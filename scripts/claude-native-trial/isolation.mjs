import { isAbsolute, resolve } from 'node:path';

/** Runs before vendor modules in the trial copy only; all native and CLI state stays in its own directory. */
export function isolationPrelude(root) {
  if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root || !/^\/(?:private\/)?tmp\/claude-native-picker\.[A-Za-z0-9]+\/trial$/.test(root)) {
    throw new Error('Native trial state must be inside the task-specific /tmp directory');
  }
  return `;(()=>{const f=require("node:fs"),p=require("node:path"),a=require("electron").app,r=${JSON.stringify(root)};const check=d=>{const s=f.lstatSync(d);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&63)!==0)throw Error("Unsafe trial state directory");};check(p.dirname(r));check(r);for(const n of ["app-data","profile","logs","crashes","cli","workspace"]){const d=p.join(r,n);try{f.mkdirSync(d,{mode:448});}catch(e){if(e.code!=="EEXIST")throw e;}check(d);}a.setPath("appData",p.join(r,"app-data"));a.setPath("userData",p.join(r,"profile"));a.setPath("logs",p.join(r,"logs"));a.setPath("crashDumps",p.join(r,"crashes"));process.env.CLAUDE_CONFIG_DIR=p.join(r,"cli");process.env.CLAUDE_CODE_TMPDIR=r;})();\n`;
}
