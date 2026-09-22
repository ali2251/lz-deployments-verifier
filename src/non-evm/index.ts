/**
 * `npm run verify:usdt0:non-evm` — verifies the sponsored DVN on Solana, Stellar and Tron
 * as USDT0 sources.
 *
 * Each run gets its own directory under reports/usdt0-non-evm/. One collector per chain
 * runs as a child process and records what it read there; policy.ts then decides pass/fail.
 * The report is published as FAIL before anything runs and only becomes PASS when every
 * selected chain completed and passed, so an interrupted run can never look like a pass.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chainKey } from '../coverage.js';
import { loadMetadata, resolveChain, type Metadata } from '../metadata.js';
import { fromRoot } from '../paths.js';
import { assertHardcodedSigner, resolveSolanaSignerPolicy } from '../signers.js';
import type { Destination } from '../types.js';
import { USDT0_EXCLUSIONS, usdt0VerificationChains } from '../usdt0-scope.js';
import { completedSnapshot, SOURCES, validateChain, validateExpectations, validateSigners, type Source } from './policy.js';
import { toJson } from './run.js';

const REPORTS_DIR = fromRoot('reports/usdt0-non-evm');
const LATEST_FILE = join(REPORTS_DIR, 'latest.json');

const HELP =
  'npm run verify:usdt0:non-evm -- [--expected file]\n' +
  'Optional --only solana|solana-stellar|tron. Required signers in expected-non-evm.json. Successfully returned zero quotes are valid.';

/** `--only` values and the sources each one selects. */
const MODES: Record<string, Source[]> = {
  all: SOURCES,
  solana: ['solana'],
  'solana-stellar': ['solana', 'stellar'],
  tron: ['tron'],
};

/** Per source: what the collector read, plus the verdict. */
interface ChainReport {
  status: 'PASS' | 'FAIL';
  /** the observed signer set is exactly the pinned one, with the expected quorum */
  signerVerified: boolean;
  errors: string[];
  signerAddresses?: string[];
}

interface Report {
  runId: string;
  startedAt: string;
  completedAt?: string;
  status: 'PASS' | 'FAIL';
  scope: Source[];
  scopeKind: string;
  errors: string[];
  chains: Record<string, ChainReport>;
  limitations: string[];
  expectedFile?: string;
  expectedHash?: string;
  destinations?: Destination[];
  exclusions?: Readonly<Record<string, string>>;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const writeJson = (path: string, value: unknown): void => writeFileSync(path, toJson(value) + '\n');

// ---------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------

type Command = { kind: 'help' } | { kind: 'report' } | { kind: 'verify'; mode: string; expectedFile: string };

function parseArgs(argv: string[]): Command {
  let mode = 'all';
  let expectedFile = fromRoot('expected-non-evm.json');

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--help') return { kind: 'help' };
    if (flag === '--report') return { kind: 'report' };
    if (flag === '--expected') {
      const file = argv[++i];
      if (!file) throw new Error('--expected requires a file');
      expectedFile = resolve(file);
    } else if (flag === '--only') {
      mode = argv[++i] ?? '';
    } else {
      throw new Error(`Unknown argument ${flag}`);
    }
  }
  if (!Object.hasOwn(MODES, mode)) throw new Error('Invalid --only mode');
  return { kind: 'verify', mode, expectedFile };
}

// ---------------------------------------------------------------------------
// run inputs
// ---------------------------------------------------------------------------

/** Loads the expected policy and rejects it unless it agrees with the pinned signers. */
function loadExpectedPolicy(expectedFile: string, sources: Source[]): any {
  const expected = JSON.parse(readFileSync(expectedFile, 'utf8'));
  if (sources.includes('solana')) resolveSolanaSignerPolicy(expected);
  for (const source of sources) assertHardcodedSigner(source, expected.chains?.[source]?.signers);

  const problems = validateExpectations(expected, sources);
  if (problems.length) throw new Error(problems.join('\n'));
  return expected;
}

