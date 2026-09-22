/** The result model shared by verification, scope resolution and reporting. */

export type Severity = 'PASS' | 'FAIL' | 'WARN' | 'ERROR' | 'INFO';

export type ChainStatus = 'OK' | 'FAIL' | 'ERROR' | 'SKIPPED';

/** One check outcome. `expected`/`actual` are display strings, not compared again. */
export interface Finding {
  check: string;
  severity: Severity;
  expected?: string;
  actual?: string;
  detail?: string;
  /** destination chain name, for per-pathway findings */
  dst?: string;
}

/** A pathway's destination: the chain name and its LayerZero endpoint id. */
export interface Destination {
  name: string;
  eid: number;
}

/** What was read for one source -> destination pathway. `null` means "not read". */
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

/** Worker and multisig values as read on-chain, stringified for the JSON report. */
export interface WorkerReport {
  quorum: string;
  signerSize: string;
  priceFeed: string;
  workerFeeLib: string;
  defaultMultiplierBps: number;
  allowlistSize: string;
  paused: boolean | null;
  vid: number | null;
  nativeTokenPriceUSD: string | null;
}

export interface ChainResult {
  name: string;
  eid: number | null;
  address: string;
  status: ChainStatus;
  findings: Finding[];
  pathways: PathwayRow[];
  /** set on SKIPPED chains */
  skipReason?: string;

  // Set only for chains that were actually verified.
  verificationScope?: 'configuration-only' | 'configuration-and-quotes';
  /** snapshot block every contract read was pinned to */
  blockNumber?: string;
  /** the RPC that was used, with credentials redacted */
  rpc?: string;
  explorer?: string | null;
  nativeSymbol?: string;
  worker?: WorkerReport;
}
