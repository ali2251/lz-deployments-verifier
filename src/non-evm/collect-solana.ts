/**
 * Solana collector. The DVN's whole configuration lives in one account (the DvnConfig PDA),
 * which is decoded here; fees are quoted by simulating the program's quote_dvn instruction.
 */
import { createHash } from 'node:crypto';
import { secp256k1SignerAddress } from '../signers.js';
import type { Destination } from '../types.js';
import type { ChainSnapshot, PathwaySnapshot } from './policy.js';
import { createJsonRpc, loadSdk, openRun } from './run.js';

const { PublicKey, Transaction, TransactionInstruction } = loadSdk('@solana/web3.js');

const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
const MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const RETRY = { attempts: 4, timeoutMs: 20_000, paceMs: 0, backoffMs: (failures: number) => 1000 * failures };
const FINALIZED = { encoding: 'base64', commitment: 'finalized' };

/** Anchor prefixes accounts and instructions with the first 8 bytes of sha256("<namespace>:<name>"). */
const anchorDiscriminator = (name: string): Buffer => createHash('sha256').update(name).digest().subarray(0, 8);

const run = openRun();
const rpc = createJsonRpc(run, SOLANA_RPC, RETRY);
const configAddress: string = run.input('deployment').config.contractAddresses.solana;

// ---------------------------------------------------------------------------
// DvnConfig account
// ---------------------------------------------------------------------------

interface DvnConfig {
  vid: number;
  bump: number;
  /** raw 64-byte secp256k1 public keys, 0x-prefixed */
  signers: string[];
  quorum: number;
  allowlist: string[];
  denylist: string[];
  paused: boolean;
  msglibs: string[];
  admins: string[];
  priceFeed: string;
  dstConfigs: Array<{ eid: number; gas: number; multiplierBps: number | null; floorMarginUSD: bigint | null }>;
  defaultMultiplierBps: number;
}

/** Sequential reader for Borsh-encoded account data (little-endian, length-prefixed vectors). */
class BorshReader {
  private offset = 0;
  constructor(private readonly data: Buffer) {}

  bytes = (length: number): Buffer => {
    if (this.offset + length > this.data.length) throw new Error('Truncated account');
    const slice = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  };
  u8 = (): number => this.bytes(1)[0]!;
  u16 = (): number => this.bytes(2).readUInt16LE();
  u32 = (): number => this.bytes(4).readUInt32LE();
  u128 = (): bigint => {
    const value = this.bytes(16);
    return value.readBigUInt64LE() + (value.readBigUInt64LE(8) << 64n);
  };
  bool = (): boolean => {
    const flag = this.u8();
    if (flag > 1) throw new Error('Invalid boolean');
    return flag === 1;
  };
  pubkey = (): string => new PublicKey(this.bytes(32)).toBase58();
  vec = <T>(item: () => T): T[] => {
    const length = this.u32();
    if (length > 1000) throw new Error('Oversized vector');
    return Array.from({ length }, item);
  };
  option = <T>(item: () => T): T | null => (this.bool() ? item() : null);
}

/** Field order follows the on-chain DvnConfig struct. */
function decodeDvnConfig(data: Buffer): DvnConfig {
  const reader = new BorshReader(data);
  if (!reader.bytes(8).equals(anchorDiscriminator('account:DvnConfig'))) throw new Error('Wrong account discriminator');
  return {
    vid: reader.u32(),
    bump: reader.u8(),
    signers: reader.vec(() => '0x' + reader.bytes(64).toString('hex')),
    quorum: reader.u8(),
    allowlist: reader.vec(reader.pubkey),
    denylist: reader.vec(reader.pubkey),
    paused: reader.bool(),
    msglibs: reader.vec(reader.pubkey),
    admins: reader.vec(reader.pubkey),
    priceFeed: reader.pubkey(),
    dstConfigs: reader.vec(() => ({
      eid: reader.u32(),
      gas: reader.u32(),
      multiplierBps: reader.option(reader.u16),
      floorMarginUSD: reader.option(reader.u128),
    })),
    defaultMultiplierBps: reader.u16(),
  };
}

// ---------------------------------------------------------------------------
// fee quote
// ---------------------------------------------------------------------------

interface QuoteAccounts {
  programId: string;
  priceFeedProgram: string;
}

const u32le = (value: number): Buffer => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
};

