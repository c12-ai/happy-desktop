/** Only profile names are read from config; ssh resolves credentials itself. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ServerEntry } from "./servers";
import { portFree } from "./tunnel";

export function validAlias(value: unknown): value is string {
    return (
        typeof value === "string" &&
        value.length <= 255 &&
        /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
    );
}

/** Wildcards, negations and options are never offered as connection targets. */
export function profileNames(config: string): string[] {
    const names = new Set<string>();
    for (const line of config.split(/\r?\n/u)) {
        const match = /^\s*Host(?:\s+|=)([^#]*)/iu.exec(line);
        if (!match) continue;
        for (const field of match[1].trim().split(/\s+/u)) {
            const value = field.replace(/^(["'])(.*)\1$/u, "$2");
            if (validAlias(value)) names.add(value);
        }
    }
    return [...names].sort((a, b) => a.localeCompare(b));
}

export async function sshProfiles(): Promise<string[]> {
    try {
        const config = await readFile(join(homedir(), ".ssh", "config"), "utf8");
        return config.length <= 1_048_576 ? profileNames(config) : [];
    } catch {
        return [];
    }
}

/** Stable starting point, with an availability check before committing an origin. */
export function preferredLocalPort(alias: string): number {
    return 47443 + (createHash("sha256").update(alias).digest().readUInt32BE(0) % 13557);
}

export async function chooseLocalPort(
    alias: string,
    servers: readonly ServerEntry[],
): Promise<number> {
    const existing = servers.find((entry) => entry.ssh?.alias === alias)?.ssh;
    if (existing) return existing.localPort;
    const reserved = new Set(servers.flatMap((entry) => (entry.ssh ? [entry.ssh.localPort] : [])));
    const first = preferredLocalPort(alias);
    for (let offset = 0; offset < 13557; offset++) {
        const port = 47443 + ((first - 47443 + offset) % 13557);
        if (!reserved.has(port) && (await portFree(port))) return port;
    }
    throw new Error("No local port is available for another server.");
}
