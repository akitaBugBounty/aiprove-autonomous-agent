/**
 * AiProve fully-autonomous agent — no human in the loop.
 *
 * Loop (mirrors https://aiprove.fun/skill.md):
 *   1. Load or generate the agent's own keypair (env AGENT_PRIVATE_KEY,
 *      else fresh keypair saved to .agent-key.json, 0600).
 *   2. Fetch skill.md and confirm the API flow.
 *   3. GET  /api/auth/challenge?address=... -> sign (EIP-191) ->
 *      POST /api/auth/verify -> Bearer token.
 *   4. GET  /api/bounties?status=open.
 *   5. For every open bounty, autonomously:
 *      - forecast bounties: compute a prediction from free public market
 *        data (see strategy.js) and POST /api/bounties/<slug>/submit.
 *      - everything else: POST /api/bounties/<slug>/enter (free) and log
 *        that there is no autonomous submission path (they need human
 *        creative work or a code repo).
 *   6. Write results.json (run report) and print a summary.
 *
 * Forecast handlers (slug -> prediction):
 *   btc-tomorrow, forecast-eth-24h, forecast-btc-7d : yes/no direction
 *   signal-eth-pnl-24h                              : long/short
 *   spy-close-1dollar, forecast-gold-tomorrow       : close price (1 day)
 *   forecast-nvda-3d                                : close price (3 days)
 *   top5-pons-24h                                   : SKIPPED — no reliable
 *     autonomous source for newly launched pons tokens.
 *
 * Env:
 *   AGENT_PRIVATE_KEY  optional, 0x-prefixed hex private key
 *   AGENT_HANDLE       optional, default "autonomous-agent"
 *   API_BASE           optional, default "https://aiprove.fun"
 *
 * Usage:
 *   npm install
 *   npm start
 */
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { cryptoMomentum, stockQuote, directionCall, longShortCall, closeCall } = require('./strategy');

const API = process.env.API_BASE || 'https://aiprove.fun';
const KEY_FILE = path.join(__dirname, '.agent-key.json');
const HANDLE = process.env.AGENT_HANDLE || 'autonomous-agent';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(step, msg) {
  console.log(`[${new Date().toISOString()}] [${step}] ${msg}`);
}

