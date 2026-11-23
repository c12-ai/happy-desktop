"""Trusted app source, executed inline with python3 -I; all request data arrives on stdin.

Never execute a mutable uploaded program. Payload pins below are substituted from the app's
bundled manifest. No credentials, arbitrary subprocess output, or request bodies are logged.
"""
import fcntl
import errno
import hashlib
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import platform
import pwd
import grp
import re
import select
import signal
import socket
import ssl
import stat
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import uuid

PATH = "/usr/sbin:/usr/bin:/sbin:/bin"
CLEAN_ENV = {"PATH": PATH, "HOME": "/root", "LANG": "C.UTF-8"}
PIN = "__KARIS_PAYLOAD_SHA256__"
PAYLOAD_BYTES = "__KARIS_PAYLOAD_BYTES__"
APT_HEX = "__KARIS_APT_HEX__"
MANIFEST_HEX = "__KARIS_PACKAGE_MANIFEST_HEX__"
MAX_FRAME = 16384
TOOLS = {"bwrap": "bubblewrap", "sudo": "sudo", "openssl": "openssl", "curl": "curl",
         "ss": "iproute2", "adduser": "adduser", "useradd": "passwd", "runuser": "util-linux"}
OPS = {"probe", "install", "setup_owner", "authorize_origin", "prepare_connection", "resume"}
UNITS = ("happy.service", "gateway.service", "helper.service", "bot-watch.service",
         "bot-watch.timer", "settings-probe.service", "settings-probe.timer")
START_UNITS = ("happy.service", "helper.service", "gateway.service", "settings-probe.timer", "bot-watch.timer")
COMPATIBLE_GATEWAY = {"0c2a7eb24cb31c909bdcb8ed581e5b509946c3cab809662d5583cfd7d6a078d0"}


class Stop(Exception):
    def __init__(self, code, **public):
        self.code, self.public = code, public


def origin_port(value):
    match = re.fullmatch(r"https://localhost:([1-9][0-9]{0,4})", value) if isinstance(value, str) else None
    if not match or not 1024 <= int(match[1]) <= 65535:
        raise Stop("invalid_origin")
    return int(match[1])


def fingerprint(path):
    # Only the public certificate, never its key or any account credential.
    pem = Path(path).read_text(encoding="ascii")
    return hashlib.sha256(ssl.PEM_cert_to_DER_cert(pem)).hexdigest()


def root_path(path, directory=None):
    path = Path(path)
    for item in [path, *path.parents]:
        metadata = item.lstat()
        if (stat.S_ISLNK(metadata.st_mode) or metadata.st_uid != 0
                or metadata.st_mode & 0o022):
            raise Stop("instance_conflict")
    metadata = path.lstat()
    if directory is not None and stat.S_ISDIR(metadata.st_mode) != directory:
        raise Stop("instance_conflict")
    if not (stat.S_ISDIR(metadata.st_mode) or stat.S_ISREG(metadata.st_mode)):
        raise Stop("instance_conflict")
    return path


