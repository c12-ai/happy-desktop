/**
 * The bridge into the app's own Servers page, and only that page: a server's
 * window has no preload at all. Five calls, each checked again in the main
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
    });
}
