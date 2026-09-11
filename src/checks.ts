import {
  createPublicClient,
  defineChain,
  formatUnits,
  http,
  zeroAddress,
  type Address,
  type PublicClient,
} from 'viem';
import { dvnAbi, dvnFeeLibAbi, priceFeedAbi } from './abi.js';
import { expectationFor, type Expected } from './config.js';
import type { ChainInfo } from './metadata.js';

export type Severity = 'PASS' | 'FAIL' | 'WARN' | 'ERROR' | 'INFO';

export interface Finding {
  check: string;
  severity: Severity;
  expected?: string;
  actual?: string;
  detail?: string;
  /** destination chain name, for per-pathway findings */
  dst?: string;
}

export interface PathwayRow {
  dst: string;
  dstEid: number;
  gas: bigint | null;
  multiplierBps: number | null;
  floorMarginUSD: bigint | null;
  feeWei: bigint | null;
  feeNative: string | null;
  feeUsd: number | null;
  floorBinding: boolean | null;
  error?: string;
}

export interface ChainResult {
  name: string;
  eid: number | null;
  address: string;
  status: 'OK' | 'FAIL' | 'ERROR' | 'SKIPPED';
  rpc?: string;
  explorer?: string | null;
  nativeSymbol?: string;
  findings: Finding[];
  worker?: {
    quorum: string;
    signerSize: string;
    priceFeed: string;
    workerFeeLib: string;
    defaultMultiplierBps: number;
    allowlistSize: string;
    paused: boolean;
    vid: number | null;
    nativeTokenPriceUSD: string | null;
  };
  pathways: PathwayRow[];
  skipReason?: string;
}

export interface RunOptions {
  expected: Expected;
  /** every EVM chain in the deployment, resolved — used as the destination universe */
  universe: Array<{ name: string; eid: number }>;
  quote: boolean;
  concurrency: number;
  rpcTimeoutMs: number;
  /** extra attempts after the first failure, for transport errors only */
  retries: number;
  /** pause before every call, to stay under a provider's rate limit */
  delayMs: number;
  /** batch several eth_calls into one JSON-RPC request — off if the provider rejects them */
  batch: boolean;
  onProgress?: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Strip credentials out of an RPC URL before it reaches the console or report.json.
 * Alchemy/Infura style keys live in a long path segment; others use a query param.
 */
export function redactRpc(url: string): string {
  try {
    const u = new URL(url);
    u.pathname = u.pathname.replace(/\/[A-Za-z0-9_-]{16,}(?=\/|$)/g, '/***');
    for (const key of [...u.searchParams.keys()]) {
      if (/key|token|auth|secret|api/i.test(key)) u.searchParams.set(key, '***');
    }
    return u.toString();
  } catch {
    return url;
  }
}

/** never let an API key reach the console or the report via an error string */
const scrub = (s: string): string => s.replace(/\/v2\/[A-Za-z0-9_-]{12,}/g, '/v2/***');

function short(msg: unknown): string {
  // viem wraps revert data in shortMessage/metaMessages; the useful part (the revert
  // reason or custom error name) is never on the first line of .message
  if (msg && typeof msg === 'object') {
    const e = msg as { shortMessage?: string; metaMessages?: string[]; details?: string; status?: number };
    const reason = e.metaMessages?.[0] ?? e.details;
    const parts = [
      e.shortMessage,
      typeof e.status === 'number' ? `HTTP ${e.status}` : undefined,
      reason,
    ].filter(Boolean) as string[];
    if (parts.length > 0) {
      return scrub([...new Set(parts)].join(' ').replace(/\s+/g, ' ').trim()).slice(0, 240);
    }
  }
  const s = msg instanceof Error ? msg.message : String(msg);
  return scrub(s.split('\n').filter((l) => l.trim()).slice(0, 2).join(' ').replace(/\s+/g, ' ')).slice(0, 240);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Target for the eth_call capability probe when no contract address is to hand. */
const PROBE_ADDRESS: Address = '0x000000000000000000000000000000000000dEaD';

/**
 * A revert is a deterministic answer from the chain — retrying it just wastes a call.
 * Everything else (HTTP status, timeout, socket reset, rate limit) is worth another go.
 */
function isRetryable(err: unknown): boolean {
  const e = err as { name?: string; shortMessage?: string; message?: string } | null;
  if (!e) return false;
  if ((e.name ?? '').includes('ContractFunctionRevertedError')) return false;
  const text = `${e.shortMessage ?? ''} ${e.message ?? ''}`.toLowerCase();
  if (text.includes('reverted') || text.includes('returned no data')) return false;
  return true;
}

/** Retry transport failures with exponential backoff and jitter. */
async function withRetry<T>(fn: () => Promise<T>, retries: number, delayMs: number): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (delayMs > 0) await sleep(delayMs);
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!isRetryable(err) || attempt === retries) throw err;
      // 400ms, 800ms, 1600ms ... capped, plus jitter so parallel chains don't resync
      await sleep(Math.min(8000, 400 * 2 ** attempt) + Math.floor(Math.random() * 250));
    }
  }
  throw last;
}

