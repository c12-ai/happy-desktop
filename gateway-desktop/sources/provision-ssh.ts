/** Fixed SSH transport for the bundled helper. Passwords are stdin-only. */
import { type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, type ReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { SSH_PATH, launch, sshVersion } from "./tunnel";
import { validAlias } from "./ssh-profiles";
import {
    ProvisionDecoder,
    type ProvisionCode,
    type ProvisionEvent,
    type ProvisionResult,
} from "./provision-protocol";

export type RemoteOp =
    | "probe"
    | "install"
    | "setup_owner"
    | "authorize_origin"
    | "prepare_connection"
    | "resume";
export interface HelperRequest {
    op: RemoteOp;
    clientOrigin: string;
    payloadPath?: string;
    owner?: { password: string };
    instanceId?: string;
}
export class ProvisionError extends Error {
    constructor(readonly code: ProvisionCode) {
        super(code);
    }
}
export interface SshProgress {
    type: "progress" | "sudo";
    step?: string;
    transferred?: number;
    total?: number;
}

export const SUDO_PROMPT = "KARIS_WORKBENCH_SUDO_PASSWORD:";
/** These strings contain trusted app sources only; no form value is interpolated. */
export function shellQuote(value: string): string {
    return `'${value.replace(/'/gu, `'"'"'`)}'`;
}
export function privilegedCommand(bootstrap: string, password: boolean): string {
    const clean = "/usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LANG=C LC_ALL=C";
    // This shell runs after sudo has generated SUDO_UID. Only that numeric value
    // survives into the otherwise empty root environment; $1 is trusted app code.
    const rootLauncher = `case "$SUDO_UID" in ''|*[!0-9]*) exit 1;; esac; exec ${clean} SUDO_UID="$SUDO_UID" /bin/sh -c "$1"`;
    const sudo = password ? `/usr/bin/sudo -S -p ${shellQuote(SUDO_PROMPT)}` : "/usr/bin/sudo -n";
    return `KARIS_BOOTSTRAP=${shellQuote(bootstrap)}; PATH=/usr/sbin:/usr/bin:/sbin:/bin; LC_ALL=C; export PATH LC_ALL; if [ "$(/usr/bin/id -u)" -eq 0 ]; then exec ${clean} SUDO_UID=0 /bin/sh -c "$KARIS_BOOTSTRAP"; else exec ${sudo} -- /bin/sh -c ${shellQuote(rootLauncher)} karis-provision "$KARIS_BOOTSTRAP"; fi`;
}

/** Config can resolve proxies/identity, but cannot add forwards, commands or backgrounding. */
export async function commandArguments(alias: string, command: string): Promise<string[]> {
    if (!validAlias(alias)) throw new ProvisionError("ssh_config");
    const version = await sshVersion();
    const options = [
        "BatchMode=yes",
        "StrictHostKeyChecking=yes",
        "ClearAllForwardings=yes",
        "ControlMaster=no",
        "ControlPath=none",
        "PermitLocalCommand=no",
        "RemoteCommand=none",
        "UpdateHostKeys=no",
        "ConnectTimeout=15",
        "ServerAliveInterval=15",
        "ServerAliveCountMax=3",
        "LogLevel=ERROR",
        ...(version[0] > 8 || (version[0] === 8 && version[1] >= 7)
            ? ["ForkAfterAuthentication=no"]
            : []),
    ];
    return ["-T", ...options.flatMap((option) => ["-o", option]), "--", alias, command];
}

/** Classify private stderr locally. Only a bounded code crosses the renderer bridge. */
export function sshProvisionFailure(
    stderr: string,
    exitCode: number | null,
    helperReady: boolean,
): ProvisionCode {
    // ssh returns the remote command's exit status; its own connection errors use 255.
    // A local proxy's sudo/password failure must not trigger a remote sudo retry.
    if (exitCode !== null && exitCode !== 255) {
        if (/must have a tty|terminal is required|requiretty/iu.test(stderr))
            return "unsupported_sudo";
        if (
            /not in the sudoers|not allowed to (?:run|execute)|may not run sudo|sudo[^\n]*(?:not found|no such file)/iu.test(
                stderr,
            )
        )
            return "privilege_required";
        if (/a password is required|password is required/iu.test(stderr)) return "sudo_required";
        if (
            /incorrect password|sudo[^\n]*authentication failure|no password was provided|sorry, try again/iu.test(
                stderr,
            )
        )
            return "sudo_failed";
        // A completed command with no handshake is not a failed SSH connection.
        return helperReady ? "protocol" : "remote_start_failed";
    }
    if (
        /host key verification failed|host identification has changed|no .*host key is known/iu.test(
            stderr,
        )
    )
        return "ssh_host_key";
    if (
        /password is required|cannot prompt[^\n]*non.interactive|(?:re-?authentication|interactive authentication)[^\n]*(?:required|needed)|(?:please run|run the following)[^\n]*(?:auth login|gcloud auth)/iu.test(
            stderr,
        )
    )
        return "ssh_interactive";
    if (
        /permission denied|too many authentication failures|no more authentication methods|agent refused operation|sign_and_send_pubkey[^\n]*signing failed|read_passphrase[^\n]*(?:can't open|cannot open)/iu.test(
            stderr,
        )
    )
        return "ssh_auth";
    if (
        /bad configuration|bad configuration option|unsupported option|garbage at end of line/iu.test(
            stderr,
        )
    )
        return "ssh_config";
    if (/could not resolve hostname|name or service not known|nodename nor servname/iu.test(stderr))
        return "ssh_name";
    if (
        /command not found|(?:^|\n)(?:\/[^:\n]+\/)?(?:ba|z|da|k)?sh:[^\n]*(?:not found|no such file)|exec[^\n]*no such file|posix_spawnp: no such file/iu.test(
            stderr,
        )
    )
        return "ssh_command_missing";
    return "ssh_network";
}

export class SshProvisionOperation {
    #child: ChildProcess | undefined;
    #cancelled = false;
    #passwordPending = false;
    #passwordTimer: ReturnType<typeof setTimeout> | undefined;
    #killTimer: ReturnType<typeof setTimeout> | undefined;
    #upload: ReadStream | undefined;
    readonly #alias: string;
    readonly #onProgress: (event: SshProgress) => void;
    readonly #requestId = randomUUID();
    constructor(alias: string, onProgress: (event: SshProgress) => void) {
        if (!validAlias(alias)) throw new ProvisionError("ssh_config");
        this.#alias = alias;
        this.#onProgress = onProgress;
    }
    password(value: unknown): boolean {
        if (
            !this.#passwordPending ||
            typeof value !== "string" ||
            value.length === 0 ||
            value.length > 1024 ||
            /[\r\n]/u.test(value) ||
            value.includes("\0") ||
            this.#cancelled
        )
            return false;
        this.#passwordPending = false;
        clearTimeout(this.#passwordTimer);
        this.#child?.stdin?.write(`${value}\n`, () => {});
        return true;
    }
    cancel(): void {
        if (this.#cancelled) return;
        this.#cancelled = true;
        this.#passwordPending = false;
        clearTimeout(this.#passwordTimer);
        const child = this.#child;
        if (!child) return;
        if (this.#upload) {
            this.#upload.destroy();
            child.stdin?.end();
        } else
            child.stdin?.end(
                `${JSON.stringify({ v: 1, requestId: this.#requestId, op: "cancel" })}\n`,
            );
        // EOF lets the helper stop its subprocess group and record the owned phase first.
        this.#killTimer = setTimeout(() => {
            if (this.#child === child) child.kill("SIGTERM");
            this.#killTimer = setTimeout(() => {
                if (this.#child === child) child.kill("SIGKILL");
            }, 2_000);
        }, 3_000);
    }
    killNow(): void {
        this.#child?.kill("SIGKILL");
    }
    async waitForClose(): Promise<void> {
        const child = this.#child;
        if (child) await new Promise<void>((resolve) => child.once("close", () => resolve()));
    }

    async upload(command: string, file: string, bytes: number): Promise<string> {
        const args = await commandArguments(this.#alias, command);
        if (this.#cancelled) throw new ProvisionError("cancelled");
        return new Promise((resolve, reject) => {
            const child = launch(SSH_PATH, args, { stdio: ["pipe", "pipe", "pipe"] });
            this.#child = child;
            let pending = "";
            const utf8 = new TextDecoder("utf-8", { fatal: true });
            let outputBytes = 0;
            let readyPath: string | undefined;
            let completed = false;
            let received = 0;
            let stderr = "";
            let failure: ProvisionCode | undefined;
            const deadline = setTimeout(() => {
                failure = "timeout";
                this.cancel();
            }, 30 * 60_000);
            const safePath = (value: unknown): value is string =>
                typeof value === "string" &&
                value.length < 4096 &&
                /^\/[A-Za-z0-9_./-]+\/\.cache\/karis-workbench\/payload-[a-f0-9]{64}\.tar\.xz$/u.test(
                    value,
                ) &&
                !value.split("/").includes("..");
            const invalid = () => {
                failure = "protocol";
                this.cancel();
            };
            const accept = (value: Record<string, unknown>) => {
                if (value.v !== 1 || value.requestId !== null) return invalid();
                if (value.type === "error") {
                    failure = [
                        "payload_mismatch",
                        "payload_unsafe",
                        "stage_conflict",
                        "cancelled",
                        "payload_missing",
                    ].includes(String(value.code))
                        ? (value.code as ProvisionCode)
                        : "protocol";
                    return this.cancel();
                }
                if (value.type === "ready") {
                    if (
                        readyPath ||
                        !safePath(value.payloadPath) ||
                        !["cached", "needed"].includes(String(value.upload))
                    )
                        return invalid();
                    readyPath = value.payloadPath;
                    if (value.upload === "cached") child.stdin?.end();
                    else {
                        this.#onProgress({
                            type: "progress",
                            step: "upload",
                            transferred: 0,
                            total: bytes,
                        });
                        this.#upload = createReadStream(file, { highWaterMark: 256 * 1024 });
                        void pipeline(this.#upload, child.stdin!).catch(() => {
                            if (!this.#cancelled && !completed) {
                                failure = "payload_missing";
                                this.cancel();
                            }
                        });
                    }
                } else if (value.type === "progress") {
                    if (
                        !readyPath ||
                        value.step !== "upload" ||
                        value.total !== bytes ||
                        !Number.isSafeInteger(value.received) ||
                        (value.received as number) < received ||
                        (value.received as number) > bytes
                    )
                        return invalid();
                    received = value.received as number;
                    this.#onProgress({
                        type: "progress",
                        step: "upload",
                        transferred: received,
                        total: bytes,
                    });
                } else if (value.type === "result") {
                    if (
                        !readyPath ||
                        completed ||
                        value.payloadPath !== readyPath ||
                        !["cached", "uploaded"].includes(String(value.status))
                    )
                        return invalid();
                    completed = true;
                } else invalid();
            };
            child.stdout?.on("data", (chunk: Buffer) => {
                outputBytes += chunk.length;
                try {
                    if (outputBytes > 1_048_576) return invalid();
                    pending += utf8.decode(chunk, { stream: true });
                    let newline: number;
                    while ((newline = pending.indexOf("\n")) >= 0) {
                        if (newline > 8192) return invalid();
                        const line = pending.slice(0, newline);
                        pending = pending.slice(newline + 1);
                        const parsed: unknown = JSON.parse(line);
                        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
                            return invalid();
                        accept(parsed as Record<string, unknown>);
                    }
                    if (pending.length > 8192) invalid();
                } catch {
                    invalid();
                }
            });
            child.stderr?.on("data", (chunk: Buffer) => {
                if (stderr.length + chunk.length > 65_536) return invalid();
                stderr += chunk.toString("utf8");
            });
            child.stdin?.on("error", () => {});
            child.once("error", () => {
                failure ??= "ssh_config";
            });
            child.once("close", (code) => {
                clearTimeout(deadline);
                clearTimeout(this.#killTimer);
                this.#upload?.destroy();
                this.#upload = undefined;
                this.#child = undefined;
                try {
                    if (pending !== "" || utf8.decode() !== "") failure ??= "protocol";
                } catch {
                    failure ??= "protocol";
                }
                if (failure) return reject(new ProvisionError(failure));
                if (this.#cancelled) return reject(new ProvisionError("cancelled"));
                if (code !== 0 || !completed || !readyPath)
                    return reject(
                        new ProvisionError(sshProvisionFailure(stderr, code, Boolean(readyPath))),
                    );
                resolve(readyPath);
            });
        });
    }

    async run(
        command: string,
        request: HelperRequest,
        elevatedBootstrap?: string,
    ): Promise<ProvisionResult> {
        try {
            return await this.#attempt(command, request, false);
        } catch (error) {
            if (
                !(error instanceof ProvisionError) ||
                error.code !== "sudo_required" ||
                !elevatedBootstrap ||
                this.#cancelled
            )
                throw error;
            return await this.#attempt(privilegedCommand(elevatedBootstrap, true), request, true);
        } finally {
            // Do not retain the owner's password in a request object after the operation.
            if (request.owner) request.owner.password = "";
        }
    }

    async #attempt(
        command: string,
        request: HelperRequest,
        allowPassword: boolean,
    ): Promise<ProvisionResult> {
        if (this.#cancelled) throw new ProvisionError("cancelled");
        const args = await commandArguments(this.#alias, command);
        if (this.#cancelled) throw new ProvisionError("cancelled");
        return new Promise((resolve, reject) => {
            const child = launch(SSH_PATH, args, { stdio: ["pipe", "pipe", "pipe"] });
            this.#child = child;
            const decoder = new ProvisionDecoder(this.#requestId);
            let ready = false;
            let result: ProvisionResult | undefined;
            let failure: ProvisionCode | undefined;
            let stderr = "";
            let stderrBytes = 0;
            let prompts = 0;
            const deadline = setTimeout(
                () => {
                    failure = "timeout";
                    this.cancel();
                },
                request.op === "install" ? 30 * 60_000 : 5 * 60_000,
            );
            const protocolFailure = () => {
                failure = "protocol";
                this.cancel();
            };
            const event = (value: ProvisionEvent) => {
                if (this.#cancelled) return;
                if (value.type === "ready") {
                    if (ready) return protocolFailure();
                    ready = true;
                    this.#passwordPending = false;
                    clearTimeout(this.#passwordTimer);
                    child.stdin?.write(
                        `${JSON.stringify({ v: 1, requestId: this.#requestId, ...request })}\n`,
                        () => {},
                    );
                } else if (value.type === "progress") {
                    if (result) return protocolFailure();
                    this.#onProgress(value);
                } else if (value.type === "result") {
                    if (!ready || result) return protocolFailure();
                    result = value.result;
                    child.stdin?.end();
                } else {
                    failure = value.code;
                    child.stdin?.end();
                }
            };
            child.stdout?.on("data", (chunk: Buffer) => {
                try {
                    for (const value of decoder.push(chunk)) event(value);
                } catch {
                    protocolFailure();
                }
            });
            child.stderr?.on("data", (chunk: Buffer) => {
                stderrBytes += chunk.length;
                if (stderrBytes > 65_536) return protocolFailure();
                stderr += chunk.toString("utf8");
                let prompt: number;
                while ((prompt = stderr.indexOf(SUDO_PROMPT)) >= 0) {
                    stderr = stderr.slice(0, prompt) + stderr.slice(prompt + SUDO_PROMPT.length);
                    if (!allowPassword || ready || ++prompts > 3 || this.#passwordPending) {
                        failure = "sudo_failed";
                        this.cancel();
                        return;
                    }
                    this.#passwordPending = true;
                    this.#onProgress({ type: "sudo" });
                    this.#passwordTimer = setTimeout(() => {
                        failure = "timeout";
                        this.cancel();
                    }, 120_000);
                }
            });
            child.stdin?.on("error", () => {});
            child.once("error", () => {
                failure ??= "ssh_config";
            });
            child.once("close", (code) => {
                clearTimeout(deadline);
                clearTimeout(this.#passwordTimer);
                clearTimeout(this.#killTimer);
                this.#passwordPending = false;
                if (this.#child === child) this.#child = undefined;
                try {
                    decoder.finish();
                } catch {
                    failure ??= "protocol";
                }
                if (failure) return reject(new ProvisionError(failure));
                if (this.#cancelled) return reject(new ProvisionError("cancelled"));
                if (code !== 0 || !result)
                    return reject(new ProvisionError(sshProvisionFailure(stderr, code, ready)));
                resolve(result);
            });
        });
    }
}
