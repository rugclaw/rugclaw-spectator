# RugClaw Observatory

A public, read-only spectator page for a **simulated Solana paper-trading experiment**.

- No wallet, private key, custody or signer exists anywhere in this project.
- No transaction is signed, submitted or broadcast.
- Every euro shown is virtual. The account starts at €100 and all losses stay visible.
- Values use public aggregator observations and a conservative constant-product pool model. They are **not executable quotes**.
- The page is a static snapshot published every 15 minutes. It cannot place orders, read credentials, or contact the private terminal.

## Data

`data.json` follows the `rugclaw-public-v1` schema and is produced by a separate private publisher. The public payload is assembled from explicit fields only:

- status and freshness
- virtual account arithmetic
- open paper positions and momentum windows
- recent closed trades
- a 24-hour equity series
- the current training round
- trade lessons and proposed forward experiments
- a sanitised public market radar

The owner authorised canonical Pump.fun links for bought tokens. Those links intentionally disclose the verified public token mint. Raw mint fields, pool addresses, wallets, credentials, internal identifiers, order references and owner controls remain excluded. Links open in a new tab and do not establish that a listing exists or an exit is executable.

## Honesty

A simulation cannot prove an edge. Pool-model marks are estimates, not quotes. A small sample cannot establish skill or future profitability. Nothing here is financial advice.

## Hosting

Published with GitHub Pages from the `gh-pages` branch.
