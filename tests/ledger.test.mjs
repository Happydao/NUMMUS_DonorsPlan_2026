import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { aggregate, extractDonations } from '../scripts/ledger.mjs';
const config = JSON.parse(await readFile(new URL('../config.json', import.meta.url)));
const start = Date.parse(config.startAt) / 1000;
const programId = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
function fixture({ amount = '100000000000', checked = true, inner = false, sourceOwner = 'DONOR', failed = false, mint = config.mint, timestamp = start } = {}) {
  const instruction = { programId, parsed: { type: checked ? 'transferChecked' : 'transfer', info: {
    source: 'SOURCE', destination: 'DESTINATION', authority: 'DELEGATE_NOT_DONOR',
    ...(checked ? { mint, tokenAmount: { amount, decimals: 6 } } : { amount }),
  } } };
  return { slot: 100, blockTime: timestamp, transaction: { message: {
    accountKeys: [{ pubkey: 'UNRELATED_FEE_PAYER' }, { pubkey: 'SOURCE' }, { pubkey: 'DESTINATION' }],
    instructions: inner ? [{ programId: 'some-program' }] : [instruction],
  } }, meta: { err: failed ? { error: true } : null,
    preTokenBalances: [{ accountIndex: 1, mint, owner: sourceOwner }, { accountIndex: 2, mint, owner: config.treasury }],
    postTokenBalances: [{ accountIndex: 2, mint, owner: config.treasury }],
    innerInstructions: inner ? [{ index: 0, instructions: [instruction] }] : [],
  } };
}
test('100,000 NUMMUS allocates exactly 300,000 QUANGO to source owner, not fee payer or delegate', () => {
  const events = extractDonations(fixture(), 'sig', config);
  const ledger = aggregate(events, config);
  assert.equal(ledger.totalRaw, '100000000000'); assert.equal(ledger.totalQuangoRaw, '300000000000');
  assert.equal(ledger.donors[0].address, 'DONOR');
});
test('excludes pre-start transfers, other tokens, failed transactions and self transfers', () => {
  for (const options of [{ timestamp: start - 1 }, { mint: 'OTHER' }, { failed: true }, { sourceOwner: config.treasury }]) {
    assert.deepEqual(extractDonations(fixture(options), 'sig', config), []);
  }
});
test('start boundary and inner unchecked SPL transfers, including closed source accounts', () => {
  const result = extractDonations(fixture({ checked: false, inner: true }), 'sig', config);
  assert.equal(result.length, 1); assert.equal(result[0].donor, 'DONOR'); assert.equal(result[0].id, 'sig:0.0');
});
test('aggregates repeated donors, deduplicates events and ranks by amount independently of recency', () => {
  const a = extractDonations(fixture({ sourceOwner: 'A', amount: '5' }), 'a', config)[0];
  const b = extractDonations(fixture({ sourceOwner: 'B', amount: '8', timestamp: start + 10 }), 'b', config)[0];
  const c = extractDonations(fixture({ sourceOwner: 'A', amount: '5', timestamp: start + 5 }), 'c', config)[0];
  const ledger = aggregate([a, b, c, a], config);
  assert.equal(ledger.totalRaw, '18'); assert.equal(ledger.donorCount, 2); assert.equal(ledger.transferCount, 3);
  assert.equal(ledger.donors[0].address, 'A'); assert.equal(ledger.donors[0].transfers, 2);
  assert.equal(ledger.donors[0].lastDonation, start + 5);
  assert.deepEqual(ledger.timeline.map(p => p.amountRaw), ['0', '5', '10', '18']);
});
test('precision is preserved beyond JavaScript safe integers', () => {
  const result = aggregate(extractDonations(fixture({ amount: '9007199254740993' }), 'a', config), config);
  assert.equal(result.totalQuangoRaw, '27021597764222979');
});
test('counts gross incoming donations even when treasury also sends funds out', () => {
  const tx = fixture();
  tx.transaction.message.instructions.push({ programId, parsed: { type: 'transfer', info: { source: 'DESTINATION', destination: 'SOURCE', amount: '50000000000' } } });
  assert.equal(aggregate(extractDonations(tx, 'sig', config), config).totalRaw, '100000000000');
});
test('does not guess donor when source ownership is unavailable', () => {
  const tx = fixture(); tx.meta.preTokenBalances.shift();
  assert.throws(() => extractDonations(tx, 'sig', config), /Cannot resolve source owner/);
});
test('handles new destination account and multiple transfers in one transaction', () => {
  const tx = fixture(); tx.meta.preTokenBalances.pop();
  tx.transaction.message.instructions.push(structuredClone(tx.transaction.message.instructions[0]));
  const result = aggregate(extractDonations(tx, 'sig', config), config);
  assert.equal(result.totalRaw, '200000000000'); assert.equal(result.transferCount, 2);
});
test('empty campaign is a verified zero with a baseline, not the treasury balance', () => {
  const result = aggregate([], config); assert.equal(result.totalRaw, '0'); assert.equal(result.donors.length, 0);
  assert.deepEqual(result.timeline, [{ timestamp: start, amountRaw: '0' }]);
});
