# Canary DVN verifier

Read-only verification of Canary DVN deployments, signer sets, worker configuration,
per-destination settings and fee quotes. No private key is needed and no transactions
are broadcast. EVM verification uses RPC reads; non-EVM verification also uses account
reads and transaction simulations.

A successful result applies only to the selected sources, destinations and enabled
checks. Inventory coverage, EVM verification and non-EVM verification are separate commands.

## Setup

Run commands from the project root with Node.js 22 and npm:

```bash
npm ci

# Optional: configure the API key used by RPC overrides.
cp .env.example .env
# Edit .env and set ALCHEMY_KEY; do not put private keys here.
```

The EVM CLI loads `.env`; existing shell environment variables take precedence.
The RPC overrides interpolate environment variables. Unresolved endpoint placeholders
are dropped with a warning. Public RPC fallback is available where `@auto` is configured.

The Solana and Stellar collectors use an additional isolated SDK installation:

```bash
npm ci --prefix runtime/non-evm
```

That runtime directory and its package files must be present. Installing the root
package alone does not install these SDKs.

## Choose a command

| Command | Scope | Default output |
|---|---|---|
| `npm run verify` | Sponsored EVM sources, destinations from the deployment inventory; slow mode | `report.json`, `report.md` |
| `npm run verify:usdt0` | USDT0 sponsored EVM sources and application destinations; slow mode | `report-usdt0.json`, `report-usdt0.md` |
| `npm run verify:subsidized` | Subsidized EVM sources and inventory destinations; $0.25 floor; **not slow by default** | `report-subsidized.json`, `report-subsidized.md` |
| `npm run verify:usdt0:non-evm` | USDT0 sponsored Solana, Stellar and Tron sources | Fresh run directory under `reports/usdt0-non-evm/` |
| `npm run verify:non-evm` | Alias for `verify:usdt0:non-evm` | Same as above |
| `npm run verify:non-evm:solana` | Partial source verification: Solana only | Fresh non-EVM run directory |
| `npm run verify:non-evm:solana-stellar` | Partial source verification: Solana and Stellar | Fresh non-EVM run directory |
| `npm run verify:non-evm:tron` | Partial source verification: Tron | Fresh non-EVM run directory |
| `npm run verify:non-evm:tron-signer` | Alias for full Tron configuration and fee verification, not a signer-only check | Fresh non-EVM run directory |
| `npm run verify:non-evm:report` | Show the last recorded non-EVM report location; no fresh checks | Console; deliberately exits 1 |
| `npm run coverage -- <app>` | Compare required chains against local deployment inventories | Console; optional JSON/Markdown |
| `npm test` | Offline regression tests | Console |
| `npm run typecheck` | TypeScript checking | Console |
| `npm run mock:serve` | Start local mock RPC | Console |
| `npm run mock:verify` | Verify the mock fixtures, including intentional failures | Console |

Solana uses the full secp256k1 public key pinned in `src/signers.ts`; its signer address is derived at runtime.
Use `verify:non-evm:solana` to check it independently of Stellar and Tron.

Pass script flags after npm's `--` separator:

```bash
npm run verify:usdt0 -- -vv
npm run verify:usdt0 -- --chains tempo
npm run verify:subsidized -- --slow
npm run verify -- --no-quote -v
```

## EVM workflows and scope

```bash
# All sponsored EVM sources in the inventory, including live fee quotes.
npm run verify

# USDT0 EVM sources only, including live quotes to non-EVM destinations.
npm run verify:usdt0

# One source, still checked against the full USDT0 destination scope.
npm run verify:usdt0 -- --chains tempo -vv

# Configuration only: explicitly excludes live fee verification.
npm run verify:usdt0 -- --no-quote -v

# Subsidized: exact $0.25 floor configuration, with live fee quotes.
npm run verify:subsidized -- --slow

# Selected subsidized sources; all subsidized inventory destinations remain.
npm run verify:subsidized -- --slow --chains ethereum,arbitrum -vv

# Retry unsuccessful sources, preserving the previous report as a separate file.
npm run verify:usdt0 -- --rerun report-usdt0.json \
  --json report-usdt0-retry.json --md report-usdt0-retry.md

# Console output only.
npm run verify:usdt0 -- --json none --md none
```

