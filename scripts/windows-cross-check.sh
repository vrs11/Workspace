#!/usr/bin/env bash
# Type/API validation only. This does not execute a Windows application.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/env.sh
node scripts/prepare-vendor.mjs
export AW_ZIG_BIN="${AW_ZIG_BIN:-$PWD/.tools/zig/zig-x86_64-macos-0.17.0/zig}"
if [[ ! -x "$AW_ZIG_BIN" ]]; then
  echo 'Set AW_ZIG_BIN to Zig 0.17.0; install the Rust x86_64-pc-windows-gnu target first.' >&2
  exit 1
fi
[[ "$("$AW_ZIG_BIN" version)" == 0.17.0 ]] || { echo 'This cross-check is validated with Zig 0.17.0.' >&2; exit 1; }
tools="$PWD/artifacts/windows-cross-tools"
mkdir -p "$tools"
cat > "$tools/cc" <<'PY'
#!/usr/bin/env python3
import os, sys
zig = os.environ['AW_ZIG_BIN']
args = [a for a in sys.argv[1:] if not a.startswith('--target=')]
os.execv(zig, [zig, 'cc', '-target', 'x86_64-windows-gnu', *args])
PY
cat > "$tools/rc" <<'PY'
#!/usr/bin/env python3
import os, sys
zig = os.environ['AW_ZIG_BIN']
if sys.argv[1:] == ['-V', '/?']:
    print('Zig Resource Converter compatibility adapter')
    print('RC-compatible adapter; preprocessing performed by embed-resource')
    sys.exit(0)
args = [a for a in sys.argv[1:] if a != '/no-preprocess']
os.execv(zig, [zig, 'rc', *args])
PY
cat > "$tools/ar" <<'SH'
#!/usr/bin/env bash
exec "$AW_ZIG_BIN" ar "$@"
SH
chmod +x "$tools/cc" "$tools/rc" "$tools/ar"
export CC_x86_64_pc_windows_gnu="$tools/cc"
export RC_x86_64_pc_windows_gnu="$tools/rc"
export AR_x86_64_pc_windows_gnu="$tools/ar"
cargo check --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-gnu --tests --features native-fixtures --locked
CARGO_TARGET_DIR="$PWD/src-tauri/target/windows-platform-check" cargo check --manifest-path tests/windows-platform/Cargo.toml --target x86_64-pc-windows-gnu --tests --locked
