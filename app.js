import { collectLedger } from './lib/sync.mjs';
const $ = selector => document.querySelector(selector);
let liveState, liveConfigIdentity, liveBusy = false;
let snapshot, page = 1, sort = 'amount', chartToken = 'nummus', loading = false;
const pageSize = 20;
const dateFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const shortDate = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', day: '2-digit', month: 'short' });
function format(raw, decimals = snapshot?.config.decimals ?? 6) {
  const value = BigInt(raw), unit = 10n ** BigInt(decimals);
  const fraction = (value % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
  return (value / unit).toLocaleString('en-US') + (fraction ? `.${fraction}` : '');
}
function exactDecimal(raw) { return format(raw).replaceAll(',', ''); }
function el(tag, text, className) { const node = document.createElement(tag); if (text != null) node.textContent = text; if (className) node.className = className; return node; }
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { $('#toast').hidden = true; }, 3500); }
function setPressed(group, value, key) { document.querySelectorAll(`${group} button`).forEach(button => button.setAttribute('aria-pressed', String(button.dataset[key] === value))); }
function showFreshness() {
  if (!snapshot) return;
  const stale = Date.now() - Date.parse(snapshot.updatedAt) > 20 * 60 * 1000;
  $('#sync-text').textContent = `${stale ? 'Update delayed' : snapshot.source === 'live' ? 'Live on-chain' : 'Verified on-chain'} · ${dateFormat.format(new Date(snapshot.updatedAt))} (Rome)`;
  $('#status-dot').className = `dot${stale ? ' warning' : ''}`;
  $('#notice').hidden = !stale;
  if (stale) $('#notice').textContent = 'Updates are taking longer than usual. These are the last verified totals; newer donations may not be included yet.';
}
async function load() {
  if (loading) return;
  loading = true; $('#refresh').disabled = true;
  try {
    const response = await fetch(`data/donations.json?t=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('Data unavailable');
    const data = await response.json();
    if (data.status !== 'verified' || !Array.isArray(data.donors) || !Array.isArray(data.timeline) || !Number.isFinite(Date.parse(data.updatedAt))) throw new Error('Unverified data');
    // An older published file must never replace a newer live scan.
    if (!snapshot || JSON.stringify(data.config) !== JSON.stringify(snapshot.config) || Date.parse(data.updatedAt) > Date.parse(snapshot.updatedAt)) {
      snapshot = data;
      liveState = undefined;
      paintSnapshot();
    }
  } catch {
    $('#notice').hidden = false;
    $('#notice').textContent = snapshot ? 'Unable to refresh. Showing the last successfully loaded data; newer donations may not be included.' : 'Donation data is temporarily unavailable. Please try refreshing shortly. Totals are not shown until verified data is available.';
    $('#sync-text').textContent = snapshot ? `Connection unavailable · last verified ${dateFormat.format(new Date(snapshot.updatedAt))} (Rome)` : 'Data unavailable';
    $('#status-dot').className = 'dot warning';
    if (!snapshot) $('#donor-rows').replaceChildren(emptyRow('The ledger is temporarily unavailable.', 'Please try again shortly.'));
  } finally {
    loading = false;
    await refreshLive();
    $('#refresh').disabled = liveBusy;
  }
}
function paintSnapshot() {
  const data = snapshot;
  $('#total-nummus').textContent = format(data.totalRaw);
  $('#total-quango').textContent = format(data.totalQuangoRaw);
  $('#total-donors').textContent = data.donorCount.toLocaleString('en-US');
  $('#transfers').textContent = `${data.transferCount.toLocaleString('en-US')} confirmed ${data.transferCount === 1 ? 'donation' : 'donations'}`;
  $('#export').disabled = false;
  showFreshness(); renderTable(); renderChart();
}
async function refreshLive() {
  if (!snapshot || liveBusy) return;
  liveBusy = true; $('#refresh').disabled = true;
  const base = snapshot;
  const identity = JSON.stringify(base.config);
  if (!liveState || liveConfigIdentity !== identity) {
    liveConfigIdentity = identity;
    liveState = { configIdentity: identity, heads: { ...(base.checkpoint?.heads ?? {}) },
      tokenAccounts: [...(base.checkpoint?.tokenAccounts ?? base.config.seedTokenAccounts)], events: base.events };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);
  let requestId = 0;
  async function rpc(method, params) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (controller.signal.aborted) throw new Error('Sync timeout');
        const response = await fetch('https://solana-rpc.publicnode.com', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
          signal: controller.signal, credentials: 'omit',
        });
        if (!response.ok) throw new Error('RPC unavailable');
        const payload = await response.json();
        if (payload.error || !Object.hasOwn(payload, 'result')) throw new Error('RPC error');
        return payload.result;
      } catch (error) {
        if (attempt === 2 || controller.signal.aborted) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  }
  try {
    const result = await collectLedger(base.config, liveState, rpc, { discoverCurrentAccounts: false });
    // If the campaign changed while the scan was in flight, discard this old scan.
    if (snapshot !== base || JSON.stringify(snapshot.config) !== identity) return;
    liveState = result.nextState;
    snapshot = { ...result.snapshot, source: 'live' };
    paintSnapshot();
  } catch (error) {
    console.warn('Live donation refresh failed:', error.message);
    showFreshness();
    $('#notice').hidden = false;
    $('#notice').textContent = 'Live refresh is temporarily unavailable. Showing the last verified totals; new donations may be delayed. Retrying automatically every minute.';
  } finally {
    clearTimeout(timeout); liveBusy = false; $('#refresh').disabled = loading;
  }
}
function emptyRow(title, detail) { const row = el('tr'), cell = el('td', null, 'empty-table'); cell.colSpan = 5; cell.append(el('strong', title), el('span', detail)); row.append(cell); return row; }
function renderTable() {
  if (!snapshot) return;
  const query = $('#search').value.trim().toLowerCase();
  const donors = snapshot.donors.filter(donor => donor.address.toLowerCase().includes(query));
  if (sort === 'recent') donors.sort((a, b) => b.lastDonation - a.lastDonation || a.rank - b.rank);
  else donors.sort((a, b) => a.rank - b.rank);
  const pages = Math.max(1, Math.ceil(donors.length / pageSize)); page = Math.min(page, pages);
  const start = (page - 1) * pageSize, visible = donors.slice(start, start + pageSize);
  const rows = visible.map(donor => {
    const row = el('tr', null, donor.rank <= 3 ? 'top-donor podium' : donor.rank <= 10 ? 'top-donor' : '');
    const rank = el('td'); rank.append(el('span', String(donor.rank).padStart(2, '0'), 'rank'));
    const wallet = el('td', null, 'wallet');
    const link = el('a', `${donor.address.slice(0, 6)}…${donor.address.slice(-6)} ↗`);
    link.href = `https://solscan.io/account/${encodeURIComponent(donor.address)}`; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.title = donor.address; link.setAttribute('aria-label', `View donor ${donor.address} on Solscan`);
    wallet.append(link); if (donor.rank <= 10) wallet.append(el('small', '✦ TOP 10'));
    const amount = el('td', format(donor.amountRaw), 'numeric amount');
    const quango = el('td', format(donor.quangoRaw), 'numeric amount quango-col');
    const recent = el('td', null, 'numeric last-date'), time = el('time', dateFormat.format(new Date(donor.lastDonation * 1000)));
    time.dateTime = new Date(donor.lastDonation * 1000).toISOString(); time.title = 'Europe/Rome'; recent.append(time);
    row.append(rank, wallet, amount, quango, recent); return row;
  });
  $('#donor-rows').replaceChildren(...(rows.length ? rows : [query
    ? emptyRow('No matching wallet found.', 'Try the full address or a shorter part. New donations appear after the next update.')
    : emptyRow('The ledger is ready for its first donor.', 'No NUMMUS donations have been recorded since 9 October 2026, 00:00 Europe/Rome.') ]));
  $('#page-info').textContent = donors.length ? `Showing ${start + 1}–${Math.min(start + pageSize, donors.length)} of ${donors.length} donors` : query ? '0 matching donors' : '0 donors · 20 per page';
  $('#page-number').textContent = `${page} / ${pages}`;
  $('#previous').disabled = page <= 1; $('#next').disabled = page >= pages;
}
function renderChart() {
  if (!snapshot) return;
  const svg = $('#chart'), ns = 'http://www.w3.org/2000/svg';
  svg.replaceChildren();
  function shape(tag, attributes, text) { const node = document.createElementNS(ns, tag); for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value); if (text != null) node.textContent = text; svg.append(node); return node; }
  const factor = chartToken === 'quango' ? 3 : 1;
  const rawTotal = chartToken === 'quango' ? snapshot.totalQuangoRaw : snapshot.totalRaw;
  const maximum = Math.max(Number(rawTotal) / 10 ** snapshot.config.decimals, 1);
  const begin = Date.parse(snapshot.config.startAt) / 1000;
  const end = Math.max(Date.parse(snapshot.updatedAt) / 1000, begin + 1);
  const left = 76, right = 1087, top = 14, bottom = 215;
  const x = timestamp => left + Math.max(0, Math.min(1, (timestamp - begin) / (end - begin))) * (right - left);
  const y = amount => bottom - (amount / maximum) * (bottom - top);
  const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 });
  for (let index = 0; index <= 4; index++) {
    const amount = maximum * index / 4, height = y(amount);
    shape('line', { x1: left, x2: right, y1: height, y2: height, stroke: '#e6dfd1', 'stroke-dasharray': index ? '3 5' : '0' });
    shape('text', { x: left - 13, y: height + 4, fill: '#817868', 'font-size': 11, 'text-anchor': 'end', 'font-family': 'monospace' }, snapshot.transferCount ? compact.format(amount) : index === 0 ? '0' : '');
  }
  const points = snapshot.timeline.map(point => [x(point.timestamp), y(Number(point.amountRaw) / 10 ** snapshot.config.decimals * factor)]);
  // A step curve preserves real donation jumps; no smoothed or invented intermediate growth.
  let path = `M${left},${bottom}`;
  for (const [px, py] of points) path += ` H${px} V${py}`;
  const lastY = points.at(-1)?.[1] ?? bottom; path += ` H${right}`;
  shape('path', { d: `${path} V${bottom} H${left} Z`, fill: '#b8913e', opacity: '.09' });
  shape('path', { d: path, fill: 'none', stroke: '#9b772f', 'stroke-width': 2.5, 'stroke-linejoin': 'round' });
  if (snapshot.transferCount) {
    const dot = shape('circle', { cx: right, cy: lastY, r: 4.5, fill: '#9b772f', stroke: '#fbf9f4', 'stroke-width': 2 });
    const title = document.createElementNS(ns, 'title'); title.textContent = `${format(rawTotal)} ${chartToken.toUpperCase()}`; dot.append(title);
  }
  $('#chart-empty').hidden = snapshot.transferCount > 0;
  $('#chart-start').textContent = shortDate.format(new Date(begin * 1000)).toUpperCase() + ' 2026';
  $('#chart-end').textContent = dateFormat.format(new Date(snapshot.updatedAt)).toUpperCase();
  $('#chart-caption').textContent = `${chartToken.toUpperCase()} · SINCE THE START OF THE PLAN`;
  svg.setAttribute('aria-label', `Cumulative ${chartToken.toUpperCase()}: ${format(rawTotal)} across ${snapshot.transferCount} donations since 9 October 2026.`);
}
$('#sort').addEventListener('click', event => { const button = event.target.closest('button'); if (!button) return; sort = button.dataset.sort; page = 1; setPressed('#sort', sort, 'sort'); renderTable(); });
$('#chart-token').addEventListener('click', event => { const button = event.target.closest('button'); if (!button) return; chartToken = button.dataset.token; setPressed('#chart-token', chartToken, 'token'); renderChart(); });
$('#search').addEventListener('input', () => { page = 1; renderTable(); });
function turnPage(delta) { page += delta; renderTable(); $('.table-scroll').scrollTop = 0; }
$('#previous').addEventListener('click', () => turnPage(-1)); $('#next').addEventListener('click', () => turnPage(1));
$('#refresh').addEventListener('click', load);
$('#copy-treasury').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('#treasury-address').textContent); toast('Treasury address copied'); } catch { toast('Please select and copy the treasury address above.'); } });
$('#export').addEventListener('click', () => {
  if (!snapshot) return;
  const header = 'Rank,Wallet,NUMMUS donated,QUANGO allocation,Last donation (UTC),Transfers';
  const rows = snapshot.donors.map(donor => [donor.rank, donor.address, exactDecimal(donor.amountRaw), exactDecimal(donor.quangoRaw), new Date(donor.lastDonation * 1000).toISOString(), donor.transfers].join(','));
  const url = URL.createObjectURL(new Blob([header + '\r\n' + rows.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8;' }));
  const link = el('a'); link.href = url; link.download = `nummus-donors-${snapshot.updatedAt.slice(0, 10)}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
load(); setInterval(() => { if (!document.hidden) load(); }, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
