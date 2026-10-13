#!/bin/sh
set -eu
umask 077
prefix="${GATEWAY_INSTALL_PREFIX:-$HOME/.local}"
legacy_command=$(command -v gateway || true)
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix) prefix="$2"; shift 2 ;;
    --help|-h) echo 'Usage: ./install [--prefix DIR]'; exit 0 ;;
    *) echo "Unknown installer option: $1" >&2; exit 2 ;;
  esac
done
case "$prefix" in /*) ;; *) echo 'Installation prefix must be absolute' >&2; exit 2 ;; esac
source_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
cd "$source_dir"
test "$(uname -s)" = Darwin && test "$(uname -m)" = arm64 || { echo 'This installer requires an Apple Silicon Mac.' >&2; exit 2; }
shasum -a 256 -c checksums.txt >/dev/null
version=$(./runtime/bin/node -p 'JSON.parse(require("fs").readFileSync("package/package.json","utf8")).version')
root="$prefix/share/subscription-gateway"
release="$root/releases/$version"
mkdir -p "$root/releases" "$prefix/bin"
if [ -e "$root/.gateway-installation" ]; then
  test "$(cat "$root/.gateway-installation")" = subscription-gateway || { echo 'Installation root is unmanaged.' >&2; exit 2; }
fi
if [ -e "$release" ]; then
  test -f "$release/.gateway-release" || { echo 'Release path is occupied by an unmanaged directory.' >&2; exit 2; }
  (cd "$release" && shasum -a 256 -c checksums.txt >/dev/null)
  cmp "$source_dir/checksums.txt" "$release/checksums.txt" >/dev/null || { echo 'This version is already installed with different contents.' >&2; exit 2; }
else
  stage="$root/releases/.install-$version-$$"
  mkdir "$stage"
  cp -R package runtime "$stage/"
  cp checksums.txt install "$stage/"
  printf '%s\n' "$version" > "$stage/.gateway-release"
  (cd "$stage" && shasum -a 256 -c checksums.txt >/dev/null)
  "$stage/runtime/bin/node" "$stage/package/dist/cli.js" --version >/dev/null
  mv "$stage" "$release"
fi
if [ -e "$root/current" ] || [ -L "$root/current" ]; then
  test -L "$root/current" || { echo 'Current release path is not a managed link.' >&2; exit 2; }
  readlink "$root/current" > "$root/previous-release"
fi
launcher="$prefix/bin/gateway"
if [ -e "$launcher" ] || [ -L "$launcher" ]; then
  test -f "$launcher" && grep -q '^# Managed by subscription-gateway installer$' "$launcher" || { echo 'gateway command is occupied by another installation.' >&2; exit 2; }
fi
./runtime/bin/node --input-type=module - "$root" "$launcher.new" <<'JS'
import {writeFileSync} from 'node:fs';
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
const root=process.argv[2];
writeFileSync(process.argv[3],'#!/bin/sh\n# Managed by subscription-gateway installer\nGATEWAY_COMMAND='+quote(process.argv[3].slice(0,-4))+' GATEWAY_INSTALLED=1 exec '+quote(root+'/current/runtime/bin/node')+' '+quote(root+'/current/package/dist/cli.js')+' "$@"\n');
JS
chmod 700 "$launcher.new"
ln -s "releases/$version" "$root/current.new-$$"
./runtime/bin/node -e 'require("fs").renameSync(process.argv[1],process.argv[2])' "$root/current.new-$$" "$root/current"
mv "$launcher.new" "$launcher"
# The product name as a second command; existing services keep using gateway.
alias_command="$prefix/bin/harness-gateway"
if [ ! -e "$alias_command" ] && [ ! -L "$alias_command" ]; then ln -s gateway "$alias_command"; fi
printf 'subscription-gateway\n' > "$root/.gateway-installation"
if [ "$prefix" = "$HOME/.local" ] && [ -n "$legacy_command" ] && [ "$legacy_command" != "$launcher" ] && [ -L "$legacy_command" ]; then
  if ./runtime/bin/node - "$legacy_command" <<'JS'
const fs=require('fs'),path=require('path');
try { const target=fs.realpathSync(process.argv[2]);const p=JSON.parse(fs.readFileSync(path.resolve(path.dirname(target),'../package.json'),'utf8'));process.exit(path.basename(target)==='cli.js'&&['@edihasaj/harness-gateway','@edihasaj/subscription-gateway'].includes(p.name)?0:1); } catch { process.exit(1); }
JS
  then
    mkdir -p "$HOME/.Trash"
    mv "$legacy_command" "$HOME/.Trash/gateway-legacy-link-$(date +%s)"
    ln -s "$launcher" "$legacy_command"
  fi
fi
# Keep the current release, the previous one and the newest other one. Older
# releases move to the Trash unless a running process still maps their files.
keep_current=$(readlink "$root/current" | sed 's#^releases/##')
keep_previous=$(sed 's#^releases/##' "$root/previous-release" 2>/dev/null || true)
in_use=$(/usr/sbin/lsof -nP -Fn 2>/dev/null | grep -o "$root/releases/[^/]*/" | sort -u || true)
kept_extra=0; pruned=0
if [ -d "$HOME/.Trash" ]; then
  for name in $(ls -1 "$root/releases" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -t. -k1,1nr -k2,2nr -k3,3nr); do
    [ "$name" = "$keep_current" ] || [ "$name" = "$keep_previous" ] && continue
    if [ "$kept_extra" -eq 0 ]; then kept_extra=1; continue; fi
    case "$in_use" in *"$root/releases/$name/"*) continue ;; esac
    [ -f "$root/releases/$name/.gateway-release" ] || continue
    mv "$root/releases/$name" "$HOME/.Trash/subscription-gateway-$name-$(date +%s)" && pruned=$((pruned + 1))
  done
fi
[ "$pruned" -eq 0 ] || echo "Moved $pruned older releases to the Trash."
echo "Installed gateway $version. Run gateway setup, gateway service install, or gateway desktop."
echo "Command: $launcher"
