/** The USDT0 verification scope, shared by the EVM and non-EVM verifiers. */
import { chainKey } from './chain-names.js';

/**
 * Chains the application lists but that are deliberately not verified, with the reason.
 * They are reported as skipped, never as passed. The coverage command keeps the full list.
 */
export const USDT0_EXCLUSIONS: Readonly<Record<string, string>> = Object.freeze({
  ton: 'User-requested exclusion; not verified',
  corn: 'Historical CSV entry excluded from the established USDT0 audit scope; not verified',
});

/** Deployment keys of every chain USDT0 requires, minus the exclusions. Unknown chains are kept. */
export function usdt0VerificationChains(products: Record<string, string[]>): string[] {
  const required = new Set(Object.values(products).flat().map(chainKey));
  return [...required].filter((name) => !Object.hasOwn(USDT0_EXCLUSIONS, name));
}
