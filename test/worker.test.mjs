// Tests for the relay, with no Cloudflare account and no network: D1, R2 and GitHub are stubs.
//
// What they are for: the worker cannot be reached by the app until someone deploys it, so without this
// the first proof that any of it works would be a stranger's lost vote. These run anywhere node does:
//
//     node --test backlog/noop-relay/test/
//
// They do not prove the deployment. They prove the behaviour the deployment will have.

import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/worker.js";

/** A D1 stand-in: enough SQL for the four statements the worker issues, and nothing more. */
function makeDB() {
  const votes = new Map();      // `${item}\u0000${key}` -> at
  const calls = new Map();      // `${key}\u0000${hour}` -> n
  const donations = new Map();  // token -> row
  const budget = { bytes: 0 };     // donated bytes ever written, the cost cap's counter
  const logBudget = { bytes: 0 };  // report-log bytes, counted apart on purpose
  const reports = new Map();       // code -> row
  const uploads = new Map();       // token -> row
  return {
    votes, calls, donations, budget, logBudget, reports, uploads,
    prepare(sql) {
      let bound = [];
      const api = {
        bind(...args) { bound = args; return api; },
        async run() {
          if (sql.startsWith("INSERT INTO calls")) {
            const [key, hour] = bound;
            const id = `${key}\u0000${hour}`;
            calls.set(id, (calls.get(id) ?? 0) + 1);
          } else if (sql.startsWith("DELETE FROM votes")) {
            votes.delete(`${bound[0]}\u0000${bound[1]}`);
          } else if (sql.startsWith("INSERT OR IGNORE INTO votes")) {
            const id = `${bound[0]}\u0000${bound[1]}`;
            if (!votes.has(id)) votes.set(id, bound[2]);
          } else if (sql.startsWith("INSERT INTO donations")) {
            const [token, code, sport, bytes, meta, at] = bound;
            donations.set(token, { token, code, sport, bytes, meta, at });
          } else if (sql.startsWith("DELETE FROM donations")) {
            donations.delete(bound[0]);
          } else if (sql.startsWith("UPDATE budget")) {
            budget.bytes = Math.max(budget.bytes - bound[0], 0);
          } else if (sql.startsWith("UPDATE log_budget")) {
            logBudget.bytes = Math.max(logBudget.bytes - bound[0], 0);
          } else if (sql.startsWith("INSERT INTO reports")) {
            const [code, number, lang, at] = bound;
            reports.set(code, { code, number, lang, at });
          } else if (sql.startsWith("DELETE FROM reports")) {
            reports.delete(bound[0]);
          } else if (sql.startsWith("INSERT INTO report_uploads")) {
            const [token, code, bytes, at] = bound;
            uploads.set(token, { token, code, bytes, at });
          } else if (sql.startsWith("DELETE FROM report_uploads")) {
            for (const [token, row] of [...uploads]) {
              if (row.code === bound[0] || token === bound[0]) uploads.delete(token);
            }
          }
          return { success: true };
        },
        async first() {
          if (sql.startsWith("SELECT n FROM calls")) {
            return { n: calls.get(`${bound[0]}\u0000${bound[1]}`) ?? 0 };
          }
          if (sql.startsWith("SELECT COUNT(*) AS n FROM votes")) {
            let n = 0;
            for (const id of votes.keys()) if (id.split("\u0000")[0] === bound[0]) n += 1;
            return { n };
          }
          if (sql.startsWith("SELECT * FROM donations")) return donations.get(bound[0]) ?? null;
          if (sql.startsWith("SELECT bytes FROM budget")) return { bytes: budget.bytes };
          if (sql.startsWith("INSERT INTO budget")) {
            budget.bytes += bound[0];
            return { bytes: budget.bytes };
          }
          if (sql.startsWith("INSERT INTO log_budget")) {
            logBudget.bytes += bound[0];
            return { bytes: logBudget.bytes };
          }
          if (sql.startsWith("SELECT * FROM reports")) return reports.get(bound[0]) ?? null;
          if (sql.startsWith("SELECT number FROM reports")) return reports.get(bound[0]) ?? null;
          if (sql.startsWith("SELECT * FROM report_uploads")) return uploads.get(bound[0]) ?? null;
          return null;
        },
        async all() {
          const counts = new Map();
          for (const id of votes.keys()) {
            const item = id.split("\u0000")[0];
            counts.set(item, (counts.get(item) ?? 0) + 1);
          }
          return { results: [...counts].map(([item, n]) => ({ item, n })) };
        },
      };
      return api;
    },
  };
}