function cmp(check: string, expected: unknown, actual: unknown, opts?: { warnOnly?: boolean; detail?: string }): Finding {
  const ok = String(expected) === String(actual);
  return {
    check,
    severity: ok ? 'PASS' : opts?.warnOnly ? 'WARN' : 'FAIL',
    expected: String(expected),
    actual: String(actual),
    ...(opts?.detail ? { detail: opts.detail } : {}),
  };
}

/**
 * Connect to the first RPC in the list that answers, reports the expected chain id
 * and will actually serve eth_call.
 *
 * That last part matters: several endpoints in LayerZero's metadata answer eth_chainId
 * and eth_getCode on a free tier but refuse eth_call outright (api.zan.top returns
 * HTTP 429 "Method eth_call is not available for unregistered accounts"). Without the
 * probe such an endpoint wins the race, every contract read fails, and the chain is
 * reported as an error even though four other endpoints in the list would have worked.
 */
async function connect(
  chain: ChainInfo,
  rpcs: string[],
  timeoutMs: number,
  opts: { batch?: boolean; retries?: number; delayMs?: number; probeAddress?: Address } = {},
): Promise<{ client: PublicClient; rpc: string }> {
  const errors: string[] = [];
  for (const url of rpcs) {
    try {
      const definition = defineChain({
        id: chain.nativeChainId ?? 1,
        name: chain.name,
        nativeCurrency: { name: chain.nativeCurrency.symbol, symbol: chain.nativeCurrency.symbol, decimals: chain.nativeCurrency.decimals },
        rpcUrls: { default: { http: [url] } },
      });
      const client = createPublicClient({
        chain: definition,
        transport: http(url, {
          timeout: timeoutMs,
          // retries are owned by withRetry, so --retries N means exactly N extra
          // attempts rather than N multiplied by viem's own internal retry count
          retryCount: 0,
          // JSON-RPC batching is a common source of 4xx/5xx from providers that either
          // cap batch size or reject arrays outright — --no-batch sends one call per request
          batch: opts.batch === false ? false : { wait: 16 },
        }),
      }) as PublicClient;

      // a rate-limited provider often rejects the very first probe; without retrying
      // here the whole chain would be dropped before a single check runs
      const id = await withRetry(() => client.getChainId(), opts.retries ?? 0, opts.delayMs ?? 0);
      if (chain.nativeChainId !== null && Number(id) !== chain.nativeChainId) {
        errors.push(`${redactRpc(url)}: reports chainId ${id}, expected ${chain.nativeChainId}`);
        continue;
      }

      // An empty eth_call against the contract tells us the method is served. The result
      // itself is irrelevant — a contract whose fallback reverts is a perfectly good
      // answer, and isRetryable() is what separates "the chain answered" from "the
      // provider refused". Only the latter disqualifies the endpoint.
      try {
        await withRetry(
          () => client.call({ to: opts.probeAddress ?? PROBE_ADDRESS, data: '0x' }),
          Math.min(opts.retries ?? 0, 1),
          opts.delayMs ?? 0,
        );
      } catch (err) {
        if (isRetryable(err)) {
          errors.push(`${redactRpc(url)}: answers eth_chainId but not eth_call — ${short(err)}`);
          continue;
        }
      }

      return { client, rpc: url };
    } catch (err) {
      errors.push(`${redactRpc(url)}: ${short(err)}`);
    }
  }
  throw new Error(`no usable RPC (${rpcs.length} tried)\n  ${errors.slice(0, 4).join('\n  ')}`);
}

