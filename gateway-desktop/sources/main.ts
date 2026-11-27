/**
 * Karis Workbench: one window per Happy Gateway server, showing the web
 * interface that server already serves. Sign-in is the gateway's own page and
 * cookie, kept in a cookie store of that server's own.
 *
 * The local chooser can provision a gateway through a narrow SSH API. A server
 * page has no native bridge, local agent, updater or analytics. Its window may load
 * only its own origin; every other address goes to the default browser.
 * Certificates are checked by the system, with one exception only: a server
 * reached through an SSH tunnel (https://localhost:<port>) is trusted by the
 * fingerprint received through authenticated SSH or entered in the manual form,
 * in that server's own cookie
 * store, and by nothing else.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
    BrowserWindow,
    Menu,
    app,
    dialog,
    ipcMain,
    net,
    protocol,
    session,
    shell,
    type IpcMainInvokeEvent,
    type MenuItemConstructorOptions,
    type Session,
    type WebContents,
} from "electron";
import {
    DEFAULT_SERVER,
    DEFAULT_TUNNEL_PORT,
    ServerStore,
    certificateFingerprint,
    entryLabel,
    entryPartition,
    serverAddressParse,
    serverLabel,
    serverPartition,
    sshServerParse,
    tunnelOrigin,
    type AddressResult,
    type ServerEntry,
    type SshTunnel,
} from "./servers";
import { Tunnel, TunnelError, TunnelRegistry } from "./tunnel";
import { sshProfiles } from "./ssh-profiles";
import { loadProvisionBundle, type ProvisionBundle } from "./provision-assets";
import { ProvisionController } from "./provision-controller";

/**
 * Switches that would let the app accept a certificate the system does not
 * trust, or turn off the same-origin rules. Chromium honours them from the
 * command line, so the app refuses to start with any of them.
 */
const REFUSED_SWITCHES = [
    "ignore-certificate-errors",
    "ignore-certificate-errors-spki-list",
    "ignore-urlfetcher-cert-requests",
    "allow-insecure-localhost",
    "unsafely-treat-insecure-origin-as-secure",
    "disable-web-security",
    "allow-running-insecure-content",
    "test-type",
];
for (const name of REFUSED_SWITCHES) {
    if (app.commandLine.hasSwitch(name)) {
        console.error(`Karis Workbench does not start with --${name}.`);
        process.exit(1);
    }
}

const APP_SCHEME = "workbench";
const APP_ORIGIN = `${APP_SCHEME}://app`;
const UI_DIRECTORY = join(fileURLToPath(new URL(".", import.meta.url)), "ui");
const UI_FILES = new Map([
    ["/chooser.html", "text/html; charset=utf-8"],
    ["/chooser.css", "text/css; charset=utf-8"],
    ["/chooser.js", "text/javascript; charset=utf-8"],
]);
const UI_SECURITY =
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
/** What a server's page may ask for. Everything else (camera, microphone, location, devices, screen) is refused. */
const PERMISSIONS = new Set(["clipboard-sanitized-write", "notifications", "fullscreen"]);
const EXTERNAL_SCHEMES = new Set(["https:", "http:", "mailto:"]);

protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true } },
]);
app.setName("Karis Workbench");
if (!app.requestSingleInstanceLock()) app.exit(0);

let store: ServerStore;
/** The main window of each open server. */
const serverWindows = new Map<string, BrowserWindow>();
/** The server each cookie store belongs to; a store not in here is the app's own. */
const sessionOrigins = new Map<Session, string>();
/** In-memory stores that have their network wall already. */
const probeSessions = new Set<Session>();
/** The SSH tunnel of each tunnelled server that has been opened. */
const tunnels = new Map<string, Tunnel>();
/** Includes the add form's trial tunnels and tunnels still stopping after removal. */
const activeTunnels = new Set<Tunnel>();
const trialAborters = new Map<Tunnel, AbortController>();
const removing = new Set<string>();
let tunnelRegistry: TunnelRegistry;
/** Tunnelled servers whose certificate did not match, until their windows are closed. */
const pinFailures = new Set<string>();
/** Why a tunnelled server was last refused, shown in the Servers window until it is opened again. */
const refusals = new Map<string, string>();
/**
 * The certificate each tunnelled server was refused for. Chromium keeps the
 * answer for a certificate it has seen, so the same certificate later fails
 * without asking pinnedTrust again; did-fail-load then refuses it the same way.
 */
