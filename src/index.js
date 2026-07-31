import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import dotenv from 'dotenv';
import { initDB, canClaim, recordClaim, createRaffle, getActiveRaffle, addRaffleEntry, removeRaffleEntry, getRaffleEntries, hasUserJoinedRaffle, closeRaffle, cancelRaffle, getRecentRaffles, getRaffleById, setRaffleTime, canStartRaffle } from './db.js';
import { selectBestNodeURL } from './api.js';
import {
  SikkaClient,
  createWallet,
  formatSikka as formatSikkaAmount,
  parseSikka,
  CHILLAR_PER_SIKKA,
  asBig,
} from './sikka_client.js';
import { validateAddress, addressRe } from './address.js';
import path from 'path';
import crypto from 'crypto';

// Helper: send a reply then delete both the trigger and the reply after `delaySec` seconds.
async function replyThenDelete(ctx, text, opts = {}, delaySec = 30) {
  const reply = await ctx.reply(text, opts);
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
const airdropDivisor = BigInt(process.env.AIRDROP_DIVISOR || "2000");

function formatSikkaDisplay(chillar) {
  const c = asBig(chillar);
  const abs = c < 0n ? -c : c;
  if (abs > 0n && abs < subunitsPerSikka) {
    return `${c} chillar`;
  }
  return `${formatSikkaAmount(c)} SIKKA`;
}

function humanizeSendError(err) {
  const msg = err.message || '';

  if (/insufficient credits/i.test(msg)) {
    return `Not enough spam credits (each send costs 1; they regen +1/min, cap 100). Wait a minute and try again.`;
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
  
  const dbPath = process.env.DBPATH || path.join(process.cwd(), 'claims.db');
  const db = await initDB(dbPath);
  console.log(`Database initialized at ${dbPath}`);
  
  const bot = new Telegraf(telegramToken);
  
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

      `<b>──────────────────────────────</b>\n` +
      `👛 <i>DM @sikkalabsbot for wallet commands</i>\n\n` +
      `🌐 <a href="https://sikkalabs.com/">sikkalabs.com</a>`
    );
  }

  bot.command(['start', 'help', 'sikka'], (ctx) => {
    const isPrivate = ctx.chat.type === 'private';
    // In a group, only respond to the configured group
    if (!isPrivate && String(ctx.chat.id) !== telegramGroup) return;
    ctx.reply(helpText(isPrivate), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
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
        100
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
      return ctx.reply(`🔒 Wallet commands are private! DM @sikkalabsbot and type /deposit to get your deposit address.`, { reply_parameters: { message_id: ctx.message.message_id } });
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
      return ctx.reply(`🔒 Wallet commands are private! DM @sikkalabsbot and type /balance to check your balance.`, { reply_parameters: { message_id: ctx.message.message_id } });
    }
    try {
      const uWallet = getUserWallet(ctx.from.id);
      const client = new SikkaClient({ nodeURL: selectedNodeURL, wallet: uWallet });
      const account = await client.account();
      const bal = asBig(account.balance);
      const credits = account.credits_now ?? account.credits ?? 0;
      await ctx.reply(
        `Your balance: *${formatSikkaDisplay(bal)}*\nCredits: *${credits}* (1 per send, +1/min, cap 100)\n\nAddress:\n\`${uWallet.address}\`\n\n[Open wallet UI](${selectedNodeURL}/wallet.html)`,
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
      return ctx.reply(`🔒 Wallet commands are private! DM @sikkalabsbot to send funds.`, { reply_parameters: { message_id: ctx.message.message_id } });
    }
    const args = ctx.message.text.split(/\s+/).slice(1);
    if (args.length !== 2) {
      return ctx.reply('Usage: /send <amount> <0x…>\nExample: /send 5 0xabc…\n(You can also use /send all <0x…>)');
    }
    await handleWithdraw(ctx, args[0], args[1]);
  });

  bot.command('sendall', async (ctx) => {
    if (ctx.chat.type !== 'private') {
      return ctx.reply(`🔒 Wallet commands are private! DM @sikkalabsbot to send funds.`, { reply_parameters: { message_id: ctx.message.message_id } });
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
      return ctx.reply(`❌ You can't tip yourself!`, replyOpts);
    }

    let amountChillar;
    try {
      amountChillar = parseSikka(amountStr);
    } catch {
      return ctx.reply(`❌ Invalid amount. Usage: /tip @username 5`, replyOpts);
    }
    if (amountChillar <= 0n) {
      return ctx.reply(`❌ Invalid amount. Usage: /tip @username 5`, replyOpts);
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
        return ctx.reply(
          `❌ Insufficient balance. You have *${formatSikkaDisplay(bal)}* but tried to tip *${formatSikkaDisplay(amountChillar)}*.\n📩 Check your DMs for your deposit address!`,
          replyOpts
        );
      }

      const recipientWallet = getUserWallet(recipientId);
      const { txID } = await senderClient.send(amountChillar, recipientWallet.address);

      // Public confirmation in group
      await ctx.reply(
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
      await ctx.reply(humanizeSendError(err), replyOpts);
    }
  }

  bot.command('tip', async (ctx) => {
    if (String(ctx.chat.id) !== telegramGroup) return;
    const replyOpts = { reply_parameters: { message_id: ctx.message.message_id } };

    const entities = ctx.message.entities || [];
    const mentionEntity = entities.find(e => e.type === 'mention');

    if (!mentionEntity) {
      return ctx.reply(`❌ Usage: /tip @username 100\nOnly users with a @username can be tipped.`, replyOpts);
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
        if (!active) return ctx.reply('No active raffle right now.', replyOpts);

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

        const sent = await ctx.reply(text, { parse_mode: 'Markdown' });
        lastPrizeMsgId = sent.message_id;
        return;
      }

      if (args.length !== 1) {
        return ctx.reply('Usage: /raffle <entry fee in SIKKA>\nExample: /raffle 5', replyOpts);
      }

      let entryFee;
      try {
        entryFee = parseSikka(args[0]);
      } catch {
        return ctx.reply('❌ Entry fee must be a positive number of SIKKA.', replyOpts);
      }
      if (entryFee <= 0n) {
        return ctx.reply('❌ Entry fee must be a positive number of SIKKA.', replyOpts);
      }
      if (entryFee < MIN_RAFFLE_FEE) {
        return ctx.reply(`❌ Minimum entry fee is *1 SIKKA*.`, { parse_mode: 'Markdown', ...replyOpts });
      }

      const active = await getActiveRaffle(db);
      if (active) return ctx.reply('⚠️ A raffle is already active! Wait for it to finish.', replyOpts);

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
        return ctx.reply(
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
      await ctx.reply(
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
    } catch (err) {
      console.error(err);
      ctx.reply(`Error: ${err.message}`, replyOpts);
    }
  });

  bot.command('join', async (ctx) => {
    if (String(ctx.chat.id) !== telegramGroup) return;

    const userId = ctx.from.id;
    const replyOpts = { reply_parameters: { message_id: ctx.message.message_id } };

    // Fix #1: per-user lock — prevents two concurrent /join messages from the
    // same user both passing hasUserJoinedRaffle before either writes to the DB.
    if (joiningUsers.has(userId)) {
      return ctx.reply("Please wait, your previous join is still processing.", replyOpts);
    }
    joiningUsers.add(userId);

    try {
      const active = await getActiveRaffle(db);
      if (!active) return ctx.reply("No active raffle to join.", replyOpts);

      const hasJoined = await hasUserJoinedRaffle(db, active.id, userId);
      if (hasJoined) return ctx.reply("You have already joined this raffle!", replyOpts);

      // Fix #5: reject if the raffle timer has already expired
      const now = Math.floor(Date.now() / 1000);
      if (active.end_time > 0 && now >= active.end_time) {
        return ctx.reply("The raffle has just ended — you can no longer join.", replyOpts);
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

        return ctx.reply(
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
        await replyThenDelete(ctx, `✅ You joined the raffle!\nWaiting for 1 more player to start the timer.\nTx: ${txID}`, replyOpts, 100);
      } else {
        // 2nd player or beyond — always reset clock to exactly 2 mins from now
        const newEndTime = nowAfter + 120;
        await setRaffleTime(db, active.id, newEndTime);

        const msg = newCount === 2
          ? `✅ You joined the raffle!\n\n⏳ Timer started — 2 minutes remaining!\nTx: ${txID}`
          : `✅ You joined the raffle!\n\n⏳ Timer reset — 2 minutes remaining!\nTx: ${txID}`;

        await replyThenDelete(ctx, msg, { parse_mode: 'Markdown', ...replyOpts }, 100);
      }
    } catch (err) {
      console.error(err);
      ctx.reply(`Error joining: ${err.message}`, replyOpts);
    } finally {
      joiningUsers.delete(userId); // always release the lock
    }
  });



  bot.command('rafflelist', async (ctx) => {
    if (String(ctx.chat.id) !== telegramGroup) return;
    try {
      const recent = await getRecentRaffles(db, 5);
      if (recent.length === 0) return ctx.reply("No past raffles found.");
      
      let msg = "📜 **Last 5 Raffles** 📜\n\n";
      for (const r of recent) {
        msg += `/raffle_${r.id} - Prize: ${formatSikkaDisplay(BigInt(r.prize_amount || 0))}\n`;
      }
      await ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error(err);
      ctx.reply(`Error: ${err.message}`);
    }
  });

  // Fix #10: /cancel — admin-only, refunds all participants and closes the raffle
  bot.command('cancel', async (ctx) => {
    if (String(ctx.chat.id) !== telegramGroup) return;
    try {
      const chatAdmins = await ctx.getChatAdministrators();
      const isAdmin = chatAdmins.some(admin => admin.user.id === ctx.from.id);
      if (!isAdmin) return ctx.reply("Only admins can cancel a raffle.");

      const active = await getActiveRaffle(db);
      if (!active) return ctx.reply("No active raffle to cancel.");

      const entries = await getRaffleEntries(db, active.id);
      const entryFee = BigInt(active.entry_fee);

      await cancelRaffle(db, active.id);
      await ctx.reply(`🚫 Raffle cancelled. Refunding ${entries.length} participant(s)...`);

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

      await ctx.reply(
        `✅ Refund complete.\n\nRefunded: ${refunded}\nFailed: ${failed}` +
        (failed > 0 ? `\n\n⚠️ ${failed} refund(s) failed — funds remain in faucet wallet.` : ``)
      );
    } catch (err) {
      console.error(err);
      ctx.reply(`Error: ${err.message}`);
    }
  });

  // Handle dynamic command for raffle details
  bot.hears(/^\/raffle_(\d+)$/, async (ctx) => {
    if (String(ctx.chat.id) !== telegramGroup) return;
    try {
      const rId = parseInt(ctx.match[1]);
      const r = await getRaffleById(db, rId);
      if (!r) return ctx.reply("Raffle not found.");
      
      const entries = await getRaffleEntries(db, r.id);
      
      let msg = `ℹ️ **Raffle #${r.id} Details**\n\n`;
      msg += `Status: ${r.status}\n`;
      msg += `Entry Fee: ${formatSikkaDisplay(BigInt(r.entry_fee))}\n`;
      msg += `Participants: ${entries.length}\n`;
      if (r.winner_id) msg += `Winner ID: ${r.winner_id}\n`;
      if (r.prize_amount) msg += `Prize Won: ${formatSikkaDisplay(BigInt(r.prize_amount))}\n`;
      
      await ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error(err);
      ctx.reply(`Error: ${err.message}`);
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

        try {
          const winnerWallet = getUserWallet(winnerId);
          const fclient = new SikkaClient({ nodeURL: selectedNodeURL, wallet });
          const { txID } = await fclient.send(prize, winnerWallet.address);
          // Fix #7: guard against sentMsg being undefined if the announce message failed
          const replyParams = sentMsg ? { reply_parameters: { message_id: sentMsg.message_id } } : {};
          bot.telegram.sendMessage(telegramGroup, `✅ Prize sent to winner's wallet!\nTx: \`${txID}\`\n\n🤫 Winner — DM @sikkalabsbot and type /balance to check your funds privately!`, { parse_mode: 'Markdown', ...replyParams }).catch(console.error);
        } catch (e) {
          console.error("Failed to send prize:", e);
          bot.telegram.sendMessage(telegramGroup, `❌ Error sending prize: ${e.message}`).catch(console.error);
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

  const processingUsers = new Set();
  const joiningUsers = new Set(); // per-user lock for /join (Fix #1)
  
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
        await ctx.reply(
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
      
      await ctx.reply(
        `Sent *${formatSikkaDisplay(sentAmount)}* to \`${recipientAddr}\`\nTx: \`${txID}\``,
        { reply_parameters: { message_id: ctx.message.message_id }, parse_mode: 'Markdown' }
      );
      
    } catch (err) {
      console.error(`Airdrop error to ${recipientAddr}:`, err);
      try {
        await ctx.telegram.setMessageReaction(ctx.chat.id, ctx.message.message_id, [{ type: 'emoji', emoji: '❌' }]);
      } catch (e) {}
      // Auto-delete settling-period and similar transient error messages after 30s
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
