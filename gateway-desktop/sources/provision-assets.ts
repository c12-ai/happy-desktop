/** App-owned, signed resources; no remote or renderer code becomes a launcher. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { shellQuote } from "./provision-ssh";
import { PayloadDownloader, type PayloadDescriptor } from "./provision-download";

export interface ProvisionManifest {
    v: 1;
    payload: PayloadDescriptor;
    helper: string;
    bootstrap: string;
    apt: string;
    upload: string;
}
export interface ProvisionBundle {
    manifest: ProvisionManifest;
    payloadPath: string;
    uploadCommand: string;
    ensurePayload?: (
        downloader: PayloadDownloader,
        progress: (received: number, total: number) => void,
    ) => Promise<string>;
    bootstrap(mode: "probe" | "install" | "root"): string;
}
function replaceOnce(source: string, placeholder: string, value: string): string {
    if (source.split(placeholder).length !== 2) throw new Error("Invalid bundled setup template.");
    return source.replace(placeholder, () => value);
}

export async function loadProvisionBundle(
    directory: string,
    payloadDirectory: string,
): Promise<ProvisionBundle> {
    const manifest = JSON.parse(
        await readFile(join(directory, "manifest.json"), "utf8"),
    ) as ProvisionManifest;
    if (
        manifest.v !== 1 ||
        !manifest.payload ||
        !/^[a-zA-Z0-9._-]+\.tar\.xz$/u.test(manifest.payload.file) ||
        !/^[a-f0-9]{64}$/u.test(manifest.payload.sha256) ||
        !Number.isSafeInteger(manifest.payload.bytes) ||
        manifest.payload.bytes <= 0 ||
        manifest.payload.bytes > 2_147_483_648 ||
        manifest.helper !== "remote.py" ||
        manifest.bootstrap !== "bootstrap.sh" ||
        manifest.apt !== "apt.sh" ||
        manifest.upload !== "upload.sh"
    )
        throw new Error("Invalid bundled setup manifest.");
    const [helper, bootstrap, apt] = await Promise.all(
        [manifest.helper, manifest.bootstrap, manifest.apt].map((file) =>
            readFile(join(directory, file), "utf8"),
        ),
    );
    let renderedHelper = replaceOnce(helper, "__KARIS_APT_HEX__", Buffer.from(apt).toString("hex"));
    renderedHelper = replaceOnce(
        renderedHelper,
        "__KARIS_PAYLOAD_SHA256__",
        manifest.payload.sha256,
    );
    renderedHelper = replaceOnce(
        renderedHelper,
        "__KARIS_PAYLOAD_BYTES__",
        String(manifest.payload.bytes),
    );
    renderedHelper = replaceOnce(
        renderedHelper,
        "__KARIS_PACKAGE_MANIFEST_HEX__",
        Buffer.from(JSON.stringify(manifest)).toString("hex"),
    );
    const program = shellQuote(
        `import zlib;exec(zlib.decompress(bytes.fromhex("${deflateSync(Buffer.from(renderedHelper)).toString("hex")}")))`,
    );
    const template = replaceOnce(
        replaceOnce(bootstrap, "__KARIS_APT_PROGRAM__", apt),
        "__KARIS_PYTHON_EXEC__",
        program,
    );
    const upload = replaceOnce(
        replaceOnce(
            await readFile(join(directory, manifest.upload), "utf8"),
            "__KARIS_PAYLOAD_SHA256__",
            manifest.payload.sha256,
        ),
        "__KARIS_PAYLOAD_BYTES__",
        String(manifest.payload.bytes),
    );
    return {
        manifest,
        payloadPath: join(payloadDirectory, manifest.payload.file),
        ensurePayload: (downloader, progress) =>
            downloader.ensure(manifest.payload, payloadDirectory, progress),
        uploadCommand: `/bin/sh -c ${shellQuote(upload)}`,
        bootstrap: (mode) => replaceOnce(template, "__KARIS_MODE__", mode),
    };
}
