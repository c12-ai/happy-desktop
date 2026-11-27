# Trusted function source embedded by the app, not sourced from an uploaded file.
# Only existing official Debian 13 deb822 sources are used; no repository configuration changes.
karis_apt_root_file() {
    [ -f "$1" ] && [ ! -L "$1" ] || return 1
    [ "$(stat -c %s "$1")" -le 65536 ] || return 1
    karis_checked_path="$1"
    while :; do
        [ ! -L "$karis_checked_path" ] || return 1
        [ "$(stat -c %u "$karis_checked_path")" = 0 ] || return 1
        karis_checked_mode="$(stat -c %a "$karis_checked_path")"
        [ $((0$karis_checked_mode & 0022)) = 0 ] || return 1
        [ "$karis_checked_path" != / ] || break
        karis_checked_path="$(dirname "$karis_checked_path")"
        [ -d "$karis_checked_path" ] || return 1
    done
}

karis_install_packages() {
    [ "$(id -u)" = 0 ] || return 1
    for karis_package in "$@"; do
        case "$karis_package" in python3|sudo|bubblewrap|openssl|curl|iproute2|adduser|passwd|util-linux|ca-certificates) ;; *) return 1 ;; esac
    done
    karis_sources=/etc/apt/sources.list.d/debian.sources
    karis_apt_root_file "$karis_sources" || return 2
    # Whitelist the standard Debian image's existing sources and Debian archive signing key.
    # Debian cloud images use these two local mirror lists. Validate every referenced list before
    # allowing APT to read the unchanged original source configuration.
    karis_apt_mirrors="$(awk '
      /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
      /^Types:/ { for(i=2;i<=NF;i++) if($i!="deb" && $i!="deb-src") bad=1; next }
      /^URIs:/ {
        uri++
        for(i=2;i<=NF;i++) {
          if($i=="mirror+file:///etc/apt/mirrors/debian.list" || $i=="mirror+file:/etc/apt/mirrors/debian.list") print "/etc/apt/mirrors/debian.list"
          else if($i=="mirror+file:///etc/apt/mirrors/debian-security.list" || $i=="mirror+file:/etc/apt/mirrors/debian-security.list") print "/etc/apt/mirrors/debian-security.list"
          else if($i !~ /^https?:\/\/deb\.debian\.org\/debian(-security)?\/?$/ && $i !~ /^https?:\/\/security\.debian\.org\/debian-security\/?$/) bad=1
        }
        next
      }
      /^Suites:/ { for(i=2;i<=NF;i++) if($i!="trixie" && $i!="trixie-updates" && $i!="trixie-security" && $i!="trixie-backports") bad=1; next }
      /^Components:/ { for(i=2;i<=NF;i++) if($i!="main" && $i!="contrib" && $i!="non-free" && $i!="non-free-firmware") bad=1; next }
      /^Signed-By: \/usr\/share\/keyrings\/debian-archive-keyring.gpg[[:space:]]*$/ { key++; next }
      { bad=1 }
      END { exit (bad || !uri || !key) }
    ' "$karis_sources")" || return 2
    for karis_mirror in $karis_apt_mirrors; do
        karis_apt_root_file "$karis_mirror" || return 2
        case "$karis_mirror" in
            /etc/apt/mirrors/debian.list) karis_repository=debian ;;
            /etc/apt/mirrors/debian-security.list) karis_repository=debian-security ;;
            *) return 2 ;;
        esac
        awk -v repository="$karis_repository" '
          /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
          {
            count++
            if(NF!=1) bad=1
            if(repository=="debian" && $1 !~ /^https?:\/\/deb\.debian\.org\/debian\/?$/) bad=1
            if(repository=="debian-security" && $1 !~ /^https?:\/\/(deb|security)\.debian\.org\/debian-security\/?$/) bad=1
          }
          END { exit (bad || !count) }
        ' "$karis_mirror" || return 2
    done
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