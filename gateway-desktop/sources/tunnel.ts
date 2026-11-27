/**
 * The SSH tunnel to a gateway on another computer's loopback: the system's own
 * /usr/bin/ssh, with the person's own ~/.ssh/config, keys, agent and
 * known_hosts, and a fixed argument list. Credentials stay with system SSH;
 * the chooser reads profile names from config only. The app never accepts a host key: a host ssh does
 * not already know, or a key that needs a passphrase no agent holds, is an
 * error that says to try `ssh <host>` in Terminal.
 *
 * Nothing here uses Electron, so the checks import it as it is.
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { dirname } from "node:path";
import { sshServerParse, type SshTunnel } from "./servers";

/** The only programs this app ever starts. */
export const SSH_PATH = "/usr/bin/ssh";
export const PS_PATH = "/bin/ps";
const PROGRAMS: ReadonlySet<string> = new Set([SSH_PATH, PS_PATH]);

/** How long ssh has to connect, sign in and open its local port. */
const READY_TIMEOUT_MS = 30_000;
/** How long a stopped ssh has between SIGTERM and SIGKILL. */
const STOP_GRACE_MS = 2_000;
/** Waits between restarts after an unexpected exit; the last repeats. */
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
/** A tunnel up this long starts its backoff from the beginning again. */
const STABLE_MS = 60_000;

/** Starts one of the two allowed programs; every process this app starts goes through here. */
export function launch(
    program: string,
    args: readonly string[],
    options: SpawnOptions,
): ChildProcess {
    if (!PROGRAMS.has(program)) throw new Error(`Karis Workbench does not start ${program}.`);
    return spawn(program, args, { ...options, shell: false });
}

/** Runs ps or `ssh -V` to completion, with what it wrote. */
function output(
    program: string,
    args: readonly string[],
): Promise<{ code: number | null; text: string }> {
    return new Promise((resolve) => {
        const child = launch(program, args, { stdio: ["ignore", "pipe", "pipe"] });
        let text = "";
        child.stdout?.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
        child.stderr?.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
        child.once("error", () => resolve({ code: null, text }));
        child.once("close", (code) => resolve({ code, text }));
    });
}

let versionRead: Promise<[number, number]> | undefined;

/** The OpenSSH version of /usr/bin/ssh, as `ssh -V` reports it; 0.0 when it cannot be read. */
export function sshVersion(): Promise<[number, number]> {
    versionRead ??= output(SSH_PATH, ["-V"]).then(({ text }) => {
        const found = /OpenSSH_(\d+)\.(\d+)/u.exec(text);
        return found ? [Number(found[1]), Number(found[2])] : [0, 0];
    });
    return versionRead;
}

/** The `-o` options, in this order, before the forward and the host. */
const SSH_OPTIONS = [
    "ExitOnForwardFailure=yes",
    "BatchMode=yes",
    "StrictHostKeyChecking=yes",
    "ServerAliveInterval=15",
    "ControlMaster=no",
    "ControlPath=none",
    "ClearAllForwardings=no",
    "PermitLocalCommand=no",
    "RemoteCommand=none",
    "UpdateHostKeys=no",
    "ConnectTimeout=15",
    "LogLevel=ERROR",
];

/**
 * The whole argument list. Options on the command line win over the person's
 * ssh config, so a config that multiplexes connections, forks ssh into the
 * background, runs a local or remote command or updates known_hosts cannot do
 * so here. Forwardings the config itself names for the host still open
 * (`ClearAllForwardings=yes` would also clear this one).
 */
export function sshArguments(tunnel: SshTunnel, version: readonly [number, number]): string[] {
    // Checked again here, so no caller can hand ssh anything the form would refuse.
    const checked = sshServerParse({
        alias: tunnel.alias,
        remotePort: String(tunnel.remotePort),
        localPort: String(tunnel.localPort),
        fingerprint: tunnel.fingerprint,
        remoteHost: tunnel.remoteHost,
    });
    if (!checked.ok || checked.tunnel.alias !== tunnel.alias)
        throw new Error("Refusing an SSH tunnel the server list would not accept.");
    const { alias, remotePort, localPort, remoteHost } = checked.tunnel;
    return [
        "-N",
        "-T",
        ...[
            ...SSH_OPTIONS,
            // ForkAfterAuthentication came in OpenSSH 8.7; an older ssh does not know the
            // option, and so neither can the person's config.
            ...(version[0] > 8 || (version[0] === 8 && version[1] >= 7)
                ? ["ForkAfterAuthentication=no"]
                : []),
        ].flatMap((option) => ["-o", option]),
        "-L",
        `127.0.0.1:${localPort}:${remoteHost ?? "127.0.0.1"}:${remotePort}`,
        "--",
        alias,
    ];
}

