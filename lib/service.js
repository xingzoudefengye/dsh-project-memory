/**
 * `ctx.projectMemory` — bounded project memory as a service.
 *
 * The service owns three things the rest of the package must not duplicate:
 * where a session's `.ai/` root is, the per-session *frozen* projection that
 * the stable prompt section renders, and the single write path every caller
 * (tool, command, or another plugin) goes through.
 *
 * The freeze is deliberate. Memory files change while a session runs, and
 * re-reading them on every request would push the injected section in and out
 * of the provider's cached prefix for no gain — the model would see the same
 * knowledge arrive as a cache miss. So a session's projection is built once
 * and kept; a caller that genuinely needs newer content reads it explicitly,
 * and the next session starts from the current files.
 *
 * @module dsh-project-memory/service
 */

import { Service } from "@deepseek-ai/cordis";
import os from "node:os";
import path from "node:path";
import {
	MEMORY_DIR,
	compactMemory,
	entriesOf,
	forgetEntries,
	initMemory,
	memoryStatus,
	nodeFs,
	readMemory,
	readMemorySync,
	workspaceRoot,
	writeEntry
} from "./store.js";
import { selectForInjection } from "./entries.js";

/** Header line the injected section carries for the project layer. */
const INJECTION_HEADER = "项目记忆（本项目 .ai/ 的择优摘要；稳定的项目事实、决策、任务状态或坑，用 project_memory 记录，默认写本项目）：";

/** Header line for the global layer: cross-project conclusions only. */
const GLOBAL_HEADER = "全局记忆（跨项目通用结论；只有放之四海皆准的才用 project_memory scope=global 写入）：";

/**
 * Injection budget for the global layer alone. Project entries keep the full
 * budget they always had; the global layer gets a smaller one on top, so one
 * chatty machine-wide file cannot crowd out the project the session is in.
 */
const GLOBAL_INJECT_MAX_CHARS = 4_000;
const GLOBAL_INJECT_MAX_TOKENS = 1_000;

/**
 * Render one projection from both layers.
 *
 * Project entries come first with the full injection budget, global entries
 * after with their own smaller budget — the same project-over-user precedence
 * the industry settled on: the session's own project always wins the prompt.
 *
 * The single place the injected text is produced, so the asynchronous and
 * synchronous paths cannot drift apart.
 *
 * @param entries - every project entry across the five files.
 * @param globalEntries - every global entry across the five files.
 * @returns the injected text, or `""` when there is nothing to inject.
 */
function renderProjection(entries, globalEntries = []) {
	const sections = [];
	if (entries.length > 0) sections.push(selectForInjection(entries, { header: INJECTION_HEADER }).text);
	if (globalEntries.length > 0) {
		sections.push(
			selectForInjection(globalEntries, {
				header: GLOBAL_HEADER,
				maxChars: GLOBAL_INJECT_MAX_CHARS,
				maxTokens: GLOBAL_INJECT_MAX_TOKENS
			}).text
		);
	}
	return sections.join("\n");
}

/**
 * Render one projection without awaiting, for {@link ProjectMemory.injected}.
 *
 * A module-level function rather than a private method, deliberately: `injected`
 * is reached through `ctx.projectMemory`, and cordis hands that call a traceable
 * proxy instead of the registered instance. Public members read straight through
 * the proxy, but a private method call (`this.#renderSync`) fails its brand check
 * on a foreign receiver and throws "Receiver must be an instance of class
 * ProjectMemory" — which takes the whole turn down on the one assembly that
 * needs this fallback most. Passing the service in as an ordinary argument keeps
 * the receiver out of the private-brand business.
 *
 * @param service - the memory service, possibly reached through a proxy.
 * @param agent - the agent being assembled.
 * @returns the rendered text, or `""` when nothing can be read.
 */
function renderSync(service, agent) {
	try {
		return renderProjection(
			entriesOf(readMemorySync(service.root(agent), service.fs)),
			entriesOf(readMemorySync(service.globalRoot(), service.fs))
		);
	} catch {
		return "";
	}
}

