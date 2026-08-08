/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Alayra Nexus™ is a trademark of Alayra Systems. Use of the name or logo
 * is not granted by the software license below.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF
 * ANY KIND, either express or implied. See the License for details.
 */

// Read a .cpuprofile in the terminal.
//
// A profile is normally opened in Chrome DevTools. That is not available in CI, it is not available
// over SSH, and a flame graph cannot be pasted into a pull request as evidence. This prints the two
// rankings a flame graph is usually read FOR — self time by function, self time by module — plus
// inclusive time, which is what answers "how much of a request is spent inside routing".
//
//   tsx scripts/bench/analyzeProfile.ts <file.cpuprofile> [--top 30]
//
// ── Idle is excluded, and that is the whole trick ─────────────────────────────────────────────
//
// At low concurrency against a fast upstream, most wall-clock in the profile is the event loop
// waiting on a socket. Percentages taken over wall-clock would report every real hotspot as ~2% and
// hide all of them behind an 85% "(idle)". Everything below is a share of BUSY time — the CPU we
// actually spend — which is the quantity that caps throughput on a single thread.

import { readFileSync } from 'node:fs';

interface CallFrame {
  functionName: string;
  url: string;
  lineNumber: number;
}

interface ProfileNode {
  id: number;
  callFrame: CallFrame;
  hitCount?: number;
  children?: number[];
}

interface CpuProfile {
  nodes: ProfileNode[];
  startTime: number;
  endTime: number;
  samples: number[];
  /** Microseconds since the PREVIOUS sample; timeDeltas[i] precedes samples[i]. */
  timeDeltas: number[];
}

/** V8's synthetic frames. Real code is everything that is not one of these. */
const IDLE_FRAMES = new Set(['(idle)', '(program)']);
const GC_FRAME = '(garbage collector)';

export interface FrameStat {
  key: string;
  functionName: string;
  url: string;
  line: number;
  selfUs: number;
  totalUs: number;
}

export interface ProfileSummary {
  wallMs: number;
  busyMs: number;
  idleMs: number;
  gcMs: number;
  samples: number;
  frames: FrameStat[];
  modules: { module: string; selfUs: number }[];
}

/**
 * Shorten a script URL to something worth grouping by.
 *
 * `dist/services/nexus.service.js` stays as it is — that is our code and the file IS the answer.
 * A dependency collapses to its package name, because "we spend 14% in js-tiktoken" is actionable
 * and "we spend 3% in js-tiktoken/dist/lite.js line 402" is not, at least not first.
 */