const refusedCertificates = new Map<string, string>();
/** Tunnelled servers whose window waits for the tunnel. */
const opening = new Set<string>();
let chooserWindow: BrowserWindow | null = null;
let quitting = false;
let provision: ProvisionController | undefined;
let provisionBundle: Promise<ProvisionBundle> | undefined;

function setupController(): ProvisionController {
    provision ??= new ProvisionController(
        () =>
            (provisionBundle ??= loadProvisionBundle(
                join(fileURLToPath(new URL(".", import.meta.url)), "provision"),
                join(app.getPath("userData"), "provision-cache"),
            ).catch((error: unknown) => {
                provisionBundle = undefined;
                throw error;
            })),
        () => store.list(),
        (event) => {
            if (!quitting && chooserWindow && !chooserWindow.isDestroyed())
                chooserWindow.webContents.send("setup:event", event);
        },
        (tunnel, signal) => {
            if (!chooserWindow || chooserWindow.isDestroyed() || quitting)
                return Promise.resolve({ ok: false, message: "Setup was cancelled." });
            return sshServerAdd(tunnel, chooserWindow.webContents, signal);
        },
    );
    return provision;
}

function entryOf(origin: string): ServerEntry {
    return store.get(origin) ?? { origin };
}

/** "www.karis.ink", or "nitro (SSH)" for a tunnelled server. */
function labelOf(origin: string): string {
    return entryLabel(entryOf(origin));
}

function partitionOf(origin: string): string {
    return entryPartition(entryOf(origin));
}

/** The server a page belongs to, or null for the app's own pages. */
function originOf(contents: WebContents): string | null {
    return sessionOrigins.get(contents.session) ?? null;
}

function urlOrigin(url: string): string | null {
    try {
        const parsed = new URL(url);
        // A server's live connection is wss:// on the same host.
        if (parsed.protocol === "wss:") parsed.protocol = "https:";
        return parsed.origin;
    } catch {
        return null;
    }
}

function openExternally(url: string): void {
    try {
        if (EXTERNAL_SCHEMES.has(new URL(url).protocol)) void shell.openExternal(url);
    } catch {
        // Not a URL; nothing to open.
    }
}

/**
 * The network wall of a cookie store: http, https and WebSocket requests reach
 * `origin` over TLS and nothing else. The app's own store (`origin` null) reaches
 * nothing at all.
 */
function networkWall(target: Session, origin: string | null, ready = () => true): void {
    target.webRequest.onBeforeRequest((details, callback) => {
        const scheme = details.url.slice(0, details.url.indexOf(":") + 1);
        if (scheme === "http:" || scheme === "https:" || scheme === "ws:" || scheme === "wss:") {
            const allowed =
                origin !== null &&
                ready() &&
                (scheme === "https:" || scheme === "wss:") &&
                urlOrigin(details.url) === origin;
            if (!allowed)
                console.warn(
                    `blocked a request from ${origin === null ? "the app" : labelOf(origin)} to ${urlOrigin(details.url) ?? "an invalid address"}`,
                );
            return callback({ cancel: !allowed });
        }
        callback({});
    });
    // macOS checks spelling itself. Elsewhere Chromium downloads Hunspell dictionaries from Google
    // for every language in this list as soon as a page starts, switched off or not, and not
    // through webRequest; an empty list is what stops it.
    if (process.platform !== "darwin") {
        target.setSpellCheckerLanguages([]);
        target.setSpellCheckerEnabled(false);
    }
}

/**
 * A short-lived store for asking an address whether it is a workbench server:
 * in memory only, so an address that is never added leaves nothing on disk.
 */
function probeSession(origin: string): Session {
    const probe = session.fromPartition(
        `probe-${serverPartition(origin).slice("persist:".length)}`,
    );
    if (!probeSessions.has(probe)) {
        probeSessions.add(probe);
        networkWall(probe, origin);
    }
    return probe;
}

/**
 * The one place the app decides about a certificate itself, used only for
 * the cookie stores of a tunnelled server: a certificate for "localhost" is
 * accepted when `accept` says its fingerprint is the pinned one, and every
 * other certificate is refused. The store's network wall lets it reach only
 * https://localhost:<that server's port>, so the pin holds for that host and
 * port alone. Every other store keeps the system's checks untouched.
 */
function pinnedTrust(target: Session, accept: (fingerprint: string) => boolean): void {
    target.setCertificateVerifyProc((request, callback) => {
        if (request.hostname !== "localhost") return callback(-2);
        callback(accept(certificateFingerprint(request.certificate.data)) ? 0 : -2);
    });
}

/**
 * A tunnelled server presented another certificate: its windows close, its
 * tunnel stops, and the Servers window says why, with both fingerprints.
 * There is no way past this but removing the server and adding it again with
 * the new fingerprint; opening it again only meets the same refusal.
 */
