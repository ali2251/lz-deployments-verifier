/**
 * Verifies one source chain: connect, pin a snapshot block, read the DVN's state and
 * every destination config, take the sample quotes, and turn it all into findings.
 * The assertions themselves live in checks.ts; this file owns the reads.
 */
import { formatUnits, getAbiItem, zeroAddress, type Address, type PublicClient } from 'viem';
import { dvnAbi, dvnFeeLibAbi, priceFeedAbi } from './abi.js';
import {
  checkDstConfig,
  checkMultisig,
  checkQuotePrerequisites,
  checkWorker,
  exceedsUsdCap,
  feeToUsd,
  hasNativePrice,
  hasUnexpectedSigners,
  type DstConfig,
  type SignerStatus,
  type WorkerState,
} from './checks.js';
import { expectationFor, type Expected } from './config.js';
import type { ChainInfo } from './metadata.js';
import { pool } from './pool.js';
import { connect, createCaller, describeError, isRetryable, redactRpc, type Caller, type RpcOptions } from './rpc.js';
import type { ChainResult, Destination, Finding, PathwayRow } from './types.js';

/** An EVM chain this run can verify. */
export interface SourceChain {
  info: ChainInfo;
  /** the DVN contract */
  address: Address;
  /** endpoints to try, in order */
  rpcs: string[];
}

export interface VerifyPlan {
  expected: Expected;
  /** every chain the DVN must be configured for; the source itself is left out automatically */
  destinations: Destination[];
  /** take live getFee() quotes (also requires expected.quote.enabled) */
  quote: boolean;
  /** on a signer-count mismatch, replay UpdateSigner logs to name the active signers */
  scanSigners: boolean;
  /** destinations checked in parallel; 1 also serializes every other read */
  concurrency: number;
}

/** Everything needed to read the DVN at one fixed block. */
interface Session {
  client: PublicClient;
  call: Caller;
  /** spread into readContract() to address the DVN at the snapshot block */
  dvn: { address: Address; abi: typeof dvnAbi; blockNumber: bigint };
}

/** Shared inputs of the per-pathway checks. */
interface PathwayContext {
  session: Session;
  chain: ChainInfo;
  expected: Expected;
  worker: WorkerState;
  quoteEnabled: boolean;
}

const errorFinding = (check: string, err: unknown): Finding => ({ check, severity: 'ERROR', detail: describeError(err) });

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

/** Returns the bytecode size, or 0 when nothing is deployed at the address. */
async function readCodeSize({ client, call, dvn }: Session): Promise<number> {
  const code = await call(() => client.getCode({ address: dvn.address, blockNumber: dvn.blockNumber }));
  return code && code !== '0x' ? (code.length - 2) / 2 : 0;
}

/** Reads that every later check depends on. Throws if any of them fails. */
async function readCoreState({ client, call, dvn }: Session) {
  const [quorum, signerSize, priceFeed, feeLib, defaultMultiplierBps, allowlistSize] = await Promise.all([
    call(() => client.readContract({ ...dvn, functionName: 'quorum' })),
    call(() => client.readContract({ ...dvn, functionName: 'signerSize' })),
    call(() => client.readContract({ ...dvn, functionName: 'priceFeed' })),
    call(() => client.readContract({ ...dvn, functionName: 'workerFeeLib' })),
    call(() => client.readContract({ ...dvn, functionName: 'defaultMultiplierBps' })),
    call(() => client.readContract({ ...dvn, functionName: 'allowlistSize' })),
  ]);
  return { quorum, signerSize, priceFeed, feeLib, defaultMultiplierBps, allowlistSize };
}

/** The native token price is only used for USD display and the optional cap, so a failure is not an error here. */
async function readNativePrice({ client, call, dvn }: Session, priceFeed: Address): Promise<bigint | null> {
  if (priceFeed === zeroAddress) return null;
  try {
    return await call(() =>
      client.readContract({
        address: priceFeed,
        blockNumber: dvn.blockNumber,
        abi: priceFeedAbi,
        functionName: 'nativeTokenPriceUSD',
      }),
    );
  } catch {
    return null;
  }
}

