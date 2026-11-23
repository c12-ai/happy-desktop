// The Servers page. It only asks the main process, which checks every address again.
const bridge = window.workbench;
const list = document.getElementById("servers");
const known = document.getElementById("known");
const form = document.getElementById("add");
const input = document.getElementById("address");
const button = document.getElementById("add-button");
const message = document.getElementById("message");
const title = document.getElementById("add-title");

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
            element("li", {}, [
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
}

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
