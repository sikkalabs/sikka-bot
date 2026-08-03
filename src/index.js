import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import dotenv from 'dotenv';
import { initDB, canClaim, recordClaim, createRaffle, getActiveRaffle, addRaffleEntry, removeRaffleEntry, getRaffleEntries, hasUserJoinedRaffle, closeRaffle, cancelRaffle, getRecentRaffles, getRaffleById, setRaffleTime, canStartRaffle, createRain, getActiveRain, addRainClaim, addRainClaimTx, removeRainClaim, getRainClaims, hasUserClaimedRain, closeRain } from './db.js';
import { selectBestNodeURL } from './api.js';
import {
  SikkaClient,
  createWallet,
  formatSikka as formatSikkaAmount,
  parseSikka,
  CHILLAR_PER_SIKKA,
  asBig,
  getBatteryPercent,
} from './sikka_client.js';
import { validateAddress, addressRe } from './address.js';
import { getSikkaEthPrice, formatFiat } from './price.js';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';

// Auto-delete TTL for group messages (replies & announcements). Telegram allows
// deleting messages up to 48h after sending — 5 min keeps the group tidy.
const GROUP_MSG_TTL_SEC = 300;

// Helper: delete a message after delaySec if it's in a group chat (never delete in private DM chats)
function deleteLater(telegram, chatId, messageId, delaySec = GROUP_MSG_TTL_SEC) {
  if (!chatId || !messageId) return;
  if (typeof chatId === 'number' && chatId > 0) return;
  if (typeof chatId === 'string' && !chatId.startsWith('-')) return;

  setTimeout(async () => {
    try { await telegram.deleteMessage(chatId, messageId); } catch (_) {}
  }, delaySec * 1000);
}

// Helper: send a reply then delete both the trigger and the reply after `delaySec` seconds in group chats. Never delete in one-on-one (private) chats.
async function replyThenDelete(ctx, text, opts = {}, delaySec = GROUP_MSG_TTL_SEC) {
  const reply = await ctx.reply(text, opts);
  if (ctx.chat?.type === 'private') {
    return reply;
  }
  const chatId = ctx.chat.id;
  const triggerMsgId = ctx.message?.message_id;
  setTimeout(async () => {
    try { await ctx.telegram.deleteMessage(chatId, reply.message_id); } catch (_) {}
    if (triggerMsgId) {
      try { await ctx.telegram.deleteMessage(chatId, triggerMsgId); } catch (_) {}
    }
  }, delaySec * 1000);
  return reply;
}

dotenv.config();

const subunitsPerSikka = CHILLAR_PER_SIKKA; // 1 SIKKA = 10⁹ CHILLAR
const airdropDivisor = 2000n;

// ─── Rain constants ─────────────────────────────────────────────────────────
const MIN_RAIN_SHARE = 10_000_000n; // 0.01 SIKKA — smallest drop we pay out
// Rain pays every drop DIRECTLY from the starter's wallet to the claimant
// (same as /tip), so the bot wallet's battery is never touched. Each drop still
// burns ~1 credit from the starter's wallet (pool maxes at 100), so cap the
// number of drops at 80 to keep a single rain within the starter's battery.
const MAX_RAIN_PAYOUTS = 80;
const RAIN_TIMEOUT_SEC = 5 * 60; // rain auto-closes after 5 min if not fully claimed

