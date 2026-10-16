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
	workspaceRoot,
	writeEntry
} from "./store.js";
import { selectForInjection } from "./entries.js";

/** Header line the injected section carries, including how to add to it. */
const INJECTION_HEADER = "项目记忆（工作区 .ai/ 的择优摘要；发现稳定的项目事实、决策、任务状态或坑时，用 project_memory 工具记录）：";

export class ProjectMemory extends Service {
	/**
	 * @param ctx - owning cordis context.
	 * @param options - `{ fs }`, a filesystem port for tests.
	 */
	constructor(ctx, options = {}) {
		super(ctx, "projectMemory");
		this.fs = options.fs ?? nodeFs;
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
			const { text } = selectForInjection(entries, { header: entries.length === 0 ? "" : INJECTION_HEADER });
			const frozen = entries.length === 0 ? "" : text;
			this.snapshots.set(id, frozen);
			return frozen;
		} catch {
			this.snapshots.set(id, "");
			return "";
		}
	}

	/**
	 * The frozen projection for one agent, for synchronous prompt assembly.
	 * @param agent - the agent being assembled.
	 * @returns the frozen text, or `""` before {@link prepare} has run.
	 */
	injected(agent) {
		const id = sessionKey(agent);
		return id === undefined ? "" : this.snapshots.get(id) ?? "";
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