export type TunnelFailure =
    | "auth"
    | "host-key"
    | "name"
    | "config"
    | "busy"
    | "network"
    | "timeout"
    | "other";

/** Why a tunnel is not up, in words for the person, and whether trying again by itself could help. */
export class TunnelError extends Error {
    readonly kind: TunnelFailure;
    constructor(kind: TunnelFailure, message: string) {
        super(message);
        this.kind = kind;
    }
    get retryable(): boolean {
        return this.kind === "network" || this.kind === "timeout" || this.kind === "other";
    }
}

/** Reads what a failed ssh wrote to stderr. */
export function sshFailure(tunnel: SshTunnel, stderr: string): TunnelError {
    const said = stderr
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line !== "")
        ?.slice(0, 200);
    const check = `Check that \`ssh ${tunnel.alias}\` works in Terminal.`;
    const because = said === undefined ? "" : ` (ssh: ${said})`;
    const failure = (kind: TunnelFailure, message: string) => new TunnelError(kind, message);
    if (
        /address already in use|cannot listen to port|could not request local forwarding/iu.test(
            stderr,
        )
    )
        return failure(
            "busy",
            `Port ${tunnel.localPort} on this computer is in use by another program.`,
        );
    if (
        /permission denied|too many authentication failures|no more authentication methods/iu.test(
            stderr,
        )
    )
        return failure("auth", `Could not sign in to ${tunnel.alias}${because}. ${check}`);
    if (
        /host key verification failed|host identification has changed|no .*host key is known/iu.test(
            stderr,
        )
    )
        return failure(
            "host-key",
            `${tunnel.alias}'s host key is not known to this computer${because}. ${check}`,
        );
    if (/could not resolve hostname|name or service not known|nodename nor servname/iu.test(stderr))
        return failure("name", `Could not find ${tunnel.alias}${because}. ${check}`);
    if (
        /bad configuration option|unsupported option|terminating, \d+ bad configuration|garbage at end of line|keyword .* extra arguments/iu.test(
            stderr,
        )
    )
        return failure(
            "config",
            `ssh could not read its configuration for ${tunnel.alias}${because}. ${check}`,
        );
    if (
        /connection refused|timed out|no route to host|network is unreachable|connection closed|connection reset|kex_exchange_identification|broken pipe/iu.test(
            stderr,
        )
    )
        return failure("network", `Could not connect to ${tunnel.alias}${because}.`);
    return failure("other", `Could not connect to ${tunnel.alias}${because}. ${check}`);
}

/**
 * Whether nothing listens on `port` on this computer's loopback, IPv4 or IPv6
 * (Chromium may try ::1 first for localhost). A computer without IPv6
 * loopback counts as free there.
 */
export async function portFree(port: number): Promise<boolean> {
    const free = (host: string) =>
        new Promise<boolean>((resolve) => {
            const server = createServer();
            server.once("error", (error: NodeJS.ErrnoException) =>
                resolve(error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT"),
            );
            server.listen({ host, port, exclusive: true }, () => server.close(() => resolve(true)));
        });
    return (await free("127.0.0.1")) && (await free("::1"));
}

/** Whether something accepts connections on 127.0.0.1:`port` now. */
function accepting(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = connect({ host: "127.0.0.1", port });
        socket.once("connect", () => (socket.destroy(), resolve(true)));
        socket.once("error", () => resolve(false));
    });
}

/**
 * The ssh processes this app has running, kept in a file so that a later
 * launch can end any a crash left behind. A record is the process id and the
 * exact command line.
 */
export class TunnelRegistry {
    readonly #path: string;
    #records: { pid: number; command: string }[] = [];

    constructor(path: string) {
        this.#path = path;
    }

    add(pid: number, command: string): void {
        this.#records.push({ pid, command });
        this.#write();
    }

    remove(pid: number): void {
        this.#records = this.#records.filter((record) => record.pid !== pid);
        this.#write();
    }

