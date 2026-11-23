/**
 * The bridge into the app's own Servers page, and only that page: a server's
 * window has no preload at all. Four calls, each checked again in the main
 * process against the page that sent it.
 */
import { contextBridge, ipcRenderer } from "electron";

if (location.protocol === "workbench:" && location.host === "app") {
    contextBridge.exposeInMainWorld("workbench", {
        list: () => ipcRenderer.invoke("servers:list"),
        add: (text: string) => ipcRenderer.invoke("servers:add", String(text)),
        open: (origin: string) => ipcRenderer.invoke("servers:open", String(origin)),
        remove: (origin: string) => ipcRenderer.invoke("servers:remove", String(origin)),
    });
}
