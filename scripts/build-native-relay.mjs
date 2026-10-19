import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,cpSync,existsSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {nativeSourceDigest} from './native-source.mjs';
import {checkSdkTestOutput,materializeSdk,sdkArchiveSha256 as archiveDigest,sdkBuildKey,sdkCodexVersion,sdkRevision as revision,sdkTestArguments} from './native-relay-sdk.mjs';
import {withPrivateFileLock} from '../dist/private-file-lock.js';
import {withCargoTargetLocks} from './cargo-target-lock.mjs';
import {assertFreeSpaceForPaths,releaseDiskSpaceRequirements} from './disk-space.mjs';

const {values}=parseArgs({options:{archive:{type:'string'},'target-dir':{type:'string'},dev:{type:'boolean'},test:{type:'boolean'},version:{type:'string'}}});
// Sources, pristine copies and the crate manifest are kept per pinned revision. The gateway SDK build reads its own pinned
// archive from `sdk.tar.gz` here, so the relay never replaces those bytes; the target folders are shared, as cargo keys them by path.
const root=resolve('.state/native-relay-build');const sdk=join(root,`sdk-${sdkBuildKey}`);const build=join(root,`build-${sdkBuildKey}`);
const target=resolve(values['target-dir']||join(root,'target'));
const sdkTarget=values['target-dir']?`${target}-sdk`:join(root,'sdk-target');
mkdirSync(root,{recursive:true});mkdirSync(build,{recursive:true});
mkdirSync(dirname(target),{recursive:true});if(values.test)mkdirSync(dirname(sdkTarget),{recursive:true});
await withPrivateFileLock(join(root,'build'),async()=>{
await withCargoTargetLocks(values.test?[target,sdkTarget]:[target],async()=>{
assertFreeSpaceForPaths(values.test?[root,target,sdkTarget]:[root,target],releaseDiskSpaceRequirements.nativeRelay,'Native relay build');
const archive=resolve(values.archive||join(root,`sdk-${sdkBuildKey}.tar.gz`));
if(!existsSync(archive)){
  // The pinned bytes use GitHub's API tarball format (including its root name).
  const response=await fetch(`https://api.github.com/repos/openai/codex/tarball/${revision}`);
  if(!response.ok)throw Error(`SDK download failed: HTTP ${response.status}`);
  writeFileSync(archive,Buffer.from(await response.arrayBuffer()));
}
if(createHash('sha256').update(readFileSync(archive)).digest('hex')!==archiveDigest)throw Error('Pinned Codex SDK archive checksum mismatch');
materializeSdk({archive,sdk,root});
const version=values.version||JSON.parse(readFileSync('package.json','utf8')).version;
if(!/^\d+\.\d+\.\d+$/.test(version))throw Error('Invalid relay release version');
writeFileSync(join(build,'Cargo.toml'),readFileSync('native-relay/Cargo.toml.in','utf8').replaceAll('@SDK@',sdk.replaceAll('\\','/')).replace('@VERSION@',version));
cpSync('native-relay/src',join(build,'src'),{recursive:true});
if(!existsSync(join(build,'Cargo.lock')))cpSync(join(sdk,'codex-rs/Cargo.lock'),join(build,'Cargo.lock'));
const cargoEnvironment={...process.env,CARGO_BUILD_JOBS:'2'};
const args=[values.test?'test':'build',...(values.dev?[]:['--release']),'--manifest-path',join(build,'Cargo.toml'),'--target-dir',target];
execFileSync('cargo',args,{stdio:'inherit',env:cargoEnvironment});
if(values.test){
  // The SDK workspace resolves its own features and lockfile, so it keeps a separate target directory.
  let output;
  try{
    output=execFileSync('cargo',sdkTestArguments({sdk,target:sdkTarget,dev:values.dev}),{cwd:join(sdk,'codex-rs'),env:cargoEnvironment,encoding:'utf8',stdio:['ignore','pipe','inherit'],maxBuffer:64*1024*1024});
  }catch(error){process.stdout.write(error.stdout||'');throw error;}
  process.stdout.write(output);
  console.log(JSON.stringify({sdkTests:checkSdkTestOutput(output),revision}));
}
if(!values.test){
  const output=join(root,'artifact');mkdirSync(output,{recursive:true});
  cpSync(join(target,values.dev?'debug':'release','gateway-native-relay'),join(output,'gateway-native-relay'));
  if(process.platform==='darwin')execFileSync('strip',['-S',join(output,'gateway-native-relay')]);
  cpSync(join(sdk,'LICENSE'),join(output,'CODEX-LICENSE'));
  cpSync(join(sdk,'NOTICE'),join(output,'CODEX-NOTICE'));
  cpSync('native-relay/NOTICE',join(output,'NOTICE'));
  const metadata=JSON.parse(execFileSync('cargo',['metadata','--format-version','1','--manifest-path',join(build,'Cargo.toml')],{encoding:'utf8',maxBuffer:32*1024*1024}));
  writeFileSync(join(output,'dependencies.json'),JSON.stringify(metadata.packages.map(({name,version,license,repository})=>({name,version,license,repository})),null,2));
  writeFileSync(join(output,'build.json'),JSON.stringify({version,codexVersion:sdkCodexVersion,revision,archiveSha256:archiveDigest,profile:values.dev?'dev':'release',sourceSha256:nativeSourceDigest()},null,2));
  console.log(JSON.stringify({artifact:output,version,revision}));
}
});
},3_600_000);