`--chains` takes deployment keys, such as `arbitrum`, `bsc`, `bera`, `hyperliquid`,
`plumephoenix`, `zkconsensys` and `xlayer`. It narrows **sources**, not destinations.
Self-routes are excluded. Do not use display names such as `BNB Chain` in this flag.

Without `--app`, destinations are resolved from the selected deployment inventory,
including its non-EVM entries. With `--app usdt0`, both sources and destinations follow
`applications/requirements.json` and the exclusions in `src/usdt0-scope.ts`:

| Chain | Treatment in USDT0 live verification |
|---|---|
| TON | Explicitly excluded by request; not verified |
| Corn | Historical CSV entry excluded from the established audit scope; not verified |
| Solana, Stellar, Tron | Included as destinations of EVM sources; require the separate non-EVM workflow to verify them as sources |

Exclusions are printed and recorded as skipped, never passed. The coverage command
retains the full requirements list, including TON and Corn. Missing required EVM
source deployments and unresolved in-scope destinations fail EVM verification.
A missing non-EVM inventory entry may be warned about without failing the EVM-source
run; consequently an EVM pass alone does not prove complete application coverage.

`--app` currently supports only `usdt0`. There is no `verify:ethena` command and no
`--app ethena` or `--app ondo`. Use `coverage` to review those applications' chain lists,
then the appropriate tier verifier with explicit source selections. Running
`verify:subsidized` checks the subsidized inventory, not an Ethena-specific scope.

## All EVM flags

These flags apply to `verify`, `verify:usdt0` and `verify:subsidized`.
Defaults below are the underlying CLI defaults; the npm presets override some of them.

| Flag | Meaning and default |
|---|---|
| `--deployment <file>` | Deployment JSON; default `deployments/canary-sponsored.json`. Subsidized preset selects its corresponding file. |
| `--expected <file>` | Expected-state JSON; default `expected.json`. Subsidized preset selects `expected-subsidized.json`. Its deployment name must match the inventory. |
| `--app usdt0` | Use the USDT0 verification scope; requires `canary-sponsored`. Already set by `verify:usdt0`. |
| `--chains a,b,c` | Verify selected source keys; keep the full destination scope. |
| `--no-quote` | Configuration-only verification. Skips live quotes and dynamic floor comparisons. |
| `--scan-signers` | On a signer-count mismatch, attempt an `UpdateSigner` event scan to identify active keys. Supplemental; failure to scan does not erase the mismatch. |
| `--rpc-overrides <file>` | RPC override JSON; default `rpc-overrides.json`. |
| `--metadata-file <file>` | Read LayerZero metadata from a local file instead of fetching it. |
| `--refresh-metadata` | Attempt fresh metadata and chainlist downloads, ignoring normal cache ages. Loaders may fall back to stale caches with a warning. |
| `--no-chainlist` | Disable automatic chainlist RPC fallback. An explicit `--chainlist-file` still loads that file. |
| `--chainlist-file <file>` | Load a local chainlist `chains.json`. |
| `--max-rpcs <n>` | Cap automatically merged RPC candidates per chain; default 5. Explicit override URLs can increase the total. |
| `--concurrency <n>` | Parallel destination checks per chain; default 6. Setting 1 also serializes worker reads. Values above 1 are not a strict global cap on all worker calls. |
| `--chain-concurrency <n>` | Source chains verified in parallel; default 6. |
| `--rpc-timeout <ms>` | Per-request timeout; default 20000. |
| `--retries <n>` | Extra attempts for retryable read failures; default 3. Connection capability probing may use fewer retries. |
| `--delay-ms <n>` | Delay before reads; default 0. Retry backoff adds further delay. |
| `--no-batch` | Disable JSON-RPC request batching. |
| `--slow` | Set concurrency 1, chain concurrency 2 and no batching; raise delay to at least 150 ms, retries to at least 3, timeout to at least 30000 ms. |
| `--rerun <report.json>` | Recheck unsuccessful sources from a compatible report. Known non-EVM and explicit scope exclusions are not retried as EVM sources. Intersects with `--chains` when both are supplied. |
| `--json <file\|none>` | JSON output path, or disable JSON output. Default `report.json`; npm presets select their own paths. |
| `--md <file\|none>` | Markdown output path, or disable Markdown output. Default `report.md`; npm presets select their own paths. |
| `-v`, `--verbose` | Worker values, signer checks and grouped findings per chain. |
| `-vv` | Also print the per-destination gas, multiplier, floor and quoted-fee table. |
| `-h`, `--help` | Print CLI help without verification. |

