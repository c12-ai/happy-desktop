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
    document.getElementById("ssh-panel").hidden = name !== "ssh";
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

// Setup runs in the main process. Only enumerated progress and public metadata arrive here.
const setup = Object.fromEntries(
    [
        "host",
        "alias",
        "inspect",
        "state",
        "status",
        "summary",
        "progress",
        "error",
        "install",
        "connect",
        "retry",
        "cancel",
        "sudo",
        "owner",
        "prepare",
        "prerequisite",
    ].map((name) => [name, document.getElementById(`setup-${name}`)]),
);
let setupId = null;
let setupBusy = false;
const steps = {
    preflight: "Inspecting the server…",
    upload: "Transferring the gateway package…",
    download: "Downloading the gateway package…",
    verify_payload: "Verifying the package…",
    packages: "Installing required system packages…",
    install: "Preparing Gateway and Happy…",
    origin: "Authorizing this connection…",
    start: "Starting services…",
    complete: "Checking the gateway…",
    owner_setup: "Setting the gateway administrator’s password…",
};
const errors = {
    unsupported_os: "Setup supports Debian 13 servers.",
    unsupported_arch: "Setup supports x86-64 servers.",
    unsupported_sudo:
        "This server requires a terminal for sudo. Ask its administrator to permit this installer without a terminal.",
    sudo_required: "Administrator permission is required on this server.",
    sudo_failed: "Administrator authentication failed. Inspect the server to try again.",
    ssh_auth:
        "SSH could not authenticate with your configured key or agent. Check that this profile works in Terminal and that any protected key is available through your SSH agent or Keychain.",
    ssh_host_key:
        "This server’s SSH host key is unknown or has changed. Verify it in Terminal before connecting again.",
    ssh_config: "SSH could not use this profile. Check its configuration.",
    ssh_network:
        "The SSH connection failed. Check that the selected SSH profile works in Terminal, then retry.",
    ssh_name:
        "SSH could not resolve a server or proxy hostname. Check this profile’s HostName and ProxyJump settings in Terminal.",
    ssh_command_missing:
        "SSH could not start a command required by this profile. Check its ProxyCommand and make sure that command is available to Workbench.",
    ssh_interactive:
        "This SSH profile needs an interactive sign-in. Connect with it in Terminal to complete that sign-in, then retry in Workbench.",
    remote_start_failed:
        "SSH connected, but the setup helper did not start. Check that this profile permits remote commands and that the server’s shell and Python work.",
    local_port_unavailable:
        "Workbench could not reserve a local connection port. Retry; if this continues, restart Workbench.",
    desktop_error:
        "Workbench could not complete the setup request. Close and reopen Servers, then retry.",
    timeout: "The operation timed out. Inspect the server before retrying.",
    cancelled: "Setup cancelled.",
    protocol: "The server returned an unsupported setup response.",
    payload_integrity: "The installation package did not pass verification.",
    conflict: "Existing server resources conflict with this installation. They were preserved.",
    recovery_required:
        "An earlier installation needs administrator recovery before setup can continue.",
    prerequisites_failed:
        "Required system packages could not be installed. Check the server’s official APT repositories and retry.",
    install_failed: "Installation failed. Inspect the server before retrying.",
    not_healthy: "The gateway has not passed its health check.",
    owner_exists: "An owner already exists. Connect and sign in with that account.",
    owner_invalid: "Check the owner email and password.",
    owner_failed: "The owner could not be created. Inspect the server before retrying.",
    invalid_request: "The server could not accept this setup request.",
    unsupported_platform: "Setup supports Debian 13 on x86-64 servers.",
    missing_prerequisites: "This server needs additional system packages before setup.",
    privilege_required: "Use an SSH profile with root access or sudo permission on this server.",
    origin_not_allowed: "This connection needs to be authorized on the gateway.",
    instance_conflict:
        "Existing server resources conflict with this installation. They were preserved.",
    partial_install:
        "An earlier installation needs administrator recovery before setup can continue.",
    service_unhealthy: "The gateway has not passed its health check.",
    payload_mismatch: "The installation package did not pass verification.",
    owner_already_configured: "An owner already exists. Connect and sign in with that account.",
    password_policy: "Use a password of 10 to 200 characters.",
    legacy_web_origin:
        "This gateway’s web interface needs an update before it can use this connection.",
    legacy_network_layout: "This gateway’s network layout does not support this SSH connection.",
    legacy_incompatible:
        "This existing gateway version needs administrator attention before Workbench can connect.",
    instance_unhealthy: "The existing gateway is not healthy. Its installation has been preserved.",
    packages_failed:
        "Required system packages could not be installed. Check the server’s official APT repositories and retry.",
    repository_configuration_unsupported:
        "Setup could not validate this server’s official APT configuration.",
    payload_missing: "The installation package could not be read. Try transferring it again.",
    payload_unsafe: "The remote package cache failed its safety checks.",
    stage_conflict: "The remote setup cache conflicts with existing files.",
    owner_not_found: "The gateway has no account eligible for initial owner setup.",
    owner_setup_failed: "The owner could not be created. Inspect the gateway before retrying.",
    origin_update_failed:
        "The gateway connection could not be enabled. Inspect the server before retrying.",
    busy: "Another setup operation is already running on this server.",
    internal_error: "Setup could not complete. Inspect the server before retrying.",
    invalid_origin: "The gateway could not accept this local connection address.",
    identity_changed:
        "The gateway identity differs from your saved server. Its saved certificate was preserved. Verify the change before removing and explicitly adding the server again.",
    download_failed:
        "The gateway package could not be downloaded. Check your connection and retry.",
    release_unavailable:
        "The gateway installation package has not been published for this Workbench release yet.",
};
function setupWorking(value) {
    setupBusy = value;
    setup.inspect.disabled = value;
    setup.alias.disabled = value;
    setup.progress.hidden = !value;
    if (value) setup.progress.removeAttribute("value");
    for (const name of ["install", "connect", "retry", "prepare", "prerequisite"])
        setup[name].hidden = true;
    setup.owner.hidden = true;
    setup.sudo.hidden = true;
    setup.error.textContent = "";
}
function setupShow(view) {
    setupWorking(false);
    setup.state.hidden = false;
    const result = view.result;
    setup.summary.textContent = "";
    if (view.code) {
        setup.status.textContent = "Setup could not continue.";
        setup.error.textContent = errors[view.code] ?? errors.protocol;
        setup.retry.hidden = false;
        if (view.code === "password_policy" && result?.connection?.ownerSetup === "required") {
            setup.owner.hidden = false;
            setup.retry.hidden = true;
        }
    } else if (result?.action === "inspect_existing") {
        setup.status.textContent = "A gateway installation is present.";
        setup.summary.textContent =
            "Install the required Debian Python package, then inspect this existing gateway. Workbench will check it before offering any gateway changes.";
        setup.prerequisite.hidden = false;
    } else if (result?.action === "prepare_connection") {
        setup.status.textContent = "A gateway is already installed.";
        setup.summary.textContent =
            "Enable this connection by updating the gateway’s web interface and authorizing this computer’s local address. Existing accounts, certificates and Happy data are preserved.";
        setup.prepare.hidden = false;
    } else if (result?.status === "missing" || result?.action === "resume") {
        setup.status.textContent = "This server is ready for setup.";
        setup.summary.textContent =
            "Install an isolated Gateway and Happy on this server. Existing Happy installations are preserved." +
            (result.prerequisites?.length
                ? ` Required system packages: ${result.prerequisites.join(", ")}.`
                : "") +
            " Workbench will download the verified package, transfer it and start the services.";
        setup.install.textContent =
            result.action === "resume" ? "Resume gateway startup" : "Install Gateway and Happy";
        setup.install.hidden = false;
    } else if (["found", "installed", "owner_ready", "origin_ready"].includes(result?.status)) {
        setup.status.textContent =
            result.status === "found"
                ? "A compatible gateway is already running."
                : "The gateway is ready.";
        setup.summary.textContent = `Connect through SSH on this computer’s port ${view.localPort}. The certificate is verified against the fingerprint received through SSH.`;
        setup.summary.textContent +=
            result.status === "owner_ready"
                ? result.connection.loginName
                    ? ` Sign in as ${result.connection.loginName} with the password you just set.`
                    : " Sign in with your gateway administrator account and the password you just set."
                : " Sign in with your existing gateway account.";
        document.getElementById("owner-instruction").textContent = result.connection.loginName
            ? `Set the gateway password for ${result.connection.loginName}.`
            : "Set the gateway administrator’s password.";
        setup.owner.hidden = result.connection.ownerSetup !== "required";
        setup.connect.hidden = result.connection.ownerSetup === "required";
    } else {
        setup.status.textContent = "Setup could not continue.";
        setup.error.textContent =
            errors[view.code ?? result?.code ?? result?.status] ?? errors.protocol;
        setup.retry.hidden = false;
    }
}
async function setupRun(op, owner) {
    if (!setupId || setupBusy) return;
    setupWorking(true);
    setup.status.textContent =
        steps[op === "probe" ? "preflight" : op === "setup_owner" ? "owner_setup" : "upload"];
    try {
        const view = await bridge.setupRun(setupId, op, owner);
        if (view?.id === setupId) setupShow(view);
    } catch {
        setupShow({ code: "desktop_error" });
    }
}
async function setupInspect() {
    if (setupBusy) return;
    const previous = setupId;
    setupId = null;
    setupWorking(true);
    setup.state.hidden = false;
    setup.status.textContent = steps.preflight;
    try {
        if (previous) await bridge.setupCancel(previous);
        const view = await bridge.setupCreate(setup.alias.value.trim());
        setupWorking(false);
        if (!view?.ok) {
            setupShow({ code: view?.code ?? "ssh_config" });
            return;
        }
        setupId = view.id;
        await setupRun("probe");
    } catch {
        setupShow({ code: "desktop_error" });
    }
}
setup.host.addEventListener("submit", (event) => {
    event.preventDefault();
    void setupInspect();
});
setup.install.addEventListener("click", () => setupRun("install"));
setup.prepare.addEventListener("click", () => setupRun("prepare_connection"));
setup.prerequisite.addEventListener("click", () => setupRun("inspect_existing"));
setup.retry.addEventListener("click", () => (setupId ? setupRun("probe") : setupInspect()));
setup.cancel.addEventListener("click", async () => {
    const id = setupId;
    setupId = null;
    if (id) await bridge.setupCancel(id);
    setupWorking(false);
    setup.state.hidden = true;
    for (const name of ["sudo-password", "owner-password", "owner-confirm"])
        document.getElementById(name).value = "";
});
setup.sudo.addEventListener("submit", (event) => {
    event.preventDefault();
    const field = document.getElementById("sudo-password");
    if (setupId) void bridge.setupSudo(setupId, field.value);
    field.value = "";
    setup.sudo.hidden = true;
});
setup.owner.addEventListener("submit", (event) => {
    event.preventDefault();
    const password = document.getElementById("owner-password");
    const confirm = document.getElementById("owner-confirm");
    if (password.value !== confirm.value) {
        setup.error.textContent = "The passwords do not match.";
        return;
    }
    const owner = { password: password.value };
    password.value = "";
    confirm.value = "";
    void setupRun("setup_owner", owner);
    owner.password = "";
});
setup.connect.addEventListener("click", async () => {
    if (!setupId || setupBusy) return;
    setupWorking(true);
    setup.status.textContent = "Connecting…";
    try {
        const result = await bridge.setupConnect(setupId);
        if (!result.ok) {
            setupWorking(false);
            setup.error.textContent = errors[result.message] ?? result.message;
            setup.retry.hidden = false;
            return;
        }
        await bridge.open(result.origin);
        setupId = null;
        setupWorking(false);
        setup.state.hidden = true;
        await refresh();
    } catch {
        setupShow({ code: "desktop_error" });
    }
});
bridge.onSetupEvent((event) => {
    if (event.id !== setupId) return;
    if (event.type === "sudo") {
        setup.sudo.hidden = false;
        setup.status.textContent = "Administrator permission is required on this server.";
        document.getElementById("sudo-password").focus();
    } else if (event.type === "progress") {
        setup.status.textContent = steps[event.step] ?? "Setting up the server…";
        if (Number.isFinite(event.total) && event.total > 0) {
            setup.progress.max = event.total;
            setup.progress.value = event.transferred;
        } else setup.progress.removeAttribute("value");
    }
});
void bridge.sshProfiles().then((profiles) => {
    document
        .getElementById("ssh-profiles")
        .replaceChildren(...profiles.map((value) => element("option", { value })));
});
