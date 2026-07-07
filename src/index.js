import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import dotenv from 'dotenv';
import { initDB, canClaim, recordClaim, createRaffle, getActiveRaffle, addRaffleEntry, removeRaffleEntry, extendRaffleTime, getRaffleEntries, hasUserJoinedRaffle, closeRaffle, getRecentRaffles, getRaffleById, setRaffleTime } from './db.js';
import { ensureUserMigrated } from './migrate_wallets.js';
import { selectBestNodeURL } from './api.js';
import { SikkaClient, createWallet } from 'sikka-sdk';
import { validateAddress, addressRe } from './bech32m.js';
import path from 'path';
import crypto from 'crypto';

dotenv.config();

const subunitsPerSikka = 10_000_000_000n;
const airdropDivisor = BigInt(process.env.AIRDROP_DIVISOR || "2000");

function formatSikka(chillar) {
  let whole = chillar / subunitsPerSikka;
  let frac = chillar % subunitsPerSikka;
  if (frac < 0n) frac = -frac;
  return `${whole}.${frac.toString().padStart(10, '0')}`;
}

function formatSikkaDisplay(chillar) {
  let abs = chillar < 0n ? -chillar : chillar;
  if (abs < subunitsPerSikka) {
    return `${chillar} chillar`;
  }
  return `${formatSikka(chillar)} SIKKA`;
}

