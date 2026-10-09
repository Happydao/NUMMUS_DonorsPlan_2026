# NUMMUS Donors Plan 2026

Community donation dashboard, published on [GitHub Pages](https://happydao.github.io/NUMMUS_DonorsPlan_2026/). Visual identity, original logo, palette and typography from [nummus.meme](https://nummus.meme).

## Campaign

- Treasury: `EKjb5grMX19c3cAZa5LQjqksDpqqVLTGZrswh79WkPdD`
- NUMMUS mint: `9JK2U7aEkp3tWaFNuaJowWRgNys5DVaKGxWk73VT5ray`
- QUANGO mint: `CSRvuL45tXnqYKqk9RXBksuaFQzsamp3ACT5pgEQTVzn`
- Fixed start: **9 October 2026, 00:00 Europe/Rome**, equivalent to **8 October 2026, 22:00 UTC**. No daily reset.
- Allocation: **3 QUANGO per 1 NUMMUS**. This is a reporting dashboard, not an airdrop execution tool.

## Features

Cumulative NUMMUS/QUANGO chart, totals, top-ten highlighting, default ranking by total donations, latest-donation sorting, wallet search, 20 donors per page, full CSV export, Solscan links, copyable treasury address and responsive layout. The interface follows the main website's English language.

All token accounting uses integer units (`BigInt`) and preserves six NUMMUS decimals. Only chart coordinates use floating-point numbers. CSV exports keep exact decimal amounts.

## Data collection

`scripts/collect.mjs` queries finalized Solana RPC transactions for the treasury and its NUMMUS token accounts, including the existing token account and token accounts discovered from historical treasury transactions. It paginates back to the campaign start on first run, then continues from per-address signature checkpoints. Token accounts remain tracked after closure. Successful parsed SPL `transfer` and `transferChecked` instructions, both top-level and inner, count when they send the configured mint to a treasury-owned token account.

The donor is the **source token-account owner**, never the fee payer or transfer authority. Incoming transfers are summed per source owner; outgoing transactions do not reduce cumulative donations. Other mints, failed transactions, pre-start balances and treasury self-transfers are excluded. Transfers are deduplicated by signature and instruction position. If a relevant transaction or donor cannot be resolved, collection fails and the previous snapshot is preserved rather than publishing incomplete totals. Protocol/custodial senders appear as the on-chain token-account owner; the ledger cannot infer a user's identity behind an exchange or protocol.

The GitHub Actions workflow runs on push, manual dispatch and every five minutes. GitHub can delay scheduled jobs; public RPC limits can also delay collection. The browser checks the published JSON once a minute and also independently collects new finalized transfers directly from the public Solana RPC at `https://solana-rpc.publicnode.com`. This live refresh runs on opening the page, every minute while visible, when returning to the tab, and on the refresh button. It does not depend on GitHub scheduling. The browser and Helius collector share the same accounting/scanning modules; they use published public signature checkpoints to resume incrementally. The browser verifies the mint through `getAccountInfo`, follows the known treasury token accounts from the private collector and discovers further token accounts from treasury transaction history. Full owner-account discovery remains in the private Helius collector because public RPC providers restrict indexed queries. Exotic new non-associated token accounts created without a treasury reference require a background collection to be discovered. No private RPC key is exposed. A live scan is adopted only after all calls succeed; older published JSON never replaces newer live totals. If the public RPC is unavailable, a warning appears and the last verified totals are retained. Snapshots older than 20 minutes are flagged. Live results update the open page and its CSV export; the downloadable published JSON and repository remain updated by the background workflow. A failed collector preserves the last verified snapshot and marks the workflow failed. The public RPC endpoint is used by default. For reliable production volume, set the repository Actions secret `SOLANA_RPC_URL` to an archival Solana mainnet RPC URL, or use `HELIUS_API_KEY`. Secrets are read only by the collector and are never shipped to the browser.

GitHub may disable scheduled workflows in public repositories after 60 days without repository activity. Daily timestamp commits ordinarily keep this repository active; monitor failed workflows and re-enable scheduling if needed.

### Changing campaign configuration

Edit `config.json`; if changing accounting settings, delete `data/state.json` and run collection to rebuild from the fixed campaign start. The collector deliberately rejects mismatched cached configuration. The campaign date text in `index.html` / `app.js` should also be updated if changing the campaign. An archival RPC is necessary if the selected endpoint cannot return the full campaign history.

## Local development

Node.js 22 or newer; no package installation needed.

```sh
npm test
npm run collect
npm run build
npm run preview
```

`data/donations.json` is the public verified ledger, including transaction signatures for auditing. `data/state.json` stores collection checkpoints and is not copied to the deployed site. The workflow publishes only `dist/` through GitHub Pages. No backend, wallet connection or wallet private key is required.

RPC references: [getSignaturesForAddress](https://solana.com/docs/rpc/http/getsignaturesforaddress), [getTransaction](https://solana.com/docs/rpc/http/gettransaction).
