// All accounting uses raw integer token units. Never attribute a donation to a fee payer.
export const TOKEN_PROGRAMS = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]);

export function tokenAccountsIn(tx, config) {
  const keys = tx.transaction.message.accountKeys.map(k => typeof k === 'string' ? k : k.pubkey);
  const accounts = new Map();
  // Pre-balances preserve the source owner even when an account is closed in the transaction.
  for (const balance of [...(tx.meta?.postTokenBalances ?? []), ...(tx.meta?.preTokenBalances ?? [])]) {
    accounts.set(keys[balance.accountIndex], { mint: balance.mint, owner: balance.owner });
  }
  return accounts;
}

export function extractDonations(tx, signature, config) {
  if (!tx.meta || tx.meta.err) return [];
  if (tx.blockTime == null) throw new Error(`Missing block time for ${signature}`);
  if (tx.blockTime * 1000 < Date.parse(config.startAt)) return [];
  const accounts = tokenAccountsIn(tx, config);
  const inner = new Map((tx.meta.innerInstructions ?? []).map(group => [group.index, group.instructions]));
  const result = [];
  function inspect(instruction, id) {
    if (!TOKEN_PROGRAMS.has(instruction.programId)) return;
    const parsed = instruction.parsed;
    if (!parsed) {
      const keys = tx.transaction.message.accountKeys.map(k => typeof k === 'string' ? k : k.pubkey);
      const involved = (instruction.accounts ?? []).map(a => typeof a === 'number' ? keys[a] : a);
      if (involved.some(a => accounts.get(a)?.mint === config.mint && accounts.get(a)?.owner === config.treasury)) {
        throw new Error(`Unparsed treasury token instruction in ${signature}`);
      }
      return;
    }
    if (!['transfer', 'transferChecked'].includes(parsed.type)) return;
    const info = parsed.info;
    const destination = accounts.get(info.destination);
    if (destination?.mint !== config.mint || destination.owner !== config.treasury) return;
    const source = accounts.get(info.source);
    if (!source?.owner || source.mint !== config.mint) throw new Error(`Cannot resolve source owner in ${signature}`);
    if (source.owner === config.treasury) return;
    if (info.mint && info.mint !== config.mint) throw new Error(`Unexpected mint in ${signature}`);
    if (info.tokenAmount && info.tokenAmount.decimals !== config.decimals) throw new Error('Token decimals changed');
    const amount = BigInt(info.amount ?? info.tokenAmount.amount);
    if (amount <= 0n) return;
    result.push({ id: `${signature}:${id}`, signature, donor: source.owner,
      amountRaw: amount.toString(), timestamp: tx.blockTime, slot: tx.slot });
  }
  tx.transaction.message.instructions.forEach((instruction, index) => {
    inspect(instruction, `${index}`);
    (inner.get(index) ?? []).forEach((child, childIndex) => inspect(child, `${index}.${childIndex}`));
  });
  return result;
}

export function aggregate(events, config) {
  const unique = [...new Map(events.map(event => [event.id, event])).values()]
    .filter(event => event.timestamp * 1000 >= Date.parse(config.startAt))
    .sort((a, b) => a.timestamp - b.timestamp || a.slot - b.slot || a.id.localeCompare(b.id));
  const donors = new Map();
  let total = 0n;
  const timeline = [{ timestamp: Date.parse(config.startAt) / 1000, amountRaw: '0' }];
  for (const event of unique) {
    const amount = BigInt(event.amountRaw);
    if (amount <= 0n) throw new Error('Invalid donation amount');
    total += amount;
    const donor = donors.get(event.donor) ?? { address: event.donor, amountRaw: '0', lastDonation: 0, transfers: 0 };
    donor.amountRaw = (BigInt(donor.amountRaw) + amount).toString();
    donor.quangoRaw = (BigInt(donor.amountRaw) * BigInt(config.rewardMultiplier)).toString();
    donor.lastDonation = Math.max(donor.lastDonation, event.timestamp);
    donor.transfers++;
    donors.set(event.donor, donor);
    timeline.push({ timestamp: event.timestamp, amountRaw: total.toString() });
  }
  const ranked = [...donors.values()].sort((a, b) => BigInt(a.amountRaw) === BigInt(b.amountRaw)
    ? a.address.localeCompare(b.address) : BigInt(a.amountRaw) > BigInt(b.amountRaw) ? -1 : 1)
    .map((donor, index) => ({ ...donor, rank: index + 1 }));
  return { totalRaw: total.toString(), totalQuangoRaw: (total * BigInt(config.rewardMultiplier)).toString(),
    donorCount: ranked.length, transferCount: unique.length, donors: ranked, timeline, events: unique };
}
