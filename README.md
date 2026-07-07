Sikka Airdrop Bot - Node.js Edition
===================================

A Telegram bot that automatically sends Sikka cryptocurrency airdrops to users
who post a valid sikka1... address in the configured Telegram group.

This bot uses the [Sikka Node.js SDK](https://github.com/sikkalabs/sikka-sdk) to create transactions, mine Proof-of-Work, and broadcast them to the network.

    docker compose down && docker compose --env-file .env up -d --build


How It Works
------------
When a user posts a message containing a valid Sikka address in the configured
Telegram group, the bot:

1. Validates the address (bech32m, correct HRP and version).
2. Checks a per-user cooldown (default 6 hours) in the SQLite database.
3. Sends a configurable percentage (default 0.05%) of the faucet wallet's current balance to the recipient.
4. Replies to the message with the transaction ID.

Environment Variables
---------------------
**Required:**
sikkanode      - Sikka node URL, or a comma-separated list of node URLs.
                 The bot probes /v1/status and picks the valid node with the
                 highest reported DAG size.
privatekey     - Hex-encoded ML-DSA-87 private key (32-byte seed) used to
                 sign transactions from the faucet wallet.
telegramtoken  - Telegram bot token (from @BotFather).
telegramgroup  - Telegram Group ID to restrict the bot to (e.g. -5450027651).

**Optional:**
COOLDOWN_HOURS - Cooldown time in hours before a user can claim again (default: 6).
AIRDROP_DIVISOR- The fraction of the faucet's balance to send. For example, 2000 means 1/2000th or 0.05% (default: 2000).

Powered by Sikka SDK
--------------------
All cryptographic operations (ML-DSA-87 signing, payload hashing) and node communication are handled by [sikka-sdk](https://github.com/sikkalabs/sikka-sdk).

Build
-----
docker build -t airdrop-node .

Run (docker-compose)
--------------------
Copy .env.example to .env and fill in the values, then:

docker compose up -d
