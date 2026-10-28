#!/usr/bin/env bash
_agent_workspace_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -d "$_agent_workspace_root/.tools/rustup/toolchains" ]]; then
  export CARGO_HOME="$_agent_workspace_root/.tools/cargo"
  export RUSTUP_HOME="$_agent_workspace_root/.tools/rustup"
  export PATH="$CARGO_HOME/bin:$PATH"
fi
if [[ -d "$_agent_workspace_root/.tools/node/bin" ]]; then
  export PATH="$_agent_workspace_root/.tools/node/bin:$PATH"
fi
if [[ "$(uname -s)" == Darwin ]]; then export MACOSX_DEPLOYMENT_TARGET=13.0; fi
unset _agent_workspace_root
