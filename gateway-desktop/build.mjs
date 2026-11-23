/**
 * Builds Karis Workbench: the macOS app (and a Linux one, for the checks)
 * from sources/ with the Electron and electron-builder this repository's
 * lockfile already pins for happy-desktop-electron.
 *
 *   node gateway-desktop/build.mjs --platform mac --arch arm64,x64 --electron-dist <dir>
 *   node gateway-desktop/build.mjs --platform linux --arch x64 --electron-dist <dir>
 *
 * <dir> holds electron-v<version>-<platform>-<arch>.zip, already checked
 * against Electron's checksums; nothing is downloaded here. The macOS app is
 * signed ad hoc (no Developer ID, no notarization): with `codesign` on a Mac,
 * otherwise with `rcodesign` (RCODESIGN names it, else PATH). It is then zipped
 * with its symlinks kept, which electron-builder's own zip does only on macOS.
 *
 * The app has no updater, no analytics and no update manifest, and the build
 * checks the packaged result for each of those, for certificate exceptions
 * (one pinned-certificate check, for SSH-tunnelled servers, and no other), for
 * the programs it may start (ssh and ps) and for the Electron fuses, before it
 * writes the zip.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    cpSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const workspace = resolve(here, "..");
const toolPackage = join(workspace, "packages", "happy-desktop-electron");
const requireTool = createRequire(join(toolPackage, "package.json"));
const packageJson = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
const version = process.env.RELEASE_VERSION || packageJson.version;
const electronVersion = JSON.parse(
    readFileSync(requireTool.resolve("electron/package.json"), "utf8"),
).version;
const platform = argument("--platform", ["mac", "linux"]);
const architectures = argument("--arch", ["arm64", "x64", "arm64,x64"]).split(",");
const electronDist = resolve(argument("--electron-dist"));

const PRODUCT = "Karis Workbench";
const APP_ID = "ink.karis.workbench";
const ARTIFACT = "Karis-Workbench";
const FUSES = {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    // The app loads nothing from file://; upstream leaves Electron's default here.
    grantFileProtocolExtraPrivileges: false,
};
/**
 * Strings no file of the packaged app may contain: upstream's servers, an
 * updater, analytics, a certificate exception. setCertificateVerifyProc is
 * not among them; CERTIFICATE_CHECKS holds it to one call, in main.js.
 */
const FORBIDDEN = [
    "slopus",
    "happy.engineering",
    "happybases",
    "happy-clusters",
    "api.github.com",
    "githubusercontent",
    "electron-updater",
    "autoUpdater",
    "posthog",
    '"certificate-error"',
    "importCertificate",
    "NODE_EXTRA_CA_CERTS",
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "rejectUnauthorized",
    "appendSwitch",
];

/** main.js calls setCertificateVerifyProc exactly once: pinnedTrust, for tunnelled servers' own stores. */
const CERTIFICATE_CHECKS = 1;
/** The only programs the app starts, and the one place it starts them. */
const PROGRAMS = ["/usr/bin/ssh", "/bin/ps"];

// The tools are happy-desktop-electron's own; the app itself has no dependencies.
const modules = join(here, "node_modules");
if (!existsSync(modules)) symlinkSync(relative(here, join(toolPackage, "node_modules")), modules);

const release = join(here, "release");
const dist = join(here, "dist");
rmSync(dist, { recursive: true, force: true });
await bundle();
const icon = await iconRender();