def atomic_json(path, data, mode=0o600):
    target = Path(path)
    root_path(target.parent, True)
    fd, temporary = tempfile.mkstemp(prefix=".karis-", dir=target.parent)
    try:
        with os.fdopen(fd, "w") as output:
            json.dump(data, output, separators=(",", ":"))
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class Profile:
    def __init__(self, prefix, opt, etc):
        self.prefix, self.opt, self.etc = prefix, Path(opt), Path(etc)
        self.state = Path("/var/lib/" + prefix + "-gateway")
        self.happy = Path("/var/lib/" + prefix + "-happy")
        self.config = None
        self.pin = None
        self.same_origin = False
        self.owner = "unknown"
        self.login_name = None
        self.healthy = False
        self.compatible = False

    def unit(self, suffix):
        return self.prefix + "-" + suffix

    def present(self):
        paths = (self.opt, self.etc, self.state, self.happy, Path("/home/" + self.prefix + "-work"))
        if any(path.exists() or path.is_symlink() for path in paths):
            return True
        for suffix in UNITS:
            for base in ("/etc/systemd/system", "/run/systemd/system", "/usr/lib/systemd/system"):
                path = Path(base) / self.unit(suffix)
                if path.exists() or path.is_symlink():
                    return True
        for name in ("happy", "gateway", "bot-watch", "work"):
            try:
                pwd.getpwnam(self.prefix + "-" + name)
                return True
            except KeyError:
                pass
            try:
                grp.getgrnam(self.prefix + "-" + name)
                return True
            except KeyError:
                pass
        return False

    def read_config(self):
        path = root_path(self.etc / "gateway.env", False)
        if path.stat().st_size > 32768:
            raise Stop("instance_conflict")
        values = {}
        for line in path.read_text().splitlines():
            if not line or line.startswith("#"):
                continue
            key, separator, value = line.partition("=")
            if not separator or not re.fullmatch(r"HG_[A-Z0-9_]+", key) or key in values:
                raise Stop("instance_conflict")
            values[key] = value
        required = {"HG_ROOT": str(self.opt), "HG_STATE_DIR": str(self.state),
                    "HG_HAPPY_HOME": str(self.happy), "HG_HAPPY_WEB_DIR": str(self.opt / "happy-web"),
                    "HG_EXECUTION_USER": self.prefix + "-work",
                    "HG_TLS_CERT": str(self.etc / "tls/server.crt"),
                    "HG_TLS_KEY": str(self.etc / "tls/server.key")}
        if any(values.get(key) != value for key, value in required.items()):
            raise Stop("instance_conflict")
        for key in ("HG_GATEWAY_PORT", "HG_HAPPY_WEB_PORT"):
            if not re.fullmatch(r"[1-9][0-9]{0,4}", values.get(key, "")) or not 1024 <= int(values[key]) <= 65535:
                raise Stop("instance_conflict")
        if int(values["HG_HAPPY_WEB_PORT"]) == int(values["HG_GATEWAY_PORT"]):
            raise Stop("instance_conflict")
        bind = ipaddress.IPv4Address(values.get("HG_GATEWAY_HOST", "127.0.0.1"))
        private = str(bind) == "127.0.0.1" or any(bind in ipaddress.ip_network(network) for network in
                      ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))
        if not private:
            raise Stop("instance_conflict")
        self.config = values

    def validate(self, controller):
        root_path(self.opt, True)
        root_path(self.etc, True)
        self.read_config()
        if self.prefix == "hgn":
            marker = root_path(self.etc / "instance", False)
            if marker.read_text().strip() != "hgn":
                raise Stop("instance_conflict")
        identities = {}
        for role in ("happy", "gateway", "bot-watch", "work"):
            account = pwd.getpwnam(self.prefix + "-" + role)
            if account.pw_uid == 0:
                raise Stop("instance_conflict")
            identities[role] = account
        if len({account.pw_uid for account in identities.values()}) != 4:
            raise Stop("instance_conflict")
        for path, role in ((self.state, "gateway"), (self.happy, "happy")):
            metadata = path.lstat()
            if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != identities[role].pw_uid or metadata.st_mode & 0o077:
                raise Stop("instance_conflict")
        for suffix in UNITS:
            path = root_path(Path("/etc/systemd/system") / self.unit(suffix), False)
            text = path.read_text()
            starts = re.findall(r"^ExecStart=(.*)$", text, re.M)
            if suffix.endswith(".timer"):
                # Default timer Unit= is its identically named service; never start a redirect.
                if starts or re.search(r"^Unit=", text, re.M):
                    raise Stop("instance_conflict")
            else:
                relative = {"gateway.service": "gateway/server.js", "helper.service": "gateway/helper.js",
                            "bot-watch.service": "bin/" + self.prefix + "-bot-watch.mjs",
                            "settings-probe.service": "bin/" + self.prefix + "-settings-probe.mjs"}
                program = (str(self.opt / "bin/happy-agent") + " run" if suffix == "happy.service" else
                           str(self.opt / "node/bin/node") + " " + str(self.opt / relative[suffix]))
                permitted = {program}
                if suffix == "helper.service":
                    permitted.add("/usr/bin/node " + str(self.opt / "gateway/helper.js"))
                if len(starts) != 1 or starts[0] not in permitted:
                    raise Stop("instance_conflict")
                expected_user = ("root" if suffix == "helper.service" else self.prefix + "-" +
                                 ("happy" if suffix == "settings-probe.service" else suffix.split(".")[0]))
                users = re.findall(r"^User=(.*)$", text, re.M)
                if users != ([] if suffix == "helper.service" else [expected_user]):
                    raise Stop("instance_conflict")
                if re.search(r"^Exec(?:StartPre|StartPost|Stop|StopPost|Reload)=", text, re.M):
                    raise Stop("instance_conflict")
            shown = controller.capture(["systemctl", "show", self.unit(suffix),
                                        "--property=LoadState,ActiveState,FragmentPath,DropInPaths"])
            properties = dict(line.split("=", 1) for line in shown.splitlines() if "=" in line)
            if properties.get("LoadState") != "loaded" or properties.get("FragmentPath") != str(path):
                raise Stop("instance_conflict")
            for name in properties.get("DropInPaths", "").split():
                dropin = root_path(name, False)
                if (suffix != "bot-watch.service" or dropin != Path(str(path) + ".d/isolation.conf")
                        or any(line and line != "[Service]" and not line.startswith("InaccessiblePaths=")
                               for line in dropin.read_text().splitlines())):
                    raise Stop("instance_conflict")
        for file in ("gateway/server.js", "gateway/setup.js", "gateway/helper.js", "node/bin/node", "bin/happy-agent",
                     "bin/" + self.prefix + "-bot-watch.mjs", "bin/" + self.prefix + "-settings-probe.mjs"):
            root_path(self.opt / file, False)
        self.compatible = hashlib.sha256((self.opt / "gateway/server.js").read_bytes()).hexdigest() in (COMPATIBLE_GATEWAY | set(controller.manifest.get("compatibleGatewaySha256", [])))
        metadata_path = self.etc / "connection.json"
        public = None
        if metadata_path.exists():
            root_path(metadata_path, False)
            public = json.loads(metadata_path.read_text())
            if public.get("v") != 1 or public.get("profile") != self.prefix:
                raise Stop("instance_conflict")
        try:
            root_path(self.etc / "tls/server.crt", False)
            self.pin = fingerprint(self.etc / "tls/server.crt")
        except PermissionError:
            if not public or not re.fullmatch(r"[a-f0-9]{64}", public.get("certificateSha256", "")):
                raise Stop("privilege_required")
            self.pin = public["certificateSha256"]
        if public and public.get("certificateSha256") != self.pin:
            raise Stop("instance_conflict")
        marker = self.opt / "happy-web/karis-web.json"
        if marker.exists():
            root_path(marker, False)
            mode = json.loads(marker.read_text())
            self.same_origin = mode.get("v") == 1 and mode.get("sameOrigin") is True
        if public:
            self.owner = public.get("ownerSetup", "unknown")
            if self.owner not in ("required", "ready", "unknown"):
                raise Stop("instance_conflict")
            self.login_name = checked_login_name(public.get("loginName"))
        self.healthy = controller.health(self)
        return self

    def identity(self):
        return self.prefix + "-" + self.pin[:24]

    def origins(self):
        values = [self.config.get("HG_PUBLIC_ORIGIN", ""), *self.config.get("HG_EXTRA_ORIGINS", "").split(",")]
        return sorted({value for value in values if re.fullmatch(r"https://localhost:[1-9][0-9]{0,4}", value)})

    def connection(self, origin):
        capabilities = {"sameOriginWeb": self.same_origin, "tunnelCompatible": True}
        if not self.same_origin:
            capabilities["requiredLocalPort"] = 47443 if self.prefix == "hgn" else 8444
        connection = {"webPort": int(self.config["HG_HAPPY_WEB_PORT"]), "remoteHost": self.config.get("HG_GATEWAY_HOST", "127.0.0.1"),
                "origin": origin, "certificateSha256": self.pin, "instanceId": self.identity(),
                "profile": self.prefix, "ownerSetup": self.owner, "allowedOrigins": self.origins(),
                "capabilities": capabilities}
        if self.login_name:
            connection["loginName"] = self.login_name
        return connection


