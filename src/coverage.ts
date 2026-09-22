/**
 * Inventory coverage: which chains an application requires, and whether the local
 * deployment JSON lists a DVN address for each. Nothing here is checked on-chain.
 */
import { chainKey } from './chain-names.js';
import type { Deployment } from './config.js';

export type Tier = 'sponsored' | 'subsidized';

/** One application's entry in applications/requirements.json. */
export interface ApplicationRequirements {
  /** the tier the application uses, or 'either' to compare against both */
  tier: Tier | 'either';
  /** where the chain list came from */
  source: string;
  /** product name -> chain labels as the application writes them */
  products: Record<string, string[]>;
}

export interface CoverageRow {
  /** the chain label as the application writes it */
  chain: string;
  /** the deployment key it maps to */
  key: string;
  /** products that require this chain */
  products: string[];
  address: string | null;
  status: 'LISTED' | 'MISSING';
  /** informational only: an entry in the other tier does not satisfy this one */
  otherTierAddress: string | null;
}

/** deployment key -> address, leaving out blank and all-zero addresses */
function listedAddresses(deployment: Deployment): Map<string, string> {
  const listed = new Map<string, string>();
  for (const [name, address] of Object.entries(deployment.contractAddresses)) {
    const trimmed = typeof address === 'string' ? address.trim() : '';
    if (trimmed !== '' && !/^0x0+$/i.test(trimmed)) listed.set(chainKey(name), trimmed);
  }
  return listed;
}

/** A required chain: its label as the application writes it, and the products that need it. */
type Requirement = Pick<CoverageRow, 'chain' | 'products'>;

/** Required chains by deployment key. */
function requiredChains(requirements: ApplicationRequirements, product?: string): Map<string, Requirement> {
  const required = new Map<string, Requirement>();
  for (const [productName, chains] of Object.entries(requirements.products)) {
    if (product && productName !== product) continue;
    for (const chain of chains) {
      const key = chainKey(chain);
      if (!key) throw new Error(`Empty chain requirement in ${productName}`);
      const entry = required.get(key) ?? { chain, products: [] };
      if (!entry.products.includes(productName)) entry.products.push(productName);
      required.set(key, entry);
    }
  }
  return required;
}

export function coverage(
  requirements: ApplicationRequirements,
  tier: Tier,
  deployments: Record<Tier, Deployment>,
  product?: string,
): CoverageRow[] {
  if (requirements.tier !== 'either' && requirements.tier !== tier) {
    throw new Error(`Application requires ${requirements.tier}, not ${tier}`);
  }
  if (product && !Object.hasOwn(requirements.products, product)) {
    throw new Error(`Unknown product: ${product}. Choose ${Object.keys(requirements.products).join(', ')}`);
  }
  const required = requiredChains(requirements, product);
  if (required.size === 0) throw new Error('Application has no required chains');

  const selectedTier = listedAddresses(deployments[tier]);
  const otherTier = listedAddresses(deployments[tier === 'sponsored' ? 'subsidized' : 'sponsored']);

  const rows = [...required].map(([key, { chain, products }]): CoverageRow => ({
    chain,
    key,
    products,
    address: selectedTier.get(key) ?? null,
    status: selectedTier.has(key) ? 'LISTED' : 'MISSING',
    otherTierAddress: otherTier.get(key) ?? null,
  }));
  return rows.sort((a, b) => a.chain.localeCompare(b.chain));
}
