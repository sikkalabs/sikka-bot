/** ETH-mainnet $SIKKA spot price via Uniswap V4 StateView + fiat FX. */

import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export const SIKKA_ETH_TOKEN = '0xbab5a2cc8c9eb4042eeae289b26b66166cf04a81';
/** Uniswap V4 SIKKA/ETH 2% pool id (bytes32). */
export const SIKKA_ETH_POOL_ID =
  '0xdb2b1a10f3039bce4777400a451db3ed6d920d6df533f12c904abcf74cd6f7d5';
/** Uniswap V4 StateView on Ethereum mainnet. */
const STATE_VIEW = '0x7ffe42c4a5deea5b0fec41c94c136cf115597227';

const SIKKA_DECIMALS = 9;
const ETH_DECIMALS = 18;
const PRICE_CACHE_TTL_MS = 10 * 60 * 1000;
const HTTP_TIMEOUT_MS = 15000;

const RPC_URLS = [
  'https://ethereum.publicnode.com',
  'https://cloudflare-eth.com',
  'https://1rpc.io/eth',
];

let cache = null; // { expiresAt, value }
let inflight = null;

function selector(sig) {
  return bytesToHex(keccak_256(new TextEncoder().encode(sig))).slice(0, 8);
}

const GET_SLOT0 = selector('getSlot0(bytes32)');

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

async function ethCall(to, data) {
  let lastErr;
  for (const rpc of RPC_URLS) {
    try {
      const j = await fetchJson(rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_call',
          params: [{ to, data }, 'latest'],
        }),
      });
      if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
      if (!j.result || j.result === '0x') throw new Error('empty eth_call result');
      return j.result;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`eth_call failed: ${lastErr?.message || lastErr}`);
}

/**
 * Uniswap V4 currency order: native ETH (address(0)) is token0, SIKKA is token1.
 * Returns ETH per 1 SIKKA (human units).
 */
function ethPerSikkaFromSqrtPriceX96(sqrtPriceX96) {
  // token0=ETH, token1=SIKKA. amount0 = amount1 * 2^192 / sqrtPriceX96^2
  const den = sqrtPriceX96 * sqrtPriceX96;
  const amount0Wei = (10n ** BigInt(SIKKA_DECIMALS) * 2n ** 192n) / den;
  return Number(amount0Wei) / 10 ** ETH_DECIMALS;
}

async function fetchEthUsd() {
  // Prefer Binance (no key); fall back to CoinGecko.
  try {
    const j = await fetchJson('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT');
    const n = Number(j.price);
    if (Number.isFinite(n) && n > 0) return n;
  } catch (_) {}
  const j = await fetchJson(
    'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd',
  );
  const n = Number(j?.ethereum?.usd);
  if (!Number.isFinite(n) || n <= 0) throw new Error('could not fetch ETH/USD');
  return n;
}

async function fetchUsdFx() {
  const j = await fetchJson('https://open.er-api.com/v6/latest/USD');
  if (j.result !== 'success' || !j.rates) throw new Error('could not fetch FX rates');
  const { INR, AED, THB } = j.rates;
  if (![INR, AED, THB].every((x) => Number.isFinite(Number(x)) && Number(x) > 0)) {
    throw new Error('FX rates missing INR/AED/THB');
  }
  return { INR: Number(INR), AED: Number(AED), THB: Number(THB) };
}

async function fetchFreshPrice() {
  const result = await ethCall(STATE_VIEW, '0x' + GET_SLOT0 + SIKKA_ETH_POOL_ID.slice(2));
  const sqrtPriceX96 = BigInt('0x' + result.slice(2, 66));
  if (sqrtPriceX96 === 0n) throw new Error('pool sqrtPriceX96 is zero');

  const [ethUsd, fx] = await Promise.all([fetchEthUsd(), fetchUsdFx()]);
  const eth = ethPerSikkaFromSqrtPriceX96(sqrtPriceX96);
  const usd = eth * ethUsd;

  return {
    symbol: 'SIKKA',
    chain: 'ETH',
    token: SIKKA_ETH_TOKEN,
    usd,
    inr: usd * fx.INR,
    aed: usd * fx.AED,
    thb: usd * fx.THB,
    eth,
    ethUsd,
    fetchedAt: Date.now(),
  };
}

/** Spot price of ETH-mainnet SIKKA in USD / INR / AED / THB. Cached 10 minutes. */
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
