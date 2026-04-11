---
description: 'Use when navigating, modifying, or understanding the Cincinnati feed generator codebase. Covers file map, database schema, post filtering pipeline, ML thresholds, config, and AT Protocol patterns. Load when asked about architecture, where to find something, how feeds work, or when editing any src/ or go/ file.'
applyTo: 'src/**, go/**, scripts/**'
---

# Cincinnati Feed Generator — Codebase Reference

## What This Project Does

An AT Protocol feed generator for Bluesky that subscribes to the Jetstream event stream, filters posts for Cincinnati relevance using keyword matching + ML zero-shot classification, stores them in SQLite, and serves them via `app.bsky.feed.getFeedSkeleton`.

There are **two implementations**: TypeScript (`src/`) is the main one; Go (`go/`) is an alternative.

---

## File Map

### TypeScript Entry & Server

| File                | Role                                                                  |
| ------------------- | --------------------------------------------------------------------- |
| `src/index.ts`      | Entry point — loads env, creates server, starts HTTP                  |
| `src/server.ts`     | Express server setup, registers XRPC handlers, wires up db + firehose |
| `src/auth.ts`       | JWT Bearer token validation against user repo DID                     |
| `src/config.ts`     | `AppContext` and `Config` TypeScript types                            |
| `src/well-known.ts` | Serves `/.well-known/did.json`                                        |

### Core Logic

| File                     | Role                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| `src/subscription.ts`    | **Start here for firehose logic** — consumes Jetstream events, runs full filtering pipeline |
| `src/algos/CincyFeed.ts` | **Start here for feed query logic** — DB query, reverse-chron order, cursor pagination      |
| `src/algos/index.ts`     | Algorithm registry mapping short names → handler functions                                  |

### Features / Filters

| File                                      | Role                                                                                                     |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `src/features/mlClassifier.ts`            | Hugging Face zero-shot classifier (`Xenova/nli-deberta-v3-small`) — scores Cincinnati relevance and NSFW |
| `src/features/isNSFW.ts`                  | Checks self-applied Bluesky labels: `porn`, `nsfw`, `sexual`, `adult`, `graphic-media`                   |
| `src/features/users.ts`                   | Discovers Cincinnati users by profile bio scoring + social graph traversal                               |
| `src/features/cleanNonCincinnatiPosts.ts` | DB cleanup — removes posts from non-Cincinnati or blocked users                                          |
| `src/features/validatePostData.ts`        | Input validation/sanitization for post records                                                           |

### Database

| File                   | Role                                                               |
| ---------------------- | ------------------------------------------------------------------ |
| `src/db/index.ts`      | Creates Kysely client using `better-sqlite3` (`SqliteDialect`)     |
| `src/db/schema.ts`     | Table TypeScript types: `post`, `actor`, `sub_state`               |
| `src/db/migrations.ts` | Kysely migrations — 001 initial, 002 add `text`, 003 add `blocked` |

### XRPC Methods

| File                                | Role                                                       |
| ----------------------------------- | ---------------------------------------------------------- |
| `src/methods/feed-generation.ts`    | Handles `app.bsky.feed.getFeedSkeleton` RPC requests       |
| `src/methods/describe-generator.ts` | Handles `app.bsky.feed.describeFeedGenerator` RPC requests |

### Scripts

| File                          | Role                                                   |
| ----------------------------- | ------------------------------------------------------ |
| `scripts/publishFeedGen.ts`   | Publish/update the feed record on Bluesky              |
| `scripts/unpublishFeedGen.ts` | Remove a published feed record                         |
| `scripts/backfillPosts.ts`    | Backfill historical posts from known Cincinnati actors |
| `scripts/setup-models.ts`     | Pre-download ML models (~150 MB) to `./models/`        |

### Go Implementation (`go/`)

Mirrors the TypeScript logic. `go/main.go` → `go/server.go` + `go/subscription.go` + `go/db.go` + `go/algos.go` + `go/config.go`. Algorithm is named `whatsAlf`.

