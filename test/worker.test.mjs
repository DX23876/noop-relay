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
  const budget = { bytes: 0 };  // bytes ever written, the cost cap's counter
  return {
    votes, calls, donations, budget,
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
    RAW: { puts, async put(key, body, opts) { puts.push({ key, body, opts }); } },
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

test("anything else is gone, so an app that meets a retired service stops asking", async () => {
  const env = makeEnv();
  const response = await worker.fetch(new Request("https://relay.test/v1/whatever"), env);
  assert.equal(response.status, 410);
});
