# noop-relay

The project's one small service, for the in-app Roadmap page. It lives **outside** the app repository on
purpose: `AGENTS.md` forbids shipping a receiver there, and keeping this source public is what makes
"NOOP runs no server" a checkable statement rather than a promise.

The app this serves: <https://github.com/DX23876/noop>. Licensed like the app, PolyForm
Noncommercial 1.0.0.

It does three things and nothing else:

| Route | What it does |
|---|---|
| `POST /v1/vote` | One thumb for a roadmap item. Body: `{"id": "...", "on": true, "key": "<32 hex>"}`. Deduplicated by the device key in D1, answers with the new count. |
| `POST /v1/suggestion` | Free text up to 500 characters. Opens an issue in the PRIVATE suggestions repository. Never public until the owner releases it. |
| `GET /v1/counts` | The current vote counts, so the app can show a number after someone voted. |
| `POST /v1/raw-upload-url` | Announces a donated raw-motion recording and answers with a single-use address that expires in ten minutes. |
| `PUT /v1/raw/<token>` | The recording itself, measured against what was announced and against the budget below, then written to the private R2 bucket. An index issue records sport, size and the withdrawal code. |

Not here, deliberately: no health data, no analytics, no logging of bodies or addresses, no account, no
cookie, no third-party script. The device key is a random 128-bit value the app makes on first use; it
identifies nothing and is used for nothing but refusing a second vote on the same item.

## What keeps it free

R2 gives away 10 GB a month. Cloudflare's spending limit covers Workers and Durable Objects, not R2 or
D1, and a budget alert only sends mail, so neither can be the answer here. Three things in this
repository are:

- **One donation is at most 1 MiB.** A full one is 432,000 bytes: three windows of two minutes, six axes
  of i16 at 100 Hz.
- **The size is measured, not believed.** The upload is read with a bound and refused past it, so a
  chunked body that declares no length cannot turn into an object of any size it likes.
- **`RAW_BUDGET_BYTES` caps the bytes ever written**, 4 GiB by default, counted in D1. Reaching it stops
  donations until the number is raised; it is not a monthly figure, because objects live 24 months and a
  figure that resets every month would bound nothing. A counter that cannot be read refuses the upload.

A spending alert in the dashboard is still worth having, as the thing that tells you the above failed.

## Tests

No account and no network needed; D1, R2 and GitHub are stubs:

```bash
node --test test/worker.test.mjs
```

They prove the behaviour the deployment will have, not the deployment itself.

## Setup

```bash
npm create cloudflare@latest -- noop-relay   # or: npx wrangler init
npx wrangler d1 create noop-relay
npx wrangler d1 execute noop-relay --file schema.sql
npx wrangler r2 bucket create noop-raw-donations
npx wrangler r2 bucket lifecycle add noop-raw-donations --expire-days 730   # the 24 months the app states
npx wrangler secret put GITHUB_TOKEN          # fine-grained, issues:write on the PRIVATE repo only
npx wrangler deploy
```

Then put the deployed address into `docs/app-feed.json` of the app repository, as
`"service": "https://noop-relay.<account>.workers.dev"`. Until that field is there, the app hides voting
and the suggestion field entirely, which is also the kill switch: remove the field and every installed
copy, however old, goes quiet on its own.

Use a `workers.dev` subdomain rather than a registered domain: a domain registration hangs off an
identity, and this project is anonymous by design. Free tier, no payment details, an account that holds
nothing else.
