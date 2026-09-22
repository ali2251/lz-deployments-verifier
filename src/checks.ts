/**
 * The assertions: on-chain values in, findings out. Nothing here touches the network —
 * verify-chain.ts does the reads and hands the values to these functions.
 */
import { formatUnits, zeroAddress, type Address } from 'viem';
import type { DstExpectation, Expected } from './config.js';
import type { Finding } from './types.js';

/** Worker and multisig state as read from the DVN contract. */
export interface WorkerState {
  quorum: bigint;
  signerSize: bigint;
  priceFeed: Address;
  feeLib: Address;
  defaultMultiplierBps: number;
  allowlistSize: bigint;
  /** null = the read failed, which is reported as its own ERROR finding */
  paused: boolean | null;
  vid: number | null;
  /** null = unavailable; only needed for USD display and the optional USD cap */
  nativePriceUSD: bigint | null;
}

/** Result of reading signers(address) for one expected signer. */
export type SignerStatus = { signer: Address; active: boolean } | { signer: Address; active: null; error: string };

export interface DstConfig {
  gas: bigint;
  multiplierBps: number;
  floorMarginUSD: bigint;
}

function compare(check: string, expected: unknown, actual: unknown, detail?: string): Finding {
  return {
    check,
    severity: String(expected) === String(actual) ? 'PASS' : 'FAIL',
    expected: String(expected),
    actual: String(actual),
    ...(detail ? { detail } : {}),
  };
}

function requireNonZero(check: string, address: Address): Finding {
  return { check, severity: address === zeroAddress ? 'FAIL' : 'PASS', expected: 'non-zero', actual: address };
}

/**
 * The signer set is exactly the expected set when signerSize matches the expected count
 * AND every expected signer is active — no event scan needed.
 */
export function checkMultisig(expected: Expected, worker: WorkerState, signers: SignerStatus[]): Finding[] {
  const expectedCount = expected.signers.length;
  const findings: Finding[] = [
    compare('multisig.quorum', expected.quorum, worker.quorum),
    compare(
      'multisig.signerSize',
      expectedCount,
      worker.signerSize,
      'signerSize == expected count AND every expected signer active => the on-chain set is exactly the expected set',
    ),
  ];

  for (const status of signers) {
    if (status.active === null) {
      findings.push({ check: 'multisig.signer', severity: 'ERROR', actual: status.signer, detail: status.error });
    } else {
      findings.push({
        check: 'multisig.signer',
        severity: status.active ? 'PASS' : 'FAIL',
        expected: `${status.signer} active`,
        actual: status.active ? 'active' : 'NOT a signer',
      });
    }
  }

  if (hasUnexpectedSigners(expected, worker)) {
    const extra = worker.signerSize - BigInt(expectedCount);
    findings.push({
      check: 'multisig.unexpectedSigners',
      severity: 'FAIL',
      expected: `${expectedCount} signers`,
      actual: `${worker.signerSize} on-chain — ${extra} unaccounted-for signer(s)`,
      detail: 'Enumerate them with: --scan-signers (reads UpdateSigner event history)',
    });
  }
  return findings;
}

export function hasUnexpectedSigners(expected: Expected, worker: WorkerState): boolean {
  return worker.signerSize > BigInt(expected.signers.length);
}

export function checkWorker(expected: Expected, worker: WorkerState): Finding[] {
  const want = expected.worker;
  const findings: Finding[] = [];
  if (want.defaultMultiplierBps !== null) {
    findings.push(compare('worker.defaultMultiplierBps', want.defaultMultiplierBps, worker.defaultMultiplierBps));
  }
  if (want.allowlistSize !== null) {
    const detail = 'non-zero means only allowlisted senders may use this DVN';
    findings.push(compare('worker.allowlistSize', want.allowlistSize, worker.allowlistSize, detail));
  }
  if (want.paused !== null && worker.paused !== null) {
    findings.push(compare('worker.paused', want.paused, worker.paused));
  }
  if (want.requirePriceFeedSet) findings.push(requireNonZero('worker.priceFeed', worker.priceFeed));
  if (want.requireFeeLibSet) findings.push(requireNonZero('worker.workerFeeLib', worker.feeLib));
  return findings;
}

