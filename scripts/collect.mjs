import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { aggregate, extractDonations, tokenAccountsIn } from './ledger.mjs';
const config = JSON.parse(await readFile(new URL('../config.json', import.meta.url)));
const dataDir = new URL('../data/', import.meta.url);
await mkdir(dataDir, { recursive: true });
const endpoint = process.env.SOLANA_RPC_URL || (process.env.HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : 'https://api.mainnet-beta.solana.com');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let calls = 0;
async function rpc(method, params) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      // Public Solana RPC has per-method limits. A steady cadence also avoids bursts.
      await pause(Number(process.env.RPC_DELAY_MS ?? 1200));
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++calls, method, params }), signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (payload.error) throw new Error(`RPC code ${payload.error.code}`);
      if (!Object.hasOwn(payload, 'result')) throw new Error('Missing RPC result');
      return payload.result;
    } catch (error) {
      if (attempt === 5) throw new Error(`${method} failed after retries (${error.message.includes('HTTP') || error.message.includes('RPC code') ? error.message : 'connection error'}). Configure SOLANA_RPC_URL with an archival mainnet provider if necessary.`);
      await pause(Math.min(2000 * 2 ** attempt, 30000));
    }
  }
}

let state;
try { state = JSON.parse(await readFile(new URL('state.json', dataDir))); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const identity = JSON.stringify(config);
if (state && state.configIdentity !== identity) throw new Error('Configuration changed: remove data/state.json and recollect the full campaign.');
state ??= { configIdentity: identity, heads: {}, tokenAccounts: config.seedTokenAccounts, events: [] };
const supply = await rpc('getTokenSupply', [config.mint, { commitment: 'finalized' }]);
if (supply.value.decimals !== config.decimals) throw new Error('Configured decimals do not match on-chain mint');
const currentAccounts = await rpc('getTokenAccountsByOwner', [config.treasury, { mint: config.mint }, { encoding: 'jsonParsed', commitment: 'finalized' }]);
const tokenAccounts = new Set([...state.tokenAccounts, ...currentAccounts.value.map(account => account.pubkey)]);
const queue = [config.treasury, ...tokenAccounts];
const scanned = new Set();
const transactions = new Map();
const heads = { ...state.heads };
const events = new Map(state.events.map(event => [event.id, event]));
const start = Date.parse(config.startAt) / 1000;
for (let addressIndex = 0; addressIndex < queue.length; addressIndex++) {
  const address = queue[addressIndex];
  if (scanned.has(address)) continue;
  scanned.add(address);
  let before;
  let finished = false;
  for (let page = 0; page < 200; page++) {
    const signatures = await rpc('getSignaturesForAddress', [address, {
      commitment: 'finalized', limit: 1000, ...(before ? { before } : {}),
      ...(state.heads[address] ? { until: state.heads[address] } : {}),
    }]);
    if (page === 0 && signatures.length) heads[address] = signatures[0].signature;
    for (const item of signatures) {
      if (item.blockTime != null && item.blockTime < start) { finished = true; continue; }
      if (item.err) continue;
      let tx = transactions.get(item.signature);
      if (!tx) {
        tx = await rpc('getTransaction', [item.signature, { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);
        if (!tx || tx.blockTime == null || !tx.meta) throw new Error(`Transaction unavailable: ${item.signature}. Keeping previous snapshot.`);
        transactions.set(item.signature, tx);
      }
      if (tx.blockTime < start) continue;
      // Discover historical/closed treasury token accounts as well as today's open accounts.
      for (const [pubkey, info] of tokenAccountsIn(tx, config)) {
        if (info.owner === config.treasury && info.mint === config.mint && !tokenAccounts.has(pubkey)) {
          tokenAccounts.add(pubkey); queue.push(pubkey);
        }
      }
      for (const event of extractDonations(tx, item.signature, config)) events.set(event.id, event);
    }
    if (finished || signatures.length < 1000) { finished = true; break; }
    before = signatures.at(-1).signature;
  }
  if (!finished) throw new Error('History pagination safety limit reached. Keeping previous snapshot.');
}
const ledger = aggregate([...events.values()], config);
const snapshot = { schemaVersion: 1, status: 'verified', updatedAt: new Date().toISOString(),
  config, ...ledger };
const nextState = { configIdentity: identity, heads, tokenAccounts: [...tokenAccounts], events: ledger.events };
// No partial snapshot is published: all RPC calls must have succeeded first.
await writeFile(new URL('state.json.tmp', dataDir), JSON.stringify(nextState, null, 2) + '\n');
await writeFile(new URL('donations.json.tmp', dataDir), JSON.stringify(snapshot, null, 2) + '\n');
await rename(new URL('state.json.tmp', dataDir), new URL('state.json', dataDir));
await rename(new URL('donations.json.tmp', dataDir), new URL('donations.json', dataDir));
console.log(`Verified ${ledger.transferCount} donations from ${ledger.donorCount} donors. ${calls} RPC calls.`);