def checked_login_name(value):
    return value if isinstance(value, str) and 1 <= len(value) <= 200 and not re.search(r"[\x00-\x1f\x7f]", value) else None


def profiles():
    return [Profile("hgn", "/opt/hgn", "/etc/hgn"), Profile("hg", "/opt/happy-gateway", "/etc/happy-gateway")]


class Controller:
    def __init__(self, request, emit):
        self.request, self.emit = request, emit
        self.cancel = threading.Event()
        self.child = None
        self.manifest = json.loads(bytes.fromhex(MANIFEST_HEX))

    def progress(self, step):
        self.emit("progress", step=step)

    def check_cancel(self):
        if self.cancel.is_set():
            raise Stop("cancelled")

    def capture(self, args, *, environment=None, input_text=None, timeout=30):
        answer = subprocess.run(args, env=environment or CLEAN_ENV, input=input_text,
                                text=True, capture_output=True, timeout=timeout)
        if answer.returncode or len(answer.stdout) > 131072:
            raise Stop("instance_conflict")
        return answer.stdout

    def run(self, args, *, environment=None, input_text=None, package_transaction=False, timeout=300):
        self.check_cancel()
        self.child = subprocess.Popen(args, env=environment or CLEAN_ENV, stdin=subprocess.PIPE,
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                      text=True, start_new_session=True)
        if input_text is not None:
            self.child.stdin.write(input_text)
        self.child.stdin.close()
        deadline = time.monotonic() + timeout
        while self.child.poll() is None:
            if not package_transaction and (self.cancel.is_set() or time.monotonic() > deadline):
                os.killpg(self.child.pid, signal.SIGTERM)
                try:
                    self.child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    os.killpg(self.child.pid, signal.SIGKILL)
                    self.child.wait()
                raise Stop("cancelled" if self.cancel.is_set() else "timeout")
            time.sleep(0.05)
        code = self.child.returncode
        self.child = None
        self.check_cancel()
        return code

    def health(self, profile):
        try:
            # is-active with several units succeeds if any unit is active; require every unit.
            answer = subprocess.run(["systemctl", "show", "--property=ActiveState", "--value",
                                     *[profile.unit(unit) for unit in START_UNITS[:3]]],
                                    env=CLEAN_ENV, capture_output=True, text=True, timeout=5)
        except subprocess.TimeoutExpired:
            return False
        if answer.returncode or answer.stdout.split() != ["active"] * 3:
            return False
        try:
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
            with socket.create_connection((profile.config.get("HG_GATEWAY_HOST", "127.0.0.1"),
                                           int(profile.config["HG_HAPPY_WEB_PORT"])), timeout=2) as tcp:
                with context.wrap_socket(tcp, server_hostname="localhost") as secured:
                    if hashlib.sha256(secured.getpeercert(binary_form=True)).hexdigest() != profile.pin:
                        return False
                    secured.sendall(b"HEAD /signin HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
                    return secured.recv(256).startswith(b"HTTP/1.1 200")
        except (OSError, ssl.SSLError):
            return False

    def discover(self):
        found = []
        for profile in profiles():
            if profile.present():
                try:
                    found.append(profile.validate(self))
                except PermissionError as error:
                    raise Stop("privilege_required") from error
                except (FileNotFoundError, KeyError, ValueError) as error:
                    raise Stop("instance_conflict") from error
        if len(found) > 1:
            raise Stop("instance_conflict")
        return found[0] if found else None

    def prerequisites(self):
        import shutil
        return sorted({package for tool, package in TOOLS.items() if shutil.which(tool, path=PATH) is None})

    def supported(self):
        try:
            data = dict(line.split("=", 1) for line in Path("/etc/os-release").read_text().splitlines() if "=" in line)
            return data.get("ID", "").strip('"') == "debian" and data.get("VERSION_ID", "").strip('"') == "13" and platform.machine() == "x86_64" and Path("/run/systemd/system").is_dir()
        except OSError:
            return False

    def result_existing(self, profile):
        connection = profile.connection(self.request["clientOrigin"])
        if not profile.healthy:
            return {"status": "action_required", "code": "service_unhealthy", "action": "resume", "connection": connection}
        if (not profile.same_origin and origin_port(self.request["clientOrigin"]) != connection["capabilities"]["requiredLocalPort"]) or self.request["clientOrigin"] not in profile.origins():
            if profile.compatible:
                return {"status": "action_required", "code": "origin_not_allowed", "action": "prepare_connection", "connection": connection}
            return {"status": "conflict", "code": "legacy_incompatible", "connection": connection}
        return {"status": "found", "connection": connection}

    def owner_info(self, profile):
        environment = {**CLEAN_ENV, **profile.config}
        program = """import {DatabaseSync} from 'node:sqlite';
const db = new DatabaseSync(process.env.HG_STATE_DIR + '/gateway.sqlite', {readOnly:true});
try { console.log(JSON.stringify(db.prepare("SELECT id, name, password_hash IS NOT NULL AS configured FROM person WHERE role='owner' AND status='active'").all())); } finally { db.close(); }
"""
        raw = self.capture(["runuser", "-u", profile.prefix + "-gateway", "--", str(profile.opt / "node/bin/node"),
                            "--input-type=module", "-e", program], environment=environment)
        owners = json.loads(raw)
        if len(owners) != 1:
            raise Stop("owner_not_found")
        owners[0]["hasPassword"] = bool(owners[0].pop("configured"))
        return owners[0]

    def publish(self, profile):
        owner = self.owner_info(profile)
        profile.owner = "ready" if owner.get("hasPassword") else "required"
        profile.login_name = checked_login_name(owner.get("name"))
        atomic_json(profile.etc / "connection.json", {"v": 1, "profile": profile.prefix,
                    "certificateSha256": profile.pin, "instanceId": profile.identity(),
                    "ownerSetup": profile.owner, **({"loginName": profile.login_name} if profile.login_name else {})}, mode=0o644)

    def locked(self):
        root_path("/run", True)
        folder = Path("/run/karis-provision")
        if not folder.exists():
            folder.mkdir(mode=0o700)
        root_path(folder, True)
        descriptor = os.open(folder / "operation.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        if os.fstat(descriptor).st_uid != 0:
            os.close(descriptor)
            raise Stop("instance_conflict")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(descriptor)
            raise Stop("busy")
        return descriptor

    def journal(self, phase, profile=None):
        folder = Path("/var/lib/karis-provision")
        root_path(folder.parent, True)
        if not folder.exists():
            folder.mkdir(mode=0o700)
        root_path(folder, True)
        atomic_json(folder / "hgn.json", {"v": 1, "phase": phase, "payloadSha256": PIN,
                    "instanceId": profile.identity() if profile else None})

    def stage(self):
        self.progress("verify_payload")
        source = Path(self.request.get("payloadPath", ""))
        caller = int(os.environ.get("SUDO_UID", os.getuid()))
        account = pwd.getpwuid(caller)
        expected = Path(account.pw_dir) / ".cache/karis-workbench" / ("payload-" + PIN + ".tar.xz")
        if source != expected:
            raise Stop("payload_unsafe")
        for ancestor in source.parents:
            metadata = ancestor.lstat()
            if stat.S_ISLNK(metadata.st_mode) or metadata.st_uid not in (0, caller) or metadata.st_mode & 0o022:
                raise Stop("payload_unsafe")
        try:
            fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except FileNotFoundError:
            raise Stop("payload_missing")
        except OSError as error:
            if error.errno in (errno.ELOOP, errno.ENOTDIR):
                raise Stop("payload_unsafe") from error
            raise
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != caller or metadata.st_size != int(PAYLOAD_BYTES):
            os.close(fd)
            raise Stop("payload_unsafe")
        parent = Path("/var/cache/karis-workbench")
        root_path(parent.parent, True)
        if not parent.exists():
            parent.mkdir(mode=0o700)
        root_path(parent, True)
        stage = Path(tempfile.mkdtemp(prefix="release-", dir=parent))
        digest = hashlib.sha256()
        with os.fdopen(fd, "rb") as incoming, (stage / "payload.tar.xz").open("xb") as output:
            total = 0
            while chunk := incoming.read(1024 * 1024):
                self.check_cancel()
                total += len(chunk)
                if total > int(PAYLOAD_BYTES):
                    raise Stop("payload_mismatch")
                digest.update(chunk)
                output.write(chunk)
        if digest.hexdigest() != PIN or total != int(PAYLOAD_BYTES):
            raise Stop("payload_mismatch")
        with tarfile.open(stage / "payload.tar.xz", "r:xz") as archive:
            members = archive.getmembers()
            if len(members) > 4096 or sum(member.size for member in members) > 2 * 1024**3:
                raise Stop("payload_unsafe")
            names = set()
            for member in members:
                path = PurePosixPath(member.name)
                if (path.is_absolute() or ".." in path.parts or not path.parts or path.as_posix() != member.name.rstrip("/")
                        or member.name in names or not (member.isdir() or member.isfile())):
                    raise Stop("payload_unsafe")
                names.add(member.name)
            manifest = archive.getmember("MANIFEST.sha256")
            if not manifest.isfile() or manifest.size > 256 * 1024:
                raise Stop("payload_unsafe")
            hashes = {}
            for line in archive.extractfile(manifest).read().decode().splitlines():
                checksum, name = line.split("  ", 1)
                if not re.fullmatch(r"[a-f0-9]{64}", checksum) or name in hashes:
                    raise Stop("payload_unsafe")
                hashes[name] = checksum
            if {member.name for member in members if member.isfile()} != set(hashes) | {"MANIFEST.sha256"} or "payload.tar.xz" in hashes:
                raise Stop("payload_unsafe")
            for member in members:
                self.check_cancel()
                if not member.isfile():
                    continue
                target = stage.joinpath(*PurePosixPath(member.name).parts)
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                digest = hashlib.sha256()
                with archive.extractfile(member) as incoming, target.open("xb") as output:
                    while chunk := incoming.read(1024 * 1024):
                        self.check_cancel()
                        digest.update(chunk)
                        output.write(chunk)
                if member.name != "MANIFEST.sha256" and digest.hexdigest() != hashes[member.name]:
                    raise Stop("payload_mismatch")
                target.chmod(0o700 if member.mode & 0o111 else 0o600)
        return stage

    def start(self, profile):
        self.progress("start")
        code = self.run(["systemctl", "enable", "--now", *[profile.unit(unit) for unit in START_UNITS]])
        if code:
            raise Stop("service_unhealthy")
        self.wait_health(profile)

    def wait_health(self, profile):
        for _ in range(60):
            self.check_cancel()
            if self.health(profile):
                profile.healthy = True
                return
            time.sleep(0.5)
        raise Stop("service_unhealthy")

    def initial_install(self):
        if not self.supported():
            return {"status": "unsupported", "code": "unsupported_platform"}
        stage = self.stage()
        missing = self.prerequisites()
        if missing:
            self.progress("packages")
            script = bytes.fromhex(APT_HEX).decode() + '\nkaris_install_packages "$@"\n'
            code = self.run(["/bin/sh", "-c", script, "karis-apt", *missing], package_transaction=True)
            if code:
                raise Stop("repository_configuration_unsupported" if code == 2 else "packages_failed")
        environment = {**CLEAN_ENV, "HAPPY_WEB_DIR": str(stage / "happy-web"),
                       "HG_CLIENT_ORIGIN": self.request["clientOrigin"],
                       "CODEX_PROGRAM": str(stage / "codex-0.170.0"),
                       "CODEX_SHA256": self.manifest["codexSha256"]}
        command = ["/bin/bash", str(stage / "bundle/install.sh"), "--prefix", "hgn"]
        arguments = [str(stage / "bundle"), str(stage / "happy-agent"), "localhost", "127.0.0.1", "47442", "127.0.0.1/32", "hgn-work"]
        self.progress("preflight")
        if self.run(command + ["--dry-run"] + arguments, environment=environment):
            raise Stop("instance_conflict")
        self.journal("installing")
        self.progress("install")
        if self.run(command + arguments, environment=environment):
            raise Stop("partial_install")
        profile = profiles()[0].validate(self)
        self.journal("configured", profile)
        self.start(profile)
        self.publish(profile)
        self.journal("ready", profile)
        return {"status": "installed", "connection": profile.connection(self.request["clientOrigin"])}

    def update_origin(self, profile):
        origin = self.request["clientOrigin"]
        if origin in profile.origins():
            return False
        target = root_path(profile.etc / "gateway.env", False)
        metadata = target.stat()
        text = target.read_text()
        existing = profile.config.get("HG_EXTRA_ORIGINS", "")
        value = existing + ("," if existing else "") + origin
        replacement = "HG_EXTRA_ORIGINS=" + value
        if "HG_EXTRA_ORIGINS" in profile.config:
            text = re.sub(r"^HG_EXTRA_ORIGINS=.*$", lambda _: replacement, text, count=1, flags=re.M)
        else:
            text = text.rstrip("\n") + "\n" + replacement + "\n"
        fd, temporary = tempfile.mkstemp(prefix=".origin-", dir=profile.etc)
        with os.fdopen(fd, "w") as output:
            os.fchown(output.fileno(), metadata.st_uid, metadata.st_gid)
            os.fchmod(output.fileno(), stat.S_IMODE(metadata.st_mode))
            output.write(text)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, target)
        profile.read_config()
        return True

    def prepare_web(self, profile, stage):
        if not profile.compatible:
            raise Stop("legacy_incompatible")
        source = stage / "happy-web"
        marker = json.loads(root_path(source / "karis-web.json", False).read_text())
        if marker.get("v") != 1 or marker.get("sameOrigin") is not True:
            raise Stop("legacy_incompatible")
        target = root_path(profile.opt / "happy-web", True)
        for item in target.rglob("*"):
            root_path(item, item.is_dir())
        index = root_path(target / "index.html", False)
        previous = index.read_bytes()
        backup = target / (".karis-index-" + hashlib.sha256(previous).hexdigest() + ".html")
        if not backup.exists():
            with backup.open("xb") as output:
                output.write(previous)
            backup.chmod(0o644)
        self.progress("origin")
        files = sorted(item for item in source.rglob("*") if item.is_file() and item.name not in ("index.html", "karis-web.json"))
        files.append(source / "index.html")  # Publish entry only after all assets; retain old hashed assets.
        files.append(source / "karis-web.json")  # Capability is committed after the new entry, never before it.
        for item in files:
            self.check_cancel()
            destination = target / item.relative_to(source)
            destination.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            root_path(destination.parent, True)
            if destination.exists():
                root_path(destination, False)
                if destination.read_bytes() == item.read_bytes():
                    continue
            fd, temporary = tempfile.mkstemp(prefix=".web-", dir=destination.parent)
            with os.fdopen(fd, "wb") as output:
                with item.open("rb") as incoming:
                    import shutil
                    shutil.copyfileobj(incoming, output)
                output.flush()
                os.fsync(output.fileno())
            os.chmod(temporary, 0o644)
            os.replace(temporary, destination)
        # The web-mode marker is part of the verified web payload, never inferred from text assets.
        marker = json.loads(root_path(target / "karis-web.json", False).read_text())
        if marker.get("v") != 1 or marker.get("sameOrigin") is not True:
            raise Stop("legacy_incompatible")
        profile.same_origin = True

    def dispatch(self):
        self.progress("preflight")
        try:
            profile = self.discover()
        except Stop as error:
            journal = Path("/var/lib/karis-provision/hgn.json")
            if error.code == "instance_conflict" and os.geteuid() == 0 and journal.exists():
                root_path(journal, False)
                record = json.loads(journal.read_text())
                if record.get("v") == 1 and record.get("payloadSha256") == PIN and record.get("phase") == "installing":
                    return {"status": "recovery_required", "code": "partial_install"}
            raise
        op = self.request["op"]
        if op == "probe":
            if profile:
                if os.geteuid() == 0 and profile.compatible:
                    owner = self.owner_info(profile)
                    profile.owner = "ready" if owner.get("hasPassword") else "required"
                    profile.login_name = checked_login_name(owner.get("name"))
                return self.result_existing(profile)
            if not self.supported():
                return {"status": "unsupported", "code": "unsupported_platform"}
            return {"status": "missing", "action": "install", "prerequisites": self.prerequisites()}
        if os.geteuid() != 0:
            raise Stop("privilege_required")
        lock = self.locked()
        try:
            self.check_cancel()
            profile = self.discover()  # Revalidate after the operation lock, never act on a stale absence.
            if op == "install":
                if profile:
                    return self.result_existing(profile)
                return self.initial_install()
            if not profile or self.request.get("instanceId") != profile.identity():
                raise Stop("instance_conflict")
            if not profile.compatible:
                raise Stop("legacy_incompatible")
            if op == "setup_owner":
                owner = self.owner_info(profile)
                if owner.get("hasPassword"):
                    self.publish(profile)
                    raise Stop("owner_already_configured")
                password = self.request["owner"]["password"]
                if not 10 <= len(password.encode("utf-16-le", errors="surrogatepass")) // 2 <= 200 or any(value in password for value in ("\x00", "\r", "\n")):
                    raise Stop("password_policy")
                try:
                    password.encode("utf8")
                except UnicodeEncodeError:
                    raise Stop("password_policy")
                self.progress("owner_setup")
                program_path = profile.opt / "gateway/ownerInitial.js"
                if not program_path.exists():
                    program_path = self.stage() / "bundle/gateway/ownerInitial.js"
                root_path(program_path, False)
                program = program_path.read_text()
                code = self.run(["runuser", "-u", profile.prefix + "-gateway", "--", str(profile.opt / "node/bin/node"),
                                 "--input-type=module", "-e", program],
                                environment={**CLEAN_ENV, **profile.config}, input_text=json.dumps({"password": password}))
                self.request.pop("owner", None)
                password = None
                if code == 10:
                    raise Stop("owner_already_configured")
                if code == 11:
                    raise Stop("password_policy")
                if code == 13:
                    raise Stop("legacy_incompatible")
                if code:
                    raise Stop("owner_setup_failed")
                self.publish(profile)
                return {"status": "owner_ready", "connection": profile.connection(self.request["clientOrigin"])}
            if op == "resume":
                self.start(profile)
                self.publish(profile)
                return self.result_existing(profile)
            if op in ("authorize_origin", "prepare_connection"):
                if not profile.compatible:
                    raise Stop("legacy_incompatible")
                if op == "prepare_connection" and not profile.same_origin:
                    self.prepare_web(profile, self.stage())
                elif not profile.same_origin and origin_port(self.request["clientOrigin"]) != (47443 if profile.prefix == "hgn" else 8444):
                    raise Stop("legacy_web_origin")
                changed = self.update_origin(profile)
                if changed and self.run(["systemctl", "restart", profile.unit("gateway.service")]):
                    raise Stop("origin_update_failed")
                self.wait_health(profile)
                self.publish(profile)
                return {"status": "origin_ready", "connection": profile.connection(self.request["clientOrigin"])}
            raise Stop("invalid_request")
        finally:
            os.close(lock)


def validate_request(value):
    if not isinstance(value, dict) or value.get("v") != 1 or value.get("op") not in OPS:
        raise Stop("invalid_request")
    if set(value) - {"v", "requestId", "op", "clientOrigin", "payloadPath", "instanceId", "owner"}:
        raise Stop("invalid_request")
    identity = value.get("requestId")
    try:
        valid_identity = isinstance(identity, str) and str(uuid.UUID(identity)) == identity
    except ValueError:
        valid_identity = False
    if not valid_identity:
        raise Stop("invalid_request")
    origin_port(value.get("clientOrigin"))
    for key in ("payloadPath", "instanceId"):
        if key in value and (not isinstance(value[key], str) or len(value[key]) > 4096 or any(char in value[key] for char in ("\x00", "\r", "\n"))):
            raise Stop("invalid_request")
    if value["op"] == "setup_owner":
        owner = value.get("owner")
        if not isinstance(owner, dict) or set(owner) != {"password"} or not isinstance(owner["password"], str):
            raise Stop("invalid_request")
    elif "owner" in value:
        raise Stop("invalid_request")
    return value


def main():
    os.umask(0o077)
    caller_uid = os.environ.get("SUDO_UID", str(os.getuid()))
    if not re.fullmatch(r"[0-9]{1,10}", caller_uid):
        caller_uid = str(os.getuid())
    os.environ.clear()
    os.environ.update({**CLEAN_ENV, "SUDO_UID": caller_uid})
    request_id = None
    stop_reader = threading.Event()
    reader = None
    def emit(kind, **fields):
        print(json.dumps({"v": 1, "requestId": request_id, "type": kind, **fields}, separators=(",", ":")), flush=True)
    emit("ready", uid=os.geteuid())
    try:
        # Raw reads avoid a daemon holding BufferedReader's lock during interpreter shutdown.
        # Read the first frame exactly, leaving cancellation bytes on the descriptor.
        line = bytearray()
        while len(line) <= MAX_FRAME:
            value = os.read(0, 1)
            line.extend(value)
            if not value or value == b"\n":
                break
        if not line.endswith(b"\n") or len(line) > MAX_FRAME:
            raise Stop("invalid_request")
        request = validate_request(json.loads(line))
        request_id = request["requestId"]
        controller = Controller(request, emit)
        def cancellation():
            followup = bytearray()
            while not stop_reader.is_set():
                if not select.select([0], [], [], 0.1)[0]:
                    continue
                value = os.read(0, MAX_FRAME + 1 - len(followup))
                followup.extend(value)
                if not value or b"\n" in followup or len(followup) > MAX_FRAME:
                    # EOF, a cancel frame, or malformed extra input all stop this operation.
                    controller.cancel.set()
                    return
        reader = threading.Thread(target=cancellation, daemon=True)
        reader.start()
        for signum in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
            signal.signal(signum, lambda *_: controller.cancel.set())
        result = controller.dispatch()
        emit("result", **result)
    except Stop as error:
        if error.code == "partial_install":
            emit("result", status="recovery_required", code=error.code)
        elif error.code == "privilege_required":
            emit("result", status="action_required", action="privilege_required", code=error.code)
        elif error.code in ("instance_conflict", "legacy_incompatible"):
            emit("result", status="conflict", code=error.code)
        else:
            emit("error", code=error.code)
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError, tarfile.TarError):
        emit("error", code="internal_error")
    finally:
        stop_reader.set()
        if reader:
            reader.join(timeout=1)


if __name__ == "__main__":
    main()