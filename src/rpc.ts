/** RPC transport: picking a usable endpoint, retrying reads, and keeping API keys out of output. */
import { createPublicClient, defineChain, encodeFunctionData, http, type Address, type PublicClient } from 'viem';
import { dvnAbi } from './abi.js';
import type { ChainInfo } from './metadata.js';

export interface RpcOptions {
  /** per-request timeout */
  timeoutMs: number;
  /** extra attempts after the first failure, for transport errors only */
  retries: number;
  /** pause before every call, to stay under a provider's rate limit */
  delayMs: number;
  /** batch several eth_calls into one JSON-RPC request — off if the provider rejects them */
  batch: boolean;
}

export interface Connection {
  client: PublicClient;
  /** the endpoint that was chosen, unredacted */
  rpc: string;
}

/** Wraps a read so that retry and throttling apply to it. */
export type Caller = <T>(read: () => Promise<T>) => Promise<T>;

// ---------------------------------------------------------------------------
// redaction
// ---------------------------------------------------------------------------

/**
 * Strip credentials out of an RPC URL before it reaches the console or report.json.
 * Alchemy/Infura style keys live in a long path segment; others use a query param.
 */
export function redactRpc(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username) parsed.username = '***';
    if (parsed.password) parsed.password = '***';
    parsed.pathname = parsed.pathname.replace(/\/[A-Za-z0-9_-]{16,}(?=\/|$)/g, '/***');
    for (const key of [...parsed.searchParams.keys()]) {
      if (/key|token|auth|secret|api/i.test(key)) parsed.searchParams.set(key, '***');
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

/** Never let an API key reach the console or the report via an error string. */
function scrub(text: string): string {
  return text
    .replace(/https?:\/\/[^\s<>"']+/gi, (url) => redactRpc(url))
    .replace(/\/v2\/[A-Za-z0-9_-]{12,}/g, '/v2/***');
}

const MAX_ERROR_LENGTH = 240;

/** A short, single-line, credential-free description of a thrown error. */
export function describeError(err: unknown): string {
  const oneLine = (text: string) => scrub(text.replace(/\s+/g, ' ').trim()).slice(0, MAX_ERROR_LENGTH);

  // viem wraps revert data in shortMessage/metaMessages; the useful part (the revert
  // reason or custom error name) is never on the first line of .message
  if (err && typeof err === 'object') {
    const e = err as { shortMessage?: string; metaMessages?: string[]; details?: string; status?: number };
    const httpStatus = typeof e.status === 'number' ? `HTTP ${e.status}` : undefined;
    const reason = e.metaMessages?.[0] ?? e.details;
    const parts = [e.shortMessage, httpStatus, reason].filter((part): part is string => Boolean(part));
    if (parts.length > 0) return oneLine([...new Set(parts)].join(' '));
  }

  const message = err instanceof Error ? err.message : String(err);
  const firstTwoLines = message.split('\n').filter((line) => line.trim()).slice(0, 2);
  return oneLine(firstTwoLines.join(' '));
}

// ---------------------------------------------------------------------------
// retry
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A revert is a deterministic answer from the chain — retrying it just wastes a call.
 * Everything else (HTTP status, timeout, socket reset, rate limit) is worth another go.
 */
export function isRetryable(err: unknown): boolean {
  const e = err as { name?: string; shortMessage?: string; message?: string } | null;
  if (!e) return false;
  if ((e.name ?? '').includes('ContractFunctionRevertedError')) return false;
  const text = `${e.shortMessage ?? ''} ${e.message ?? ''}`.toLowerCase();
  return !text.includes('reverted') && !text.includes('returned no data');
}

/** Retry transport failures with exponential backoff and jitter. */
async function withRetry<T>(read: () => Promise<T>, retries: number, delayMs: number): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    if (delayMs > 0) await sleep(delayMs);
    try {
      return await read();
    } catch (err) {
      if (!isRetryable(err) || attempt >= retries) throw err;
      // 400ms, 800ms, 1600ms ... capped, plus jitter so parallel chains don't resync
      await sleep(Math.min(8000, 400 * 2 ** attempt) + Math.floor(Math.random() * 250));
    }
  }
}

/**
 * Every on-chain read goes through a Caller, so retry/throttle applies uniformly.
 * A `serial` caller also runs one read at a time, even for reads started together.
 */
export function createCaller(options: RpcOptions, serial: boolean): Caller {
  let queue: Promise<unknown> = Promise.resolve();
  return <T>(read: () => Promise<T>): Promise<T> => {
    const attempt = () => withRetry(read, options.retries, options.delayMs);
    if (!serial) return attempt();
    const result = queue.then(attempt);
    queue = result.catch(() => undefined);
    return result;
  };
}

// ---------------------------------------------------------------------------
// connecting
// ---------------------------------------------------------------------------

function createClient(chain: ChainInfo, chainId: number, url: string, options: RpcOptions): PublicClient {
  const { symbol, decimals } = chain.nativeCurrency;
  return createPublicClient({
    chain: defineChain({
      id: chainId,
      name: chain.name,
      nativeCurrency: { name: symbol, symbol, decimals },
      rpcUrls: { default: { http: [url] } },
    }),
    transport: http(url, {
      timeout: options.timeoutMs,
      // retries are owned by withRetry, so --retries N means exactly N extra
      // attempts rather than N multiplied by viem's own internal retry count
      retryCount: 0,
      // JSON-RPC batching is a common source of 4xx/5xx from providers that either
      // cap batch size or reject arrays outright — --no-batch sends one call per request
      batch: options.batch ? { wait: 16 } : false,
    }),
  }) as PublicClient;
}

/** Why this endpoint cannot be used, or null if it can. */
async function endpointProblem(client: PublicClient, chainId: number, dvn: Address, options: RpcOptions): Promise<string | null> {
  // a rate-limited provider often rejects the very first request; without retrying
  // here the whole chain would be dropped before a single check runs
  const reported = await withRetry(() => client.getChainId(), options.retries, options.delayMs);
  if (reported !== chainId) return `reports chainId ${reported}, expected ${chainId}`;

  // Probe a real view function rather than an empty call: some RPCs return an internal
  // error for an empty call to a contract without a fallback even though ordinary
  // contract reads work. A revert still proves that eth_call is served.
  try {
    const data = encodeFunctionData({ abi: dvnAbi, functionName: 'quorum' });
    await withRetry(() => client.call({ to: dvn, data }), Math.min(options.retries, 1), options.delayMs);
  } catch (err) {
    if (isRetryable(err)) return `answers eth_chainId but not eth_call — ${describeError(err)}`;
  }
  return null;
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
export async function connect(chain: ChainInfo, rpcs: string[], dvn: Address, options: RpcOptions): Promise<Connection> {
  const chainId = chain.nativeChainId;
  if (chainId === null || !Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error('Cannot verify RPC network: missing or invalid native chain ID');
  }
  const { decimals } = chain.nativeCurrency;
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error('Invalid native currency decimals');
  }

  const errors: string[] = [];
  for (const url of rpcs) {
    try {
      const client = createClient(chain, chainId, url, options);
      const problem = await endpointProblem(client, chainId, dvn, options);
      if (problem === null) return { client, rpc: url };
      errors.push(`${redactRpc(url)}: ${problem}`);
    } catch (err) {
      errors.push(`${redactRpc(url)}: ${describeError(err)}`);
    }
  }
  throw new Error(`no usable RPC (${rpcs.length} tried)\n  ${errors.slice(0, 4).join('\n  ')}`);
}