async function getUserWallet(userId) {
  const walletSeed = process.env.WALLETSEED;
  if (!walletSeed) throw new Error("WALLETSEED env var is required for user wallet derivation");
  const derivedHex = crypto.createHash('sha256').update(walletSeed + String(userId)).digest('hex');
  return await createWallet(derivedHex);
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
  const walletSeed = process.env.WALLETSEED;

  if (!nodeURLsRaw) throw new Error("env var 'SIKKANODE' is required");
  if (!privKeyHex) throw new Error("env var 'PRIVATEKEY' is required");
  if (!telegramToken) throw new Error("env var 'TELEGRAMTOKEN' is required");
  if (!telegramGroup) throw new Error("env var 'TELEGRAMGROUP' is required");
  if (!walletSeed) throw new Error("env var 'WALLETSEED' is required for user wallet derivation");
  
  const nodeURLs = nodeURLsRaw.split(',').map(s => s.trim()).filter(Boolean);
  const selectedNodeURL = await selectBestNodeURL(nodeURLs);
  console.log(`Using Sikka node: ${selectedNodeURL}`);
  
  const wallet = await createWallet(privKeyHex);
  console.log(`Faucet address: ${wallet.address}`);
  
  const dbPath = process.env.DBPATH || path.join(process.cwd(), 'claims.db');
  const db = await initDB(dbPath);
  console.log(`Database initialized at ${dbPath}`);
  
  const bot = new Telegraf(telegramToken);
  
  bot.command(['start', 'help'], (ctx) => {
    if (ctx.chat.type === 'private') {
      ctx.reply("Welcome to your Sikka Wallet! \n\nCommands:\n/deposit - Get your deposit address\n/balance - Check your balance\n/send <amount | all> <address> - Send funds\n/sendall <address> - Send all funds");
    } else {
      ctx.reply("Welcome! Post your Sikka address in this group to receive a free airdrop.");
    }
  });

  bot.command('deposit', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    try {
      const uWallet = await getUserWallet(ctx.from.id);
      await ensureUserMigrated(db, selectedNodeURL, privKeyHex, walletSeed, ctx.from.id, uWallet);
      await ctx.reply(`Your personal SIKKA deposit address:\n\n\`${uWallet.address}\``, { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.reply(`Error: ${err.message}`);
    }
  });

  bot.command('balance', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    try {
      const uWallet = await getUserWallet(ctx.from.id);
      await ensureUserMigrated(db, selectedNodeURL, privKeyHex, walletSeed, ctx.from.id, uWallet);
      const client = new SikkaClient({ nodeURL: selectedNodeURL, wallet: uWallet });
      const bal = await client.balance();
      await ctx.reply(`Your balance: *${formatSikkaDisplay(BigInt(bal))}*\n\n[View History](https://1.sikkalabs.com/wallet/${uWallet.address})`, { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } });
    } catch (err) {
      await ctx.reply(`Error: ${err.message}`);
    }
  });

  async function handleWithdraw(ctx, amountStr, address) {
    const uWallet = await getUserWallet(ctx.from.id);
    await ensureUserMigrated(db, selectedNodeURL, privKeyHex, walletSeed, ctx.from.id, uWallet);

    let amountChillar;
    if (amountStr.toLowerCase() === 'all') {
      const client = new SikkaClient({ nodeURL: selectedNodeURL, wallet: uWallet });
      const bal = await client.balance();
      amountChillar = BigInt(bal);
    } else {
      const floatAmt = parseFloat(amountStr);
      if (isNaN(floatAmt) || floatAmt <= 0) return ctx.reply("Invalid amount");
      amountChillar = BigInt(Math.floor(floatAmt * Number(subunitsPerSikka)));
    }

    if (amountChillar === 0n) {
      return ctx.reply("Cannot withdraw 0.");
    }

    try {
      const client = new SikkaClient({ nodeURL: selectedNodeURL, wallet: uWallet });
      const bal = await client.balance();
      if (BigInt(bal) < amountChillar) {
        return ctx.reply(`Insufficient balance. You have ${formatSikkaDisplay(BigInt(bal))}`);
      }

      const { txID } = await client.send(amountChillar, address);
      await ctx.reply(`Successfully withdrew *${formatSikkaDisplay(amountChillar)}* to \`${address}\`\nTx: \`${txID}\``, { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.reply(`Error withdrawing: ${err.message}`);
    }
  }

  bot.command('send', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const args = ctx.message.text.split(/\s+/).slice(1);
    if (args.length !== 2) {
      return ctx.reply("Usage: /send <amount> <address>\nExample: /send 5 sikka1...\n(You can also use 'all' as the amount to withdraw your entire balance: /send all sikka1...)");
    }
    await handleWithdraw(ctx, args[0], args[1]);
  });

  bot.command('sendall', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const args = ctx.message.text.split(/\s+/).slice(1);
    if (args.length !== 1) {
      return ctx.reply("Usage: /sendall <address>\nExample: /sendall sikka1...");
    }
    await handleWithdraw(ctx, 'all', args[0]);
  });


  // RAFFLE LOGIC
  bot.command('raffle', async (ctx) => {
    if (String(ctx.chat.id) !== telegramGroup) return;
    try {
      const chatAdmins = await ctx.getChatAdministrators();
      const isAdmin = chatAdmins.some(admin => admin.user.id === ctx.from.id);
      if (!isAdmin) {
        return ctx.reply("Only admins can start a raffle.");
      }
      const args = ctx.message.text.split(/\s+/).slice(1);
      if (args.length !== 1) return ctx.reply("Usage: /raffle <amount in chillar>");
      const entryFee = BigInt(args[0]);
      if (entryFee <= 0n) return ctx.reply("Invalid amount");
      
      const active = await getActiveRaffle(db);
      if (active) return ctx.reply("A raffle is already active!");
      
      const endTimeSec = 0; // 0 means waiting for players
      const raffleId = await createRaffle(db, entryFee.toString(), endTimeSec);
      await ctx.reply(`🎟 **New Raffle Started!** 🎟\n\nEntry Fee: ${entryFee} chillar\nJoin with /join\nWaiting for at least 2 players to start the timer!`, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error(err);
      ctx.reply(`Error: ${err.message}`);
    }
  });

  bot.command('join', async (ctx) => {
    if (String(ctx.chat.id) !== telegramGroup) return;

    const userId = ctx.from.id;

    // Fix #1: per-user lock — prevents two concurrent /join messages from the
    // same user both passing hasUserJoinedRaffle before either writes to the DB.
    if (joiningUsers.has(userId)) {
      return ctx.reply("Please wait, your previous join is still processing.");
    }
    joiningUsers.add(userId);

    try {
      const active = await getActiveRaffle(db);
      if (!active) return ctx.reply("No active raffle to join.");

      const hasJoined = await hasUserJoinedRaffle(db, active.id, userId);
      if (hasJoined) return ctx.reply("You have already joined this raffle!");

      // Fix #5: reject if the raffle timer has already expired
      const now = Math.floor(Date.now() / 1000);
      if (active.end_time > 0 && now >= active.end_time) {
        return ctx.reply("The raffle has just ended — you can no longer join.");
      }

      const entryFee = BigInt(active.entry_fee);
      const uWallet = await getUserWallet(userId);
      await ensureUserMigrated(db, selectedNodeURL, privKeyHex, walletSeed, userId, uWallet);
      const client = new SikkaClient({ nodeURL: selectedNodeURL, wallet: uWallet });
      const bal = await client.balance();

      if (BigInt(bal) < entryFee) {
        return ctx.reply(`You don't have enough balance. You need ${entryFee} chillar, but have ${bal} chillar.\nDeposit to: \`${uWallet.address}\``, { parse_mode: 'Markdown' });
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
        return ctx.reply(`Failed to send entry fee: ${sendErr.message}. Please try again.`);
      }

      const entries = await getRaffleEntries(db, active.id);
      const newCount = entries.length;
      const nowAfter = Math.floor(Date.now() / 1000);

      if (newCount === 1) {
        await ctx.reply(`✅ You joined the raffle! Waiting for at least 1 more player to start the timer.\nTx: ` + txID);
      } else if (newCount === 2) {
        const newEndTime = nowAfter + 120;
        await setRaffleTime(db, active.id, newEndTime);
        await ctx.reply(`✅ You joined the raffle!\n\n⏳ **Timer Started!** 2 minutes remaining!\nTx: ` + txID, { parse_mode: 'Markdown' });
      } else {
        // Fix #5: only extend if the timer hasn't already expired
        if (active.end_time > 0 && nowAfter < active.end_time) {
          await extendRaffleTime(db, active.id, 120);
          await ctx.reply(`✅ You joined the raffle! Timer extended by 2 mins.\nTx: ` + txID);
        } else {
          await ctx.reply(`✅ You joined the raffle!\nTx: ` + txID);
        }
      }
    } catch (err) {
      console.error(err);
      ctx.reply(`Error joining: ${err.message}`);
    } finally {
      joiningUsers.delete(userId); // always release the lock
    }
  });

  bot.command('prize', async (ctx) => {
    if (String(ctx.chat.id) !== telegramGroup) return;
    try {
      const active = await getActiveRaffle(db);
      if (!active) return ctx.reply("No active raffle.");
      
      const entries = await getRaffleEntries(db, active.id);
      const entryFee = BigInt(active.entry_fee);
      const totalPool = entryFee * BigInt(entries.length);
      const fee = totalPool * 5n / 100n;
      const prize = totalPool - fee;
      
      const now = Math.floor(Date.now() / 1000);
      
      let timeText = "";
      if (active.end_time === 0) {
         timeText = "Waiting for 2 players to start...";
      } else {
         const timeLeft = Math.max(0, active.end_time - now);
         const m = Math.floor(timeLeft / 60);
         const s = timeLeft % 60;
         timeText = `${m}m ${s}s`;
      }
      
      await ctx.reply(`🏆 **Current Raffle Info** 🏆\n\nParticipants: ${entries.length}\nTotal Pool: ${totalPool} chillar\nPrize (Minus 5%): ${prize} chillar\n\nTime Left: ${timeText}`, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error(err);
      ctx.reply(`Error: ${err.message}`);
    }
  });

  bot.command('rafflelist', async (ctx) => {
    if (String(ctx.chat.id) !== telegramGroup) return;
    try {
      const recent = await getRecentRaffles(db, 5);
      if (recent.length === 0) return ctx.reply("No past raffles found.");
      
      let msg = "📜 **Last 5 Raffles** 📜\n\n";
      for (const r of recent) {
        msg += `/raffle_${r.id} - Prize: ${r.prize_amount} chillar\n`;
      }
      await ctx.reply(msg, { parse_mode: 'Markdown' });
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
      msg += `Entry Fee: ${r.entry_fee} chillar\n`;
      msg += `Participants: ${entries.length}\n`;
      if (r.winner_id) msg += `Winner ID: ${r.winner_id}\n`;
      if (r.prize_amount) msg += `Prize Won: ${r.prize_amount} chillar\n`;
      
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
      if (active.end_time > 0 && now >= active.end_time) {
        const entries = await getRaffleEntries(db, active.id);
        if (entries.length === 0) {
          await closeRaffle(db, active.id, "none", "0");
          bot.telegram.sendMessage(telegramGroup, "The raffle has ended with no participants! 😢").catch(console.error);
          return;
        }

        const winnerIdx = Math.floor(Math.random() * entries.length);
        const winnerId = entries[winnerIdx];

        const entryFee = BigInt(active.entry_fee);
        const totalPool = entryFee * BigInt(entries.length);
        const fee = totalPool * 5n / 100n;
        const prize = totalPool - fee;

        // Close BEFORE announcing so a second tick never sees this raffle as active
        await closeRaffle(db, active.id, winnerId, prize.toString());

        const announceMsg = `🎉 **RAFFLE ENDED!** 🎉\n\nWinner: [User](tg://user?id=${winnerId})\nPrize: ${prize} chillar!\n\nSending funds...`;
        const sentMsg = await bot.telegram.sendMessage(telegramGroup, announceMsg, { parse_mode: 'Markdown' }).catch(console.error);

        try {
          const winnerWallet = await getUserWallet(winnerId);
          const fclient = new SikkaClient({ nodeURL: selectedNodeURL, wallet });
          const { txID } = await fclient.send(prize, winnerWallet.address);
          // Fix #7: guard against sentMsg being undefined if the announce message failed
          const replyParams = sentMsg ? { reply_parameters: { message_id: sentMsg.message_id } } : {};
          bot.telegram.sendMessage(telegramGroup, `✅ Prize sent to winner's wallet!\nTx: \`${txID}\`\nThey can type /balance to check.`, { parse_mode: 'Markdown', ...replyParams }).catch(console.error);
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

  const processingUsers = new Set();
  const joiningUsers = new Set(); // per-user lock for /join (Fix #1)
  
  bot.on(message('text'), async (ctx) => {
    console.log(`Received message from chat ${ctx.chat.id}: ${ctx.message.text}`);
    // Check group
    if (String(ctx.chat.id) !== telegramGroup) {
      console.log(`Ignored message from chat ${ctx.chat.id} (expected ${telegramGroup})`);
      return;
    }
    
    const text = ctx.message.text;
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
      await ctx.reply(`Sorry, could not process the airdrop: ${err.message}`, { reply_parameters: { message_id: ctx.message.message_id } });
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
