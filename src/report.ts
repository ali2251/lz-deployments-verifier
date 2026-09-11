import type { ChainResult, Finding, Severity } from './checks.js';
import type { Expected } from './config.js';

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  grey: '\x1b[90m',
};
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string, s: string) => (useColor ? `${code}${s}${C.reset}` : s);

const STATUS_MARK: Record<ChainResult['status'], string> = {
  OK: c(C.green, 'PASS'),
  FAIL: c(C.red, 'FAIL'),
  ERROR: c(C.yellow, 'ERR '),
  SKIPPED: c(C.grey, 'SKIP'),
};

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

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

export function totals(results: ChainResult[]): Totals {
  const t: Totals = {
    chains: results.length,
    ok: 0,
    fail: 0,
    error: 0,
    skipped: 0,
    pathways: 0,
    pathwaysConfigured: 0,
    failFindings: 0,
  };
  for (const r of results) {
    if (r.status === 'OK') t.ok++;
    else if (r.status === 'FAIL') t.fail++;
    else if (r.status === 'ERROR') t.error++;
    else t.skipped++;
    t.pathways += r.pathways.length;
    t.pathwaysConfigured += r.pathways.filter((p) => p.gas !== null && p.gas > 0n).length;
    t.failFindings += r.findings.filter((f) => f.severity === 'FAIL').length;
  }
  return t;
}

const isNotable = (f: Finding): boolean => f.severity !== 'PASS';

function mark(s: Severity): string {
  if (s === 'FAIL') return c(C.red, 'FAIL');
  if (s === 'ERROR') return c(C.yellow, 'ERR ');
  if (s === 'WARN') return c(C.yellow, 'WARN');
  return c(C.dim, 'INFO');
}

function describe(f: Finding): string {
  const parts = [f.check];
  if (f.dst) parts.push(`-> ${f.dst}`);
  let line = pad(parts.join(' '), 40);
  if (f.expected !== undefined) line += ` expected=${f.expected}`;
  if (f.actual !== undefined) line += ` actual=${f.actual}`;
  if (f.detail) line += `\n        ${c(C.dim, f.detail)}`;
  return line;
}

