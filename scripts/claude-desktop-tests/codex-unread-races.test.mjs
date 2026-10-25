import assert from 'node:assert/strict';
import test from 'node:test';
import { installReadStateBridge } from '../codex-unread-trial/read-state-bridge.mjs';

const state = (revision, unread = true) => ({revision,firstUnread:unread ? {type:'turn',turnId:'turn'} : null});
const page = receipt => ({data:[{id:'one'}],readStates:{one:receipt}});
const deferred = () => {let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}};
const tick = () => new Promise(resolve=>setImmediate(resolve));
function fixture(send) {
  const values=new Map(),notices=[],calls=[];
  const saved={has:id=>values.get(id),set:(id,unread)=>values.set(id,unread),isReady:()=>true,subscribe:()=>()=>{}};
  const original=(method,params,...rest)=>{calls.push({method,params});return send(method,params,...rest)};
  const client={sendRequest:original};
  const bridge=installReadStateBridge({client,saved,notify:(id,unread)=>notices.push([id,unread])});
  return {values,notices,calls,saved,client,bridge,original};
}

test('a newer list response wins over an older list or read response',async()=>{
  for(const firstMethod of ['thread/list','thread/read']) {
    const old=deferred(),fresh=deferred();let count=0;
    const f=fixture(()=>++count===1?old.promise:fresh.promise);
    const a=f.client.sendRequest(firstMethod,{threadId:'one'});
    const b=f.client.sendRequest('thread/list',{});
    fresh.resolve(page(state('new')));await b;
    old.resolve(firstMethod==='thread/read'?{thread:{id:'one'},readState:state('old',false)}:page(state('old',false)));await a;
    assert.equal(f.values.get('one'),true);
    f.bridge.dispose();
  }
});

test('same boolean still updates the loaded UI, duplicates do not, and local changes invalidate projection',async()=>{
  const f=fixture(()=>Promise.resolve(page(state('v1'))));
  f.values.set('one',true);
  await f.client.sendRequest('thread/list',{});
  assert.deepEqual(f.notices,[['one',true]]);
  await f.client.sendRequest('thread/list',{});
  assert.equal(f.notices.length,1);
  f.saved.set('one',false);
  await f.client.sendRequest('thread/list',{});
  assert.equal(f.values.get('one'),true);
  assert.equal(f.notices.length,2);
  assert.equal(f.calls.filter(call=>call.method==='thread/readState/update').length,0);
  f.bridge.dispose();
});

test('stale ack or conflict cannot replace a newer notification revision',async()=>{
  for(const conflict of [false,true]) {
    const ack=deferred();
    const f=fixture(method=>method==='thread/list'?Promise.resolve(page(state('v1'))):ack.promise);
    await f.client.sendRequest('thread/list',{});
    f.saved.set('one',false);f.bridge.mark('one',false);
    f.bridge.observe({method:'thread/readState/changed',params:{threadId:'one',readState:state('v3')}});
    if(conflict)ack.reject(Object.assign(new Error('conflict'),{data:{reason:'readStateConflict',readState:state('v2',false)}}));
    else ack.resolve({readState:state('v2',false)});
    await tick();
    assert.equal(f.values.get('one'),true);
    f.saved.set('one',false);f.bridge.mark('one',false);
    const updates=f.calls.filter(call=>call.method==='thread/readState/update');
    assert.equal(updates.length,2);
    assert.equal(updates[1].params.expectedRevision,'v3');
    await tick();f.bridge.dispose();
  }
});

test('dispose blocks pending results and notification writes while preserving a foreign wrapper',async()=>{
  const pending=deferred(),f=fixture(()=>pending.promise);
  const response=f.client.sendRequest('thread/list',{});
  const foreign=()=>Promise.resolve({});f.client.sendRequest=foreign;
  f.bridge.dispose();f.bridge.dispose();
  pending.resolve(page(state('v1')));await response;
  f.bridge.observe({method:'thread/readState/changed',params:{threadId:'one',readState:state('v2')}});
  assert.equal(f.values.size,0);
  assert.equal(f.client.sendRequest,foreign);
});

