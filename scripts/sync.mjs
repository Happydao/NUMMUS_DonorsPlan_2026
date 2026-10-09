import { aggregate, extractDonations, tokenAccountsIn } from './ledger.mjs';

// Shared by the private Helius collector and the browser's public-RPC refresh.
// Inputs are never mutated; the caller adopts a snapshot only after a complete scan.
export async function collectLedger(config, previousState, rpc, { discoverCurrentAccounts = true } = {}) {
let state = previousState;
const identity = JSON.stringify(config);
if (state && state.configIdentity !== identity) throw new Error('Configuration changed: remove data/state.json and recollect the full campaign.');
state ??= { configIdentity: identity, heads: {}, tokenAccounts: config.seedTokenAccounts, events: [] };
// The browser can follow the treasury accounts already verified by the private
// collector without exposing a key for indexed owner-account searches. It also
// discovers accounts from the treasury transaction history below.
let currentAccounts = [];
if (discoverCurrentAccounts) {
  const supply = await rpc('getTokenSupply', [config.mint, { commitment: 'finalized' }]);
  if (supply.value.decimals !== config.decimals) throw new Error('Configured decimals do not match on-chain mint');
  const result = await rpc('getTokenAccountsByOwner', [config.treasury, { mint: config.mint }, { encoding: 'jsonParsed', commitment: 'finalized' }]);
  currentAccounts = result.value.map(account => account.pubkey);
} else {
  const mint = await rpc('getAccountInfo', [config.mint, { encoding: 'jsonParsed', commitment: 'finalized' }]);
  if (mint.value?.data?.parsed?.type !== 'mint' || mint.value.data.parsed.info.decimals !== config.decimals) throw new Error('Unable to verify mint decimals');
}
const tokenAccounts = new Set([...state.tokenAccounts, ...currentAccounts]);
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
  config, ...ledger, checkpoint: { heads, tokenAccounts: [...tokenAccounts] } };
const nextState = { configIdentity: identity, heads, tokenAccounts: [...tokenAccounts], events: ledger.events };
return { snapshot, nextState };
}
