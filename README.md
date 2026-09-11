# canary-dvn-verify

Read-only audit of the Canary DVN deployment across every LayerZero V2 chain it's on.
No private key, no transactions — `eth_call` only.

For each source chain it checks:

| area | what it asserts |
|---|---|
| **multisig** | `quorum` matches, and the active signer set is **exactly** the expected addresses |
| **worker** | `priceFeed` and `workerFeeLib` set, `defaultMultiplierBps`, `allowlistSize`, not paused |
| **dstConfig** | for every destination: `gas` configured, `multiplierBps` and `floorMarginUSD` as expected |
| **live fee** | `getFee()` quote per pathway, converted to USD, plus a check that no USD floor is binding |

---

## Setup

```bash
npm install
```

Then open `expected.json` and **replace the signer placeholder**:

```jsonc
"signers": ["0xPASTE_SIGNER_ADDRESS_HERE"],   // <- the real Canary DVN signer(s)
"quorum": 1                                    // <- the expected quorum
```

The script refuses to run until that's a real address. That's the only required setup —
RPCs resolve automatically (see below).

## Run

```bash
npm run verify                          # everything, with live fee quotes
npm run verify -- --no-quote            # config only, much faster
npm run verify -- --chains ethereum,arbitrum,bsc
npm run verify -- --scan-signers        # name the extras when a signer count mismatches
```

Writes `report.json` and `report.md` alongside the console output. **Exit code is 1
if any check fails**, so it drops straight into CI.

Full flag list: `npm run verify -- --help`.

### When a provider throttles

`worker.read — core reads failed ... HTTP request failed` does **not** mean the contract
is wrong. `eth_chainId` and `getCode` are single calls and already succeeded by that
point; the first thing to fail is the first *multi-call*. Two causes, both transport:

- the provider **rejects or caps JSON-RPC batches** (six reads go out as one array)
- the provider is **rate-limiting** you

Both are handled by re-running just the affected chains, slowly:

```bash
npm run verify -- --rerun report.json --slow
```

`--rerun` reads the previous `report.json` and re-verifies only the chains that didn't
pass. `--slow` is a preset for `--concurrency 1 --chain-concurrency 2 --delay-ms 150
--no-batch --retries 3` with a 30s timeout. Tune individually if you want:

| flag | effect |
|---|---|
| `--no-batch` | one `eth_call` per HTTP request instead of a batched array |
| `--retries <n>` | extra attempts per call, exponential backoff + jitter (default 3) |
| `--delay-ms <n>` | pause before every call, to stay under a rate limit |
| `--rerun <file>` | re-verify only chains that were FAIL or ERROR in that report |

Retries apply to transport failures only. A revert is a deterministic answer from the
chain, so it's never retried — `getFee` reverting on an unconfigured destination fails
immediately rather than burning four attempts on a known answer.

### Seeing what passed, not just what failed

By default the console shows a one-line-per-chain summary and then only failures — the
quiet-unless-broken shape you want in CI. When you need to see the verification itself:

```bash
npm run verify -- -v      # every check that ran, per chain, and what was read on-chain
npm run verify -- -vv     # as -v, plus the full per-destination pathway table
```

`-v` prints, for each chain: the RPC actually used, quorum and signer count, priceFeed
and workerFeeLib addresses, the native token price the feed reports, worker settings, then
every check with its verdict — collapsed so 49 identical pathway passes read as
`dstConfig.floorMarginUSD  ok (49/49 passed)` rather than 49 lines. Anything that didn't
pass gets its expected/actual and reason printed underneath.

`-vv` adds a per-destination table — gas, multiplierBps, floorMarginUSD, quoted fee in
native and USD — which is what you want when reconciling a specific pathway's price.

## How the signer check is airtight

Enumerating signers normally means replaying `UpdateSigner` events, which most public
RPCs won't serve over a wide block range. This script doesn't need to:

```
signerSize == expected.signers.length          (nothing extra on-chain)
  AND  signers(a) == true  for every expected a  (nothing missing)
  ⇒ the on-chain active set is exactly the expected set
```

Two cheap `eth_call`s per signer, no log scan, no false negatives. `--scan-signers`
only kicks in when the count *does* mismatch, to tell you which address is the extra.

## How the fee check works

`canary-sponsored` is a fully sponsored deployment: every pathway should be priced on
**gas alone**, with no USD floor. That's asserted two ways.

**Statically** — `dstConfig(dstEid).floorMarginUSD` must equal `0`. This is a raw
integer comparison, so it needs no assumptions about USD denomination.

**Dynamically** — the script quotes `DVN.getFee()` for real, then re-quotes through
`DVNFeeLib.getFee()` with `floorMarginUSD` forced to `0`. LayerZero's fee math is:

```solidity
feeWithMultiplier = gasFee * multiplierBps / 10000;
feeWithFloor      = gasFee + (floorMarginUSD * 1e18) / nativePriceUSD;
fee = max(feeWithMultiplier, feeWithFloor);   // floor skipped entirely when 0
```

If the two quotes are identical, no floor is binding and you're charging gas × multiplier.
If they differ, `quote.floorNotBinding` fails and the report shows both numbers.

### The $0.25 deployment

