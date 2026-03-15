import { describe, it, expect, vi, beforeEach } from "vitest";

// We test the exported phase functions from agent.ts
// Note: fetchAllInputData and runAndValidateOracle require network/API calls,
// so we focus on writeSessionOutput structure and the exports existing.

describe("agent phase function exports", () => {
  it("exports fetchAllInputData", async () => {
    const mod = await import("../src/agent");
    expect(typeof mod.fetchAllInputData).toBe("function");
  });

  it("exports runAndValidateOracle", async () => {
    const mod = await import("../src/agent");
    expect(typeof mod.runAndValidateOracle).toBe("function");
  });

  it("exports runAndValidateAxiom", async () => {
    const mod = await import("../src/agent");
    expect(typeof mod.runAndValidateAxiom).toBe("function");
  });

  it("exports runAndValidateForge", async () => {
    const mod = await import("../src/agent");
    expect(typeof mod.runAndValidateForge).toBe("function");
  });

  it("exports writeSessionOutput", async () => {
    const mod = await import("../src/agent");
    expect(typeof mod.writeSessionOutput).toBe("function");
  });

  it("exports runSession", async () => {
    const mod = await import("../src/agent");
    expect(typeof mod.runSession).toBe("function");
  });
});