export class ProjectMemory extends Service {
	/**
	 * @param ctx - owning cordis context.
	 * @param options - `{ fs, globalRoot }`: a filesystem port for tests, and
	 *   an override for the global layer root (also for tests).
	 */
	constructor(ctx, options = {}) {
		super(ctx, "projectMemory");
		this.fs = options.fs ?? nodeFs;
		this.globalRootOverride = options.globalRoot ?? null;
		/** Frozen injected text per session id. */
		this.snapshots = new Map();
	}

	/**
	 * The `.ai` directory for one agent's workspace.
	 * @param agent - the agent whose session names the workspace.
	 * @returns an absolute path.
	 */
	root(agent) {
		const cwd = agent?.session?.header?.cwd ?? process.cwd();
		return path.join(workspaceRoot(cwd, this.fs), MEMORY_DIR);
	}

	/**
	 * Read every memory file for one agent.
	 * @param agent - the agent whose workspace to read.
	 * @returns `{ root, files, entries }`.
	 */
	async load(agent) {
		const root = this.root(agent);
		const files = await readMemory(root, this.fs);
		return { root, files, entries: entriesOf(files) };
	}

	/**
	 * The global layer root: the same five files, but machine-wide.
	 *
	 * Project memory follows the checkout (shared through git); global memory
	 * follows the machine (`$DSH_HOME/project-memory/`), which is what makes
	 * it visible from every project and what keeps it out of every project's
	 * repository. It is deliberately not committable alongside a project —
	 * moving machines copies one directory, not every checkout.
	 *
	 * @returns an absolute path.
	 */
	globalRoot() {
		if (this.globalRootOverride !== null) return this.globalRootOverride;
		const home = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
		return path.join(home, "project-memory");
	}

	/**
	 * Read every global memory file.
	 * @returns `{ root, files, entries }`, mirroring {@link load}.
	 */
	async loadGlobal() {
		const root = this.globalRoot();
		const files = await readMemory(root, this.fs);
		return { root, files, entries: entriesOf(files) };
	}

	/**
	 * Create the global templates when they are absent.
	 * @returns the file names created.
	 */
	async initGlobal() {
		return initMemory(this.globalRoot(), this.fs);
	}

	/**
	 * Capacity and entry counts for the global layer.
	 * @returns the report from the store.
	 */
	async statusGlobal() {
		return memoryStatus(this.globalRoot(), this.fs);
	}

	/**
	 * Write one entry to the global layer through the single write path.
	 * @param agent - unused for routing (kept for a symmetric signature).
	 * @param request - `{ file, entry }`.
	 * @returns the store's outcome.
	 */
	async writeGlobal(agent, request) {
		return writeEntry(this.globalRoot(), { ...request, fs: this.fs });
	}

	/**
	 * Forget global entries, previewing unless `apply` is set.
	 */
	async forgetGlobal(selector, options = {}) {
		return forgetEntries(this.globalRoot(), selector, { ...options, fs: this.fs });
	}

	/**
	 * Coarsen global details toward the target capacity.
	 */
	async compactGlobal(options = {}) {
		return compactMemory(this.globalRoot(), { ...options, fs: this.fs });
	}

	/**
	 * Promote one project entry to the global layer.
	 *
	 * The entry keeps its id, kind, status, conclusion, details, and date —
	 * promotion copies knowledge, it does not rewrite it. Preview by default;
	 * only `apply: true` writes, through the same capacity-checked write path.
	 *
	 * @param agent - the agent whose project to promote from.
	 * @param id - the project entry id.
	 * @param options - `{ apply }`.
	 * @returns `{ ok, file, entry, reason? }`.
	 */
	async promote(agent, id, options = {}) {
		const { entries } = await this.load(agent);
		const entry = entries.find((candidate) => candidate.id === id);
		if (entry === undefined) return { ok: false, reason: `no project entry with id ${JSON.stringify(id)}` };
		if (options.apply !== true) return { ok: true, file: entry.file, entry, applied: false };
		const { file, ...rest } = entry;
		const outcome = await this.writeGlobal(agent, { file: entry.file, entry: rest });
		if (!outcome.ok) return { ok: false, file: entry.file, entry, reason: outcome.reason };
		return { ok: true, file: entry.file, entry, applied: true };
	}