Flags are processed left to right. `verify` and `verify:usdt0` insert `--slow` before
user arguments, so later flags can override its numeric settings:

```bash
npm run verify:usdt0 -- --rpc-timeout 10000 --retries 1 --delay-ms 300
npm run verify:subsidized -- --slow --chain-concurrency 1
```

Concurrency, timeouts and RPC limits must be positive integers; retry counts and
delays may be zero. Invalid selections, malformed arguments and no-op reruns fail.
A rerun writes a report of the selected sources only; it does not merge old passes
with new results into a fresh full audit.

## What EVM verification checks

| Check | Assertion or read |
|---|---|
| Network | RPC `eth_chainId` matches metadata; endpoint can answer a contract call. |
| Snapshot | Record a block number and use it for the chain's contract state and fee reads. Different source chains have separate snapshots. |
| Deployment | DVN address has nonempty bytecode at that block. |
| Signer set | Expected signer count matches `signerSize`, and every expected address is active in `signers(address)`. |
| Quorum | Exact configured quorum; shipped profiles expect 1. |
| Worker | Read `paused`, `allowlistSize`, `defaultMultiplierBps`, `priceFeed`, `workerFeeLib` and `vid`. Required read failures fail verification. |
| Worker policy | Shipped profiles require unpaused, empty allowlist, default multiplier 12000 and nonzero price-feed/fee-library addresses. VID is recorded, not compared to an expected VID. |
| Destination gas | Each required source → destination has `gas >= minGas`; default minimum is 1. |
| Destination floor | Exact raw integer comparison against the configured floor. |
| Destination multiplier | Compare only when an expected multiplier is set. Shipped EVM profiles use `null`, so per-destination multipliers are recorded but not asserted. |
| Live quote | `DVN.getFee` must return successfully for each configured pathway using the expected sender, confirmations and options. **A returned zero is valid.** Missing data and reverts do not count as zero. |
| Dynamic floor comparison | When enabled, compare the DVN quote with the fee-library quote using a zero floor at the same block. Mismatches fail; comparison read failures are errors. |
| USD cap | Optional `quote.maxUsd`; exact integer/rational comparison. A configured cap requires an available, positive native-token price. |

Exact set verification uses a count plus membership checks; a successful event scan
is not required. A nonzero dependency address is not proof of its implementation's
correctness. Contract bytecode presence does not verify source code, implementation
version, ownership or upgrade controls.

The quote is a sample using the configured parameters, not every possible application
sender, payload or option. The verifier does not prove that USDT0/Ethena/Ondo selected
Canary in their messaging configuration, that a signer controls its key, or that
messages are delivered end to end.

## Expected-state files and fee settings

| Profile | Signer/quorum | Default worker multiplier | Raw floor | Dynamic zero-floor comparison |
|---|---|---|---|---|
| `expected.json` / sponsored | Pinned EVM signer, 1 of 1 | 12000 bps | `0` | Required |
| `expected-subsidized.json` / subsidized | Same pinned EVM signer, 1 of 1 | 12000 bps | `25000000000000000000` | Disabled; a binding floor is allowed |

The configured USD denominator is `100000000000000000000` (1e20), so the subsidized
raw floor represents **$0.25**. This checks the floor parameter, not that every total
quote equals $0.25. Sponsored zero floors do not imply every total quote is zero.
The deployment JSON's advertised `pathwayFloorMarginUSD` is not the assertion policy:
actual expected values come from the selected expected-state file.

