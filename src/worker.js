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
// Bytes ever written to the bucket, over the life of the service. R2 gives away 10 GB (decimal), so
// 8 GiB is 8.59 GB of it and the remainder is deliberate margin, not caution about the allowance.
const DEFAULT_RAW_BUDGET_BYTES = 8 * 1024 * 1024 * 1024;
const DONATION_TTL_MS = 10 * 60 * 1000;
const DONATION_SPORTS = /^[a-z0-9_]{2,40}$/;
const MAX_ID = 40;
const CALLS_PER_HOUR = 30;
// A report needs more room than a wish: it describes what happened, on what, and what was expected.
const MAX_REPORT = 2000;
const MAX_REPLY = 1000;
// A redacted report bundle. Four times a donation, and on its own counter: a bad week of reports must
// not eat the allowance the donations live on, nor the other way round.
const MAX_REPORT_LOG_BYTES = 4 * 1024 * 1024;
const DEFAULT_LOG_BUDGET_BYTES = 2 * 1024 * 1024 * 1024;
// Letters and digits that survive being read aloud and typed back: no I, no O, no 0, no 1.
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_PATTERN = /^[2-9A-HJ-NP-Z]{4}(-[2-9A-HJ-NP-Z]{4}){3}$/;
// What marks a comment as the reporter's rather than the owner's. Both are posted by the same token,
// so without this the thread could not say who spoke, and an answer would read as a question.
const FROM_APP = "<!--app-->";
const LANG_PATTERN = /^[a-z]{2}(-[A-Za-z0-9]{2,8})?$/;
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
  // So it has to be visible SOMEWHERE, and a suggestion that silently never becomes an issue is the
  // hardest kind of fault to find. The status alone, no body, no token, no text anyone wrote: enough
  // to tell a refused token (401/403) from a repository that answers differently (404/422). With
  // observability off this is stored nowhere; it reaches a live `wrangler tail` and otherwise nobody.
  if (!response.ok) {
    console.warn(`suggestion refused by GitHub: ${response.status}`);
    return json({ ok: false }, 502);
  }
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
 * A report code: four groups of four, 80 bits of randomness. It is the whole credential for a thread,
 * so it is generated here and never derived from anything about the device. Groups because somebody
 * has to be able to read it off one screen and type it into another.
 */
function newReportCode() {
  const raw = new Uint8Array(16);
  crypto.getRandomValues(raw);
  const letters = [...raw].map((n) => CODE_ALPHABET[n % CODE_ALPHABET.length]);
  return [0, 4, 8, 12].map((at) => letters.slice(at, at + 4).join("")).join("-");
}

/** The log budget, counted apart from the donations but by the same rules. See `budgetTake`. */
function logBudget(env) {
  const configured = Number(env.LOG_BUDGET_BYTES);
  return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_LOG_BUDGET_BYTES;
}

