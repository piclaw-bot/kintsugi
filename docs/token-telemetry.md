# Graphite token telemetry

Available on `main`; not included in v0.3.4. Token telemetry exports recorded agent consumption to Graphite. It is separate from provider subscription quotas and is disabled by default.

## Configuration

Open **Settings → Token telemetry** and set:

| Setting | Default | Meaning |
| --- | --- | --- |
| Export token usage | Off | Enable collection and delivery of new usage |
| Graphite host | Empty | Carbon receiver hostname or IP, without a URL scheme |
| Carbon TCP port | `2003` | Plaintext TCP receiver port |
| Instance name | Generated `kintsugi-…` ID | Stable, unique label for this installation |
| Export interval | 15 minutes | Aggregate interval, configurable from 1 to 60 minutes |

Carbon plaintext has no encryption or authentication. Use a trusted network or an independently managed secure tunnel. The destination is an app-level administrative setting; saving it does not grant workspace LAN access or change network policy.

**Test connection** opens TCP without writing a metric or saving the form. Success proves connectivity, not Graphite ingestion. **Refresh status** reads current queue/delivery status without contacting Graphite.

Collection checks local accounting every 30 seconds while enabled. Initial enablement establishes baselines rather than backfilling history. Re-enabling excludes usage produced while disabled; already pending exports remain queued. Idle periods do not generate artificial zero samples.

## Metric schema