test('separate hosts never share unread revisions or read actions',async()=>{
  const a=fixture(()=>Promise.resolve(page(state('host-a'))));
  const b=fixture(()=>Promise.resolve(page(state('host-b',false))));
  await a.client.sendRequest('thread/list',{});await b.client.sendRequest('thread/list',{});
  assert.equal(a.values.get('one'),true);assert.equal(b.values.get('one'),false);
  a.saved.set('one',false);a.bridge.mark('one',false);
  assert.equal(a.calls.at(-1).params.expectedRevision,'host-a');
  assert.equal(b.calls.length,1);
  await tick();a.bridge.dispose();b.bridge.dispose();
});

test('bounded epoch eviction cannot revive an old pending response',async()=>{
  const pending=deferred(),f=fixture(()=>pending.promise);
  const response=f.client.sendRequest('thread/list',{});
  f.saved.set('one',false);
  for(let i=0;i<1000;i++)f.saved.set('other-'+i,false);
  pending.resolve(page(state('stale')));await response;
  assert.equal(f.values.get('one'),false);
  f.bridge.dispose();
});

test('refresh during serialized read/unread actions cannot leave the latest UI read',async()=>{
  const first=deferred(),second=deferred(),refresh=deferred();let lists=0,updates=0;
  const f=fixture(method=>method==='thread/list'?(++lists===1?Promise.resolve(page(state('v1'))):refresh.promise)
    :(++updates===1?first.promise:second.promise));
  await f.client.sendRequest('thread/list',{});
  f.saved.set('one',false);f.bridge.mark('one',false);
  f.saved.set('one',true);f.bridge.mark('one',true);
  const listing=f.client.sendRequest('thread/list',{});
  first.resolve({readState:state('v2',false)});await tick();
  refresh.resolve(page(state('v2',false)));await listing;
  second.resolve({readState:state('v3')});await tick();
  assert.equal(f.values.get('one'),true);
  f.bridge.dispose();
});

test('duplicate snapshot or notification cannot erase a queued unread action',async()=>{
  for(const notification of [false,true]) {
    const ack=deferred();let updates=0;
    const f=fixture(method=>method==='thread/list'?Promise.resolve(page(state('v1')))
      :(++updates===1?ack.promise:Promise.resolve({readState:state('v3')})));
    await f.client.sendRequest('thread/list',{});
    f.saved.set('one',false);f.bridge.mark('one',false);
    f.saved.set('one',true);f.bridge.mark('one',true);
    if(notification)f.bridge.observe({method:'thread/readState/changed',params:{threadId:'one',readState:state('v1')}});
    else await f.client.sendRequest('thread/list',{});
    ack.resolve({readState:state('v2',false)});await tick();
    assert.equal(updates,2);
    assert.equal(f.calls.at(-1).params.expectedRevision,'v2');
    assert.equal(f.values.get('one'),true);
    f.bridge.dispose();
  }
});

test('duplicate old notification cannot undo an optimistic read acknowledgement',async()=>{
  const ack=deferred(),f=fixture(method=>method==='thread/list'?Promise.resolve(page(state('v1'))):ack.promise);
  await f.client.sendRequest('thread/list',{});
  f.saved.set('one',false);f.bridge.mark('one',false);
  f.bridge.observe({method:'thread/readState/changed',params:{threadId:'one',readState:state('v1')}});
  ack.resolve({readState:state('v2',false)});await tick();
  assert.equal(f.values.get('one'),false);
  f.bridge.dispose();
});

test('a failed local projection retries the same receipt after recovery',async()=>{
  for(const failNotify of [false,true]) {
    let failing=true;
    const values=new Map(),notices=[];
    const saved={has:id=>values.get(id),set(id,unread){if(failing&&!failNotify)throw Error('unavailable');values.set(id,unread)},
      isReady:()=>true,subscribe:()=>()=>{}};
    const result=page(state('v1')),client={sendRequest:async()=>result};
    const bridge=installReadStateBridge({client,saved,notify(id,unread){if(failing&&failNotify)throw Error('unavailable');notices.push([id,unread])}});
    assert.equal(await client.sendRequest('thread/list',{}),result);
    failing=false;
    await client.sendRequest('thread/list',{});
    assert.equal(values.get('one'),true);
    assert.deepEqual(notices.at(-1),['one',true]);
    bridge.dispose();
  }
});
