/** Numbers shared by the console, Markdown and JSON reports. */
import type { ChainResult, Finding } from '../types.js';

export interface Totals {
  chains: number;
  ok: number;
  fail: number;
  error: number;
  skipped: number;
  pathways: number;
  pathwaysConfigured: number;
  failFindings: number;
}

export interface PathwayStats {
  total: number;
  /** destinations with gas > 0 */
  configured: number;
  /** destinations with a non-zero USD floor */
  nonZeroFloor: number;
  /** quoted fees in USD, ascending */
  feesUsd: number[];
}

export function pathwayStats(result: ChainResult): PathwayStats {
  const { pathways } = result;
  return {
    total: pathways.length,
    configured: pathways.filter((p) => p.gas !== null && p.gas > 0n).length,
    nonZeroFloor: pathways.filter((p) => p.floorMarginUSD !== null && p.floorMarginUSD > 0n).length,
    feesUsd: pathways
      .map((p) => p.feeUsd)
      .filter((fee) => fee !== null)
      .sort((a, b) => a - b),
  };
}

/** Upper median of an ascending list. */
export const median = (sorted: number[]): number | null => sorted[Math.floor(sorted.length / 2)] ?? null;

export const usd = (value: number | null): string => (value === null ? '-' : `$${value.toFixed(4)}`);

export function totals(results: ChainResult[]): Totals {
  const count = (status: ChainResult['status']) => results.filter((r) => r.status === status).length;
  const sum = (value: (r: ChainResult) => number) => results.reduce((total, r) => total + value(r), 0);
  return {
    chains: results.length,
    ok: count('OK'),
    fail: count('FAIL'),
    error: count('ERROR'),
    skipped: count('SKIPPED'),
    pathways: sum((r) => r.pathways.length),
    pathwaysConfigured: sum((r) => pathwayStats(r).configured),
    failFindings: sum((r) => r.findings.filter((f) => f.severity === 'FAIL').length),
  };
}

/** Anything that did not pass is worth showing. */
export const isNotable = (finding: Finding): boolean => finding.severity !== 'PASS';

export const isConfigOnly = (result: ChainResult): boolean => result.verificationScope === 'configuration-only';

export const byName = (results: ChainResult[]): ChainResult[] =>
  [...results].sort((a, b) => a.name.localeCompare(b.name));