// ---------------------------------------------------------------------------
// per-chain verification
// ---------------------------------------------------------------------------

export async function verifyChain(
  chain: ChainInfo,
  address: Address,
  rpcs: string[],
  opts: RunOptions,
): Promise<ChainResult> {
  const { expected } = opts;
  const result: ChainResult = {
    name: chain.name,
    eid: chain.eid,
    address,
    status: 'OK',
    explorer: chain.explorer,
    nativeSymbol: chain.nativeCurrency.symbol,
    findings: [],
    pathways: [],
  };

  let client: PublicClient;
  try {
    const conn = await connect(chain, rpcs, opts.rpcTimeoutMs, {
      batch: opts.batch,
      retries: opts.retries,
      delayMs: opts.delayMs,
      probeAddress: address,
    });
    client = conn.client;
    result.rpc = redactRpc(conn.rpc);
  } catch (err) {
    result.status = 'ERROR';
    result.findings.push({ check: 'rpc.connect', severity: 'ERROR', detail: short(err) });
    return result;
  }

  const callEarly = <T>(fn: () => Promise<T>): Promise<T> => withRetry(fn, opts.retries, opts.delayMs);

  // --- contract exists ---
  try {
    const code = await callEarly(() => client.getCode({ address }));
    if (!code || code === '0x') {
      result.status = 'FAIL';
      result.findings.push({
        check: 'contract.deployed',
        severity: 'FAIL',
        expected: 'bytecode present',
        actual: 'no code at address',
      });
      return result;
    }
    result.findings.push({ check: 'contract.deployed', severity: 'PASS', actual: `${(code.length - 2) / 2} bytes` });
  } catch (err) {
    result.status = 'ERROR';
    result.findings.push({ check: 'contract.deployed', severity: 'ERROR', detail: short(err) });
    return result;
  }

  /** every on-chain read goes through here, so retry/throttle applies uniformly */
  const call = <T>(fn: () => Promise<T>): Promise<T> => withRetry(fn, opts.retries, opts.delayMs);

  const read = <T>(functionName: string, args: readonly unknown[] = []) =>
    call(
      () =>
        client.readContract({
          address,
          abi: dvnAbi,
          functionName: functionName as any,
          args: args as any,
        }) as Promise<T>,
    );

  // --- worker / multisig state ---
  let quorum = 0n;
  let signerSize = 0n;
  let priceFeed: Address = zeroAddress;
  let feeLib: Address = zeroAddress;
  let defaultMultiplierBps = 0;
  let allowlistSize = 0n;
  let paused = false;
  let vid: number | null = null;

  try {
    const [q, ss, pf, fl, dm, als] = await Promise.all([
      read<bigint>('quorum'),
      read<bigint>('signerSize'),
      read<Address>('priceFeed'),
      read<Address>('workerFeeLib'),
      read<number>('defaultMultiplierBps'),
      read<bigint>('allowlistSize'),
    ]);
    quorum = q;
    signerSize = ss;
    priceFeed = pf;
    feeLib = fl;
    defaultMultiplierBps = Number(dm);
    allowlistSize = als;
  } catch (err) {
    result.status = 'ERROR';
    const detail = short(err);
    // getCode already succeeded, so the contract is there and the RPC answers single
    // calls — a failure here is the first multi-call, which usually means the provider
    // is throttling or refusing JSON-RPC batches rather than the ABI being wrong
    const transport = /http|timeout|socket|fetch|429|batch|limit/i.test(detail);
    result.findings.push({
      check: 'worker.read',
      severity: 'ERROR',
      detail: transport
        ? `${detail} — transport failure, not an ABI mismatch (getCode succeeded on this RPC). Retry with --no-batch, or --slow to throttle.`
        : `core reads failed — is this a LayerZero V2 DVN? ${detail}`,
    });
    return result;
  }

  paused = await read<boolean>('paused').catch(() => false);
  vid = await read<number>('vid').then(Number).catch(() => null);

  // --- signers ---
  result.findings.push(cmp('multisig.quorum', expected.quorum, quorum));
  result.findings.push(
    cmp('multisig.signerSize', expected.signers.length, signerSize, {
      detail: 'signerSize == expected count AND every expected signer active => the on-chain set is exactly the expected set',
    }),
  );

  const active = await pool(expected.signers, 4, async (signer) => {
    try {
      return { signer, active: await read<boolean>('signers', [signer]) };
    } catch (err) {
      return { signer, active: null, error: short(err) };
    }
  });
  for (const a of active) {
    if (a.active === null) {
      result.findings.push({ check: 'multisig.signer', severity: 'ERROR', actual: a.signer, detail: (a as any).error });
    } else {
      result.findings.push({
        check: 'multisig.signer',
        severity: a.active ? 'PASS' : 'FAIL',
        expected: `${a.signer} active`,
        actual: a.active ? 'active' : 'NOT a signer',
      });
    }
  }
  if (signerSize > BigInt(expected.signers.length)) {
    result.findings.push({
      check: 'multisig.unexpectedSigners',
      severity: 'FAIL',
      expected: `${expected.signers.length} signers`,
      actual: `${signerSize} on-chain — ${signerSize - BigInt(expected.signers.length)} unaccounted-for signer(s)`,
      detail: 'Enumerate them with: --scan-signers (reads UpdateSigner event history)',
    });
  }

  // --- worker config ---
  if (expected.worker.defaultMultiplierBps !== null) {
    result.findings.push(cmp('worker.defaultMultiplierBps', expected.worker.defaultMultiplierBps, defaultMultiplierBps));
  }
  if (expected.worker.allowlistSize !== null) {
    result.findings.push(
      cmp('worker.allowlistSize', expected.worker.allowlistSize, allowlistSize, {
        detail: 'non-zero means only allowlisted senders may use this DVN',
      }),
    );
  }
  if (expected.worker.paused !== null) result.findings.push(cmp('worker.paused', expected.worker.paused, paused));
  if (expected.worker.requirePriceFeedSet) {
    result.findings.push({
      check: 'worker.priceFeed',
      severity: priceFeed === zeroAddress ? 'FAIL' : 'PASS',
      expected: 'non-zero',
      actual: priceFeed,
    });
  }
  if (expected.worker.requireFeeLibSet) {
    result.findings.push({
      check: 'worker.workerFeeLib',
      severity: feeLib === zeroAddress ? 'FAIL' : 'PASS',
      expected: 'non-zero',
      actual: feeLib,
    });
  }

  // --- native token price, for USD conversion of quotes ---
  let nativePriceUSD: bigint | null = null;
  if (priceFeed !== zeroAddress) {
    nativePriceUSD = await call(() =>
      client.readContract({ address: priceFeed, abi: priceFeedAbi, functionName: 'nativeTokenPriceUSD' }),
    )
      .then((v) => v as bigint)
      .catch(() => null);
  }

  result.worker = {
    quorum: quorum.toString(),
    signerSize: signerSize.toString(),
    priceFeed,
    workerFeeLib: feeLib,
    defaultMultiplierBps,
    allowlistSize: allowlistSize.toString(),
    paused,
    vid,
    nativeTokenPriceUSD: nativePriceUSD === null ? null : nativePriceUSD.toString(),
  };

  const toUsd = (wei: bigint): number | null => {
    if (nativePriceUSD === null || nativePriceUSD === 0n) return null;
    const decimals = chain.nativeCurrency.decimals;
    const usdScaled = (wei * nativePriceUSD) / 10n ** BigInt(decimals);
    return Number(formatUnits(usdScaled, Number(bigintLog10(expected.usdDenominator))));
  };

  // --- destination configs ---
  const destinations = opts.universe.filter((d) => d.name !== chain.name);

  result.pathways = await pool(destinations, opts.concurrency, async (dst) => {
    const row: PathwayRow = {
      dst: dst.name,
      dstEid: dst.eid,
      gas: null,
      multiplierBps: null,
      floorMarginUSD: null,
      feeWei: null,
      feeNative: null,
      feeUsd: null,
      floorBinding: null,
    };
    const want = expectationFor(expected, chain.name, dst.name);

    try {
      const cfg = (await read<readonly [bigint, number, bigint]>('dstConfig', [dst.eid])) as unknown as

        | readonly [bigint, number, bigint]
        | { gas: bigint; multiplierBps: number; floorMarginUSD: bigint };
      const gas = Array.isArray(cfg) ? (cfg[0] as bigint) : (cfg as any).gas;
      const mult = Number(Array.isArray(cfg) ? cfg[1] : (cfg as any).multiplierBps);
      const floor = Array.isArray(cfg) ? (cfg[2] as bigint) : (cfg as any).floorMarginUSD;
      row.gas = gas;
      row.multiplierBps = mult;
      row.floorMarginUSD = floor;

      if (gas < want.minGas) {
        result.findings.push({
          check: 'dstConfig.gas',
          severity: 'FAIL',
          dst: dst.name,
          expected: `>= ${want.minGas}`,
          actual: gas.toString(),
          detail: gas === 0n ? 'destination not configured — this pathway will revert on quote' : undefined,
        });
      }
      if (want.floorMarginUSD !== null && floor !== want.floorMarginUSD) {
        result.findings.push({
          check: 'dstConfig.floorMarginUSD',
          severity: 'FAIL',
          dst: dst.name,
          expected: want.floorMarginUSD.toString(),
          actual: floor.toString(),
          detail:
            want.floorMarginUSD === 0n
              ? 'sponsored pathway must charge gas only — a non-zero floor imposes a USD minimum'
              : undefined,
        });
      }
      if (want.multiplierBps !== null && mult !== want.multiplierBps) {
        result.findings.push({
          check: 'dstConfig.multiplierBps',
          severity: 'FAIL',
          dst: dst.name,
          expected: String(want.multiplierBps),
          actual: String(mult),
        });
      }
    } catch (err) {
      row.error = short(err);
      result.findings.push({ check: 'dstConfig.read', severity: 'ERROR', dst: dst.name, detail: row.error });
      return row;
    }

    // --- live quote ---
    if (!opts.quote || row.gas === 0n) return row;

    try {
      const fee = await call(() =>
        client.readContract({
          address,
          abi: dvnAbi,
          functionName: 'getFee',
          args: [dst.eid, expected.quote.confirmations, expected.quote.sender, expected.quote.options],
        }),
      );
      row.feeWei = fee as bigint;
      row.feeNative = formatUnits(row.feeWei, chain.nativeCurrency.decimals);
      row.feeUsd = toUsd(row.feeWei);

      if (expected.quote.maxUsd !== null && row.feeUsd !== null && row.feeUsd > expected.quote.maxUsd) {
        result.findings.push({
          check: 'quote.maxUsd',
          severity: 'FAIL',
          dst: dst.name,
          expected: `<= $${expected.quote.maxUsd}`,
          actual: `$${row.feeUsd.toFixed(4)}`,
        });
      }
    } catch (err) {
      result.findings.push({
        check: 'quote.getFee',
        severity: 'FAIL',
        dst: dst.name,
        detail: `getFee reverted: ${short(err)}`,
      });
      return row;
    }

    // --- is the USD floor binding? quote the fee lib again with floorMarginUSD forced to 0 ---
    if (expected.quote.requireFloorNotBinding && feeLib !== zeroAddress && row.feeWei !== null) {
      try {
        const params = {
          priceFeed,
          dstEid: dst.eid,
          confirmations: expected.quote.confirmations,
          sender: expected.quote.sender,
          quorum,
          defaultMultiplierBps,
        };
        const zeroFloor = await call(() =>
          client.readContract({
            address: feeLib,
            abi: dvnFeeLibAbi,
            functionName: 'getFee',
            args: [
              params,
              { gas: row.gas!, multiplierBps: row.multiplierBps!, floorMarginUSD: 0n },
              expected.quote.options,
            ],
          }),
        );
        row.floorBinding = (zeroFloor as bigint) !== row.feeWei;
        if (row.floorBinding) {
          result.findings.push({
            check: 'quote.floorNotBinding',
            severity: 'FAIL',
            dst: dst.name,
            expected: `gas-only ${formatUnits(zeroFloor as bigint, chain.nativeCurrency.decimals)}`,
            actual: `charged ${row.feeNative}`,
            detail: 'a USD floor is raising this pathway above the gas-only price',
          });
        }
      } catch {
        // fee lib shape differs across DVN contract versions — informational only
        row.floorBinding = null;
      }
    }

    return row;
  });

  if (result.findings.some((f) => f.severity === 'FAIL')) result.status = 'FAIL';
  else if (result.findings.some((f) => f.severity === 'ERROR')) result.status = 'ERROR';
  return result;
}