/** Per-chain detail: what was actually read and which checks passed. `-v` / `-vv`. */
function printVerboseChain(r: ChainResult, expected: Expected, level: number): void {
  console.log('');
  console.log(`  ${c(C.cyan, r.name)} ${c(C.dim, `eid ${r.eid ?? '?'}  ${r.address}`)}`);

  if (r.status === 'SKIPPED') {
    console.log(`    ${c(C.dim, r.skipReason ?? 'skipped')}`);
    return;
  }
  if (r.rpc) console.log(`    ${pad('rpc', 18)} ${c(C.dim, r.rpc)}`);

  const w = r.worker;
  if (w) {
    const priceUsd =
      w.nativeTokenPriceUSD === null
        ? null
        : Number(BigInt(w.nativeTokenPriceUSD) / (expected.usdDenominator / 10000n)) / 10000;
    console.log(`    ${pad('quorum', 18)} ${w.quorum} of ${w.signerSize} signer(s)`);
    console.log(`    ${pad('priceFeed', 18)} ${w.priceFeed}${priceUsd === null ? '' : c(C.dim, `  native ≈ $${priceUsd.toFixed(2)}`)}`);
    console.log(`    ${pad('workerFeeLib', 18)} ${w.workerFeeLib}`);
    console.log(
      `    ${pad('worker', 18)} ${w.defaultMultiplierBps} bps default · allowlist ${w.allowlistSize}` +
        `${w.allowlistSize === '0' ? c(C.dim, ' (open)') : c(C.red, ' (GATED)')} · paused ${w.paused}` +
        `${w.vid === null ? '' : ` · vid ${w.vid}`}`,
    );
  }

  // every check that ran, grouped by name so 49 identical pathway passes read as one line
  const groups = new Map<string, Finding[]>();
  for (const f of r.findings) {
    const g = groups.get(f.check) ?? [];
    g.push(f);
    groups.set(f.check, g);
  }
  console.log(`    ${c(C.dim, 'checks')}`);
  for (const [check, fs] of groups) {
    const passed = fs.filter((f) => f.severity === 'PASS').length;
    const failed = fs.filter((f) => f.severity === 'FAIL').length;
    const other = fs.length - passed - failed;
    const verdict =
      failed > 0 ? c(C.red, `${failed} FAIL`) : other > 0 && passed === 0 ? c(C.yellow, `${other} skipped`) : c(C.green, 'ok');
    const detail =
      fs.length > 1
        ? c(C.dim, ` (${passed}/${fs.length} passed)`)
        : fs[0]?.severity === 'PASS' && fs[0]?.actual
          ? c(C.dim, ` ${fs[0].actual}`)
          : '';
    console.log(`      ${pad(check, 30)} ${verdict}${detail}`);
    // in verbose mode, say exactly why anything that didn't pass didn't pass
    for (const f of fs.filter((x) => x.severity !== 'PASS')) {
      const why = [
        f.dst ? `-> ${f.dst}` : '',
        f.expected !== undefined ? `expected=${f.expected}` : '',
        f.actual !== undefined ? `actual=${f.actual}` : '',
      ]
        .filter(Boolean)
        .join(' ');
      if (why) console.log(`        ${c(C.dim, why)}`);
      if (f.detail) for (const line of f.detail.split('\n')) console.log(`        ${c(C.dim, line.trim())}`);
    }
  }

  const configured = r.pathways.filter((p) => p.gas !== null && p.gas > 0n);
  const fees = configured.map((p) => p.feeUsd).filter((v): v is number => v !== null).sort((a, b) => a - b);
  if (fees.length > 0) {
    console.log(
      `    ${pad('fees', 18)} min $${fees[0]!.toFixed(4)} · median $${fees[Math.floor(fees.length / 2)]!.toFixed(4)} · max $${fees[fees.length - 1]!.toFixed(4)}` +
        c(C.dim, `  across ${fees.length} pathway(s)`),
    );
  }

  if (level >= 2 && r.pathways.length > 0) {
    console.log(`    ${c(C.dim, 'pathways')}`);
    console.log(
      `      ${c(C.dim, `${pad('destination', 16)} ${pad('eid', 7)} ${pad('gas', 10)} ${pad('multBps', 8)} ${pad('floorUSD', 22)} ${pad('fee', 18)} ${pad('usd', 10)}`)}`,
    );
    for (const p of [...r.pathways].sort((a, b) => a.dst.localeCompare(b.dst))) {
      const floor = p.floorMarginUSD === null ? '-' : p.floorMarginUSD.toString();
      const floorCell = pad(floor, 22);
      console.log(
        `      ${pad(p.dst, 16)} ${pad(String(p.dstEid), 7)} ${pad(p.gas === null ? '-' : p.gas.toString(), 10)} ` +
          `${pad(p.multiplierBps === null ? '-' : String(p.multiplierBps), 8)} ` +
          `${p.floorMarginUSD && p.floorMarginUSD > 0n ? c(C.red, floorCell) : floorCell} ` +
          `${pad(p.feeNative ?? (p.error ? 'error' : '-'), 18)} ${pad(p.feeUsd === null ? '-' : `$${p.feeUsd.toFixed(4)}`, 10)}`,
      );
    }
  }
}