function pinRefused(origin: string, presented: string): void {
    if (quitting || removing.has(origin) || !store.has(origin)) return;
    refusedCertificates.set(origin, presented);
    for (const window of windowsOf(origin)) window.destroy();
    void tunnels.get(origin)?.stop();
    const label = labelOf(origin);
    refusals.set(
        origin,
        `${label} was closed: the server presented another certificate than the one pinned when it was added.\nPinned: ${entryOf(origin).ssh?.fingerprint ?? "-"}\nPresented: ${presented}\nIf your administrator replaced the certificate, remove ${label} and add it again with the new fingerprint.`,
    );
    pinFailures.delete(origin);
    openChooser();
}

/** Every window showing `origin`, the further ones a page opened included. */
function windowsOf(origin: string): BrowserWindow[] {
    return BrowserWindow.getAllWindows().filter(
        (window) => !window.isDestroyed() && originOf(window.webContents) === origin,
    );
}

/** A server's cookie store, set up once: its network wall, its permissions. */
function serverSession(origin: string): Session {
    const serverSessionValue = session.fromPartition(partitionOf(origin));
    if (sessionOrigins.has(serverSessionValue)) return serverSessionValue;
    sessionOrigins.set(serverSessionValue, origin);
    // Nothing on a server's page reaches another host, whatever the page asks for.
    networkWall(
        serverSessionValue,
        origin,
        () =>
            store.has(origin) &&
            (store.get(origin)?.ssh === undefined || tunnels.get(origin)?.state === "up"),
    );
    if (entryOf(origin).ssh !== undefined)
        // The pin is read at each check, so a server removed and added again with a new fingerprint uses the new one.
        pinnedTrust(serverSessionValue, (fingerprint) => {
            const checkedEntry = store.get(origin);
            if (fingerprint === checkedEntry?.ssh?.fingerprint) {
                refusedCertificates.delete(origin);
                return true;
            }
            console.warn(
                `refused ${labelOf(origin)}: its certificate is not the one pinned when it was added`,
            );
            if (!pinFailures.has(origin)) {
                pinFailures.add(origin);
                setImmediate(() => {
                    if (store.get(origin) === checkedEntry) pinRefused(origin, fingerprint);
                });
            }
            return false;
        });
    serverSessionValue.setPermissionRequestHandler((_contents, permission, callback, details) =>
        callback(PERMISSIONS.has(permission) && urlOrigin(details.requestingUrl) === origin),
    );
    serverSessionValue.setPermissionCheckHandler(
        (_contents, permission, requestingOrigin) =>
            PERMISSIONS.has(permission) && requestingOrigin === origin,
    );
    serverSessionValue.setDevicePermissionHandler(() => false);
    return serverSessionValue;
}

const webPreferences = (partition?: string): Electron.WebPreferences => ({
    ...(partition ? { partition } : {}),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    spellcheck: process.platform === "darwin",
});

function openServer(origin: string): void {
    if (quitting || removing.has(origin) || !store.has(origin)) return;
    const entry = store.get(origin);
    const existing = serverWindows.get(origin);
    if (existing !== undefined && !existing.isDestroyed()) {
        if (existing.isMinimized()) existing.restore();
        existing.focus();
        return;
    }
    refusals.delete(origin);
    if (entryOf(origin).ssh === undefined) return void serverWindowOpen(origin);
    // A tunnelled server's window opens once its tunnel is up.
    if (opening.has(origin)) return;
    opening.add(origin);
    void tunnelUp(origin)
        .then((up) => {
            if (up && !quitting && !removing.has(origin) && store.get(origin) === entry)
                serverWindowOpen(origin);
        })
        .catch((error: unknown) =>
            console.warn(`Could not open ${labelOf(origin)}: ${String(error)}`),
        )
        .finally(() => opening.delete(origin));
}

/** The tunnel of a tunnelled server, made once and kept with its events. */
function tunnelOf(origin: string, tunnel: SshTunnel): Tunnel {
    let running = tunnels.get(origin);
    if (running === undefined) {
        running = new Tunnel(tunnel, tunnelRegistry);
        activeTunnels.add(running);
        running.on("failed", (error: TunnelError) => void tunnelFailed(origin, error));
        tunnels.set(origin, running);
    }
    return running;
}