const results = [];
for (const arch of architectures) {
    const zipName = `electron-v${electronVersion}-${platform === "mac" ? "darwin" : "linux"}-${arch}.zip`;
    if (!existsSync(join(electronDist, zipName)))
        throw new Error(`${zipName} is not in ${electronDist}.`);
    const output = join(release, `${platform}-${arch}`);
    rmSync(output, { recursive: true, force: true });
    await pack(arch, output, icon);
    if (platform === "mac") {
        const application = join(output, arch === "arm64" ? "mac-arm64" : "mac", `${PRODUCT}.app`);
        await packagedVerify(
            join(application, "Contents", "Resources"),
            join(application, "Contents", "MacOS", PRODUCT),
        );
        plistVerify(join(application, "Contents", "Info.plist"));
        sign(application);
        const zip = join(release, `${ARTIFACT}-${version}-${arch}-mac.zip`);
        zipWrite(application, zip);
        results.push({ arch, application, zip, sha256: sha256(zip) });
    } else {
        const directory = join(
            output,
            arch === "arm64" ? "linux-arm64-unpacked" : "linux-unpacked",
        );
        await packagedVerify(join(directory, "resources"), join(directory, "karis-workbench"));
        results.push({ arch, application: directory });
    }
}
writeFileSync(
    join(release, `${platform}-build.json`),
    `${JSON.stringify({ version, electronVersion, platform, results }, null, 4)}\n`,
);
for (const result of results)
    console.log(
        `built ${platform} ${result.arch}: ${result.zip ?? result.application}${result.sha256 ? ` (sha256 ${result.sha256})` : ""}`,
    );

async function bundle() {
    const { build } = await import(pathToFileURL(requireTool.resolve("vite")).href);
    const common = { root: here, configFile: false, logLevel: "warn", publicDir: false };
    await build({
        ...common,
        build: {
            ssr: join(here, "sources", "main.ts"),
            outDir: dist,
            emptyOutDir: false,
            minify: false,
            target: "node22",
            rollupOptions: {
                external: ["electron"],
                output: { format: "es", entryFileNames: "main.js" },
            },
        },
    });
    await build({
        ...common,
        build: {
            outDir: dist,
            emptyOutDir: false,
            minify: false,
            lib: {
                entry: join(here, "sources", "preload.ts"),
                formats: ["cjs"],
                fileName: () => "preload.cjs",
            },
            rollupOptions: { external: ["electron"] },
        },
    });
    cpSync(join(here, "ui"), join(dist, "ui"), { recursive: true });
}

