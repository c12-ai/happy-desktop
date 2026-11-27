/**
 * The bridge into the app's own Servers page, and only that page: a server's
 * window has no preload at all. Every call is checked again in the main
 * process against the page that sent it.
 */
import { contextBridge, ipcRenderer } from "electron";

if (location.protocol === "workbench:" && location.host === "app") {
    contextBridge.exposeInMainWorld("workbench", {
        list: () => ipcRenderer.invoke("servers:list"),
        add: (text: string) => ipcRenderer.invoke("servers:add", String(text)),
        addSsh: (fields: Record<string, unknown>) =>
            ipcRenderer.invoke("servers:addSsh", {
                alias: String(fields?.alias ?? ""),
                remotePort: String(fields?.remotePort ?? ""),
                localPort: String(fields?.localPort ?? ""),
                fingerprint: String(fields?.fingerprint ?? ""),
            }),
        open: (origin: string) => ipcRenderer.invoke("servers:open", String(origin)),
        remove: (origin: string) => ipcRenderer.invoke("servers:remove", String(origin)),
        sshProfiles: () => ipcRenderer.invoke("setup:profiles"),
        setupCreate: (alias: string) => ipcRenderer.invoke("setup:create", String(alias)),
        setupRun: (id: string, op: string, owner?: { password: string }) =>
            ipcRenderer.invoke(
                "setup:run",
                String(id),
                String(op),
                owner ? { password: String(owner.password ?? "") } : undefined,
            ),
        setupConnect: (id: string) => ipcRenderer.invoke("setup:connect", String(id)),
        setupLegacyPort: (id: string) => ipcRenderer.invoke("setup:legacyPort", String(id)),
        setupCancel: (id: string) => ipcRenderer.invoke("setup:cancel", String(id)),
        setupSudo: (id: string, password: string) =>
            ipcRenderer.invoke("setup:sudo", String(id), String(password)),
        onSetupEvent: (callback: (event: unknown) => void) => {
            ipcRenderer.on("setup:event", (_event, value: unknown) => callback(value));
        },
    });
}