export function moduleOf(url: string): string {
  if (!url) return '(native)';
  const normalized = url.replace(/^file:\/\/\//, '').replace(/\\/g, '/');
  if (!normalized.includes('/')) return `(node:${normalized})`;

  const nm = normalized.lastIndexOf('node_modules/');
  if (nm !== -1) {
    const after = normalized.slice(nm + 'node_modules/'.length).split('/');
    return after[0]?.startsWith('@') ? `${after[0]}/${after[1]}` : (after[0] ?? 'node_modules');
  }

  const dist = normalized.lastIndexOf('/dist/');
  if (dist !== -1) return normalized.slice(dist + 1);
  return normalized.split('/').slice(-2).join('/');
}

export function analyze(profile: CpuProfile): ProfileSummary {
  const byId = new Map<number, ProfileNode>();
  for (const n of profile.nodes) byId.set(n.id, n);

  // ── Self time ──
  // A sample names the function that was ON TOP of the stack at that instant, so attributing the
  // preceding delta to it — and only to it — is exactly self time.
  const selfByNode = new Map<number, number>();
  let idleUs = 0;
  let gcUs = 0;

  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i]!;
    const dt = profile.timeDeltas[i] ?? 0;
    // A negative delta is possible when the clock is adjusted mid-run; it would otherwise subtract
    // real time from a real frame.
    if (dt < 0) continue;

    const name = byId.get(id)?.callFrame.functionName ?? '';
    if (IDLE_FRAMES.has(name)) { idleUs += dt; continue; }
    if (name === GC_FRAME) gcUs += dt;
    selfByNode.set(id, (selfByNode.get(id) ?? 0) + dt);
  }

  // ── Inclusive time ──
  // Self time plus everything called from here. Computed over the tree, then summed per function,
  // which double-counts a directly recursive function — none of the code being examined here is,
  // and the self-time table above is unaffected either way.
  const totalByNode = new Map<number, number>();
  const inclusive = (id: number, seen: Set<number>): number => {
    const cached = totalByNode.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0;
    seen.add(id);
    let sum = selfByNode.get(id) ?? 0;
    for (const c of byId.get(id)?.children ?? []) sum += inclusive(c, seen);
    seen.delete(id);
    totalByNode.set(id, sum);
    return sum;
  };
  for (const n of profile.nodes) inclusive(n.id, new Set());

  // ── Fold tree positions together, per function ──
  const frames = new Map<string, FrameStat>();
  const modules = new Map<string, number>();

  for (const n of profile.nodes) {
    const self = selfByNode.get(n.id) ?? 0;
    const total = totalByNode.get(n.id) ?? 0;
    if (self === 0 && total === 0) continue;

    const { functionName, url, lineNumber } = n.callFrame;
    if (IDLE_FRAMES.has(functionName)) continue;

    const name = functionName || '(anonymous)';
    const key = `${name}@${url}:${lineNumber}`;
    const prev = frames.get(key);
    if (prev) { prev.selfUs += self; prev.totalUs += total; }
    else frames.set(key, { key, functionName: name, url, line: lineNumber, selfUs: self, totalUs: total });

    modules.set(moduleOf(url), (modules.get(moduleOf(url)) ?? 0) + self);
  }

  const busyUs = [...selfByNode.values()].reduce((a, b) => a + b, 0);

  return {
    wallMs: (profile.endTime - profile.startTime) / 1000,
    busyMs: busyUs / 1000,
    idleMs: idleUs / 1000,
    gcMs: gcUs / 1000,
    samples: profile.samples.length,
    frames: [...frames.values()].sort((a, b) => b.selfUs - a.selfUs),
    modules: [...modules.entries()].map(([module, selfUs]) => ({ module, selfUs })).sort((a, b) => b.selfUs - a.selfUs),
  };
}

const pct = (part: number, whole: number): string => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '—');
const msOf = (us: number): string => (us / 1000).toFixed(1);

export function report(s: ProfileSummary, top: number): string {
  const out: string[] = [];
  const busyUs = s.busyMs * 1000;

  out.push('');
  out.push(`wall ${s.wallMs.toFixed(0)}ms   busy ${s.busyMs.toFixed(0)}ms (${pct(s.busyMs, s.wallMs)} of wall)   idle ${s.idleMs.toFixed(0)}ms   gc ${s.gcMs.toFixed(0)}ms (${pct(s.gcMs, busyUs / 1000)} of busy)   ${s.samples} samples`);
  out.push('');
  out.push('── self time by module (share of BUSY cpu) ──');
  out.push('  self ms   share   module');
  for (const m of s.modules.slice(0, 15)) {
    out.push(`  ${msOf(m.selfUs).padStart(7)}  ${pct(m.selfUs, busyUs).padStart(6)}   ${m.module}`);
  }

  out.push('');
  out.push(`── self time by function, top ${top} (share of BUSY cpu) ──`);
  out.push('  self ms   share    incl ms   function');
  for (const f of s.frames.slice(0, top)) {
    out.push(`  ${msOf(f.selfUs).padStart(7)}  ${pct(f.selfUs, busyUs).padStart(6)}  ${msOf(f.totalUs).padStart(9)}   ${f.functionName}  ${moduleOf(f.url)}:${f.line + 1}`);
  }

  out.push('');
  out.push(`── inclusive time, top ${top} (self + everything called from it) ──`);
  const byTotal = [...s.frames].sort((a, b) => b.totalUs - a.totalUs);
  out.push('  incl ms   share   function');
  for (const f of byTotal.slice(0, top)) {
    out.push(`  ${msOf(f.totalUs).padStart(7)}  ${pct(f.totalUs, busyUs).padStart(6)}   ${f.functionName}  ${moduleOf(f.url)}:${f.line + 1}`);
  }
  out.push('');
  return out.join('\n');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const topArg = args.indexOf('--top');
  const top = topArg !== -1 ? parseInt(args[topArg + 1] ?? '30', 10) : 30;

  if (!file) {
    console.error('usage: tsx scripts/bench/analyzeProfile.ts <file.cpuprofile> [--top 30]');
    process.exit(1);
  }
  console.log(report(analyze(JSON.parse(readFileSync(file, 'utf8')) as CpuProfile), top));
}