Same script, different `expected.json`. `floorMarginUSD` is denominated the same as the
price feed's `nativeTokenPriceUSD` (1e20), so a 25-cent floor is `25000000000000000000`:

```jsonc
"dstConfig": {
  "default": { "floorMarginUSD": "25000000000000000000", "multiplierBps": null, "minGas": 1 },
  "overrides": {
    "ethereum": { "floorMarginUSD": "0" },              // this whole source chain is free
    "arbitrum->ethereum": { "floorMarginUSD": "0" }     // just this one pathway is free
  }
},
"quote": { "requireFloorNotBinding": false }
```

Overrides resolve most-specific-first: `src->dst`, then `src`, then `default`.

**Verify the denominator once before trusting it.** Run against Ethereum and check
`nativeTokenPriceUSD` in `report.json` — divided by `usdDenominator` it should land on
roughly the live ETH price. If your price feed uses a different scale, change
`usdDenominator` in `expected.json` and rescale the floor values to match.

## Chain and RPC resolution

Chain names come from the deployment file and resolve to EIDs through LayerZero's
metadata API, cached for 24h in `.cache/`. Nothing is hardcoded, so a new chain in the
deployment file just works.

RPCs come from three layers, in order:

1. **`rpc-overrides.json`** — yours, if present. An override *replaces* the other layers
   for that chain rather than being prepended, so a paid endpoint never silently falls
   back to a public one.
2. **LayerZero metadata** — the curated endpoints for each chain.
3. **[chainlist](https://chainlist.org)** (`ethereum-lists/chains`) — public endpoints,
   appended as failover, cached for 7 days.

Layers 2 and 3 are merged and deduped, capped at `--max-rpcs` (default 5). Every
candidate is chain-id checked before use, and the first that answers correctly wins.
Chainlist is matched **by numeric chain id, never by name**, so there's no way to
resolve the wrong network — worst case a chain has no entry and you get the metadata
RPCs alone.

The startup line tells you what came from where:

```
> chainlist: public RPCs for 2579 chain ids
> rpcs: 45 from metadata (38 with chainlist failover), 2 chainlist-only, 0 overridden
```

A ready-made `rpc-overrides.json` ships with this repo covering **all 47 EVM chains**:

```bash
# find-and-replace YOUR_KEY_HERE with your Alchemy key (the part after 'alch_')
# or, to keep the key out of the file entirely:
sed -i '' 's/alch_YOUR_KEY_HERE/alch_${ALCHEMY_KEY}/g' rpc-overrides.json
export ALCHEMY_KEY=...
```

Every chain is `["https://<slug>-mainnet.g.alchemy.com/v2/alch_...", "@auto"]`. The
`@auto` sentinel expands to the automatically-resolved endpoints, so each chain is *try
Alchemy first, fall back to public* — a slug Alchemy doesn't serve costs one failed DNS
lookup and the chain still gets verified. Endpoints with an unreplaced placeholder or an
unset env var are dropped with a warning rather than being attempted.

24 of the slugs are confirmed against the `Network` enum in `alchemy-sdk-js`; the other 23
are inferred, because that enum lags what Alchemy actually serves (`stable-mainnet` is
live but absent from it). `$slugs` in the file records which are which, and `-v` shows the
endpoint each chain actually used. Both groups are safe to attempt — a wrong URL can't
verify the wrong contract, because every endpoint is chain-id checked before use.

That file is gitignored so your key stays out of the repo. `--no-chainlist` turns layer 3
off if you'd rather only hit endpoints you've vetted.

**API keys are redacted from all output**, including `report.json` and error messages —
a long path segment or a `key`/`token`/`auth` query param becomes `***`. Reports are safe
to share.

If the APIs are unreachable from where you're running, both datasets can be supplied
offline:

```bash
curl -o lz-metadata.json https://metadata.layerzero-api.com/v1/metadata
curl -o chains.json https://raw.githubusercontent.com/ethereum-lists/chains/gh-pages/chains.json
npm run verify -- --metadata-file lz-metadata.json --chainlist-file chains.json
```

**Solana, Aptos and Stellar** are listed as `SKIPPED` — their addresses aren't EVM and
each needs its own reader. They still count as *destinations*, so a missing dstConfig
pointing at Solana is caught from every EVM source chain.

## Self-test

The verifier can be exercised end to end without touching mainnet:

```bash
npm run mock:serve      # terminal 1 — fake DVN on 127.0.0.1:8599
npm run mock:verify     # terminal 2
```

The mock covers every code path the real run can hit:

| mock chain | exercises |
|---|---|
| ethereum | the passing case — correct signer set, all floors zero |
| arbitrum | an extra on-chain signer, a $0.25 floor on a sponsored pathway, an unconfigured destination |
| metis | wrong quorum, wrong multiplier, allowlist-gated, paused, a `getFee` that reverts, a fee lib with an unrecognised ABI |
| fuse | rate-limits its first 3 requests — must recover to PASS via retries |
| polygon | offline — no usable RPC |
| solana | non-EVM, skipped but still counted as a destination |

A good run reports failures on arbitrum and metis, an error on polygon, and exits 1. The
metis case matters most: it proves a DVN whose fee lib doesn't match the expected ABI
degrades to "floor check skipped" rather than emitting a false failure.