---

## Database Schema

**`post`** — stored feed posts

- `uri` (PK, text) — AT URI of the post
- `cid` (text) — commit CID
- `author` (text) — DID of the author
- `indexedAt` (text) — ISO 8601 timestamp
- `text` (text) — post body
- `mlScore` (real) — Cincinnati relevance score from ML classifier

**`actor`** — known Cincinnati users

- `did` (PK, text)
- `name` (text)
- `description` (text) — bio used for classification
- `blocked` (integer, 0/1)

**`sub_state`** — Jetstream cursor resumption

- `service` (PK, text) — WebSocket endpoint URL
- `cursor` (integer) — last processed event timestamp

---

## Post Filtering Pipeline (`src/subscription.ts`)

Each incoming Jetstream event (commit op) passes these gates in order:

1. **Keyword pre-filter** — skip if post text has no Cincinnati keyword AND author is not in `actor` table (cheap, no I/O needed)
2. **Block check** — skip authors in `blocked-users.txt`
3. **Label NSFW check** — skip posts with self-applied explicit labels (`src/features/isNSFW.ts`)
4. **ML NSFW check** — skip if `nsfwScore >= NSFW_THRESHOLD` (default 0.8)
5. **ML Cincinnati check** — for unknown authors, skip if `mlScore < CINCINNATI_THRESHOLD` (default 0.5)
6. **Insert** — write to `post` table with mlScore

---

## ML Configuration

**Model**: `Xenova/nli-deberta-v3-small` (ONNX, zero-shot classification, ~150 MB)
**Labels**: Defined in `labels.json` — 11 weighted labels covering Cincinnati neighborhoods, sports teams, landmarks, universities, and culture.

**Thresholds** (env var → default):
| Variable | Default | Used For |
|----------|---------|---------|
| `CINCINNATI_THRESHOLD` | `0.5` | Minimum score for unknown-author posts |
| `NSFW_THRESHOLD` | `0.8` | Maximum NSFW score before rejection |
| `PROFILE_CINCINNATI_THRESHOLD` | `0.6` | Minimum score for user bio discovery |

---

## Key Environment Variables

| Variable                        | Default              | Purpose                                     |
| ------------------------------- | -------------------- | ------------------------------------------- |
| `FEEDGEN_PORT`                  | `3000`               | HTTP listen port                            |
| `FEEDGEN_HOSTNAME`              | —                    | Public hostname (used in DID doc)           |
| `FEEDGEN_PUBLISHER_DID`         | —                    | Bluesky account DID of feed owner           |
| `FEEDGEN_SERVICE_DID`           | `did:web:{hostname}` | Feed generator DID                          |
| `FEEDGEN_SUBSCRIPTION_ENDPOINT` | Jetstream WSS URL    | Firehose source                             |
| `FEEDGEN_SQLITE_LOCATION`       | `:memory:`           | SQLite path; use `./data/db.sqlite` in prod |
| `HF_HOME`                       | `./models`           | Hugging Face model cache dir                |
| `SEARCH_LOOP_ATTEMPTS`          | `0`                  | Set >0 to enable user discovery crawler     |

---

## Key Patterns

- **Database queries**: Always use `src/db/index.ts` Kysely instance — never raw SQL strings
- **XRPC handlers**: Registered in `src/server.ts` via `@atproto/xrpc-server`; lexicon schemas live in `src/lexicon/`
- **Auth**: Calls to `getFeedSkeleton` may be authenticated; use `src/auth.ts` for validation
- **Pagination**: Feed cursors are `indexedAt::uri` strings; split on `::` to parse
- **AT URIs**: Format is `at://did:plc:.../app.bsky.feed.post/...`
- **Blocked users**: Flat file `blocked-users.txt`, one DID per line, loaded at startup

---

## Data Flow Summary

```
Jetstream WSS → subscription.ts (filter pipeline) → db post table
                                                          ↓
HTTP GET getFeedSkeleton → CincyFeed.ts → query post table → return URIs
```