/** Brings a tunnelled server's tunnel up, or tells the person why it is not. */
async function tunnelUp(origin: string): Promise<boolean> {
    if (quitting || removing.has(origin)) return false;
    const tunnel = entryOf(origin).ssh;
    if (tunnel === undefined) return false;
    try {
        await tunnelOf(origin, tunnel).start();
        return true;
    } catch (error) {
        await tunnelFailed(
            origin,
            error instanceof TunnelError ? error : new TunnelError("other", String(error)),
        );
        return false;
    }
}

async function tunnelFailed(origin: string, error: TunnelError): Promise<void> {
    if (quitting || removing.has(origin) || !store.has(origin)) return;
    const entry = store.get(origin);
    const parent = windowsOf(origin)[0] ?? chooserWindow ?? undefined;
    const message = {
        type: "warning" as const,
        message: `${labelOf(origin)} could not be reached.`,
        detail: error.message,
        buttons: ["Try Again", "Servers…", "Close"],
        defaultId: 0,
        cancelId: 2,
    };
    let response: number;
    try {
        ({ response } = await (parent && !parent.isDestroyed()
            ? dialog.showMessageBox(parent, message)
            : dialog.showMessageBox(message)));
    } catch {
        // Its parent may have closed, or the app may have quit, while the dialog was open.
        return;
    }
    if (quitting || removing.has(origin) || store.get(origin) !== entry) return;
    if (response === 0) {
        if (
            (await tunnelUp(origin)) &&
            !quitting &&
            !removing.has(origin) &&
            store.get(origin) === entry
        ) {
            const window = windowsOf(origin)[0];
            if (window === undefined) serverWindowOpen(origin);
            else window.webContents.reload();
        }
    } else {
        if (response === 1) openChooser();
        for (const window of windowsOf(origin)) window.close();
        await tunnels.get(origin)?.stop();
    }
}

/** Stops a tunnel once no window of its server is left. */
function tunnelRelease(origin: string): void {
    const tunnel = tunnels.get(origin);
    if (tunnel !== undefined && windowsOf(origin).length === 0 && !opening.has(origin))
        void tunnel.stop();
}

function serverWindowOpen(origin: string): BrowserWindow {
    serverSession(origin);
    const label = labelOf(origin);
    const bounds = store.get(origin)?.bounds;
    const window = new BrowserWindow({
        width: bounds?.width ?? 1280,
        height: bounds?.height ?? 860,
        ...(bounds?.x !== undefined && bounds.y !== undefined ? { x: bounds.x, y: bounds.y } : {}),
        minWidth: 640,
        minHeight: 480,
        title: label,
        show: false,
        webPreferences: webPreferences(partitionOf(origin)),
    });
    serverWindows.set(origin, window);
    serverWindowTitle(window, label);
    window.once("ready-to-show", () => window.show());
    const remember = () => {
        if (!window.isDestroyed() && !window.isMinimized() && !window.isFullScreen())
            store.boundsSet(origin, window.getNormalBounds());
    };
    window.on("resized", remember);
    window.on("moved", remember);
    window.on("close", remember);
    window.on("closed", () => {
        serverWindows.delete(origin);
        if (!quitting) store.openSet([...serverWindows.keys()]);
        tunnelRelease(origin);
    });
    window.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
        // -3 is a navigation that was replaced or stopped, not a failure. A refused pin has its own message.
        if (
            quitting ||
            removing.has(origin) ||
            !isMainFrame ||
            code === -3 ||
            pinFailures.has(origin)
        )
            return;
        // The certificate refused before, refused again from Chromium's memory (net::ERR_FAILED).
        const refused = refusedCertificates.get(origin);
        if (refused !== undefined && (code === -2 || /CERT/u.test(description)))
            return void setImmediate(() => pinRefused(origin, refused));
        void dialog
            .showMessageBox(window, {
                type: "warning",
                message: `${label} could not be reached.`,
                detail: `${description} (${code})${/CERT/u.test(description) ? "\n\nThis Mac does not trust the server's certificate." : ""}`,
                buttons: ["Try Again", "Servers…", "Close"],
                defaultId: 0,
                cancelId: 2,
            })
            .then(({ response }) => {
                if (window.isDestroyed()) return;
                if (response === 0)
                    void window.loadURL(urlOrigin(url) === origin ? url : `${origin}/`);
                else if (response === 1) openChooser();
                else window.close();
            })
            .catch(() => undefined);
    });
    void window.loadURL(`${origin}/`).catch(() => undefined);
    store.openSet([...serverWindows.keys()]);
    rebuildMenu();
    return window;
}

/** The page's title with the server's address, so a window always says where it is. */
function serverWindowTitle(window: BrowserWindow, label: string): void {
    window.on("page-title-updated", (event, title) => {
        event.preventDefault();
        window.setTitle(title.trim() === "" ? label : `${title.trim()} — ${label}`);
    });
}