/** Simulates quote_dvn for one destination and returns the fee in lamports. */
async function quoteFee(config: DvnConfig, accounts: QuoteAccounts, dstEid: number): Promise<string> {
  const sender = config.admins[0]!;
  const PACKET_HEADER_LENGTH = 81;
  // quote_dvn(msglib, dst_eid, sender, packet_header: bytes, payload_hash: [u8; 32], confirmations: u64, options: bytes)
  const data = Buffer.concat([
    anchorDiscriminator('global:quote_dvn'),
    new PublicKey(config.msglibs[0]!).toBuffer(),
    u32le(dstEid),
    new PublicKey(sender).toBuffer(),
    u32le(PACKET_HEADER_LENGTH),
    Buffer.alloc(PACKET_HEADER_LENGTH),
    Buffer.alloc(32), // payload hash
    Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]), // confirmations = 1
    u32le(0), // no options
  ]);
  const readonly = (address: string) => ({ pubkey: new PublicKey(address), isSigner: false, isWritable: false });
  const instruction = new TransactionInstruction({
    programId: new PublicKey(accounts.programId),
    keys: [configAddress, accounts.priceFeedProgram, config.priceFeed].map(readonly),
    data,
  });
  // never signed or sent: the blockhash is a placeholder that simulation replaces
  const transaction = new Transaction({ feePayer: new PublicKey(sender), recentBlockhash: '11111111111111111111111111111111' });
  transaction.add(instruction);
  const serialized = transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');

  const simulation = await rpc(`solana-quote-${dstEid}`, 'simulateTransaction', [
    serialized,
    { ...FINALIZED, sigVerify: false, replaceRecentBlockhash: true },
  ]);
  const { err, logs, returnData } = simulation.value;
  if (err) throw new Error(`${JSON.stringify(err)} ${logs.find((line: string) => line.includes('Error Code:'))}`);
  if (returnData?.programId !== accounts.programId) throw new Error('Unexpected return program');
  const fee = Buffer.from(returnData.data[0], 'base64');
  if (fee.length !== 8) throw new Error('Unexpected return bytes');
  return fee.readBigUInt64LE().toString();
}

async function readPathway(config: DvnConfig, accounts: QuoteAccounts, dst: Destination): Promise<PathwaySnapshot> {
  const pathway: PathwaySnapshot = { dst: dst.name, eid: dst.eid, configStatus: 'MISSING' };
  const dstConfig = config.dstConfigs.find((entry) => entry.eid === dst.eid);
  if (dstConfig) {
    pathway.gas = dstConfig.gas;
    pathway.floorMarginUSD = String(dstConfig.floorMarginUSD ?? 0);
    pathway.multiplierBps = dstConfig.multiplierBps ?? config.defaultMultiplierBps;
    pathway.configStatus = dstConfig.gas > 0 && pathway.floorMarginUSD === '0' ? 'PASS' : 'FAIL';
  }
  try {
    pathway.feeRaw = await quoteFee(config, accounts, dst.eid);
    pathway.quoteStatus = 'PASS';
  } catch (err: any) {
    pathway.quoteStatus = 'FAIL';
    pathway.error = err.message;
  }
  return pathway;
}

// ---------------------------------------------------------------------------
// collect
// ---------------------------------------------------------------------------

// --- network and deployment ---
const genesisHash = await rpc('solana-network', 'getGenesisHash', []);
if (genesisHash !== MAINNET_GENESIS_HASH) throw new Error('Wrong Solana network');

const account = (await rpc('solana-account', 'getAccountInfo', [configAddress, FINALIZED])).value;
if (!account || account.executable) throw new Error('Missing/invalid Solana config account');
const programId: string = account.owner;

const config = decodeDvnConfig(Buffer.from(account.data[0], 'base64'));
const [pda, bump] = PublicKey.findProgramAddressSync([Buffer.from('DvnConfig')], new PublicKey(programId));
if (pda.toBase58() !== configAddress || bump !== config.bump) throw new Error('Config PDA mismatch');

const signerAddresses = config.signers.map(secp256k1SignerAddress);
run.save('solana-decoded', { ...config, signerAddresses });
console.log('Solana live signers:', signerAddresses.join(', '));

// --- dependencies ---
const priceFeed = (await rpc('solana-pricefeed', 'getAccountInfo', [config.priceFeed, FINALIZED])).value;
if (!priceFeed) throw new Error('Missing Solana price feed');
const program = (await rpc('solana-program', 'getAccountInfo', [programId, FINALIZED])).value;
if (!program?.executable) throw new Error('Solana program not executable');
if (!config.msglibs.length) throw new Error('Missing Solana message library');

const snapshot: ChainSnapshot = {
  ...run.snapshot(configAddress),
  signerAddresses,
  signerPublicKeys: config.signers,
  quorum: config.quorum,
  paused: config.paused,
  allowlistSize: config.allowlist.length,
  defaultMultiplierBps: config.defaultMultiplierBps,
  pathways: [],
  checks: { network: true, deployed: true, feeDependencies: true },
};

// --- destinations: saved after each one, so an interrupted run leaves its evidence behind ---
const quoteAccounts = { programId, priceFeedProgram: priceFeed.owner };
for (const dst of run.destinations('solana')) {
  const pathway = await readPathway(config, quoteAccounts, dst);
  snapshot.pathways.push(pathway);
  run.save('solana-final', snapshot);
  console.log('solana ->', dst.name, pathway.configStatus, pathway.quoteStatus);
}

snapshot.completedAt = new Date().toISOString();
run.save('solana-final', snapshot);
