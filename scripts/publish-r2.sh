#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist-release"
BUCKET="${R2_BUCKET:-terminal-browser-releases}"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) TARGET=darwin-arm64 ;;
  Linux-x86_64|Linux-amd64) TARGET=linux-x64 ;;
  Linux-aarch64|Linux-arm64) TARGET=linux-arm64 ;;
  *) echo "unsupported build host: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

MANIFEST="$OUT/manifest-$TARGET.json"
[ -f "$MANIFEST" ] || { echo "no manifest at $MANIFEST — run release.sh first" >&2; exit 1; }

field() { node -p "require('$MANIFEST').$1"; }
VERSION="$(field version)"
CHANNEL="$(field channel)"
FILE="$(field file)"

wr() { (cd "$ROOT/release-worker" && npx --yes wrangler "$@"); }

put() {
  # wrangler uploads in one request, which the API caps at 315 MB.
  local size
  size=$(($(wc -c < "$2")))
  if [ "$size" -gt 330000000 ]; then
    echo "$2 is $size bytes — past the single-request R2 limit, needs multipart" >&2
    exit 1
  fi
  wr r2 object put "$BUCKET/$1" --file "$2" --remote --content-type "$3"
}

echo "uploading $FILE to $CHANNEL/$VERSION"
put "$CHANNEL/$VERSION/$FILE" "$OUT/$FILE" application/gzip
put "$CHANNEL/$VERSION/manifest-$TARGET.json" "$MANIFEST" application/json

echo "published $TARGET build of $VERSION to $CHANNEL"
