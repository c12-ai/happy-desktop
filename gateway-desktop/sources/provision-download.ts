/** A pinned installer asset, fetched only after an explicit setup action. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { request } from "node:https";
import { type IncomingMessage } from "node:http";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ProvisionError } from "./provision-ssh";

export interface PayloadDescriptor {
    file: string;
    sha256: string;
    bytes: number;
    url?: string | null;
}
export function releaseUrl(value: unknown): URL | null {
    try {
        if (typeof value !== "string") return null;
        const url = new URL(value);
        if (
            url.protocol !== "https:" ||
            url.hostname !== "github.com" ||
            url.port ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/download\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.tar\.xz$/u.test(
                url.pathname,
            )
        )
            return null;
        return url;
    } catch {
        return null;
    }
}
function redirectUrl(value: string, previous: URL): URL {
    const next = new URL(value, previous);
    if (
        next.protocol !== "https:" ||
        next.port ||
        next.username ||
        next.password ||
        next.hash ||
        !["github.com", "release-assets.githubusercontent.com"].includes(next.hostname)
    )
        throw new ProvisionError("download_failed");
    return next;
}
async function response(url: URL, signal: AbortSignal, redirects = 0): Promise<IncomingMessage> {
    if (signal.aborted) throw new ProvisionError("cancelled");
    if (redirects > 3) throw new ProvisionError("download_failed");
    const answer = await new Promise<IncomingMessage>((resolve, reject) => {
        const req = request(
            url,
            {
                method: "GET",
                signal,
                headers: { "user-agent": "Karis-Workbench", accept: "application/octet-stream" },
            },
            resolve,
        );
        req.setTimeout(60_000, () => req.destroy(new Error("Download timed out.")));
        req.once("error", reject);
        req.end();
    });
    if ([301, 302, 303, 307, 308].includes(answer.statusCode ?? 0)) {
        const location = answer.headers.location;
        answer.destroy();
        if (!location) throw new ProvisionError("download_failed");
        return response(redirectUrl(location, url), signal, redirects + 1);
    }
    if (answer.statusCode !== 200) {
        answer.destroy();
        throw new ProvisionError("download_failed");
    }
    return answer;
}

export class PayloadDownloader {
    readonly #abort = new AbortController();
    constructor(
        readonly fetchResponse: (
            url: URL,
            signal: AbortSignal,
        ) => Promise<IncomingMessage> = response,
    ) {}
    cancel(): void {
        this.#abort.abort();
    }
    async ensure(
        descriptor: PayloadDescriptor,
        directory: string,
        progress: (received: number, total: number) => void,
    ): Promise<string> {
        if (
            !/^[a-f0-9]{64}$/u.test(descriptor.sha256) ||
            !Number.isSafeInteger(descriptor.bytes) ||
            descriptor.bytes < 1 ||
            descriptor.bytes > 2_147_483_648
        )
            throw new ProvisionError("payload_mismatch");
        const signal = this.#abort.signal;
        const currentUid = process.getuid?.();
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const dir = await lstat(directory);
        if (
            !dir.isDirectory() ||
            dir.isSymbolicLink() ||
            (currentUid !== undefined && dir.uid !== currentUid) ||
            dir.mode & 0o022
        )
            throw new ProvisionError("payload_unsafe");
        const file = join(directory, `payload-${descriptor.sha256}.tar.xz`);
        const validCache = async () => {
            let handle;
            try {
                handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
                const stat = await handle.stat();
                if (
                    !stat.isFile() ||
                    stat.size !== descriptor.bytes ||
                    (currentUid !== undefined && stat.uid !== currentUid) ||
                    stat.mode & 0o022
                )
                    return false;
                const hash = createHash("sha256");
                for await (const chunk of handle.createReadStream({ autoClose: false })) {
                    if (signal.aborted) throw new ProvisionError("cancelled");
                    hash.update(chunk);
                }
                return hash.digest("hex") === descriptor.sha256;
            } catch (error) {
                if (signal.aborted) throw error;
                return false;
            } finally {
                await handle?.close();
            }
        };
        if (await validCache()) {
            progress(descriptor.bytes, descriptor.bytes);
            return file;
        }
        const url = releaseUrl(descriptor.url);
        if (!url) throw new ProvisionError("release_unavailable");
        const temporary = join(directory, `.download-${randomUUID()}`);
        const timer = setTimeout(() => this.cancel(), 30 * 60_000);
        let handle;
        try {
            const incoming = await this.fetchResponse(url, signal);
            const advertised = incoming.headers["content-length"];
            if (
                advertised !== undefined &&
                (!/^[0-9]+$/u.test(advertised) || Number(advertised) !== descriptor.bytes)
            ) {
                incoming.destroy();
                throw new ProvisionError("payload_mismatch");
            }
            handle = await open(temporary, "wx", 0o600);
            const hash = createHash("sha256");
            let received = 0;
            progress(0, descriptor.bytes);
            const verify = new Transform({
                transform(chunk: Buffer, _encoding, callback) {
                    received += chunk.length;
                    if (received > descriptor.bytes)
                        return callback(new ProvisionError("payload_mismatch"));
                    hash.update(chunk);
                    progress(received, descriptor.bytes);
                    callback(null, chunk);
                },
            });
            await pipeline(incoming, verify, handle.createWriteStream({ autoClose: true }), {
                signal,
            });
            handle = undefined;
            if (received !== descriptor.bytes || hash.digest("hex") !== descriptor.sha256)
                throw new ProvisionError("payload_mismatch");
            if (signal.aborted) throw new ProvisionError("cancelled");
            await rename(temporary, file);
            return file;
        } catch (error) {
            if (signal.aborted) throw new ProvisionError("cancelled");
            if (error instanceof ProvisionError) throw error;
            throw new ProvisionError("download_failed");
        } finally {
            clearTimeout(timer);
            await handle?.close();
            await unlink(temporary).catch(() => {});
        }
    }
}
