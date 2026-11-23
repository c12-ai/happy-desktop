/**
 * Karis Workbench: one window per Happy Gateway server, showing the web
 * interface that server already serves. Sign-in is the gateway's own page and
 * cookie, kept in a cookie store of that server's own.
 *
 * The app adds nothing a browser tab would not have: no local agent, no
 * updater, no analytics, no bridge into the page. A server window may load
 * only its own origin; every other address goes to the default browser.
 * Certificates are checked by the system, with no exception of any kind.
 */
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
    ServerStore,
    serverAddressParse,
    serverLabel,
    serverPartition,
    type AddressResult,
} from "./servers";

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
let chooserWindow: BrowserWindow | null = null;
let quitting = false;

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
function networkWall(target: Session, origin: string | null): void {
    target.webRequest.onBeforeRequest((details, callback) => {
        const scheme = details.url.slice(0, details.url.indexOf(":") + 1);
        if (scheme === "http:" || scheme === "https:" || scheme === "ws:" || scheme === "wss:") {
            const allowed =
                origin !== null &&
                (scheme === "https:" || scheme === "wss:") &&
                urlOrigin(details.url) === origin;
            if (!allowed)
                console.warn(
                    `blocked a request from ${origin === null ? "the app" : serverLabel(origin)} to ${urlOrigin(details.url) ?? "an invalid address"}`,
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

/** A server's cookie store, set up once: its network wall, its permissions. */
function serverSession(origin: string): Session {
    const serverSessionValue = session.fromPartition(serverPartition(origin));
    if (sessionOrigins.has(serverSessionValue)) return serverSessionValue;
    sessionOrigins.set(serverSessionValue, origin);
    // Nothing on a server's page reaches another host, whatever the page asks for.
    networkWall(serverSessionValue, origin);
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

function openServer(origin: string): BrowserWindow {
    const existing = serverWindows.get(origin);
    if (existing !== undefined && !existing.isDestroyed()) {
        if (existing.isMinimized()) existing.restore();
        existing.focus();
        return existing;
    }
    serverSession(origin);
    const label = serverLabel(origin);
    const bounds = store.get(origin)?.bounds;
    const window = new BrowserWindow({
        width: bounds?.width ?? 1280,
        height: bounds?.height ?? 860,
        ...(bounds?.x !== undefined && bounds.y !== undefined ? { x: bounds.x, y: bounds.y } : {}),
        minWidth: 640,
        minHeight: 480,
        title: label,
        show: false,
        webPreferences: webPreferences(serverPartition(origin)),
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
    });
    window.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
        // -3 is a navigation that was replaced or stopped, not a failure.
        if (!isMainFrame || code === -3) return;
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
            });
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
                    webPreferences: webPreferences(serverPartition(origin)),
                },
            };
        openExternally(url);
        return { action: "deny" };
    });
    contents.on("did-create-window", (window) => {
        const origin = originOf(contents);
        if (origin !== null) serverWindowTitle(window, serverLabel(origin));
    });
});

function openChooser(): void {
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
    chooserWindow.on("closed", () => (chooserWindow = null));
    void chooserWindow.loadURL(`${APP_ORIGIN}/chooser.html`);
}

/** Only the app's own chooser page may change the list. */
function fromChooser(event: IpcMainInvokeEvent): boolean {
    return (
        chooserWindow !== null &&
        event.sender === chooserWindow.webContents &&
        (event.senderFrame?.url ?? "").startsWith(`${APP_ORIGIN}/`)
    );
}

function serversListed() {
    return {
        servers: store.list().map((entry) => ({
            origin: entry.origin,
            label: serverLabel(entry.origin),
            open: serverWindows.has(entry.origin),
        })),
        suggestion: store.list().length === 0 ? DEFAULT_SERVER : "",
    };
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
function probeRequest(target: Session, url: string): Promise<ProbeAnswer> {
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
            reject(new Error("no answer within 15 seconds"));
        }, 15_000);
        const done = (value: ProbeAnswer) => {
            clearTimeout(timer);
            resolve(value);
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
            response.on("error", (error: Error) => (clearTimeout(timer), reject(error)));
        });
        request.on("error", (error) => (clearTimeout(timer), reject(error)));
        request.end();
    });
}

function registerIpc(): void {
    ipcMain.handle("servers:list", (event) => (fromChooser(event) ? serversListed() : null));
    ipcMain.handle("servers:add", async (event, text: unknown) => {
        if (!fromChooser(event) || typeof text !== "string")
            return { ok: false, message: "Not allowed." };
        const parsed = serverAddressParse(text);
        if (!parsed.ok) return parsed;
        const probed = await serverProbe(parsed.origin);
        if (!probed.ok) return probed;
        store.add(probed.origin);
        rebuildMenu();
        return probed;
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
            message: `Remove ${serverLabel(origin)}?`,
            detail: "Its window closes and this app forgets its sign-in, cookies and cache.",
            buttons: ["Remove", "Cancel"],
            defaultId: 1,
            cancelId: 1,
        });
        if (response !== 0) return false;
        const removed = serverSession(origin);
        for (const window of BrowserWindow.getAllWindows())
            if (window.webContents.session === removed) window.destroy();
        serverWindows.delete(origin);
        await removed.clearStorageData();
        await removed.clearCache();
        store.remove(origin);
        rebuildMenu();
        return true;
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
        label: serverLabel(entry.origin),
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
    quitting = true;
    store.openSet([...serverWindows.keys()]);
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

void app.whenReady().then(() => {
    // The app's own pages (the Servers window) need no network at all.
    networkWall(session.defaultSession, null);
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
    );
    store = new ServerStore(join(app.getPath("userData"), "servers.json"));
    protocol.handle(APP_SCHEME, serveAppFile);
    registerIpc();
    rebuildMenu();
    const reopen = store.openOrigins();
    if (reopen.length > 0) for (const origin of reopen) openServer(origin);
    else if (store.list().length > 0) openServer(store.list()[0]!.origin);
    else openChooser();
});