function makeEnv(overrides = {}) {
  const puts = [];
  return {
    DB: makeDB(),
    RAW: {
      puts,
      async put(key, body, opts) { puts.push({ key, body, opts }); },
      async list({ prefix }) {
        return { objects: puts.filter((p) => p.key.startsWith(prefix)).map((p) => ({ key: p.key })) };
      },
      async delete(key) {
        const at = puts.findIndex((p) => p.key === key);
        if (at >= 0) puts.splice(at, 1);
      },
    },
    SUGGESTION_REPO: "owner/private",
    GITHUB_TOKEN: "test-token",
    ...overrides,
  };
}

const KEY = "0123456789abcdef0123456789abcdef";

function post(path, body) {
  return new Request(`https://relay.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// GitHub is never really called.
function captureFetch() {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return new Response("{}", { status: 201 });
  };
  return seen;
}

test("a vote counts once per device and can be withdrawn", async () => {
  const env = makeEnv();
  let response = await worker.fetch(post("/v1/vote", { id: "s-12", on: true, key: KEY }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: "s-12", count: 1 });

  // The same device again does not inflate the count: it is a COUNT(*), not an increment.
  response = await worker.fetch(post("/v1/vote", { id: "s-12", on: true, key: KEY }), env);
  assert.equal((await response.json()).count, 1);

  const other = "ffffffffffffffffffffffffffffffff";
  response = await worker.fetch(post("/v1/vote", { id: "s-12", on: true, key: other }), env);
  assert.equal((await response.json()).count, 2);

  response = await worker.fetch(post("/v1/vote", { id: "s-12", on: false, key: KEY }), env);
  assert.equal((await response.json()).count, 1, "a thumb must be withdrawable");
});

test("a malformed vote is refused before it reaches the table", async () => {
  const env = makeEnv();
  for (const body of [{ id: "Caps", key: KEY }, { id: "s-12", key: "short" },
                      { id: "", key: KEY }, { id: "s-12" }, {}]) {
    const response = await worker.fetch(post("/v1/vote", body), env);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.equal(env.DB.votes.size, 0);
});

test("one device cannot hammer the service", async () => {
  const env = makeEnv();
  let last;
  for (let i = 0; i < 40; i += 1) {
    last = await worker.fetch(post("/v1/vote", { id: `s-${i + 2}`, on: true, key: KEY }), env);
  }
  assert.equal(last.status, 429, "the rate limit has to bite somewhere under forty calls");
});

test("counts come back as a plain map", async () => {
  const env = makeEnv();
  await worker.fetch(post("/v1/vote", { id: "s-1", on: true, key: KEY }), env);
  const response = await worker.fetch(new Request("https://relay.test/v1/counts"), env);
  assert.deepEqual(await response.json(), { counts: { "s-1": 1 } });
});

test("a suggestion becomes an issue in the private repository, with its first line as the title", async () => {
  const seen = captureFetch();
  const env = makeEnv();
  const text = "A dark mode for the charts\nIt would help at night.";
  const response = await worker.fetch(post("/v1/suggestion", { text, key: KEY }), env);
  assert.equal(response.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://api.github.com/repos/owner/private/issues");
  const body = JSON.parse(seen[0].init.body);
  assert.equal(body.title, "A dark mode for the charts");
  assert.equal(body.body, text);
  assert.deepEqual(body.labels, ["suggestion", "from-app"]);
});

test("an empty or over-long suggestion never reaches GitHub", async () => {
  const seen = captureFetch();
  const env = makeEnv();
  for (const text of ["", "   ", "x".repeat(501)]) {
    const response = await worker.fetch(post("/v1/suggestion", { text, key: KEY }), env);
    assert.equal(response.status, 400);
  }
  assert.equal(seen.length, 0);
});

test("a donation is announced, then uploaded to a single-use address", async () => {
  const seen = captureFetch();
  const env = makeEnv();
  const announce = await worker.fetch(
    post("/v1/raw-upload-url", { sport: "cycling", bytes: 432000, code: "R-4K8T" }), env);
  assert.equal(announce.status, 200);
  const { url } = await announce.json();
  assert.match(url, /^https:\/\/relay\.test\/v1\/raw\/[0-9a-f]{32}$/);

  const put = await worker.fetch(new Request(url, { method: "PUT", body: "bytes" }), env);
  assert.equal(put.status, 200);
  assert.equal(env.RAW.puts.length, 1);
  assert.match(env.RAW.puts[0].key, /^cycling\/R-4K8T-[0-9a-f]{32}\.bin$/);
  assert.equal(seen.length, 1, "an index issue records what arrived");
  assert.match(JSON.parse(seen[0].init.body).title, /^Raw donation R-4K8T \(cycling\)$/);

  const again = await worker.fetch(new Request(url, { method: "PUT", body: "bytes" }), env);
  assert.equal(again.status, 410, "the address is single use");
});

test("a donation address expires", async () => {
  captureFetch();
  const env = makeEnv();
  const announce = await worker.fetch(
    post("/v1/raw-upload-url", { sport: "walking", bytes: 1000, code: "R-ABCD" }), env);
  const { url } = await announce.json();
  for (const row of env.DB.donations.values()) row.at -= 11 * 60 * 1000;
  const put = await worker.fetch(new Request(url, { method: "PUT", body: "bytes" }), env);
  assert.equal(put.status, 410);
  assert.equal(env.RAW.puts.length, 0, "nothing lands in the bucket after the window closed");
});

test("more bytes than it announced never reach the bucket, with or without a length header", async () => {
  captureFetch();
  const env = makeEnv();
  const announce = () => worker.fetch(
    post("/v1/raw-upload-url", { sport: "walking", bytes: 432000, code: "R-ABCD" }), env);

  // One byte over what it announced.
  let url = (await (await announce()).json()).url;
  let put = await worker.fetch(new Request(url, { method: "PUT", body: "x".repeat(432001) }), env);
  assert.equal(put.status, 413);

  // The same, as a chunked stream that carries no content-length: the size is measured, not believed.
  url = (await (await announce()).json()).url;
  const big = new ReadableStream({
    start(c) {
      for (let i = 0; i < 44; i += 1) c.enqueue(new Uint8Array(10_000));
      c.close();
    },
  });
  put = await worker.fetch(new Request(url, { method: "PUT", body: big, duplex: "half" }), env);
  assert.equal(put.status, 413);

  // And an empty body is not a donation either.
  url = (await (await announce()).json()).url;
  put = await worker.fetch(new Request(url, { method: "PUT", body: "" }), env);
  assert.equal(put.status, 413);

  assert.equal(env.RAW.puts.length, 0, "nothing was stored");
  assert.equal(env.DB.budget.bytes, 0, "and nothing was counted against the budget");
});

test("the budget is the cap: it counts what arrived and refuses what would exceed it", async () => {
  captureFetch();
  const env = makeEnv({ RAW_BUDGET_BYTES: "500000" });

  const first = await (await worker.fetch(
    post("/v1/raw-upload-url", { sport: "cycling", bytes: 432000, code: "R-4K8T" }), env)).json();
  const put = await worker.fetch(
    new Request(first.url, { method: "PUT", body: "x".repeat(432000) }), env);
  assert.equal(put.status, 200);
  assert.equal(env.DB.budget.bytes, 432000, "the bytes that arrived, not the bytes announced");

  // 432,000 of 500,000 are gone, so the next one is refused at the announcement already.
  const second = await worker.fetch(
    post("/v1/raw-upload-url", { sport: "cycling", bytes: 432000, code: "R-5L9U" }), env);
  assert.equal(second.status, 503);
  assert.equal(env.DB.donations.size, 0, "a refused donation is not even announced");
  assert.equal(env.RAW.puts.length, 1, "and nothing more reached the bucket");
});

test("a bucket that refuses the bytes gives the budget back", async () => {
  captureFetch();
  const env = makeEnv({ RAW: { puts: [], async put() { throw new Error("no space"); } } });
  const { url } = await (await worker.fetch(
    post("/v1/raw-upload-url", { sport: "running", bytes: 1000, code: "R-ZZZZ" }), env)).json();
  const put = await worker.fetch(new Request(url, { method: "PUT", body: "x".repeat(1000) }), env);
  assert.equal(put.status, 502);
  assert.equal(env.DB.budget.bytes, 0, "nothing stored, nothing owed");
});

test("without a bucket the service says so instead of failing", async () => {
  const env = makeEnv({ RAW: undefined });
  const response = await worker.fetch(
    post("/v1/raw-upload-url", { sport: "cycling", bytes: 1000, code: "R-4K8T" }), env);
  assert.equal(response.status, 503);
});

test("a counter that cannot be read is not permission to write", async () => {
  captureFetch();
  const env = makeEnv();
  const { url } = await (await worker.fetch(
    post("/v1/raw-upload-url", { sport: "cycling", bytes: 1000, code: "R-4K8T" }), env)).json();
  const broken = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => (sql.startsWith("INSERT INTO budget")
    ? { bind: () => ({ async first() { throw new Error("D1 is down"); } }) }
    : broken(sql));
  const put = await worker.fetch(new Request(url, { method: "PUT", body: "x".repeat(1000) }), env);
  assert.equal(put.status, 503);
  assert.equal(env.RAW.puts.length, 0);
});

test("a nonsense announcement is refused", async () => {
  const env = makeEnv();
  for (const body of [{ sport: "Cycling", bytes: 10, code: "R-4K8T" },      // sport must be a key
                      { sport: "cycling", bytes: 0, code: "R-4K8T" },
                      { sport: "cycling", bytes: 2 * 1024 * 1024, code: "R-4K8T" },   // over 1 MiB
                      { sport: "cycling", bytes: 10, code: "nope" }]) {
    const response = await worker.fetch(post("/v1/raw-upload-url", body), env);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.equal(env.DB.donations.size, 0);
});

// GitHub, answering the four calls the report routes make. `issue` is what the thread route will read.
function captureGitHub({ issue = {}, comments = [] } = {}) {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    seen.push({ url: target, init });
    const method = (init?.method || "GET").toUpperCase();
    if (method === "POST" && target.endsWith("/issues")) {
      return new Response(JSON.stringify({ number: 7 }), { status: 201 });
    }
    if (method === "GET" && /\/issues\/\d+\/comments/.test(target)) {
      return new Response(JSON.stringify(comments), { status: 200 });
    }
    if (method === "GET" && /\/issues\/\d+$/.test(target)) {
      return new Response(JSON.stringify({ state: "open", labels: [], body: "", ...issue }),
                          { status: 200 });
    }
    return new Response("{}", { status: 201 });
  };
  return seen;
}

const CODE = /^[2-9A-HJ-NP-Z]{4}(-[2-9A-HJ-NP-Z]{4}){3}$/;

test("a report reaches the private repository and comes back with a code", async () => {
  const seen = captureGitHub();
  const env = makeEnv();
  const response = await worker.fetch(
    post("/v1/report", { text: "The strap stops sharing after a reconnect", key: KEY, lang: "de" }), env);
  assert.equal(response.status, 200);
  const { code } = await response.json();
  assert.match(code, CODE, "the code is what the reporter types back later");

  const sent = JSON.parse(seen[0].init.body);
  assert.deepEqual(sent.labels, ["bug", "from-app"], "never the suggestion labels");
  assert.match(sent.body, new RegExp(`Code: ${code}`), "the owner can find the thread from the issue");
  assert.equal(env.DB.reports.get(code).number, 7);
});

test("a report sent without a thread leaves nothing behind", async () => {
  const seen = captureGitHub();
  const env = makeEnv();
  const response = await worker.fetch(
    post("/v1/report", { text: "No way back wanted", key: KEY, thread: false }), env);
  assert.deepEqual(await response.json(), { ok: true }, "no code is handed out");
  assert.equal(env.DB.reports.size, 0, "and nothing is stored that could tie this to a device");
  assert.match(JSON.parse(seen[0].init.body).body, /without a thread/);
});

test("the thread shows both voices apart, and a wrong code says nothing", async () => {
  const env = makeEnv();
  captureGitHub();
  const { code } = await (await worker.fetch(
    post("/v1/report", { text: "Live heart rate stops", key: KEY }), env)).json();

  captureGitHub({
    issue: { state: "open", labels: [{ name: "bug" }, { name: "in-progress" }], body: "Public: #123" },
    comments: [{ body: "Which firmware is on the strap?", created_at: "2026-11-15T10:00:00Z" },
               { body: "<!--app-->\n17.1.3", created_at: "2026-11-15T11:00:00Z" }],
  });
  const thread = await worker.fetch(new Request(`https://relay.test/v1/report?code=${code}`), env);
  const body = await thread.json();
  assert.equal(body.status, "working");
  assert.equal(body.publicNumber, 123);
  assert.deepEqual(body.messages.map((m) => m.mine), [false, true]);
  assert.equal(body.messages[1].text, "17.1.3", "the marker never reaches the reader");

  const wrong = await worker.fetch(new Request("https://relay.test/v1/report?code=AAAA-BBBB-CCCC-DDDD"), env);
  assert.equal(wrong.status, 410, "a wrong code answers exactly like a withdrawn one");
});

