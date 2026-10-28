#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/env.sh
node scripts/prepare-vendor.mjs
# Requires native GLib development libraries (already required on Linux).
export CARGO_TARGET_DIR="$PWD/src-tauri/target/glib-native-check"
exec cargo test --manifest-path vendor/glib/Cargo.toml --release --lib test_variant_str_iter --locked
