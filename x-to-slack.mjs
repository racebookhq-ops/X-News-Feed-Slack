#!/usr/bin/env node
/**
 * Polls X recent-search for a list of handles and relays new posts to Slack.
 *
 * State: the newest tweet ID already relayed is stored as a GitHub Actions
 * repository variable called LAST_SEEN_ID. It is only advanced AFTER Slack has
 * accepted the messages, so a failure mid-run means the next run retries rather
 * than silently dropping posts.
 */

import { readFileSync } from "node:fs";

const { X_BEARER_TOKEN, SLACK_WEBHOOK_URL, GH_PAT, GITHUB_REPOSITORY } = process.env;
const LAST_SEEN_ID = (process.env.LAST_SEEN_ID || "").trim();

// --- tuning -----------------------------------------------------------------
const FILTERS = " -is:reply -is:retweet"; // drop these two if you want replies/RTs
const MAX_QUERY_CHARS = 480;              // X caps query length; we chunk to stay under
const MAX_SLACK_MESSAGES = 25;            // flood guard per run
const FIRST_RUN_LOOKBACK_MINUTES = 20;    // don't dump history on the very first run
// ----------------------------------------------------------------------------

for (const [key, value] of Object.entries({
  X_BEARER_TOKEN,
  SLACK_WEBHOOK_URL,
  GH_PAT,
  GITHUB_REPOSITORY,
})) {
  if (!value) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

const handles = readFileSync(new URL("../handles.txt", import.meta.url), "utf8")
  .split("\n")
  .map((line) => line.trim().replace(/^@/, ""))
  .filter((line) => line && !line.startsWith("#"));

if (handles.length === 0) {
  console.error("handles.txt is empty — nothing to track.");
  process.exit(1);
}

/** Split handles into groups whose assembled query fits under the char cap. */
function chunkHandles(list) {
  const chunks = [];
  let current = [];
  for (const handle of list) {
    const candidate = [...current, handle];
    if (buildQuery(candidate).length > MAX_QUERY_CHARS && current.length > 0) {
      chunks.push(current);
      current = [handle];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function buildQuery(group) {
  return `(${group.map((h) => `from:${h}`).join(" OR ")})${FILTERS}`;
}

async function searchChunk(group) {
  const params = new URLSearchParams({
    query: buildQuery(group),
    "tweet.fields": "created_at,author_id",
    expansions: "author_id",
    "user.fields": "username",
    max_results: "100",
  });

  if (LAST_SEEN_ID) {
    params.set("since_id", LAST_SEEN_ID);
  } else {
    params.set(
      "start_time",
      new Date(Date.now() - FIRST_RUN_LOOKBACK_MINUTES * 60_000).toISOString(),
    );
  }

  const res = await fetch(`https://api.x.com/2/tweets/search/recent?${params}`, {
    headers: { Authorization: `Bearer ${X_BEARER_TOKEN}` },
  });

  if (res.status === 429) {
    throw new Error("X rate limit hit — state left unchanged, next run will retry.");
  }
  if (!res.ok) {
    throw new Error(`X API ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const usernames = Object.fromEntries(
    (data.includes?.users || []).map((u) => [u.id, u.username]),
  );

  return (data.data || []).map((t) => {
    const username = usernames[t.author_id] || t.author_id;
    return {
      id: t.id,
      username,
      text: t.text,
      created_at: t.created_at,
      url: `https://x.com/${username}/status/${t.id}`,
    };
  });
}

async function postToSlack(text) {
  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, unfurl_links: false }),
  });
  if (!res.ok) {
    throw new Error(`Slack webhook ${res.status}: ${await res.text()}`);
  }
}

async function setLastSeenId(id) {
  const [owner, repo] = GITHUB_REPOSITORY.split("/");
  const base = `https://api.github.com/repos/${owner}/${repo}/actions/variables`;
  const headers = {
    Authorization: `Bearer ${GH_PAT}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
  const payload = JSON.stringify({ name: "LAST_SEEN_ID", value: id });

  let res = await fetch(`${base}/LAST_SEEN_ID`, { method: "PATCH", headers, body: payload });
  if (res.status === 404) {
    res = await fetch(base, { method: "POST", headers, body: payload });
  }
  if (!res.ok) {
    throw new Error(`GitHub variable update ${res.status}: ${await res.text()}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const groups = chunkHandles(handles);
  console.log(`Tracking ${handles.length} handles across ${groups.length} query chunk(s).`);
  console.log(LAST_SEEN_ID ? `since_id=${LAST_SEEN_ID}` : "First run — using time window.");

  const collected = [];
  for (const group of groups) {
    collected.push(...(await searchChunk(group)));
  }

  // De-duplicate, then sort oldest → newest so Slack reads chronologically.
  const seen = new Set();
  const tweets = collected
    .filter((t) => (seen.has(t.id) ? false : seen.add(t.id)))
    .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));

  if (tweets.length === 0) {
    console.log("No new posts.");
    return;
  }

  const batch = tweets.slice(0, MAX_SLACK_MESSAGES);
  const skipped = tweets.length - batch.length;
  console.log(`Relaying ${batch.length} post(s)${skipped ? ` (${skipped} held back)` : ""}.`);

  let lastPostedId = null;
  for (const tweet of batch) {
    await postToSlack(`*@${tweet.username}*\n${tweet.text}\n${tweet.url}`);
    lastPostedId = tweet.id;
    await sleep(1100); // Slack webhooks allow roughly 1 message/second
  }

  if (skipped > 0) {
    await postToSlack(
      `_${skipped} further post(s) held back by the per-run cap — they'll follow on the next run._`,
    );
  }

  if (lastPostedId) {
    await setLastSeenId(lastPostedId);
    console.log(`LAST_SEEN_ID advanced to ${lastPostedId}.`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
