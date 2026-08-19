SIKKA Telegram Bot
==================

Custodial faucet, wallets, tips, and raffles for the current SIKKA chain
(account model, `0x` addresses, ML-DSA-87, JSON-RPC).

Matches the protocol documented in the main repo:
[docs/wallets.md](https://github.com/sikkalabs/sikka/blob/main/docs/wallets.md)
and the reference wallet at `/wallet.html`.
Transfers are signed as **`SIKKA/tx/v1`** with the node’s `chain_id` and
`genesis_fingerprint` (from `chain.info`), ML-DSA-87 context `SIKKA-v1`.

How It Works
------------
- **Group faucet** — `/claim` or `/claim <0x…>` to receive a fraction of the
  faucet balance (default 1/2000), with a per-user cooldown (default 5 hours).
- **DM wallet** — `/deposit`, `/balance`, `/send`, `/sendall` on a deterministic
  address derived from `PRIVATEKEY` + Telegram user id.
- **Tips / raffles** — group commands move funds between those custodial wallets.

Each on-chain send burns **1 battery** (+1/min, cap 10).

Environment Variables
---------------------
**Required:**

| Var | Meaning |
| --- | --- |
| `SIKKANODE` | Node URL(s), comma-separated. Bot picks the highest `/api/health` height. |
| `PRIVATEKEY` | Faucet key: 32-byte seed hex **or** full 4896-byte ML-DSA-87 private key hex. Also roots all user wallets. |
| `TELEGRAMTOKEN` | BotFather token. |
| `TELEGRAMGROUP` | Group chat id (e.g. `-100…`). |


Run
---

```bash
cp .env.example .env   # fill values
npm install
npm start

# or
docker compose --env-file .env up -d --build
```

Test with Podman
----------------

```bash
podman build -t sikka-bot-test:local .
podman run --rm sikka-bot-test:local npm run test:unit
```

The helper script also runs the same test flow:

```bash
bash scripts/test.sh
```

Addresses are `0x` + 64 hex (`SHA3-256` of the ML-DSA-87 public key).
Amounts are SIKKA with up to 9 decimals (`1 SIKKA = 10⁹ CHILLAR`).