function readSignerStatuses({ client, call, dvn }: Session, signers: Address[]): Promise<SignerStatus[]> {
  return pool(signers, 4, async (signer): Promise<SignerStatus> => {
    try {
      const active = await call(() => client.readContract({ ...dvn, functionName: 'signers', args: [signer] }));
      return { signer, active };
    } catch (err) {
      return { signer, active: null, error: describeError(err) };
    }
  });
}

async function readDstConfig({ client, call, dvn }: Session, dstEid: number): Promise<DstConfig> {
  const [gas, multiplierBps, floorMarginUSD] = await call(() =>
    client.readContract({ ...dvn, functionName: 'dstConfig', args: [dstEid] }),
  );
  return { gas, multiplierBps, floorMarginUSD };
}

function quoteDvnFee({ client, call, dvn }: Session, dstEid: number, quote: Expected['quote']): Promise<bigint> {
  return call(() =>
    client.readContract({
      ...dvn,
      functionName: 'getFee',
      args: [dstEid, quote.confirmations, quote.sender, quote.options],
    }),
  );
}

/** What the fee library would charge for this pathway if its USD floor were zero. */
function quoteZeroFloorFee(ctx: PathwayContext, dstEid: number, config: DstConfig): Promise<bigint> {
  const { client, call, dvn } = ctx.session;
  const { quote } = ctx.expected;
  const params = {
    priceFeed: ctx.worker.priceFeed,
    dstEid,
    confirmations: quote.confirmations,
    sender: quote.sender,
    quorum: ctx.worker.quorum,
    defaultMultiplierBps: ctx.worker.defaultMultiplierBps,
  };
  return call(() =>
    client.readContract({
      address: ctx.worker.feeLib,
      blockNumber: dvn.blockNumber,
      abi: dvnFeeLibAbi,
      functionName: 'getFee',
      args: [params, { ...config, floorMarginUSD: 0n }, quote.options],
    }),
  );
}

// ---------------------------------------------------------------------------
// worker
// ---------------------------------------------------------------------------

/** getCode already succeeded by now, so explain what a failure of the first contract reads usually means. */
function describeCoreReadFailure(err: unknown): string {
  const detail = describeError(err);
  // the contract is there and the RPC answers single calls — a transport-looking failure
  // on the first multi-call usually means the provider is throttling or refusing batches
  const looksLikeTransport = /http|timeout|socket|fetch|429|batch|limit/i.test(detail);
  return looksLikeTransport
    ? `${detail} — transport failure, not an ABI mismatch (getCode succeeded on this RPC). Retry with --no-batch, or --slow to throttle.`
    : `core reads failed — is this a LayerZero V2 DVN? ${detail}`;
}

/** Reads the worker state. `paused` and `vid` may fail individually; those failures come back as findings. */
async function readWorker(session: Session): Promise<{ worker: WorkerState; findings: Finding[] }> {
  const { client, call, dvn } = session;
  const core = await readCoreState(session);
  const findings: Finding[] = [];

  let paused: boolean | null = null;
  try {
    paused = await call(() => client.readContract({ ...dvn, functionName: 'paused' }));
  } catch (err) {
    findings.push(errorFinding('worker.paused', err));
  }

  let vid: number | null = null;
  try {
    vid = await call(() => client.readContract({ ...dvn, functionName: 'vid' }));
  } catch (err) {
    findings.push(errorFinding('worker.vid', err));
  }

  return { worker: { ...core, paused, vid, nativePriceUSD: null }, findings };
}