/** Every page, the app's own included, is held to its origin here. */
app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event) => event.preventDefault());
    const guard = (event: Electron.Event, url: string) => {
        const origin = originOf(contents);
        if (origin !== null && urlOrigin(url) === origin && url.startsWith("https://")) return;
        if (origin === null && url.startsWith(`${APP_ORIGIN}/`)) return;
        event.preventDefault();
        openExternally(url);
    };
    contents.on("will-navigate", (event) => guard(event, event.url));
    contents.on("will-redirect", (event) => guard(event, event.url));
    contents.setWindowOpenHandler(({ url }) => {
        const origin = originOf(contents);
        // The same server in a further window of its own, held to the same rules.
        if (origin !== null && urlOrigin(url) === origin && url.startsWith("https://"))
            return {
                action: "allow",
                overrideBrowserWindowOptions: {
                    width: 1100,
                    height: 800,
                    webPreferences: webPreferences(partitionOf(origin)),
                },
            };
        openExternally(url);
        return { action: "deny" };
    });
    contents.on("did-create-window", (window) => {
        const origin = originOf(contents);
        if (origin === null) return;
        serverWindowTitle(window, labelOf(origin));
        window.on("closed", () => tunnelRelease(origin));
    });
});

function openChooser(): void {
    if (quitting) return;
    if (chooserWindow !== null && !chooserWindow.isDestroyed()) {
        chooserWindow.focus();
        return;
    }
    chooserWindow = new BrowserWindow({
        width: 520,
        height: 560,
        resizable: true,
        minimizable: false,
        fullscreenable: false,
        title: "Servers",
        show: false,
        webPreferences: {
            ...webPreferences(),
            preload: join(fileURLToPath(new URL(".", import.meta.url)), "preload.cjs"),
        },
    });
    chooserWindow.once("ready-to-show", () => chooserWindow?.show());
    chooserWindow.on("closed", () => {
        provision?.cancelAll();
        chooserWindow = null;
    });
    void chooserWindow.loadURL(`${APP_ORIGIN}/chooser.html`);
}

/** Only the app's own chooser page may change the list. */
function fromChooser(event: IpcMainInvokeEvent): boolean {
    return (
        !quitting &&
        chooserWindow !== null &&
        event.sender === chooserWindow.webContents &&
        (event.senderFrame?.url ?? "").startsWith(`${APP_ORIGIN}/`)
    );
}

function serversListed() {
    return {
        servers: store.list().map((entry) => ({
            origin: entry.origin,
            label: entryLabel(entry),
            ssh: entry.ssh !== undefined,
            open: serverWindows.has(entry.origin),
            refused: refusals.get(entry.origin) ?? null,
        })),
        suggestion: store.list().length === 0 ? DEFAULT_SERVER : "",
        tunnelPort: DEFAULT_TUNNEL_PORT,
    };
}

/**
 * Adds a tunnelled server: brings its tunnel up, reads the certificate the
 * gateway presents at the end of it without trusting it, compares that
 * certificate's fingerprint with the expected one, and asks the
 * gateway whether it is one only once they match. Nothing is added otherwise.
 */