export function printConsole(results: ChainResult[], expected: Expected, verbose = 0): void {
  console.log('');
  console.log(c(C.bold, `Canary DVN verification — deployment "${expected.deployment}"`));
  console.log(
    c(C.dim, `expected quorum ${expected.quorum} of ${expected.signers.length} signer(s): ${expected.signers.join(', ')}`),
  );
  console.log('');

  const header = `${pad('', 4)}  ${pad('chain', 16)} ${pad('eid', 7)} ${pad('signers', 9)} ${pad('dst cfg', 9)} ${pad('floor!=0', 9)} ${pad('median fee', 14)}`;
  console.log(c(C.bold, header));
  console.log(c(C.dim, '-'.repeat(header.length)));

  for (const r of [...results].sort((a, b) => a.name.localeCompare(b.name))) {
    if (r.status === 'SKIPPED') {
      console.log(`${STATUS_MARK.SKIPPED}  ${pad(r.name, 16)} ${c(C.dim, r.skipReason ?? '')}`);
      continue;
    }

    if (r.status === 'ERROR' && r.pathways.length === 0) {
      const why = r.findings.find((f) => f.severity === 'ERROR');
      console.log(
        `${STATUS_MARK.ERROR}  ${pad(r.name, 16)} ${pad(String(r.eid ?? '?'), 7)} ` +
          c(C.dim, `${why?.check ?? 'unreachable'} — ${(why?.detail ?? '').split('\n')[0]}`),
      );
      continue;
    }

    const signerOk = !r.findings.some((f) => f.check.startsWith('multisig') && f.severity === 'FAIL');
    const configured = r.pathways.filter((p) => p.gas !== null && p.gas > 0n).length;
    const nonZeroFloor = r.pathways.filter((p) => p.floorMarginUSD !== null && p.floorMarginUSD > 0n).length;
    const fees = r.pathways.map((p) => p.feeUsd).filter((v): v is number => v !== null).sort((a, b) => a - b);
    const median = fees.length > 0 ? fees[Math.floor(fees.length / 2)]! : null;

    const signerCell = pad(signerOk ? 'ok' : 'MISMATCH', 9);
    const floorCell = pad(String(nonZeroFloor), 9);
    console.log(
      `${STATUS_MARK[r.status]}  ${pad(r.name, 16)} ${pad(String(r.eid ?? '?'), 7)} ` +
        `${signerOk ? signerCell : c(C.red, signerCell)} ` +
        `${pad(`${configured}/${r.pathways.length}`, 9)} ` +
        `${nonZeroFloor === 0 ? floorCell : c(C.red, floorCell)} ` +
        `${pad(median === null ? '-' : `$${median.toFixed(4)}`, 14)}`,
    );
  }

  if (verbose > 0) {
    console.log('');
    console.log(c(C.bold, 'Detail'));
    for (const r of [...results].sort((a, b) => a.name.localeCompare(b.name))) {
      printVerboseChain(r, expected, verbose);
    }
  }

  // failures in detail
  const failing = results.filter((r) => r.findings.some(isNotable));
  if (failing.length > 0) {
    console.log('');
    console.log(c(C.bold, 'Findings'));
    for (const r of failing) {
      const notable = r.findings.filter(isNotable);
      // collapse repeated per-destination findings of the same kind
      const grouped = new Map<string, Finding[]>();
      for (const f of notable) {
        const key = `${f.check}|${f.expected ?? ''}|${f.dst ? '' : (f.actual ?? '')}`;
        (grouped.get(key) ?? grouped.set(key, []).get(key)!).push(f);
      }
      console.log('');
      console.log(`  ${c(C.cyan, r.name)} ${c(C.dim, `(eid ${r.eid ?? '?'}, ${r.address})`)}`);
      for (const group of grouped.values()) {
        const first = group[0]!;
        if (group.length > 1 && first.dst) {
          const dsts = group.map((g) => g.dst).join(', ');
          console.log(
            `    ${mark(first.severity)}${pad(first.check, 34)} x${group.length}` +
              (first.expected !== undefined ? ` expected=${first.expected}` : '') +
              `\n        ${c(C.dim, dsts)}` +
              (first.detail ? `\n        ${c(C.dim, first.detail)}` : ''),
          );
        } else {
          for (const f of group) {
            console.log(`    ${mark(f.severity)} ${describe(f)}`);
          }
        }
      }
    }
  }

  const t = totals(results);
  console.log('');
  console.log(
    c(C.bold, 'Summary  ') +
      `${t.ok} pass  ${t.fail} fail  ${t.error} error  ${t.skipped} skipped   ` +
      c(C.dim, `${t.pathwaysConfigured}/${t.pathways} pathways configured, ${t.failFindings} failing check(s)`),
  );
  console.log('');
}