/** Every USDT0 chain, resolved to its endpoint id. Each source is checked against all the others. */
function resolveDestinations(metadata: Metadata, sources: Source[]) {
  const products = JSON.parse(readFileSync(fromRoot('applications/requirements.json'), 'utf8')).usdt0.products;
  const chains = usdt0VerificationChains(products).map((name) => {
    const chain = resolveChain(metadata, chainKey(name));
    if (!chain) throw new Error(`Required destination unresolved: ${name}`);
    return chain;
  });

  const uniqueEids = new Set(chains.map((chain) => chain.eid)).size;
  if (chains.length < 2 || uniqueEids !== chains.length) throw new Error('Invalid or duplicate destination scope');
  for (const source of sources) {
    if (!chains.some((chain) => chain.name === source)) throw new Error(`Missing required source ${source}`);
  }
  return chains;
}

/** Tron's DVN address: the sponsored inventory if it lists one, else LayerZero's metadata. */
function resolveTronAddress(deployment: any, metadata: Metadata): { address: string; source: string } {
  const listed: string | undefined = deployment.config.contractAddresses.tron;
  if (listed) return { address: listed, source: 'deployment inventory' };

  const dvns = Object.entries(metadata.tron?.dvns ?? {});
  const candidates = dvns.filter(([, dvn]) => dvn.id === 'canary-sponsored' && !dvn.deprecated);
  if (candidates.length !== 1) throw new Error('Tron sponsored deployment missing or ambiguous');
  return { address: candidates[0]![0], source: 'LayerZero metadata canary-sponsored' };
}

// ---------------------------------------------------------------------------
// collect and evaluate
// ---------------------------------------------------------------------------

