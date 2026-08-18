# X → Slack Notification Pipeline (30 followed accounts)

Architecture: **Zapier Schedule → Code step (calls X API) → Loop → Slack message**, with the "last seen post ID" persisted in Zapier's built-in Storage so you never repost the same thing twice.

Cost estimate at 30 accounts, checked every 15 minutes: well under $5/month on X's pay-per-use pricing, since you're only billed per post *read*, not per API call — and a single combined search call covers all 30 accounts at once.

---

## Step 1 — X Developer Portal

1. Go to https://developer.x.com and sign up / log in with the X account you want posting rights from (read-only is fine here).
2. Create a new **Project** and **App** inside it.
3. In the App's "Keys and tokens" tab, generate a **Bearer Token**. This is all you need for read-only endpoints — save it somewhere safe (you'll paste it into Zapier as a secret).
4. In the developer dashboard, confirm the project is on **pay-per-use** billing (this is the default for new projects since Feb 2026) and add a payment method. Optionally set a monthly spend cap so it can never run away on you.

## Step 2 — Get the 30 account handles ready

Just keep a plain list of the @handles (without the @) you want to track, e.g.:

```
handle1
handle2
handle3
...
```

You don't need to look up numeric user IDs — the endpoint we'll use (`recent search`) can query directly by handle using `from:handle`.

## Step 3 — Slack side

1. In Slack, create the dedicated channel (e.g. `#x-alerts`).
2. In Zapier, connect your Slack account if it isn't already connected (your account already shows Slack as connected).
3. No separate Slack app/webhook needed — Zapier's native Slack "Send Channel Message" action handles posting.

## Step 4 — Build the Zap

### Trigger: Schedule by Zapier
- Event: **Every 15 minutes** (or 30/60 min if you want to reduce call frequency further — cost is driven by posts read, not check frequency, so this is really about how "live" you want it).

### Step 2: Storage by Zapier — Get Value
- App: **Storage by Zapier**
- Action: **Get Value**
- Key: `x_last_seen_id`
- This retrieves the tweet ID of the newest post you've already alerted on, so we only fetch anything newer.

### Step 3: Code by Zapier — Fetch new posts
- Action: **Run Javascript**
- Input data: pass in `last_seen_id` from the previous step's output (empty string if it's the very first run).
- Paste this code:

```javascript
const BEARER_TOKEN = "YOUR_X_BEARER_TOKEN"; // store as a Zapier secret/env in production

const handles = [
  "handle1", "handle2", "handle3", "handle4", "handle5",
  "handle6", "handle7", "handle8", "handle9", "handle10",
  "handle11", "handle12", "handle13", "handle14", "handle15",
  "handle16", "handle17", "handle18", "handle19", "handle20",
  "handle21", "handle22", "handle23", "handle24", "handle25",
  "handle26", "handle27", "handle28", "handle29", "handle30"
];

// X recent-search supports combining accounts with OR, and excluding replies/retweets
const query = `(${handles.map(h => `from:${h}`).join(" OR ")}) -is:reply -is:retweet`;

const params = new URLSearchParams({
  query,
  "tweet.fields": "created_at,author_id",
  "expansions": "author_id",
  "user.fields": "username",
  "max_results": "50"
});

if (inputData.last_seen_id) {
  params.set("since_id", inputData.last_seen_id);
}

const res = await fetch(`https://api.x.com/2/tweets/search/recent?${params.toString()}`, {
  headers: { Authorization: `Bearer ${BEARER_TOKEN}` }
});

if (!res.ok) {
  throw new Error(`X API error: ${res.status} ${await res.text()}`);
}

const data = await res.json();
const tweets = data.data || [];
const users = (data.includes && data.includes.users) || [];

const userMap = {};
users.forEach(u => { userMap[u.id] = u.username; });

// Sort oldest -> newest so Slack messages post in chronological order
tweets.sort((a, b) => a.id.localeCompare(b.id));

const formatted = tweets.map(t => ({
  id: t.id,
  username: userMap[t.author_id] || t.author_id,
  text: t.text,
  url: `https://x.com/${userMap[t.author_id] || "i"}/status/${t.id}`,
  created_at: t.created_at
}));

const newest_id = tweets.length ? tweets[tweets.length - 1].id : (inputData.last_seen_id || "");

output = { newest_id, count: formatted.length, tweets_json: JSON.stringify(formatted) };
```

Output fields available to later steps: `newest_id`, `count`, `tweets_json`.

### Step 4: Storage by Zapier — Set Value
- Action: **Set Value**
- Key: `x_last_seen_id`
- Value: `{{newest_id}}` from the Code step
- (Skip/guard this if `count` is 0, so you don't overwrite with an unchanged value — Zapier's built-in Filter step can do this: only continue if `count` > 0.)

### Step 5: Filter by Zapier
- Only continue if **count > 0** — avoids empty runs cluttering things downstream.

### Step 6: Looping by Zapier
- Action: **Create Loop From Line Items**
- Values to loop over: parse `tweets_json` (Zapier's "Formatter → Utilities → Line Item to Text" or a small second Code step can turn the JSON array into loop-able line items; alternatively use the "Looping by Zapier" app directly on a JSON array input).

### Step 7: Slack — Send Channel Message (inside the loop)
- Channel: `#x-alerts`
- Message text, e.g.:
  ```
  🆕 *@{{username}}*: {{text}}
  {{url}}
  ```

---

## Notes & tuning

- **Reply/retweet filtering**: the `-is:reply -is:retweet` filters are in the query above — remove them if you want retweets/replies included too.
- **Cost control**: set a monthly spend cap in the X developer dashboard (Step 1) as a safety net.
- **Query length limit**: X's recent-search query has a character cap (roughly 512–1024 characters depending on access level). 30 handles comfortably fits; if you ever grow past ~40–50 handles, split into two parallel Code steps/queries.
- **Zapier Code step timeout**: free/starter plans cap code execution around 30 seconds — a single search call for 30 accounts finishes well within that.

Let me know once you've got the Bearer Token and I can help fill in the handle list or debug the first run.
