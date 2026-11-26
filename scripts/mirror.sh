#!/usr/bin/env bash
# Push a folder's history to its standalone repository:
#   docs    -> meghjs/meghjs.github.io  (deploys GitHub Pages on push to main)
#   neovim  -> meghjs/megh.nvim         (editors/neovim, installed with lazy.nvim)
#
# The npm packages are no longer mirrored: they are versioned and published
# from this repository with Lerna (see README.md).
#
# Usage:
#   scripts/mirror.sh              mirror docs
#   scripts/mirror.sh docs         same
#   scripts/mirror.sh neovim       mirror the Neovim plugin
#   scripts/mirror.sh docs neovim  both
#
# Pushes are fast-forward only: if the standalone repo has commits the
# monorepo does not, the push is rejected instead of overwriting them.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

prefix_of() {
  case "$1" in
    docs) echo "docs" ;;
    neovim) echo "editors/neovim" ;;
    *) echo "Unknown target '$1' (expected docs or neovim)" >&2; exit 1 ;;
  esac
}

remote_of() {
  case "$1" in
    docs) echo "https://github.com/meghjs/meghjs.github.io.git" ;;
    neovim) echo "https://github.com/meghjs/megh.nvim.git" ;;
  esac
}

# The Neovim plugin ships a bundled language server built from
# editors/vscode/src. Refuse to mirror a committed bundle that is stale.
check_neovim() {
  local bundle="editors/neovim/server/megh-language-server.js"
  echo "==> neovim: checking $bundle is up to date"
  (cd editors/vscode && npm run --silent build:server >/dev/null)
  if ! git diff --quiet -- "$bundle"; then
    git checkout -- "$bundle"
    echo "$bundle is out of date. Run 'npm run build:server' in editors/vscode, commit it, then mirror again." >&2
    exit 1
  fi
}

mirror() {
  local target="$1" prefix remote sha
  prefix="$(prefix_of "$target")"
  remote="$(remote_of "$target")"
  if [ "$target" = neovim ]; then check_neovim; fi
  echo "==> $target: splitting $prefix"
  sha="$(git subtree split -q --prefix="$prefix" HEAD)"
  echo "==> $target: pushing $sha to $remote main"
  git push "$remote" "$sha:refs/heads/main"
}

if [ "$#" -eq 0 ]; then
  set -- docs
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "Note: uncommitted changes are not mirrored; only committed history is pushed." >&2
fi

for target in "$@"; do
  mirror "$target"
done