/** Runs collect-<source>.ts in the run directory. Returns an error message if it did not exit cleanly. */
function runCollector(source: Source, runDir: string, runId: string): string | null {
  const script = fromRoot(`src/non-evm/collect-${source}.ts`);
  const child = spawnSync(process.execPath, ['--import', 'tsx', script], {
    cwd: fromRoot(),
    env: { ...process.env, NON_EVM_RUN_DIR: runDir, NON_EVM_RUN_ID: runId },
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  // A collector's PASS describes an individual read, never the verification: reword it
  // so that nothing in this command's output says PASS except the final verdict.
  if (child.stdout) console.log(child.stdout.replace(/\bPASS\b/g, 'READ_OK'));
  if (child.stderr) console.error(child.stderr);

  if (child.status === 0) return null;
  return `collect-${source}.ts: collection failed (${child.status ?? child.error?.message ?? 'terminated'})`;
}

/** Judges one source's snapshot. `errors` are the problems to list in the run report. */
function evaluate(source: Source, runDir: string, report: Report, expected: any): { chain: ChainReport; errors: string[] } {
  try {
    const snapshot = JSON.parse(readFileSync(join(runDir, `${source}-final.json`), 'utf8'));
    if (!completedSnapshot(snapshot, report.runId, report.startedAt)) {
      throw new Error('stale or incomplete result; run ID/completion invalid');
    }
    const policy = expected.chains[source];
    const errors = validateChain(source, snapshot, policy, report.destinations!);
    const signerVerified = validateSigners(source, snapshot, policy).length === 0;
    return { chain: { ...snapshot, status: errors.length ? 'FAIL' : 'PASS', signerVerified, errors }, errors };
  } catch (err) {
    const chain: ChainReport = { status: 'FAIL', signerVerified: false, errors: ['Required reads incomplete'] };
    return { chain, errors: [`${source}: ${errorMessage(err)}`] };
  }
}

async function verify(report: Report, runDir: string, expectedFile: string): Promise<void> {
  const sources = report.scope;

  // --- inputs, saved into the run directory for the collectors and as evidence ---
  const expected = loadExpectedPolicy(expectedFile, sources);
  report.expectedFile = expectedFile;
  report.expectedHash = createHash('sha256').update(JSON.stringify(expected)).digest('hex');
  writeJson(join(runDir, 'expected.json'), expected);

  const metadata = await loadMetadata({ cachePath: fromRoot('.cache/lz-metadata.json') });
  const chains = resolveDestinations(metadata, sources);
  report.destinations = chains.map(({ name, eid }) => ({ name, eid }));
  report.exclusions = USDT0_EXCLUSIONS;
  writeJson(join(runDir, 'scope.json'), { runId: report.runId, chains, exclusions: USDT0_EXCLUSIONS });

  const deployment = JSON.parse(readFileSync(fromRoot('deployments/canary-sponsored.json'), 'utf8'));
  writeJson(join(runDir, 'deployment.json'), deployment);
  if (sources.includes('tron')) writeJson(join(runDir, 'tron-address-source.json'), resolveTronAddress(deployment, metadata));

  // --- collect everything first, then judge ---
  const errors: string[] = [];
  for (const source of sources) {
    const failure = runCollector(source, runDir, report.runId);
    if (failure) errors.push(failure);
  }
  for (const source of sources) {
    const verdict = evaluate(source, runDir, report, expected);
    report.chains[source] = verdict.chain;
    errors.push(...verdict.errors);
  }
  report.errors = errors;
  report.status = errors.length ? 'FAIL' : 'PASS';
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

/** Writes the run's JSON and Markdown report and points latest.json at it. */
function publish(report: Report, runDir: string): void {
  const jsonFile = join(runDir, 'final-results.json');
  const markdownFile = join(runDir, 'results.md');
  const chainLines = Object.entries(report.chains).map(([name, chain]) => {
    const signers = (chain.signerAddresses ?? []).join(', ') || 'unavailable';
    const signerCheck = chain.signerVerified ? 'signer VERIFIED' : 'signer NOT VERIFIED';
    return `${name}: ${chain.status}; ${signerCheck}; observed/confirmed signers: ${signers}`;
  });
  const lines = [
    `# USDT0 non-EVM: ${report.status}`,
    `Run: ${report.runId}`,
    `Sources: ${report.scope.join(', ')}`,
    '',
    ...report.errors.map((error) => `- ${error}`),
    '',
    ...chainLines,
    '',
    ...report.limitations,
  ];
  writeJson(jsonFile, report);
  writeFileSync(markdownFile, lines.join('\n') + '\n');
  writeJson(LATEST_FILE, { runId: report.runId, status: report.status, report: markdownFile, json: jsonFile });
}

/** Reporting never creates a new verification or combines independently collected snapshots. */
function showLatest(): void {
  const latest = JSON.parse(readFileSync(LATEST_FILE, 'utf8'));
  console.log(`Recorded run ${latest.runId}: ${latest.status}. Report: ${latest.report}`);
  console.log('Report-only invocation does not perform fresh checks; exiting nonzero. Run verify:usdt0:non-evm for verification.');
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const command = parseArgs(process.argv.slice(2));
  if (command.kind === 'help') {
    console.log(HELP);
    return 0;
  }
  if (command.kind === 'report') {
    showLatest();
    return 1;
  }

  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const runDir = join(REPORTS_DIR, `${startedAt.replace(/[:.]/g, '-')}-${runId}`);
  mkdirSync(runDir, { recursive: true });

  const report: Report = {
    runId,
    startedAt,
    status: 'FAIL',
    scope: MODES[command.mode]!,
    scopeKind: command.mode === 'all' ? 'full USDT0 non-EVM scope excluding TON' : 'partial source verification',
    errors: ['Verification has not completed'],
    chains: {},
    limitations: [
      'Generic DVN configuration and fee verification only; does not verify USDT0 application DVN selection, end-to-end delivery, or signing-key control.',
    ],
  };
  publish(report, runDir);

  try {
    await verify(report, runDir, command.expectedFile);
  } catch (err) {
    report.status = 'FAIL';
    report.errors = [errorMessage(err)];
  }
  report.completedAt = new Date().toISOString();
  publish(report, runDir);

  console.log(`${report.status}: ${report.scopeKind}`);
  for (const [name, chain] of Object.entries(report.chains)) {
    console.log(`${name}: ${chain.status}; signer ${chain.signerVerified ? 'VERIFIED' : 'NOT VERIFIED'}`);
  }
  for (const error of report.errors) console.error(error);
  console.log(`Report: ${join(runDir, 'results.md')}`);
  return report.status === 'PASS' ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (err) {
  console.error(errorMessage(err));
  process.exitCode = 2;
}
