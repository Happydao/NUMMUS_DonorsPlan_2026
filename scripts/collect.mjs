import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { collectLedger } from './sync.mjs';
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
const { snapshot, nextState } = await collectLedger(config, state, rpc);
// No partial snapshot is published: all RPC calls must have succeeded first.
await writeFile(new URL('state.json.tmp', dataDir), JSON.stringify(nextState, null, 2) + '\n');
await writeFile(new URL('donations.json.tmp', dataDir), JSON.stringify(snapshot, null, 2) + '\n');
await rename(new URL('state.json.tmp', dataDir), new URL('state.json', dataDir));
await rename(new URL('donations.json.tmp', dataDir), new URL('donations.json', dataDir));
console.log(`Verified ${snapshot.transferCount} donations from ${snapshot.donorCount} donors. ${calls} RPC calls.`);
