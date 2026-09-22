/** Shared test fixtures: temp files, CLI runs, and an in-process fake DVN behind globalThis.fetch. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decodeFunctionData, encodeFunctionResult, type Abi } from 'viem';
import { dvnAbi, dvnFeeLibAbi, priceFeedAbi } from '../src/abi.js';
import type { Expected } from '../src/config.js';
import { resolveChain } from '../src/metadata.js';
import type { RpcOptions } from '../src/rpc.js';
import type { SourceChain, VerifyPlan } from '../src/verify-chain.js';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const fromRoot = (path: string): string => join(ROOT, path);
export const readJson = (path: string): any => JSON.parse(readFileSync(fromRoot(path), 'utf8'));

export const MOCK_METADATA = readJson('test/mock-metadata.json');

// ---------------------------------------------------------------------------
// temp files and CLI runs
// ---------------------------------------------------------------------------

/** Writes `value` to a JSON file that is removed when the test ends. */
export function tempJson(t: TestContext, value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'canary-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'file.json');
  writeFileSync(path, JSON.stringify(value));
  return path;
}

/** Runs a CLI entry point from the repository root. `nodeArgs` go before the script. */
export function runCli(script: string, args: string[], nodeArgs: string[] = []) {
  return spawnSync(process.execPath, ['--import', 'tsx', ...nodeArgs, script, ...args], { cwd: ROOT, encoding: 'utf8' });
}

/** EVM CLI flags that keep a run offline and on the mock fixtures. */
export const MOCK_CLI_ARGS = [
  '--no-chainlist',
  '--metadata-file', 'test/mock-metadata.json',
  '--rpc-overrides', 'test/no-overrides.json',
  '--deployment', 'test/mock-deployment.json',
  '--expected', 'test/mock-expected.json',
  '--json', 'none',
  '--md', 'none',
];

// ---------------------------------------------------------------------------
// verifyChain inputs
// ---------------------------------------------------------------------------

export const DVN_ADDRESS = '0xf9d2c0915cac4c75b7ae359089333c8ac258e12c';
export const PRICE_FEED = '0x0000000000000000000000000000000000000f33';
export const FEE_LIB = '0x000000000000000000000000000000000000fe1b';

export const NO_RETRY: RpcOptions = { timeoutMs: 1000, retries: 0, delayMs: 0, batch: false };

/** Ethereum from the mock metadata, pointed at a URL only the fake fetch answers. */
export function ethereumSource(address: string = DVN_ADDRESS): SourceChain {
  return { info: resolveChain(MOCK_METADATA, 'ethereum')!, address: address as SourceChain['address'], rpcs: ['http://mock.invalid'] };
}

/** A sequential ethereum -> arbitrum plan. */
export function planFor(expected: Expected, overrides: Partial<VerifyPlan> = {}): VerifyPlan {
  return {
    expected,
    destinations: [{ name: 'arbitrum', eid: 30110 }],
    quote: true,
    scanSigners: false,
    concurrency: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// fake DVN
// ---------------------------------------------------------------------------

export interface FakeDvn {
  /** view function name -> return value; change these between runs */
  values: Record<string, unknown>;
  /** what the fee library's getFee returns; defaults to the DVN's own quote (floor not binding) */
  zeroFloorFee?: bigint;
  /** eth_getCode result */
  code: string;
  /** functions that fail, by name ("feeLib" = every fee library call) -> JSON-RPC error message */
  failing: Record<string, string>;
  /** every eth_call that was served */
  calls: Array<{ to: string; functionName: string; args: readonly unknown[]; block: string }>;
  /** the most requests that were in flight at the same time */
  maxConcurrentRequests: number;
}

export const REVERT = 'execution reverted: fixture failure';

const CONTRACT_ABI: Abi = [...dvnAbi, ...priceFeedAbi];

/**
 * Replaces globalThis.fetch with a JSON-RPC endpoint for chain id 1, block 0x10, that serves
 * a healthy sponsored DVN: one signer, quorum 1, open allowlist, zero floor, fee of 1 wei.
 */
export function installFakeDvn(t: TestContext): FakeDvn {
  const dvn: FakeDvn = {
    values: {
      quorum: 1n,
      signerSize: 1n,
      signers: true,
      paused: false,
      vid: 101,
      priceFeed: PRICE_FEED,
      workerFeeLib: FEE_LIB,
      defaultMultiplierBps: 12000,
      allowlistSize: 0n,
      nativeTokenPriceUSD: 10n ** 20n, // $1
      dstConfig: [77000n, 12000, 0n],
      getFee: 1n,
    },
    code: '0x60806040',
    failing: {},
    calls: [],
    maxConcurrentRequests: 0,
  };

  const ethCall = (id: number, [{ to, data }, block]: [{ to: string; data?: string }, string]) => {
    // real RPCs on Astar/Fuse/Peaq reject an empty call to a contract without a fallback
    if (!data || data === '0x') return { jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error' } };

    const isFeeLib = to.toLowerCase() === FEE_LIB;
    const abi = isFeeLib ? dvnFeeLibAbi : CONTRACT_ABI;
    const { functionName, args = [] } = decodeFunctionData({ abi, data: data as `0x${string}` });
    dvn.calls.push({ to: to.toLowerCase(), functionName, args, block });

    const failure = dvn.failing[isFeeLib ? 'feeLib' : functionName];
    if (failure) return { jsonrpc: '2.0', id, error: { code: -32000, message: failure } };
    const result = isFeeLib ? (dvn.zeroFloorFee ?? dvn.values.getFee) : dvn.values[functionName];
    return { jsonrpc: '2.0', id, result: encodeFunctionResult({ abi, functionName, result } as any) };
  };

  const respond = (request: { id: number; method: string; params: any }) => {
    switch (request.method) {
      case 'eth_chainId': return { jsonrpc: '2.0', id: request.id, result: '0x1' };
      case 'eth_blockNumber': return { jsonrpc: '2.0', id: request.id, result: '0x10' };
      case 'eth_getCode': return { jsonrpc: '2.0', id: request.id, result: dvn.code };
      case 'eth_call': return ethCall(request.id, request.params);
      default: return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `unsupported: ${request.method}` } };
    }
  };

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let inFlight = 0;
  globalThis.fetch = async (_url, init) => {
    inFlight++;
    dvn.maxConcurrentRequests = Math.max(dvn.maxConcurrentRequests, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 2)); // long enough for parallel reads to overlap
    inFlight--;

    const request = JSON.parse(String(init?.body));
    const body = Array.isArray(request) ? request.map(respond) : respond(request);
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  };
  return dvn;
}
