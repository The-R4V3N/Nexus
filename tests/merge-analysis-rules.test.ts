import { describe, it, expect } from "vitest";
import { mergeAnalysisRules } from "../scripts/merge-analysis-rules";

const baseRule = (id: string, mod: number, desc = "base") => ({
  id,
  category: "test",
  description: desc,
  weight: 5,
  addedSession: 1,
  lastModifiedSession: mod,
});

describe("mergeAnalysisRules", () => {
  it("keeps all rules from remote when local has no changes", () => {
    const remote = {
      rules: [baseRule("r001", 0), baseRule("r002", 0)],
      version: 10,
      lastUpdated: "2026-04-11T13:07:00.000Z",
      sessionNotes: "Session #146",
      focusInstruments: ["BTC"],
    };
    const local = structuredClone(remote);

    const merged = mergeAnalysisRules(remote, local);
    expect(merged.rules).toHaveLength(2);
    expect(merged.rules.map((r: any) => r.id)).toEqual(["r001", "r002"]);
  });

  it("adds new rules from local that don't exist in remote", () => {
    const remote = {
      rules: [baseRule("r001", 0)],
      version: 10,
      lastUpdated: "2026-04-11T13:07:00.000Z",
      sessionNotes: "Session #146a",
      focusInstruments: ["BTC"],
    };
    const local = {
      ...remote,
      rules: [baseRule("r001", 0), baseRule("r002", 147, "new rule from local")],
      version: 11,
      lastUpdated: "2026-04-11T13:08:00.000Z",
      sessionNotes: "Session #147",
    };

    const merged = mergeAnalysisRules(remote, local);
    expect(merged.rules).toHaveLength(2);
    expect(merged.rules.find((r: any) => r.id === "r002")).toBeDefined();
  });

  it("keeps remote version of a rule when remote has a more recent modification", () => {
    const remote = {
      rules: [baseRule("r001", 148, "remote newer")],
      version: 12,
      lastUpdated: "2026-04-11T14:00:00.000Z",
      sessionNotes: "Session #148",
      focusInstruments: ["BTC"],
    };
    const local = {
      ...remote,
      rules: [baseRule("r001", 147, "local older")],
      version: 11,
      lastUpdated: "2026-04-11T13:08:00.000Z",
      sessionNotes: "Session #147",
    };

    const merged = mergeAnalysisRules(remote, local);
    expect(merged.rules[0].description).toBe("remote newer");
  });

  it("takes local version of a rule when local has a more recent modification", () => {
    const remote = {
      rules: [baseRule("r001", 146, "remote older")],
      version: 10,
      lastUpdated: "2026-04-11T13:07:00.000Z",
      sessionNotes: "Session #146",
      focusInstruments: ["BTC"],
    };
    const local = {
      ...remote,
      rules: [baseRule("r001", 147, "local newer")],
      version: 11,
      lastUpdated: "2026-04-11T13:08:00.000Z",
      sessionNotes: "Session #147",
    };

    const merged = mergeAnalysisRules(remote, local);
    expect(merged.rules[0].description).toBe("local newer");
  });

  it("takes the higher version number", () => {
    const remote = { rules: [], version: 87, lastUpdated: "2026-04-11T13:07:00.000Z", sessionNotes: "", focusInstruments: [] };
    const local  = { rules: [], version: 88, lastUpdated: "2026-04-11T13:08:00.000Z", sessionNotes: "", focusInstruments: [] };
    expect(mergeAnalysisRules(remote, local).version).toBe(88);
    expect(mergeAnalysisRules(local, remote).version).toBe(88);
  });

  it("takes the later lastUpdated timestamp", () => {
    const remote = { rules: [], version: 87, lastUpdated: "2026-04-11T13:07:00.000Z", sessionNotes: "", focusInstruments: [] };
    const local  = { rules: [], version: 87, lastUpdated: "2026-04-11T13:08:00.000Z", sessionNotes: "", focusInstruments: [] };
    expect(mergeAnalysisRules(remote, local).lastUpdated).toBe("2026-04-11T13:08:00.000Z");
    expect(mergeAnalysisRules(local, remote).lastUpdated).toBe("2026-04-11T13:08:00.000Z");
  });

  it("takes sessionNotes from the session with the higher version", () => {
    const remote = { rules: [], version: 87, lastUpdated: "2026-04-11T13:07:00.000Z", sessionNotes: "Session #146a", focusInstruments: [] };
    const local  = { rules: [], version: 88, lastUpdated: "2026-04-11T13:08:00.000Z", sessionNotes: "Session #147",  focusInstruments: [] };
    expect(mergeAnalysisRules(remote, local).sessionNotes).toBe("Session #147");
  });

  it("produces valid sorted rule order by numeric ID", () => {
    const remote = { rules: [baseRule("r003", 0), baseRule("r001", 0)], version: 10, lastUpdated: "2026-04-11T13:07:00.000Z", sessionNotes: "", focusInstruments: [] };
    const local  = { rules: [baseRule("r002", 147)], version: 11, lastUpdated: "2026-04-11T13:08:00.000Z", sessionNotes: "", focusInstruments: [] };
    const ids = mergeAnalysisRules(remote, local).rules.map((r: any) => r.id);
    expect(ids).toEqual(["r001", "r002", "r003"]);
  });

  it("output is valid JSON", () => {
    const remote = { rules: [baseRule("r001", 0)], version: 10, lastUpdated: "2026-04-11T13:07:00.000Z", sessionNotes: "a", focusInstruments: ["BTC"] };
    const local  = { rules: [baseRule("r001", 147), baseRule("r002", 147)], version: 11, lastUpdated: "2026-04-11T13:08:00.000Z", sessionNotes: "b", focusInstruments: ["ETH"] };
    const merged = mergeAnalysisRules(remote, local);
    expect(() => JSON.parse(JSON.stringify(merged))).not.toThrow();
  });
});
