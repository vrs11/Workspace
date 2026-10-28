#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/env.sh"
node "$(dirname "$0")/prepare-vendor.mjs"
node "$(dirname "$0")/prepare-licenses.mjs"
export VITE_DESKTOP_TEST=true
profile=debug
destination=artifacts/desktop-test
options=(--debug)
bundle_options=(--no-bundle)
if [[ "${1:-}" == --release ]]; then
  profile=release
  destination=artifacts/desktop-perf
  options=()
  if [[ "$OSTYPE" == darwin* ]]; then bundle_options=(--bundles app); fi
fi
pnpm exec tauri build "${options[@]}" "${bundle_options[@]}" --features desktop-test --config tests/desktop/tauri.test.conf.json -- --locked
mkdir -p "$destination"
if [[ "$OSTYPE" == msys* || "$OSTYPE" == cygwin* ]]; then
  cp "src-tauri/target/$profile/agent-workspace.exe" "$destination/agent-workspace.exe.tmp"
  mv "$destination/agent-workspace.exe.tmp" "$destination/agent-workspace.exe"
else
  cp "src-tauri/target/$profile/agent-workspace" "$destination/agent-workspace.tmp"
  mv "$destination/agent-workspace.tmp" "$destination/agent-workspace"
fi
if [[ "$profile" == release && "$OSTYPE" == darwin* ]]; then
  ditto "src-tauri/target/release/bundle/macos/Workspace Test.app" "$destination/Workspace Test.app"
fi
