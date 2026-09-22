/** Maps chain labels as applications write them ("BNB Chain") to LayerZero deployment keys ("bsc"). */

// Unknown names keep their own normalised key and are reported missing, never dropped.
const ALIASES: Record<string, string> = {
  'arbitrum one': 'arbitrum',
  'bnb chain': 'bsc',
  bnb: 'bsc',
  berachain: 'bera',
  'conflux espace': 'conflux',
  hyperevm: 'hyperliquid',
  'polygon pos': 'polygon',
  plume: 'plumephoenix',
  linea: 'zkconsensys',
  'xrp ledger': 'xrpl',
};

export function chainKey(name: string): string {
  const normalized = name.trim().toLowerCase().replace(/\s+/g, ' ');
  return ALIASES[normalized] ?? normalized;
}