| Expected-file setting | Meaning |
|---|---|
| `deployment` | Must match the inventory's `canonicalName`. |
| `signers` | Expected exact signer set; production Canary profiles must match the source-code pin. |
| `quorum` | Positive integer, no larger than the expected signer set. |
| `worker.defaultMultiplierBps`, `worker.allowlistSize`, `worker.paused` | Expected worker values; explicit `null` disables the corresponding comparison. |
| `worker.requirePriceFeedSet`, `worker.requireFeeLibSet` | Require nonzero dependency addresses when true. |
| `dstConfig.default.floorMarginUSD` | Raw expected floor; use a decimal string for large integers. `null` disables the comparison. |
| `dstConfig.default.multiplierBps` | Expected raw destination multiplier, or `null` to record without comparing. |
| `dstConfig.default.minGas` | Minimum configured gas, at least 1. |
| `dstConfig.overrides` | Partial source-wide or pathway-specific overrides. |
| `quote.enabled` | False produces configuration-only results, as does `--no-quote`. |
| `quote.sender` | Sample quote sender; shipped value is `0x000000000000000000000000000000000000dEaD`. |
| `quote.confirmations` | Sample confirmation count; default 1. |
| `quote.options` | Hex-encoded quote options; default `0x`. |
| `quote.maxUsd` | Optional nonnegative USD cap; shipped value `null` means no cap. |
| `quote.requireFloorNotBinding` | Require the dynamic zero-floor comparison. |
| `usdDenominator` | Positive power-of-ten price-feed scale used for USD conversion. |

Overrides merge by field: default → source → `source->destination`. Omitted fields
inherit; explicit `null` disables a nullable comparison. For example, in a copy of the
subsidized expected file:

```json
"overrides": {
  "ethereum": { "floorMarginUSD": "0" },
  "arbitrum->ethereum": { "floorMarginUSD": "0", "minGas": 1 }
}
```

This changes the expected policy; it does not change the contracts. Keep signer pins
and the intended deployment name intact. Large integer amounts must be strings to
avoid JavaScript precision loss. USD display values are informational; cap enforcement
uses exact arithmetic. If USD conversion is unavailable and no cap is configured,
USD display can be absent without failing an otherwise successful quote.

## Signer policy

Public identities are pinned in [`src/signers.ts`](src/signers.ts). They are never
learned from observed on-chain values. Production sponsored/subsidized expected files
and non-EVM expectation files cannot override the corresponding pins.

| Network | Pinned public identity | Current use |
|---|---|---|
| EVM | `0x6d695bDb416274d37fb877f5f46A3F20c9343D80` | Sponsored and subsidized EVM verification |
| Tron | `0x869bFFb8777378343631ae99A5ef68d406Ab774c` | Tron membership/count verification |
| Stellar | `0x70Da0d17248E28801f2FE4321497f8bbA57aC7c4` | Exact signer-set verification |
| Solana | `0x30Eef9754502f7B77895602F2C355baA37C36281` | Derived at runtime from the pinned full public key |
| Sui | `0x36e353871e75c0918126368cd0689f21835bcf57aea32e78feb78e34fc939576` | Stored only; no current npm verification reader |
| IOTA L1 (`iotal1`) | `0x67a9137092e444d4a8d31e26c78f08ee2f114caab2afa67478f021c4c9bac2fb` | Stored only; no current npm verification reader |
| Aptos | `0xedb0145daf54b2f17644121ca490ab918985d11b21d0df9d3623ad65877f7a85` | Stored only; no current npm verification reader |
| Starknet | `0x82c16B5BB0933428Dd69b9449728B0b25dd06A88` | Stored only; no current npm verification reader |

### Solana public-key derivation

The Solana DVN configuration stores full 64-byte secp256k1 public keys. The expected
policy supplies `chains.solana.publicKeys`, rather than a hash-only `signers` entry:

```json
"publicKeys": [
  "0xd171a4428246ac2fe197c6ffe4973809e8d8c797a9c24010a99e31e98fcceb3694be32cbaa366166cafe512728e543a99e575aecd94451608ea20206cc5639f8"
]
```

The verifier validates the key length and secp256k1 curve point, hashes the raw 64
bytes (x || y, without a 0x04 prefix) with **Keccak-256**, takes the last 20 bytes,
and formats the address with an EVM checksum. This produces
`0x30Eef9754502f7B77895602F2C355baA37C36281`. SHA3-256 is not interchangeable with
Keccak-256. It compares both the full on-chain public-key set and derived addresses
against the expected policy. Missing or mismatched keys fail verification.

Canary's signer-info endpoint publishes the association between the account identity
`nKtqDFhGeUDQpDVatUxKFUkSciAkBUaTof1g1iJQTr4` and this public key:

```bash
curl --fail 'https://layer0.canaryprotocol.com/signer-info?chainName=solana'
```

