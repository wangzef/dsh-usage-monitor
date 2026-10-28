import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
import { SessionEvent, SessionHeader } from "@deepseek-ai/dsh-session";
//#region src/types.d.ts
type TaskScope = 'all' | 'main' | 'subtasks';
interface TokenBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}
interface ActivityRecord {
  seq: number;
  time: number;
  kind: 'human' | 'assistant';
  provider?: string;
  model?: string;
  tokens?: TokenBreakdown;
  /** End-to-end response time from step/start to assistant/message, in ms. */
  durationMs?: number;
  /** Effective reasoning effort from the nearest request/header; absent when none was recorded. */
  effort?: string;
}
interface SessionSummary {
  id: string;
  createdAt: number;
  cwd?: string;
  parentSession?: string;
  lastSeq: number;
  indexedAt: number;
  activities: ActivityRecord[];
}
interface IndexCache {
  /** Schema 4 rebuilds call metadata using persistent request-header snapshots. */
  schema: 4;
  sessions: SessionSummary[];
}
interface StatsQuery {
  from: string;
  to: string;
  timeZone: string;
  workspace?: string;
  scope: TaskScope;
}
/** Query filters for the per-call detail endpoint (`/calls`). */
interface CallsQuery extends StatsQuery {
  /** Exact model filter; absent means no filter. */
  model: string | undefined;
  /** Exact provider route filter; absent means no filter. */
  provider: string | undefined;
  /** Keep only calls whose billed input tokens are at least this value. */
  minInputTokens: number | undefined;
  /** Keep only calls whose output tokens are at least this value. */
  minOutputTokens: number | undefined;
  /** Maximum number of newest matching calls retained by the detail view. */
  maxRecords: number;
  page: number;
  pageSize: number;
}
type CallsFilter = Omit<CallsQuery, 'page' | 'pageSize'>;
/** One assistant call row served by `/calls`. */
interface CallRecord {
  key: string;
  seq: number;
  time: number;
  sessionId: string;
  provider: string;
  model: string;
  effort: string | null;
  durationMs: number | null;
  tokens: TokenBreakdown;
}
/** Paginated payload served by `/calls`. */
interface CallsPage {
  indexReady: boolean;
  items: CallRecord[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}
interface ModelStats extends TokenBreakdown {
  key: string;
  provider: string;
  model: string;
  tokens: number;
  calls: number;
  percent: number;
}
interface DayStats extends TokenBreakdown {
  date: string;
  tokens: number;
  calls: number;
  messages: number;
  sessions: number;
  models: Record<string, number>;
}
interface StatsSnapshot {
  generatedAt: number;
  range: {
    from: string;
    to: string;
    timeZone: string;
  };
  totals: {
    tokens: number;
    sessions: number;
    messages: number;
    activeDays: number;
    currentStreak: number;
  } & TokenBreakdown;
  mostUsedModel: ModelStats | null;
  allTime: {
    totals: StatsSnapshot['totals'];
    mostUsedModel: ModelStats | null;
  };
  days: DayStats[];
  models: ModelStats[];
  workspaces: {
    path: string;
    sessions: number;
  }[];
  index: {
    sessions: number;
    lastUpdatedAt: number | null;
  };
}
//#endregion
//#region src/core.d.ts
/** Per-session in-memory state for pairing step timing and reasoning effort. */
interface CollectState {
  openStep: {
    turn: number;
    step: number;
    time: number;
  } | null;
  currentEffort: string | undefined;
}
declare function newCollectState(): CollectState;
declare function activityFromEvent(event: SessionEvent, state?: CollectState): ActivityRecord | null;
declare function summarizeSession(header: SessionHeader, events: readonly SessionEvent[], indexedAt?: number): SessionSummary;
declare function appendActivity(summary: SessionSummary, event: SessionEvent, indexedAt?: number, state?: CollectState): boolean;
declare function aggregateStats(sessions: Iterable<SessionSummary>, query: StatsQuery): StatsSnapshot;
declare function collectCalls(sessions: Iterable<SessionSummary>, query: CallsFilter): CallRecord[];
declare function aggregateCalls(sessions: Iterable<SessionSummary>, query: CallsQuery): {
  items: CallRecord[];
  total: number;
};
declare function exportCsv(snapshot: StatsSnapshot): string;
//#endregion
//#region src/index.d.ts
declare const name = "usage-stats";
declare const inject: string[];
interface Config {
  indexConcurrency?: number;
  cacheWriteDelayMs?: number;
  cachePath?: string;
  apiPath?: string;
}
declare const Config: z<Config>;
declare function apply(ctx: Context, config?: Config): void;
//#endregion
export { type ActivityRecord, type CallRecord, type CallsFilter, type CallsPage, type CallsQuery, Config, type DayStats, type IndexCache, type ModelStats, type SessionSummary, type StatsQuery, type StatsSnapshot, type TaskScope, type TokenBreakdown, activityFromEvent, aggregateCalls, aggregateStats, appendActivity, apply, collectCalls, exportCsv, inject, name, newCollectState, summarizeSession };