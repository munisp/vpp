#!/usr/bin/env bash
set -euo pipefail

# `image-size` remains vendor-unpatched in the Metro dependency graph. Metro's
# current asset allowlist does not include these formats, but reject them here so
# a future transformer or asset-extension change cannot silently expose a CI or
# developer build process to their malformed parser paths.
blocked="$(git ls-files 'mobile/**' | grep -Ei '\.(icns|jxl|heif|heic)$' || true)"
if [[ -n "$blocked" ]]; then
  printf '%s\n' 'Unsupported high-risk mobile asset extension(s):' >&2
  printf '%s\n' "$blocked" >&2
  exit 1
fi