The observed response is an object with `statusCode` and a `body` array containing
`address` and `publicKey`. The account address itself is not hashed to derive the
DVN signer. The published public key matches our live sponsored-DVN read. Expectations
remain pinned locally: runs do not automatically trust a newly returned public key or
adopt an on-chain key. For an approved rotation, update both the source public-key pin
and `expected-non-evm.json`; derived addresses then update automatically. If an alternate
policy also supplies `signers`, it must agree with the derived pin. Run evidence stores
both the expected public key and its derived address.

The sponsored Solana config is `FGfRUbiNjXJ5FaVzWj7gcnUJMYTiCLPmgTVeeozWooZB`.
The metadata entry `7jMeX5mzXnSSKYd8DxBDP4xMnkNFZZZm5W28FWUTbwU3` is the separate
standard Canary deployment. Other chain expectations retain their existing address
formats; the Solana derivation must not be applied blindly to other key types.

## Non-EVM workflow, flags and checks

```bash
# All three supported non-EVM sources.
npm run verify:usdt0:non-evm

# Run one source independently.
npm run verify:non-evm:solana
npm run verify:non-evm:tron

# Partial Solana/Stellar scope.
npm run verify:non-evm:solana-stellar

# Alternate fee/multiplier policy; signer pins remain enforced.
npm run verify:non-evm:tron -- --expected expected-non-evm.json

# Show the latest report location without running checks (exit 1).
npm run verify:non-evm:report
```

| Non-EVM flag | Meaning |
|---|---|
| `--expected <file>` | Expected policy; default `expected-non-evm.json`. Signer pins cannot be overridden. |
| `--only solana` | Verify Solana alone against the application destination scope. |
| `--only solana-stellar` | Verify these two sources against the application destination scope. |
| `--only tron` | Verify Tron as a source against that destination scope. |
| `--report` | Display the latest recorded run's status/location; exits 1 because it performs no fresh verification. |
| `--help` | Print help and exit successfully. |

EVM flags such as `--slow`, `--chains`, `--rpc-overrides`, `--no-quote`, `-v` and report
path flags are not supported here. There is no Stellar-only mode, subsidized non-EVM
mode or generic all-applications non-EVM command. Collectors currently use fixed RPC
URLs and their own retry/delay settings; EVM `.env`/RPC overrides do not configure them.

The non-EVM policy requires:

- A verified network/deployment and completed dependency reads. Solana checks its
  configuration discriminator/PDA, program executability and price-feed account;
  Stellar reads the contract instance/WASM and required dependencies; Tron checks
  chain ID, bytecode and nonzero dependency addresses.
- Exact expected signer set and quorum. Tron additionally checks each expected
  signer's membership and the total count.
- Unpaused state, empty allowlist and the expected default multiplier (12000).
- Exactly one result per required destination, with the correct EID, positive gas,
  a zero sponsored floor and the expected destination multiplier. The shipped policy
  uses 12000, except that every source → Ethereum uses 10500 (the same schedule the
  EVM sources use).
- A successful nonnegative fee return for every required route. **Zero is valid**;
  missing, malformed, negative or failed reads are not.
- A completed snapshot from the current run ID with a valid completion timestamp.

Non-EVM collectors do not implement the EVM USD-cap or zero-floor fee-library
comparison. They read/simulate over the duration of a run, not at one shared pinned
block. Solana/Stellar use collector-selected message-library/admin/source values;
Tron uses sender `0x000000000000000000000000000000000000dEaD`, confirmation count 1
and empty options. These are sample quotes, not application delivery tests.

Tron's address comes from the sponsored inventory when present, otherwise from an
unambiguous, nondeprecated `canary-sponsored` entry in LayerZero metadata. The chosen
address and source are saved in the run directory.

Each invocation creates a timestamp/UUID directory under `reports/usdt0-non-evm/`
with its inputs, raw read evidence and final JSON/Markdown. One collector per source
chain runs as a child process and writes its reads to `<chain>-final.json`; a chain
passes only if its own snapshot completed in this run, so one chain's collection
failure does not invalidate another chain's reads (the run as a whole still fails).
`latest.json` points to the latest run, which may be partial or failed. Each chain line in
`results.md` states `signer VERIFIED` only when the observed signer set is exactly the pinned
set with the expected quorum. Reports begin as FAIL/incomplete and
become PASS only when every selected check completes. Partial runs are labeled and
are not combined with evidence from other runs. Intermediate `READ_OK` messages do
not mean the chain or complete run passed.