/**
 * Enumerate the actual signer set by replaying UpdateSigner events.
 * Only needed when signerSize disagrees with the expected list — the normal
 * check (size + membership) already proves set equality without any log scan.
 * Many public RPCs cap getLogs ranges, so this is best-effort and chunks down.
 */
export async function scanSigners(
  client: PublicClient,
  address: Address,
  opts: { fromBlock?: bigint; chunk?: bigint } = {},
): Promise<{ signers: Address[]; scannedFrom: bigint; scannedTo: bigint } | { error: string }> {
  const event = dvnAbi.find((x) => x.type === 'event' && x.name === 'UpdateSigner') as any;
  try {
    const latest = await client.getBlockNumber();
    const from = opts.fromBlock ?? 0n;

    const collect = async (a: bigint, b: bigint) =>
      client.getLogs({ address, event, fromBlock: a, toBlock: b });

    let logs: any[];
    try {
      logs = await collect(from, latest);
    } catch {
      const chunk = opts.chunk ?? 50_000n;
      logs = [];
      for (let a = from; a <= latest; a += chunk) {
        const b = a + chunk - 1n > latest ? latest : a + chunk - 1n;
        logs.push(...(await collect(a, b)));
      }
    }

    const state = new Map<string, boolean>();
    for (const log of logs) {
      const signer = String(log.args?._signer ?? '').toLowerCase();
      if (signer) state.set(signer, Boolean(log.args?._active));
    }
    return {
      signers: [...state.entries()].filter(([, on]) => on).map(([s]) => s as Address),
      scannedFrom: from,
      scannedTo: latest,
    };
  } catch (err) {
    return { error: short(err) };
  }
}

export { connect as connectToChain };

function bigintLog10(v: bigint): bigint {
  let n = 0n;
  let x = v;
  while (x >= 10n) {
    x /= 10n;
    n++;
  }
  return n;
}