/** The mark on upstream's tile: the same canvas, tile size and corner radius as scripts/create-mac-icon.mjs. */
async function iconRender() {
    const sharp = (
        await import(
            pathToFileURL(createRequire(join(workspace, "package.json")).resolve("sharp")).href
        )
    ).default;
    const canvasSize = 1024;
    const tileSize = 824;
    const tileCornerRadius = 185;
    const roundedTile = Buffer.from(
        `<svg width="${tileSize}" height="${tileSize}"><rect width="${tileSize}" height="${tileSize}" rx="${tileCornerRadius}" fill="white"/></svg>`,
    );
    const tile = await sharp(join(here, "assets", "icon-source.svg"))
        .resize(tileSize, tileSize)
        .composite([{ input: roundedTile, blend: "dest-in" }])
        .png()
        .toBuffer();
    const path = join(release, ".icon", "icon.png");
    mkdirSync(join(release, ".icon"), { recursive: true });
    await sharp({
        create: {
            width: canvasSize,
            height: canvasSize,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
    })
        .composite([
            { input: tile, left: (canvasSize - tileSize) / 2, top: (canvasSize - tileSize) / 2 },
        ])
        .png()
        .toFile(path);
    // The .icns iconutil would write: PNGs of each size in one container. electron-builder would
    // otherwise download a converter of its own from GitHub.
    const icns = join(release, ".icon", "icon.icns");
    const kinds = [
        ["icp4", 16],
        ["icp5", 32],
        ["ic11", 32],
        ["ic12", 64],
        ["ic07", 128],
        ["ic13", 256],
        ["ic08", 256],
        ["ic14", 512],
        ["ic09", 512],
        ["ic10", 1024],
    ];
    const parts = [];
    for (const [kind, size] of kinds) {
        const png = await sharp(path).resize(size, size).png().toBuffer();
        const head = Buffer.alloc(8);
        head.write(kind, 0, "latin1");
        head.writeUInt32BE(png.length + 8, 4);
        parts.push(head, png);
    }
    const head = Buffer.alloc(8);
    head.write("icns", 0, "latin1");
    head.writeUInt32BE(8 + parts.reduce((sum, part) => sum + part.length, 0), 4);
    writeFileSync(icns, Buffer.concat([head, ...parts]));
    return { png: path, icns };
}

async function pack(arch, output, icons) {
    const { Arch, Platform, build } = requireTool("electron-builder");
    // Only what the app runs: its package.json and the bundle.
    const staging = join(release, ".staging");
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    cpSync(dist, join(staging, "dist"), { recursive: true });
    writeFileSync(
        join(staging, "package.json"),
        `${JSON.stringify({ ...packageJson, version }, null, 4)}\n`,
    );
    const config = {
        appId: APP_ID,
        productName: PRODUCT,
        electronVersion,
        electronDist,
        beforeBuild: () => false,
        npmRebuild: false,
        nodeGypRebuild: false,
        asar: true,
        files: ["dist/**/*", "package.json"],
        electronFuses: FUSES,
        publish: null,
        directories: { output, buildResources: join(here, "assets") },
        mac: {
            category: "public.app-category.productivity",
            icon: icons.icns,
            identity: null,
            hardenedRuntime: false,
            notarize: false,
            target: [{ target: "dir", arch: [arch] }],
            extendInfo: { LSApplicationCategoryType: "public.app-category.productivity" },
        },
        linux: {
            icon: icons.png,
            executableName: "karis-workbench",
            target: [{ target: "dir", arch: [arch] }],
        },
    };
    const target = platform === "mac" ? Platform.MAC : Platform.LINUX;
    try {
        await build({
            config,
            projectDir: staging,
            publish: "never",
            targets: target.createTarget(["dir"], arch === "arm64" ? Arch.arm64 : Arch.x64),
        });
    } finally {
        rmSync(staging, { recursive: true, force: true });
    }
}

/** What the packaged app must and must not be. */
async function packagedVerify(resources, executable) {
    if (existsSync(join(resources, "app-update.yml")))
        throw new Error(`${resources} has an app-update.yml: the app must have no update feed.`);
    const asar = createRequire(requireTool.resolve("electron-builder")).resolve("@electron/asar");
    const { extractFile, listPackage } = await import(pathToFileURL(asar).href);
    const archive = join(resources, "app.asar");
    const files = listPackage(archive, { isPack: false }).map((name) =>
        name.replace(/^[/\\]/u, ""),
    );
    for (const required of [
        "dist/main.js",
        "dist/preload.cjs",
        "dist/ui/chooser.html",
        "package.json",
    ])
        if (!files.includes(required)) throw new Error(`${archive} has no ${required}.`);
    const unexpected = files.filter(
        (name) =>
            !/^(dist(\/(main\.js|preload\.cjs|ui(\/chooser\.(html|css|js))?))?|package\.json)$/u.test(
                name,
            ),
    );
    if (unexpected.length > 0)
        throw new Error(`${archive} has files the app does not need: ${unexpected.join(", ")}`);
    for (const name of files.filter((file) => /\.(js|cjs|html|json)$/u.test(file))) {
        const text = extractFile(archive, name).toString("utf8");
        const found = FORBIDDEN.filter((token) => text.includes(token));
        if (found.length > 0)
            throw new Error(`${name} in ${archive} contains ${found.join(", ")}.`);
    }
    const main = extractFile(archive, "dist/main.js").toString("utf8");
    const verifyProcs = main.split("setCertificateVerifyProc").length - 1;
    if (verifyProcs !== CERTIFICATE_CHECKS)
        throw new Error(
            `dist/main.js calls setCertificateVerifyProc ${verifyProcs} times; only pinnedTrust may.`,
        );
    const processImports = [...main.matchAll(/^import .* from "(?:node:)?child_process";$/gmu)].map(
        (found) => found[0],
    );
    if (
        processImports.length !== 1 ||
        processImports[0] !== 'import { spawn } from "node:child_process";' ||
        main.split("spawn(").length - 1 !== 1 ||
        /\b(?:utilityProcess|execFileSync|spawnSync|execSync|shell\.openPath)\b/u.test(main)
    )
        throw new Error("dist/main.js starts processes other than through tunnel.ts's launch().");
    // Bundled, `const` may read `var`, and the set may carry a /* @__PURE__ */ mark.
    const declared = (name) =>
        new RegExp(`(?:const|let|var) ${name} = (?:/\\* @__PURE__ \\*/ )?(.+);`, "u").exec(
            main,
        )?.[1];
    const paths = [declared("SSH_PATH"), declared("PS_PATH")].map(
        (value) => value && JSON.parse(value),
    );
    if (
        declared("PROGRAMS") !== "new Set([SSH_PATH, PS_PATH])" ||
        JSON.stringify(paths) !== JSON.stringify(PROGRAMS)
    )
        throw new Error(`dist/main.js may start ${PROGRAMS.join(" and ")} only; found ${paths}.`);
    if (readdirSync(resources).some((name) => name === "node_modules" || name.endsWith(".node")))
        throw new Error(`${resources} carries native modules or node_modules.`);
    const fusesEntry = createRequire(requireTool.resolve("electron-builder")).resolve(
        "@electron/fuses",
    );
    const { FuseV1Options, getCurrentFuseWire } = await import(pathToFileURL(fusesEntry).href);
    const { FuseState } = await import(pathToFileURL(join(fusesEntry, "..", "constants.js")).href);
    const wire = await getCurrentFuseWire(executable);
    const expected = {
        [FuseV1Options.RunAsNode]: FuseState.DISABLE,
        [FuseV1Options.EnableCookieEncryption]: FuseState.ENABLE,
        [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: FuseState.DISABLE,
        [FuseV1Options.EnableNodeCliInspectArguments]: FuseState.DISABLE,
        [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: FuseState.ENABLE,
        [FuseV1Options.OnlyLoadAppFromAsar]: FuseState.ENABLE,
        [FuseV1Options.GrantFileProtocolExtraPrivileges]: FuseState.DISABLE,
    };
    for (const [fuse, state] of Object.entries(expected))
        if (wire[fuse] !== state)
            throw new Error(
                `${executable}: fuse ${FuseV1Options[fuse]} is ${wire[fuse]}, expected ${state}.`,
            );
    console.log(
        `checked ${archive}: ${files.length} entries, no update feed, no forbidden strings, one certificate check, programs ${PROGRAMS.join(" and ")} only, fuses as set`,
    );
}

function plistVerify(path) {
    const text = readFileSync(path, "utf8");
    const value = (key) =>
        text.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`, "u"))?.[1];
    if (value("CFBundleIdentifier") !== APP_ID)
        throw new Error(`${path}: CFBundleIdentifier is ${value("CFBundleIdentifier")}.`);
    if (value("CFBundleShortVersionString") !== version)
        throw new Error(`${path}: version is ${value("CFBundleShortVersionString")}.`);
    if (text.includes("CFBundleURLTypes"))
        throw new Error(`${path} registers URL schemes; the app has none.`);
    if (!text.includes("ElectronAsarIntegrity"))
        throw new Error(`${path} has no ElectronAsarIntegrity, so the asar fuse checks nothing.`);
}

/** An ad hoc signature: what Apple silicon needs to run the app at all. Not a Developer ID. */
function sign(application) {
    if (process.platform === "darwin") {
        execFileSync("codesign", ["--force", "--deep", "--sign", "-", application], {
            stdio: "inherit",
        });
        execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", application], {
            stdio: "inherit",
        });
        return;
    }
    const rcodesign = process.env.RCODESIGN || "rcodesign";
    execFileSync(rcodesign, ["sign", application], { stdio: ["ignore", "ignore", "inherit"] });
    // rcodesign's own `verify` says it is unreliable and trips on the empty CMS blob of an ad hoc
    // signature, so the signature is read back instead; a Mac checks it again with codesign.
    const frameworks = join(application, "Contents", "Frameworks");
    const signed = [
        join(application, "Contents", "MacOS", PRODUCT),
        join(frameworks, "Electron Framework.framework", "Versions", "A", "Electron Framework"),
        ...readdirSync(frameworks)
            .filter((name) => name.endsWith(".app"))
            .map((name) => join(frameworks, name, "Contents", "MacOS", name.slice(0, -4))),
    ];
    for (const path of signed) {
        const info = execFileSync(rcodesign, ["print-signature-info", path], { encoding: "utf8" });
        if (
            !info.includes("flags: CodeSignatureFlags(ADHOC)") ||
            !info.includes("digest_type: sha256")
        )
            throw new Error(`${path} has no ad hoc signature.`);
    }
    console.log(`signed ad hoc: ${signed.length} executables checked`);
}

/**
 * A zip of `directory` (kept as its top folder) with symlinks stored as
 * symlinks and Unix modes kept, as `ditto -c -k --keepParent` would write it.
 * Electron's frameworks are symlink trees that break the signature when
 * followed. Every entry is under 4 GB and there are fewer than 65535, so no
 * Zip64 is needed; both are checked.
 */
function zipWrite(directory, outFile) {
    const base = resolve(directory, "..");
    const entries = [];
    const walk = (path) => {
        const stat = lstatSync(path);
        const name = relative(base, path).split("\\").join("/");
        if (stat.isSymbolicLink())
            entries.push({ name, mode: 0o120755, data: Buffer.from(readlinkSync(path)) });
        else if (stat.isDirectory()) {
            entries.push({ name: `${name}/`, mode: 0o40755, data: Buffer.alloc(0) });
            for (const child of readdirSync(path).sort()) walk(join(path, child));
        } else
            entries.push({
                name,
                mode: 0o100000 | (stat.mode & 0o111 ? 0o755 : 0o644),
                data: readFileSync(path),
            });
    };
    walk(directory);
    if (entries.length >= 0xffff) throw new Error("Too many files for a zip without Zip64.");
    const chunks = [];
    const central = [];
    let offset = 0;
    for (const entry of entries) {
        const nameBytes = Buffer.from(entry.name, "utf8");
        const stored = entry.mode >> 12 !== 0o10 || entry.data.length === 0;
        const body = stored ? entry.data : deflateRawSync(entry.data, { level: 9 });
        if (body.length >= 0xffffffff || offset >= 0xffffffff)
            throw new Error("An entry is too large for a zip without Zip64.");
        const crc = crc32(entry.data);
        // 1980-01-01 00:00: the same bytes for the same files, whenever they were built.
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(stored ? 0 : 8, 8);
        local.writeUInt16LE(0, 10);
        local.writeUInt16LE(0x21, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(entry.data.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        local.writeUInt16LE(0, 28);
        const header = Buffer.alloc(46);
        header.writeUInt32LE(0x02014b50, 0);
        header.writeUInt16LE((3 << 8) | 20, 4);
        header.writeUInt16LE(20, 6);
        header.writeUInt16LE(0x0800, 8);
        header.writeUInt16LE(stored ? 0 : 8, 10);
        header.writeUInt16LE(0, 12);
        header.writeUInt16LE(0x21, 14);
        header.writeUInt32LE(crc, 16);
        header.writeUInt32LE(body.length, 20);
        header.writeUInt32LE(entry.data.length, 24);
        header.writeUInt16LE(nameBytes.length, 28);
        header.writeUInt32LE(
            ((entry.mode << 16) | (entry.name.endsWith("/") ? 0x10 : 0)) >>> 0,
            38,
        );
        header.writeUInt32LE(offset, 42);
        chunks.push(local, nameBytes, body);
        central.push(header, nameBytes);
        offset += local.length + nameBytes.length + body.length;
    }
    const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    rmSync(outFile, { force: true });
    writeFileSync(outFile, Buffer.concat([...chunks, ...central, end]));
}

function sha256(path) {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function argument(name, allowed) {
    const index = process.argv.indexOf(name);
    const value = index >= 0 ? process.argv[index + 1] : undefined;
    if (value === undefined || (allowed && !allowed.includes(value)))
        throw new Error(`${name} is required${allowed ? `: one of ${allowed.join(", ")}` : ""}.`);
    return value;
}
