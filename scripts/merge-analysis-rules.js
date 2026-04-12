// ============================================================
// NEXUS — Analysis Rules Merge Utility
// Merges two analysis-rules.json versions produced by concurrent
// sessions. Used by the GitHub Actions commit step to resolve
// autostash conflicts without losing either session's rule changes.
//
// Usage (CLI): node scripts/merge-analysis-rules.js <remote.json> <local.json>
// Outputs merged JSON to stdout.
//
// Usage (module): const { mergeAnalysisRules } = require('./merge-analysis-rules')
// ============================================================

"use strict";

/**
 * Merges two analysis-rules.json objects.
 *
 * Strategy:
 * - Rules: start with remote as base; for each rule in local,
 *   add it if new, or replace if local has a higher lastModifiedSession.
 * - version: take the higher of the two.
 * - lastUpdated: take the later ISO timestamp.
 * - sessionNotes / focusInstruments: taken from whichever has the higher version.
 *
 * @param {object} remote - The version already on origin/main
 * @param {object} local  - The version written by the current session
 * @returns {object} merged rules object
 */
function mergeAnalysisRules(remote, local) {
  // Build map of remote rules by ID
  const byId = {};
  for (const rule of (remote.rules || [])) {
    byId[rule.id] = rule;
  }

  // Apply local rules
  for (const rule of (local.rules || [])) {
    const existing = byId[rule.id];
    if (!existing) {
      byId[rule.id] = rule;
    } else if ((rule.lastModifiedSession ?? 0) > (existing.lastModifiedSession ?? 0)) {
      byId[rule.id] = rule;
    }
    // else keep remote version (it's more recent or equal)
  }

  // Sort by numeric ID (r001, r002, … r037)
  const mergedRules = Object.values(byId).sort((a, b) => {
    const numA = parseInt(a.id.replace(/\D/g, ""), 10) || 0;
    const numB = parseInt(b.id.replace(/\D/g, ""), 10) || 0;
    return numA - numB;
  });

  const higherVersion = (local.version ?? 0) >= (remote.version ?? 0) ? local : remote;

  return {
    ...remote,
    rules: mergedRules,
    version: Math.max(remote.version ?? 0, local.version ?? 0),
    lastUpdated: (local.lastUpdated ?? "") > (remote.lastUpdated ?? "")
      ? local.lastUpdated
      : remote.lastUpdated,
    sessionNotes: higherVersion.sessionNotes ?? remote.sessionNotes,
    focusInstruments: higherVersion.focusInstruments ?? remote.focusInstruments,
  };
}

module.exports = { mergeAnalysisRules };

// CLI entry point
if (require.main === module) {
  const fs = require("fs");
  const [, , remotePath, localPath] = process.argv;
  if (!remotePath || !localPath) {
    console.error("Usage: node scripts/merge-analysis-rules.js <remote.json> <local.json>");
    process.exit(1);
  }
  const remote = JSON.parse(fs.readFileSync(remotePath, "utf8"));
  const local  = JSON.parse(fs.readFileSync(localPath,  "utf8"));
  const merged = mergeAnalysisRules(remote, local);
  process.stdout.write(JSON.stringify(merged, null, 2) + "\n");
}
