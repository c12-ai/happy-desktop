// The Servers page. It only asks the main process, which checks every address again.
const bridge = window.workbench;
const list = document.getElementById("servers");
const known = document.getElementById("known");
const form = document.getElementById("add");
const input = document.getElementById("address");
const button = document.getElementById("add-button");
const message = document.getElementById("message");
const title = document.getElementById("add-title");
const sshForm = document.getElementById("add-ssh");
const sshButton = document.getElementById("ssh-button");
const sshMessage = document.getElementById("ssh-message");
const alias = document.getElementById("ssh-alias");
const remotePort = document.getElementById("ssh-remote-port");
const localPort = document.getElementById("ssh-local-port");
const fingerprint = document.getElementById("ssh-fingerprint");
const tabs = {
    address: document.getElementById("tab-address"),
    ssh: document.getElementById("tab-ssh"),
};
/** The local port follows the gateway port until the person types one of their own. */
let localPortTyped = false;

function element(name, properties, children = []) {
    const node = document.createElement(name);
    Object.assign(node, properties);
    node.append(...children);
    return node;
}

async function refresh() {
    const state = await bridge.list();
    if (state === null) return;
    list.replaceChildren(
        ...state.servers.map((server) =>
            element("li", { className: server.refused ? "refused" : "" }, [
                ...(server.refused
                    ? [
                          element("p", {
                              className: "problem",
                              role: "alert",
                              textContent: server.refused,
                          }),
                      ]
                    : []),
                element("span", { className: "name", textContent: server.label }),
                ...(server.open
                    ? [element("span", { className: "open-mark", textContent: "open" })]
                    : []),
                element("button", {
                    className: "primary",
                    type: "button",
                    textContent: "Open",
                    onclick: () => bridge.open(server.origin).then(refresh),
                }),
                element("button", {
                    type: "button",
                    textContent: "Remove",
                    onclick: () => bridge.remove(server.origin).then(refresh),
                }),
            ]),
        ),
    );
    known.hidden = state.servers.length === 0;
    title.textContent = state.servers.length === 0 ? "Server" : "Add another server";
    if (state.suggestion && input.value === "") input.value = state.suggestion;
    if (remotePort.value === "") remotePort.value = String(state.tunnelPort);
    if (!localPortTyped && localPort.value === "") localPort.value = remotePort.value;
}

function tabShow(name) {
    form.hidden = name !== "address";
    sshForm.hidden = name !== "ssh";
    tabs.address.setAttribute("aria-selected", String(name === "address"));
    tabs.ssh.setAttribute("aria-selected", String(name === "ssh"));
}
tabs.address.addEventListener("click", () => tabShow("address"));
tabs.ssh.addEventListener("click", () => tabShow("ssh"));
remotePort.addEventListener("input", () => {
    if (!localPortTyped) localPort.value = remotePort.value;
});
localPort.addEventListener("input", () => (localPortTyped = localPort.value !== ""));

sshForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    sshButton.disabled = true;
    sshMessage.textContent = `Connecting to ${alias.value.trim()}…`;
    try {
        const result = await bridge.addSsh({
            alias: alias.value,
            remotePort: remotePort.value.trim(),
            localPort: localPort.value.trim(),
            fingerprint: fingerprint.value,
        });
        if (!result.ok) {
            sshMessage.textContent = result.message;
            return;
        }
        sshMessage.textContent = "";
        alias.value = "";
        fingerprint.value = "";
        await bridge.open(result.origin);
        await refresh();
    } finally {
        sshButton.disabled = false;
    }
});

form.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.disabled = true;
    message.textContent = "Checking…";
    try {
        const result = await bridge.add(input.value);
        if (!result.ok) {
            message.textContent = result.message;
            return;
        }
        message.textContent = "";
        input.value = "";
        await bridge.open(result.origin);
        await refresh();
    } finally {
        button.disabled = false;
    }
});

window.addEventListener("focus", refresh);
void refresh();
