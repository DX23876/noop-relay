// noop-relay — the project's one small service: thumbs for roadmap items and a private suggestion box.
//
// Everything here is written so that the honest sentence stays true: NOOP sends nothing about a person.
// No body is logged, no address is stored, there is no account, no cookie and no third-party script. The
// device key is a random 128-bit value the app makes on first use; it identifies nothing and exists only
// so a second vote on the same item can be refused.
//
// The app finds this service through the `service` field in the app repository's docs/app-feed.json. Take
// the field out and every installed copy, however old, goes quiet without an update. That is the kill
// switch, and it is why the address is not baked into the app.

const MAX_SUGGESTION = 500;
// A full donation is 432,000 bytes: three windows of two minutes, six axes of i16 at 100 Hz
// (`RawDonationPlan.approximateBytes` in the app's core). 1 MiB leaves room for a longer plan or
// a header without leaving room for someone else's video.
const MAX_DONATION_BYTES = 1024 * 1024;
// Bytes ever written to the bucket, over the life of the service. R2's free allowance is 10 GB.
const DEFAULT_RAW_BUDGET_BYTES = 4 * 1024 * 1024 * 1024;
const DONATION_TTL_MS = 10 * 60 * 1000;
const DONATION_SPORTS = /^[a-z0-9_]{2,40}$/;
const MAX_ID = 40;
const CALLS_PER_HOUR = 30;
const KEY_PATTERN = /^[0-9a-f]{32}$/;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,39}$/;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS },
  });

/** Bounded, per device key and per hour. Keeps one broken client from filling the table. */
async function withinRate(db, key) {
  const hour = Math.floor(Date.now() / 3600000);
  await db
    .prepare("INSERT INTO calls (key, hour, n) VALUES (?, ?, 1) " +
             "ON CONFLICT(key, hour) DO UPDATE SET n = n + 1")
    .bind(key, hour)
    .run();
  const row = await db.prepare("SELECT n FROM calls WHERE key = ? AND hour = ?").bind(key, hour).first();
  return (row?.n ?? 0) <= CALLS_PER_HOUR;
}

async function countFor(db, item) {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM votes WHERE item = ?").bind(item).first();
  return row?.n ?? 0;
}

/** One thumb, withdrawable. The count is a COUNT(*), never a number we add to, so a retry cannot inflate it. */
async function vote(request, env) {
  const body = await request.json().catch(() => null);
  const id = typeof body?.id === "string" ? body.id : "";
  const key = typeof body?.key === "string" ? body.key : "";
  if (!ID_PATTERN.test(id) || id.length > MAX_ID || !KEY_PATTERN.test(key)) {
    return json({ error: "bad request" }, 400);
  }
  if (!(await withinRate(env.DB, key))) return json({ error: "slow down" }, 429);

  if (body.on === false) {
    await env.DB.prepare("DELETE FROM votes WHERE item = ? AND key = ?").bind(id, key).run();
  } else {
    await env.DB
      .prepare("INSERT OR IGNORE INTO votes (item, key, at) VALUES (?, ?, ?)")
      .bind(id, key, Date.now())
      .run();
  }
  return json({ id, count: await countFor(env.DB, id) });
}

/** Every count at once: the app asks for them after someone has voted, never before. */
async function counts(env) {
  const { results } = await env.DB.prepare("SELECT item, COUNT(*) AS n FROM votes GROUP BY item").all();
  const out = {};
  for (const row of results ?? []) out[row.item] = row.n;
  return json({ counts: out });
}

/**
 * A suggestion becomes an issue in the PRIVATE repository. It is not public, and the app never reads it
 * back: what reaches other people is only what the owner releases into the generated feed later.
 */
async function suggestion(request, env) {
  const body = await request.json().catch(() => null);
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  const key = typeof body?.key === "string" ? body.key : "";
  if (!text || text.length > MAX_SUGGESTION || !KEY_PATTERN.test(key)) {
    return json({ error: "bad request" }, 400);
  }
  if (!(await withinRate(env.DB, key))) return json({ error: "slow down" }, 429);

  const firstLine = text.split("\n")[0].slice(0, 80).trim() || "Suggestion";
  const response = await fetch(`https://api.github.com/repos/${env.SUGGESTION_REPO}/issues`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      // GitHub asks automated clients to identify themselves; a generic client name, never a person.
      "user-agent": "noop-relay",
    },
    body: JSON.stringify({ title: firstLine, body: text, labels: ["suggestion", "from-app"] }),
  });
  // The reporter learns that it arrived, never why it did not: a failure here is the owner's to see.
  if (!response.ok) return json({ ok: false }, 502);
  return json({ ok: true });
}

/**
 * Read at most `limit` bytes, or nothing. The announcement's cap bounds what a donor SAYS it will send;
 * this bounds what arrives. `content-length` is not the place to decide it: a chunked upload carries
 * none, and a header is a claim either way. A full donation is 432 KB, so holding one in memory to
 * measure it costs nothing worth saving.
 */
async function bodyWithin(request, limit) {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  if (total === 0) return null;
  const all = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return all;
}

/**
 * The cost cap, and the only real one. R2 gives away 10 GB; Cloudflare's spending limit covers Workers
 * and Durable Objects, not R2 or D1; a budget alert sends mail and stops nothing. So the thing that
 * keeps this service inside the free tier is this counter and the refusal under it, not a setting.
 *
 * It counts bytes EVER written, not bytes this month. Objects age out after 24 months, so stored bytes
 * can never exceed this number, which a figure that resets every month would not bound. When it fills,
 * donations stop and the owner decides: raise `RAW_BUDGET_BYTES`, or delete what is no longer needed.
 *
 * Every failure in here refuses the upload. A counter that cannot be read is not permission to write.
 */