test("the service's own notes never reach the thread as the owner's voice", async () => {
  const env = makeEnv();
  captureGitHub();
  const { code } = await (await worker.fetch(
    post("/v1/report", { text: "Live heart rate stops", key: KEY }), env)).json();

  captureGitHub({
    comments: [{ body: "<!--relay-->\nLog attached: `reports/x/y.zip` (2108421 bytes).",
                 created_at: "2026-11-15T22:53:00Z" },
               { body: "Which firmware is on the strap?", created_at: "2026-11-15T23:00:00Z" }],
  });
  const body = await (await worker.fetch(
    new Request(`https://relay.test/v1/report?code=${code}`), env)).json();
  assert.equal(body.messages.length, 1, "the note about the log is not a message");
  assert.equal(body.messages[0].text, "Which firmware is on the strap?");
  assert.ok(!JSON.stringify(body).includes("reports/x/y.zip"),
            "and the bucket path never reaches the reporter");
});

test("the status is read from the issue, never invented", async () => {
  const env = makeEnv();
  captureGitHub();
  const { code } = await (await worker.fetch(
    post("/v1/report", { text: "Something", key: KEY }), env)).json();
  const ask = async () => (await (await worker.fetch(
    new Request(`https://relay.test/v1/report?code=${code}`), env)).json());

  captureGitHub({ issue: { labels: [{ name: "bug" }, { name: "from-app" }] } });
  assert.equal((await ask()).status, "arrived", "nobody has touched it yet");

  captureGitHub({ issue: { labels: [{ name: "bug" }, { name: "needs-you" }] } });
  assert.equal((await ask()).status, "read");

  captureGitHub({ issue: { state: "closed", labels: [{ name: "fixed-in:13.1.0" }] } });
  const fixed = await ask();
  assert.equal(fixed.status, "fixed");
  assert.equal(fixed.fixedIn, "13.1.0");

  captureGitHub({ issue: { state: "closed", state_reason: "not_planned", labels: [] } });
  assert.equal((await ask()).status, "notPlanned");
});

