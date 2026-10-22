#!/bin/sh
set -eu
umask 077
prefix="${GATEWAY_INSTALL_PREFIX:-$HOME/.local}"
transaction_nonce=""
legacy_command=$(command -v gateway || true)
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix) prefix="$2"; shift 2 ;;
    --update-transaction) transaction_nonce="$2"; shift 2 ;;
    --help|-h) echo 'Usage: ./install [--prefix DIR]'; exit 0 ;;
    *) echo "Unknown installer option: $1" >&2; exit 2 ;;
  esac
done
case "$prefix" in /*) ;; *) echo 'Installation prefix must be absolute' >&2; exit 2 ;; esac
if [ -n "$transaction_nonce" ]; then
  case "$transaction_nonce" in
    [0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]-????-????-????-????????????) ;;
    *) echo 'Invalid update transaction.' >&2; exit 2 ;;
  esac
fi
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
installation_lock="$root/.gateway-installation-lock"
if ! mkdir "$installation_lock" 2>/dev/null; then
  echo 'Gateway installation is busy; retry.' >&2
  exit 75
fi
release_installation_lock() { rmdir "$installation_lock" 2>/dev/null || true; }
trap 'status=$?; release_installation_lock; exit "$status"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
if [ -n "$transaction_nonce" ]; then
  ./runtime/bin/node --input-type=module - "$root" "$prefix" "$version" "$transaction_nonce" <<'JS'
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
const [root,prefix,version,nonce]=process.argv.slice(2);
try {
  if(resolve(root)!==root||resolve(prefix)!==prefix||resolve(root)!==resolve(prefix,"share","subscription-gateway"))throw Error();
  const file=openSync(join(root,"app-update-transaction.json"),constants.O_RDONLY|constants.O_NOFOLLOW), info=fstatSync(file);
  try {
    const value=JSON.parse(readFileSync(file,"utf8"));
    if(!info.isFile()||info.uid!==process.getuid()||(info.mode&0o077)||info.nlink!==1||value?.schema!==1||value.root!==root||value.prefix!==prefix||value.version!==version||value.nonce!==nonce||value.phase!=="installing")throw Error();
    const same=(path,saved)=>{ let stat;try{stat=lstatSync(path)}catch(error){return error?.code==="ENOENT"&&saved?.kind==="none"}; if(!saved||saved.kind==="none")return false;
      const bytes=stat.isSymbolicLink()?Buffer.from(readlinkSync(path)):stat.isFile()?readFileSync(path):null;if(!bytes)return false;
      const receipt=saved.receipt;return receipt&&receipt.dev===stat.dev&&receipt.ino===stat.ino&&receipt.mode===(stat.mode&0o777)&&receipt.size===stat.size&&receipt.digest===createHash("sha256").update(bytes).digest("hex"); };
    const selected=readlinkSync(join(root,"current")), match=/^releases\/(0|[1-9]\d*)\.(0|[1-9]\d*)\.([0-9])$/.exec(selected);
    const numbers=value=>value.split(".").map(Number), [selectedMajor,selectedMinor,selectedPatch]=match?numbers(match.slice(1).join(".")):[], [nextMajor,nextMinor,nextPatch]=numbers(version);
    if(!match||selectedMajor>nextMajor||selectedMajor===nextMajor&&(selectedMinor>nextMinor||selectedMinor===nextMinor&&selectedPatch>nextPatch))throw Error();
    if(!same(join(root,"current"),value.before?.current)||!same(join(root,"previous-release"),value.before?.previous)||
      !same(join(prefix,"bin","gateway"),value.before?.wrappers?.gateway)||!same(join(prefix,"bin","harness-gateway"),value.before?.wrappers?.["harness-gateway"])||
      !same(join(prefix,"bin","subscription-gateway"),value.before?.wrappers?.["subscription-gateway"]))throw Error();
  }
  finally { closeSync(file); }
} catch { process.exit(2); }
JS
fi
transaction_receipt() {
  [ -z "$transaction_nonce" ] && return 0
  ./runtime/bin/node --input-type=module - "$root" "$prefix" "$version" "$transaction_nonce" "$1" "$2" <<'JS'
import { constants, closeSync, fsyncSync, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, renameSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
const [root,prefix,version,nonce,key,path]=process.argv.slice(2);
const fail=()=>process.exit(2), journal=join(root,"app-update-transaction.json");
const expected={current:/^current\.new-[0-9]+$/,previous:/^previous-release\.new-[0-9]+$/,gateway:/^gateway\.new$/, "harness-gateway":/^harness-gateway\.new$/};
if (!expected[key] || resolve(root)!==root || resolve(prefix)!==prefix || resolve(root)!==resolve(prefix,"share","subscription-gateway")) fail();
const parent=key==="current"||key==="previous"?root:join(prefix,"bin");
if (dirname(path)!==parent || !expected[key].test(path.slice(parent.length+1))) fail();
let descriptor; try { descriptor=openSync(journal,constants.O_RDONLY|constants.O_NOFOLLOW); const info=fstatSync(descriptor);
  if(!info.isFile()||info.uid!==process.getuid()||(info.mode&0o077)||info.nlink!==1||info.size>512*1024)fail();
  const value=JSON.parse(readFileSync(descriptor,"utf8"));
  if(value?.schema!==1||value.root!==root||value.prefix!==prefix||value.version!==version||value.nonce!==nonce||value.phase!=="installing")fail();
  const stat=lstatSync(path); let digest;
  if(stat.isSymbolicLink())digest=createHash("sha256").update(readlinkSync(path)).digest("hex");
  else if(stat.isFile())digest=createHash("sha256").update(readFileSync(path)).digest("hex"); else fail();
  value.installer??={outputs:{}}; value.installer.outputs[key]={dev:stat.dev,ino:stat.ino,mode:stat.mode&0o777,size:stat.size,digest};
  const temporary=join(root,`.${randomUUID()}.app-update-transaction`);
  writeFileSync(temporary,JSON.stringify(value),{flag:"wx",mode:0o600}); const output=openSync(temporary,constants.O_RDONLY); fsyncSync(output); closeSync(output);
  renameSync(temporary,journal); const directory=openSync(root,constants.O_RDONLY); fsyncSync(directory); closeSync(directory);
} catch { fail(); } finally { if(descriptor!==undefined)closeSync(descriptor); }
JS
}
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
# macOS scans a new large executable the first time it runs, which can make the service's first host start time out.
# Run it once now, before current switches. A failure or a stuck run never stops the install.
prewarm="$release/package/gateway-sdk/gateway-codex"
if [ -f "$prewarm" ]; then
  ./runtime/bin/node -e 'const r=require("child_process").spawnSync(process.argv[1],["--version"],{stdio:"ignore",timeout:60000,killSignal:"SIGKILL"});if(r.error||r.status!==0)console.error("Warning: gateway-codex did not pre-warm; its first start may be slow.")' "$prewarm" || true
fi
if [ -e "$root/current" ] || [ -L "$root/current" ]; then
  test -L "$root/current" || { echo 'Current release path is not a managed link.' >&2; exit 2; }
  # Installing the same version again must not turn previous-release into the current one, so it keeps the last different release.
  current_target=$(readlink "$root/current")
  if [ "$current_target" != "releases/$version" ]; then
    previous_new="$root/previous-release.new-$$"
    ./runtime/bin/node - "$previous_new" "$current_target" <<'JS'
const fs=require("fs");fs.writeFileSync(process.argv[2],process.argv[3]+"\n",{flag:"wx",mode:0o600});
JS
    transaction_receipt previous "$previous_new"
    ./runtime/bin/node - "$previous_new" "$root/previous-release" <<'JS'
const fs=require("fs");fs.renameSync(process.argv[2],process.argv[3]);
JS
  fi
fi
# harness-gateway is the managed launcher, because macOS names a background item after the executable a LaunchAgent runs.
# gateway stays a second managed launcher with the same contents, so the older command and old LaunchAgents keep working.
launcher="$prefix/bin/harness-gateway"
compat="$prefix/bin/gateway"
managed='^# Managed by subscription-gateway installer$'
if [ -L "$launcher" ]; then
  # Only the installer's own link to its gateway launcher is replaced.
  test "$(readlink "$launcher")" = gateway && [ -f "$compat" ] && [ ! -L "$compat" ] && grep -q "$managed" "$compat" || { echo 'harness-gateway command is occupied by another installation.' >&2; exit 2; }
elif [ -e "$launcher" ]; then
  test -f "$launcher" && grep -q "$managed" "$launcher" || { echo 'harness-gateway command is occupied by another installation.' >&2; exit 2; }
fi
if [ -e "$compat" ] || [ -L "$compat" ]; then
  test -f "$compat" && grep -q "$managed" "$compat" || { echo 'gateway command is occupied by another installation.' >&2; exit 2; }
fi
# Staging names are exclusive. A leftover file or link is evidence of another publisher and is never removed here.
./runtime/bin/node --input-type=module - "$root" "$launcher" "$launcher.new" "$compat.new" <<'JS'
import {writeFileSync} from 'node:fs';
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
const [root,launcher,...files]=process.argv.slice(2);
const appRuntime=root+'/app-runtime';
const text='#!/bin/sh\n# Managed by subscription-gateway installer\n# App runtime is registered by Harness Gateway.\nruntime='+quote(root+'/current/runtime/bin/node')+'\nif [ -L '+quote(appRuntime)+' ] || [ -e '+quote(appRuntime)+' ]; then\n runtime='+quote(appRuntime+'/bin/node')+'\n [ -x "$runtime" ] || { echo \'Harness Gateway app runtime is unavailable.\' >&2; exit 78; }\n PATH='+quote(appRuntime+'/bin')+':"${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"\n export PATH\nfi\nGATEWAY_COMMAND='+quote(launcher)+' GATEWAY_INSTALLED=1 exec "$runtime" '+quote(root+'/current/package/dist/cli.js')+' "$@"\n';
for(const file of files)writeFileSync(file,text,{flag:'wx'});
JS
chmod 700 "$launcher.new" "$compat.new"
ln -s "releases/$version" "$root/current.new-$$"
transaction_receipt current "$root/current.new-$$"
transaction_receipt harness-gateway "$launcher.new"
transaction_receipt gateway "$compat.new"
./runtime/bin/node -e 'require("fs").renameSync(process.argv[1],process.argv[2])' "$root/current.new-$$" "$root/current"
mv "$launcher.new" "$launcher"
mv "$compat.new" "$compat"
printf 'subscription-gateway\n' > "$root/.gateway-installation"
if [ -z "$transaction_nonce" ] && [ "$prefix" = "$HOME/.local" ] && [ -n "$legacy_command" ] && [ "$legacy_command" != "$launcher" ] && [ "$legacy_command" != "$compat" ] && [ -L "$legacy_command" ]; then
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
# releases are deleted only after a complete local inspection: every published
# release can be downloaded again, so moving them to the Trash only filled it.
# A current launcher can run old JavaScript under an app-owned Node, so a process
# without the immutable marker is a legacy holder and makes this whole cleanup a no-op.
keep_current=$(readlink "$root/current" | sed 's#^releases/##')
keep_previous=$(sed 's#^releases/##' "$root/previous-release" 2>/dev/null || true)
in_use=""
prune_safe=0
if in_use=$(./runtime/bin/node --input-type=module - "$root" <<'JS'
import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const root=process.argv[2], releases=`${root}/releases/`, current=`${root}/current/package/dist/cli.js`;
const options={encoding:"utf8",stdio:["ignore","pipe","ignore"],timeout:10000,maxBuffer:16*1024*1024};
const lsof=spawnSync("/usr/sbin/lsof",["-nP","-u",String(process.getuid()),"-Fpn"],options);
const processes=spawnSync("/bin/ps",["-x","-o","pid=","-o","command="],options);
if(lsof.error||lsof.status!==0||processes.error||processes.status!==0)process.exit(1);
const mapped=new Map(); let pid;
for(const line of lsof.stdout.split("\n")) {
  if(line.startsWith("p")) { pid=line.slice(1); mapped.set(pid,[]); }
  else if(line.startsWith("n")&&pid) mapped.get(pid).push(line.slice(1));
}
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
const immutable=new RegExp(`${escape(releases)}([^/]+)/package/dist/cli\\.js(?:\\s|$)`);
const marker=path=>new RegExp(`^${escape(releases)}([^/]+)/\\.gateway-release$`).exec(path)?.[1];
const entrypoint=path=>new RegExp(`^${escape(releases)}([^/]+)/package/dist/cli\\.js$`).exec(path)?.[1];
const names=new Set();
for(const line of processes.stdout.split("\n")) {
  const match=/^\s*(\d+)\s+(.*)$/.exec(line);
  if(!match)continue;
  const paths=mapped.get(match[1])||[];
  const held=new Set(paths.map(marker).filter(Boolean));
  const bootstrapped=new Set(paths.map(entrypoint).filter(Boolean));
  for(const path of paths) { const name=marker(path)??entrypoint(path); if(name) names.add(name); }
  const legacy=immutable.exec(match[2])?.[1];
  if(legacy&&!held.has(legacy))names.add(legacy);
  // `current` does not identify the source release after it moves. A runtime
  // marker from a newer hot swap is insufficient; only the immutable CLI file
  // descriptor acquired at process startup proves which release bootstrapped it.
  if(match[2].includes(current) && !bootstrapped.size)process.exit(1);
}
for(const paths of mapped.values())for(const path of paths) {
  if(!path.startsWith(releases))continue;
  const match=new RegExp(`^${escape(releases)}([^/]+)/`).exec(path);
  if(match)names.add(match[1]);
}
const launchAgents=join(process.env.HOME||"", "Library", "LaunchAgents");
try {
  for(const file of readdirSync(launchAgents)) {
    if(!/^com\.edihasaj\.subscription-gateway.*\.plist$/.test(file))continue;
    const path=join(launchAgents,file), info=lstatSync(path);
    if(!info.isFile()||info.isSymbolicLink()||info.size>1024*1024)process.exit(1);
    for(const match of readFileSync(path,"utf8").matchAll(new RegExp(`${escape(releases)}([^/]+)/`,"g")))names.add(match[1]);
  }
} catch(error) {
  if(error?.code!=="ENOENT")process.exit(1);
}
process.stdout.write([...names].sort().join("\n"));
JS
); then
  prune_safe=1
fi
kept_extra=0; pruned=0
# A deletion interrupted earlier leaves only a `.retired-*` folder, never a half-deleted release under its own name.
for leftover in "$root"/releases/.retired-*; do [ -d "$leftover" ] && /bin/rm -rf "$leftover"; done
if [ -z "$transaction_nonce" ] && [ "$prune_safe" -eq 1 ]; then
  for name in $(ls -1 "$root/releases" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -t. -k1,1nr -k2,2nr -k3,3nr); do
    [ "$name" = "$keep_current" ] || [ "$name" = "$keep_previous" ] && continue
    if [ "$kept_extra" -eq 0 ]; then kept_extra=1; continue; fi
    if printf '%s\n' "$in_use" | /usr/bin/grep -Fx "$name" >/dev/null; then continue; fi
    [ -f "$root/releases/$name/.gateway-release" ] || continue
    retired="$root/releases/.retired-$name-$$"
    mv "$root/releases/$name" "$retired" && /bin/rm -rf "$retired" && pruned=$((pruned + 1))
  done
fi
[ "$pruned" -eq 0 ] || echo "Deleted $pruned older releases."
echo "Installed gateway $version. Run gateway setup, gateway service install, or gateway desktop."
echo "Command: $launcher (gateway is the same command)"
