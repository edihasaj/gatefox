// Verifies each reasoning level end to end on gateway models: the effort Codex sends,
// the delegation tools Ultra exposes, streamed reasoning summaries, and (for Claude on
// this host) the CLI's actual --effort and --thinking-display flags. Isolated native home.
import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {once} from 'node:events';
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {AppServerConnection} from '../dist/app-server-connection.js';
const {values:options}=parseArgs({options:{gateway:{type:'string'},config:{type:'string'},codex:{type:'string'},catalog:{type:'string'},fixture:{type:'string'},output:{type:'string'},cases:{type:'string',default:'claude/claude-opus-5-5:max,claude/claude-opus-5-5:ultra,codex/gpt-6.1-sol:max,codex/gpt-6.1-sol:ultra'}}});
for(const key of ['gateway','config','codex','catalog','fixture','output'])if(!options[key])throw Error(`Missing --${key}`);
const upstream=JSON.parse(await readFile(resolve(options.config),'utf8'));
const root=resolve(options.fixture);const home=join(root,'native'),state=join(root,'state'),work=join(root,'work');
for(const p of [home,state,work])await mkdir(p,{recursive:true,mode:0o700});
await copyFile(resolve(options.catalog),join(home,'models.json'));
await copyFile(resolve(upstream.stateDirectory,'client-token'),join(state,'client-token'));
await writeFile(join(home,'config.toml'),`model_catalog_json = "${join(home,'models.json')}"\n`,{mode:0o600});
const seen=[];
const server=createServer(async(req,res)=>{
 const control=new AbortController();res.on('close',()=>control.abort());
 try{
  const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks);
  if(req.url==='/v1/responses'){const json=JSON.parse(body.toString());const declared=[...(json.tools||[]),...(json.input||[]).filter(i=>i.type==='additional_tools').flatMap(i=>i.tools||[])];seen.push({model:json.model,effort:json.reasoning?.effort,summary:json.reasoning?.summary,context:json.reasoning?.context,lite:(json.input||[]).some(i=>i.type==='additional_tools'),namespaces:declared.filter(t=>t.type==='namespace'||t.tools).map(t=>t.name)});}
  const r=await fetch(`http://127.0.0.1:${upstream.port}`+req.url,{method:req.method,headers:{authorization:req.headers.authorization,'content-type':'application/json',...(req.headers['session-id']?{'session-id':req.headers['session-id']}:{}),...(req.headers['thread-id']?{'thread-id':req.headers['thread-id']}:{})},...(body.length?{body}:{}),signal:control.signal});
  res.writeHead(r.status,{'content-type':r.headers.get('content-type')||'application/json'});
  if(r.body)await pipeline(Readable.fromWeb(r.body),res);else res.end();
 }catch{if(!res.headersSent)res.writeHead(502);res.end();}
});server.listen(0,'127.0.0.1');await once(server,'listening');
const config=join(root,'gateway.json');await writeFile(config,JSON.stringify({version:1,clientOnly:true,port:server.address().port,stateDirectory:state,providers:[]}),{mode:0o600});
const env={...process.env,CODEX_HOME:home};for(const k of ['OPENAI_API_KEY','CODEX_API_KEY','OPENAI_BASE_URL'])delete env[k];
const results=[];const record=async row=>{results.push(row);await writeFile(resolve(options.output),JSON.stringify({results},null,2),{mode:0o600});console.log(JSON.stringify(row));};
const events=[];
const client=new AppServerConnection(resolve(options.gateway),['codex-shim','--config',config,'--codex',resolve(options.codex),'--','app-server','--listen','stdio://'],async m=>{if(m.id!==undefined&&m.method)client.send({id:m.id,result:{decision:'decline'}});else events.push(m);},()=>{},env);
await client.request('initialize',{clientInfo:{name:'gateway_reasoning_e2e',version:'1'},capabilities:{experimentalApi:true}});client.send({method:'initialized',params:{}});
// Claude runs on this host: sample the CLI's own flags while its turn is in flight.
const claudeFlags=()=>{try{return execFileSync('/bin/ps',['-axo','args='],{encoding:'utf8'}).split('\n').filter(l=>/(^|\/)claude /.test(l)&&l.includes('--print')&&l.includes('stream-json')).map(l=>({effort:/--effort (\S+)/.exec(l)?.[1],display:/--thinking-display (\S+)/.exec(l)?.[1],model:/--model (\S+)/.exec(l)?.[1]}));}catch{return [];}};
for(const spec of options.cases.split(',')){
 const [model,effort]=spec.split(':');const offset=events.length,from=seen.length;let flags=[];
 try{
  const start=await client.request('thread/start',{model,cwd:work,approvalPolicy:'never',sandbox:'read-only',config:{model_reasoning_effort:effort}});
  const turn=await client.request('turn/start',{threadId:start.thread.id,input:[{type:'text',text:'Think carefully about which is larger, 9.11 or 9.9, then answer in one short sentence.'}],effort});
  for(const end=Date.now()+900000;Date.now()<end;){
   if(model.startsWith('claude/')&&!flags.length)flags=claudeFlags();
   if(events.slice(offset).find(e=>e.method==='turn/completed'&&e.params?.turn?.id===turn.turn.id))break;await delay(200);
  }
  const completed=events.slice(offset).find(e=>e.method==='turn/completed'&&e.params?.turn?.id===turn.turn.id);
  const summaryChars=events.slice(offset).filter(e=>/reasoning.*(summary|text).*delta/i.test(e.method||'')).map(e=>e.params?.delta||'').join('').length;
  const wire=seen.slice(from);const expected=model.startsWith('claude/')?'max':effort;
  const delegation=wire.some(w=>w.namespaces.includes('collaboration'));
  const passed=completed?.params?.turn?.status==='completed'&&wire.length>0&&(!model.startsWith('claude/')||flags.some(f=>f.effort===expected&&f.display==='summarized'));
  await record({model,effort,passed,turnStatus:completed?.params?.turn?.status,wireEffort:wire[0]?.effort,wireSummary:wire[0]?.summary,wireContext:wire[0]?.context,liteRequest:wire[0]?.lite,collaborationTools:delegation,cliFlags:flags[0]||null,reasoningSummaryChars:summaryChars});
 }catch(e){await record({model,effort,passed:false,error:e.message});}
}
client.stop();server.closeAllConnections();server.close();
if(results.some(r=>!r.passed))process.exitCode=1;