async function sshServerAdd(
    tunnel: SshTunnel,
    owner: WebContents,
    signal?: AbortSignal,
): Promise<AddressResult & { fingerprint?: string }> {
    if (quitting) return { ok: false, message: "The app is quitting." };
    if (signal?.aborted) return { ok: false, message: "Adding this server was cancelled." };
    const origin = tunnelOrigin(tunnel);
    const taken = store.byLocalPort(tunnel.localPort);
    if (taken !== undefined)
        return {
            ok: false,
            message: `Local port ${tunnel.localPort} is already used by ${entryLabel(taken)}.`,
        };
    const label = `${tunnel.alias} (SSH)`;
    const trial = new Tunnel(tunnel, tunnelRegistry);
    const controller = new AbortController();
    const cancel = () => {
        controller.abort();
        void trial.stop();
    };
    owner.once("destroyed", cancel);
    signal?.addEventListener("abort", cancel, { once: true });
    trialAborters.set(trial, controller);
    activeTunnels.add(trial);
    try {
        await trial.start();
        const refuse = (message: string) => ({ ok: false as const, message });
        // The certificate, read and refused: no request goes out over it.
        let presented: string | undefined;
        const reader = tunnelProbeSession(origin);
        pinnedTrust(reader, (fingerprint) => ((presented = fingerprint), false));
        await probeRequest(reader, `${origin}/healthz`, controller.signal).catch(() => undefined);
        if (quitting || controller.signal.aborted)
            return refuse("Adding this server was cancelled.");
        if (presented === undefined)
            return refuse(
                `${tunnel.alias} accepted the SSH connection, but nothing answered with TLS on its port ${tunnel.remotePort}.`,
            );
        if (presented !== tunnel.fingerprint)
            return refuse(
                `The server presented a different certificate from the expected fingerprint, so ${label} was not added.\n\nExpected: ${tunnel.fingerprint}\nPresented: ${presented}`,
            );
        const checker = tunnelProbeSession(origin);
        pinnedTrust(checker, (fingerprint) => fingerprint === tunnel.fingerprint);
        let answer: ProbeAnswer;
        try {
            answer = await probeRequest(checker, `${origin}/healthz`, controller.signal);
        } catch (error) {
            return refuse(
                `${label} could not be reached (${error instanceof Error ? error.message.replace(/^net::/u, "") : String(error)}).`,
            );
        }
        let body: unknown = null;
        try {
            body = answer.status === 200 ? JSON.parse(answer.body) : null;
        } catch {
            // Not JSON: not a gateway.
        }
        if ((body as { ok?: unknown } | null)?.ok !== true)
            return refuse(`${label} does not answer as a workbench server.`);
        if (quitting || controller.signal.aborted)
            return refuse("Adding this server was cancelled.");
        if (store.byLocalPort(tunnel.localPort) !== undefined)
            return refuse("This local port has already been added.");
        store.add(origin, tunnel);
        // The tunnel stays up for the window that opens next.
        trial.on("failed", (error: TunnelError) => void tunnelFailed(origin, error));
        tunnels.set(origin, trial);
        rebuildMenu();
        return { ok: true, origin, fingerprint: presented };
    } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
    } finally {
        owner.removeListener("destroyed", cancel);
        signal?.removeEventListener("abort", cancel);
        trialAborters.delete(trial);
        if (tunnels.get(origin) !== trial) {
            await trial.stop();
            activeTunnels.delete(trial);
        }
    }
}

/** A fresh in-memory store for one look at a tunnel's certificate; it reaches only that origin. */
function tunnelProbeSession(origin: string): Session {
    const probe = session.fromPartition(`probe-ssh-${randomUUID()}`);
    networkWall(probe, origin);
    return probe;
}

/**
 * Asks a new address whether it is a workbench server before adding it, over
 * that server's own cookie store, with the system's certificate checks. A bare
 * name that forwards to another https name (karis.ink to www.karis.ink) is
 * added under the name it forwards to.
 */
async function serverProbe(origin: string, hops = 0): Promise<AddressResult> {
    let answer: ProbeAnswer;
    try {
        answer = await probeRequest(probeSession(origin), `${origin}/healthz`);
    } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        if (/CERT/u.test(text))
            return {
                ok: false,
                message: `${serverLabel(origin)}'s certificate is not trusted by this computer.`,
            };
        return {
            ok: false,
            message: `${serverLabel(origin)} could not be reached (${text.replace(/^net::/u, "")}).`,
        };
    }
    if (answer.location !== undefined && hops === 0) {
        const target = serverAddressParse(urlOrigin(new URL(answer.location, origin).href) ?? "");
        if (target.ok && target.origin !== origin) return serverProbe(target.origin, 1);
    }
    let body: unknown = null;
    try {
        body = answer.status === 200 ? JSON.parse(answer.body) : null;
    } catch {
        // Not JSON: not a gateway.
    }
    if ((body as { ok?: unknown } | null)?.ok !== true)
        return {
            ok: false,
            message: `${serverLabel(origin)} does not answer as a workbench server.`,
        };
    return { ok: true, origin };
}

interface ProbeAnswer {
    status: number;
    /** Where a redirect points; the redirect itself is not followed. */
    location?: string;
    body: string;
}

/** One GET in a server's own cookie store, without cookies, stopping at a redirect. */
function probeRequest(target: Session, url: string, signal?: AbortSignal): Promise<ProbeAnswer> {
    return new Promise((resolve, reject) => {
        const request = net.request({
            url,
            session: target,
            redirect: "manual",
            cache: "no-store",
            credentials: "omit",
        });
        const timer = setTimeout(() => {
            request.abort();
            signal?.removeEventListener("abort", abort);
            reject(new Error("no answer within 15 seconds"));
        }, 15_000);
        const abort = () => {
            clearTimeout(timer);
            request.abort();
            reject(new Error("Adding this server was cancelled."));
        };
        signal?.addEventListener("abort", abort, { once: true });
        const done = (value: ProbeAnswer) => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            resolve(value);
        };
        const failed = (error: Error) => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            reject(error);
        };
        request.on("redirect", (status, _method, location) => {
            request.abort();
            done({ status, location, body: "" });
        });
        request.on("response", (response) => {
            let body = "";
            response.on("data", (chunk) => {
                if (body.length < 4096) body += chunk.toString("utf8");
            });
            response.on("end", () => done({ status: response.statusCode, body }));
            response.on("error", failed);
        });
        request.on("error", failed);
        if (signal?.aborted) return abort();
        request.end();
    });
}