test("a reply is marked as the reporter's", async () => {
  const env = makeEnv();
  captureGitHub();
  const { code } = await (await worker.fetch(
    post("/v1/report", { text: "Something", key: KEY }), env)).json();
  const seen = captureGitHub();
  const response = await worker.fetch(post("/v1/report/reply", { code, text: "Tried it, same thing", key: KEY }), env);
  assert.equal(response.status, 200);
  assert.match(JSON.parse(seen[0].init.body).body, /^<!--app-->\n/);
});

test("a log rides the same two steps, on its own counter", async () => {
  const env = makeEnv();
  captureGitHub();
  const { code } = await (await worker.fetch(
    post("/v1/report", { text: "Something", key: KEY }), env)).json();

  captureGitHub();
  const { url } = await (await worker.fetch(
    post("/v1/report-log-url", { code, bytes: 2000 }), env)).json();
  const put = await worker.fetch(new Request(url, { method: "PUT", body: "x".repeat(2000) }), env);
  assert.equal(put.status, 200);
  assert.match(env.RAW.puts[0].key, new RegExp(`^reports/${code}/[0-9a-f]{32}\\.zip$`));
  assert.equal(env.DB.logBudget.bytes, 2000);
  assert.equal(env.DB.budget.bytes, 0, "the donation allowance is untouched by a bug report");
});

test("withdrawing takes the log and the thread with it", async () => {
  const env = makeEnv();
  captureGitHub();
  const { code } = await (await worker.fetch(
    post("/v1/report", { text: "Something", key: KEY }), env)).json();
  captureGitHub();
  const { url } = await (await worker.fetch(
    post("/v1/report-log-url", { code, bytes: 50 }), env)).json();
  await worker.fetch(new Request(url, { method: "PUT", body: "x".repeat(50) }), env);
  assert.equal(env.RAW.puts.length, 1);

  captureGitHub();
  const gone = await worker.fetch(post("/v1/report/withdraw", { code }), env);
  assert.equal(gone.status, 200);
  assert.equal(env.RAW.puts.length, 0, "the log is deleted, not just unlinked");
  assert.equal(env.DB.reports.size, 0);

  const after = await worker.fetch(new Request(`https://relay.test/v1/report?code=${code}`), env);
  assert.equal(after.status, 410, "the code stops working");
});

test("anything else is gone, so an app that meets a retired service stops asking", async () => {
  const env = makeEnv();
  const response = await worker.fetch(new Request("https://relay.test/v1/whatever"), env);
  assert.equal(response.status, 410);
});
