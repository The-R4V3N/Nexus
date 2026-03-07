// ============================================================
// NEXUS — Type Definitions
// ============================================================

export interface MarketSnapshot {
  symbol: string;
  name: string;
  category: MarketCategory;
  price: number;
  previousClose: number;
  change: number;
  changePercent: number;
  high: number;
  low: number;
  volume?: number;
  timestamp: Date;
}

export type MarketCategory =
  | "forex"
  | "indices"
  | "crypto"
  | "metals"
  | "commodities";

export interface MarketConfig {
  symbol: string;
  name: string;
  category: MarketCategory;
}

export interface OracleAnalysis {
  timestamp: Date;
  sessionId: string;
  marketSnapshots: MarketSnapshot[];
  analysis: string;
  setups: TradingSetup[];
  bias: MarketBias;
  keyLevels: KeyLevel[];
  confidence: number; // 0-100
}

export interface TradingSetup {
  instrument: string;
  type: "FVG" | "OB" | "Liquidity Sweep" | "MSS" | "CISD" | "PDH/PDL" | "Other";
  direction: "bullish" | "bearish" | "neutral";
  description: string;
  invalidation: string;
}

export interface MarketBias {
  overall: "bullish" | "bearish" | "neutral" | "mixed";
  notes: string;
}

export interface KeyLevel {
  instrument: string;
  level: number;
  type: "support" | "resistance" | "FVG" | "OB" | "liquidity";
  notes: string;
}

export interface AxiomReflection {
  timestamp: Date;
  sessionId: string;
  whatWorked: string;
  whatFailed: string;
  cognitiveBiases: string[];
  ruleUpdates: RuleUpdate[];
  newSystemPromptSections: string;
  evolutionSummary: string;
}

export interface RuleUpdate {
  ruleId: string;
  type: "add" | "modify" | "remove";
  before?: string;
  after?: string;
  reason: string;
}

export interface AnalysisRules {
  version: number;
  lastUpdated: string;
  rules: Rule[];
  focusInstruments: string[];
  sessionNotes: string;
}

export interface Rule {
  id: string;
  category: string;
  description: string;
  weight: number; // 1-10 importance
  addedSession: number;
  lastModifiedSession: number;
}

export interface JournalEntry {
  sessionNumber: number;
  date: string;
  title: string;
  oracleSummary: string;
  axiomSummary: string;
  fullAnalysis: OracleAnalysis;
  reflection: AxiomReflection;
  ruleCount: number;
  systemPromptVersion: number;
}

export interface NexusSession {
  id: string;
  number: number;
  startTime: Date;
  endTime?: Date;
  oracle?: OracleAnalysis;
  axiom?: AxiomReflection;
  journal?: JournalEntry;
}