function toWorkerReport(worker: WorkerState): ChainResult['worker'] {
  return {
    quorum: worker.quorum.toString(),
    signerSize: worker.signerSize.toString(),
    priceFeed: worker.priceFeed,
    workerFeeLib: worker.feeLib,
    defaultMultiplierBps: worker.defaultMultiplierBps,
    allowlistSize: worker.allowlistSize.toString(),
    paused: worker.paused,
    vid: worker.vid,
    nativeTokenPriceUSD: worker.nativePriceUSD?.toString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// pathways
// ---------------------------------------------------------------------------

/** Takes the sample quote for a configured pathway and runs the quote checks. Fills in the row's fee fields. */
async function verifyQuote(ctx: PathwayContext, dst: Destination, config: DstConfig, row: PathwayRow): Promise<Finding[]> {
  const { chain, expected, worker } = ctx;
  const { decimals } = chain.nativeCurrency;
  const findings: Finding[] = [];

  let fee: bigint;
  try {
    fee = await quoteDvnFee(ctx.session, dst.eid, expected.quote);
  } catch (err) {
    row.error = describeError(err);
    // a revert is the contract's answer (FAIL); anything else means we could not ask (ERROR)
    const severity = isRetryable(err) ? 'ERROR' : 'FAIL';
    return [{ check: 'quote.getFee', severity, dst: dst.name, detail: `getFee failed: ${row.error}` }];
  }
  row.feeWei = fee;
  row.feeNative = formatUnits(fee, decimals);
  row.feeUsd = hasNativePrice(worker) ? feeToUsd(fee, worker.nativePriceUSD, decimals, expected.usdDenominator) : null;

  const { maxUsd } = expected.quote;
  const overCap =
    maxUsd !== null &&
    hasNativePrice(worker) &&
    exceedsUsdCap(fee, worker.nativePriceUSD, decimals, expected.usdDenominator, maxUsd);
  if (overCap) {
    findings.push({
      check: 'quote.maxUsd',
      severity: 'FAIL',
      dst: dst.name,
      expected: `<= $${maxUsd}`,
      actual: `$${row.feeUsd?.toString() ?? 'unavailable'}`,
    });
  }

  // Is the USD floor binding? Quote the fee lib again with floorMarginUSD forced to 0.
  if (expected.quote.requireFloorNotBinding && worker.feeLib !== zeroAddress) {
    try {
      const zeroFloorFee = await quoteZeroFloorFee(ctx, dst.eid, config);
      row.floorBinding = zeroFloorFee !== fee;
      if (row.floorBinding) {
        findings.push({
          check: 'quote.floorNotBinding',
          severity: 'FAIL',
          dst: dst.name,
          expected: `gas-only ${formatUnits(zeroFloorFee, decimals)}`,
          actual: `charged ${row.feeNative}`,
          detail: 'a USD floor is raising this pathway above the gas-only price',
        });
      }
    } catch (err) {
      findings.push({
        check: 'quote.floorNotBinding',
        severity: 'ERROR',
        dst: dst.name,
        detail: `Required comparison failed: ${describeError(err)}`,
      });
    }
  }
  return findings;
}

async function verifyPathway(ctx: PathwayContext, dst: Destination): Promise<{ row: PathwayRow; findings: Finding[] }> {
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

  let config: DstConfig;
  try {
    config = await readDstConfig(ctx.session, dst.eid);
  } catch (err) {
    row.error = describeError(err);
    return { row, findings: [{ check: 'dstConfig.read', severity: 'ERROR', dst: dst.name, detail: row.error }] };
  }
  row.gas = config.gas;
  row.multiplierBps = config.multiplierBps;
  row.floorMarginUSD = config.floorMarginUSD;

  const want = expectationFor(ctx.expected, ctx.chain.name, dst.name);
  const findings = checkDstConfig(want, config, dst.name);

  // an unconfigured destination (gas 0) reverts on quote, and is already a finding
  if (ctx.quoteEnabled && config.gas !== 0n) {
    findings.push(...(await verifyQuote(ctx, dst, config, row)));
  }
  return { row, findings };
}

// ---------------------------------------------------------------------------
// signer scan
// ---------------------------------------------------------------------------

/**
 * Enumerate the actual signer set by replaying UpdateSigner events.
 * Only needed when signerSize disagrees with the expected list — the normal
 * check (size + membership) already proves set equality without any log scan.
 * Many public RPCs cap getLogs ranges, so this is best-effort and chunks down.
 */
async function scanSigners(client: PublicClient, address: Address): Promise<Finding> {
  const CHUNK = 50_000n;
  const event = getAbiItem({ abi: dvnAbi, name: 'UpdateSigner' });
  try {
    const latest = await client.getBlockNumber();
    const getLogs = (fromBlock: bigint, toBlock: bigint) => client.getLogs({ address, event, fromBlock, toBlock });

    let logs: Awaited<ReturnType<typeof getLogs>>;
    try {
      logs = await getLogs(0n, latest);
    } catch {
      logs = [];
      for (let from = 0n; from <= latest; from += CHUNK) {
        const to = from + CHUNK - 1n > latest ? latest : from + CHUNK - 1n;
        logs.push(...(await getLogs(from, to)));
      }
    }

    // later events override earlier ones for the same signer
    const active = new Map<string, boolean>();
    for (const { args } of logs) {
      if (args._signer) active.set(args._signer.toLowerCase(), Boolean(args._active));
    }
    const signers = [...active].filter(([, isActive]) => isActive).map(([signer]) => signer);
    return {
      check: 'multisig.scan',
      severity: 'INFO',
      actual: signers.join(', '),
      detail: `active signers from UpdateSigner logs, blocks 0-${latest}`,
    };
  } catch (err) {
    return { check: 'multisig.scan', severity: 'WARN', detail: `log scan failed: ${describeError(err)}` };
  }
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

function overallStatus(findings: Finding[]): ChainResult['status'] {
  if (findings.some((f) => f.severity === 'FAIL')) return 'FAIL';
  if (findings.some((f) => f.severity === 'ERROR')) return 'ERROR';
  return 'OK';
}

export async function verifyChain(source: SourceChain, plan: VerifyPlan, rpcOptions: RpcOptions): Promise<ChainResult> {
  const { info: chain, address } = source;
  const { expected } = plan;
  const quoteEnabled = plan.quote && expected.quote.enabled;

  const result: ChainResult = {
    verificationScope: quoteEnabled ? 'configuration-and-quotes' : 'configuration-only',
    name: chain.name,
    eid: chain.eid,
    address,
    status: 'OK',
    explorer: chain.explorer,
    nativeSymbol: chain.nativeCurrency.symbol,
    findings: [],
    pathways: [],
  };
  /** Ends verification early: nothing after this step can be checked. */
  const stop = (finding: Finding): ChainResult => {
    result.findings.push(finding);
    result.status = finding.severity === 'FAIL' ? 'FAIL' : 'ERROR';
    return result;
  };

  // --- connect, and pin every later read to one block ---
  let client: PublicClient;
  try {
    const connection = await connect(chain, source.rpcs, address, rpcOptions);
    client = connection.client;
    result.rpc = redactRpc(connection.rpc);
  } catch (err) {
    return stop(errorFinding('rpc.connect', err));
  }

  const call = createCaller(rpcOptions, plan.concurrency === 1);
  let blockNumber: bigint;
  try {
    blockNumber = await call(() => client.getBlockNumber({ cacheTime: 0 }));
    result.blockNumber = blockNumber.toString();
  } catch (err) {
    return stop(errorFinding('rpc.snapshot', err));
  }
  const session: Session = { client, call, dvn: { address, abi: dvnAbi, blockNumber } };

  // --- contract exists ---
  try {
    const codeSize = await readCodeSize(session);
    if (codeSize === 0) {
      return stop({ check: 'contract.deployed', severity: 'FAIL', expected: 'bytecode present', actual: 'no code at address' });
    }
    result.findings.push({ check: 'contract.deployed', severity: 'PASS', actual: `${codeSize} bytes` });
  } catch (err) {
    return stop(errorFinding('contract.deployed', err));
  }

  // --- worker and multisig ---
  let worker: WorkerState;
  try {
    const read = await readWorker(session);
    worker = read.worker;
    result.findings.push(...read.findings);
  } catch (err) {
    return stop({ check: 'worker.read', severity: 'ERROR', detail: describeCoreReadFailure(err) });
  }
  const signerStatuses = await readSignerStatuses(session, expected.signers);
  worker.nativePriceUSD = await readNativePrice(session, worker.priceFeed);
  result.worker = toWorkerReport(worker);

  result.findings.push(...checkMultisig(expected, worker, signerStatuses));
  result.findings.push(...checkWorker(expected, worker));
  if (quoteEnabled) result.findings.push(...checkQuotePrerequisites(expected, worker));

  // --- every destination: config, then a live quote ---
  const context: PathwayContext = { session, chain, expected, worker, quoteEnabled };
  const destinations = plan.destinations.filter((dst) => dst.name !== chain.name);
  const pathways = await pool(destinations, plan.concurrency, (dst) => verifyPathway(context, dst));
  result.pathways = pathways.map((pathway) => pathway.row);
  result.findings.push(...pathways.flatMap((pathway) => pathway.findings));

  result.status = overallStatus(result.findings);

  if (plan.scanSigners && hasUnexpectedSigners(expected, worker)) {
    result.findings.push(await scanSigners(client, address));
  }
  return result;
}
