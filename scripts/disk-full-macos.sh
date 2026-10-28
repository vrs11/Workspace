#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/env.sh
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'This runner requires macOS hdiutil; it never fills the host filesystem.' >&2
  exit 1
fi
mkdir -p artifacts
fixture="$(mktemp -d "$PWD/artifacts/disk-full-XXXXXX")"
mkdir "$fixture/mount"
attached=false
cleanup() {
  if [[ "$attached" == true ]]; then hdiutil detach "$fixture/mount"; fi
}
trap cleanup EXIT
hdiutil create -size 32m -fs HFS+ -volname AW-Save-Fault "$fixture/volume.dmg"
hdiutil attach -nobrowse -owners on -mountpoint "$fixture/mount" "$fixture/volume.dmg"
attached=true
printf %s disposable-disk-full-volume > "$fixture/mount/.aw-disposable-full-volume"
AW_FULL_VOLUME_FIXTURE="$fixture/mount" bash scripts/cargo.sh test --test disk_full --locked -- --ignored --exact full_volume_preserves_original_and_acknowledged_recovery_then_allows_retry
