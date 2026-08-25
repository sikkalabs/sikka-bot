/** Server-rendered $SIKKA price card PNG (minimal, USD only). */

import { createCanvas } from '@napi-rs/canvas';

const W = 1200;
const H = 630;

const BG = '#0a0d12';
const ACCENT = '#22c55e';
const TEXT = '#f4f6f8';
const MUTED = '#8b949e';

function pickFont(c) {
  const families = ['DejaVu Sans', 'Liberation Sans', 'Noto Sans', 'Arial', 'sans-serif'];
  return families.find((f) => {
    try {
      return c.fontFamilyIsAvailable?.(f) ?? true;
    } catch (_) {
      return false;
    }
  });
}

/** USD with exactly 3 decimals (e.g. "0.013"). */
export function formatUsd3(n) {
  if (!Number.isFinite(n)) return '—';
  return Number(n).toLocaleString('en-US', {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  });
}

/**
 * Render the card and resolve to a PNG Buffer.
 * @param {number} usd spot price in USD
 */
export async function renderPriceCard(usd) {
  const canvas = createCanvas(W, H);
  const c = canvas.getContext('2d');

  // Background
  c.fillStyle = BG;
  c.fillRect(0, 0, W, H);

  // Subtle accent glow
  const glow = c.createRadialGradient(W * 0.5, H * 1.05, 40, W * 0.5, H * 1.05, W * 0.75);
  glow.addColorStop(0, 'rgba(34,197,94,0.16)');
  glow.addColorStop(1, 'rgba(34,197,94,0)');
  c.fillStyle = glow;
  c.fillRect(0, 0, W, H);

  // Top hairline
  c.fillStyle = 'rgba(34,197,94,0.55)';
  c.fillRect(0, 0, W, 4);

  const fam = pickFont(c);

  // Label
  c.fillStyle = MUTED;
  c.font = `600 34px ${fam}`;
  c.textBaseline = 'alphabetic';
  c.fillText('$SIKKA', 80, 130);

  // Big USD price, 3 decimals
  const price = `$${formatUsd3(usd)}`;
  c.fillStyle = TEXT;
  c.font = `700 168px ${fam}`;
  c.fillText(price, 72, 330);

  // Underline accent under the price
  c.fillStyle = ACCENT;
  c.fillRect(80, 368, 120, 6);

  // Footer
  c.fillStyle = MUTED;
  c.font = `400 28px ${fam}`;
  c.fillText('Spot · Ethereum mainnet · Uniswap', 80, H - 70);
  c.textAlign = 'right';
  c.fillText('sikkalabs.com', W - 80, H - 70);
  c.textAlign = 'left';

  return canvas.encode('png');
}