/** Quote checks that are required by the policy but cannot run on this chain at all. */
export function checkQuotePrerequisites(expected: Expected, worker: WorkerState): Finding[] {
  const findings: Finding[] = [];
  if (expected.quote.maxUsd !== null && !hasNativePrice(worker)) {
    findings.push({
      check: 'quote.usdPrice',
      severity: 'ERROR',
      detail: 'USD cap cannot be checked: native price is unavailable or zero',
    });
  }
  if (expected.quote.requireFloorNotBinding && worker.feeLib === zeroAddress) {
    findings.push({
      check: 'quote.floorNotBinding',
      severity: 'ERROR',
      detail: 'Required fee-library comparison cannot run: fee library is zero',
    });
  }
  return findings;
}

export function checkDstConfig(want: DstExpectation, config: DstConfig, dst: string): Finding[] {
  const findings: Finding[] = [];
  if (config.gas < want.minGas) {
    findings.push({
      check: 'dstConfig.gas',
      severity: 'FAIL',
      dst,
      expected: `>= ${want.minGas}`,
      actual: config.gas.toString(),
      detail: config.gas === 0n ? 'destination not configured — this pathway will revert on quote' : undefined,
    });
  }
  if (want.floorMarginUSD !== null && config.floorMarginUSD !== want.floorMarginUSD) {
    const sponsored = want.floorMarginUSD === 0n;
    findings.push({
      check: 'dstConfig.floorMarginUSD',
      severity: 'FAIL',
      dst,
      expected: want.floorMarginUSD.toString(),
      actual: config.floorMarginUSD.toString(),
      detail: sponsored ? 'sponsored pathway must charge gas only — a non-zero floor imposes a USD minimum' : undefined,
    });
  }
  if (want.multiplierBps !== null && config.multiplierBps !== want.multiplierBps) {
    findings.push({
      check: 'dstConfig.multiplierBps',
      severity: 'FAIL',
      dst,
      expected: String(want.multiplierBps),
      actual: String(config.multiplierBps),
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// USD arithmetic
// ---------------------------------------------------------------------------

export function hasNativePrice(worker: WorkerState): worker is WorkerState & { nativePriceUSD: bigint } {
  return worker.nativePriceUSD !== null && worker.nativePriceUSD > 0n;
}

/** Approximate USD value of a fee, for display only. `usdDenominator` is a power of ten. */
export function feeToUsd(feeWei: bigint, nativePriceUSD: bigint, nativeDecimals: number, usdDenominator: bigint): number {
  const usdScaled = (feeWei * nativePriceUSD) / 10n ** BigInt(nativeDecimals);
  const usdDecimals = usdDenominator.toString().length - 1;
  return Number(formatUnits(usdScaled, usdDecimals));
}

/** Compare the configured decimal cap without rounding a bigint quote to a JS float. */
export function exceedsUsdCap(
  feeWei: bigint,
  nativePriceUSD: bigint,
  nativeDecimals: number,
  usdDenominator: bigint,
  capUsd: number,
): boolean {
  // Turn the cap (e.g. 1.5 or 1e-8) into an exact fraction capNumerator / capDenominator.
  const [mantissa = '0', exponent = '0'] = capUsd.toString().toLowerCase().split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  let capNumerator = BigInt(`${whole}${fraction}`);
  let capDenominator = 1n;
  const scale = fraction.length - Number(exponent);
  if (scale > 0) capDenominator = 10n ** BigInt(scale);
  else capNumerator *= 10n ** BigInt(-scale);

  // fee / 10^decimals * price / usdDenominator  >  capNumerator / capDenominator
  return feeWei * nativePriceUSD * capDenominator > capNumerator * usdDenominator * 10n ** BigInt(nativeDecimals);
}
