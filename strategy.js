/**
 * Forecast strategy for the autonomous agent.
 *
 * Everything is derived from free public market data, no API keys:
 *  - Crypto direction: Kraken public ticker (24h open vs last), with
 *    CoinGecko 24h change as fallback. (Binance is geo-blocked from
 *    this environment — HTTP 451 — so it is only a last-resort fallback.)
 *  - Stock/ETF closes: Yahoo Finance chart API (browser User-Agent),
 *    with Stooq daily CSV as fallback.
 *
 * The rules are deliberately naive and documented as such — momentum
 * continuation for direction calls, and a drift-extrapolated close for
 * price targets. No signal is fabricated: if every data source fails,
 * the bounty is SKIPPED and the skip is logged.
 */

const KRAKEN = 'https://api.kraken.com/0/public/Ticker';
const COINGECKO = 'https://api.coingecko.com/api/v3/simple/price';
const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart';
const STOOQ = 'https://stooq.com/q/l/';
const BINANCE = 'https://api.binance.com/api/v3/ticker/24hr';
const UA = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' };

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

async function fetchText(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.text();
}

/**
 * Crypto 24h momentum: { lastPrice, changePct } (changePct in %).
 * Kraken first (24h open vs last close), then CoinGecko, then Binance.
 */
async function cryptoMomentum(symbol) {
  const krakenPair = { BTC: 'XBTUSD', ETH: 'ETHUSD' }[symbol];
  const geckoId = { BTC: 'bitcoin', ETH: 'ethereum' }[symbol];
  const errors = [];
  try {
    const d = await fetchJson(`${KRAKEN}?pair=${krakenPair}`);
    if (d.error && d.error.length) throw new Error('Kraken: ' + d.error.join('; '));
    const t = d.result[Object.keys(d.result)[0]];
    const open = parseFloat(t.o);
    const last = parseFloat(t.c[0]);
    if (!Number.isFinite(open) || !Number.isFinite(last) || open === 0) throw new Error('Kraken bad numbers');
    return { lastPrice: last, changePct: ((last - open) / open) * 100, source: 'kraken' };
  } catch (e) { errors.push(e.message); }
  try {
    const d = await fetchJson(`${COINGECKO}?ids=${geckoId}&vs_currencies=usd&include_24hr_change=true`);
    const row = d[geckoId];
    if (!row || !Number.isFinite(row.usd) || !Number.isFinite(row.usd_24h_change)) throw new Error('CoinGecko bad numbers');
    return { lastPrice: row.usd, changePct: row.usd_24h_change, source: 'coingecko' };
  } catch (e) { errors.push(e.message); }
  try {
    const d = await fetchJson(`${BINANCE}?symbol=${symbol}USDT`);
    return { lastPrice: parseFloat(d.lastPrice), changePct: parseFloat(d.priceChangePercent), source: 'binance' };
  } catch (e) { errors.push(e.message); }
  throw new Error('all crypto sources failed: ' + errors.join(' | '));
}

/**
 * Stock/ETF daily quote: { symbol, date, open, close }.
 * Yahoo chart API first (last two daily bars), then Stooq CSV.
 */
async function stockQuote(yahooSymbol, stooqSymbol) {
  const errors = [];
  try {
    const d = await fetchJson(`${YAHOO}/${yahooSymbol}?range=5d&interval=1d`, UA);
    const r = d.chart && d.chart.result && d.chart.result[0];
    const q = r && r.indicators && r.indicators.quote && r.indicators.quote[0];
    const closes = q && q.close;
    const opens = q && q.open;
    if (!closes || closes.length < 1) throw new Error('Yahoo: no bars');
    const i = closes.length - 1;
    const close = closes[i];
    const open = opens[i];
    if (!Number.isFinite(close) || !Number.isFinite(open)) throw new Error('Yahoo: bad numbers');
    return { symbol: yahooSymbol, date: new Date(r.timestamp[i] * 1000).toISOString().slice(0, 10), open, close, source: 'yahoo' };
  } catch (e) { errors.push(e.message); }
  try {
    const csv = await fetchText(`${STOOQ}?s=${stooqSymbol}&f=sd2t2ohlcv&h&e=csv`);
    const lines = csv.trim().split('\n');
    if (lines.length < 2) throw new Error('Stooq: empty response');
    const cols = lines[1].split(',');
    const close = parseFloat(cols[6]);
    const open = parseFloat(cols[3]);
    if (!Number.isFinite(close) || !Number.isFinite(open)) throw new Error('Stooq: unparseable row');
    return { symbol: yahooSymbol, date: cols[1], open, close, source: 'stooq' };
  } catch (e) { errors.push(e.message); }
  throw new Error('all stock sources failed: ' + errors.join(' | '));
}

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * Direction call from 24h momentum (continuation rule).
 * |change| > 0.5% -> follow the direction; otherwise a weak "no".
 * Confidence grows with |momentum|, clamped to [0.52, 0.75].
 */
function directionCall(changePct) {
  const conf = clamp(0.55 + Math.min(0.2, Math.abs(changePct) / 20), 0.52, 0.75);
  if (changePct > 0.5) return { answer: 'yes', confidence: +conf.toFixed(2) };
  if (changePct < -0.5) return { answer: 'no', confidence: +conf.toFixed(2) };
  return { answer: 'no', confidence: 0.52 };
}

/** Long/short call from the same momentum rule. */
function longShortCall(changePct) {
  const conf = clamp(0.55 + Math.min(0.2, Math.abs(changePct) / 20), 0.52, 0.75);
  if (changePct > 0.5) return { answer: 'long', confidence: +conf.toFixed(2) };
  if (changePct < -0.5) return { answer: 'short', confidence: +conf.toFixed(2) };
  return { answer: 'short', confidence: 0.52 };
}

/**
 * Close-price call: last close extrapolated by half of the latest day's
 * return per day out, clamped to +/-0.5% per day. Rounded to 2 decimals.
 */
function closeCall(quote, daysOut) {
  const dayReturn = (quote.close - quote.open) / quote.open;
  const drift = clamp(0.5 * dayReturn, -0.005, 0.005);
  const predicted = quote.close * (1 + drift * daysOut);
  return { answer: +predicted.toFixed(2) };
}

module.exports = { cryptoMomentum, stockQuote, directionCall, longShortCall, closeCall };
