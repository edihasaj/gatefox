import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readAsarFile } from '../claude-native-trial/asar.mjs';
import { patchUnreadRenderer, patchPinnedUnreadRenderer, supportedUnreadTrial } from '../codex-unread-trial/patch.mjs';

const bridge = 'export function installReadStateBridge(options){globalThis.testBridgeCalls.push(options);return{observe(message){globalThis.testObserved.push(message)},mark(id,unread){globalThis.testMarks.push([id,unread])},dispose(){}}}';
const fixture = `class Manager {
  cleanup=[];
  readState={values:new Map(),has(id){return this.values.get(id)},set(id,unread){this.values.set(id,unread)},isReady(){return true},subscribe(){return ()=>{}}};
  threadStore={params:{requestClient:{sendRequest(){}}}};
  constructor(){this.constructed=true;}
  saveReadState(){}
  setConversationUnreadState(id,unread){this.readState.set(id,unread)}
  getThreadHasUnreadTurn(){}
  applySavedConversationReadState(id,unread){this.applied=[id,unread]}
  markConversationAsRead(id){this.setConversationUnreadState(id,false)}
  markConversationAsUnread(id){this.setConversationUnreadState(id,true)}
}
function dispatch(context,method,params){switch(method){case\`turn/started\`:case\`turn/completed\`:case\`thread/status/changed\`:case\`item/completed\`:break;}}
globalThis.testManager = new Manager();
globalThis.testDispatch = (method,params)=>dispatch({manager:globalThis.testManager},method,params);
dispatch({manager:globalThis.testManager},'thread/readState/changed',{});`;

test('installs after manager construction and observes before the original notification handler', () => {
  globalThis.testBridgeCalls=[];globalThis.testObserved=[];globalThis.testMarks=[];
  try {
    // Only this independently authored synthetic fixture is evaluated. Installed vendor code is never executed by a test.
    Function(patchUnreadRenderer(fixture,bridge))();
    assert.equal(globalThis.testManager.constructed,true);
    assert.equal(globalThis.testBridgeCalls.length,1);
    assert.equal(globalThis.testBridgeCalls[0].client,globalThis.testManager.threadStore.params.requestClient);
    assert.equal(globalThis.testBridgeCalls[0].saved,globalThis.testManager.readState);
    assert.equal(globalThis.testManager.cleanup.length,1);
    globalThis.testBridgeCalls[0].notify('three',true);
    assert.deepEqual(globalThis.testManager.applied,['three',true]);
    assert.deepEqual(globalThis.testObserved,[{method:'thread/readState/changed',params:{}}]);
    globalThis.testManager.markConversationAsRead('one');
    globalThis.testManager.markConversationAsUnread('two');
    globalThis.testManager.saveReadState('housekeeping',false);
    assert.deepEqual(globalThis.testMarks,[['one',false],['two',true]]);
  } finally {
    delete globalThis.testManager;delete globalThis.testDispatch;delete globalThis.testBridgeCalls;delete globalThis.testObserved;delete globalThis.testMarks;
  }
});

test('refuses missing, ambiguous, changed and already patched renderer hooks', () => {
  assert.throws(()=>patchUnreadRenderer(fixture.replace('saveReadState','otherMethod'),bridge),/missing or ambiguous/);
  assert.throws(()=>patchUnreadRenderer(fixture+fixture,bridge),/missing or ambiguous/);
  assert.throws(()=>patchUnreadRenderer(fixture.replace('case`item/completed`:',''),bridge),/missing or ambiguous/);
  assert.throws(()=>patchUnreadRenderer(fixture.replace('context,method,params','context,method'),bridge),/missing or ambiguous/);
  assert.throws(()=>patchUnreadRenderer(fixture.replace('markConversationAsRead(id)','markConversationAsRead()'),bridge),/signature changed/);
  assert.throws(()=>patchUnreadRenderer(patchUnreadRenderer(fixture,bridge),bridge),/already patched/);
  assert.throws(()=>patchUnreadRenderer('not valid JavaScript {',bridge),/does not parse/);
});

