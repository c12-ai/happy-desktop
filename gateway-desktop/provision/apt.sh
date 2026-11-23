# Trusted function source embedded by the app, not sourced from an uploaded file.
# Only existing official Debian 13 deb822 sources are used; no repository configuration changes.
karis_install_packages() {
    [ "$(id -u)" = 0 ] || return 1
    for karis_package in "$@"; do
        case "$karis_package" in python3|sudo|bubblewrap|openssl|curl|iproute2|adduser|passwd|util-linux|ca-certificates) ;; *) return 1 ;; esac
    done
    karis_sources=/etc/apt/sources.list.d/debian.sources
    [ -f "$karis_sources" ] && [ ! -L "$karis_sources" ] || return 2
    [ "$(stat -c %u "$karis_sources")" = 0 ] || return 2
    karis_source_mode="$(stat -c %a "$karis_sources")"
    [ $((0$karis_source_mode & 0022)) = 0 ] || return 2
    # Whitelist the standard Debian image's existing sources and Debian archive signing key.
    awk '
      /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
      /^Types:/ { for(i=2;i<=NF;i++) if($i!="deb" && $i!="deb-src") bad=1; next }
      /^URIs:/ { uri++; for(i=2;i<=NF;i++) if($i !~ /^https?:\/\/(deb|security)\.debian\.org\//) bad=1; next }
      /^Suites:/ { for(i=2;i<=NF;i++) if($i!="trixie" && $i!="trixie-updates" && $i!="trixie-security") bad=1; next }
      /^Components:/ { for(i=2;i<=NF;i++) if($i!="main" && $i!="contrib" && $i!="non-free" && $i!="non-free-firmware") bad=1; next }
      /^Signed-By: \/usr\/share\/keyrings\/debian-archive-keyring.gpg[[:space:]]*$/ { key++; next }
      { bad=1 }
      END { exit (bad || !uri || !key) }
    ' "$karis_sources" || return 2
    karis_apt_temp="$(mktemp -d /tmp/karis-apt.XXXXXXXX)" || return 1
    mkdir -m 700 "$karis_apt_temp/empty" || return 1
    # Finish the current package transaction on disconnect; do not kill dpkg mid-transaction.
    # The caller checks cancellation before starting the instance's next phase.
    /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LANG=C.UTF-8 DEBIAN_FRONTEND=noninteractive apt-get \
        -o Acquire::Retries=0 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o DPkg::Lock::Timeout=60 \
        -o "Dir::Etc::sourcelist=$karis_sources" -o "Dir::Etc::sourceparts=$karis_apt_temp/empty" \
        -o "Dir::Etc::Trusted=/usr/share/keyrings/debian-archive-keyring.gpg" \
        -o "Dir::Etc::TrustedParts=$karis_apt_temp/empty" update >/dev/null 2>&1 || { rm -rf "$karis_apt_temp"; return 1; }
    /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LANG=C.UTF-8 DEBIAN_FRONTEND=noninteractive apt-get \
        -o Acquire::Retries=0 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o DPkg::Lock::Timeout=60 \
        -o "Dir::Etc::sourcelist=$karis_sources" -o "Dir::Etc::sourceparts=$karis_apt_temp/empty" \
        -o "Dir::Etc::Trusted=/usr/share/keyrings/debian-archive-keyring.gpg" \
        -o "Dir::Etc::TrustedParts=$karis_apt_temp/empty" \
        install --yes --no-upgrade --no-remove --no-install-recommends -- "$@" >/dev/null 2>&1
    karis_apt_result=$?
    rm -rf "$karis_apt_temp"
    return "$karis_apt_result"
}