async function getJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`non-JSON from ${url}: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

function loadOrCreateWallet() {
  if (process.env.AGENT_PRIVATE_KEY) {
    const w = new ethers.Wallet(process.env.AGENT_PRIVATE_KEY.trim());
    log('KEYPAIR', `loaded from AGENT_PRIVATE_KEY env, address=${w.address}`);
    return w;
  }
  if (fs.existsSync(KEY_FILE)) {
    const saved = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
    const w = new ethers.Wallet(saved.privateKey);
    log('KEYPAIR', `loaded saved keypair from .agent-key.json, address=${w.address}`);
    return w;
  }
  const w = ethers.Wallet.createRandom();
  fs.writeFileSync(KEY_FILE, JSON.stringify({ address: w.address, privateKey: w.privateKey }, null, 2), { mode: 0o600 });
  log('KEYPAIR', `generated fresh keypair, address=${w.address} (saved to .agent-key.json, 0600)`);
  return w;
}

// --- forecast handlers: each returns a prediction payload or null to skip ---
const forecastHandlers = {
  'btc-tomorrow': async () => {
    const t = await cryptoMomentum('BTC');
    const p = directionCall(t.changePct);
    log('STRATEGY', `BTC 24h change ${t.changePct.toFixed(2)}% (last $${t.lastPrice}, ${t.source}) -> ${JSON.stringify(p)}`);
    return { prediction: p };
  },
  'forecast-eth-24h': async () => {
    const t = await cryptoMomentum('ETH');
    const p = directionCall(t.changePct);
    log('STRATEGY', `ETH 24h change ${t.changePct.toFixed(2)}% (last $${t.lastPrice}, ${t.source}) -> ${JSON.stringify(p)}`);
    return { prediction: p };
  },
  'forecast-btc-7d': async () => {
    const t = await cryptoMomentum('BTC');
    const p = directionCall(t.changePct);
    p.confidence = Math.max(0.52, +(p.confidence - 0.05).toFixed(2)); // longer horizon, less certain
    log('STRATEGY', `BTC 7d call from 24h change ${t.changePct.toFixed(2)}% -> ${JSON.stringify(p)}`);
    return { prediction: p };
  },
  'signal-eth-pnl-24h': async () => {
    const t = await cryptoMomentum('ETH');
    const p = longShortCall(t.changePct);
    log('STRATEGY', `ETH 24h change ${t.changePct.toFixed(2)}% -> ${JSON.stringify(p)}`);
    return { prediction: p };
  },
  'spy-close-1dollar': async () => {
    const q = await stockQuote('SPY', 'spy.us');
    const p = closeCall(q, 1);
    log('STRATEGY', `SPY last close $${q.close} (${q.date}, ${q.source}) -> predicted $${p.answer}`);
    return { prediction: p };
  },
  'forecast-gold-tomorrow': async () => {
    const q = await stockQuote('GLD', 'gld.us');
    const p = closeCall(q, 1);
    log('STRATEGY', `GLD last close $${q.close} (${q.date}, ${q.source}) -> predicted $${p.answer}`);
    return { prediction: p };
  },
  'forecast-nvda-3d': async () => {
    const q = await stockQuote('NVDA', 'nvda.us');
    const p = closeCall(q, 3);
    log('STRATEGY', `NVDA last close $${q.close} (${q.date}, ${q.source}) -> predicted $${p.answer} (3d out)`);
    return { prediction: p };
  },
};

async function main() {
  log('START', 'aiprove-autonomous-agent starting (no human in the loop)');
  const wallet = loadOrCreateWallet();
  const address = wallet.address;

  // 1. Read skill.md.
  const skill = await fetch(`${API}/skill.md`).then((r) => {
    if (!r.ok) throw new Error(`skill.md fetch failed: HTTP ${r.status}`);
    return r.text();
  });
  if (!skill.includes('/api/auth/challenge') || !skill.includes('/api/bounties')) {
    throw new Error('skill.md does not contain the expected API flow');
  }
  log('SKILL', `fetched skill.md (${skill.length} chars), auth + bounties flow confirmed`);

  // 2. Authenticate.
  const ch = await getJson(`${API}/api/auth/challenge?address=${address}`);
  if (!ch.challenge) throw new Error('no challenge in response: ' + JSON.stringify(ch));
  const signature = await wallet.signMessage(ch.challenge);
  const verified = await getJson(`${API}/api/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address, signature }),
  });
  if (!verified.token) throw new Error('no token in verify response: ' + JSON.stringify(verified));
  const token = verified.token;
  log('AUTH', `verified, session token issued (expiresAt=${verified.expiresAt})`);

  // 3. List open bounties.
  const list = await getJson(`${API}/api/bounties?status=open`);
  const bounties = list.bounties || list;
  if (!Array.isArray(bounties)) throw new Error('unexpected bounties shape');
  log('BOUNTIES', `open bounties: ${bounties.length}`);

  // 4. Autonomous loop over every open bounty.
  const results = [];
  for (const b of bounties) {
    const entry = { slug: b.slug, title: b.title, prize: `${b.amt} ${b.unit}`, action: null, detail: null };
    try {
      const handler = forecastHandlers[b.slug];
      if (b.slug === 'top5-pons-24h') {
        entry.action = 'skipped';
        entry.detail = 'no reliable autonomous source for newly launched pons tokens';
        log('SKIP', `${b.slug}: ${entry.detail}`);
      } else if (handler) {
        const { prediction } = await handler();
        const submitted = await getJson(`${API}/api/bounties/${b.slug}/submit`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ prediction, handle: HANDLE }),
        });
        entry.action = 'submitted-forecast';
        entry.detail = `prediction=${JSON.stringify(prediction)} id=${submitted.id || 'n/a'}`;
        log('SUBMIT', `${b.slug}: forecast submitted ${entry.detail}`);
      } else {
        const entered = await getJson(`${API}/api/bounties/${b.slug}/enter`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ handle: HANDLE }),
        });
        entry.action = 'entered-only';
        entry.detail = `id=${entered.id || 'n/a'}; no autonomous submission path (needs human/code work)`;
        log('ENTER', `${b.slug}: entered only — ${entry.detail}`);
      }
    } catch (e) {
      // A 409 "not opened yet" is not an agent failure — the bounty simply
      // is not accepting entries yet.
      if (e.message.includes('409') && e.message.includes('not opened yet')) {
        entry.action = 'skipped';
        entry.detail = 'bounty has not opened yet (HTTP 409)';
        log('SKIP', `${b.slug}: ${entry.detail}`);
      } else {
        entry.action = 'failed';
        entry.detail = e.message;
        log('ERROR', `${b.slug}: ${e.message}`);
      }
    }
    results.push(entry);
    await sleep(300); // polite pacing between writes
  }

  const done = results.filter((r) => r.action === 'submitted-forecast').length;
  const entered = results.filter((r) => r.action === 'entered-only').length;
  const skipped = results.filter((r) => r.action === 'skipped').length;
  const failed = results.filter((r) => r.action === 'failed').length;
  const report = { agent: address, handle: HANDLE, at: new Date().toISOString(), totals: { bounties: bounties.length, submitted: done, entered, skipped, failed }, results };
  fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify(report, null, 2));
  log('DONE', `autonomous run complete: ${bounties.length} open bounties -> ${done} forecasts submitted, ${entered} entered-only, ${skipped} skipped, ${failed} failed (report: results.json)`);
}

main().catch((e) => {
  console.error(`[ERROR] ${e.message}`);
  process.exit(1);
});
