import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import dotenv from 'dotenv';
import { initDB, canClaim, recordClaim } from './db.js';
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
  const baseSeed = process.env.WALLETSEED || process.env.PRIVATEKEY;
  if (!baseSeed) throw new Error("No seed configured for wallets");
  const derivedHex = crypto.createHash('sha256').update(baseSeed + String(userId)).digest('hex');
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
  
  if (!nodeURLsRaw) throw new Error("env var 'SIKKANODE' is required");
  if (!privKeyHex) throw new Error("env var 'PRIVATEKEY' is required");
  if (!telegramToken) throw new Error("env var 'TELEGRAMTOKEN' is required");
  if (!telegramGroup) throw new Error("env var 'TELEGRAMGROUP' is required");
  
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
      await ctx.reply(`Your personal SIKKA deposit address:\n\n\`${uWallet.address}\``, { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.reply(`Error: ${err.message}`);
    }
  });

  bot.command('balance', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    try {
      const uWallet = await getUserWallet(ctx.from.id);
      const client = new SikkaClient({ nodeURL: selectedNodeURL, wallet: uWallet });
      const bal = await client.balance();
      await ctx.reply(`Your balance: *${formatSikkaDisplay(BigInt(bal))}*\n\n[View History](https://1.sikkalabs.com/wallet/${uWallet.address})`, { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } });
    } catch (err) {
      await ctx.reply(`Error: ${err.message}`);
    }
  });

  async function handleWithdraw(ctx, amountStr, address) {
    let amountChillar;
    if (amountStr.toLowerCase() === 'all') {
      const uWallet = await getUserWallet(ctx.from.id);
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
      const uWallet = await getUserWallet(ctx.from.id);
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

  const processingUsers = new Set();
  
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
