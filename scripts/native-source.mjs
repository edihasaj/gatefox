import {createHash} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';

export function nativeSourceDigest(){
  const hash=createHash('sha256');const paths=[];
  function walk(directory){for(const entry of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const path=join(directory,entry.name);if(entry.isDirectory())walk(path);else if(entry.isFile())paths.push(path);}}
  walk('native-relay');paths.push('scripts/build-native-relay.mjs','scripts/native-source.mjs','scripts/native-relay-sdk.mjs','scripts/native-relay-sdk-patches.mjs','scripts/native-relay-sdk-lock.mjs');
  for(const path of paths)hash.update(path).update('\0').update(readFileSync(path)).update('\0');
  return hash.digest('hex');
}