// Ordinal suffix for rain drop numbering: 1st, 2nd, 3rd, 4th, ...
function rainOrdinal(i) {
  const n = i + 1;
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// Geometric payout schedule: each drop is half of the remaining pot (floored),
// stopping once the next drop would fall below MIN_RAIN_SHARE or the requested
// person count is reached. The tail is always refunded to the starter.
function computeRainSchedule(pot, persons) {
  const shares = [];
  let remainder = pot;
  let i = 0;
  while (i < persons && remainder >= 2n * MIN_RAIN_SHARE) {
    const share = remainder / 2n;
    shares.push(share);
    remainder -= share;
    i++;
  }
  return { shares, leftover: remainder };
}

function formatSikkaDisplay(chillar) {
  const c = asBig(chillar);
  const abs = c < 0n ? -c : c;
  if (abs > 0n && abs < subunitsPerSikka) {
    return `${c} chillar`;
  }
  return `${formatSikkaAmount(c)} SIKKA`;
}

function getBatteryIcon(pct) {
  if (pct <= 20) return '🪫';
  return '🔋';
}

function humanizeSendError(err) {
  const msg = err.message || '';

  if (/insufficient credits|insufficient battery/i.test(msg)) {
    return `Not enough transaction battery. Please wait a minute and try again.`;
  }

  if (msg.includes('faucet is empty') || msg.includes('balance too low') || /insufficient balance/i.test(msg)) {
    return `Insufficient balance for this send. Top up or try a smaller amount.`;
  }

  if (/bad nonce|nonce/i.test(msg)) {
    return `Nonce conflict — another send may still be pending. Wait a moment and retry.`;
  }

  const clean = msg.replace(/:\s*\{.*\}/s, '').trim();
  return `Something went wrong: ${clean}`;
}

function getUserWallet(userId) {
  const privKeyHex = process.env.PRIVATEKEY || process.env.privatekey;
  if (!privKeyHex) throw new Error("PRIVATEKEY env var is required for user wallet derivation");
  // Deterministic 32-byte seed per Telegram user (custodial).
  const derivedHex = crypto.createHash('sha256').update(privKeyHex + String(userId)).digest('hex');
  return createWallet(derivedHex);
}

async function sendAirdrop(nodeURL, wallet, recipientAddr) {
  const client = new SikkaClient({ nodeURL, wallet });
  const balance = await client.balance();
  
  if (BigInt(balance) === 0n) {
    throw new Error("faucet is empty");
  }
  
  const amount = BigInt(balance) / airdropDivisor;
  if (amount < 1n) {
    throw new Error(`faucet balance too low to send (0.05% = ${amount} chillar)`);
  }
  
  console.log(`Sending airdrop to ${recipientAddr} via ${nodeURL}...`);
  const { txID, sentAmount } = await client.send(amount, recipientAddr);
  return { txID, sentAmount };
}

async function main() {
  const nodeURLsRaw = process.env.SIKKANODE || process.env.sikkanode;
  const privKeyHex = process.env.PRIVATEKEY || process.env.privatekey;
  const telegramToken = process.env.TELEGRAMTOKEN || process.env.telegramtoken;
  const telegramGroup = process.env.TELEGRAMGROUP || process.env.telegramgroup;

  if (!nodeURLsRaw) throw new Error("env var 'SIKKANODE' is required");
  if (!privKeyHex) throw new Error("env var 'PRIVATEKEY' is required");
  if (!telegramToken) throw new Error("env var 'TELEGRAMTOKEN' is required");
  if (!telegramGroup) throw new Error("env var 'TELEGRAMGROUP' is required");
  
  const nodeURLs = nodeURLsRaw.split(',').map(s => s.trim()).filter(Boolean);
  const selectedNodeURL = await selectBestNodeURL(nodeURLs);
  console.log(`Using Sikka node: ${selectedNodeURL}`);
  
  const wallet = createWallet(privKeyHex);
  console.log(`Faucet address: ${wallet.address}`);
  
  const dbPath = path.join(process.cwd(), 'claims.db');
  const db = await initDB(dbPath);
  console.log(`Database initialized at ${dbPath}`);
  
  const bot = new Telegraf(telegramToken);

  // Normalise command case — Telegram sends the command text verbatim, so
  // /Claim would not match bot.command('claim'). Lowercase just the command
  // token (preserving any @botname and overall length so entity offsets stay valid).
  //
  // Also: Telegram delivers every command in a group to every bot in the chat,
  // but Telegraf's bot.command() rejects commands whose @botname suffix doesn't
  // match this bot's username (e.g. /join@sikkalabsbot on a bot that is
  // @sikkawalletbot). Override ctx.me so any @botname suffix is accepted —
  // matching how the /me rain handler already behaves.
  bot.use((ctx, next) => {
    const msg = ctx.message;
    const entity = msg?.entities?.[0];
    if (msg?.text && entity?.type === 'bot_command' && entity.offset === 0) {
      const cmd = msg.text.slice(0, entity.length);
      const at = cmd.indexOf('@');
      const cmdPart = at === -1 ? cmd : cmd.slice(0, at);
      const rest = at === -1 ? '' : cmd.slice(at);
      if (cmdPart !== cmdPart.toLowerCase()) {
        msg.text = cmdPart.toLowerCase() + rest + msg.text.slice(entity.length);
      }
      if (at !== -1) {
        Object.defineProperty(ctx, 'me', {
          value: cmd.slice(at + 1),
          configurable: true,
          enumerable: true,
        });
      }
    }
    return next();
  });

  // ── Help renderer ────────────────────────────────────────────────────────
  // Returns HTML-formatted help text tailored to where the command was sent.
  function helpText(isPrivate) {
    if (isPrivate) {
      return (
        `👛 <b>Sikka Wallet</b>\n` +
        `<i>Your personal on-chain wallet, right in Telegram.</i>\n\n` +

        `<b>┌─ 📥 Receive ─────────────────┐</b>\n` +
        `  /deposit\n` +
        `  Get your personal SIKKA address\n\n` +

        `<b>┌─ 📊 Balance ─────────────────┐</b>\n` +
        `  /balance\n` +
        `  Check your current balance\n\n` +

        `<b>┌─ 📤 Send ────────────────────┐</b>\n` +
        `  <code>/send &lt;amount&gt; &lt;0x…&gt;</code>\n` +
        `  <code>/send all &lt;0x…&gt;</code>\n` +
        `  <code>/sendall &lt;0x…&gt;</code>\n\n` +

        `<b>──────────────────────────────</b>\n` +
        `🎰 <i>Head to the group for faucet, raffle &amp; tips</i>`
      );
    }

    return (
      `🤖 <b>Sikka Bot</b>\n` +
      `<i>Commands available in this group</i>\n\n` +

      `<b>┌─ 💧 Faucet ──────────────────┐</b>\n` +
      `  <code>/claim</code> — Free SIKKA to your wallet\n` +
      `  <code>/claim &lt;0x…&gt;</code> — Free SIKKA to any address\n\n` +

      `<b>┌─ 🎰 Raffle ──────────────────┐</b>\n` +
      `  <code>/raffle</code> — Live pot &amp; countdown\n` +
      `  <code>/raffle &lt;fee&gt;</code> — Start a raffle\n` +
      `  <i>  min 1 SIKKA · 10 min cooldown between raffles · admins exempt</i>\n` +
      `  <code>/join</code> — Enter the active raffle\n` +
      `  <code>/rafflelist</code> — Last 5 results\n` +
      `  <code>/cancel</code> — Cancel raffle <i>(admin only)</i>\n\n` +

      `<b>┌─ 💸 Tips ────────────────────┐</b>\n` +
      `  <code>/tip @username &lt;amount&gt;</code>\n` +
      `  Send SIKKA to any group member\n\n` +

      `<b>┌─ 🌧 Rain ────────────────────┐</b>\n` +
      `  <code>/rain &lt;amount&gt; [&lt;persons&gt;]</code>\n` +
      `  Drop SIKKA — first to /me grabs a share\n` +
      `  <i>  default 10 drops · halves each time · min drop 0.01</i>\n\n` +

      `<b>┌─ 📈 Price ───────────────────┐</b>\n` +
      `  <code>/price</code> — ETH-mainnet $SIKKA in USD / INR / AED / THB\n\n` +

      `<b>──────────────────────────────</b>\n` +
      `👛 <i>DM @sikkalabsbot for wallet commands</i>\n\n` +
      `🌐 <a href="https://sikkalabs.com/">sikkalabs.com</a>`
    );
  }

  bot.command(['start', 'help', 'sikka'], (ctx) => {
    const isPrivate = ctx.chat.type === 'private';
    // In a group, only respond to the configured group
    if (!isPrivate && String(ctx.chat.id) !== telegramGroup) return;
    replyThenDelete(ctx, helpText(isPrivate), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  });

  // /x & /tweet — random tweet from tweets.txt in a copy-paste code block,
  // plus a link to live $SIKKA tweets on X.
  const TWEETS_PATH = path.join(process.cwd(), 'tweets.txt');
  const TWEET_SEARCH_URL = 'https://x.com/search?q=%24SIKKA&src=typed_query&f=live';

  function randomTweet() {
    const lines = fs.readFileSync(TWEETS_PATH, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return null;
    return lines[crypto.randomInt(lines.length)];
  }

  bot.command(['x', 'tweet'], (ctx) => {
    if (String(ctx.chat.id) !== telegramGroup) return;
    const tweet = randomTweet();
    if (!tweet) {
      return replyThenDelete(ctx, 'No tweets found in tweets.txt.', { reply_parameters: { message_id: ctx.message.message_id } });
    }
    const text =
      `🐦 *Random #SIKKA tweet*\n\n` +
      '```\n' + tweet + '\n```\n\n' +
      `🔍 [See recent tweets](${TWEET_SEARCH_URL})`;
    replyThenDelete(ctx, text, { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } });
  });

  // /price — ETH-mainnet $SIKKA spot (Uniswap V4), cached 10 min.
  bot.command('price', async (ctx) => {
    const isPrivate = ctx.chat.type === 'private';
    if (!isPrivate && String(ctx.chat.id) !== telegramGroup) return;
    const replyOpts = { reply_parameters: { message_id: ctx.message.message_id }, parse_mode: 'HTML' };
    try {
      const p = await getSikkaEthPrice();
      const ageMin = Math.floor((Date.now() - p.fetchedAt) / 60000);
      const cacheNote = ageMin <= 0 ? 'just now' : `${ageMin}m ago`;
      const text =
        `📈 <b>$SIKKA</b> <i>(ETH)</i>\n\n` +
        `🇺🇸 <b>USD</b>  $${formatFiat(p.usd)}\n` +
        `🇮🇳 <b>INR</b>  ₹${formatFiat(p.inr)}\n` +
        `🇦🇪 <b>AED</b>  د.إ${formatFiat(p.aed)}\n` +
        `🇹🇭 <b>THB</b>  ฿${formatFiat(p.thb)}\n\n` +
        `<i>Cached ${cacheNote} · refreshes every 10 min</i>`;
      await replyThenDelete(ctx, text, replyOpts);
    } catch (err) {
      await replyThenDelete(ctx, `❌ Could not fetch price: ${err.message}`, replyOpts);
    }
  });


  // /claim — faucet command using the bot wallet.
  // Usage: /claim            → sends to the user's personal wallet
  //        /claim <address>  → sends to a specific sikka address
  bot.command('claim', async (ctx) => {
    if (String(ctx.chat.id) !== telegramGroup) return;
    const userId = ctx.from.id;
    const replyOpts = { reply_parameters: { message_id: ctx.message.message_id }, parse_mode: 'Markdown' };

    // Determine recipient address
    const args = ctx.message.text.split(/\s+/).slice(1);
    let recipientAddr;
    if (args.length === 0) {
      // No address given — use the user's personal wallet
      try {
        const uWallet = getUserWallet(userId);
        recipientAddr = uWallet.address;
      } catch (err) {
        return replyThenDelete(ctx, `❌ Could not resolve your wallet: ${err.message}`, replyOpts);
      }
    } else {
      // Address provided — validate it
      try {
        recipientAddr = validateAddress(args[0]);
      } catch (_) {
        return replyThenDelete(ctx, `❌ Invalid address. Usage: /claim or /claim <0x…>`, replyOpts);
      }
    }

    if (recipientAddr === wallet.address) {
      return replyThenDelete(ctx, `❌ You cannot claim to the faucet wallet itself.`, replyOpts);
    }

    // Cooldown check
    const claimStatus = await canClaim(db, userId);
    if (!claimStatus.ok) {
      const remainingHours = Math.floor(claimStatus.remaining / (60 * 60 * 1000));
      const remainingMins = Math.floor((claimStatus.remaining % (60 * 60 * 1000)) / (60 * 1000));
      return replyThenDelete(
        ctx,
        `⏳ You already claimed recently. Try again in *${remainingHours}h ${remainingMins}m*.`,
        replyOpts
      );
    }

    // Show processing reaction
    try {
      await ctx.telegram.setMessageReaction(ctx.chat.id, ctx.message.message_id, [{ type: 'emoji', emoji: '⏳' }]);
    } catch (_) {}

    try {
      const { txID, sentAmount } = await sendAirdrop(selectedNodeURL, wallet, recipientAddr);
      await recordClaim(db, userId);

      try {
        await ctx.telegram.setMessageReaction(ctx.chat.id, ctx.message.message_id, [{ type: 'emoji', emoji: '🎉' }]);
      } catch (_) {}

      await replyThenDelete(
        ctx,
        `✅ Sent *${formatSikkaDisplay(sentAmount)}* to \`${recipientAddr}\`\nTx: \`${txID}\``,
        replyOpts,
        60
      );
    } catch (err) {
      console.error(`Claim error for userId=${userId}:`, err);
      try {
        await ctx.telegram.setMessageReaction(ctx.chat.id, ctx.message.message_id, [{ type: 'emoji', emoji: '❌' }]);
      } catch (_) {}
      await replyThenDelete(ctx, `❌ ${humanizeSendError(err)}`, replyOpts);
    }
  });

  bot.command('deposit', async (ctx) => {
    if (ctx.chat.type !== 'private') {
      return replyThenDelete(ctx, `🔒 Wallet commands are private! DM @sikkalabsbot and type /deposit to get your deposit address.`, { reply_parameters: { message_id: ctx.message.message_id } });
    }
    try {
      const uWallet = getUserWallet(ctx.from.id);
      await ctx.reply(`Your personal SIKKA deposit address:\n\n\`${uWallet.address}\``, { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.reply(`Error: ${err.message}`);
    }
  });

  bot.command('balance', async (ctx) => {
    if (ctx.chat.type !== 'private') {
      return replyThenDelete(ctx, `🔒 Wallet commands are private! DM @sikkalabsbot and type /balance to check your balance.`, { reply_parameters: { message_id: ctx.message.message_id } });
    }
    try {
      const uWallet = getUserWallet(ctx.from.id);
      const client = new SikkaClient({ nodeURL: selectedNodeURL, wallet: uWallet });
      const account = await client.account();
      const bal = asBig(account.balance);
      const pct = getBatteryPercent(account);
      const batteryIcon = getBatteryIcon(pct);
      await ctx.reply(
        `Your balance: *${formatSikkaDisplay(bal)}*\nBattery: *${batteryIcon} ${pct}%*\n\nAddress:\n\`${uWallet.address}\`\n\n[Open wallet UI](${selectedNodeURL}/wallet.html)`,
        { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } }
      );
    } catch (err) {
      await ctx.reply(`Error: ${err.message}`);
    }
  });

  // /my — your address, balance, battery and a link to your address page.
  // Works anywhere (group or DM): everything shown belongs to the sender.
  bot.command('my', async (ctx) => {
    try {
      const uWallet = getUserWallet(ctx.from.id);
      const client = new SikkaClient({ nodeURL: selectedNodeURL, wallet: uWallet });
      const account = await client.account();
      const bal = asBig(account.balance);
      const pct = getBatteryPercent(account);
      const batteryIcon = getBatteryIcon(pct);
      const addrLink = `https://2.sikkalabs.com/address.html?a=${uWallet.address}`;
      await replyThenDelete(
        ctx,
        `👤 *Your wallet*\n\n` +
        `Balance: *${formatSikkaDisplay(bal)}*\n` +
        `Battery: *${batteryIcon} ${pct}%*\n\n` +
        `Address:\n\`${uWallet.address}\`\n\n` +
        `[View on explorer](${addrLink})`,
        { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } }
      );
    } catch (err) {
      await ctx.reply(`Error: ${err.message}`);
    }
  });

  async function handleWithdraw(ctx, amountStr, addressRaw) {
    const uWallet = getUserWallet(ctx.from.id);
    let address;
    try {
      address = validateAddress(addressRaw);
    } catch {
      return ctx.reply('Invalid address. Expected `0x` + 64 hex characters.', { parse_mode: 'Markdown' });
    }

    let amountChillar;
    if (amountStr.toLowerCase() === 'all') {
      const client = new SikkaClient({ nodeURL: selectedNodeURL, wallet: uWallet });
      amountChillar = await client.balance();
    } else {
      try {
        amountChillar = parseSikka(amountStr);
      } catch {
        return ctx.reply('Invalid amount');
      }
    }

    if (amountChillar === 0n) {
      return ctx.reply('Cannot withdraw 0.');
    }

    try {
      const client = new SikkaClient({ nodeURL: selectedNodeURL, wallet: uWallet });
      const bal = await client.balance();
      if (bal < amountChillar) {
        return ctx.reply(`Insufficient balance. You have ${formatSikkaDisplay(bal)}`);
      }

      const { txID } = await client.send(amountChillar, address);
      await ctx.reply(`Successfully withdrew *${formatSikkaDisplay(amountChillar)}* to \`${address}\`\nTx: \`${txID}\``, { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.reply(humanizeSendError(err), { parse_mode: 'Markdown' });
    }
  }

  bot.command('send', async (ctx) => {
    if (ctx.chat.type !== 'private') {
      return replyThenDelete(ctx, `🔒 Wallet commands are private! DM @sikkalabsbot to send funds.`, { reply_parameters: { message_id: ctx.message.message_id } });
    }
    const args = ctx.message.text.split(/\s+/).slice(1);
    if (args.length !== 2) {
      return ctx.reply('Usage: /send <amount> <0x…>\nExample: /send 5 0xabc…\n(You can also use /send all <0x…>)');
    }
    await handleWithdraw(ctx, args[0], args[1]);
  });

  bot.command('sendall', async (ctx) => {
    if (ctx.chat.type !== 'private') {
      return replyThenDelete(ctx, `🔒 Wallet commands are private! DM @sikkalabsbot to send funds.`, { reply_parameters: { message_id: ctx.message.message_id } });
    }
    const args = ctx.message.text.split(/\s+/).slice(1);
    if (args.length !== 1) {
      return ctx.reply('Usage: /sendall <0x…>');
    }
    await handleWithdraw(ctx, 'all', args[0]);
  });


  // TIP LOGIC
  async function handleTip(ctx, recipientId, recipientName, amountStr) {
    const senderId = ctx.from.id;
    const replyOpts = { reply_parameters: { message_id: ctx.message.message_id }, parse_mode: 'Markdown' };

    if (senderId === recipientId) {
      return replyThenDelete(ctx, `❌ You can't tip yourself!`, replyOpts);
    }

    let amountChillar;
    try {
      amountChillar = parseSikka(amountStr);
    } catch {
      return replyThenDelete(ctx, `❌ Invalid amount. Usage: /tip @username 5`, replyOpts);
    }
    if (amountChillar <= 0n) {
      return replyThenDelete(ctx, `❌ Invalid amount. Usage: /tip @username 5`, replyOpts);
    }

    try {
      const senderWallet = getUserWallet(senderId);

      const senderClient = new SikkaClient({ nodeURL: selectedNodeURL, wallet: senderWallet });
      const bal = await senderClient.balance();

      if (bal < amountChillar) {
        ctx.telegram.sendMessage(
          senderId,
          `💳 *You tried to tip ${formatSikkaDisplay(amountChillar)} but only have ${formatSikkaDisplay(bal)}.*\n\nYour deposit address:\n\`${senderWallet.address}\``,
          { parse_mode: 'Markdown' }
        ).catch(() => {});
        return replyThenDelete(
          ctx,
          `❌ Insufficient balance. You have *${formatSikkaDisplay(bal)}* but tried to tip *${formatSikkaDisplay(amountChillar)}*.\n📩 Check your DMs for your deposit address!`,
          replyOpts
        );
      }

      const recipientWallet = getUserWallet(recipientId);
      const { txID } = await senderClient.send(amountChillar, recipientWallet.address);

      // Public confirmation in group
      await replyThenDelete(
        ctx,
        `💸 *${ctx.from.first_name}* tipped *${recipientName}* **${formatSikkaDisplay(amountChillar)}**!\n\nTx: \`${txID}\``,
        replyOpts
      );

      // Private notification to recipient
      ctx.telegram.sendMessage(
        recipientId,
        `🎉 You received a tip of *${formatSikkaDisplay(amountChillar)}* from *${ctx.from.first_name}*!\n\nIt's now in your wallet:\n\`${recipientWallet.address}\``,
        { parse_mode: 'Markdown' }
      ).catch(() => {}); // Silently ignore if recipient hasn't started bot in DM
    } catch (err) {
      console.error('Tip error:', err);
      await replyThenDelete(ctx, humanizeSendError(err), replyOpts);
    }
  }

  bot.command('tip', async (ctx) => {
    if (String(ctx.chat.id) !== telegramGroup) return;
    const replyOpts = { reply_parameters: { message_id: ctx.message.message_id } };

    const entities = ctx.message.entities || [];
    const mentionEntity = entities.find(e => e.type === 'mention');

    if (!mentionEntity) {
      return replyThenDelete(ctx, `❌ Usage: /tip @username 100\nOnly users with a @username can be tipped.`, replyOpts);
    }

    // Extract the @username from the message text
    const username = ctx.message.text.slice(
      mentionEntity.offset, mentionEntity.offset + mentionEntity.length
    ); // e.g. "@john"

    // Resolve user ID from cache (populated from group messages)
    let recipientId, recipientName;
    const cached = usernameCache.get(username.replace('@', '').toLowerCase());
    if (cached) {
      recipientId = cached.id;
      recipientName = cached.firstName;
    } else {
      return replyThenDelete(
        ctx,
        `❌ Couldn't resolve ${username}. They need to send a message in the group first so the bot can see them.`,
        replyOpts
      );
    }

    // Amount is the last token
    const args = ctx.message.text.trim().split(/\s+/);
    const amountStr = args[args.length - 1];

    await handleTip(ctx, recipientId, recipientName, amountStr);
  });

  // /raffle — anyone can start one, but only once every 3 hours.
  // Admins bypass the cooldown. Minimum entry fee: 1 SIKKA.
  const MIN_RAFFLE_FEE = subunitsPerSikka; // 1 SIKKA

  bot.command('raffle', async (ctx) => {
    if (String(ctx.chat.id) !== telegramGroup) return;
    const replyOpts = { reply_parameters: { message_id: ctx.message.message_id } };
    try {
      const args = ctx.message.text.split(/\s+/).slice(1).filter(Boolean);

      // No args → show current raffle status (replaces the old /prize command)
      if (args.length === 0) {
        const active = await getActiveRaffle(db);
        if (!active) return replyThenDelete(ctx, 'No active raffle right now.', replyOpts);

        const entries = await getRaffleEntries(db, active.id);
        const entryFee = BigInt(active.entry_fee);
        const totalPool = entryFee * BigInt(entries.length);
        const prize = totalPool - (totalPool * 5n / 100n);
        const now = Math.floor(Date.now() / 1000);
        const timeText = Number(active.end_time) === 0
          ? 'Waiting for 2 players to start...'
          : (() => { const s = Math.max(0, active.end_time - now); return `${Math.floor(s/60)}m ${s%60}s`; })();

        const text =
          `🏆 **Current Raffle** 🏆\n\n` +
          `👥 Players: ${entries.length}\n` +
          `💰 Pool: ${formatSikkaDisplay(totalPool)}\n` +
          `🎁 Prize (−5%): ${formatSikkaDisplay(prize)}\n\n` +
          `⏳ **${timeText}**\n\n` +
          `👉 /join@sikkalabsbot to enter!`;

        const sent = await replyThenDelete(ctx, text, { parse_mode: 'Markdown' });
        lastPrizeMsgId = sent.message_id;
        return;
      }

      if (args.length !== 1) {
        return replyThenDelete(ctx, 'Usage: /raffle <entry fee in SIKKA>\nExample: /raffle 5', replyOpts);
      }

      let entryFee;
      try {
        entryFee = parseSikka(args[0]);
      } catch {
        return replyThenDelete(ctx, '❌ Entry fee must be a positive number of SIKKA.', replyOpts);
      }
      if (entryFee <= 0n) {
        return replyThenDelete(ctx, '❌ Entry fee must be a positive number of SIKKA.', replyOpts);
      }
      if (entryFee < MIN_RAFFLE_FEE) {
        return replyThenDelete(ctx, `❌ Minimum entry fee is *1 SIKKA*.`, { parse_mode: 'Markdown', ...replyOpts });
      }

      const active = await getActiveRaffle(db);
      if (active) return replyThenDelete(ctx, '⚠️ A raffle is already active! Wait for it to finish.', replyOpts);

      // Check if user is admin — admins skip the cooldown
      const chatAdmins = await ctx.getChatAdministrators();
      const isAdmin = chatAdmins.some(a => a.user.id === ctx.from.id);

      if (!isAdmin) {
        const cooldown = await canStartRaffle(db);
        if (!cooldown.ok) {
          const m = Math.floor(cooldown.remaining / (60 * 1000));
          const s = Math.floor((cooldown.remaining % (60 * 1000)) / 1000);
          return replyThenDelete(
            ctx,
            `⏳ A raffle just ended. Please wait *${m}m ${s}s* before starting a new one.`,
            { parse_mode: 'Markdown', ...replyOpts }
          );
        }
      }

      // Auto-join the creator as player 1 — check balance first
      const creatorId = ctx.from.id;
      const creatorWallet = getUserWallet(creatorId);
      const creatorClient = new SikkaClient({ nodeURL: selectedNodeURL, wallet: creatorWallet });
      const creatorBal = await creatorClient.balance();

      if (creatorBal < entryFee) {
        // Can't afford their own raffle — abort before creating it
        ctx.telegram.sendMessage(
          creatorId,
          `💳 *You need ${formatSikkaDisplay(entryFee)} to start this raffle (you're auto-joined as player 1).*\n\nYour deposit address:\n\`${creatorWallet.address}\`\n\nTop up and try again!`,
          { parse_mode: 'Markdown' }
        ).catch(() => {});
        return replyThenDelete(
          ctx,
          `❌ You don't have enough balance to start this raffle.\nYou need *${formatSikkaDisplay(entryFee)}* (entry fee for player 1), but have *${formatSikkaDisplay(creatorBal)}*.\n📩 Check your DMs for your deposit address!`,
          { parse_mode: 'Markdown', ...replyOpts }
        );
      }

      const raffleId = await createRaffle(db, entryFee.toString(), 0);

      // Record creator as player 1 and collect their fee
      await addRaffleEntry(db, raffleId, creatorId);
      let creatorTxID;
      try {
        const result = await creatorClient.send(entryFee, wallet.address);
        creatorTxID = result.txID;
      } catch (sendErr) {
        await removeRaffleEntry(db, raffleId, creatorId);
        await cancelRaffle(db, raffleId);
        return replyThenDelete(ctx, humanizeSendError(sendErr), { parse_mode: 'Markdown', ...replyOpts });
      }

      const creatorTag = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
      await replyThenDelete(
        ctx,
        `🎟 *New Raffle Started!* 🎟\n\nStarted by: ${creatorTag}\nEntry Fee: *${formatSikkaDisplay(entryFee)}*\n\n✅ ${creatorTag} joined as player 1!\nTx: \`${creatorTxID}\`\n\nJoin with /join — waiting for 1 more player to start the timer!`,
        { parse_mode: 'Markdown' }
      );

      // Auto-post live prize board showing 1 participant already in
      const initialPool = entryFee;
      const initialPrize = initialPool - (initialPool * 5n / 100n);
      const prizeText =
        `🏆 **Current Raffle Info** 🏆\n\n` +
        `👥 Participants: 1\n` +
        `💰 Total Pool: ${formatSikkaDisplay(initialPool)}\n` +
        `🎁 Prize (Minus 5%): ${formatSikkaDisplay(initialPrize)}\n\n` +
        `⏳ Time Left: **Waiting for 1 more player to start...**\n\n` +
        `👉 /join@sikkalabsbot to enter!`;
      const prizeMsg = await bot.telegram.sendMessage(telegramGroup, prizeText, { parse_mode: 'Markdown' });
      lastPrizeMsgId = prizeMsg.message_id;
      deleteLater(bot.telegram, telegramGroup, prizeMsg.message_id, GROUP_MSG_TTL_SEC);
    } catch (err) {
      console.error(err);
      replyThenDelete(ctx, `Error: ${err.message}`, replyOpts);
    }
  });

  bot.command('join', async (ctx) => {
    if (String(ctx.chat.id) !== telegramGroup) return;

    const userId = ctx.from.id;
    const replyOpts = { reply_parameters: { message_id: ctx.message.message_id } };

    // Fix #1: per-user lock — prevents two concurrent /join messages from the
    // same user both passing hasUserJoinedRaffle before either writes to the DB.
    if (joiningUsers.has(userId)) {
      return replyThenDelete(ctx, "Please wait, your previous join is still processing.", replyOpts);
    }
    joiningUsers.add(userId);

    try {
      const active = await getActiveRaffle(db);
      if (!active) return replyThenDelete(ctx, "No active raffle to join.", replyOpts);

      const hasJoined = await hasUserJoinedRaffle(db, active.id, userId);
      if (hasJoined) return replyThenDelete(ctx, "You have already joined this raffle!", replyOpts);

      // Fix #5: reject if the raffle timer has already expired
      const now = Math.floor(Date.now() / 1000);
      if (active.end_time > 0 && now >= active.end_time) {
        return replyThenDelete(ctx, "The raffle has just ended — you can no longer join.", replyOpts);
      }

      const entryFee = BigInt(active.entry_fee);
      const uWallet = getUserWallet(userId);
      const client = new SikkaClient({ nodeURL: selectedNodeURL, wallet: uWallet });
      const bal = await client.balance();

      if (bal < entryFee) {
        // Try to DM them the deposit address so they can top up privately.
        // Silently ignored if they haven't started the bot in DM yet.
        ctx.telegram.sendMessage(
          userId,
          `💳 *You need ${formatSikkaDisplay(entryFee)} to join the raffle.*\n\nYour deposit address:\n\`${uWallet.address}\`\n\nSend funds there and then try /join again!`,
          { parse_mode: 'Markdown' }
        ).catch(() => {});

        return replyThenDelete(
          ctx,
          `You don't have enough balance. You need *${formatSikkaDisplay(entryFee)}*, but have *${formatSikkaDisplay(bal)}*.\n📩 Check your DMs for your deposit address!`,
          { parse_mode: 'Markdown', ...replyOpts }
        );
      }

      // Fix #3: record entry in DB FIRST, then send funds.
      // If the send fails, roll back the entry so the user can retry cleanly.
      await addRaffleEntry(db, active.id, userId);

      let txID;
      try {
        const result = await client.send(entryFee, wallet.address);
        txID = result.txID;
      } catch (sendErr) {
        await removeRaffleEntry(db, active.id, userId);
        return replyThenDelete(ctx, humanizeSendError(sendErr), { parse_mode: 'Markdown', ...replyOpts });
      }

      const entries = await getRaffleEntries(db, active.id);
      const newCount = entries.length;
      const nowAfter = Math.floor(Date.now() / 1000);

      if (newCount === 1) {
        // Still waiting for a second player — no timer yet
        await replyThenDelete(ctx, `✅ You joined the raffle!\nWaiting for 1 more player to start the timer.\nTx: ${txID}`, replyOpts, GROUP_MSG_TTL_SEC);
      } else {
        // 2nd player or beyond — always reset clock to exactly 2 mins from now
        const newEndTime = nowAfter + 120;
        await setRaffleTime(db, active.id, newEndTime);

        const msg = newCount === 2
          ? `✅ You joined the raffle!\n\n⏳ Timer started — 2 minutes remaining!\nTx: ${txID}`
          : `✅ You joined the raffle!\n\n⏳ Timer reset — 2 minutes remaining!\nTx: ${txID}`;

        await replyThenDelete(ctx, msg, { parse_mode: 'Markdown', ...replyOpts }, GROUP_MSG_TTL_SEC);
      }
    } catch (err) {
      console.error(err);
      replyThenDelete(ctx, `Error joining: ${err.message}`, replyOpts);
    } finally {
      joiningUsers.delete(userId); // always release the lock
    }
  });



  bot.command('rafflelist', async (ctx) => {
    if (String(ctx.chat.id) !== telegramGroup) return;
    try {
      const recent = await getRecentRaffles(db, 5);
      if (recent.length === 0) return replyThenDelete(ctx, "No past raffles found.");
      
      let msg = "📜 **Last 5 Raffles** 📜\n\n";
      for (const r of recent) {
        msg += `/raffle_${r.id} - Prize: ${formatSikkaDisplay(BigInt(r.prize_amount || 0))}\n`;
      }
      await replyThenDelete(ctx, msg, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error(err);
      replyThenDelete(ctx, `Error: ${err.message}`);
    }
  });

  // Fix #10: /cancel — admin-only, refunds all participants and closes the raffle
  bot.command('cancel', async (ctx) => {
    if (String(ctx.chat.id) !== telegramGroup) return;
    try {
      const chatAdmins = await ctx.getChatAdministrators();
      const isAdmin = chatAdmins.some(admin => admin.user.id === ctx.from.id);
      if (!isAdmin) return replyThenDelete(ctx, "Only admins can cancel a raffle.");

      const active = await getActiveRaffle(db);
      if (!active) return replyThenDelete(ctx, "No active raffle to cancel.");

      const entries = await getRaffleEntries(db, active.id);
      const entryFee = BigInt(active.entry_fee);

      await cancelRaffle(db, active.id);
      await replyThenDelete(ctx, `🚫 Raffle cancelled. Refunding ${entries.length} participant(s)...`);

      // Refund each participant from the faucet wallet
      let refunded = 0;
      let failed = 0;
      for (const participantId of entries) {
        try {
          const pWallet = getUserWallet(participantId);
          const fclient = new SikkaClient({ nodeURL: selectedNodeURL, wallet });
          await fclient.send(entryFee, pWallet.address);
          refunded++;
        } catch (e) {
          console.error(`Refund failed for userId=${participantId}:`, e.message);
          failed++;
        }
      }

      await replyThenDelete(
        ctx,
        `✅ Refund complete.\n\nRefunded: ${refunded}\nFailed: ${failed}` +
        (failed > 0 ? `\n\n⚠️ ${failed} refund(s) failed — funds remain in faucet wallet.` : ``)
      );
    } catch (err) {
      console.error(err);
      replyThenDelete(ctx, `Error: ${err.message}`);
    }
  });

  // Handle dynamic command for raffle details
  bot.hears(/^\/raffle_(\d+)$/, async (ctx) => {
    if (String(ctx.chat.id) !== telegramGroup) return;
    try {
      const rId = parseInt(ctx.match[1]);
      const r = await getRaffleById(db, rId);
      if (!r) return replyThenDelete(ctx, "Raffle not found.");
      
      const entries = await getRaffleEntries(db, r.id);
      
      let msg = `ℹ️ **Raffle #${r.id} Details**\n\n`;
      msg += `Status: ${r.status}\n`;
      msg += `Entry Fee: ${formatSikkaDisplay(BigInt(r.entry_fee))}\n`;
      msg += `Participants: ${entries.length}\n`;
      if (r.winner_id) msg += `Winner ID: ${r.winner_id}\n`;
      if (r.prize_amount) msg += `Prize Won: ${formatSikkaDisplay(BigInt(r.prize_amount))}\n`;
      
      await replyThenDelete(ctx, msg, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error(err);
      replyThenDelete(ctx, `Error: ${err.message}`);
    }
  });

  // /rain — user-funded rain. The first N people to type /me split the pot:
  // drop 1 = half, drop 2 = half of the remainder, and so on, until a drop
  // would fall below 0.01 SIKKA. The starter pays the pot up front; the
  // unclaimed tail is refunded to them when the rain closes.
  bot.command('rain', async (ctx) => {
    if (String(ctx.chat.id) !== telegramGroup) return;
    const replyOpts = { reply_parameters: { message_id: ctx.message.message_id } };
    try {
      const args = ctx.message.text.split(/\s+/).slice(1).filter(Boolean);

      // No args → show current rain status
      if (args.length === 0) {
        const active = await getActiveRain(db);
        if (!active) return replyThenDelete(ctx, 'No active rain right now.', replyOpts);

        const claims = await getRainClaims(db, active.id);
        const schedule = computeRainSchedule(BigInt(active.total_amount), active.persons);
        const paid = claims.reduce((s, c) => s + BigInt(c.share), 0n);
        const now = Math.floor(Date.now() / 1000);
        const left = Math.max(0, RAIN_TIMEOUT_SEC - (now - active.started_at));
        const m = Math.floor(left / 60);
        const s = left % 60;

        return replyThenDelete(
          ctx,
          `🌧 **Active Rain** 🌧\n\n` +
          `Total: *${formatSikkaDisplay(BigInt(active.total_amount))}* · up to *${schedule.shares.length}* drops\n` +
          `☔ Claimed: ${claims.length}/${schedule.shares.length}\n` +
          `🏦 Paid so far: ${formatSikkaDisplay(paid)}\n\n` +
          `⏳ ${m}m ${s}s left — type /me to grab a drop!`,
          { parse_mode: 'Markdown', ...replyOpts }
        );
      }

      if (args.length > 2) {
        return replyThenDelete(ctx, 'Usage: /rain <amount> [<persons>]\nExample: /rain 1 3', replyOpts);
      }

      let pot;
      try {
        pot = parseSikka(args[0]);
      } catch {
        return replyThenDelete(ctx, '❌ Invalid amount. Usage: /rain <amount> [<persons>]', replyOpts);
      }
      if (pot <= 0n) {
        return replyThenDelete(ctx, '❌ Amount must be positive.', replyOpts);
      }
      if (pot < 2n * MIN_RAIN_SHARE) {
        return replyThenDelete(
          ctx,
          `❌ Amount too small — needs at least *${formatSikkaDisplay(2n * MIN_RAIN_SHARE)}* so the first drop is ≥ 0.01 SIKKA.`,
          { parse_mode: 'Markdown', ...replyOpts }
        );
      }

      let persons = 10;
      if (args.length === 2) {
        const n = parseInt(args[1], 10);
        if (!Number.isInteger(n) || n < 1) {
          return replyThenDelete(ctx, '❌ Persons must be a positive whole number.', replyOpts);
        }
        persons = Math.min(n, MAX_RAIN_PAYOUTS);
      }

      const schedule = computeRainSchedule(pot, persons);
      if (schedule.shares.length === 0) {
        return replyThenDelete(ctx, '❌ Amount too small — no drop reaches 0.01 SIKKA.', replyOpts);
      }

      const active = await getActiveRain(db);
      if (active) return replyThenDelete(ctx, '⚠️ A rain is already active! Wait for it to finish.', replyOpts);

      const starterId = ctx.from.id;
      const starterWallet = getUserWallet(starterId);
      const starterClient = new SikkaClient({ nodeURL: selectedNodeURL, wallet: starterWallet });
      const starterBal = await starterClient.balance();

      if (starterBal < pot) {
        ctx.telegram.sendMessage(
          starterId,
          `💳 *You need ${formatSikkaDisplay(pot)} to start this rain.*\n\nYour deposit address:\n\`${starterWallet.address}\`\n\nTop up and try again!`,
          { parse_mode: 'Markdown' }
        ).catch(() => {});
        return replyThenDelete(
          ctx,
          `❌ You don't have enough balance. You need *${formatSikkaDisplay(pot)}*, but have *${formatSikkaDisplay(starterBal)}*.\n📩 Check your DMs for your deposit address!`,
          { parse_mode: 'Markdown', ...replyOpts }
        );
      }

      const rainId = await createRain(db, pot.toString(), schedule.shares.length, starterId);

      // No up-front collection — drops are paid directly from the starter's
      // wallet to each claimant (balance already checked above, and re-checked
      // before every /me payout).
      const dropText = schedule.shares.map((d, i) => `${rainOrdinal(i)} ${formatSikkaDisplay(d)}`).join(' · ');
      const starterTag = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
      await replyThenDelete(
        ctx,
        `🌧 **New Rain!** 🌧\n\n` +
        `${starterTag} is dropping *${formatSikkaDisplay(pot)}* to up to *${schedule.shares.length}* people!\n\n` +
        `Drops: ${dropText}\n\n` +
        `⏳ ${Math.floor(RAIN_TIMEOUT_SEC / 60)} min — type *\/me* to grab a drop!`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      console.error(err);
      replyThenDelete(ctx, `Error: ${err.message}`, replyOpts);
    }
  });

  // Background loop to resolve raffles.
  // Fix #2: isResolvingRaffle is set synchronously (before first await) so any
  // subsequent interval tick that fires while an async resolution is in-flight
  // sees the flag immediately and exits — preventing double prize payout.
  let isResolvingRaffle = false;
  setInterval(async () => {
    if (isResolvingRaffle) return;
    isResolvingRaffle = true;
    try {
      const active = await getActiveRaffle(db);
      if (!active) return;

      const now = Math.floor(Date.now() / 1000);

      // Auto-cancel: raffle open ≥15 min but no 2nd player ever joined (end_time stays 0)
      const NO_PLAYERS_TIMEOUT_SEC = 15 * 60;
      if (
        Number(active.end_time) === 0 &&
        active.created_at &&
        now - active.created_at >= NO_PLAYERS_TIMEOUT_SEC
      ) {
        const entries = await getRaffleEntries(db, active.id);
        await cancelRaffle(db, active.id);

        if (entries.length === 0) {
          bot.telegram.sendMessage(
            telegramGroup,
            `⏰ Raffle auto-cancelled — nobody joined within 15 minutes.`
          ).catch(console.error);
        } else {
          // 1 player joined but a 2nd never came — refund them
          bot.telegram.sendMessage(
            telegramGroup,
            `⏰ Raffle auto-cancelled — not enough players joined within 15 minutes. Refunding ${entries.length} participant(s)...`
          ).catch(console.error);

          const entryFee = BigInt(active.entry_fee);
          for (const participantId of entries) {
            try {
              const pWallet = getUserWallet(participantId);
              const fclient = new SikkaClient({ nodeURL: selectedNodeURL, wallet });
              await fclient.send(entryFee, pWallet.address);
            } catch (e) {
              console.error(`Auto-cancel refund failed for userId=${participantId}:`, e.message);
              bot.telegram.sendMessage(
                telegramGroup,
                `⚠️ Refund failed for one participant — funds remain in faucet wallet.`
              ).catch(console.error);
            }
          }
        }
        return;
      }

      if (active.end_time > 0 && now >= active.end_time) {
        const entries = await getRaffleEntries(db, active.id);
        if (entries.length === 0) {
          await closeRaffle(db, active.id, "none", "0");
          bot.telegram.sendMessage(telegramGroup, "The raffle has ended with no participants! 😢").catch(console.error);
          return;
        }

        const winnerIdx = crypto.randomInt(entries.length); // cryptographically secure
        const winnerId = entries[winnerIdx];

        const entryFee = BigInt(active.entry_fee);
        const totalPool = entryFee * BigInt(entries.length);
        const fee = totalPool * 5n / 100n;
        const prize = totalPool - fee;

        // Close BEFORE announcing so a second tick never sees this raffle as active
        await closeRaffle(db, active.id, winnerId, prize.toString());

        // Resolve winner's display name — prefer @username, fall back to first name
        let winnerName = 'Winner';
        try {
          const member = await bot.telegram.getChatMember(telegramGroup, winnerId);
          const u = member.user;
          winnerName = u.username
            ? `@${u.username}`
            : `${u.first_name}${u.last_name ? ' ' + u.last_name : ''}`;
        } catch (e) {
          console.error('Could not fetch winner name:', e.message);
        }

        const announceMsg = `🎉 **RAFFLE ENDED!** 🎉\n\nWinner: [${winnerName}](tg://user?id=${winnerId})\nPrize: ${formatSikkaDisplay(prize)}!\n\nSending funds...`;
        const sentMsg = await bot.telegram.sendMessage(telegramGroup, announceMsg, { parse_mode: 'Markdown' }).catch(console.error);
        if (sentMsg) deleteLater(bot.telegram, telegramGroup, sentMsg.message_id, GROUP_MSG_TTL_SEC);

        try {
          const winnerWallet = getUserWallet(winnerId);
          const fclient = new SikkaClient({ nodeURL: selectedNodeURL, wallet });
          const { txID } = await fclient.send(prize, winnerWallet.address);
          // Fix #7: guard against sentMsg being undefined if the announce message failed
          const replyParams = sentMsg ? { reply_parameters: { message_id: sentMsg.message_id } } : {};
          bot.telegram.sendMessage(telegramGroup, `✅ Prize sent to winner's wallet!\nTx: \`${txID}\`\n\n🤫 Winner — DM @sikkalabsbot and type /balance to check your funds privately!`, { parse_mode: 'Markdown', ...replyParams }).then(m => deleteLater(bot.telegram, telegramGroup, m.message_id, GROUP_MSG_TTL_SEC)).catch(console.error);
        } catch (e) {
          console.error("Failed to send prize:", e);
          bot.telegram.sendMessage(telegramGroup, `❌ Error sending prize: ${e.message}`).then(m => deleteLater(bot.telegram, telegramGroup, m.message_id, GROUP_MSG_TTL_SEC)).catch(console.error);
        }
      }
    } catch (e) {
      console.error("Raffle resolution error:", e);
    } finally {
      isResolvingRaffle = false;
    }
  }, 5000);

  // Live raffle status — edits the last /prize message every 30s.
  // Auto-posted on raffle creation; also updated when someone types /prize.
  let lastPrizeMsgId = null;
  const usernameCache = new Map(); // username (lowercase, no @) → { id, firstName }

  setInterval(async () => {
    try {
      const active = await getActiveRaffle(db);

      if (!active) {
        lastPrizeMsgId = null; // raffle ended — stop editing
        return;
      }

      if (!lastPrizeMsgId) return; // nobody has typed /prize yet

      const now = Math.floor(Date.now() / 1000);
      const entries = await getRaffleEntries(db, active.id);
      const entryFee = BigInt(active.entry_fee);

      let timeText;
      if (Number(active.end_time) === 0) {
        const needed = Math.max(1, 2 - entries.length);
        timeText = needed === 1 ? 'Waiting for 1 more player...' : 'Waiting for players...';
      } else if (now >= active.end_time) {
        return; // resolver will handle this tick
      } else {
        const timeLeft = active.end_time - now;
        const m = Math.floor(timeLeft / 60);
        const s = timeLeft % 60;
        timeText = `${m}m ${s}s`;
      }

      const totalPool = entryFee * BigInt(entries.length);
      const fee = totalPool * 5n / 100n;
      const prize = totalPool - fee;

      const statusText =
        `🏆 **Current Raffle Info** 🏆\n\n` +
        `👥 Participants: ${entries.length}\n` +
        `💰 Total Pool: ${formatSikkaDisplay(totalPool)}\n` +
        `🎁 Prize (Minus 5%): ${formatSikkaDisplay(prize)}\n\n` +
        `⏳ Time Left: **${timeText}**\n\n` +
        `👉 /join@sikkalabsbot to enter!`;

      await bot.telegram.editMessageText(
        telegramGroup, lastPrizeMsgId, undefined,
        statusText, { parse_mode: 'Markdown' }
      ).catch(() => {
        // Message was deleted — stop trying to edit it
        lastPrizeMsgId = null;
      });
    } catch (e) {
      console.error('Raffle status update error:', e);
    }
  }, 30000);

  // Background loop to resolve rains: close when every drop is paid out, or
  // when the rain times out (unclaimed drops simply stay in the starter's
  // wallet — there's nothing to refund since drops pay directly).
  let isResolvingRain = false;
  setInterval(async () => {
    if (isResolvingRain) return;
    isResolvingRain = true;
    try {
      const active = await getActiveRain(db);
      if (!active) return;

      const claims = await getRainClaims(db, active.id);
      const schedule = computeRainSchedule(BigInt(active.total_amount), active.persons);
      const allPaid = claims.length >= schedule.shares.length && claims.every(c => c.tx_id);
      const timedOut = Math.floor(Date.now() / 1000) - active.started_at >= RAIN_TIMEOUT_SEC;

      if (!allPaid && !timedOut) return;

      // Close BEFORE announcing so a second tick never sees this rain as active
      await closeRain(db, active.id);

      const pot = BigInt(active.total_amount);
      const paid = claims.reduce((s, c) => s + BigInt(c.share), 0n);
      const leftover = pot - paid;

      const reason = allPaid ? 'All drops taken!' : 'Time up!';
      const msg =
        `🌧 **Rain over — ${reason}**\n\n` +
        `☔ Drops claimed: ${claims.length}/${schedule.shares.length}\n` +
        `💰 Total dropped: ${formatSikkaDisplay(paid)}\n` +
        (leftover > 0n
          ? `↩️ Unclaimed: ${formatSikkaDisplay(leftover)} stays in the starter's wallet.\n`
          : '');
      bot.telegram.sendMessage(telegramGroup, msg, { parse_mode: 'Markdown' })
        .then(m => deleteLater(bot.telegram, telegramGroup, m.message_id, GROUP_MSG_TTL_SEC))
        .catch(console.error);
    } catch (e) {
      console.error('Rain resolution error:', e);
    } finally {
      isResolvingRain = false;
    }
  }, 5000);

  const processingUsers = new Set();
  const joiningUsers = new Set(); // per-user lock for /join (Fix #1)
  const claimingRainUsers = new Set(); // per-user lock for /me rain claims

  // Global rain claim lock — serializes slot assignment so two concurrent /me
  // claims can never both grab the same drop (single-process, so an in-process
  // mutex is sufficient). The lock is held only for the read-slot → insert
  // section; the on-chain send happens after the slot is reserved.
  let rainClaimQueue = Promise.resolve();
  function claimRainLocked(fn) {
    const result = rainClaimQueue.then(fn, fn);
    rainClaimQueue = result.then(() => {}, () => {});
    return result;
  }
  
  bot.on(message('text'), async (ctx) => {
    console.log(`Received message from chat ${ctx.chat.id}: ${ctx.message.text}`);
    // Check group
    if (String(ctx.chat.id) !== telegramGroup) {
      console.log(`Ignored message from chat ${ctx.chat.id} (expected ${telegramGroup})`);
      return;
    }

    // Cache sender's username → userId so tips can resolve @mentions reliably
    if (ctx.from?.username) {
      usernameCache.set(ctx.from.username.toLowerCase(), { id: ctx.from.id, firstName: ctx.from.first_name || ctx.from.username });
    }

    const text = ctx.message.text;

    // /me — grab a drop from the active rain (first come, first served).
    // Allow an optional @botname suffix (/me@sikkawalletbot) like Telegram adds
    // when the command is sent from a client that appends it.
    if (/^\/me(@[a-zA-Z0-9_]+)?(\s|$)/.test(text)) {
      const userId = ctx.from.id;
      const opts = { reply_parameters: { message_id: ctx.message.message_id } };
      if (claimingRainUsers.has(userId)) {
        return replyThenDelete(ctx, 'Please wait, your previous claim is still processing.', opts);
      }
      claimingRainUsers.add(userId);
      try {
        // Serialize slot assignment so two concurrent /me claims can never
        // both grab the same drop (the share depends on claim order).
        const claim = await claimRainLocked(async () => {
          const activeNow = await getActiveRain(db);
          if (!activeNow) return { status: 'none' };
          if (await hasUserClaimedRain(db, activeNow.id, userId)) return { status: 'already' };
          const claims = await getRainClaims(db, activeNow.id);
          const schedule = computeRainSchedule(BigInt(activeNow.total_amount), activeNow.persons);
          if (claims.length >= schedule.shares.length) return { status: 'full' };
          const slot = claims.length;
          const share = schedule.shares[slot];
          // Direct pay: the drop comes from the STARTER's wallet (not the bot),
          // so confirm they can still cover it before reserving the slot. Their
          // balance can drop mid-rain (they can /send, /tip, /withdraw in
          // between), and if they can't cover any more drops the rain is over.
          const starterClient = new SikkaClient({
            nodeURL: selectedNodeURL,
            wallet: getUserWallet(activeNow.starter_id),
          });
          if ((await starterClient.balance()) < share) {
            return { status: 'starter_broke', rainId: activeNow.id };
          }
          // Record the claim FIRST (reserves the slot), then send funds —
          // rolled back if the send fails.
          await addRainClaim(db, activeNow.id, userId, share.toString(), null);
          return { status: 'ok', rainId: activeNow.id, starterId: activeNow.starter_id, slot, share, schedule };
        });

        if (claim.status === 'none') return replyThenDelete(ctx, 'No active rain right now.', opts);
        if (claim.status === 'already') return replyThenDelete(ctx, 'You already grabbed a drop from this rain!', opts);
        if (claim.status === 'full') return replyThenDelete(ctx, 'All drops have been taken! 🌧', opts);
        if (claim.status === 'starter_broke') {
          // The starter can no longer cover any drops — end the rain. Unclaimed
          // shares simply stay in the starter's wallet (nothing to refund).
          await closeRain(db, claim.rainId);
          bot.telegram.sendMessage(telegramGroup, `🌧 **Rain over — starter ran out of funds.**`, { parse_mode: 'Markdown' })
            .then(m => deleteLater(bot.telegram, telegramGroup, m.message_id, GROUP_MSG_TTL_SEC))
            .catch(console.error);
          return replyThenDelete(ctx, `❌ The rain starter ran out of funds — this rain is over.`, opts);
        }

        const uWallet = getUserWallet(userId);
        let txID;
        try {
          const starterClient = new SikkaClient({
            nodeURL: selectedNodeURL,
            wallet: getUserWallet(claim.starterId),
          });
          const result = await starterClient.send(claim.share, uWallet.address);
          txID = result.txID;
        } catch (sendErr) {
          await removeRainClaim(db, claim.rainId, userId);
          // If the starter ran out mid-send, no remaining drop can be paid
          // either — close the rain (unclaimed shares stay in their wallet).
          if (/insufficient balance|balance too low/i.test(sendErr.message || '')) {
            await closeRain(db, claim.rainId);
            bot.telegram.sendMessage(telegramGroup, `🌧 **Rain over — starter ran out of funds.**`, { parse_mode: 'Markdown' })
              .then(m => deleteLater(bot.telegram, telegramGroup, m.message_id, GROUP_MSG_TTL_SEC))
              .catch(console.error);
          }
          return replyThenDelete(ctx, humanizeSendError(sendErr), { parse_mode: 'Markdown', ...opts });
        }
        await addRainClaimTx(db, claim.rainId, userId, txID);

        const name = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
        const ord = rainOrdinal(claim.slot);
        const remaining = claim.schedule.shares.length - claim.slot - 1;
        const msg =
          `☔ *${name}* grabbed the *${ord}* drop: *${formatSikkaDisplay(claim.share)}*!\n\n` +
          (remaining > 0
            ? `Still up for grabs: ${remaining} drop${remaining > 1 ? 's' : ''} — type /me!`
            : `That was the last drop! 🌧`);
        await replyThenDelete(ctx, msg, { parse_mode: 'Markdown', ...opts });

        ctx.telegram.sendMessage(
          userId,
          `🌧 You grabbed *${formatSikkaDisplay(claim.share)}* from the rain!\nTx: \`${txID}\`\n\nIt's in your wallet:\n\`${uWallet.address}\``,
          { parse_mode: 'Markdown' }
        ).catch(() => {});
      } catch (err) {
        console.error(err);
        replyThenDelete(ctx, `Error claiming rain: ${err.message}`, opts);
      } finally {
        claimingRainUsers.delete(userId);
      }
      return;
    }

    // Handle plain-text tip: "tip @username 100"
    if (/^tip\s+/i.test(text)) {
      const entities = ctx.message.entities || [];
      const mentionEntity = entities.find(e => e.type === 'mention');
      if (mentionEntity) {
        const username = text.slice(mentionEntity.offset, mentionEntity.offset + mentionEntity.length);
        let recipientId, recipientName;
        const cached = usernameCache.get(username.replace('@', '').toLowerCase());
        if (cached) {
          recipientId = cached.id;
          recipientName = cached.firstName;
        } else {
          await replyThenDelete(
            ctx,
            `❌ Couldn't resolve ${username}. They need to send a message in the group first so the bot can see them.`,
            { reply_parameters: { message_id: ctx.message.message_id } }
          );
          return;
        }
        const args = text.trim().split(/\s+/);
        const amountStr = args[args.length - 1];
        await handleTip(ctx, recipientId, recipientName, amountStr);
        return; // Don't fall through to airdrop logic
      }
    }

    const matches = text.match(addressRe);
    if (!matches || matches.length === 0) return;
    
    let recipientAddr;
    for (const candidate of matches) {
      try {
        recipientAddr = validateAddress(candidate);
        break;
      } catch (err) {
        // invalid
      }
    }
    
    if (!recipientAddr) return;
    if (recipientAddr === wallet.address) return;
    
    const userId = ctx.from.id;
    
    if (processingUsers.has(userId)) {
      return; // Skip concurrent buffered messages for the same user
    }
    processingUsers.add(userId);
    
    try {
      const claimStatus = await canClaim(db, userId);
      if (!claimStatus.ok) {
        const remainingHours = Math.floor(claimStatus.remaining / (60 * 60 * 1000));
        const remainingMins = Math.floor((claimStatus.remaining % (60 * 60 * 1000)) / (60 * 1000));
        await replyThenDelete(
          ctx,
          `You already claimed recently. Try again in *${remainingHours}h ${remainingMins}m*.`,
          { reply_parameters: { message_id: ctx.message.message_id }, parse_mode: 'Markdown' }
        );
        return;
      }
      
      // Send a reaction to let the user know the bot is mining/processing
      try {
        await ctx.telegram.setMessageReaction(ctx.chat.id, ctx.message.message_id, [{ type: 'emoji', emoji: '⏳' }]);
      } catch (e) {
        // ignore if reactions are disabled in the group
      }
      
      const { txID, sentAmount } = await sendAirdrop(selectedNodeURL, wallet, recipientAddr);
      
      await recordClaim(db, userId);
      
      // Update reaction to success
      try {
        await ctx.telegram.setMessageReaction(ctx.chat.id, ctx.message.message_id, [{ type: 'emoji', emoji: '🎉' }]);
      } catch (e) {}
      
      await replyThenDelete(
        ctx,
        `Sent *${formatSikkaDisplay(sentAmount)}* to \`${recipientAddr}\`\nTx: \`${txID}\``,
        { reply_parameters: { message_id: ctx.message.message_id }, parse_mode: 'Markdown' }
      );
      
    } catch (err) {
      console.error(`Airdrop error to ${recipientAddr}:`, err);
      try {
        await ctx.telegram.setMessageReaction(ctx.chat.id, ctx.message.message_id, [{ type: 'emoji', emoji: '❌' }]);
      } catch (e) {}
      // Auto-delete settling-period and similar transient error messages using the group TTL (replyThenDelete default)
      await replyThenDelete(
        ctx,
        `Sorry, could not process the airdrop: ${humanizeSendError(err)}`,
        { reply_parameters: { message_id: ctx.message.message_id }, parse_mode: 'Markdown' }
      );
      // Wait for 1s to avoid spamming if there's a flood
      await new Promise(r => setTimeout(r, 1000));
    } finally {
      processingUsers.delete(userId);
    }
  });

  bot.catch((err, ctx) => {
    console.error(`Ooops, encountered an error for ${ctx.updateType}`, err);
  });
  
  bot.launch();
  console.log("Telegram bot started. Press Ctrl+C to stop.");

  // Enable graceful stop
  process.once('SIGINT', () => { bot.stop('SIGINT'); db.close(); });
  process.once('SIGTERM', () => { bot.stop('SIGTERM'); db.close(); });
}

main().catch(console.error);
