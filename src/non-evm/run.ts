/**
 * What the collectors share: access to the run directory and an evidence-saving JSON-RPC client.
 *
 * A collector is a child process of index.ts. It receives the run through the environment,
 * reads the inputs index.ts prepared, saves every raw RPC response as evidence, and writes
 * its ChainSnapshot to <chain>-final.json. It never decides pass/fail — policy.ts does.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fromRoot } from '../paths.js';
import type { Destination } from '../types.js';
import type { ChainSnapshot, Source } from './policy.js';

export const toJson = (value: unknown): string =>
  JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item), 2);

/** The Solana/Stellar SDKs live in their own install (runtime/non-evm), not in the root package. */
const sdkRequire = createRequire(fromRoot('runtime/non-evm/package.json'));
export const loadSdk = (id: string): any => sdkRequire(id);

// ---------------------------------------------------------------------------
// run directory
// ---------------------------------------------------------------------------

export interface Run {
  runId: string;
  /** Write <name>.json into the run directory. */
  save(name: string, value: unknown): void;
  /** Read <name>.json, one of the inputs prepared by index.ts. */
  input(name: string): any;
  /** Every chain in scope; a collector quotes all of them except itself. */
  destinations(source: Source): Destination[];
  /** Start this chain's snapshot. */
  snapshot(address: string): Pick<ChainSnapshot, 'runId' | 'checkedAt' | 'address'>;
}

export function openRun(): Run {
  const dir = process.env.NON_EVM_RUN_DIR;
  const runId = process.env.NON_EVM_RUN_ID;
  if (!dir || !runId) throw new Error('Use npm run verify:usdt0:non-evm');

  const input = (name: string) => JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8'));
  return {
    runId,
    input,
    save: (name, value) => writeFileSync(join(dir, `${name}.json`), toJson(value)),
    destinations: (source) => (input('scope').chains as Destination[]).filter((chain) => chain.name !== source),
    snapshot: (address) => ({ runId, checkedAt: new Date().toISOString(), address }),
  };
}

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------

export interface RetryPolicy {
  attempts: number;
  timeoutMs: number;
  /** wait before every request, to stay under a public endpoint's rate limit */
  paceMs: number;
  /** extra wait after the n-th failure */
  backoffMs: (failures: number) => number;
}

/** Calls `method` and saves the raw response as <evidenceName>.json. */
export type JsonRpc = (evidenceName: string, method: string, params: unknown) => Promise<any>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createJsonRpc(run: Run, url: string, retry: RetryPolicy): JsonRpc {
  const request = async (evidenceName: string, method: string, params: unknown) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(retry.timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 100)}`);

    const body = JSON.parse(text);
    run.save(evidenceName, body);
    if (body.error) throw new Error(JSON.stringify(body.error));
    return body.result;
  };

  return async (evidenceName, method, params) => {
    let failures = 0;
    for (;;) {
      if (retry.paceMs > 0) await sleep(retry.paceMs);
      try {
        return await request(evidenceName, method, params);
      } catch (err) {
        if (++failures >= retry.attempts) throw err;
        await sleep(retry.backoffMs(failures));
      }
    }
  };
}