export function toMarkdown(results: ChainResult[], expected: Expected): string {
  const t = totals(results);
  const lines: string[] = [];
  lines.push(`# Canary DVN verification — \`${expected.deployment}\``);
  lines.push('');
  lines.push(`Generated ${new Date().toISOString()}`);
  lines.push('');
  lines.push(
    `**${t.ok} pass · ${t.fail} fail · ${t.error} error · ${t.skipped} skipped** — ` +
      `${t.pathwaysConfigured}/${t.pathways} pathways configured, ${t.failFindings} failing check(s).`,
  );
  lines.push('');
  lines.push('## Expected');
  lines.push('');
  lines.push(`- Quorum: \`${expected.quorum}\` of ${expected.signers.length} signer(s)`);
  for (const s of expected.signers) lines.push(`- Signer: \`${s}\``);
  lines.push(`- floorMarginUSD: \`${expected.dst.default.floorMarginUSD ?? 'not asserted'}\` (sponsored = gas only)`);
  lines.push('');
  lines.push('## Chains');
  lines.push('');
  lines.push('| status | chain | eid | DVN | quorum | signers | dst configured | non-zero floor | median fee |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const r of [...results].sort((a, b) => a.name.localeCompare(b.name))) {
    if (r.status === 'SKIPPED') {
      lines.push(`| skip | ${r.name} | - | \`${r.address}\` | - | - | - | - | ${r.skipReason ?? ''} |`);
      continue;
    }
    const configured = r.pathways.filter((p) => p.gas !== null && p.gas > 0n).length;
    const nonZeroFloor = r.pathways.filter((p) => p.floorMarginUSD !== null && p.floorMarginUSD > 0n).length;
    const fees = r.pathways.map((p) => p.feeUsd).filter((v): v is number => v !== null).sort((a, b) => a - b);
    const median = fees.length > 0 ? `$${fees[Math.floor(fees.length / 2)]!.toFixed(4)}` : '-';
    lines.push(
      `| ${r.status === 'OK' ? 'pass' : r.status.toLowerCase()} | ${r.name} | ${r.eid ?? '?'} | \`${r.address}\` | ` +
        `${r.worker?.quorum ?? '?'} | ${r.worker?.signerSize ?? '?'} | ${configured}/${r.pathways.length} | ${nonZeroFloor} | ${median} |`,
    );
  }

  const failing = results.filter((r) => r.findings.some(isNotable));
  if (failing.length > 0) {
    lines.push('');
    lines.push('## Findings');
    for (const r of failing) {
      lines.push('');
      lines.push(`### ${r.name}`);
      lines.push('');
      for (const f of r.findings.filter(isNotable)) {
        lines.push(
          `- **${f.severity}** \`${f.check}\`${f.dst ? ` → ${f.dst}` : ''}` +
            (f.expected !== undefined ? ` — expected \`${f.expected}\`` : '') +
            (f.actual !== undefined ? `, got \`${f.actual}\`` : '') +
            (f.detail ? ` _(${f.detail})_` : ''),
        );
      }
    }
  }
  lines.push('');
  return lines.join('\n');
}

export function toJson(results: ChainResult[], expected: Expected): string {
  return JSON.stringify(
    {
      deployment: expected.deployment,
      generatedAt: new Date().toISOString(),
      expected: {
        signers: expected.signers,
        quorum: expected.quorum.toString(),
        worker: {
          ...expected.worker,
          allowlistSize: expected.worker.allowlistSize?.toString() ?? null,
        },
        dstDefault: {
          floorMarginUSD: expected.dst.default.floorMarginUSD?.toString() ?? null,
          multiplierBps: expected.dst.default.multiplierBps,
          minGas: expected.dst.default.minGas.toString(),
        },
      },
      totals: totals(results),
      chains: results,
    },
    (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
    2,
  );
}
