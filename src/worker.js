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
const MAX_DONATION_BYTES = 8 * 1024 * 1024;
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
 * A donated raw-motion recording. Two steps on purpose: the app asks where to put it, then puts the
 * bytes there. The second address is single use and expires, so a leaked one is worth nothing an hour
 * later, and the app never holds a bucket credential.
 *
 * The bytes stream straight into R2. A donation is a few hundred kilobytes, so nothing is buffered.
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
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_DONATION_BYTES) return json({ error: "too large" }, 413);

  const key = `${row.sport}/${row.code}-${token}.bin`;
  await env.RAW.put(key, request.body, { httpMetadata: { contentType: "application/octet-stream" } });
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