	/**
	 * Build and freeze one session's injected projection.
	 *
	 * Idempotent: once a session has a projection, calling again is a no-op
	 * unless `force` is set, so a caller may safely await it on every step to
	 * close the gap between the asynchronous read and the first assembly.
	 *
	 * Failures are swallowed: a workspace whose memory cannot be read must
	 * still be able to run a turn, and an absent `.ai/` is a normal state
	 * rather than an error.
	 *
	 * @param agent - the agent whose session is being projected.
	 * @param options - `{ force }` to re-read the files.
	 * @returns the frozen text.
	 */
	async prepare(agent, options = {}) {
		const id = sessionKey(agent);
		if (id === undefined) return "";
		const existing = this.snapshots.get(id);
		if (existing !== undefined && options.force !== true) return existing;
		try {
			const { entries } = await this.load(agent);
			const global = await this.loadGlobal();
			const frozen = renderProjection(entries, global.entries);
			this.snapshots.set(id, frozen);
			return frozen;
		} catch {
			this.snapshots.set(id, "");
			return "";
		}
	}

	/**
	 * The frozen projection for one agent, for synchronous prompt assembly.
	 *
	 * Prompt sections are synchronous, so the one assembly that can run before
	 * {@link prepare} finishes — the first step of a session — would otherwise
	 * render nothing. Rather than let the first answer of every session run
	 * without its standing constraints, this falls back to one synchronous read
	 * of the five files and caches the result. It is bounded (five small files,
	 * once per session) and only ever runs while the snapshot is missing; a
	 * port with no synchronous read degrades to an empty section for that one
	 * assembly.
	 *
	 * @param agent - the agent being assembled.
	 * @returns the frozen text, or `""` when the workspace has no memory.
	 */
	injected(agent) {
		const id = sessionKey(agent);
		if (id === undefined) return "";
		const existing = this.snapshots.get(id);
		if (existing !== undefined) return existing;
		const frozen = renderSync(this, agent);
		this.snapshots.set(id, frozen);
		return frozen;
	}

	/**
	 * Drop a session's frozen projection, so the next assembly rebuilds it.
	 * @param agent - the agent whose session to forget.
	 */
	release(agent) {
		const id = sessionKey(agent);
		if (id !== undefined) this.snapshots.delete(id);
	}

	/**
	 * Create the `.ai/` templates when they are absent.
	 * @param agent - the agent whose workspace to initialize.
	 * @returns the file names created.
	 */
	async init(agent) {
		const created = await initMemory(this.root(agent), this.fs);
		await this.prepare(agent);
		return created;
	}

	/**
	 * Capacity and entry counts for one workspace.
	 * @param agent - the agent whose workspace to report on.
	 * @returns the report from the store.
	 */
	async status(agent) {
		return memoryStatus(this.root(agent), this.fs);
	}

	/**
	 * Write one entry through the single write path.
	 * @param agent - the agent whose workspace to write.
	 * @param request - `{ file, entry }`.
	 * @returns the store's outcome.
	 */
	async write(agent, request) {
		const outcome = await writeEntry(this.root(agent), { ...request, fs: this.fs });
		// The frozen projection deliberately does not follow a mid-session
		// write: the next session picks it up, and this one reads it on demand.
		return outcome;
	}

	/**
	 * Forget entries, previewing unless `apply` is set.
	 * @param agent - the agent whose workspace to edit.
	 * @param selector - `{ id?, date?, query? }`.
	 * @param options - `{ apply }`.
	 * @returns the store's result.
	 */
	async forget(agent, selector, options = {}) {
		return forgetEntries(this.root(agent), selector, { ...options, fs: this.fs });
	}

	/**
	 * Coarsen details toward the target capacity.
	 * @param agent - the agent whose workspace to compact.
	 * @param options - `{ apply }`.
	 * @returns the store's result.
	 */
	async compact(agent, options = {}) {
		return compactMemory(this.root(agent), { ...options, fs: this.fs });
	}
}

/**
 * The session identity a snapshot is keyed by.
 * @param agent - the agent, if any.
 * @returns the session id, or `undefined` when there is no session.
 */
function sessionKey(agent) {
	const id = agent?.session?.id;
	return id === undefined ? undefined : String(id);
}

export default ProjectMemory;