function rawBudget(env) {
  const configured = Number(env.RAW_BUDGET_BYTES);
  return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_RAW_BUDGET_BYTES;
}

async function budgetUsed(db) {
  const row = await db.prepare("SELECT bytes FROM budget WHERE id = 1").first();
  return Number(row?.bytes ?? 0);
}

async function budgetGiveBack(db, bytes) {
  try {
    await db.prepare("UPDATE budget SET bytes = MAX(bytes - ?, 0) WHERE id = 1").bind(bytes).run();
  } catch {
    // Nothing to do but leave the reservation standing: it only ever refuses too early, never too late.
  }
}

/** Count first, then judge, so two uploads at once can overshoot by one object and never by more. */
async function budgetTake(db, bytes, limit) {
  try {
    const row = await db
      .prepare("INSERT INTO budget (id, bytes) VALUES (1, ?) " +
               "ON CONFLICT(id) DO UPDATE SET bytes = bytes + excluded.bytes RETURNING bytes")
      .bind(bytes)
      .first();
    const total = Number(row?.bytes);
    if (!Number.isFinite(total)) return false;
    if (total > limit) {
      await budgetGiveBack(db, bytes);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * A donated raw-motion recording. Two steps on purpose: the app asks where to put it, then puts the
 * bytes there. The second address is single use and expires, so a leaked one is worth nothing an hour
 * later, and the app never holds a bucket credential.
 *
 * The bytes are read with a bound and then put, not streamed through: a stream of unknown size is the
 * one thing that could spend money here, and a donation is a few hundred kilobytes.
 */
async function donationTarget(request, env) {
  const body = await request.json().catch(() => null);
  const sport = typeof body?.sport === "string" ? body.sport : "";
  const bytes = Number(body?.bytes);
  const code = typeof body?.code === "string" ? body.code : "";
  if (!DONATION_SPORTS.test(sport) || !(bytes > 0 && bytes <= MAX_DONATION_BYTES) ||
      !/^R-[A-Z0-9]{4}$/.test(code)) {
    return json({ error: "bad request" }, 400);
  }
  // Refused here as well as at the upload, so a wearer who pressed the button learns it now rather
  // than after sending. Unreadable counter means no: see `budgetTake`.
  if (!env.RAW) return json({ error: "no donations" }, 503);
  const used = await budgetUsed(env.DB).catch(() => Number.POSITIVE_INFINITY);
  if (used + bytes > rawBudget(env)) return json({ error: "no donations" }, 503);

  const token = crypto.randomUUID().replace(/-/g, "");
  // The metadata, never the wearer: sport, size, strap family, firmware, app version, a day, the code.
  await env.DB
    .prepare("INSERT INTO donations (token, code, sport, bytes, meta, at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(token, code, sport, bytes, JSON.stringify(body), Date.now())
    .run();
  const base = new URL(request.url);
  return json({ url: `${base.origin}/v1/raw/${token}` });
}

async function donationUpload(request, env, token) {
  const row = await env.DB.prepare("SELECT * FROM donations WHERE token = ?").bind(token).first();
  if (!row) return json({ error: "gone" }, 410);
  if (Date.now() - row.at > DONATION_TTL_MS) return json({ error: "expired" }, 410);
  if (!env.RAW) return json({ error: "no donations" }, 503);

  // No more than it announced, and no more than one donation can be, measured here rather than trusted.
  const declared = Number(row.bytes);
  const ceiling = Math.min(MAX_DONATION_BYTES,
                           Number.isFinite(declared) && declared > 0 ? declared : MAX_DONATION_BYTES);
  const payload = await bodyWithin(request, ceiling);
  if (!payload) return json({ error: "too large" }, 413);

  const length = payload.byteLength;
  if (!(await budgetTake(env.DB, length, rawBudget(env)))) return json({ error: "no donations" }, 503);

  const key = `${row.sport}/${row.code}-${token}.bin`;
  try {
    await env.RAW.put(key, payload, { httpMetadata: { contentType: "application/octet-stream" } });
  } catch {
    // Nothing was stored, so nothing is owed: a failed put must not eat the budget for good.
    await budgetGiveBack(env.DB, length);
    return json({ error: "not stored" }, 502);
  }
  await env.DB.prepare("DELETE FROM donations WHERE token = ?").bind(token).run();

  // An index entry so the owner can find, count and withdraw one. The code is what a donor quotes.
  if (env.GITHUB_TOKEN && env.SUGGESTION_REPO) {
    const meta = JSON.parse(row.meta || "{}");
    await fetch(`https://api.github.com/repos/${env.SUGGESTION_REPO}/issues`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "noop-relay",
      },
      body: JSON.stringify({
        title: `Raw donation ${row.code} (${row.sport})`,
        body: ["```json", JSON.stringify(meta, null, 2), "```", "", `Object: ${key}`].join("\n"),
        labels: ["raw-donation", row.sport],
      }),
    }).catch(() => {});
  }
  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method === "GET" && url.pathname === "/v1/counts") return counts(env);
    if (request.method === "POST" && url.pathname === "/v1/vote") return vote(request, env);
    if (request.method === "POST" && url.pathname === "/v1/suggestion") return suggestion(request, env);
    if (request.method === "POST" && url.pathname === "/v1/raw-upload-url") return donationTarget(request, env);
    if (request.method === "PUT" && url.pathname.startsWith("/v1/raw/")) {
      return donationUpload(request, env, url.pathname.slice("/v1/raw/".length));
    }
    // 410 rather than 404 for anything else: an app that meets a retired service should stop asking.
    return json({ error: "gone" }, 410);
  },
};
