# Tripwire

Plan, watch and protect a Mezo MUSD loan. A Telegram bot that warns you before liquidation or redemption, a public JSON API and web pages, all read-only: no keys, no custody. Every action is a link to the Mezo app.

(Formerly called Trove Guardian.)

## Status

Done: Multicall engine (whole protocol in about 5 requests), redemption queue and Stability Pool maths, Telegram bot (/track, /status, /simulate, /alerts, /list, /untrack), alert engine, public API (`/api/system`, `/api/position`, `/api/prices`), landing page, rate limiting, local runner and a Cloudflare Worker version (D1 storage, webhook, once-a-minute cron). 140 unit tests. Deployed on Cloudflare Workers.
In progress: borrow planner, French/Spanish/Portuguese.

## How it works

Everything runs off one picture of the protocol, built with Multicall3:

1. Every 5 minutes: a **full read** of the BTC price, the Stability Pool and every trove (`getTroveOwnersCount` and `getTroveFromTroveOwnersArray`, then `getEntireDebtAndColl` for each), saved in D1. About 5 requests for 255 troves.
2. Every minute: **one small request** refreshes the price and the tracked addresses on top of that snapshot.
3. The redemption queue, each trove's place in it, the MUSD ahead of it, the system ratio and the liquidation wall are all worked out in memory from that picture, so cost does not grow with the number of users.

The queue follows the contract: redemptions go lowest collateral ratio first, skip loans already below 110%, and redeem debt net of the 200 MUSD gas deposit (`TroveManager.redeemCollateral`). Mezo's docs note that a partial redemption raises the borrower's ratio, so the bot calls it "exposure", not "risk".

Free-plan limits shaped this: 50 outgoing requests and 10 ms CPU per run. The Multicall encoder and decoder are hand-written because the general-purpose one cost about 11 ms of CPU for a full read; the hand-written one is tested against viem on 120 random inputs and measured at about 3 to 5 ms in Node. Real production CPU is not yet measured (check `npx wrangler tail` for `Exceeded CPU`).

### Web dashboard and Telegram Mini App

`/p?a=0x...` is a mobile-first page for one loan: status, liquidation price, place in the redemption queue, a ruler showing where the ratio sits, and a **what-if slider** (BTC down 0% to 60%) that shows the new ratio and tier and how much collateral to add, or MUSD to repay, to get back to 135%, 150% or 200%. The bot's `/status`, `/simulate` and `/track` replies carry an **Open dashboard** button that opens it inside Telegram as a Mini App, and risky alerts link to it.

The page is plain HTML plus one script served from the same origin (`/assets/position.js`), so it runs under a strict Content-Security-Policy with no inline scripts, no third-party code and no `eval`. API values are written into the page as text only. The slider maths is a pure function in that script, and the tests run the shipped file in Node and check it against the server's own `simulate` maths.

### Public API

- `GET /api/system`: price, system ratio, Stability Pool, trove ratio buckets, the liquidation wall (debt exposed if BTC falls 5% to 60%, and whether the pool covers it) and the first 20 in the redemption queue.
- `GET /api/position?address=0x...`: one position with its liquidation price and queue place.
- `GET /api/prices?hours=24`: one BTC price per minute from Mezo's own oracle.

## Run it

```bash
npm install
npm test            # risk math tests, no network needed
npm run typecheck
npm run check -- 0xYourTroveOwnerAddress     # one position, cross-checked against the contracts
npm run system                                # whole protocol, cross-checked against the contracts
```

### Run the bot locally

1. Create a bot with @BotFather on Telegram and copy the token.
2. `copy .env.example .env` (Windows) then put the token after `TELEGRAM_BOT_TOKEN=` in `.env`.
3. `npm run bot`, then message your bot: /start, /track <address>, /status.

### Hosted version (Cloudflare Workers, free plan)

`src/worker.ts` is the hosted entry: Telegram sends messages to `/webhook`, and a cron trigger runs the monitor every minute. Tracked addresses live in Cloudflare D1 (`migrations/0001_init.sql`).

