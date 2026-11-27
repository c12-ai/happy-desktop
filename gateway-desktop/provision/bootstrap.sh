# Trusted inline launcher. The desktop substitutes only bundled program text and a fixed mode.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077
karis_mode=__KARIS_MODE__
__KARIS_APT_PROGRAM__
if ! command -v python3 >/dev/null 2>&1; then
    if [ ! -f /etc/os-release ]; then
        printf '%s\n' '{"v":1,"requestId":null,"type":"error","code":"unsupported_platform"}'
        exit 0
    fi
    . /etc/os-release
    if [ "${ID:-}" != debian ] || [ "${VERSION_ID:-}" != 13 ] || [ "$(uname -m)" != x86_64 ]; then
        printf '%s\n' '{"v":1,"requestId":null,"type":"error","code":"unsupported_platform"}'
        exit 0
    fi
    if [ "$karis_mode" != install ] || [ "$(id -u)" != 0 ]; then
        if [ -e /etc/hgn ] || [ -e /opt/hgn ] || [ -e /etc/happy-gateway ] || [ -e /opt/happy-gateway ]; then
            printf '%s\n' '{"v":1,"requestId":null,"type":"error","code":"bootstrap_existing"}'
        else
            printf '%s\n' '{"v":1,"requestId":null,"type":"error","code":"bootstrap_required"}'
        fi
        exit 0
    fi
    # This branch runs only after the app user has selected Install, with the APT plan visible.
    . /etc/os-release
    if [ "${ID:-}" != debian ] || [ "${VERSION_ID:-}" != 13 ] || [ "$(uname -m)" != x86_64 ]; then
        printf '%s\n' '{"v":1,"requestId":null,"type":"error","code":"unsupported_platform"}'
        exit 0
    fi
    printf '%s\n' '{"v":1,"requestId":null,"type":"progress","step":"packages"}'
    # Child APT/dpkg processes inherit these ignored signals and finish their transaction.
    # On disconnect the subsequent helper reads EOF before any instance operation can begin.
    trap '' HUP INT TERM
    set +e
    karis_install_packages python3
    karis_result=$?
    trap - HUP INT TERM
    set -e
    if [ "$karis_result" != 0 ]; then
        if [ "$karis_result" = 2 ]; then karis_code=repository_configuration_unsupported; else karis_code=packages_failed; fi
        printf '{"v":1,"requestId":null,"type":"error","code":"%s"}\n' "$karis_code"
        exit 1
    fi
fi
exec /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LANG=C.UTF-8 SUDO_UID="${SUDO_UID:-0}" /usr/bin/python3 -I -c __KARIS_PYTHON_EXEC__