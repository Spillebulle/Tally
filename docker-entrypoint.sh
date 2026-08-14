#!/bin/sh
# Reconcile container and host ownership of /data before starting Tally.
#
# /data is almost always a bind mount owned by some host user. A container that
# simply runs as a fixed uid cannot write to it, so the image starts as root,
# takes ownership of /data as PUID:PGID, then drops to that user. This is the
# convention self-hosted images follow, and it means `- ./data:/data` works
# without the user having to chown anything first.
set -eu

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
DATA_DIR="${DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
    # Point the tally user at the requested ids. Skip when they already match,
    # which is the common case and avoids a pointless usermod on every boot.
    if [ "$(id -u tally)" != "$PUID" ]; then
        usermod -o -u "$PUID" tally
    fi
    if [ "$(id -g tally)" != "$PGID" ]; then
        groupmod -o -g "$PGID" tally
    fi

    mkdir -p "$DATA_DIR"
    # Only chown when it is actually wrong: recursing a large data directory on
    # every restart is slow, and on some remote filesystems it fails outright.
    if [ "$(stat -c '%u:%g' "$DATA_DIR")" != "$PUID:$PGID" ]; then
        echo "Tally: taking ownership of $DATA_DIR as $PUID:$PGID"
        chown -R "$PUID:$PGID" "$DATA_DIR" || {
            echo "Tally: could not chown $DATA_DIR." >&2
            echo "       If it is on a network share, chown it on the host and" >&2
            echo "       set PUID/PGID to the owning user instead." >&2
        }
    fi
    chown "$PUID:$PGID" /app 2>/dev/null || true

    exec gosu tally "$@"
fi

# Already non-root (someone passed `user:` in compose). Fail early and clearly
# rather than letting the app die on a permission error deep in startup.
if [ ! -w "$DATA_DIR" ]; then
    echo "Tally: $DATA_DIR is not writable by uid $(id -u)." >&2
    echo "       Either drop the 'user:' override so the image can manage" >&2
    echo "       ownership, or chown the directory on the host to match." >&2
    exit 1
fi

exec "$@"
