/** The remote helper may return only public metadata and enumerated progress. */
import { validRemoteHost } from "./servers";
export const PROVISION_STEPS = [
    "preflight",
    "packages",
    "verify_payload",
    "install",
    "start",
    "owner_setup",
    "origin",
    "complete",
    "upload",
] as const;
export type ProvisionStep = (typeof PROVISION_STEPS)[number];
export const PROVISION_CODES = [
    "unsupported_os",
    "unsupported_arch",
    "unsupported_sudo",
    "sudo_required",
    "sudo_failed",
    "ssh_auth",
    "ssh_host_key",
    "ssh_config",
    "ssh_network",
    "ssh_name",
    "ssh_command_missing",
    "ssh_interactive",
    "remote_start_failed",
    "local_port_unavailable",
    "desktop_error",
    "timeout",
    "cancelled",
    "protocol",
    "payload_integrity",
    "conflict",
    "recovery_required",
    "prerequisites_failed",
    "install_failed",
    "not_healthy",
    "owner_exists",
    "owner_invalid",
    "owner_failed",
    "invalid_request",
    "unsupported_platform",
    "missing_prerequisites",
    "privilege_required",
    "origin_not_allowed",
    "instance_conflict",
    "partial_install",
    "service_unhealthy",
    "payload_mismatch",
    "owner_already_configured",
    "password_policy",
    "invalid_origin",
    "bootstrap_required",
    "instance_unhealthy",
    "payload_missing",
    "payload_unsafe",
    "stage_conflict",
    "packages_failed",
    "repository_configuration_unsupported",
    "owner_not_found",
    "owner_setup_failed",
    "origin_update_failed",
    "busy",
    "internal_error",
    "legacy_web_origin",
    "legacy_network_layout",
    "legacy_incompatible",
    "identity_changed",
    "download_failed",
    "release_unavailable",
    "bootstrap_existing",
] as const;
export type ProvisionCode = (typeof PROVISION_CODES)[number];
export interface RemoteConnection {
    webPort: number;
    remoteHost: string;
    certificateSha256: string;
    instanceId: string;
    ownerSetup: "required" | "ready" | "unknown";
    loginName?: string;
    origin: string;
    allowedOrigins: string[];
    profile: "hgn" | "hg";
    capabilities: { sameOriginWeb: boolean; tunnelCompatible: boolean; requiredLocalPort?: number };
}
export interface ProvisionResult {
    status:
        | "found"
        | "missing"
        | "installed"
        | "owner_ready"
        | "origin_ready"
        | "action_required"
        | "unsupported"
        | "conflict"
        | "recovery_required";
    connection?: RemoteConnection;
    prerequisites?: string[];
    code?: ProvisionCode;
    action?:
        | "install"
        | "authorize_origin"
        | "prepare_connection"
        | "resume"
        | "privilege_required"
        | "inspect_existing";
}
export type ProvisionEvent =
    | { type: "ready" }
    | { type: "progress"; step: ProvisionStep }
    | { type: "result"; result: ProvisionResult }
    | { type: "error"; code: ProvisionCode };

function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function member<T extends string>(value: unknown, choices: readonly T[]): value is T {
    return typeof value === "string" && choices.includes(value as T);
}

