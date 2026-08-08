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

// Parsing for Redis MONITOR output, in its own module so it can be tested.
//
// The benchmark scripts that use this each call main() at import, so a test that imported one of
// them would try to start Docker. These functions are the part worth testing — one of them is the
// reason a published measurement had to be corrected — so they live apart from the scripts.
//
// A MONITOR line looks like:
//
//   1699123456.789012 [0 127.0.0.1:60486] "eval" "return 1" "0"
//   1699123456.789050 [0 lua] "GET" "nexus:rpm:abc"
//
// timestamp, then the database index and the ORIGIN in brackets, then the command and its arguments.

/**
 * Collapse a monitored key to the thing it identifies.
 *
 * `nexus:setting:CACHE_ENABLED` is worth seeing in full — WHICH setting is the whole question.
 * `nexus:sticky:<64 hex chars>` is not; the hash differs per session and would turn a summary into
 * a list. So identifiers are folded and namespaces are kept.
 */
export function foldKey(key: string): string {
  return key
    .replace(/[0-9a-f]{16,}/gi, '<hash>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>');
}

/** A MONITOR line: `1699…  [0 127.0.0.1:1] "get" "nexus:setting:CACHE_ENABLED"` */
export function parseMonitorLine(line: string): { command: string; key: string } | null {
  const m = /\]\s+"([^"]+)"(?:\s+"([^"]*)")?/.exec(line);
  if (!m?.[1]) return null;
  return { command: m[1].toLowerCase(), key: m[2] ? foldKey(m[2]) : '' };
}

/**
 * Did this line cross the network, or did it happen inside a Lua script?
 *
 * This distinction is load-bearing and was got wrong once, publicly. `INFO commandstats` counts
 * every command Redis EXECUTES, including the ones a script calls internally — one `EVALSHA` doing
 * two `GET`s registers as three. Read as a count of network round trips, that inflates the cost of
 * the routing walk by roughly two and a half times.
 *
 * MONITOR settles it exactly, because Redis logs a script's internal calls with `lua` where the
 * client address would otherwise be. Everything else is a client round trip.
 */
export function isRoundTrip(line: string): boolean {
  const origin = /^\d+\.\d+\s+\[\d+\s+([^\]]+)\]\s+"/.exec(line.trim())?.[1];
  return origin !== undefined && origin.trim() !== 'lua';
}