function registerIpc(): void {
    ipcMain.handle("setup:profiles", (event) => (fromChooser(event) ? sshProfiles() : []));
    ipcMain.handle("setup:create", (event, alias: unknown) =>
        fromChooser(event) && !quitting ? setupController().create(alias) : null,
    );
    ipcMain.handle("setup:run", (event, id: unknown, op: unknown, owner: unknown) =>
        fromChooser(event) && !quitting ? setupController().run(id, op, owner) : null,
    );
    ipcMain.handle("setup:connect", (event, id: unknown) =>
        fromChooser(event) && !quitting
            ? setupController().connect(id)
            : { ok: false, message: "Not allowed." },
    );
    ipcMain.handle("setup:legacyPort", (event, id: unknown) =>
        fromChooser(event) && !quitting ? setupController().useLegacyPort(id) : null,
    );
    ipcMain.handle("setup:cancel", (event, id: unknown) =>
        fromChooser(event) ? provision?.cancel(id) === true : false,
    );
    ipcMain.handle("setup:sudo", (event, id: unknown, password: unknown) =>
        fromChooser(event) && !quitting ? provision?.password(id, password) === true : false,
    );
    ipcMain.handle("servers:list", (event) => (fromChooser(event) ? serversListed() : null));
    ipcMain.handle("servers:add", async (event, text: unknown) => {
        if (!fromChooser(event) || typeof text !== "string")
            return { ok: false, message: "Not allowed." };
        const parsed = serverAddressParse(text);
        if (!parsed.ok) return parsed;
        const probed = await serverProbe(parsed.origin);
        if (!probed.ok) return probed;
        if (quitting) return { ok: false, message: "The app is quitting." };
        store.add(probed.origin);
        rebuildMenu();
        return probed;
    });
    ipcMain.handle("servers:addSsh", async (event, fields: unknown) => {
        const text = (name: string) =>
            typeof fields === "object" &&
            fields !== null &&
            typeof (fields as Record<string, unknown>)[name] === "string"
                ? ((fields as Record<string, unknown>)[name] as string)
                : null;
        const alias = text("alias");
        const remotePort = text("remotePort");
        const localPort = text("localPort");
        const fingerprint = text("fingerprint");
        if (
            !fromChooser(event) ||
            alias === null ||
            remotePort === null ||
            localPort === null ||
            fingerprint === null
        )
            return { ok: false, message: "Not allowed." };
        const parsed = sshServerParse({ alias, remotePort, localPort, fingerprint });
        if (!parsed.ok) return parsed;
        return sshServerAdd(parsed.tunnel, event.sender);
    });
    ipcMain.handle("servers:open", (event, origin: unknown) => {
        if (!fromChooser(event) || typeof origin !== "string" || !store.has(origin)) return false;
        openServer(origin);
        return true;
    });
    ipcMain.handle("servers:remove", async (event, origin: unknown) => {
        if (!fromChooser(event) || typeof origin !== "string" || !store.has(origin)) return false;
        const { response } = await dialog.showMessageBox(chooserWindow!, {
            type: "question",
            message: `Remove ${labelOf(origin)}?`,
            detail: "Its window closes and this app forgets its sign-in, cookies and cache.",
            buttons: ["Remove", "Cancel"],
            defaultId: 1,
            cancelId: 1,
        });
        if (response !== 0) return false;
        if (quitting || !store.has(origin) || removing.has(origin)) return false;
        removing.add(origin);
        try {
            const removed = serverSession(origin);
            for (const window of BrowserWindow.getAllWindows())
                if (window.webContents.session === removed) window.destroy();
            serverWindows.delete(origin);
            const tunnel = tunnels.get(origin);
            await tunnel?.stop();
            if (tunnel !== undefined) activeTunnels.delete(tunnel);
            tunnels.delete(origin);
            refusals.delete(origin);
            refusedCertificates.delete(origin);
            pinFailures.delete(origin);
            await removed.closeAllConnections();
            await removed.clearStorageData();
            await removed.clearCache();
            store.remove(origin);
            rebuildMenu();
            return true;
        } finally {
            removing.delete(origin);
        }
    });
}

