#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/env.sh"
node "$(dirname "$0")/prepare-vendor.mjs"
node "$(dirname "$0")/prepare-licenses.mjs"
cd "$(dirname "$0")/../src-tauri"
exec cargo "$@"