async function logBudgetTake(db, bytes, limit) {
  try {
    const row = await db
      .prepare("INSERT INTO log_budget (id, bytes) VALUES (1, ?) " +
               "ON CONFLICT(id) DO UPDATE SET bytes = bytes + excluded.bytes RETURNING bytes")
      .bind(bytes)
      .first();
    const total = Number(row?.bytes);
    if (!Number.isFinite(total)) return false;
    if (total > limit) {
      await db.prepare("UPDATE log_budget SET bytes = MAX(bytes - ?, 0) WHERE id = 1")
        .bind(bytes).run().catch(() => {});
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** One call to GitHub, always with the same headers, never with anything about the caller. */
function github(env, path, init = {}) {
  return fetch(`https://api.github.com/repos/${env.SUGGESTION_REPO}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "noop-relay",
      ...(init.headers || {}),
    },
  });
}

/**
 * A reported problem. It goes to the PRIVATE repository and stops there: publishing is a press in the
 * owner's hands, never a consequence of sending (see the repository's README). The moderation filter
 * that guards wishes is deliberately not in this path, because it answers "may this be published",
 * and the answer here is already no.
 *
 * With `thread: false` nothing is stored at all: no code, no row, no way back. Some people want to
 * help once without leaving a channel open, and that has to be possible.
 */
async function report(request, env) {
  const body = await request.json().catch(() => null);
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  const key = typeof body?.key === "string" ? body.key : "";
  const lang = typeof body?.lang === "string" && LANG_PATTERN.test(body.lang) ? body.lang : "en";
  const wantsThread = body?.thread !== false;
  if (!text || text.length > MAX_REPORT || !KEY_PATTERN.test(key)) {
    return json({ error: "bad request" }, 400);
  }
  if (!(await withinRate(env.DB, key))) return json({ error: "slow down" }, 429);

  const code = wantsThread ? newReportCode() : null;
  const firstLine = text.split("\n")[0].slice(0, 80).trim() || "Reported from the app";
  const lines = [text];
  if (code) lines.push("", `Code: ${code}`, `Language: ${lang}`);
  else lines.push("", "Sent without a thread: there is no way to ask this reporter anything.");

  const response = await github(env, "/issues", {
    method: "POST",
    body: JSON.stringify({ title: firstLine, body: lines.join("\n"),
                           labels: ["bug", "from-app"] }),
  });
  if (!response.ok) {
    console.warn(`report refused by GitHub: ${response.status}`);
    return json({ ok: false }, 502);
  }
  if (!code) return json({ ok: true });

  const number = Number((await response.json().catch(() => ({})))?.number);
  if (!Number.isFinite(number)) return json({ ok: false }, 502);
  await env.DB
    .prepare("INSERT INTO reports (code, number, lang, at) VALUES (?, ?, ?, ?)")
    .bind(code, number, lang, Date.now())
    .run();
  return json({ ok: true, code });
}

/** The row behind a code, or nothing. Every thread route starts here and none of them says more. */
async function reportRow(env, code) {
  if (!CODE_PATTERN.test(code)) return null;
  return await env.DB.prepare("SELECT * FROM reports WHERE code = ?").bind(code).first();
}

/**
 * The thread as the reporter sees it: their own words, the owner's answers, and where the matter
 * stands. A wrong code is answered exactly like a withdrawn one, so the route cannot be used to find
 * out which codes exist.
 */
async function thread(request, env, code) {
  const row = await reportRow(env, code);
  if (!row) return json({ error: "gone" }, 410);

  const issue = await github(env, `/issues/${row.number}`);
  if (!issue.ok) {
    console.warn(`thread refused by GitHub: ${issue.status}`);
    return json({ ok: false }, 502);
  }
  const data = await issue.json();
  const comments = await github(env, `/issues/${row.number}/comments?per_page=100`);
  const list = comments.ok ? await comments.json() : [];

  return json({
    status: statusOf(data),
    fixedIn: fixedInOf(data),
    publicNumber: publicNumberOf(data.body),
    messages: list
      .map((c) => ({
        mine: String(c.body || "").startsWith(FROM_APP),
        text: String(c.body || "").replace(FROM_APP, "").trim().slice(0, MAX_REPORT),
        at: c.created_at,
      }))
      .filter((m) => m.text.length > 0),
  });
}

/** Reported, read, being worked on, fixed: from the labels, never invented. */
function statusOf(issue) {
  const labels = (issue.labels || []).map((l) => (typeof l === "string" ? l : l?.name) || "");
  if ((issue.state || "").toLowerCase() === "closed") {
    return (issue.state_reason || "").toUpperCase() === "NOT_PLANNED" ? "notPlanned" : "fixed";
  }
  if (labels.includes("in-progress")) return "working";
  // Any label at all means somebody has been here: that is what "read" honestly means, and it is not
  // set by hand, so it cannot say read when nobody read it.
  return labels.some((l) => l !== "bug" && l !== "from-app") ? "read" : "arrived";
}

function fixedInOf(issue) {
  const labels = (issue.labels || []).map((l) => (typeof l === "string" ? l : l?.name) || "");
  const hit = labels.find((l) => /^fixed-in:\d+\.\d+(\.\d+)?$/.test(l));
  return hit ? hit.slice("fixed-in:".length) : null;
}

/** The public issue this became, written into the private body by the publishing workflow. */
function publicNumberOf(body) {
  const hit = /(?:^|\n)Public: #(\d+)/.exec(String(body || ""));
  return hit ? Number(hit[1]) : null;
}

/** The reporter answering a question. Marked, so the thread can tell the two voices apart. */
async function reply(request, env) {
  const body = await request.json().catch(() => null);
  const code = typeof body?.code === "string" ? body.code : "";
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  const key = typeof body?.key === "string" ? body.key : "";
  if (!text || text.length > MAX_REPLY || !KEY_PATTERN.test(key)) {
    return json({ error: "bad request" }, 400);
  }
  if (!(await withinRate(env.DB, key))) return json({ error: "slow down" }, 429);
  const row = await reportRow(env, code);
  if (!row) return json({ error: "gone" }, 410);

  const response = await github(env, `/issues/${row.number}/comments`, {
    method: "POST",
    body: JSON.stringify({ body: `${FROM_APP}\n${text}` }),
  });
  if (!response.ok) {
    console.warn(`reply refused by GitHub: ${response.status}`);
    return json({ ok: false }, 502);
  }
  return json({ ok: true });
}

/** Taking it back: the log goes, the thread is closed, the code stops working. */
async function withdraw(request, env) {
  const body = await request.json().catch(() => null);
  const row = await reportRow(env, typeof body?.code === "string" ? body.code : "");
  if (!row) return json({ error: "gone" }, 410);

  if (env.RAW) {
    const listing = await env.RAW.list({ prefix: `reports/${row.code}/` }).catch(() => null);
    for (const object of listing?.objects || []) await env.RAW.delete(object.key).catch(() => {});
  }
  await github(env, `/issues/${row.number}/comments`, {
    method: "POST",
    body: JSON.stringify({ body: "The reporter withdrew this. The log is deleted." }),
  }).catch(() => {});
  await env.DB.prepare("DELETE FROM reports WHERE code = ?").bind(row.code).run();
  await env.DB.prepare("DELETE FROM report_uploads WHERE code = ?").bind(row.code).run();
  return json({ ok: true });
}

/** The log, by the same two steps as a donation, with its own ceiling and its own counter. */
async function reportLogTarget(request, env) {
  const body = await request.json().catch(() => null);
  const bytes = Number(body?.bytes);
  const row = await reportRow(env, typeof body?.code === "string" ? body.code : "");
  if (!row) return json({ error: "gone" }, 410);
  if (!(bytes > 0 && bytes <= MAX_REPORT_LOG_BYTES)) return json({ error: "bad request" }, 400);
  if (!env.RAW) return json({ error: "no logs" }, 503);

  const token = crypto.randomUUID().replace(/-/g, "");
  await env.DB
    .prepare("INSERT INTO report_uploads (token, code, bytes, at) VALUES (?, ?, ?, ?)")
    .bind(token, row.code, bytes, Date.now())
    .run();
  const base = new URL(request.url);
  return json({ url: `${base.origin}/v1/report-log/${token}` });
}

async function reportLogUpload(request, env, token) {
  const row = await env.DB.prepare("SELECT * FROM report_uploads WHERE token = ?").bind(token).first();
  if (!row) return json({ error: "gone" }, 410);
  if (Date.now() - row.at > DONATION_TTL_MS) return json({ error: "expired" }, 410);
  if (!env.RAW) return json({ error: "no logs" }, 503);

  const declared = Number(row.bytes);
  const ceiling = Math.min(MAX_REPORT_LOG_BYTES,
                           Number.isFinite(declared) && declared > 0 ? declared : MAX_REPORT_LOG_BYTES);
  const payload = await bodyWithin(request, ceiling);
  if (!payload) return json({ error: "too large" }, 413);
  if (!(await logBudgetTake(env.DB, payload.byteLength, logBudget(env)))) {
    return json({ error: "no logs" }, 503);
  }

  const key = `reports/${row.code}/${token}.zip`;
  try {
    await env.RAW.put(key, payload, { httpMetadata: { contentType: "application/zip" } });
  } catch {
    await env.DB.prepare("UPDATE log_budget SET bytes = MAX(bytes - ?, 0) WHERE id = 1")
      .bind(payload.byteLength).run().catch(() => {});
    return json({ error: "not stored" }, 502);
  }
  await env.DB.prepare("DELETE FROM report_uploads WHERE token = ?").bind(token).run();

  const report = await env.DB.prepare("SELECT number FROM reports WHERE code = ?")
    .bind(row.code).first().catch(() => null);
  if (report?.number) {
    await github(env, `/issues/${report.number}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: `Log attached: \`${key}\` (${payload.byteLength} bytes).` }),
    }).catch(() => {});
  }
  return json({ ok: true });
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
    if (request.method === "POST" && url.pathname === "/v1/report") return report(request, env);
    if (request.method === "GET" && url.pathname === "/v1/report") {
      return thread(request, env, url.searchParams.get("code") || "");
    }
    if (request.method === "POST" && url.pathname === "/v1/report/reply") return reply(request, env);
    if (request.method === "POST" && url.pathname === "/v1/report/withdraw") return withdraw(request, env);
    if (request.method === "POST" && url.pathname === "/v1/report-log-url") {
      return reportLogTarget(request, env);
    }
    if (request.method === "PUT" && url.pathname.startsWith("/v1/report-log/")) {
      return reportLogUpload(request, env, url.pathname.slice("/v1/report-log/".length));
    }
    // 410 rather than 404 for anything else: an app that meets a retired service should stop asking.
    return json({ error: "gone" }, 410);
  },
};
