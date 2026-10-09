import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { collectLedger } from '../scripts/sync.mjs';
const config = JSON.parse(await readFile(new URL('../config.json', import.meta.url)));
const destination = config.seedTokenAccounts[0];
const start = Date.parse(config.startAt) / 1000;
function transaction(amount, timestamp = start + 1) {
  return { slot: timestamp, blockTime: timestamp, transaction: { message: { accountKeys: [{pubkey:'SOURCE'}, {pubkey:destination}], instructions:[{programId:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',parsed:{type:'transferChecked',info:{source:'SOURCE',destination,mint:config.mint,tokenAmount:{amount,decimals:6}}}}]}}, meta:{err:null,preTokenBalances:[{accountIndex:0,mint:config.mint,owner:'DONOR'},{accountIndex:1,mint:config.mint,owner:config.treasury}],postTokenBalances:[],innerInstructions:[]} };
}
function mock() {
  const transactions = new Map([['FIRST', transaction('100000000000')]]);
  let fail = false;
  async function rpc(method, params) {
    if (method === 'getAccountInfo') return {value:{data:{parsed:{type:'mint',info:{decimals:6}}}}};
    if (method === 'getTokenSupply') return {value:{decimals:6}};
    if (method === 'getTokenAccountsByOwner') return {value:[{pubkey:destination}]};
    if (method === 'getTransaction') return fail ? null : transactions.get(params[0]);
    if (method === 'getSignaturesForAddress') {
      let entries = [...transactions.entries()].reverse();
      const index = entries.findIndex(([signature]) => signature === params[1].until);
      if (index >= 0) entries = entries.slice(0,index);
      return entries.map(([signature,tx]) => ({signature,blockTime:tx.blockTime,slot:tx.slot,err:null}));
    }
    throw new Error(method);
  }
  return {transactions,rpc,setFail:()=>{fail=true;}};
}
test('incremental live refresh discovers new transfers without duplicating treasury/token-account results', async () => {
  const api = mock();
  const first = await collectLedger(config, undefined, api.rpc);
  assert.equal(first.snapshot.totalRaw, '100000000000');
  const original = structuredClone(first.nextState);
  api.transactions.set('SECOND',transaction('50000000000',start+60));
  const second = await collectLedger(config, first.nextState, api.rpc);
  assert.deepEqual(first.nextState, original, 'input checkpoint must remain unchanged');
  assert.equal(second.snapshot.totalRaw, '150000000000');
  assert.equal(second.snapshot.totalQuangoRaw, '450000000000');
  assert.equal(second.snapshot.donorCount, 1);
  assert.equal(second.snapshot.transferCount, 2);
  assert.equal(second.snapshot.donors[0].lastDonation, start+60);
  const unchanged = await collectLedger(config,second.nextState,api.rpc);
  assert.equal(unchanged.snapshot.transferCount,2);
  assert.deepEqual(unchanged.snapshot.events,second.snapshot.events);
});
test('a browser can resume from the public checkpoint, without private Helius credentials', async () => {
  const api = mock();
  const first = await collectLedger(config, undefined, api.rpc);
  const state = {configIdentity:JSON.stringify(config),...first.snapshot.checkpoint,events:first.snapshot.events};
  api.transactions.set('SECOND',transaction('1',start+60));
  const result = await collectLedger(config,state,api.rpc);
  assert.equal(result.snapshot.totalRaw,'100000000001');
  assert.equal(result.snapshot.totalQuangoRaw,'300000000003');
});
test('failed live scan cannot advance checkpoints or corrupt previous totals', async () => {
  const api = mock();
  const first = await collectLedger(config, undefined, api.rpc);
  const original = structuredClone(first);
  api.transactions.set('SECOND',transaction('10',start+60));api.setFail();
  await assert.rejects(collectLedger(config,first.nextState,api.rpc),/Transaction unavailable/);
  assert.deepEqual(first,original);
});

test('public browser path verifies mint and follows known accounts without indexed RPC calls', async () => {
  const api = mock();
  const calls = [];
  const rpc = (method, params) => { calls.push(method); return api.rpc(method, params); };
  const first = await collectLedger(config, undefined, rpc, { discoverCurrentAccounts: false });
  assert.equal(first.snapshot.totalRaw, '100000000000');
  assert.ok(calls.includes('getAccountInfo'));
  assert.ok(!calls.includes('getTokenAccountsByOwner'));
  api.transactions.set('SECOND', transaction('50000000000',start+60));
  const second = await collectLedger(config, first.nextState, rpc, { discoverCurrentAccounts: false });
  assert.equal(second.snapshot.totalRaw, '150000000000');
  assert.equal(second.snapshot.transferCount, 2);
});