    /**
     * Ends the ssh processes a previous run left behind: only one whose owner
     * is this user, whose parent is now the system's first process (it was
     * orphaned) and whose command line is exactly the one recorded. Returns
     * the ids it ended. Run once, before this run starts any tunnel.
     */
    async sweep(): Promise<number[]> {
        let records: unknown;
        try {
            records = JSON.parse(readFileSync(this.#path, "utf8"));
        } catch {
            records = [];
        }
        const ended: number[] = [];
        for (const record of Array.isArray(records) ? records : []) {
            const pid = (record as { pid?: unknown })?.pid;
            const command = (record as { command?: unknown })?.command;
            if (!Number.isInteger(pid) || (pid as number) <= 1 || typeof command !== "string")
                continue;
            if (!(await orphanedTunnel(pid as number, command))) continue;
            await processEnd(pid as number, command);
            ended.push(pid as number);
        }
        this.#records = [];
        this.#write();
        return ended;
    }

    #write(): void {
        mkdirSync(dirname(this.#path), { recursive: true });
        const temporary = `${this.#path}.new`;
        writeFileSync(temporary, `${JSON.stringify(this.#records)}\n`, { mode: 0o600 });
        renameSync(temporary, this.#path);
    }
}

/** Whether `pid` is this user's orphaned ssh running exactly `command`. */
async function orphanedTunnel(pid: number, command: string): Promise<boolean> {
    if (!command.startsWith(`${SSH_PATH} `)) return false;
    const { code, text } = await output(PS_PATH, [
        "-o",
        "uid=",
        "-o",
        "ppid=",
        "-o",
        "args=",
        "-p",
        String(pid),
    ]);
    if (code !== 0) return false;
    const found = /^\s*(\d+)\s+(\d+)\s+(.*?)\s*$/u.exec(text.split("\n")[0] ?? "");
    return (
        found !== null &&
        Number(found[1]) === process.getuid?.() &&
        Number(found[2]) === 1 &&
        found[3] === command
    );
}

/** SIGTERM, then SIGKILL if the process is still there after a grace period. */
async function processEnd(pid: number, command: string): Promise<void> {
    const alive = () => {
        try {
            process.kill(pid, 0);
            return true;
        } catch {
            return false;
        }
    };
    try {
        process.kill(pid, "SIGTERM");
    } catch {
        return;
    }
    for (let waited = 0; waited < STOP_GRACE_MS && alive(); waited += 100)
        await new Promise((resolve) => setTimeout(resolve, 100));
    if (alive() && (await orphanedTunnel(pid, command))) {
        try {
            process.kill(pid, "SIGKILL");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
    }
}

export type TunnelState = "idle" | "connecting" | "up" | "retrying" | "failed";

/**
 * One tunnel: started when a window of its server opens, kept up while one
 * is open, restarted after an unexpected exit with a growing wait, stopped
 * when the last window closes or the app quits. An error that waiting cannot
 * mend (a refused key, an unknown host key, a busy port) stops it instead.
 *
 * Events: "state" (TunnelState), "failed" (TunnelError) after an automatic
 * restart gave up.
 */
export class Tunnel extends EventEmitter {
    readonly tunnel: SshTunnel;
    readonly #registry: TunnelRegistry;
    #state: TunnelState = "idle";
    #child: ChildProcess | null = null;
    #wanted = false;
    #starting: Promise<void> | null = null;
    #retry: ReturnType<typeof setTimeout> | null = null;
    #failures = 0;
    #upSince = 0;

    constructor(tunnel: SshTunnel, registry: TunnelRegistry) {
        super();
        this.tunnel = tunnel;
        this.#registry = registry;
    }

    get state(): TunnelState {
        return this.#state;
    }

    /** The running ssh's process id, if any. */
    get pid(): number | undefined {
        return this.#child?.pid;
    }

    /** Brings the tunnel up, or says why it could not. */
    async start(): Promise<void> {
        this.#wanted = true;
        if (this.#retry !== null) {
            clearTimeout(this.#retry);
            this.#retry = null;
        }
        // An attempt already under way (a restart, or another window's) is waited for, not doubled.
        while (this.#starting !== null) await this.#starting.catch(() => undefined);
        if (!this.#wanted) throw new TunnelError("other", "The tunnel was stopped.");
        if (this.#state === "up") return;
        this.#starting = this.#attempt()
            .catch((error: TunnelError) => {
                this.#stateSet(this.#wanted ? "failed" : "idle");
                throw error;
            })
            .finally(() => (this.#starting = null));
        return this.#starting;
    }

    /** Ends ssh: SIGTERM, then SIGKILL if it is still there after a grace period. */
    async stop(): Promise<void> {
        this.#wanted = false;
        if (this.#retry !== null) {
            clearTimeout(this.#retry);
            this.#retry = null;
        }
        const child = this.#child;
        if (child !== null && child.exitCode === null && child.signalCode === null) {
            const exited = new Promise((resolve) => child.once("close", resolve));
            child.kill("SIGTERM");
            const timer = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS);
            await exited;
            clearTimeout(timer);
        }
        // An attempt may still be checking the port or reading ssh's version. It must finish
        // observing #wanted before stop resolves, so it cannot spawn after the app has quit.
        await this.#starting?.catch(() => undefined);
        this.#stateSet("idle");
    }

    /** For the app's last moment: ends ssh at once, without waiting. */
    killNow(): void {
        this.#wanted = false;
        this.#child?.kill("SIGKILL");
    }

    #stateSet(state: TunnelState): void {
        if (this.#state === state) return;
        this.#state = state;
        this.emit("state", state);
    }

    async #attempt(): Promise<void> {
        this.#stateSet("connecting");
        const { tunnel } = this;
        try {
            if (!(await portFree(tunnel.localPort)))
                throw new TunnelError(
                    "busy",
                    `Port ${tunnel.localPort} on this computer is in use by another program.`,
                );
            const args = sshArguments(tunnel, await sshVersion());
            if (!this.#wanted) throw new TunnelError("other", "The tunnel was stopped.");
            const child = launch(SSH_PATH, args, {
                stdio: ["ignore", "ignore", "pipe"],
                // No password window either, whatever SSH_ASKPASS the environment names.
                env: { ...process.env, SSH_ASKPASS_REQUIRE: "never" },
            });
            this.#child = child;
            const pid = child.pid;
            let stderr = "";
            child.stderr?.on("data", (chunk: Buffer) => {
                if (stderr.length < 4096) stderr += chunk.toString("utf8");
            });
            const exited = new Promise<TunnelError>((resolve) => {
                child.once("error", (error) =>
                    resolve(
                        new TunnelError("other", `Could not start ${SSH_PATH}: ${error.message}`),
                    ),
                );
                child.once("close", () => resolve(sshFailure(tunnel, stderr)));
            });
            child.once("exit", () => {
                if (pid !== undefined) this.#registry.remove(pid);
                if (this.#child === child) this.#child = null;
                if (this.#state === "up") this.#exitedWhileUp(sshFailure(tunnel, stderr));
            });
            try {
                if (pid !== undefined) this.#registry.add(pid, [SSH_PATH, ...args].join(" "));
            } catch (error) {
                child.kill("SIGKILL");
                await exited;
                throw error;
            }
            const deadline = Date.now() + READY_TIMEOUT_MS;
            for (;;) {
                if (!this.#wanted) throw new TunnelError("other", "The tunnel was stopped.");
                const ended = await Promise.race([
                    exited,
                    new Promise<null>((resolve) => setTimeout(() => resolve(null), 150)),
                ]);
                if (ended !== null) throw ended;
                if (await accepting(tunnel.localPort)) {
                    if (!this.#wanted) throw new TunnelError("other", "The tunnel was stopped.");
                    break;
                }
                if (Date.now() > deadline) {
                    child.kill("SIGKILL");
                    throw new TunnelError(
                        "timeout",
                        `${tunnel.alias} did not open the tunnel within ${READY_TIMEOUT_MS / 1000} seconds.`,
                    );
                }
            }
            this.#upSince = Date.now();
            this.#stateSet("up");
        } catch (error) {
            throw error instanceof TunnelError ? error : new TunnelError("other", String(error));
        }
    }

    /** ssh ended by itself while the tunnel was up: try again after a wait, or give up. */
    #exitedWhileUp(failure: TunnelError): void {
        if (!this.#wanted) return void this.#stateSet("idle");
        if (Date.now() - this.#upSince >= STABLE_MS) this.#failures = 0;
        this.#retryAfter(failure);
    }

    #retryAfter(failure: TunnelError): void {
        if (!failure.retryable) {
            this.#stateSet("failed");
            this.emit("failed", failure);
            return;
        }
        this.#stateSet("retrying");
        const wait = BACKOFF_MS[Math.min(this.#failures, BACKOFF_MS.length - 1)]!;
        this.#failures += 1;
        this.#retry = setTimeout(() => {
            this.#retry = null;
            if (!this.#wanted) return;
            this.#starting = this.#attempt()
                .catch((next: TunnelError) => {
                    if (this.#wanted) this.#retryAfter(next);
                    else this.#stateSet("idle");
                })
                .finally(() => (this.#starting = null));
        }, wait);
    }
}