Paths follow [PiClaw's observability schema](https://github.com/rcarmo/piclaw-addons/tree/main/addons/observability), with the root changed to:

```text
kintsugi.<instance>.usage.<provider>.<model>
```

Instance/provider/model segments are lower-case; punctuation outside letters, digits, underscores and hyphens becomes an underscore. Segments are bounded to 128 characters; instance settings are limited to 80 characters. Avoid names that collide after normalisation.

| Suffix | Value |
| --- | --- |
| `tokens.input` | Uncached input tokens |
| `tokens.output` | Output tokens, including reasoning when the provider includes it |
| `tokens.cache_read` | Input tokens served from cache |
| `tokens.cache_write` | Input tokens written to cache |
| `tokens.reasoning` | Reported reasoning subset; do not add it to output again |
| `tokens.total` | Reported/normalised total; reasoning is not counted twice |
| `tokens.prompt` | Input + cache read + cache write, only with complete cache coverage |
| `cache.hit_percent` | `100 × cache_read / prompt` |
| `cache.write_percent` | `100 × cache_write / prompt` |
| `cost.estimated_usd` | Available recorded/catalogue API-equivalent cost estimate |

Token counts and costs are **interval sums**, timestamped at batch creation. Percentages are calculated after grouping token counts, not averaged across calls. A zero-length prompt has no percentage. Missing counters/costs are omitted. If any contributing record lacks a cache component, that group's interval has no prompt total or cache percentage; reported cache counts can still be partial sums.

Cost estimates are not actual subscription charges or a provider invoice. Unknown catalogue costs are omitted; documented/reported zero costs remain zero.

Configure Graphite storage aggregation to **sum** token and cost series. Percentage series are gauges, never sums. For longer-range or cross-model cache rates, recompute from matching complete-coverage token intervals; exclude intervals without `tokens.prompt`. Averaging interval percentages can give the wrong result.

## Collection and coverage

The exporter reads accounting data; it does not estimate usage from text, intercept provider traffic or start workspace containers.

| Source | Collection and attribution |
| --- | --- |
| Built-in assistant calls | Committed native `UsageDoc` counters, by provider/model |
| Built-in compaction | Included in the native model counters |
| Built-in classifier/image calls | Model identity retained at the native tool-call boundary; separate from parent-model totals |
| Claude / Claude CLI | Native assistant response usage; response model takes precedence over session metadata |
| Codex / Codex CLI | Native session/turn identity and cumulative token events converted to deltas; cached input is separated from uncached input |
| Pi assistant calls | Native response provider/model; physical response model preferred; bounded parent-branch context recovers missing identity without borrowing a sibling's model |
| Pi standalone `usage` entries | Their recorded provider/model, including cache-warming usage when Pi records it |
| Pi tool results | Explicit usage identity, or the single model shared by all charged native code-mode model-call rows |
| Pi compaction / branch summaries | Explicit model metadata when present; otherwise the reserved buckets below |

Closed/abandoned branches still consumed tokens. Their physical records count once; inherited copies do not create a second charge. Invocation IDs, high-water marks and persisted file positions protect against ordinary replay, copying, rotation, resume and restart.

### Pi unattributed buckets

Some native Pi entries contain counts without enough information to assign them to one model. Mixed-model code-mode results combine token usage; their call rows contain model references and costs but not per-call token counts. The exporter never divides those tokens by price or assigns them to the parent chat model.

Known counts remain visible under the reserved provider `unattributed`:

| Model segment | Meaning |
| --- | --- |
| `pi_assistant` | Assistant identity could not be recovered from the recorded response/branch metadata |
| `pi_usage` | A standalone usage entry lacks provider/model identity |
| `pi_tools` | Tool usage lacks identity, including combined usage from multiple code-mode models |
| `pi_compaction` | Compaction usage lacks model attribution |
| `pi_branch_summary` | Branch-summary usage lacks model attribution |

These are coverage categories, not real providers/models. Include them when summing installation consumption; exclude them when comparing actual models. Homogeneous code-mode usage is counted once under its one model. Mixed code-mode usage is counted once in `unattributed.pi_tools`, not again for every nested call.

The metadata limitation is tracked in [earendil-works/pi#11090](https://github.com/earendil-works/pi/issues/11090). The contributor gate auto-closed it pending maintainer triage; that is not evidence of a fix. A future upstream format with per-call usage IDs will need an explicit adapter review so call records and roll-ups are not both counted.

### Limits of recorded accounting

The exporter cannot reconstruct usage that a backend never records, such as a process crash before its final usage write or a failed auxiliary request with no persisted usage entry. Missing native counters remain unavailable. Tool-side remote model calls that report no usage cannot be measured. Current coverage is not a guarantee of complete billing reconciliation.

Provider and CLI caching defaults remain unchanged. The exporter neither warms caches nor forces retention TTLs. Existing stable native sessions are resumed; genuine prompt/model changes and provider eviction can still cause cache misses.

## Delivery, storage and failures

The app stores private configuration in `<app-data>/telemetry/config.json` and accounting/checkpoints in `<app-data>/telemetry/usage.sqlite`. Back up the app data through the normal supported procedure. Prompts, responses, tool output, credentials and workspace names are not exported. Local cursor state contains file paths and opaque deduplication IDs; it must remain private.

Pending Carbon batches retain their original timestamps and are limited to **seven days or 10 MiB**. Dropped/expired batches are reported in Settings. A connection failure leaves the batch queued. A crash after TCP delivery but before the local delivery checkpoint can replay the same points: Carbon does not provide a storage acknowledgement or exactly-once guarantee.

Pending aggregates/batches belong to their saved destination and instance name. Deliver them or explicitly **Discard pending exports** before changing either. Discard does not delete native agent histories or provider credentials.

Native reads are bounded: at most 10,000 history files / 50,000 discovery entries, directory depth 12, 2 MiB per JSONL row and a 16 MiB read budget per collection pass. Oversized rows and malformed JSON are reported. Usage without the mandatory numeric counters cannot be exported; absent/invalid native data is not complete accounting. The latest 128 Pi entry contexts are retained for branch identity recovery. Missing ancestors do not justify guessing a model. The batcher limits pending provider/model series to 256 and combines at most 128 queued batches / 4 MiB per TCP send, with a five-second connection deadline.

The seven-day/10-MiB policy bounds retry batches, not the entire deduplication database. Monitor app-data disk use. Collection errors do not authorise agent restarts, installation updates or changes to workspace resource/network settings.

## JSON management API

The normal app access/Origin boundary applies. Authenticated admin bindings require **`security` scope** for every telemetry operation; the HTML Settings frame is not exposed there.

```http
GET /settings/telemetry
POST /settings/telemetry
POST /settings/telemetry/test
POST /settings/telemetry/discard
```

Save/test input:

```json
{
  "enabled": true,
  "host": "graphite.example.net",
  "port": 2003,
  "instance": "my-kintsugi",
  "intervalMinutes": 15
}
```

Discard input is `{ "confirmed": true }`. Read/save/test responses contain `config`, the metric `prefix`, pending-series and queue counts/bytes, last TCP delivery/error, dropped-batch count and malformed/oversized row counts. `GET /openapi.json` describes the running instance's schemas and admin scopes.

## Acceptance

Before enabling a real destination, choose an instance name that does not collide with PiClaw or another Kintsugi installation. Confirm token/cost sum aggregation and percentage handling in Graphite.

Run a few real turns per backend, including a cached follow-up, native resume, subagent and relevant Pi auxiliary work. Compare native counts and exported series. Briefly stop the receiver to check pending delivery and restart recovery. Test fixtures and CI verify adapters and Carbon transport; they do not establish acceptance on an untested Graphite deployment.
