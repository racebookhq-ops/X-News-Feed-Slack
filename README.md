# X → Slack relay

Polls X recent-search for a list of handles and posts anything new into a Slack channel. Runs on GitHub Actions; no third-party automation platform involved.

## Setup

### 1. X bearer token

X Developer Portal → new Project + App → Keys and tokens → generate a **Bearer Token**. Read-only is fine. Confirm the project has billing set up and set a monthly spend cap.

### 2. Slack incoming webhook

Slack → your workspace apps → **Incoming Webhooks** → add a webhook pointed at the target channel (e.g. `#x-alerts`). Copy the URL.

### 3. GitHub PAT (for state)

The script stores the last-relayed tweet ID as a repository variable, which the default `GITHUB_TOKEN` isn't allowed to write. Create a **fine-grained personal access token** scoped to this repo with:

- Repository permissions → **Variables: Read and write**

### 4. Repo secrets

Settings → Secrets and variables → Actions → Secrets:

| Secret | Value |
|---|---|
| `X_BEARER_TOKEN` | from step 1 |
| `SLACK_WEBHOOK_URL` | from step 2 |
| `GH_PAT` | from step 3 |

Leave the `LAST_SEEN_ID` **variable** alone — the script creates it on first successful run.

### 5. Handles

Edit `handles.txt`, one handle per line. Commit.

### 6. Test

Actions tab → **X to Slack** → Run workflow. The first run only looks back 20 minutes, so it won't flood the channel with history.

## How it works

1. Reads `handles.txt` and builds `(from:a OR from:b ...) -is:reply -is:retweet`, splitting into multiple queries if the handle list would exceed X's query length cap.
2. Calls recent-search with `since_id` set to the last relayed tweet ID.
3. De-duplicates, sorts oldest → newest, posts each to Slack.
4. **Only then** advances `LAST_SEEN_ID`.

That ordering matters: if Slack or the network fails partway, state isn't advanced, so the next run retries. You may occasionally see a repeat post, but you'll never silently lose one.

## Tuning

| What | Where |
|---|---|
| Check frequency | `cron` in `.github/workflows/x-to-slack.yml` |
| Include replies / retweets | remove filters from `FILTERS` in the script |
| Message format | the `postToSlack(...)` call in `main()` |
| Flood cap per run | `MAX_SLACK_MESSAGES` |

## Gotchas

- **Actions minutes.** Private repos bill each job rounded up to a full minute. At 15-minute intervals that's ~2,880 minutes/month, over the 2,000 free allowance. Either make the repo public (unlimited minutes; secrets stay secret either way) or drop to a 30-minute cadence.
- **Scheduled workflows get disabled** after 60 days without repository activity. A dummy commit occasionally, or a calendar reminder, avoids the surprise.
- **Cron is best-effort.** GitHub can delay scheduled runs by 10+ minutes under load. Because dedupe is ID-based rather than time-based, delays just mean a later batch — never a gap.
- **Access tier.** Confirm recent-search is included on your X access tier before relying on this; it hasn't historically been available at every level.
