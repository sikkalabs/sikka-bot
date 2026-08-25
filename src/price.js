/** ETH-mainnet $SIKKA spot price via GeckoTerminal pool API + fiat FX. */

export const SIKKA_ETH_TOKEN = '0x3931e94dc0afa7d755c2fc91a799ef6b59963a38';
/** Uniswap SIKKA/ETH pool id (bytes32) on GeckoTerminal. */
export const SIKKA_ETH_POOL_ID =
  '0x2898fdc38e4a17907ea1a39eb9be67adb8719c779ba22c7928fc37a6c240d75b';

const GECKO_POOL_URL =
  `https://api.geckoterminal.com/api/v2/networks/eth/pools/${SIKKA_ETH_POOL_ID}`;

const PRICE_CACHE_TTL_MS = 10 * 60 * 1000;
const HTTP_TIMEOUT_MS = 15000;

let cache = null; // { expiresAt, value }
let inflight = null;

function normalizeAddr(addr) {
  return String(addr || '').trim().toLowerCase();
}

/** Extract the 0x address from a GeckoTerminal relationship id (`eth_0x…`). */
function tokenIdToAddress(id) {
  const s = String(id || '');
  const i = s.indexOf('0x');
  return i === -1 ? s : s.slice(i);
}

async function fetchJson(url, opts = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { ...opts, signal: controller.signal });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status} ${url}: ${body.slice(0, 120)}`);
    }
    return await resp.json();
  } finally {
    clearTimeout(t);
  }
}

/**
 * Pick USD / ETH prices for `tokenAddress` from a GeckoTerminal pool payload.
 * Handles SIKKA as either base or quote.
 */
export function priceFromGeckoPool(payload, tokenAddress = SIKKA_ETH_TOKEN) {
  const attrs = payload?.data?.attributes;
  const rel = payload?.data?.relationships;
  if (!attrs) throw new Error('GeckoTerminal pool payload missing attributes');

  const want = normalizeAddr(tokenAddress);
  const baseAddr = normalizeAddr(tokenIdToAddress(rel?.base_token?.data?.id));
  const quoteAddr = normalizeAddr(tokenIdToAddress(rel?.quote_token?.data?.id));

  let usd;
  let eth;
  let ethUsd;
  if (baseAddr === want) {
    usd = Number(attrs.base_token_price_usd);
    eth = Number(attrs.base_token_price_native_currency);
    ethUsd = Number(attrs.quote_token_price_usd);
  } else if (quoteAddr === want) {
    usd = Number(attrs.quote_token_price_usd);
    eth = Number(attrs.quote_token_price_native_currency);
    ethUsd = Number(attrs.base_token_price_usd);
  } else {
    throw new Error(`GeckoTerminal pool does not contain token ${tokenAddress}`);
  }

  if (!Number.isFinite(usd) || usd <= 0) throw new Error('GeckoTerminal USD price missing');
  if (!Number.isFinite(eth) || eth <= 0) throw new Error('GeckoTerminal native price missing');
  if (!Number.isFinite(ethUsd) || ethUsd <= 0) ethUsd = usd / eth;

  return { usd, eth, ethUsd };
}

async function fetchUsdFx() {
  const j = await fetchJson('https://open.er-api.com/v6/latest/USD');
  if (j.result !== 'success' || !j.rates) throw new Error('could not fetch FX rates');
  const { INR, AED, THB, CNY } = j.rates;
  if (![INR, AED, THB, CNY].every((x) => Number.isFinite(Number(x)) && Number(x) > 0)) {
    throw new Error('FX rates missing INR/AED/THB/CNY');
  }
  return { INR: Number(INR), AED: Number(AED), THB: Number(THB), CNY: Number(CNY) };
}

async function fetchFreshPrice() {
  const [gecko, fx] = await Promise.all([
    fetchJson(GECKO_POOL_URL, {
      headers: { Accept: 'application/json;version=20230203' },
    }),
    fetchUsdFx(),
  ]);
  const spot = priceFromGeckoPool(gecko, SIKKA_ETH_TOKEN);

  return {
    symbol: 'SIKKA',
    chain: 'ETH',
    token: SIKKA_ETH_TOKEN,
    usd: spot.usd,
    inr: spot.usd * fx.INR,
    aed: spot.usd * fx.AED,
    thb: spot.usd * fx.THB,
    cny: spot.usd * fx.CNY,
    eth: spot.eth,
    ethUsd: spot.ethUsd,
    fetchedAt: Date.now(),
  };
}

/** Spot price of ETH-mainnet SIKKA in USD / INR / AED / THB / CNY. Cached 10 minutes. */
export async function getSikkaEthPrice() {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.value;

  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const value = await fetchFreshPrice();
      cache = { expiresAt: Date.now() + PRICE_CACHE_TTL_MS, value };
      return value;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/** Format a fiat amount for Telegram display. */
export function formatFiat(n) {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  let digits;
  if (abs >= 1000) digits = 2;
  else if (abs >= 1) digits = 4;
  else if (abs >= 0.01) digits = 6;
  else digits = 8;
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  });
}
