import { mkdtemp, mkdir, realpath, writeFile, chmod, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A throwaway state directory, native home, config, and fake signed codex / claude that record argv and CODEX_HOME. Nothing real is touched. */
export async function accountFixture(extra: Record<string, unknown> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gateway-account-")));
  const state = join(root, "state"); const nativeHome = join(root, "native"); const bin = join(root, "bin");
  for (const path of [state, nativeHome, bin]) await mkdir(path, { mode: 0o700 });
  await writeFile(join(nativeHome, "auth.json"), '{"fake_primary_secret":"must-never-be-copied"}', { mode: 0o600 });
  await writeFile(join(nativeHome, "config.toml"), 'model = "native"\n[features]\nmemories = true\n', { mode: 0o600 });
  const configPath = join(root, "config.json"); const log = join(root, "calls.jsonl");
  await writeFile(configPath, JSON.stringify({ version: 1, port: 1, stateDirectory: state, providers: [{ id: "base", type: "claude-subscription", models: { "base/m": "m" } }], ...extra }), { mode: 0o600 });
  const codex = join(bin, "codex"); const emailFile = join(root, "email");
  await writeFile(emailFile, "second@example.test");
  await writeFile(codex, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),{createInterface}=require('node:readline');
const a=process.argv.slice(2),home=process.env.CODEX_HOME;
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({a,home,envKeys:Object.keys(process.env).filter(k=>/^(OPENAI_|CODEX_ACCESS_TOKEN|CODEX_AUTH)/.test(k))})+'\\n');
const i=a.indexOf('login'),auth=path.join(home,'auth.json');
if(i>=0&&a[i+1]==='status'){if(fs.existsSync(auth)){console.log('Logged in using ChatGPT');}else{console.log('Not logged in');}process.exit(0);}
if(i>=0&&a[i+1]==='--device-auth'){fs.writeFileSync(auth,'{"x":1}',{mode:0o600});process.exit(0);}
if(a.includes('logout')){fs.rmSync(auth,{force:true});process.exit(0);}
if(a.includes('app-server')){const out=m=>process.stdout.write(JSON.stringify(m)+'\\n');createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.id===undefined)return;
 if(m.method==='initialize')out({id:m.id,result:{}});else if(m.method==='account/read')out({id:m.id,result:{account:{type:'chatgpt',email:fs.readFileSync(${JSON.stringify(emailFile)},'utf8').trim(),planType:'pro'}}});});}
`, { mode: 0o700 }); await chmod(codex, 0o700);
  const claude = join(bin, "claude"); const claudeEmail = join(root, "claude-email"); const defaultEmail = join(root, "claude-default-email");
  await writeFile(claudeEmail, "work@example.test"); await writeFile(defaultEmail, "main@example.test");
  await writeFile(claude, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const a=process.argv.slice(2),dir=process.env.CLAUDE_CONFIG_DIR;
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({claude:a,dir,hasToken:!!process.env.CLAUDE_CODE_OAUTH_TOKEN})+'\\n');
const marker=dir&&path.join(dir,'logged-in');
if(a[1]==='login'){fs.writeFileSync(marker,'1');process.exit(0);}
if(a[1]==='logout'){if(marker)fs.rmSync(marker,{force:true});process.exit(0);}
if(a[1]==='status'){const on=!dir||process.env.CLAUDE_CODE_OAUTH_TOKEN||fs.existsSync(marker);
 console.log(JSON.stringify(on?{loggedIn:true,email:fs.readFileSync(dir?${JSON.stringify(claudeEmail)}:${JSON.stringify(defaultEmail)},'utf8').trim(),subscriptionType:'max'}:{loggedIn:false}));process.exit(0);}
`, { mode: 0o700 }); await chmod(claude, 0o700);
  return { root, state, nativeHome, configPath, codex, claude, emailFile, claudeEmail, defaultEmail, calls: async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).map(l => JSON.parse(l)) };
}