## Application inventory coverage and flags

```bash
npm run coverage -- usdt0
npm run coverage -- ethena
npm run coverage -- ondo
npm run coverage -- ondo --tier subsidized --product usdy
npm run coverage -- ondo --tier sponsored --product ousg
npm run coverage -- ondo --tier both --product stocks
npm run coverage -- all --json coverage-report.json --md coverage-report.md
```

| Coverage argument/flag | Meaning |
|---|---|
| `<app>` or `--app <name\|all>` | Application from the requirements file, or all applications. |
| `--tier sponsored\|subsidized\|both` | Tier selection. USDT0 is sponsored; Ethena is subsidized. Incompatible tier selections fail. Ondo defaults to separate comparisons for both tiers. |
| `--product <name>` | Select a product key; Ondo keys are `usdy`, `ousg`, `stocks`. It must exist in each selected application. |
| `--requirements <file>` | Alternate requirements JSON; default `applications/requirements.json`. |
| `--json <file>` | Write a JSON coverage report; no file by default. |
| `--md <file>` | Write a Markdown coverage report; no file by default. |
| `--help`, `-h` | Print help. |

Coverage uses the two local tier deployment files. `LISTED` means a nonempty, nonzero
address is present; `MISSING` means it is absent. It does not check bytecode, signer,
fees, address correctness or application DVN selection. An entry in the other tier
does not satisfy the selected tier. Non-EVM chains remain in this comparison.

Requirements are snapshots: USDT0 uses both columns of `usdt0.csv`, including
zero-volume rows; Ethena uses the September 14, 2026 documentation baseline; Ondo uses
the supplied product lists. They are not automatically refreshed from application
websites. Update the file when requirements change. Name aliases normalize labels
such as BNB Chain → `bsc`, HyperEVM → `hyperliquid`, Plume → `plumephoenix` and
Linea → `zkconsensys`; unknown chains remain required and are reported missing.

## RPC resolution and troubleshooting

The EVM verifier resolves LayerZero V2 mainnet endpoints from metadata. It classifies
VMs using metadata rather than address length. Known non-EVM sources are skipped by
this CLI but remain destinations when in scope; unknown VM types fail.

RPC overrides replace automatic endpoints unless their list contains `@auto`:

```json
{
  "ethereum": ["https://your-rpc.example/${RPC_TOKEN}", "@auto"],
  "arbitrum": "https://your-arbitrum-rpc.example"
}
```

`@auto` expands to metadata endpoints followed by public chainlist endpoints, deduplicated
and capped by `--max-rpcs`. Chainlist matches numeric chain IDs. Candidate RPCs are
checked for the expected network and contract-call capability. Selection does not
guarantee the provider will remain available for every subsequent read.

Metadata is normally cached for 24 hours and chainlist for 7 days under `.cache/`.
Local files can replace those downloads; on-chain verification still requires RPC access:

```bash
npm run verify -- --metadata-file lz-metadata.json --chainlist-file chains.json
npm run verify -- --refresh-metadata
npm run verify -- --no-chainlist
```

| Symptom | What to do |
|---|---|
| HTTP 429, timeout, batch rejection | Use `--slow`, increase `--delay-ms`, lower chain concurrency or configure a working RPC. Slow mode is already on for `verify` and `verify:usdt0`. |
| `rpc.snapshot` or historical-state errors | Use an RPC that supports reads at the recorded block. Snapshot reads remain required. |
| `dstConfig.gas` failure | Destination gas is below the configured minimum. Inspect on-chain configuration; retries do not repair it. |
| `quote.floorNotBinding` error | Required fee-library comparison failed. Inspect the RPC/revert/ABI detail; it is not silently skipped. |
| Successful quote of `0` | Valid. No minimum positive-fee policy is imposed. |
| No sources selected / no unsuccessful sources to rerun | No fresh verification occurred; the CLI exits nonzero. |
| Solana signer failure | Compare the decoded secp256k1 signer against the approved pin; account public keys are not substitutes. |

EVM output redacts common RPC credential patterns, but review reports before sharing;
redaction is not a guarantee for every provider's URL format. Non-EVM directories
contain raw public RPC responses and may contain error text.

