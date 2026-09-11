#!/usr/bin/env tsx
/**
 * canary-dvn-verify
 *
 * Verifies, for every chain in a Canary DVN deployment:
 *   1. the multisig  — quorum, signer set (exactly the expected addresses, nothing else)
 *   2. the worker    — priceFeed, workerFeeLib, defaultMultiplierBps, allowlist, pause state
 *   3. every dstConfig — gas / multiplierBps / floorMarginUSD against the expected fee policy
 *   4. a live getFee() quote per pathway, plus a check that no USD floor is binding
 *
 * Read-only. Never sends a transaction, never needs a private key.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress, type Address } from 'viem';

import { loadChainlist, mergeRpcs } from './chainlist.js';
import { verifyChain, pool, scanSigners, connectToChain, type ChainResult } from './checks.js';
import { isEvmAddress, loadDeployment, loadExpected } from './config.js';
import { AUTO_RPC, loadMetadata, loadRpcOverrides, resolveChain, type ChainInfo } from './metadata.js';
import { printConsole, toJson, toMarkdown, totals } from './report.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface Args {
  deployment: string;
  expected: string;
  rpcOverrides: string;
  metadataFile?: string;
  refreshMetadata: boolean;
  chainlist: boolean;
  chainlistFile?: string;
  maxRpcs: number;
  chains: string[] | null;
  quote: boolean;
  scanSigners: boolean;
  concurrency: number;
  chainConcurrency: number;
  rpcTimeoutMs: number;
  retries: number;
  delayMs: number;
  batch: boolean;
  rerun: string | null;
  outJson: string | null;
  outMd: string | null;
  verbose: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    deployment: resolve(ROOT, 'deployments/canary-sponsored.json'),
    expected: resolve(ROOT, 'expected.json'),
    rpcOverrides: resolve(ROOT, 'rpc-overrides.json'),
    refreshMetadata: false,
    chainlist: true,
    maxRpcs: 5,
    chains: null,
    quote: true,
    scanSigners: false,
    concurrency: 6,
    chainConcurrency: 6,
    rpcTimeoutMs: 20_000,
    retries: 3,
    delayMs: 0,
    batch: true,
    rerun: null,
    outJson: resolve(ROOT, 'report.json'),
    outMd: resolve(ROOT, 'report.md'),
    verbose: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => argv[++i]!;
    switch (arg) {
      case '--deployment': a.deployment = resolve(next()); break;
      case '--expected': a.expected = resolve(next()); break;
      case '--rpc-overrides': a.rpcOverrides = resolve(next()); break;
      case '--metadata-file': a.metadataFile = resolve(next()); break;
      case '--refresh-metadata': a.refreshMetadata = true; break;
      case '--no-chainlist': a.chainlist = false; break;
      case '--chainlist-file': a.chainlistFile = resolve(next()); break;
      case '--max-rpcs': a.maxRpcs = Number(next()); break;
      case '--chains': a.chains = next().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--no-quote': a.quote = false; break;
      case '--scan-signers': a.scanSigners = true; break;
      case '-v':
      case '--verbose': a.verbose = Math.max(a.verbose, 1); break;
      case '-vv': a.verbose = 2; break;
      case '--concurrency': a.concurrency = Number(next()); break;
      case '--chain-concurrency': a.chainConcurrency = Number(next()); break;
      case '--rpc-timeout': a.rpcTimeoutMs = Number(next()); break;
      case '--retries': a.retries = Number(next()); break;
      case '--delay-ms': a.delayMs = Number(next()); break;
      case '--no-batch': a.batch = false; break;
      case '--rerun': a.rerun = resolve(next()); break;
      case '--slow':
        // one call at a time, two chains at a time, no batching, patient retries
        a.concurrency = 1;
        a.chainConcurrency = 2;
        a.delayMs = Math.max(a.delayMs, 150);
        a.retries = Math.max(a.retries, 3);
        a.batch = false;
        a.rpcTimeoutMs = Math.max(a.rpcTimeoutMs, 30_000);
        break;
      case '--json': a.outJson = next() === 'none' ? null : resolve(argv[i]!); break;
      case '--md': a.outMd = next() === 'none' ? null : resolve(argv[i]!); break;
      case '-h':
      case '--help':
        console.log(HELP);
        process.exit(0);
      default:
        throw new Error(`unknown argument: ${arg}\n\n${HELP}`);
    }
  }
  return a;
}

const HELP = `
canary-dvn-verify — read-only audit of a LayerZero V2 DVN deployment

  npm install
  npm run verify -- [options]

Options
  --deployment <file>     deployment JSON            (default deployments/canary-sponsored.json)
  --expected <file>       expected on-chain state    (default expected.json)
  --rpc-overrides <file>  { "chain": "https://..." } (default rpc-overrides.json, optional)
  --metadata-file <file>  use a local copy of LayerZero metadata instead of fetching
  --refresh-metadata      ignore the 24h metadata cache
  --no-chainlist          don't append public RPCs from chainlist as failover
  --chainlist-file <file> use a local copy of chainlist's chains.json
  --max-rpcs <n>          endpoints tried per chain before giving up (default 5)
  --chains a,b,c          only verify these source chains
  --no-quote              skip live getFee() quotes (much faster, config checks only)
  --scan-signers          on a signer-count mismatch, replay UpdateSigner logs to name the extras
  --concurrency <n>       parallel calls per chain     (default 6)
  --chain-concurrency <n> chains verified in parallel  (default 6)
  --rpc-timeout <ms>      per-request timeout          (default 20000)
  --retries <n>           retries per call on transport errors (default 3)
  --delay-ms <n>          pause before every call, to stay under a rate limit
  --no-batch              one eth_call per HTTP request (some providers reject batches)
  --slow                  preset: --concurrency 1 --chain-concurrency 2 --delay-ms 150
                          --no-batch --retries 3, 30s timeout
  --rerun <report.json>   re-verify only the chains that didn't pass in that report
  --json <file|none>      JSON report path             (default report.json)
  --md <file|none>        Markdown report path         (default report.md)
  -v, --verbose           show every check that passed, per chain, plus what was read
  -vv                     as -v, plus the full per-destination pathway table

API keys in RPC URLs are redacted from all output, including report.json.

Exit code is 1 if any check FAILs, 2 on a setup error, 0 otherwise.
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const expected = loadExpected(args.expected);
  const deployment = loadDeployment(args.deployment);
  const overrides = loadRpcOverrides(args.rpcOverrides);

  console.log(`> deployment ${deployment.canonicalName} (${Object.keys(deployment.contractAddresses).length} chains)`);
  const metadata = await loadMetadata({
    cachePath: resolve(ROOT, '.cache/lz-metadata.json'),
    metadataFile: args.metadataFile,
    refresh: args.refreshMetadata,
  });
  console.log(`> LayerZero metadata: ${Object.keys(metadata).length} chain keys`);

  const chainlist =
    args.chainlist || args.chainlistFile
      ? await loadChainlist({
          cachePath: resolve(ROOT, '.cache/chainlist.json'),
          file: args.chainlistFile,
          refresh: args.refreshMetadata,
        })
      : new Map<number, string[]>();
  if (chainlist.size > 0) console.log(`> chainlist: public RPCs for ${chainlist.size} chain ids`);

  // --- resolve every chain in the deployment ---
  const evm: Array<{ info: ChainInfo; address: Address; rpcs: string[] }> = [];
  const skipped: ChainResult[] = [];
  const rpcSource = {
    metadataOnly: [] as string[],
    both: [] as string[],
    chainlistOnly: [] as string[],
    override: [] as string[],
  };

  for (const [name, addr] of Object.entries(deployment.contractAddresses)) {
    if (!isEvmAddress(addr)) {
      skipped.push({
        name, eid: null, address: addr, status: 'SKIPPED', findings: [], pathways: [],
        skipReason: 'non-EVM VM — not verified by this script',
      });
      continue;
    }
    const info = resolveChain(metadata, name);
    if (!info) {
      skipped.push({
        name, eid: null, address: addr, status: 'SKIPPED', findings: [], pathways: [],
        skipReason: 'no LayerZero V2 mainnet eid found in metadata for this chain key',
      });
      continue;
    }
    // curated metadata RPCs first, public chainlist endpoints appended as failover
    const publicRpcs = info.nativeChainId === null ? [] : (chainlist.get(info.nativeChainId) ?? []);
    const autoRpcs = mergeRpcs(info.rpcs, publicRpcs, args.maxRpcs);

    // an override list replaces that, except where it says "@auto" — which expands
    // back to the automatic endpoints, so "try my endpoint, then fall back" is expressible
    const override = overrides[name];
    let rpcs: string[];
    if (override) {
      const expanded: string[] = [];
      for (const entry of override) {
        if (entry === AUTO_RPC) expanded.push(...autoRpcs);
        else expanded.push(entry);
      }
      const explicit = override.filter((e) => e !== AUTO_RPC).length;
      rpcs = mergeRpcs(expanded, [], explicit + args.maxRpcs);
    } else {
      rpcs = autoRpcs;
    }
    if (rpcs.length === 0) {
      skipped.push({
        name, eid: info.eid, address: addr, status: 'SKIPPED', findings: [], pathways: [],
        skipReason: `no RPC URL (metadata has none, chainlist has none for chain id ${info.nativeChainId ?? '?'}) — add one to rpc-overrides.json`,
      });
      continue;
    }
    if (overrides[name]) rpcSource.override.push(name);
    else if (info.rpcs.length === 0) rpcSource.chainlistOnly.push(name);
    else if (publicRpcs.length > 0) rpcSource.both.push(name);
    else rpcSource.metadataOnly.push(name);

    evm.push({ info, address: getAddress(addr), rpcs });
  }

  console.log(
    `> rpcs: ${rpcSource.metadataOnly.length + rpcSource.both.length} from metadata` +
      `${rpcSource.both.length > 0 ? ` (${rpcSource.both.length} with chainlist failover)` : ''}` +
      `, ${rpcSource.chainlistOnly.length} chainlist-only, ${rpcSource.override.length} overridden`,
  );
  if (rpcSource.chainlistOnly.length > 0) {
    console.log(`  chainlist-only: ${rpcSource.chainlistOnly.join(', ')}`);
  }

  // The destination universe is every chain in the deployment we could resolve an eid for,
  // including the non-EVM ones — a sponsored pathway to Solana still needs a dstConfig here.
  const universe = [
    ...evm.map((e) => ({ name: e.info.name, eid: e.info.eid })),
    ...skipped
      .map((s) => {
        const info = resolveChain(metadata, s.name);
        return info ? { name: s.name, eid: info.eid } : null;
      })
      .filter((v): v is { name: string; eid: number } => v !== null),
  ];

  // --rerun narrows to whatever didn't pass last time; --chains narrows further
  let wanted = args.chains;
  if (args.rerun) {
    if (!existsSync(args.rerun)) throw new Error(`--rerun: report not found: ${args.rerun}`);
    const prev = JSON.parse(readFileSync(args.rerun, 'utf8'));
    const failed: string[] = (prev.chains ?? [])
      .filter((c: any) => c.status === 'FAIL' || c.status === 'ERROR')
      .map((c: any) => c.name);
    if (failed.length === 0) {
      console.log('> --rerun: every chain passed in that report, nothing to re-verify');
      process.exit(0);
    }
    console.log(`> --rerun: ${failed.length} chain(s) did not pass last time — ${failed.join(', ')}`);
    wanted = wanted ? wanted.filter((c) => failed.includes(c)) : failed;
  }

  const selected = wanted ? evm.filter((e) => wanted!.includes(e.info.name)) : evm;
  if (wanted) {
    const missing = wanted.filter((c) => !evm.some((e) => e.info.name === c));
    if (missing.length > 0) console.warn(`! not verifiable here: ${missing.join(', ')}`);
  }

  console.log(
    `> verifying ${selected.length} EVM chain(s) x ${universe.length - 1} destinations` +
      `${args.quote ? ' with live fee quotes' : ' (config only)'}`,
  );
  console.log(
    `> transport: ${args.batch ? 'batched' : 'one call per request'}, ${args.retries} retries, ` +
      `${args.delayMs}ms delay, ${args.concurrency} calls/chain, ${args.chainConcurrency} chains in parallel\n`,
  );

  let done = 0;
  const results = await pool(selected, args.chainConcurrency, async (entry) => {
    const r = await verifyChain(entry.info, entry.address, entry.rpcs, {
      expected,
      universe,
      quote: args.quote,
      concurrency: args.concurrency,
      rpcTimeoutMs: args.rpcTimeoutMs,
      retries: args.retries,
      delayMs: args.delayMs,
      batch: args.batch,
    });

    if (args.scanSigners && r.findings.some((f) => f.check === 'multisig.unexpectedSigners')) {
      try {
        const { client } = await connectToChain(entry.info, entry.rpcs, args.rpcTimeoutMs, {
          batch: args.batch,
          retries: args.retries,
        });
        const scan = await scanSigners(client, entry.address);
        r.findings.push(
          'error' in scan
            ? { check: 'multisig.scan', severity: 'WARN', detail: `log scan failed: ${scan.error}` }
            : {
                check: 'multisig.scan',
                severity: 'INFO',
                actual: scan.signers.join(', '),
                detail: `active signers from UpdateSigner logs, blocks ${scan.scannedFrom}-${scan.scannedTo}`,
              },
        );
      } catch { /* best effort */ }
    }

    done++;
    const mark = r.status === 'OK' ? 'ok  ' : r.status === 'FAIL' ? 'FAIL' : 'ERR ';
    const passed = r.findings.filter((f) => f.severity === 'PASS').length;
    const extra =
      args.verbose > 0
        ? `  ${passed} checks passed, ${r.pathways.filter((p) => p.gas !== null && p.gas > 0n).length} pathways  ${r.rpc ?? ''}`
        : '';
    console.log(`  [${String(done).padStart(2)}/${selected.length}] ${mark} ${entry.info.name.padEnd(14)}${extra}`);
    return r;
  });

  const all = [...results, ...skipped];
  printConsole(all, expected, args.verbose);

  if (args.outJson) {
    mkdirSync(dirname(args.outJson), { recursive: true });
    writeFileSync(args.outJson, toJson(all, expected));
    console.log(`  json -> ${args.outJson}`);
  }
  if (args.outMd) {
    mkdirSync(dirname(args.outMd), { recursive: true });
    writeFileSync(args.outMd, toMarkdown(all, expected));
    console.log(`  md   -> ${args.outMd}`);
  }
  console.log('');

  const t = totals(all);
  process.exit(t.fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n${err?.message ?? err}\n`);
  process.exit(2);
});
