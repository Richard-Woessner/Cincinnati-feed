# Cincinnati Feed Generator

A [Bluesky](https://bsky.app) / AT Protocol feed generator that surfaces posts relevant to Cincinnati, Ohio. It subscribes to the Bluesky Jetstream firehose, filters posts using keyword matching and ML-based zero-shot classification, stores them in SQLite, and serves them via the `app.bsky.feed.getFeedSkeleton` XRPC endpoint.

## Features

- **Keyword pre-filtering** — fast, low-cost check for Cincinnati-related terms before any I/O or ML inference
- **ML relevance scoring** — uses [`Xenova/nli-deberta-v3-small`](https://huggingface.co/Xenova/nli-deberta-v3-small) (ONNX zero-shot classification) to score each post against 11 weighted Cincinnati labels covering neighborhoods, sports teams, landmarks, universities, and local culture
- **ML NSFW filtering** — the same zero-shot model detects explicit content and rejects posts above a configurable threshold
- **Label-based NSFW check** — also rejects posts with self-applied Bluesky explicit content labels (`porn`, `nsfw`, `sexual`, `adult`, `graphic-media`)
- **Cincinnati user discovery** — crawls follower/following graphs and scores user bios to build a list of known Cincinnati accounts; known-author posts skip the ML relevance threshold
- **Blocked user support** — a plain-text `blocked-users.txt` (one DID per line) is loaded at startup; matching authors are dropped from the feed
- **Live label reloading** — `labels.json` is watched at runtime; changes take effect within 5 seconds without restarting
- **Cursor-based pagination** — feed responses support `indexedAt::uri` cursors for efficient forward pagination
- **Docker support** — includes a `DockerFile` and `docker-compose.yml` for containerized deployment
- **Go implementation** — a parallel Go implementation under `go/` mirrors the TypeScript logic for environments where a compiled binary is preferred

## Post Filtering Pipeline

Each incoming event passes these gates in order:

1. **Keyword pre-filter** — skip if the post has no Cincinnati keyword and the author is not a known Cincinnati user
2. **Block check** — skip authors listed in `blocked-users.txt`
3. **Label NSFW check** — skip posts with explicit self-applied Bluesky labels
4. **ML NSFW check** — skip if `nsfwScore >= NSFW_THRESHOLD` (default `0.8`)
5. **ML Cincinnati check** — for unknown authors, skip if `mlScore < CINCINNATI_THRESHOLD` (default `0.5`)
6. **Insert** — write to the `post` table with the ML score

## Project Structure

```
src/
  subscription.ts       # Jetstream consumer + full filter pipeline
  algos/CincyFeed.ts    # Feed query logic — reverse-chron, cursor pagination
  features/
    mlClassifier.ts     # Zero-shot ML classifier (relevance + NSFW)
    isNSFW.ts           # Self-applied label check
    users.ts            # Cincinnati user discovery via bio scoring + graph traversal
    cleanNonCincinnatiPosts.ts  # DB cleanup for non-Cincinnati / blocked posts
    validatePostData.ts # Post record input validation
  db/                   # Kysely + better-sqlite3 database layer
  methods/              # XRPC handler implementations
scripts/
  publishFeedGen.ts     # Publish / update the feed record on Bluesky
  unpublishFeedGen.ts   # Remove a published feed record
  backfillPosts.ts      # Backfill historical posts from known Cincinnati actors
  setup-models.ts       # Pre-download ML models (~150 MB) to ./models/
go/                     # Alternate Go implementation
```

## Configuration

Key environment variables:

| Variable                       | Default    | Purpose                                      |
| ------------------------------ | ---------- | -------------------------------------------- |
| `FEEDGEN_PORT`                 | `3000`     | HTTP listen port                             |
| `FEEDGEN_HOSTNAME`             | —          | Public hostname (used in DID doc)            |
| `FEEDGEN_PUBLISHER_DID`        | —          | Bluesky account DID of the feed owner        |
| `FEEDGEN_SQLITE_LOCATION`      | `:memory:` | SQLite path — use `./data/db.sqlite` in prod |
| `CINCINNATI_THRESHOLD`         | `0.5`      | Min ML score for unknown-author posts        |
| `NSFW_THRESHOLD`               | `0.8`      | Max NSFW score before rejection              |
| `PROFILE_CINCINNATI_THRESHOLD` | `0.6`      | Min ML score for user bio discovery          |
| `SEARCH_LOOP_ATTEMPTS`         | `0`        | Set >0 to enable the user discovery crawler  |
| `HF_HOME`                      | `./models` | Hugging Face model cache directory           |

## Running the Server

```bash
# Install dependencies
yarn

# Pre-download ML models (recommended before first run)
yarn ts-node scripts/setup-models.ts

# Start the server
yarn start
```

The server starts on port `3000` (or `FEEDGEN_PORT`). The feed skeleton endpoint is available at:

```
http://localhost:3000/xrpc/app.bsky.feed.getFeedSkeleton?feed=at://<your-did>/app.bsky.feed.generator/cincinnati
```

**Docker:**

```bash
docker build -t cincinnati-feed . && docker run --env-file .env cincinnati-feed
# or
docker-compose up
```

## Publishing the Feed

Fill in the variables at the top of `scripts/publishFeedGen.ts`, then run:

```bash
yarn publishFeed
```

Re-run the same command to update display metadata (name, avatar, description). To remove the feed record from Bluesky, run `yarn unpublishFeed`.

## Deployment

The service must be publicly accessible over HTTPS on port 443 at the hostname set in `FEEDGEN_HOSTNAME`. Use `./data/db.sqlite` as the SQLite path in production and mount it as a persistent volume when using Docker.

### Authentication

If you are creating a generic feed that does not differ for different users, you do not need to check auth. But if a user's state (such as follows or likes) is taken into account, we _strongly_ encourage you to validate their auth token.

Users are authenticated with a simple JWT signed by the user's repo signing key.

This JWT header/payload takes the format:

```ts
const header = {
  type: 'JWT',
  alg: 'ES256K', // (key algorithm) - in this case secp256k1
}
const payload = {
  iss: 'did:example:alice', // (issuer) the requesting user's DID
  aud: 'did:example:feedGenerator', // (audience) the DID of the Feed Generator
  exp: 1683643619, // (expiration) unix timestamp in seconds
}
```

We provide utilities for verifying user JWTs in the `@atproto/xrpc-server` package, and you can see them in action in `src/auth.ts`.

### Pagination

You'll notice that the `getFeedSkeleton` method returns a `cursor` in its response and takes a `cursor` param as input.

This cursor is treated as an opaque value and fully at the Feed Generator's discretion. It is simply passed through the PDS directly to and from the client.

We strongly encourage that the cursor be _unique per feed item_ to prevent unexpected behavior in pagination.

We recommend, for instance, a compound cursor with a timestamp + a CID:
`1683654690921::bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u`

## Suggestions for Implementation

How a feed generator fulfills the `getFeedSkeleton` request is completely at their discretion. At the simplest end, a Feed Generator could supply a "feed" that only contains some hardcoded posts.

For most use cases, we recommend subscribing to the firehose at `com.atproto.sync.subscribeRepos`. This websocket will send you every record that is published on the network. Since Feed Generators do not need to provide hydrated posts, you can index as much or as little of the firehose as necessary.

Depending on your algorithm, you likely do not need to keep posts around for long. Unless your algorithm is intended to provide "posts you missed" or something similar, you can likely garbage collect any data that is older than 48 hours.

Some examples:

### Reimplementing What's Hot

To reimplement "What's Hot", you may subscribe to the firehose and filter for all posts and likes (ignoring profiles/reposts/follows/etc.). You would keep a running tally of likes per post and when a PDS requests a feed, you would send the most recent posts that pass some threshold of likes.

### A Community Feed

You might create a feed for a given community by compiling a list of DIDs within that community and filtering the firehose for all posts from users within that list.

### A Topical Feed

To implement a topical feed, you might filter the algorithm for posts and pass the post text through some filtering mechanism (an LLM, a keyword matcher, etc.) that filters for the topic of your choice.

## Community Feed Generator Templates

- [Python](https://github.com/MarshalX/bluesky-feed-generator) - [@MarshalX](https://github.com/MarshalX)
- [Ruby](https://github.com/mackuba/bluesky-feeds-rb) - [@mackuba](https://github.com/mackuba)
