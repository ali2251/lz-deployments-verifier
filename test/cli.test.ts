import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { parseArgs, type CliOptions } from '../src/cli-args.js';
import { MOCK_CLI_ARGS, runCli, tempJson } from './helpers.js';

const parse = (...argv: string[]) => parseArgs(argv) as CliOptions;
const runVerifier = (args: string[], nodeArgs?: string[]) => runCli('src/index.ts', [...MOCK_CLI_ARGS, ...args], nodeArgs);

// ---------------------------------------------------------------------------
// argument parsing
// ---------------------------------------------------------------------------

test('defaults', () => {
  const options = parse();
  assert.equal(options.app, null);
  assert.equal(options.chains, null);
  assert.equal(options.quote, true);
  assert.equal(options.useChainlist, true);
  assert.equal(options.maxRpcs, 5);
  assert.equal(options.concurrency, 6);
  assert.equal(options.chainConcurrency, 6);
  assert.deepEqual(options.rpc, { timeoutMs: 20_000, retries: 3, delayMs: 0, batch: true });
  assert.equal(options.verbose, 0);
  assert.match(options.deployment, /deployments\/canary-sponsored\.json$/);
  assert.match(options.outJson!, /report\.json$/);
});

test('flags map onto options', () => {
  const options = parse(
    '--app', 'usdt0', '--chains', 'tempo, arbitrum,', '--no-quote', '--scan-signers', '--no-chainlist', '--no-batch',
    '--max-rpcs', '2', '--retries', '0', '--delay-ms', '25', '--rpc-timeout', '900', '--json', 'none', '--md', 'out/r.md', '-vv',
  );
  assert.equal(options.app, 'usdt0');
  assert.deepEqual(options.chains, ['tempo', 'arbitrum']);
  assert.equal(options.quote, false);
  assert.equal(options.scanSigners, true);
  assert.equal(options.useChainlist, false);
  assert.equal(options.maxRpcs, 2);
  assert.deepEqual(options.rpc, { timeoutMs: 900, retries: 0, delayMs: 25, batch: false });
  assert.equal(options.outJson, null);
  assert.equal(options.outMd, resolve('out/r.md'));
  assert.equal(options.verbose, 2);
  assert.equal(parse('-v').verbose, 1);
  assert.equal(parse('-vv', '--verbose').verbose, 2);
});

test('--slow is a preset that later flags can override, but never loosens earlier ones', () => {
  const slow = parse('--slow');
  assert.equal(slow.concurrency, 1);
  assert.equal(slow.chainConcurrency, 2);
  assert.deepEqual(slow.rpc, { timeoutMs: 30_000, retries: 3, delayMs: 150, batch: false });

  // the npm scripts put --slow first, so the user's flags win
  const tuned = parse('--slow', '--retries', '1', '--chain-concurrency', '1', '--delay-ms', '300');
  assert.equal(tuned.rpc.retries, 1);
  assert.equal(tuned.rpc.delayMs, 300);
  assert.equal(tuned.chainConcurrency, 1);

  // --slow after patient settings keeps the more patient value
  const patient = parse('--retries', '8', '--delay-ms', '500', '--rpc-timeout', '60000', '--slow');
  assert.deepEqual(patient.rpc, { timeoutMs: 60_000, retries: 8, delayMs: 500, batch: false });
});

test('help is recognised; malformed arguments are rejected', () => {
  assert.equal(parseArgs(['--help']), 'help');
  assert.equal(parseArgs(['-h']), 'help');

  const malformed = [
    ['--bogus'],
    ['--chains'],
    ['--chains', '--no-quote'],
    ['--chains', ','],
    ['--concurrency', 'NaN'],
    ['--concurrency', '0'],
    ['--chain-concurrency', '1.5'],
    ['--max-rpcs', '0'],
    ['--retries', '-1'],
    ['--delay-ms', '-5'],
    ['--rpc-timeout', '0'],
  ];
  for (const argv of malformed) assert.throws(() => parseArgs(argv), argv.join(' '));
  assert.throws(() => parseArgs(['--max-rpcs', 'abc']), /--max-rpcs must be an integer >= 1/);
});

// ---------------------------------------------------------------------------
// the CLI end to end (offline: the mock fixtures point at an RPC that is not running)
// ---------------------------------------------------------------------------

test('setup errors exit 2 before any verification', () => {
  const setupErrors = [
    ['--chains', 'typo'], // nothing verifiable selected
    ['--chains', 'solana'], // only a non-EVM chain selected
    ['--concurrency', '0'],
    ['--chains'],
    ['--expected', 'expected.json'], // profile does not match the mock deployment
    ['--app', 'ethena'],
    ['--app', 'usdt0'], // USDT0 scope requires the canary-sponsored deployment
    ['--rerun', '/nonexistent/report.json'],
  ];
  for (const args of setupErrors) {
    const run = runVerifier(args);
    assert.equal(run.status, 2, `${args.join(' ')}\n${run.stdout}${run.stderr}`);
  }
});

test('--rerun rejects reports that are malformed, incompatible, or have nothing left to rerun', (t) => {
  const unusableReports = [
    {},
    { deployment: 'canary-sponsored-mock', chains: [] },
    { deployment: 'some-other-deployment', chains: [{ name: 'ethereum', status: 'FAIL' }] },
    { deployment: 'canary-sponsored-mock', chains: [{ name: 'ethereum', status: 'BOGUS' }] },
    { deployment: 'canary-sponsored-mock', chains: [{ name: 'ethereum', status: 'OK' }] },
    // a skipped non-EVM chain is not a failure this verifier could rerun
    { deployment: 'canary-sponsored-mock', chains: [{ name: 'solana', status: 'SKIPPED' }] },
  ];
  for (const report of unusableReports) {
    const run = runVerifier(['--rerun', tempJson(t, report)]);
    assert.equal(run.status, 2, JSON.stringify(report));
  }
});

test('--rerun verifies only the chains that did not pass', (t) => {
  const report = {
    deployment: 'canary-sponsored-mock',
    chains: [
      { name: 'ethereum', status: 'OK' },
      { name: 'polygon', status: 'ERROR' },
      { name: 'solana', status: 'SKIPPED' },
    ],
  };
  const run = runVerifier(['--rerun', tempJson(t, report), '--retries', '0', '--rpc-timeout', '500']);
  assert.match(run.stdout, /--rerun: 1 chain\(s\) did not pass last time — polygon/);
  assert.match(run.stdout, /verifying 1 EVM chain\(s\)/);
});

test('RPC failures exit 1, and credentials never reach the output', () => {
  const offline = 'globalThis.fetch = async () => { throw new Error("offline https://alice:synthetic-secret@rpc.example.com/?token=query-secret"); };';
  const run = runVerifier(['--chains', 'polygon', '--retries', '0'], ['--import', `data:text/javascript,${encodeURIComponent(offline)}`]);

  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /1 error/);
  assert.match(run.stdout, /rpc\.connect/);
  for (const secret of ['alice', 'synthetic-secret', 'query-secret']) {
    assert.ok(!(run.stdout + run.stderr).includes(secret), secret);
  }
});

test('--help prints usage and exits 0', () => {
  const run = runCli('src/index.ts', ['--help']);
  assert.equal(run.status, 0);
  assert.match(run.stdout, /--rerun <report\.json>/);
});
