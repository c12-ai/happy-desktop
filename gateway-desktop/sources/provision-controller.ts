/** One chooser-owned setup transaction. It never persists passwords or updates a saved pin. */
import { randomUUID } from "node:crypto";
import { type ServerEntry, fingerprintParse, type SshTunnel, type AddressResult } from "./servers";
import { chooseLocalPort, validAlias } from "./ssh-profiles";
import { portFree } from "./tunnel";
import { type ProvisionBundle } from "./provision-assets";
import { PayloadDownloader } from "./provision-download";
import { type ProvisionResult, type ProvisionCode } from "./provision-protocol";
import {
    ProvisionError,
    SshProvisionOperation,
    privilegedCommand,
    shellQuote,
    type SshProgress,
    type HelperRequest,
    type RemoteOp,
} from "./provision-ssh";

export interface SetupView {
    id: string;
    alias: string;
    localPort: number;
    result?: ProvisionResult;
    code?: ProvisionCode;
}
interface Job extends SetupView {
    abort: AbortController;
    cancelled: boolean;
    busy: boolean;
    operation?: SshProvisionOperation;
    downloader?: PayloadDownloader;
    payloadPath?: string;
}
export class ProvisionController {
    #job: Job | undefined;
    readonly #operations = new Set<SshProvisionOperation>();
    readonly #requests = new Set<Promise<unknown>>();
    constructor(
        readonly bundle: () => Promise<ProvisionBundle>,
        readonly servers: () => readonly ServerEntry[],
        readonly progress: (value: SshProgress & { id: string }) => void,
        readonly add: (tunnel: SshTunnel, signal: AbortSignal) => Promise<AddressResult>,
    ) {}
    #view(job: Job): SetupView {
        return {
            id: job.id,
            alias: job.alias,
            localPort: job.localPort,
            ...(job.result ? { result: job.result } : {}),
            ...(job.code ? { code: job.code } : {}),
        };
    }
    async create(
        alias: unknown,
    ): Promise<(SetupView & { ok: true }) | { ok: false; code: ProvisionCode }> {
        if (!validAlias(alias)) return { ok: false, code: "ssh_config" };
        this.cancelAll();
        const job: Job = {
            id: randomUUID(),
            alias,
            localPort: 0,
            cancelled: false,
            busy: true,
            abort: new AbortController(),
        };
        this.#job = job;
        try {
            job.localPort = await chooseLocalPort(alias, this.servers());
            if (this.#job !== job || job.cancelled) return { ok: false, code: "cancelled" };
            job.busy = false;
            return { ...this.#view(job), ok: true };
        } catch {
            return { ok: false, code: "ssh_network" };
        }
    }
    #track<T>(pending: Promise<T>): Promise<T> {
        this.#requests.add(pending);
        void pending.then(
            () => this.#requests.delete(pending),
            () => this.#requests.delete(pending),
        );
        return pending;
    }
    run(id: unknown, op: unknown, owner?: unknown): Promise<SetupView | null> {
        return this.#track(this.#run(id, op, owner));
    }
    async #run(id: unknown, op: unknown, owner?: unknown): Promise<SetupView | null> {
        const job = this.#job;
        if (
            !job ||
            job.id !== id ||
            job.cancelled ||
            job.busy ||
            !["probe", "install", "setup_owner", "prepare_connection", "inspect_existing"].includes(
                String(op),
            )
        )
            return null;
        if (op !== "probe" && job.code && !(op === "setup_owner" && job.code === "password_policy"))
            return null;
        if (op === "install" && job.result?.status !== "missing" && job.result?.action !== "resume")
            return null;
        if (op === "setup_owner" && job.result?.connection?.ownerSetup !== "required") return null;
        if (op === "inspect_existing" && job.result?.action !== "inspect_existing") return null;
        if (
            op === "prepare_connection" &&
            (job.result?.action !== "prepare_connection" || !job.result.connection)
        )
            return null;
        const password =
            typeof owner === "object" &&
            owner !== null &&
            typeof (owner as { password?: unknown }).password === "string"
                ? (owner as { password: string }).password
                : undefined;
        if (
            op === "setup_owner" &&
            (password === undefined ||
                password.length < 10 ||
                password.length > 200 ||
                password.includes("\0"))
        ) {
            job.code = "password_policy";
            return this.#view(job);
        }
        job.busy = true;
        job.code = undefined;
        const previous = job.result?.connection;
        try {
            const bundle = await this.bundle();
            if (job.cancelled) throw new ProvisionError("cancelled");
            let operation: RemoteOp = op as RemoteOp;
            if (op === "inspect_existing") operation = "probe";
            if (op === "install" && job.result?.action === "resume") operation = "resume";
            const request: HelperRequest = {
                op: operation,
                clientOrigin: `https://localhost:${job.localPort}`,
            };
            if (
                operation === "setup_owner" ||
                operation === "resume" ||
                operation === "prepare_connection"
            )
                request.instanceId = job.result?.connection?.instanceId;
            if (operation === "setup_owner") request.owner = { password: password! };
            if (operation === "setup_owner" && job.payloadPath)
                request.payloadPath = job.payloadPath;
            if (operation === "install" || operation === "prepare_connection") {
                request.payloadPath = await this.#payload(job, bundle);
            }
            let result: ProvisionResult;
            if (op === "inspect_existing")
                result = await this.#rootCall(job, bundle.bootstrap("install"), request);
            else if (operation === "probe") {
                try {
                    result = await this.#call(
                        job,
                        `/bin/sh -c ${shellQuote(bundle.bootstrap("probe"))}`,
                        request,
                    );
                    if (result.action === "privilege_required")
                        result = await this.#rootCall(job, bundle.bootstrap("root"), request);
                } catch (error) {
                    if (!(error instanceof ProvisionError)) throw error;
                    if (error.code === "bootstrap_required")
                        result = {
                            status: "missing",
                            action: "install",
                            prerequisites: ["python3"],
                        };
                    else if (error.code === "bootstrap_existing")
                        result = {
                            status: "action_required",
                            action: "inspect_existing",
                            code: "bootstrap_existing",
                            prerequisites: ["python3"],
                        };
                    else throw error;
                }
            } else {
                try {
                    result = await this.#rootCall(
                        job,
                        bundle.bootstrap(operation === "install" ? "install" : "root"),
                        request,
                    );
                } catch (error) {
                    if (
                        operation !== "setup_owner" ||
                        !(error instanceof ProvisionError) ||
                        error.code !== "payload_missing"
                    )
                        throw error;
                    request.payloadPath = await this.#payload(job, bundle);
                    request.owner = { password: password! };
                    result = await this.#rootCall(job, bundle.bootstrap("root"), request);
                }
            }
            if (job.cancelled) throw new ProvisionError("cancelled");
            if (result.connection && result.connection.origin !== request.clientOrigin)
                throw new ProvisionError("protocol");
            if (
                operation !== "probe" &&
                previous &&
                result.connection &&
                (result.connection.instanceId !== previous.instanceId ||
                    result.connection.certificateSha256 !== previous.certificateSha256 ||
                    result.connection.webPort !== previous.webPort ||
                    result.connection.remoteHost !== previous.remoteHost)
            )
                throw new ProvisionError("identity_changed");
            job.result = result;
            const saved = this.servers().find((entry) => entry.ssh?.alias === job.alias)?.ssh;
            if (
                saved &&
                (!result.connection ||
                    saved.fingerprint !== fingerprintParse(result.connection.certificateSha256) ||
                    saved.remotePort !== result.connection.webPort ||
                    (saved.remoteHost ?? "127.0.0.1") !== result.connection.remoteHost)
            )
                job.code = "identity_changed";
        } catch (error) {
            job.code = error instanceof ProvisionError ? error.code : "internal_error";
        } finally {
            job.busy = false;
            job.operation = undefined;
            // No credential is included in the public view or held by this controller.
            if (typeof owner === "object" && owner !== null && "password" in owner)
                (owner as { password: unknown }).password = "";
        }
        return this.#view(job);
    }
    async #payload(job: Job, bundle: ProvisionBundle): Promise<string> {
        if (job.payloadPath) return job.payloadPath;
        let file = bundle.payloadPath;
        if (bundle.ensurePayload) {
            const downloader = new PayloadDownloader();
            job.downloader = downloader;
            try {
                file = await bundle.ensurePayload(downloader, (received, total) => {
                    if (!job.cancelled)
                        this.progress({
                            id: job.id,
                            type: "progress",
                            step: "download",
                            transferred: received,
                            total,
                        });
                });
            } finally {
                job.downloader = undefined;
            }
        }
        if (job.cancelled) throw new ProvisionError("cancelled");
        const upload = this.#operation(job);
        try {
            job.payloadPath = await upload.upload(
                bundle.uploadCommand,
                file,
                bundle.manifest.payload.bytes,
            );
            return job.payloadPath;
        } finally {
            this.#operations.delete(upload);
        }
    }
    #operation(job: Job): SshProvisionOperation {
        if (job.cancelled) throw new ProvisionError("cancelled");
        const operation = new SshProvisionOperation(job.alias, (value) => {
            if (this.#job === job && !job.cancelled) this.progress({ ...value, id: job.id });
        });
        job.operation = operation;
        this.#operations.add(operation);
        return operation;
    }
    async #call(
        job: Job,
        command: string,
        request: HelperRequest,
        elevated?: string,
    ): Promise<ProvisionResult> {
        const operation = this.#operation(job);
        try {
            return await operation.run(command, request, elevated);
        } finally {
            this.#operations.delete(operation);
        }
    }
    #rootCall(job: Job, bootstrap: string, request: HelperRequest): Promise<ProvisionResult> {
        return this.#call(job, privilegedCommand(bootstrap, false), request, bootstrap);
    }
    password(id: unknown, value: unknown): boolean {
        const job = this.#job;
        return (
            job !== undefined &&
            job.id === id &&
            !job.cancelled &&
            job.operation?.password(value) === true
        );
    }
    cancel(id: unknown): boolean {
        if (this.#job?.id !== id) return false;
        this.cancelAll();
        return true;
    }
    cancelAll(): void {
        if (this.#job) {
            this.#job.cancelled = true;
            this.#job.abort.abort();
            this.#job.downloader?.cancel();
        }
        this.#job = undefined;
        for (const operation of this.#operations) operation.cancel();
    }
    killNow(): void {
        for (const operation of this.#operations) operation.killNow();
    }
    get active(): boolean {
        return this.#operations.size > 0 || this.#requests.size > 0;
    }
    async stop(): Promise<void> {
        this.cancelAll();
        await Promise.allSettled(this.#requests);
        await Promise.all([...this.#operations].map((operation) => operation.waitForClose()));
    }
    async useLegacyPort(id: unknown): Promise<SetupView | null> {
        const job = this.#job;
        if (!job || job.id !== id || job.cancelled || job.busy) return null;
        const port = job.result?.connection?.capabilities.requiredLocalPort;
        if (
            !port ||
            this.servers().some((entry) => entry.ssh?.localPort === port) ||
            !(await portFree(port))
        ) {
            job.code = "legacy_web_origin";
            return this.#view(job);
        }
        if (job.cancelled) return null;
        job.localPort = port;
        job.result = undefined;
        return this.run(id, "probe");
    }
    connect(id: unknown): Promise<AddressResult> {
        return this.#track(this.#connect(id));
    }
    async #connect(id: unknown): Promise<AddressResult> {
        const job = this.#job;
        if (
            !job ||
            job.id !== id ||
            job.cancelled ||
            job.busy ||
            !job.result?.connection ||
            job.code
        )
            return { ok: false, message: "Inspect the server before connecting." };
        job.busy = true;
        try {
            let connection = job.result.connection;
            if (
                !connection.capabilities.tunnelCompatible ||
                (connection.capabilities.requiredLocalPort !== undefined &&
                    connection.capabilities.requiredLocalPort !== job.localPort)
            )
                throw new ProvisionError(
                    connection.capabilities.tunnelCompatible
                        ? "legacy_web_origin"
                        : "legacy_network_layout",
                );
            const fingerprint = fingerprintParse(connection.certificateSha256)!;
            const saved = this.servers().find((entry) => entry.ssh?.alias === job.alias);
            if (
                saved?.ssh &&
                (saved.ssh.fingerprint !== fingerprint ||
                    saved.ssh.remotePort !== connection.webPort ||
                    saved.ssh.localPort !== job.localPort ||
                    (saved.ssh.remoteHost ?? "127.0.0.1") !== connection.remoteHost)
            )
                return {
                    ok: false,
                    message:
                        "The server identity differs from the saved SSH server. Its saved certificate has not been changed. Remove and explicitly add it again after verifying the change.",
                };
            const clientOrigin = `https://localhost:${job.localPort}`;
            if (!connection.allowedOrigins.includes(clientOrigin)) {
                const bundle = await this.bundle();
                const result = await this.#rootCall(job, bundle.bootstrap("root"), {
                    op: "authorize_origin",
                    clientOrigin,
                    instanceId: connection.instanceId,
                });
                if (
                    !result.connection ||
                    result.connection.origin !== clientOrigin ||
                    result.connection.instanceId !== connection.instanceId ||
                    result.connection.certificateSha256 !== connection.certificateSha256 ||
                    result.connection.remoteHost !== connection.remoteHost ||
                    result.connection.webPort !== connection.webPort ||
                    result.connection.profile !== connection.profile ||
                    result.connection.capabilities.tunnelCompatible !==
                        connection.capabilities.tunnelCompatible ||
                    result.connection.capabilities.sameOriginWeb !==
                        connection.capabilities.sameOriginWeb ||
                    result.connection.capabilities.requiredLocalPort !==
                        connection.capabilities.requiredLocalPort ||
                    !result.connection.allowedOrigins.includes(clientOrigin)
                )
                    throw new ProvisionError("identity_changed");
                connection = result.connection;
                job.result = result;
            }
            if (job.cancelled) throw new ProvisionError("cancelled");
            const tunnel = {
                alias: job.alias,
                localPort: job.localPort,
                remotePort: connection.webPort,
                fingerprint,
                ...(connection.remoteHost !== "127.0.0.1"
                    ? { remoteHost: connection.remoteHost }
                    : {}),
            };
            if (saved) return { ok: true, origin: saved.origin };
            return await this.add(tunnel, job.abort.signal);
        } catch (error) {
            return {
                ok: false,
                message:
                    error instanceof ProvisionError
                        ? error.code
                        : "The gateway could not be connected.",
            };
        } finally {
            job.busy = false;
            job.operation = undefined;
        }
    }
}
