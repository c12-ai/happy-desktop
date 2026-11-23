# Trusted nonroot upload command. Pin/size are substituted from the bundled manifest only.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077
karis_sha=__KARIS_PAYLOAD_SHA256__
karis_bytes=__KARIS_PAYLOAD_BYTES__
karis_fail() { printf '{"v":1,"requestId":null,"type":"error","code":"%s"}\n' "$1"; exit 1; }
case "${HOME:-}" in /*) ;; *) karis_fail payload_unsafe ;; esac
case "$HOME" in *[!a-zA-Z0-9_./-]*|*/../*|*/..|/) karis_fail payload_unsafe ;; esac
karis_cache="$HOME/.cache/karis-workbench"
karis_parent="$HOME"
while [ "$karis_parent" != / ]; do
    [ ! -L "$karis_parent" ] || karis_fail payload_unsafe
    karis_parent="$(dirname "$karis_parent")"
done
mkdir -p "$karis_cache"
for karis_dir in "$HOME/.cache" "$karis_cache"; do
    [ ! -L "$karis_dir" ] && [ "$(stat -c %u "$karis_dir")" = "$(id -u)" ] || karis_fail payload_unsafe
    karis_mode="$(stat -c %a "$karis_dir")"
    [ $((0$karis_mode & 0022)) = 0 ] || karis_fail payload_unsafe
done
karis_path="$karis_cache/payload-$karis_sha.tar.xz"
[ ! -L "$karis_path" ] || karis_fail payload_unsafe
if [ -f "$karis_path" ]; then
    [ "$(stat -c %u "$karis_path")" = "$(id -u)" ] || karis_fail payload_unsafe
    karis_actual="$(sha256sum "$karis_path")"; karis_actual="${karis_actual%% *}"
    if [ "$karis_actual" = "$karis_sha" ] && [ "$(stat -c %s "$karis_path")" = "$karis_bytes" ]; then
        printf '{"v":1,"requestId":null,"type":"ready","upload":"cached","payloadPath":"%s"}\n' "$karis_path"
        printf '{"v":1,"requestId":null,"type":"result","status":"cached","payloadPath":"%s"}\n' "$karis_path"
        exit 0
    fi
fi
karis_temp="$(mktemp "$karis_cache/.upload.XXXXXXXX")"
trap 'rm -f "$karis_temp" "$karis_temp.extra"' EXIT
trap 'exit 1' HUP INT TERM
printf '{"v":1,"requestId":null,"type":"ready","upload":"needed","payloadPath":"%s"}\n' "$karis_path"
karis_received=0
while [ "$karis_received" -lt "$karis_bytes" ]; do
    karis_chunk=$((karis_bytes - karis_received))
    [ "$karis_chunk" -le 1048576 ] || karis_chunk=1048576
    dd bs="$karis_chunk" count=1 iflag=fullblock status=none >> "$karis_temp"
    karis_received=$((karis_received + karis_chunk))
    [ "$(stat -c %s "$karis_temp")" = "$karis_received" ] || karis_fail payload_mismatch
    printf '{"v":1,"requestId":null,"type":"progress","step":"upload","received":%s,"total":%s}\n' "$karis_received" "$karis_bytes"
done
dd bs=1 count=1 iflag=fullblock status=none > "$karis_temp.extra"
[ ! -s "$karis_temp.extra" ] || karis_fail payload_mismatch
karis_actual="$(sha256sum "$karis_temp")"; karis_actual="${karis_actual%% *}"
[ "$karis_actual" = "$karis_sha" ] || karis_fail payload_mismatch
chmod 400 "$karis_temp"
mv -T "$karis_temp" "$karis_path"
printf '{"v":1,"requestId":null,"type":"result","status":"uploaded","payloadPath":"%s"}\n' "$karis_path"