async function serveAppFile(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const type = UI_FILES.get(url.pathname);
    if (url.host !== "app" || type === undefined) return new Response("Not found", { status: 404 });
    const body = await readFile(normalize(join(UI_DIRECTORY, url.pathname)));
    return new Response(body, {
        headers: {
            "content-type": type,
            "content-security-policy": UI_SECURITY,
            "x-content-type-options": "nosniff",
        },
    });
}

function rebuildMenu(): void {
    const isMac = process.platform === "darwin";
    const servers: MenuItemConstructorOptions[] = store.list().map((entry) => ({
        label: entryLabel(entry),
        click: () => openServer(entry.origin),
    }));
    const template: MenuItemConstructorOptions[] = [
        ...(isMac ? [{ role: "appMenu" as const }] : []),
        {
            label: "File",
            submenu: [
                { label: "Servers…", accelerator: "CmdOrCtrl+Shift+O", click: openChooser },
                {
                    label: "Open Server",
                    submenu:
                        servers.length > 0
                            ? servers
                            : [{ label: "No servers yet", enabled: false }],
                },
                { type: "separator" },
                isMac ? { role: "close" } : { role: "quit" },
            ],
        },
        { role: "editMenu" },
        {
            label: "View",
            submenu: [
                {
                    label: "Back",
                    accelerator: "CmdOrCtrl+[",
                    click: (_item, window) =>
                        window instanceof BrowserWindow
                            ? window.webContents.navigationHistory.goBack()
                            : undefined,
                },
                {
                    label: "Forward",
                    accelerator: "CmdOrCtrl+]",
                    click: (_item, window) =>
                        window instanceof BrowserWindow
                            ? window.webContents.navigationHistory.goForward()
                            : undefined,
                },
                { type: "separator" },
                { role: "reload" },
                { role: "forceReload" },
                { role: "toggleDevTools" },
                { type: "separator" },
                { role: "resetZoom" },
                { role: "zoomIn" },
                { role: "zoomOut" },
                { type: "separator" },
                { role: "togglefullscreen" },
            ],
        },
        { role: "windowMenu" },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on("second-instance", () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) return void openChooser();
    if (window.isMinimized()) window.restore();
    window.focus();
});
app.on("before-quit", () => {
    // Quitting again once the tunnels are stopped finds the windows already closed.
    if (quitting) return;
    quitting = true;
    provision?.cancelAll();
    for (const controller of trialAborters.values()) controller.abort();
    store?.openSet([...serverWindows.keys()]);
});
let tunnelsStopped = false;
// No ssh outlives the app: each is stopped before it quits, and killed if the process ends any other way.
app.on("will-quit", (event) => {
    if (tunnelsStopped || (activeTunnels.size === 0 && !provision?.active)) return;
    event.preventDefault();
    const stopping = Promise.allSettled(
        [...activeTunnels]
            .map((tunnel) => tunnel.stop())
            .concat(provision ? [provision.stop()] : []),
    );
    void Promise.race([stopping, new Promise((resolve) => setTimeout(resolve, 6_000))]).then(() => {
        tunnelsStopped = true;
        // Not from within this event: Electron counts the app as quitting until it has returned.
        setImmediate(() => app.quit());
    });
});
process.on("exit", () => {
    provision?.killNow();
    for (const tunnel of activeTunnels) tunnel.killNow();
});
app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length > 0) return;
    const first = store.openOrigins()[0] ?? store.list()[0]?.origin;
    if (first !== undefined) openServer(first);
    else openChooser();
});

void app.whenReady().then(async () => {
    // The app's own pages (the Servers window) need no network at all.
    networkWall(session.defaultSession, null);
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
    );
    store = new ServerStore(join(app.getPath("userData"), "servers.json"));
    tunnelRegistry = new TunnelRegistry(join(app.getPath("userData"), "tunnels.json"));
    // An ssh a crash of this app left behind, before any tunnel of this run starts.
    const swept = await tunnelRegistry.sweep();
    if (swept.length > 0)
        console.log(`ended ${swept.length} ssh left behind by an earlier run: ${swept.join(", ")}`);
    protocol.handle(APP_SCHEME, serveAppFile);
    registerIpc();
    rebuildMenu();
    const reopen = store.openOrigins();
    if (reopen.length > 0) for (const origin of reopen) openServer(origin);
    else if (store.list().length > 0) openServer(store.list()[0]!.origin);
    else openChooser();
});
