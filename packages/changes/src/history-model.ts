import type { DiffEndpoints, ComparisonCommit } from "./diff-endpoints.ts";
export const workingTree = "working";
export const stagedChanges = "staged";
export type { DiffEndpoints } from "./diff-endpoints.ts";
export interface ChangesRef { name: string; kind: "local" | "remote" | "tag" }
export interface ChangesNodeStats { files: number; additions: number; deletions: number }
export interface ChangesCommit {
  id: string;
  parents: string[];
  subject: string;
  body?: string;
  author: string;
  date: string;
  refs: ChangesRef[];
  ahead: boolean;
  kind: "commit" | "working" | "staged";
  stats?: ChangesNodeStats;
}
export interface UnpushedHistory { base: string; count: number }
export interface HistoryModel {
  commits: ChangesCommit[];
  topology: ComparisonCommit[];
  references: (ChangesRef & { id: string })[];
  endpoints: DiffEndpoints;
  head?: string;
  branch?: string;
  upstream?: string;
  unpushed?: UnpushedHistory;
}
export interface GraphNode { commit: ChangesCommit; row: number; lane: number }
export interface GraphEdge { from: string; to: string; d: string; lane: number }
export interface HistoryGraph { nodes: GraphNode[]; edges: GraphEdge[]; width: number; height: number }
