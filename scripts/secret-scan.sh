#!/usr/bin/env bash
# Scan the working tree and all non-baselined historical patches. One earlier
# commit exposed a VAPID key that is permanently retired and documented in
# SECURITY.md; skip only that exact commit, never a whole file or directory.
set -euo pipefail

: "${GITLEAKS_BIN:=gitleaks}"
readonly RETIRED_VAPID_COMMIT_PREFIX="1fdff68"

"${GITLEAKS_BIN}" detect \
  --source . \
  --no-git \
  --no-banner \
  --redact \
  --config .gitleaks.toml

commit_count="$(git rev-list --all --count)"
if [[ "${commit_count}" -eq 0 ]]; then
  echo "Secret scan refused: no Git history is available." >&2
  exit 1
fi

while IFS= read -r commit; do
  if [[ "${commit}" == "${RETIRED_VAPID_COMMIT_PREFIX}"* ]]; then
    continue
  fi
  git show --format= --no-ext-diff "${commit}" \
    | sed -n '/^+/ { /^+++/d; s/^+//; p }'
done < <(git rev-list --all) \
  | "${GITLEAKS_BIN}" detect --pipe --no-banner --redact --config .gitleaks.toml
