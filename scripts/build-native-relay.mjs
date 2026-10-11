import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,cpSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';

const revision='740e5af33c71225640e0c1c1555c514c2c93ab74';
const archiveDigest='25747823ea4ec852a146cbbe75d805b8df19190ca5b3fb21052d8e1cb75f2f83';
const {values}=parseArgs({options:{archive:{type:'string'},'target-dir':{type:'string'},dev:{type:'boolean'},test:{type:'boolean'},version:{type:'string'}}});
const root=resolve('.state/native-relay-build');const sdk=join(root,'sdk');const build=join(root,'build');
mkdirSync(root,{recursive:true});mkdirSync(build,{recursive:true});
const archive=resolve(values.archive||join(root,'sdk.tar.gz'));
if(!existsSync(archive)){
  const response=await fetch(`https://codeload.github.com/openai/codex/tar.gz/${revision}`);
  if(!response.ok)throw Error(`SDK download failed: HTTP ${response.status}`);
  writeFileSync(archive,Buffer.from(await response.arrayBuffer()));
}
if(createHash('sha256').update(readFileSync(archive)).digest('hex')!==archiveDigest)throw Error('Pinned Codex SDK archive checksum mismatch');
if(!existsSync(join(sdk,'.gateway-revision'))){
  if(existsSync(sdk))throw Error('Refusing an unrecognized SDK checkout');
  mkdirSync(sdk);execFileSync('tar',['-xzf',archive,'--strip-components=1','-C',sdk]);
  writeFileSync(join(sdk,'.gateway-revision'),revision);
}
if(readFileSync(join(sdk,'.gateway-revision'),'utf8')!==revision)throw Error('Codex SDK revision mismatch');
function patch(file,original,replacement){
  const path=join(sdk,file);const text=readFileSync(path,'utf8');
  if(text.includes(replacement))return;
  if(!text.includes(original))throw Error(`SDK source no longer matches: ${file}`);
  writeFileSync(path,text.replace(original,replacement));
}
const transport='codex-rs/app-server-transport/src/';
patch(transport+'outgoing_message.rs','pub enum OutgoingMessage {','pub enum OutgoingMessage {\n    /// Gateway: preserve arbitrary app-server JSON envelopes.\n    Passthrough(serde_json::Value),');
patch(transport+'transport/remote_control/mod.rs','pub struct RemoteControlStartConfig {','pub struct RemoteControlStartConfig {\n    pub server_name: Option<String>,');
patch(transport+'transport/remote_control/controller.rs','let server_name = gethostname().to_string_lossy().trim().to_string();','let server_name = self.config.server_name.clone().unwrap_or_else(|| gethostname().to_string_lossy().trim().to_string());');
patch(transport+'transport/remote_control/controller.rs','server_name: gethostname().to_string_lossy().trim().to_string(),','server_name: config.server_name.clone().unwrap_or_else(|| gethostname().to_string_lossy().trim().to_string()),');
patch(transport+'transport/remote_control/websocket.rs','    info!(\n        "creating new remote control enrollment:', '    if enrollment.is_none() || matches!(selection, RemoteControlEnrollmentSelection::ReplaceExisting) {\n        return Err(io::Error::new(ErrorKind::NotFound, "Gateway requires the existing native machine registration"));\n    }\n    info!(\n        "creating new remote control enrollment:');
const version=values.version||JSON.parse(readFileSync('package.json','utf8')).version;
if(!/^\d+\.\d+\.\d+$/.test(version))throw Error('Invalid relay release version');
writeFileSync(join(build,'Cargo.toml'),readFileSync('native-relay/Cargo.toml.in','utf8').replaceAll('@SDK@',sdk.replaceAll('\\','/')).replace('@VERSION@',version));
cpSync('native-relay/src',join(build,'src'),{recursive:true});
if(!existsSync(join(build,'Cargo.lock')))cpSync(join(sdk,'codex-rs/Cargo.lock'),join(build,'Cargo.lock'));
const target=resolve(values['target-dir']||join(root,'target'));
const args=[values.test?'test':'build',...(values.dev?[]:['--release']),'--manifest-path',join(build,'Cargo.toml'),'--target-dir',target];
execFileSync('cargo',args,{stdio:'inherit',env:{...process.env,CARGO_BUILD_JOBS:'2'}});
if(!values.test){
  const output=join(root,'artifact');mkdirSync(output,{recursive:true});
  cpSync(join(target,values.dev?'debug':'release','gateway-native-relay'),join(output,'gateway-native-relay'));
  if(process.platform==='darwin')execFileSync('strip',['-S',join(output,'gateway-native-relay')]);
  cpSync(join(sdk,'LICENSE'),join(output,'CODEX-LICENSE'));
  cpSync(join(sdk,'NOTICE'),join(output,'CODEX-NOTICE'));
  cpSync('native-relay/NOTICE',join(output,'NOTICE'));
  const metadata=JSON.parse(execFileSync('cargo',['metadata','--format-version','1','--manifest-path',join(build,'Cargo.toml')],{encoding:'utf8',maxBuffer:32*1024*1024}));
  writeFileSync(join(output,'dependencies.json'),JSON.stringify(metadata.packages.map(({name,version,license,repository})=>({name,version,license,repository})),null,2));
  writeFileSync(join(output,'build.json'),JSON.stringify({version,codexVersion:'0.162.0-alpha.17.2',revision,archiveSha256:archiveDigest,profile:values.dev?'dev':'release'},null,2));
  console.log(JSON.stringify({artifact:output,version,revision}));
}