/** No remote prose, stderr, credentials or extra fields cross the renderer bridge. */
export function publicEvent(raw: unknown, requestId: string): ProvisionEvent {
    if (!object(raw) || raw.v !== 1) throw new Error("protocol");
    if (raw.type === "ready" && raw.requestId === null) return { type: "ready" };
    if (
        raw.requestId !== requestId &&
        !(
            raw.requestId === null &&
            ((raw.type === "progress" && raw.step === "packages") ||
                (raw.type === "error" &&
                    member(raw.code, [
                        "bootstrap_required",
                        "bootstrap_existing",
                        "unsupported_platform",
                        "repository_configuration_unsupported",
                        "packages_failed",
                    ])))
        )
    )
        throw new Error("protocol");
    if (raw.type === "progress" && member(raw.step, PROVISION_STEPS))
        return { type: "progress", step: raw.step };
    if (raw.type === "error" && member(raw.code, PROVISION_CODES))
        return { type: "error", code: raw.code };
    if (
        raw.type !== "result" ||
        !member(raw.status, [
            "found",
            "missing",
            "installed",
            "owner_ready",
            "origin_ready",
            "action_required",
            "unsupported",
            "conflict",
            "recovery_required",
        ] as const)
    )
        throw new Error("protocol");
    const result: ProvisionResult = { status: raw.status };
    if (raw.action !== undefined) {
        if (
            !member(raw.action, [
                "install",
                "authorize_origin",
                "prepare_connection",
                "resume",
                "privilege_required",
                "inspect_existing",
            ] as const)
        )
            throw new Error("protocol");
        result.action = raw.action;
    }
    if (raw.code !== undefined) {
        if (!member(raw.code, PROVISION_CODES)) throw new Error("protocol");
        result.code = raw.code;
    }
    if (raw.prerequisites !== undefined) {
        if (
            !Array.isArray(raw.prerequisites) ||
            raw.prerequisites.length > 32 ||
            !raw.prerequisites.every(
                (name) => typeof name === "string" && /^[a-z0-9][a-z0-9+.-]{0,63}$/u.test(name),
            )
        )
            throw new Error("protocol");
        result.prerequisites = [...raw.prerequisites];
    }
    if (raw.connection !== undefined) {
        const connection = raw.connection;
        if (!object(connection) || !validRemoteHost(connection.remoteHost))
            throw new Error("protocol");
        if (
            connection.loginName !== undefined &&
            (typeof connection.loginName !== "string" ||
                connection.loginName.length < 1 ||
                connection.loginName.length > 200 ||
                [...connection.loginName].some(
                    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
                ))
        )
            throw new Error("protocol");
        if (
            !object(connection) ||
            !Number.isInteger(connection.webPort) ||
            (connection.webPort as number) < 1 ||
            (connection.webPort as number) > 65535 ||
            typeof connection.certificateSha256 !== "string" ||
            !/^[a-f0-9]{64}$/iu.test(connection.certificateSha256) ||
            typeof connection.instanceId !== "string" ||
            !/^[A-Za-z0-9._-]{1,128}$/u.test(connection.instanceId) ||
            !member(connection.ownerSetup, ["required", "ready", "unknown"] as const) ||
            !validClientOrigin(connection.origin) ||
            !Array.isArray(connection.allowedOrigins) ||
            connection.allowedOrigins.length > 128 ||
            !connection.allowedOrigins.every(validClientOrigin) ||
            !member(connection.profile, ["hgn", "hg"] as const) ||
            !object(connection.capabilities) ||
            typeof connection.capabilities.sameOriginWeb !== "boolean" ||
            typeof connection.capabilities.tunnelCompatible !== "boolean" ||
            (connection.capabilities.requiredLocalPort !== undefined &&
                (!Number.isInteger(connection.capabilities.requiredLocalPort) ||
                    (connection.capabilities.requiredLocalPort as number) < 1024 ||
                    (connection.capabilities.requiredLocalPort as number) > 65535))
        )
            throw new Error("protocol");
        result.connection = {
            webPort: connection.webPort as number,
            remoteHost: connection.remoteHost,
            certificateSha256: connection.certificateSha256.toUpperCase(),
            instanceId: connection.instanceId,
            ownerSetup: connection.ownerSetup,
            ...(connection.loginName !== undefined
                ? { loginName: connection.loginName as string }
                : {}),
            origin: connection.origin,
            allowedOrigins: [...connection.allowedOrigins] as string[],
            profile: connection.profile,
            capabilities: {
                sameOriginWeb: connection.capabilities.sameOriginWeb,
                tunnelCompatible: connection.capabilities.tunnelCompatible,
                ...(connection.capabilities.requiredLocalPort !== undefined
                    ? { requiredLocalPort: connection.capabilities.requiredLocalPort as number }
                    : {}),
            },
        };
    }
    if (
        ["found", "installed", "owner_ready", "origin_ready"].includes(result.status) &&
        !result.connection
    )
        throw new Error("protocol");
    return { type: "result", result };
}

export function validClientOrigin(value: unknown): value is string {
    if (typeof value !== "string" || !/^https:\/\/localhost:[1-9][0-9]{3,4}$/u.test(value))
        return false;
    const port = Number(value.slice(value.lastIndexOf(":") + 1));
    return port >= 1024 && port <= 65535;
}

/** Streaming UTF-8 decoder and strict line limits, even when a peer never sends a newline. */
export class ProvisionDecoder {
    readonly #decoder = new TextDecoder("utf-8", { fatal: true });
    #pending = "";
    #bytes = 0;
    readonly #requestId: string;
    constructor(requestId: string) {
        this.#requestId = requestId;
    }
    push(bytes: Uint8Array): ProvisionEvent[] {
        this.#bytes += bytes.length;
        if (this.#bytes > 1_048_576) throw new Error("protocol");
        this.#pending += this.#decoder.decode(bytes, { stream: true });
        const events: ProvisionEvent[] = [];
        let newline: number;
        while ((newline = this.#pending.indexOf("\n")) >= 0) {
            if (newline > 16_384) throw new Error("protocol");
            const line = this.#pending.slice(0, newline);
            this.#pending = this.#pending.slice(newline + 1);
            events.push(publicEvent(JSON.parse(line), this.#requestId));
        }
        if (this.#pending.length > 16_384) throw new Error("protocol");
        return events;
    }
    finish(): void {
        if (this.#decoder.decode() !== "" || this.#pending !== "") throw new Error("protocol");
    }
}
