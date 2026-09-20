# Verification harness

Two harnesses live here. `overflow-probe/` proves a DSH-side contract with a
scripted provider; `history-cap/` replays a real recorded request against the
real service. Neither is a unit test — both reach something `tests/` cannot.

`overflow-probe/` is a DSH plugin used to prove one contract that unit tests
cannot reach and live traffic cannot force cheaply: that a
`CONTEXT_WINDOW_EXCEEDED` failure from this adapter makes DSH compact the
conversation and retry the turn.

It registers a `kiro-probe` provider whose scripted responses are:

1. one tool call, so the turn produces durable history,
2. then a throw whose code comes from this package's own `httpErrorCode()`
   applied to a real recorded Kiro HTTP 400 body,
3. a short summary for the compaction summarizer,
4. the final answer on the retried request.

Everything else — agent loop, token meter, `dsh-compaction-basic`, retry — is the
genuine installed code, and no provider credits are spent.

## Run it

```sh
# 1. build the artifact under test
npm run check && npm run pack:dist

# 2. create a throwaway profile that loads it next to this probe
mkdir -p "$DSH_HOME/profiles/kiro-recovery"
# package.json bundles: @deepseek-ai/dsh-base, @deepseek-ai/dsh-headless,
# dsh-kiro (file: the packed tarball), dsh-kiro-overflow-probe (file: this dir)
# cordis.patch.yml: set agent-default-model to provider kiro-probe, model probe-1
dsh plugin --profile kiro-recovery install

# 3. answer one task against an isolated DSH_HOME
DSH_HOME=/tmp/dsh-recovery KIRO_PROBE_TRACE=/tmp/probe.jsonl \
  dsh --profile kiro-recovery "Run the probe step and then report the outcome."
```

Expected: the task prints `recovered-ok`, `/tmp/probe.jsonl` records a
`CONTEXT_WINDOW_EXCEEDED` throw followed by a `purpose: "compaction"` call, and
the session transcript contains `compaction/start`, `compaction/summary`,
`compaction/end`, and `turn/end` with `completed`.

---

# history-cap

Kiro serves at most **100 user messages per request, counting
`currentMessage`**, and refuses the 101st as `Input is too long.` with
`CONTENT_LENGTH_EXCEEDS_THRESHOLD`. The name is misleading: the limit counts
messages, not size. `tests/live-history-cap.spec.ts` pins that boundary with
synthetic turns; this harness does the other half — it rebuilds the request an
actual recorded session produced and replays it, which is how a report of
"the session just dies" gets turned into a body you can A/B.

Crossing the cap gets two different responses depending on who is asking, and
this harness can build either. An ordinary turn throws `CONTEXT_WINDOW_EXCEEDED`
instead of building a request, which drives the harness's existing overflow
recovery into a real summarization. The compaction summarizer's own request is
the one caller allowed past the cap, by truncating with a tombstone — it has
to be, since it carries the same oversized span it is summarizing. An earlier
version of this fix truncated for *every* caller; that kept ordinary requests
succeeding, but permanently: Kiro's reported context-usage percentage
plateaued at whatever the truncated window happened to cost (16–24% across
several real sessions) and never reached the threshold that would trigger a
real summarization, so the same span of history was silently re-dropped on
every later turn, forever, invisibly to DSH's own bookkeeping.

Requires Node with TypeScript type stripping (22.6+), because `build-body.mjs`
imports `src/serialize.ts` directly — `serializeRequest` is not part of the
package's public exports.

## Rebuild a request from a recorded session

```sh
cd verification/history-cap

DSH_DATA=~/.dsh \
SESSION=~/.dsh/sessions/<project>/session-<id>/session.v3.jsonl.zstd \
PROFILE_ARN=arn:aws:codewhisperer:<region>:<account>:profile/<id> \
  node build-body.mjs
```

`STOP_AT` chooses the cut: `overflow` (default) stops at the first
`Input is too long` event, a number stops at that event index, `end` uses the
whole log. `DSH_DATA` is only needed for two modules that ship with DSH rather
than with this package (the session log's zstd reader and `deriveEventMessage`).

By default this builds an ordinary turn, which — for a session recorded before
the fix, over the cap by construction — now throws `CONTEXT_WINDOW_EXCEEDED`
rather than writing a body; the script reports that and exits 0, since it is
the point of the fix, not a script failure. Set `PURPOSE=compaction` to build
the summarizer's own request instead, the one caller still allowed past the
cap, which reports the shape that matters and writes `wire-body.json`:

```
history entries     : 198
user messages       : 100 (99 history + currentMessage)
orphaned toolResults: 0
```

## Replay it

```sh
KIRO_PROXY=http://127.0.0.1:7890 node replay-body.mjs   # exits 0 on HTTP 200
```

Credentials resolve through `lib/`, so refresh, the profile ARN lookup and the
proxy egress are the code DSH runs. Requests go to the profile ARN's region;
token refresh keeps using the credential's own region, which this never
touches. Recorded bodies are gitignored — they carry conversation content.

## What a regression looks like

Adding back the two oldest history entries is a 152-byte change that flips the
verdict, which is the whole point:

```
453,928 bytes / 198 entries / 100 user messages -> HTTP 200, 17.5% context
454,080 bytes / 200 entries / 101 user messages -> HTTP 400, CONTENT_LENGTH_EXCEEDS_THRESHOLD
```