test('requires a self-contained bridge with exactly the intended export', () => {
  assert.throws(()=>patchUnreadRenderer(fixture,bridge+'\nexport const extra=1;'),/export only/);
  assert.throws(()=>patchUnreadRenderer(fixture,'import x from "x";'+bridge),/self-contained/);
  assert.throws(()=>patchUnreadRenderer(fixture,'export const installReadStateBridge=()=>{};'),/export only/);
});

test('pinned mode refuses arbitrary versions and bytes', () => {
  assert.throws(()=>patchPinnedUnreadRenderer(fixture,bridge,'unknown'),/No verified/);
  assert.throws(()=>patchPinnedUnreadRenderer(fixture,bridge,supportedUnreadTrial.version),/No verified/);
});

test('rejects a changed runtime store or missing cleanup rather than installing a partial bridge', () => {
  for(const changed of [fixture.replace('cleanup=[]','cleanup=null'),fixture.replace('isReady(){return true}','isReady:null')]) {
    assert.throws(()=>Function(patchUnreadRenderer(changed,bridge))(),/client contract changed/);
  }
});

test('real bridge consumes a receipt through the patched native-shaped request and explicit read hooks', async () => {
  const actualBridge=await readFile(new URL('../codex-unread-trial/read-state-bridge.mjs',import.meta.url),'utf8');
  const requests=[];
  globalThis.testRequest=async (method,params) => {
    requests.push({method,params});
    return method==='thread/list' ? {data:[{id:'one'}],readStates:{one:{firstUnread:{type:'turn',turnId:'turn-one'},revision:'v1'}}}
      : {readState:{firstUnread:null,revision:'v2'}};
  };
  try {
    const source=fixture.replace('sendRequest(){}','sendRequest(method,params){return globalThis.testRequest(method,params)}');
    Function(patchUnreadRenderer(source,actualBridge))();
    const manager=globalThis.testManager;
    await manager.threadStore.params.requestClient.sendRequest('thread/list',{});
    assert.equal(manager.readState.has('one'),true);
    assert.deepEqual(manager.applied,['one',true]);
    manager.markConversationAsRead('one');
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(requests.at(-1),{method:'thread/readState/update',params:{threadId:'one',operation:{type:'read'},expectedRevision:'v1'}});
    assert.equal(manager.readState.has('one'),false);
    globalThis.testDispatch('thread/readState/changed',{threadId:'one',readState:{firstUnread:{type:'turn',turnId:'turn-two'},revision:'v3'}});
    assert.equal(manager.readState.has('one'),true);
    assert.deepEqual(manager.applied,['one',true]);
    for(const cleanup of manager.cleanup)cleanup();
  } finally {delete globalThis.testManager;delete globalThis.testDispatch;delete globalThis.testRequest;}
});

test('installed renderer matches the pin and patches in memory without changing the app', async t => {
  let archive;
  try { archive=await readFile('/Applications/ChatGPT.app/Contents/Resources/app.asar'); }
  catch(error){if(error.code==='ENOENT')return t.skip('Installed app unavailable');throw error;}
  const source=readAsarFile(archive,supportedUnreadTrial.asset).toString('utf8');
  const version=JSON.parse(readAsarFile(archive,'package.json')).version;
  if(version!==supportedUnreadTrial.version)return t.skip('App version has no verified experimental patch');
  const before=createHash('sha256').update(archive).digest('hex');
  const actualBridge=await readFile(new URL('../codex-unread-trial/read-state-bridge.mjs',import.meta.url),'utf8');
  const patched=patchPinnedUnreadRenderer(source,actualBridge,version);
  assert.ok(patched.length>source.length);
  assert.equal((patched.match(/\.install\(this\)/g)||[]).length,1);
  assert.equal(createHash('sha256').update(await readFile('/Applications/ChatGPT.app/Contents/Resources/app.asar')).digest('hex'),before);
});
