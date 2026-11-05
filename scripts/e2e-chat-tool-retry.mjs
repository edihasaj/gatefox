#!/usr/bin/env node
// Proves a real Codex client retries a garbled Chat Completions tool call. Usage:
// E2E_ROOT=/tmp/task node scripts/e2e-chat-tool-retry.mjs LABEL GATEWAY_COMMAND [ARGUMENTS]
// A local mock provider streams reasoning and text, then a broken tool name, then a valid call.
// It uses private homes and no provider credit. Passing needs exit 0, proofWritten true and no leaks.
import http from "node:http"; import fs from "node:fs"; import path from "node:path"; import {spawn,spawnSync} from "node:child_process"; import {randomUUID} from "node:crypto";
const [,,label,...gw]=process.argv; const root=fs.mkdtempSync(path.join(process.env.E2E_ROOT,label+"-"));
const work=path.join(root,"work"),home=path.join(root,"codex"),state=path.join(root,"state");[work,home,state].forEach(d=>fs.mkdirSync(d,{recursive:true}));
const proof=path.join(work,"proof.txt"),value=randomUUID(); const seen=[];
const sse=(res,rows)=>{res.writeHead(200,{"Content-Type":"text/event-stream"});for(const r of rows)res.write(`data: ${JSON.stringify(r)}\n\n`);res.end("data: [DONE]\n\n")};
const M="fixture-model"; const usage={choices:[],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}};
const tool=(name,args)=>[{model:M,choices:[{index:0,delta:{tool_calls:[{index:0,id:"call_"+randomUUID().slice(0,8),function:{name,arguments:args}}]},finish_reason:null}]},{model:M,choices:[{index:0,delta:{},finish_reason:"tool_calls"}]},usage];
const text=t=>[{model:M,choices:[{index:0,delta:{content:t},finish_reason:null}]},{model:M,choices:[{index:0,delta:{},finish_reason:"stop"}]},usage];
const mock=http.createServer((req,res)=>{let b="";req.on("data",c=>b+=c);req.on("end",()=>{
 if(!req.url.endsWith("/chat/completions")){res.writeHead(200,{"Content-Type":"application/json"});res.end('{"object":"list","data":[{"id":"fixture-model"}]}');return}
 const body=JSON.parse(b);const n=seen.push({tools:(body.tools||[]).length});
 const idx=(body.tools||[]).findIndex(t=>t.function.parameters?.properties?.cmd);
 if(!body.tools?.length)return sse(res,text("ok"));
 const toolMsgs=body.messages.filter(m=>m.role==="tool").length;
 if(toolMsgs)return sse(res,text("E2E_DONE"));
 if(seen.filter(x=>x.tools).length===1)return sse(res,[{model:M,choices:[{index:0,delta:{reasoning_content:"PARTIAL_REASONING "},finish_reason:null}]},{model:M,choices:[{index:0,delta:{content:"PARTIAL_TEXT "},finish_reason:null}]},...tool("tool=\n","{}")]);
 seen[seen.length-1].leaked=/PARTIAL_TEXT|PARTIAL_REASONING/.test(JSON.stringify(body.messages));
 return sse(res,tool(body.tools[idx].function.name,JSON.stringify({cmd:`/usr/bin/printf %s ${value} > ${proof}`,yield_time_ms:1000})));
})});
await new Promise(r=>mock.listen(0,"127.0.0.1",r)); const mp=mock.address().port;
const port=40000+Math.floor(Math.random()*9000); const key="E2E_FIXTURE_KEY";
const cfg=path.join(root,"gateway.json");
fs.writeFileSync(cfg,JSON.stringify({version:1,port,stateDirectory:state,providers:[{id:"qwen",type:"chat-completions-api",label:"Fixture",baseUrl:`http://127.0.0.1:${mp}/v1`,apiKeyEnv:key,models:{"qwen/flash":M},modelMetadata:{"qwen/flash":{reasoningEfforts:["low","medium","high"]}}}]},null,1));
const env={...process.env,[key]:"fixture-only",TMPDIR:root,GATEWAY_CONFIG:cfg};
const serve=spawn(gw[0],[...gw.slice(1),"serve","--config",cfg,"--port",String(port)],{env,stdio:["ignore","pipe","pipe"]});let log="";serve.stdout.on("data",d=>log+=d);serve.stderr.on("data",d=>log+=d);
let up=false;for(let i=0;i<60&&!up;i++){await new Promise(r=>setTimeout(r,250));try{const r=await fetch(`http://127.0.0.1:${port}/health`);up=r.status<500}catch{}}
if(!up){console.log("GATEWAY LOG:",log.slice(0,600));}
const tf=path.join(state,"client-token");
const token=fs.existsSync(tf)?fs.readFileSync(tf,"utf8").trim():spawnSync(gw[0],[...gw.slice(1),"token","--config",cfg],{env,encoding:"utf8"}).stdout.trim();
fs.writeFileSync(path.join(home,"config.toml"),['model = "qwen/flash"','model_provider = "gw"','model_reasoning_effort = "medium"','web_search = "disabled"','[model_providers.gw]','name = "Fixture"',`base_url = "http://127.0.0.1:${port}/v1"`,'wire_api = "responses"','env_key = "E2E_CLIENT_KEY"','supports_websockets = false','stream_max_retries = 5','request_max_retries = 1'].join("\n")+"\n");
spawnSync("git",["init","--quiet",work]);
const started=Date.now();
const ex=await new Promise(done=>{const c=spawn("codex",["exec","--skip-git-repo-check","--sandbox","danger-full-access","-C",work,"Create the proof with the shell tool."],{env:{...env,CODEX_HOME:home,E2E_CLIENT_KEY:token},stdio:["ignore","pipe","pipe"]});let o="",e="";c.stdout.on("data",d=>o+=d);c.stderr.on("data",d=>e+=d);const t=setTimeout(()=>c.kill("SIGKILL"),100000);c.on("close",status=>{clearTimeout(t);done({status,stdout:o,stderr:e})})});
const ok=fs.existsSync(proof)&&fs.readFileSync(proof,"utf8")===value;
const tail=(ex.stdout+ex.stderr).split("\n").filter(l=>/malformed|unknown tool|E2E_DONE|Reconnecting|retry|error/i.test(l)).slice(-6).map(l=>l.slice(0,160));
const hist=[];for(const[d,,fs_]of (function*w(p){const e=fs.readdirSync(p,{withFileTypes:true});yield[p,0,e.filter(x=>x.isFile()).map(x=>x.name)];for(const x of e)if(x.isDirectory())yield*w(path.join(p,x.name))})(path.join(home,"sessions")))for(const f of fs_)if(f.endsWith(".jsonl"))hist.push(fs.readFileSync(path.join(d,f),"utf8"));
const rollout=hist.join("\n");const partialInSavedItems=rollout.split("\n").filter(l=>l.includes("PARTIAL_TEXT")&&l.includes('"response_item"')).length;
console.log(JSON.stringify({leakedIntoRetriedRequests:seen.filter(x=>x.leaked).length,partialInSavedItems,stdoutPartialCount:(ex.stdout.match(/PARTIAL_TEXT/g)||[]).length,label,up,exit:ex.status,proofWritten:ok,providerRequests:seen.filter(x=>x.tools).length,sec:Math.round((Date.now()-started)/1000),finalText:/E2E_DONE/.test(ex.stdout),tail},null,1));
serve.kill("SIGTERM");mock.close();process.exit(0);
