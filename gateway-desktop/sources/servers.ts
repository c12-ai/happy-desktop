/**
 * The servers this app opens: Happy Gateway addresses the person entered, and
 * how each is kept on disk. Nothing here uses Electron, so the checks import it
 * as it is.
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
            const servers = (Array.isArray(raw.servers) ? raw.servers : []).flatMap(
                (entry): ServerEntry[] => {
                    const parsed =
                        typeof entry?.origin === "string" ? serverAddressParse(entry.origin) : null;
                    return parsed?.ok === true && parsed.origin === entry.origin
                        ? [
                              {
                                  origin: parsed.origin,
                                  ...(boundsValid(entry.bounds) ? { bounds: entry.bounds } : {}),
                              },
                          ]
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

    add(origin: string): void {
        if (this.has(origin)) return;
        this.#state.servers.push({ origin });
        this.#write();
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