```
npx wrangler login
npx wrangler d1 create trove-guardian        # paste the database_id into wrangler.toml
npx wrangler d1 migrations apply trove-guardian --remote
npx wrangler deploy
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npm run set-webhook -- https://trove-guardian.<your-subdomain>.workers.dev
npm run webhook-info                          # check Telegram is happy
npx wrangler tail                             # live logs
npm run clear-webhook                         # go back to local polling
```

### Landing page

`GET /` on the Worker serves a single static page (`src/landing.ts`): no scripts, no remote resources, system fonts, light and dark mode. The collateral-ratio ruler is drawn from the same tier thresholds the bot uses. Set `BOT_USERNAME` and `REPO_URL` in `wrangler.toml` `[vars]`. The Telegram button and repo link are left out if the values are missing or unsafe.

## Security model

- **Read-only.** The bot only calls view functions on the Mezo contracts. It holds no keys, never asks for a seed phrase or private key, and cannot send transactions. Every action is a link to the Mezo app.
- **Webhook authentication.** Telegram sends a secret header with each update. The Worker compares it in constant time and returns 401 before doing any work or making any outgoing call.
- **Secrets.** The bot token and webhook secret live only in Cloudflare secrets and a git-ignored `.env`. `wrangler.toml` contains no secrets.
- **Abuse limits.** Private chats only. 12 messages per chat per minute (one polite warning, then silence). At most 5 tracked addresses per chat and 25 in total (`MAX_TOTAL_TROVES`). Users who block the bot are removed automatically.
- **Input handling.** Addresses are validated and checksummed before use. All chain and Telegram errors are caught, and users only see generic messages.
- **Data stored.** Telegram chat ID, the public address tracked, and the last alert state (tier, redemption flag, timestamp). Nothing else. `/untrack` deletes it.
- **Dashboard.** Strict CSP (`script-src 'self'`, `connect-src 'self'`, no inline script), and framing allowed only from Telegram's own web clients so the Mini App works there.
- **Landing page.** Served with `Content-Security-Policy: default-src 'none'` (inline styles and the data-URI favicon only), `nosniff`, no referrer, and `frame-ancestors 'none'`.
- **Dependencies.** `npm audit --omit=dev` reports 0 vulnerabilities. Known warnings are in dev-only test tooling that is never deployed.
- **Limits of this build.** It targets Mezo testnet. The alert thresholds are design defaults, not protocol values. Recovery Mode is shown as a flag only.

### Demo mode

To see alerts fire on a healthy position, set `DEMO_PRICE_DROP_PCT=40` (and optionally `POLL_SECONDS=15`) in `.env` and restart. The monitor then pretends BTC is 40% lower, and every message is labelled `DEMO MODE`. Leave it blank for real use.

The bot token is a secret. `.env` is git-ignored. Never paste the token anywhere public.

`npm run check` and `npm run system` need network access to `https://rpc.test.mezo.org`. They print the engine's numbers next to the contracts' own (trove count, system ratio, Stability Pool, ratio) so any decoding problem shows up immediately.

## What was verified from the MUSD source (mezo-org/musd)

- Chain ID 31611 (Matsnet testnet), RPC `https://rpc.test.mezo.org`.
- MCR is 110% and CCR is 150% (`LiquityBase.sol`).
- Redemptions start at the lowest-ratio trove, skip loans under 110%, and redeem debt net of the 200 MUSD gas compensation.
- Recovery Mode does not change the liquidation line (Mezo docs); it only blocks new loans below 150%.
- Closed troves leave the owners array, so Multicall enumeration sees only active loans.
- Function signatures in `src/abi.ts` match `ITroveManager`, `ISortedTroves`, `IPriceFeed`.
- Testnet addresses in `src/config.ts` come from the repo's deployment artifacts. Re-check them against the Mezo docs.

## Assumptions to confirm

- Tier thresholds (urgent below 120%, warning below 135%, watch below 150%, 3-point hysteresis) are design defaults, not protocol values.
- MUSD and BTC are treated as 18-decimal values.
