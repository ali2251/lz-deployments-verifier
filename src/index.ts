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
import { existsSync } from 'node:fs';

import { loadChainlist, type ChainlistIndex } from './chainlist.js';
import { HELP, parseArgs, type CliOptions } from './cli-args.js';
import { loadDeployment, loadExpected } from './config.js';
import { loadMetadata } from './metadata.js';
import { fromRoot } from './paths.js';
import { pool } from './pool.js';
import { printConsole, printProgress } from './report/console.js';
import { toJson, toMarkdown, writeReport } from './report/files.js';
import { totals } from './report/summary.js';
import { loadRpcOverrides } from './rpc-endpoints.js';
import { chainsToRerun, loadAppScope, resolveScope, selectSources, type ResolvedSource } from './scope.js';
import { verifyChain } from './verify-chain.js';

// Secrets live in .env at the repo root, which is gitignored — rpc-overrides.json ships
// with ${ALCHEMY_KEY} placeholders instead of a real key. A variable already exported in
// the shell wins, so CI can supply the key without a file existing at all.
function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  try {
    process.loadEnvFile(path);
  } catch (err) {
    console.warn(`! could not read ${path}: ${err instanceof Error ? err.message : err}`);
  }
}

/** --no-chainlist turns the public failover off, but an explicit --chainlist-file is still honoured. */
async function loadChainlistIfWanted(options: CliOptions): Promise<ChainlistIndex> {
  if (!options.useChainlist && !options.chainlistFile) return new Map();
  return loadChainlist({
    cachePath: fromRoot('.cache/chainlist.json'),
    file: options.chainlistFile,
    refresh: options.refreshMetadata,
  });
}

function printRpcOrigins(sources: ResolvedSource[]): void {
  const named = (origin: ResolvedSource['rpcOrigin']) => sources.filter((s) => s.rpcOrigin === origin).map((s) => s.info.name);
  const withFailover = named('metadata+chainlist').length;
  const fromMetadata = named('metadata').length + withFailover;
  const chainlistOnly = named('chainlist');

  console.log(
    `> rpcs: ${fromMetadata} from metadata` +
      (withFailover > 0 ? ` (${withFailover} with chainlist failover)` : '') +
      `, ${chainlistOnly.length} chainlist-only, ${named('override').length} overridden`,
  );
  if (chainlistOnly.length > 0) console.log(`  chainlist-only: ${chainlistOnly.join(', ')}`);
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if (options === 'help') {
    console.log(HELP);
    return 0;
  }

  // --- inputs ---
  const expected = loadExpected(options.expected);
  const deployment = loadDeployment(options.deployment);
  if (expected.deployment !== deployment.canonicalName) {
    throw new Error(`Expected profile ${expected.deployment} does not match deployment ${deployment.canonicalName}`);
  }
  const quote = options.quote && expected.quote.enabled;
  const app = options.app ? loadAppScope(options.app, deployment, fromRoot('applications/requirements.json')) : null;
  const rpcOverrides = loadRpcOverrides(options.rpcOverrides);

  console.log(`> deployment ${deployment.canonicalName} (${Object.keys(deployment.contractAddresses).length} chains)`);
  const metadata = await loadMetadata({
    cachePath: fromRoot('.cache/lz-metadata.json'),
    metadataFile: options.metadataFile,
    refresh: options.refreshMetadata,
  });
  console.log(`> LayerZero metadata: ${Object.keys(metadata).length} chain keys`);
  const chainlist = await loadChainlistIfWanted(options);
  if (chainlist.size > 0) console.log(`> chainlist: public RPCs for ${chainlist.size} chain ids`);

  // --- what to verify ---
  const scope = resolveScope({ deployment, metadata, chainlist, rpcOverrides, maxRpcs: options.maxRpcs, app });
  printRpcOrigins(scope.sources);

  // --rerun narrows to whatever didn't pass last time; --chains narrows further
  let wanted = options.chains;
  if (options.rerun) {
    const failed = chainsToRerun(options.rerun, deployment.canonicalName, metadata, app);
    console.log(`> --rerun: ${failed.length} chain(s) did not pass last time — ${failed.join(', ')}`);
    wanted = wanted ? wanted.filter((name) => failed.includes(name)) : failed;
  }
  const { selected, unverified } = selectSources(scope, wanted);

  console.log(
    `> verifying ${selected.length} EVM chain(s) x ${scope.destinations.length - 1} destinations` +
      (quote ? ' with live fee quotes' : ' (config only)'),
  );
  console.log(
    `> transport: ${options.rpc.batch ? 'batched' : 'one call per request'}, ${options.rpc.retries} retries, ` +
      `${options.rpc.delayMs}ms delay, ${options.concurrency} calls/chain, ${options.chainConcurrency} chains in parallel\n`,
  );

  // --- verify ---
  const plan = {
    expected,
    destinations: scope.destinations,
    quote,
    scanSigners: options.scanSigners,
    concurrency: options.concurrency,
  };
  let done = 0;
  const verified = await pool(selected, options.chainConcurrency, async (source) => {
    const result = await verifyChain(source, plan, options.rpc);
    printProgress(result, ++done, selected.length, options.verbose);
    return result;
  });

  // --- report ---
  const results = [...verified, ...unverified];
  printConsole(results, expected, options.verbose);
  if (options.outJson) {
    writeReport(options.outJson, toJson(results, expected));
    console.log(`  json -> ${options.outJson}`);
  }
  if (options.outMd) {
    writeReport(options.outMd, toMarkdown(results, expected));
    console.log(`  md   -> ${options.outMd}`);
  }
  console.log('');

  const { fail, error } = totals(results);
  return fail > 0 || error > 0 ? 1 : 0;
}

loadDotEnv(fromRoot('.env'));
main()
  .then((exitCode) => process.exit(exitCode))
  .catch((err) => {
    console.error(`\n${err?.message ?? err}\n`);
    process.exit(2);
  });