## Reports, statuses and exit codes

Generated reports are local artifacts and must not be committed. `.gitignore` excludes
`reports/` and root JSON/Markdown filenames containing `report` (including
`report-usdt0.json` and `coverage-report.md`). Put custom output paths under `reports/`
so they are ignored too. The reusable non-EVM SDK manifests live separately in
`runtime/non-evm/`; installed `node_modules/` remain ignored.

EVM console output defaults to a chain summary plus unsuccessful findings. `-v` adds
worker/signature-check details; `-vv` adds pathway values. JSON includes the snapshot
block, verification scope, expected policy, worker reads, findings and pathways.

| Status | Meaning |
|---|---|
| `PASS` / JSON `OK` | All enabled checks for that selected EVM source completed without a failure/error. |
| `CONFIG` / JSON `OK` with `verificationScope: configuration-only` | Configuration passed; live quotes were deliberately not checked. |
| `FAIL` | An asserted value or required quote failed. |
| `ERROR` | A required check could not complete, for example an RPC/read/metadata error. |
| `SKIP` / JSON `SKIPPED` | Outside this verifier's source scope or explicitly excluded; not verified. |

A chain can contain both FAIL and ERROR findings even if its overall label is FAIL.
Inspect individual findings. A signer-column success proves only the signer checks,
not fee verification or total chain success.

| Command family | Exit 0 | Exit 1 | Exit 2 |
|---|---|---|---|
| EVM | Selected enabled checks succeeded; inspect scope/skips | At least one FAIL or ERROR | Setup/argument error or no-op selection |
| Coverage | All selected inventories have entries | Missing inventory entries | Invalid input/setup |
| Non-EVM | All selected checks completed successfully | Failed/incomplete verification or report-only invocation | Invalid arguments; no run directory is created |

Help invocations exit successfully without verification. EVM reports are written when
the run completes; an interrupted run or setup failure can leave an older report at
the default path. Check its timestamp and the command's exit code. Non-EVM runs publish
an initial FAIL manifest so an unfinished run is not represented as a fresh pass.

## Code layout

| Path | Responsibility |
|---|---|
| `src/index.ts` | EVM verifier entry point: load inputs, resolve scope, verify, report. |
| `src/cli-args.ts` | Every EVM flag, its default and the `--slow` preset. Nothing else parses arguments. |
| `src/config.ts` | Loads and validates the expected-state and deployment files. |
| `src/scope.ts` | Decides sources, destinations and unverified chains; `--app`, `--chains`, `--rerun`. |
| `src/verify-chain.ts` | Verifies one source chain: all on-chain reads, pinned to one snapshot block. |
| `src/checks.ts` | The assertions as pure functions: values in, findings out. No network access. |
| `src/rpc.ts`, `src/rpc-endpoints.ts` | Connecting/retrying/redaction, and which endpoints to try per chain. |
| `src/metadata.ts`, `src/chainlist.ts`, `src/cache.ts` | LayerZero metadata, public RPC list, and their file cache. |
| `src/report/` | Console output, `report.md`/`report.json`, and the numbers they share. |
| `src/signers.ts` | The pinned signer identities. |
| `src/coverage.ts`, `src/coverage-cli.ts`, `src/usdt0-scope.ts` | Inventory coverage and the USDT0 scope. |
| `src/non-evm/index.ts` | Non-EVM entry point: prepares a run directory, runs collectors, judges, publishes. |
| `src/non-evm/collect-*.ts` | One collector per chain. They record reads and never decide pass/fail. |
| `src/non-evm/policy.ts` | The non-EVM pass/fail policy, applied to the collectors' snapshots. |
| `test/helpers.ts` | Test fixtures, including an in-process fake DVN behind `fetch`. |

## Local validation

```bash
npm test
npm run typecheck

# Two terminals: no live-chain access required.
npm run mock:serve
npm run mock:verify
```

The mock intentionally includes signer/configuration mismatches, reverts, a rate-limited
endpoint and an offline endpoint. `mock:verify` is expected to exit nonzero; those
failures exercise reporting. Regression tests cover missing reads, exact signer sets,
zero quotes, USD-cap arithmetic, scope exclusions and incomplete non-EVM runs.
