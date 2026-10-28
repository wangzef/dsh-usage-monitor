import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import z from "@deepseek-ai/schemastery";
//#region src/core.ts
const ZERO_TOKENS = () => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	reasoning: 0
});
function finiteCount(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
function newCollectState() {
	return {
		openStep: null,
		currentEffort: void 0
	};
}
function activityFromEvent(event, state = newCollectState()) {
	if (event.type === "step/start") {
		state.openStep = {
			turn: event.data.turn,
			step: event.data.step,
			time: event.time
		};
		return null;
	}
	if (event.type === "request/header") {
		const effort = event.data.header?.config?.reasoningEffort;
		if (typeof effort === "string" && effort.length > 0) state.currentEffort = effort;
		return null;
	}
	if (event.type === "step/end" || event.type === "turn/end") {
		state.openStep = null;
		return null;
	}
	if (event.type === "user/message" && event.data.source.kind === "user") return {
		seq: event.seq,
		time: event.time,
		kind: "human"
	};
	if (event.type !== "assistant/message") return null;
	const usage = event.data.usage;
	let durationMs;
	if (state.openStep !== null && state.openStep.turn === event.data.turn && state.openStep.step === event.data.step) {
		durationMs = Math.max(0, event.time - state.openStep.time);
		state.openStep = null;
	}
	const activity = {
		seq: event.seq,
		time: event.time,
		kind: "assistant",
		provider: event.data.message.source.provider,
		model: event.data.message.source.model,
		tokens: {
			input: finiteCount(usage?.inputTokens),
			output: finiteCount(usage?.outputTokens),
			cacheRead: finiteCount(usage?.cacheReadTokens),
			cacheWrite: finiteCount(usage?.cacheWriteTokens),
			reasoning: finiteCount(usage?.reasoningTokens)
		}
	};
	if (durationMs !== void 0) activity.durationMs = durationMs;
	if (state.currentEffort !== void 0) activity.effort = state.currentEffort;
	return activity;
}
function summarizeSession(header, events, indexedAt = Date.now()) {
	const firstOwnSeq = header.parentSession !== void 0 ? header.seedLength ?? 0 : 0;
	const activities = [];
	const state = newCollectState();
	for (const event of events) {
		if (event.seq < firstOwnSeq) continue;
		const activity = activityFromEvent(event, state);
		if (activity !== null) activities.push(activity);
	}
	const summary = {
		id: String(header.id),
		createdAt: header.createdAt,
		lastSeq: events.at(-1)?.seq ?? -1,
		indexedAt,
		activities
	};
	if (header.cwd !== void 0) summary.cwd = header.cwd;
	if (header.parentSession !== void 0) summary.parentSession = String(header.parentSession);
	return summary;
}
function appendActivity(summary, event, indexedAt = Date.now(), state) {
	if (event.seq <= summary.lastSeq) return false;
	summary.lastSeq = event.seq;
	summary.indexedAt = indexedAt;
	const activity = activityFromEvent(event, state ?? newCollectState());
	if (activity !== null) summary.activities.push(activity);
	return true;
}
function addTokens(target, value) {
	target.input += value.input;
	target.output += value.output;
	target.cacheRead += value.cacheRead;
	target.cacheWrite += value.cacheWrite;
	target.reasoning += value.reasoning;
	return value.input + value.output + value.cacheRead + value.cacheWrite;
}
function formatter(timeZone) {
	try {
		return new Intl.DateTimeFormat("en-CA", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit"
		});
	} catch {
		return new Intl.DateTimeFormat("en-CA", {
			timeZone: "UTC",
			year: "numeric",
			month: "2-digit",
			day: "2-digit"
		});
	}
}
function dateKey(value, format) {
	const parts = format.formatToParts(value);
	return `${parts.find((part) => part.type === "year")?.value ?? "1970"}-${parts.find((part) => part.type === "month")?.value ?? "01"}-${parts.find((part) => part.type === "day")?.value ?? "01"}`;
}
function datesBetween(from, to) {
	const days = [];
	const cursor = /* @__PURE__ */ new Date(`${from}T00:00:00Z`);
	const end = /* @__PURE__ */ new Date(`${to}T00:00:00Z`);
	while (cursor <= end && days.length < 3660) {
		days.push(cursor.toISOString().slice(0, 10));
		cursor.setUTCDate(cursor.getUTCDate() + 1);
	}
	return days;
}
function newDay(date) {
	return {
		date,
		tokens: 0,
		calls: 0,
		messages: 0,
		sessions: 0,
		models: {},
		...ZERO_TOKENS()
	};
}
function inScope(session, query) {
	if (query.workspace !== void 0 && session.cwd !== query.workspace) return false;
	if (query.scope === "main" && session.parentSession !== void 0) return false;
	if (query.scope === "subtasks" && session.parentSession === void 0) return false;
	return true;
}
function aggregateStats(sessions, query) {
	const allSessions = [...sessions];
	const format = formatter(query.timeZone);
	const days = datesBetween(query.from, query.to).map(newDay);
	const byDate = new Map(days.map((day) => [day.date, day]));
	const activeSessionsByDay = /* @__PURE__ */ new Map();
	const models = /* @__PURE__ */ new Map();
	const sessionIds = /* @__PURE__ */ new Set();
	const activeDates = /* @__PURE__ */ new Set();
	const totals = {
		tokens: 0,
		sessions: 0,
		messages: 0,
		activeDays: 0,
		currentStreak: 0,
		...ZERO_TOKENS()
	};
	const allTimeTotals = {
		tokens: 0,
		sessions: 0,
		messages: 0,
		activeDays: 0,
		currentStreak: 0,
		...ZERO_TOKENS()
	};
	const allTimeModels = /* @__PURE__ */ new Map();
	const allTimeSessionIds = /* @__PURE__ */ new Set();
	const allTimeActiveDates = /* @__PURE__ */ new Set();
	for (const session of allSessions) {
		if (!inScope(session, query)) continue;
		let sessionActive = false;
		let allTimeSessionActive = false;
		for (const activity of session.activities) {
			const dayKey = dateKey(activity.time, format);
			allTimeTotals.messages += 1;
			allTimeSessionActive = true;
			allTimeActiveDates.add(dayKey);
			if (activity.kind === "assistant" && activity.tokens !== void 0) {
				const provider = activity.provider ?? "unknown";
				const model = activity.model ?? "unknown";
				const key = `${provider}/${model}`;
				let modelStats = allTimeModels.get(key);
				if (modelStats === void 0) {
					modelStats = {
						key,
						provider,
						model,
						tokens: 0,
						calls: 0,
						percent: 0,
						...ZERO_TOKENS()
					};
					allTimeModels.set(key, modelStats);
				}
				const amount = addTokens(modelStats, activity.tokens);
				modelStats.tokens += amount;
				modelStats.calls += 1;
				allTimeTotals.tokens += amount;
				addTokens(allTimeTotals, activity.tokens);
			}
			const day = byDate.get(dayKey);
			if (day === void 0) continue;
			day.messages += 1;
			totals.messages += 1;
			sessionActive = true;
			activeDates.add(dayKey);
			let daySessions = activeSessionsByDay.get(dayKey);
			if (daySessions === void 0) activeSessionsByDay.set(dayKey, daySessions = /* @__PURE__ */ new Set());
			daySessions.add(session.id);
			if (activity.kind !== "assistant" || activity.tokens === void 0) continue;
			day.calls += 1;
			const provider = activity.provider ?? "unknown";
			const model = activity.model ?? "unknown";
			const key = `${provider}/${model}`;
			let modelStats = models.get(key);
			if (modelStats === void 0) {
				modelStats = {
					key,
					provider,
					model,
					tokens: 0,
					calls: 0,
					percent: 0,
					...ZERO_TOKENS()
				};
				models.set(key, modelStats);
			}
			const amount = addTokens(modelStats, activity.tokens);
			modelStats.tokens += amount;
			modelStats.calls += 1;
			day.tokens += amount;
			day.models[key] = (day.models[key] ?? 0) + amount;
			addTokens(day, activity.tokens);
			totals.tokens += amount;
			addTokens(totals, activity.tokens);
		}
		if (sessionActive) sessionIds.add(session.id);
		if (allTimeSessionActive) allTimeSessionIds.add(session.id);
	}
	for (const day of days) day.sessions = activeSessionsByDay.get(day.date)?.size ?? 0;
	totals.sessions = sessionIds.size;
	totals.activeDays = activeDates.size;
	for (let index = days.length - 1; index >= 0; index -= 1) {
		const day = days[index];
		if (day === void 0 || !activeDates.has(day.date)) break;
		totals.currentStreak += 1;
	}
	const sortedModels = [...models.values()].sort((a, b) => b.tokens - a.tokens || a.key.localeCompare(b.key));
	for (const model of sortedModels) model.percent = totals.tokens === 0 ? 0 : model.tokens / totals.tokens * 100;
	allTimeTotals.sessions = allTimeSessionIds.size;
	allTimeTotals.activeDays = allTimeActiveDates.size;
	const todayKey = dateKey(Date.now(), format);
	const streakCursor = /* @__PURE__ */ new Date(`${todayKey}T00:00:00Z`);
	while (allTimeActiveDates.has(streakCursor.toISOString().slice(0, 10))) {
		allTimeTotals.currentStreak += 1;
		streakCursor.setUTCDate(streakCursor.getUTCDate() - 1);
	}
	const sortedAllTimeModels = [...allTimeModels.values()].sort((a, b) => b.tokens - a.tokens || a.key.localeCompare(b.key));
	for (const model of sortedAllTimeModels) model.percent = allTimeTotals.tokens === 0 ? 0 : model.tokens / allTimeTotals.tokens * 100;
	const workspaceCounts = /* @__PURE__ */ new Map();
	for (const session of allSessions) {
		if (session.cwd === void 0) continue;
		let ids = workspaceCounts.get(session.cwd);
		if (ids === void 0) workspaceCounts.set(session.cwd, ids = /* @__PURE__ */ new Set());
		ids.add(session.id);
	}
	const workspaces = [...workspaceCounts].map(([path, ids]) => ({
		path,
		sessions: ids.size
	})).sort((a, b) => b.sessions - a.sessions || a.path.localeCompare(b.path));
	return {
		generatedAt: Date.now(),
		range: {
			from: query.from,
			to: query.to,
			timeZone: query.timeZone
		},
		totals,
		mostUsedModel: sortedModels[0] ?? null,
		allTime: {
			totals: allTimeTotals,
			mostUsedModel: sortedAllTimeModels[0] ?? null
		},
		days,
		models: sortedModels,
		workspaces,
		index: {
			sessions: allSessions.length,
			lastUpdatedAt: allSessions.length === 0 ? null : Math.max(...allSessions.map((session) => session.indexedAt))
		}
	};
}
function collectCalls(sessions, query) {
	const format = formatter(query.timeZone);
	const rows = [];
	for (const session of sessions) {
		if (!inScope(session, query)) continue;
		for (const activity of session.activities) {
			if (activity.kind !== "assistant") continue;
			if (query.model !== void 0 && activity.model !== query.model) continue;
			if (query.provider !== void 0 && activity.provider !== query.provider) continue;
			const tokens = activity.tokens ?? ZERO_TOKENS();
			if (query.minInputTokens !== void 0 && tokens.input < query.minInputTokens) continue;
			if (query.minOutputTokens !== void 0 && tokens.output < query.minOutputTokens) continue;
			const dayKey = dateKey(activity.time, format);
			if (dayKey < query.from || dayKey > query.to) continue;
			rows.push({
				key: `${session.id}:${activity.seq}`,
				seq: activity.seq,
				time: activity.time,
				sessionId: session.id,
				provider: activity.provider ?? "unknown",
				model: activity.model ?? "unknown",
				effort: activity.effort ?? null,
				durationMs: activity.durationMs ?? null,
				tokens
			});
		}
	}
	rows.sort((a, b) => b.time - a.time || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	if (rows.length > query.maxRecords) rows.length = query.maxRecords;
	return rows;
}
function aggregateCalls(sessions, query) {
	const rows = collectCalls(sessions, query);
	const total = rows.length;
	const offset = (query.page - 1) * query.pageSize;
	return {
		items: rows.slice(offset, offset + query.pageSize),
		total
	};
}
function exportCsv(snapshot) {
	const quote = (value) => `"${String(value).replaceAll("\"", "\"\"")}"`;
	const header = [
		"date",
		"model",
		"provider",
		"tokens",
		"input",
		"output",
		"cache_read",
		"cache_write",
		"messages",
		"sessions"
	];
	const rows = [];
	for (const day of snapshot.days) {
		const entries = Object.entries(day.models);
		if (entries.length === 0) rows.push([
			day.date,
			"",
			"",
			"0",
			"0",
			"0",
			"0",
			"0",
			String(day.messages),
			String(day.sessions)
		]);
		for (const [key, tokens] of entries) {
			const model = snapshot.models.find((item) => item.key === key);
			rows.push([
				day.date,
				model?.model ?? key,
				model?.provider ?? "",
				String(tokens),
				"",
				"",
				"",
				"",
				String(day.messages),
				String(day.sessions)
			]);
		}
	}
	return [header, ...rows].map((row) => row.map(quote).join(",")).join("\r\n");
}
//#endregion
//#region src/index.ts
const name = "usage-stats";
const inject = ["sessionQuery", "webServer"];
const Config = z.object({
	indexConcurrency: z.natural().min(1).max(8).default(2).description("Concurrent historical session reads."),
	cacheWriteDelayMs: z.natural().min(250).max(3e4).default(1e3).description("Debounce delay for local index writes."),
	cachePath: z.string().description("Optional index path; defaults below DSH_HOME."),
	apiPath: z.string().default("/usage-stats/v1").description("Same-origin read-only API prefix.")
});
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SCOPES = /* @__PURE__ */ new Set([
	"all",
	"main",
	"subtasks"
]);
function sendJson(res, status, body) {
	const json = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(json),
		"cache-control": "no-store",
		"x-content-type-options": "nosniff"
	});
	res.end(json);
}
function parseQuery(req) {
	const url = new URL(req.url ?? "/", "http://localhost");
	const now = /* @__PURE__ */ new Date();
	const fallbackTo = now.toISOString().slice(0, 10);
	now.setUTCDate(now.getUTCDate() - 29);
	const fallbackFrom = now.toISOString().slice(0, 10);
	const from = url.searchParams.get("from") ?? fallbackFrom;
	const to = url.searchParams.get("to") ?? fallbackTo;
	if (!ISO_DATE.test(from) || !ISO_DATE.test(to) || from > to) throw new Error("Invalid date range");
	const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5;
	if (!Number.isFinite(span) || span > 3660) throw new Error("Date range exceeds 10 years");
	const scope = url.searchParams.get("scope") ?? "all";
	if (!SCOPES.has(scope)) throw new Error("Invalid task scope");
	const workspace = url.searchParams.get("workspace") ?? void 0;
	const query = {
		from,
		to,
		timeZone: (url.searchParams.get("timeZone") ?? "UTC").slice(0, 80),
		scope
	};
	if (workspace !== void 0 && workspace.length <= 4096) query.workspace = workspace;
	return query;
}
/** Pagination, model/provider, and token-threshold filters for `/calls`. */
function parsePagination(req) {
	const url = new URL(req.url ?? "/", "http://localhost");
	const page = Number(url.searchParams.get("page") ?? "1");
	const pageSize = Number(url.searchParams.get("pageSize") ?? "50");
	const maxRecords = Number(url.searchParams.get("maxRecords") ?? "1000");
	if (!Number.isSafeInteger(page) || page < 1 || page > 1e6) throw new Error("Invalid page");
	if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) throw new Error("Invalid page size");
	if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 1e4) throw new Error("Invalid maximum records");
	const model = url.searchParams.get("model") ?? void 0;
	const provider = url.searchParams.get("provider") ?? void 0;
	if (model !== void 0 && model.length > 4096) throw new Error("Invalid model filter");
	if (provider !== void 0 && provider.length > 4096) throw new Error("Invalid provider filter");
	const threshold = (name) => {
		const raw = url.searchParams.get(name);
		if (raw === null || raw === "") return void 0;
		const value = Number(raw);
		if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}`);
		return value;
	};
	return {
		page,
		pageSize,
		maxRecords,
		model,
		provider,
		minInputTokens: threshold("minInputTokens"),
		minOutputTokens: threshold("minOutputTokens")
	};
}
function isCache(value) {
	if (typeof value !== "object" || value === null) return false;
	const record = value;
	return record.schema === 4 && Array.isArray(record.sessions);
}
var UsageIndex = class {
	ctx;
	config;
	sessions = /* @__PURE__ */ new Map();
	collectors = /* @__PURE__ */ new Map();
	callsCache;
	/** True once the historical replay finished; served to `/calls` as `indexReady`. */
	ready = false;
	cachePath;
	writeTimer;
	disposed = false;
	loading;
	constructor(ctx, config) {
		this.ctx = ctx;
		this.config = config;
		this.cachePath = config.cachePath ?? dshHomePath("usage-stats", "index-v1.json");
	}
	start() {
		this.ctx.on("session/event", (session, event) => {
			this.acceptLive(session, event);
		});
		this.ctx.effect(() => this.ctx.webServer.register({
			kind: "prefix",
			path: this.config.apiPath,
			handler: (req, res) => this.handle(req, res)
		}), "usage-stats: read-only API");
		this.ctx.effect(() => () => {
			this.dispose();
		}, "usage-stats: local index lifecycle");
		this.loading = this.initialize().catch((error) => {
			this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)));
		});
	}
	async initialize() {
		const cacheNeedsRewrite = await this.loadCache();
		const missing = (await this.ctx.sessionQuery.listSessions()).filter((record) => !this.sessions.has(String(record.header.id)));
		let cursor = 0;
		const worker = async () => {
			while (!this.disposed) {
				const record = missing[cursor];
				cursor += 1;
				if (record === void 0) return;
				try {
					const snapshot = await this.ctx.sessionQuery.readSession(record.header.id);
					const incoming = summarizeSession(snapshot.session, snapshot.events);
					const current = this.sessions.get(incoming.id);
					if (current === void 0 || current.lastSeq < incoming.lastSeq) {
						this.sessions.set(incoming.id, incoming);
						this.callsCache = void 0;
					}
				} catch (error) {
					this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)));
				}
				await new Promise((resolve) => setImmediate(resolve));
			}
		};
		await Promise.all(Array.from({ length: Math.min(this.config.indexConcurrency, Math.max(1, missing.length)) }, worker));
		if (cacheNeedsRewrite) await this.persist();
		else if (missing.length > 0) this.scheduleWrite();
		this.ready = true;
	}
	acceptLive(session, event) {
		const id = String(session.id);
		let summary = this.sessions.get(id);
		if (summary === void 0) {
			summary = summarizeSession(session.header, []);
			this.sessions.set(id, summary);
		}
		let state = this.collectors.get(id);
		if (state === void 0) {
			state = newCollectState();
			this.collectors.set(id, state);
		}
		if (appendActivity(summary, event, Date.now(), state)) {
			this.callsCache = void 0;
			this.scheduleWrite();
		}
	}
	/** Returns true when an existing cache must be replaced after reindexing. */
	async loadCache() {
		try {
			const parsed = JSON.parse(await readFile(this.cachePath, "utf8"));
			if (!isCache(parsed)) return true;
			for (const session of parsed.sessions) if (typeof session.id === "string" && Array.isArray(session.activities)) this.sessions.set(session.id, session);
			return false;
		} catch (error) {
			if (error.code !== "ENOENT") {
				this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)));
				return true;
			}
			return false;
		}
	}
	scheduleWrite() {
		if (this.disposed || this.writeTimer !== void 0) return;
		this.writeTimer = setTimeout(() => {
			this.writeTimer = void 0;
			this.persist().catch((error) => this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error))));
		}, this.config.cacheWriteDelayMs);
		this.writeTimer.unref?.();
	}
	async persist() {
		const data = {
			schema: 4,
			sessions: [...this.sessions.values()]
		};
		const temporary = `${this.cachePath}.${process.pid}.tmp`;
		await mkdir(dirname(this.cachePath), { recursive: true });
		await writeFile(temporary, JSON.stringify(data), {
			encoding: "utf8",
			mode: 384
		});
		await rename(temporary, this.cachePath);
	}
	async handle(req, res) {
		if (req.method !== "GET" && req.method !== "HEAD") {
			res.writeHead(405, { allow: "GET, HEAD" });
			res.end();
			return;
		}
		try {
			const path = new URL(req.url ?? "/", "http://localhost").pathname;
			if (path === `${this.config.apiPath}/calls`) {
				const query = parseQuery(req);
				const pagination = parsePagination(req);
				const filter = {
					...query,
					model: pagination.model,
					provider: pagination.provider,
					minInputTokens: pagination.minInputTokens,
					minOutputTokens: pagination.minOutputTokens,
					maxRecords: pagination.maxRecords
				};
				const cacheKey = JSON.stringify(filter);
				if (this.callsCache?.key !== cacheKey) this.callsCache = {
					key: cacheKey,
					rows: collectCalls(this.sessions.values(), filter)
				};
				const offset = (pagination.page - 1) * pagination.pageSize;
				const total = this.callsCache.rows.length;
				const page = {
					indexReady: this.ready,
					items: this.callsCache.rows.slice(offset, offset + pagination.pageSize),
					page: pagination.page,
					pageSize: pagination.pageSize,
					total,
					hasMore: total > pagination.page * pagination.pageSize
				};
				sendJson(res, 200, req.method === "HEAD" ? null : page);
				return;
			}
			const query = parseQuery(req);
			const snapshot = aggregateStats(this.sessions.values(), query);
			if (path === `${this.config.apiPath}/export.csv`) {
				const csv = exportCsv(snapshot);
				res.writeHead(200, {
					"content-type": "text/csv; charset=utf-8",
					"content-disposition": "attachment; filename=\"dsh-usage-stats.csv\"",
					"cache-control": "no-store",
					"x-content-type-options": "nosniff"
				});
				res.end(req.method === "HEAD" ? void 0 : `\uFEFF${csv}`);
				return;
			}
			if (path === `${this.config.apiPath}/export.json`) res.setHeader("content-disposition", "attachment; filename=\"dsh-usage-stats.json\"");
			else if (path !== `${this.config.apiPath}/snapshot`) {
				sendJson(res, 404, { error: "Not found" });
				return;
			}
			sendJson(res, 200, req.method === "HEAD" ? null : snapshot);
		} catch (error) {
			sendJson(res, 400, { error: error instanceof Error ? error.message : "Bad request" });
		}
	}
	async dispose() {
		this.disposed = true;
		if (this.writeTimer !== void 0) clearTimeout(this.writeTimer);
		await this.loading;
		await this.persist();
	}
};
function apply(ctx, config = {}) {
	new UsageIndex(ctx, {
		...config,
		indexConcurrency: config.indexConcurrency ?? 2,
		cacheWriteDelayMs: config.cacheWriteDelayMs ?? 1e3,
		apiPath: (config.apiPath ?? "/usage-stats/v1").replace(/\/$/, "")
	}).start();
}
//#endregion
export { Config, activityFromEvent, aggregateCalls, aggregateStats, appendActivity, apply, collectCalls, exportCsv, inject, name, newCollectState, summarizeSession };
