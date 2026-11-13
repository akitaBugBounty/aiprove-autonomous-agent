# AiProve Autonomous Agent

Fully-autonomous agent — no human in the loop. It reads
`https://aiprove.fun/skill.md`, signs in with its own keypair, and enters and
completes as many open bounties as it can on its own. Built for the AiProve
bounty **`best-autonomous-agent`** (0.3 GLD).

## How it works

1. **Keypair** — `AGENT_PRIVATE_KEY` env var wins; otherwise a fresh keypair
   is generated on first run and saved to `.agent-key.json` (0600). The
   private key is never printed and never leaves the machine.
2. **Read skill.md** — fetches the spec and confirms the API flow.
3. **Authenticate** — challenge → EIP-191 `personal_sign` → session token.
4. **List** — `GET /api/bounties?status=open`.
5. **Autonomous loop** — for every open bounty:
   - **Forecast bounties**: compute a prediction from free public market
     data and submit it (`POST /api/bounties/<slug>/submit`).
   - **Everything else**: enter it for free (`POST .../enter`) and log that
     there is no autonomous submission path (they need human creative work
     or a code repo).
   - `top5-pons-24h` is skipped with a logged reason: no reliable
     autonomous source for newly launched pons tokens.
6. **Report** — writes `results.json` with per-bounty outcome + totals.

## Forecast strategy (`strategy.js`)

Naive, documented, and honest — momentum continuation for direction calls,
drift-extrapolated close for price targets. No signal is fabricated: if a
data source is unreachable, the bounty is skipped.

- **Direction** (`btc-tomorrow`, `forecast-eth-24h`, `forecast-btc-7d`):
  Kraken public ticker 24h change (CoinGecko 24h change as fallback;
  Binance is geo-blocked from this environment — HTTP 451 — so it is only
  a last-resort fallback). |change| > 0.5% → follow the direction,
  confidence 0.55–0.75 by |momentum|; otherwise weak "no" at 0.52.
  7-day call loses 0.05 confidence (longer horizon).
- **Long/short** (`signal-eth-pnl-24h`): same momentum rule, `long`/`short`.
- **Close price** (`spy-close-1dollar`, `forecast-gold-tomorrow`,
  `forecast-nvda-3d`): Yahoo Finance chart API latest close (Stooq daily
  CSV as fallback), extrapolated by half the latest day's return per day
  out (clamped ±0.5%/day).

## Run

```bash
npm install
npm start
```

Optional env: `AGENT_PRIVATE_KEY`, `AGENT_HANDLE` (default:
`autonomous-agent`), `API_BASE` (default: `https://aiprove.fun`).

## Files

- `index.js` — the autonomous loop.
- `strategy.js` — market-data fetchers + prediction rules.
- `package.json` — one dependency: `ethers` (signing).
- `results.json` — run report, written on every run.
- `TRANSCRIPT.md` — step-by-step build + verified test run log.
