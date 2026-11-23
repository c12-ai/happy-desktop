/**
 * The servers this app opens: Happy Gateway addresses the person entered, or
 * gateways reached through an SSH tunnel, and how each is kept on disk.
 * Nothing here uses Electron, so the checks import it as it is.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Offered on first launch; the person may replace it before adding. */
export const DEFAULT_SERVER = "www.karis.ink";

export type AddressResult = { ok: true; origin: string } | { ok: false; message: string };

/**
 * Turns what the person typed into an exact https origin, or says why not.
 * A bare name gets `https://`. Anything that is not a plain origin is refused
 * rather than trimmed: a path, a query, a fragment, a user name or password,
 * an IP address, http, or characters a URL parser would quietly repair.
 */
export function serverAddressParse(input: string): AddressResult {
    const text = input.trim();
    if (text === "") return { ok: false, message: "Enter the server's address." };
    if (text.length > 253 + 16) return { ok: false, message: "That address is too long." };
    // Before the parser sees it: it would drop tabs and newlines and turn backslashes into slashes.
    if (
        /[\s\\]/u.test(text) ||
        [...text].some(
            (character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f,
        )
    )
        return { ok: false, message: "An address has no spaces or backslashes." };
    // "name:8443" is a name and a port, not a scheme called "name".
    const hasScheme =
        /^[a-z][a-z0-9+.-]*:/iu.test(text) && !/^[^/?#@:]+:\d+(?:[/?#]|$)/u.test(text);
    if (hasScheme && !/^https:\/\//iu.test(text))
        return { ok: false, message: "Only https:// addresses are accepted." };
    let url: URL;
    try {
        url = new URL(hasScheme ? text : `https://${text}`);
    } catch {
        return { ok: false, message: "That isn't a valid address." };
    }
    if (url.protocol !== "https:")
        return { ok: false, message: "Only https:// addresses are accepted." };
    if (url.username !== "" || url.password !== "" || /@/u.test(text))
        return { ok: false, message: "An address has no user name or password in it." };
    const rest = text.replace(/^https:\/\//iu, "").replace(/^[^/?#]*/u, "");
    if (rest !== "" && rest !== "/")
        return { ok: false, message: "Enter the address only, with no path, ? or #." };
    const host = url.hostname;
    if (host === "" || host.startsWith("[") || /^[0-9.]+$/u.test(host))
        return { ok: false, message: "Enter the server's name, not an IP address." };
    if (
        !/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/u.test(
            host,
        )
    )
        return { ok: false, message: "That isn't a valid server name." };
    // A certificate this computer trusts never names a single-label host such as "localhost".
    if (!host.includes("."))
        return { ok: false, message: "Enter the server's full name, such as www.example.com." };
    return { ok: true, origin: url.origin };
}

/** What the window title and the list show: the name, and the port where it is not 443. */
export function serverLabel(origin: string): string {
    return new URL(origin).host;
}

/**
 * The gateway port the SSH form suggests: where the gateway listens on the
 * server's own loopback. The local port suggested is the same number, so one
 * origin (https://localhost:<port>) serves every computer.
 */
export const DEFAULT_TUNNEL_PORT = 8443;

/**
 * A gateway reached through `ssh -L`: the ~/.ssh/config host the person named,
 * the gateway's port on that host's loopback, the port on this computer's
 * loopback the tunnel listens on, and the SHA-256 fingerprint of the
 * certificate the gateway must present there.
 */
export interface SshTunnel {
    alias: string;
    remotePort: number;
    localPort: number;
    fingerprint: string;
}

export type SshResult = { ok: true; tunnel: SshTunnel } | { ok: false; message: string };

/**
 * A host alias as ssh reads it from ~/.ssh/config: letters, digits, dots,
 * hyphens and underscores, never starting with a hyphen, so it can never be
 * read as an option.
 */
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/** The four fields of the SSH form, checked as strictly as an address is. */
export function sshServerParse(fields: {
    alias: string;
    remotePort: string;
    localPort: string;
    fingerprint: string;
}): SshResult {
    const alias = fields.alias.trim();
    if (alias === "") return { ok: false, message: "Enter the SSH host, as in ~/.ssh/config." };
    if (alias.length > 255 || !ALIAS.test(alias))
        return {
            ok: false,
            message:
                "An SSH host is a name from ~/.ssh/config: letters, digits, dots, hyphens and underscores, starting with a letter or digit.",
        };
    const remotePort = portParse(fields.remotePort, 1);
    if (remotePort === null)
        return { ok: false, message: "The gateway port is a number from 1 to 65535." };
    const localPort = portParse(fields.localPort, 1024);
    if (localPort === null)
        return { ok: false, message: "The local port is a number from 1024 to 65535." };
    const fingerprint = fingerprintParse(fields.fingerprint);
    if (fingerprint === null)
        return {
            ok: false,
            message:
                "Paste the certificate's SHA-256 fingerprint you were given: 32 pairs of hex digits.",
        };
    return { ok: true, tunnel: { alias, remotePort, localPort, fingerprint } };
}

/** A port as typed: digits only, no sign, no leading zero, no spaces. */
function portParse(text: string, lowest: number): number | null {
    if (!/^[1-9][0-9]{0,4}$/u.test(text)) return null;
    const port = Number(text);
    return port >= lowest && port <= 65535 ? port : null;
}

/**
 * A SHA-256 fingerprint as the person pastes it, in the form `openssl x509
 * -fingerprint -sha256` prints (with or without its "sha256 Fingerprint="
 * label, colons, spaces or line breaks, in either case), written back as 32
 * upper-case pairs joined by colons.
 */
export function fingerprintParse(text: string): string | null {
    const hex = text
        .trim()
        .replace(/^(?:sha-?256\s*)?fingerprint\s*=\s*/iu, "")
        .replace(/[:\s]/gu, "");
    if (!/^[0-9a-f]{64}$/iu.test(hex)) return null;
    return hex.toUpperCase().match(/../gu)!.join(":");
}

/** The fingerprint of a certificate in PEM form: SHA-256 of its DER bytes, as openssl prints it. */
export function certificateFingerprint(pem: string): string {
    const body = /-----BEGIN CERTIFICATE-----([^-]+)-----END CERTIFICATE-----/u.exec(pem)?.[1];
    if (body === undefined) return "";
    const der = Buffer.from(body.replace(/\s/gu, ""), "base64");
    return createHash("sha256").update(der).digest("hex").toUpperCase().match(/../gu)!.join(":");
}

/** Where the tunnel puts a server: https on this computer's loopback, at the local port. */
export function tunnelOrigin(tunnel: SshTunnel): string {
    return `https://localhost:${tunnel.localPort}`;
}

/** What the window title and the list show for a tunnelled server. */
export function entryLabel(entry: ServerEntry): string {
    return entry.ssh === undefined ? serverLabel(entry.origin) : `${entry.ssh.alias} (SSH)`;
}

/**
 * A server's cookie store. A tunnelled server's is named by its alias, both ports
 * and fingerprint: reused ports and replacement certificates never share cookies
 * or Chromium's cached certificate decisions.
 */
export function entryPartition(entry: ServerEntry): string {
    if (entry.ssh === undefined) return serverPartition(entry.origin);
    const { alias, remotePort, localPort, fingerprint } = entry.ssh;
    return `persist:server-${createHash("sha256").update(`ssh:${alias}:${remotePort}:${localPort}:${fingerprint}`).digest("hex").slice(0, 32)}`;
}

/**
 * Each server's own cookie store and cache. The name is derived from the
 * origin, so the same server always finds its own store again and two servers
 * never share one.
 */
export function serverPartition(origin: string): string {
    return `persist:server-${createHash("sha256").update(origin).digest("hex").slice(0, 32)}`;
}

export interface WindowBounds {
    x?: number;
    y?: number;
    width: number;
    height: number;
}

export interface ServerEntry {
    origin: string;
    /** Present when the server is reached through an SSH tunnel. */
    ssh?: SshTunnel;
    bounds?: WindowBounds;
}

export interface ServerState {
    servers: ServerEntry[];
    /** Origins whose windows were open when the app last quit, reopened at launch. */
    open: string[];
}

/** The server list in one JSON file, rewritten whole through a rename. */
export class ServerStore {
    readonly #path: string;
    #state: ServerState;

    constructor(path: string) {
        this.#path = path;
        this.#state = ServerStore.#read(path);
    }

    static #read(path: string): ServerState {
        try {
            const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ServerState>;
            // A file edited by hand is read with the same rules as typed input.
            const localPorts = new Set<number>();
            const servers = (Array.isArray(raw.servers) ? raw.servers : []).flatMap(
                (entry): ServerEntry[] => {
                    const bounds = boundsValid(entry?.bounds) ? { bounds: entry.bounds } : {};
                    if (entry?.ssh !== undefined) {
                        const tunnel = sshEntryRead(entry.ssh);
                        if (
                            tunnel === null ||
                            entry.origin !== tunnelOrigin(tunnel) ||
                            localPorts.has(tunnel.localPort)
                        )
                            return [];
                        localPorts.add(tunnel.localPort);
                        return [{ origin: entry.origin, ssh: tunnel, ...bounds }];
                    }
                    const parsed =
                        typeof entry?.origin === "string" ? serverAddressParse(entry.origin) : null;
                    return parsed?.ok === true && parsed.origin === entry.origin
                        ? [{ origin: parsed.origin, ...bounds }]
                        : [];
                },
            );
            const known = new Set(servers.map((entry) => entry.origin));
            const open = (Array.isArray(raw.open) ? raw.open : []).filter(
                (origin): origin is string => typeof origin === "string" && known.has(origin),
            );
            return { servers, open };
        } catch {
            return { servers: [], open: [] };
        }
    }

    list(): readonly ServerEntry[] {
        return this.#state.servers;
    }

    has(origin: string): boolean {
        return this.#state.servers.some((entry) => entry.origin === origin);
    }

    get(origin: string): ServerEntry | undefined {
        return this.#state.servers.find((entry) => entry.origin === origin);
    }

    openOrigins(): readonly string[] {
        return this.#state.open;
    }

    add(origin: string, ssh?: SshTunnel): void {
        if (this.has(origin)) return;
        this.#state.servers.push(ssh === undefined ? { origin } : { origin, ssh });
        this.#write();
    }

    /** The tunnelled server that already uses `localPort`, if any. */
    byLocalPort(localPort: number): ServerEntry | undefined {
        return this.#state.servers.find((entry) => entry.ssh?.localPort === localPort);
    }

    remove(origin: string): void {
        this.#state.servers = this.#state.servers.filter((entry) => entry.origin !== origin);
        this.#state.open = this.#state.open.filter((entry) => entry !== origin);
        this.#write();
    }

    boundsSet(origin: string, bounds: WindowBounds): void {
        const entry = this.get(origin);
        if (entry === undefined) return;
        entry.bounds = bounds;
        this.#write();
    }

    openSet(origins: readonly string[]): void {
        this.#state.open = origins.filter((origin) => this.has(origin));
        this.#write();
    }

    #write(): void {
        mkdirSync(dirname(this.#path), { recursive: true });
        const temporary = `${this.#path}.new`;
        writeFileSync(temporary, `${JSON.stringify(this.#state, null, 4)}\n`, { mode: 0o600 });
        renameSync(temporary, this.#path);
    }
}

/** A tunnel from servers.json, held to the same rules as the form. */
function sshEntryRead(value: unknown): SshTunnel | null {
    if (typeof value !== "object" || value === null) return null;
    const raw = value as Record<string, unknown>;
    if (
        typeof raw.alias !== "string" ||
        typeof raw.remotePort !== "number" ||
        typeof raw.localPort !== "number" ||
        typeof raw.fingerprint !== "string"
    )
        return null;
    const parsed = sshServerParse({
        alias: raw.alias,
        remotePort: String(raw.remotePort),
        localPort: String(raw.localPort),
        fingerprint: raw.fingerprint,
    });
    return parsed.ok &&
        parsed.tunnel.alias === raw.alias &&
        parsed.tunnel.fingerprint === raw.fingerprint
        ? parsed.tunnel
        : null;
}

function boundsValid(value: unknown): value is WindowBounds {
    if (typeof value !== "object" || value === null) return false;
    const bounds = value as Record<string, unknown>;
    const finite = (key: string) => typeof bounds[key] === "number" && Number.isFinite(bounds[key]);
    return (
        finite("width") &&
        finite("height") &&
        (bounds.x === undefined || finite("x")) &&
        (bounds.y === undefined || finite("y"))
    );
}
