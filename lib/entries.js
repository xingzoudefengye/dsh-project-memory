/**
 * Bounded project memory: entry format, capacity accounting, tiered retention,
 * and injection selection for the five whitelisted `.ai/` Markdown files.
 *
 * The format is deliberately line-oriented so a human can edit these files in
 * any editor and `git diff` stays readable: one entry per line, optional
 * nested detail lines under it, and everything else left alone as prose. A
 * fenced code block is never scanned for entries, so a file may document the
 * format with examples without those examples becoming memory.
 *
 * Nothing here calls a model, and nothing here touches the filesystem — the
 * store owns I/O, which keeps these folds directly testable and lets the
 * injector reuse them without a live harness.
 *
 * @module dsh-project-memory/entries
 */

/**
 * The five files this package owns, in the order they are injected.
 *
 * A file's `quotaChars` is a soft share of {@link MEMORY_TOTAL_MAX_CHARS}: a
 * file may borrow from another, but the total never moves. The quota decides
 * which file coarsens first under pressure, not whether a write is legal.
 */
export const MEMORY_FILES = [
	{ name: "project.md", title: "项目", quotaChars: 4_000 },
	{ name: "decisions.md", title: "决策", quotaChars: 6_000 },
	{ name: "tasks.md", title: "任务", quotaChars: 5_000 },
	{ name: "bugs.md", title: "坑与缺陷", quotaChars: 5_000 },
	{ name: "memory.md", title: "其他事实", quotaChars: 4_000 }
];

/** File names this package may write, as a set for whitelist checks. */
export const MEMORY_FILE_NAMES = MEMORY_FILES.map((file) => file.name);

/** Hard ceiling for the five files together, in characters. */
export const MEMORY_TOTAL_MAX_CHARS = 24_000;

/** Hard ceiling for the five files together, in UTF-8 bytes. */
export const MEMORY_TOTAL_MAX_BYTES = 65_536;

/** Coarsening aims below the hard ceiling, leaving room for the next entry. */
export const MEMORY_TARGET_CHARS = 19_000;

/** Ceiling for the text this package injects into one model request. */
export const INJECT_MAX_CHARS = 12_000;

/** Ceiling for the same text in estimated tokens. */
export const INJECT_MAX_TOKENS = 4_000;

/** Entry statuses. `superseded` entries are retained but never injected. */
export const STATUSES = ["active", "done", "resolved", "superseded"];

/** Entry kinds, in the order the injector prefers them. */
export const KINDS = ["constraint", "task", "bug", "decision", "fact", "history"];

/** Detail lines survive in full for this many days after the entry date. */
const DETAIL_DAYS = 7;

/** Detail lines collapse to at most this many per entry after {@link DETAIL_DAYS}. */
const PHASE_KEEP_DETAILS = 2;

/** Beyond this many days an entry keeps its conclusion and no detail at all. */
const PHASE_DAYS = 30;

/** `- YYYY-MM-DD [id=…] [status=…] [kind=…]: conclusion` */
const ENTRY_RE = /^- (\d{4}-\d{2}-\d{2}) \[id=([^\]\s]+)\] \[status=([a-z]+)\] \[kind=([a-z]+)\]: (.+)$/;

/** A nested detail line under an entry. */
const DETAIL_RE = /^ {2,}- (.+)$/;

/** A fenced code block delimiter. */
const FENCE_RE = /^\s*(```|~~~)/;

/** Milliseconds in one day, for age comparisons. */
const DAY_MS = 86_400_000;

/**
 * Estimate tokens for mixed Chinese/English text without a tokenizer.
 *
 * CJK codepoints are close to one token each; everything else is close to one
 * token per four characters. This is an estimate for budgeting, never a
 * provider usage figure, and callers with a real tokenizer should pass their
 * own `estimateTokens` instead.
 *
 * @param text - the text to estimate.
 * @returns a non-negative token estimate.
 */
export function estimateTokens(text) {
	let cjk = 0;
	let other = 0;
	for (const char of text) {
		if (char.codePointAt(0) >= 0x2e80) cjk += 1;
		else other += 1;
	}
	return cjk + Math.ceil(other / 4);
}

/**
 * Count the UTF-8 bytes in a string.
 * @param text - the text to measure.
 * @returns the byte length.
 */
export function byteLength(text) {
	return Buffer.byteLength(text, "utf8");
}

/**
 * Split a file into its entries plus the prose between them.
 *
 * Every line that is not part of an entry is prose and is preserved verbatim
 * by every rewrite, so headings, notes, and format examples survive edits.
 *
 * @param text - the file's full text.
 * @returns `{ entries, prose }`, where each entry records its `startLine` and
 *   `endLine` (inclusive, 0-based) in `text`.
 */
export function parseMemoryFile(text) {
	const lines = text.split("\n");
	const entries = [];
	const proseLines = [];
	let inFence = false;
	let current = null;
	const flush = () => {
		if (current !== null) entries.push(current);
		current = null;
	};
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (FENCE_RE.test(line)) {
			inFence = !inFence;
			flush();
			proseLines.push(index);
			continue;
		}
		if (inFence) {
			proseLines.push(index);
			continue;
		}
		const match = ENTRY_RE.exec(line);
		if (match !== null) {
			flush();
			current = {
				date: match[1],
				id: match[2],
				status: match[3],
				kind: match[4],
				conclusion: match[5].trim(),
				details: [],
				startLine: index,
				endLine: index
			};
			continue;
		}
		if (current !== null) {
			const detail = DETAIL_RE.exec(line);
			if (detail !== null) {
				current.details.push(detail[1].trim());
				current.endLine = index;
				continue;
			}
			if (line.trim() === "") {
				// A blank line ends the entry but stays in the file.
				flush();
				proseLines.push(index);
				continue;
			}
		}
		flush();
		proseLines.push(index);
	}
	flush();
	return { entries, prose: proseLines };
}

/**
 * Render one entry as its canonical lines.
 *
 * @param entry - an entry with `date`, `id`, `status`, `kind`, `conclusion`,
 *   and optional `details`.
 * @returns the entry's text, without a trailing newline.
 */
export function renderEntry(entry) {
	const head = `- ${entry.date} [id=${entry.id}] [status=${entry.status}] [kind=${entry.kind}]: ${entry.conclusion}`;
	const details = (entry.details ?? []).map((detail) => `  - ${detail}`);
	return [head, ...details].join("\n");
}

/**
 * Build one entry, normalizing its fields and rejecting an unusable one.
 *
 * @param input - `{ id, kind, conclusion, details?, status?, date? }`.
 * @returns a normalized entry.
 * @throws {Error} when the id, kind, status, or conclusion is not usable.
 */
export function makeEntry(input) {
	const id = String(input.id ?? "").trim();
	if (id === "" || /[\s\]]/.test(id)) {
		throw new Error(`project memory: id must be a non-empty token without spaces or ']' (got ${JSON.stringify(input.id)})`);
	}
	const kind = String(input.kind ?? "").trim();
	if (!KINDS.includes(kind)) {
		throw new Error(`project memory: kind must be one of ${KINDS.join(", ")} (got ${JSON.stringify(input.kind)})`);
	}
	const status = String(input.status ?? "active").trim();
	if (!STATUSES.includes(status)) {
		throw new Error(`project memory: status must be one of ${STATUSES.join(", ")} (got ${JSON.stringify(input.status)})`);
	}
	const conclusion = String(input.conclusion ?? "").replace(/\s+/g, " ").trim();
	if (conclusion === "") throw new Error("project memory: conclusion must not be empty");
	const date = String(input.date ?? todayIso(input.now)).trim();
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		throw new Error(`project memory: date must be YYYY-MM-DD (got ${JSON.stringify(input.date)})`);
	}
	const details = Array.isArray(input.details)
		? input.details.map((detail) => String(detail).replace(/\s+/g, " ").trim()).filter((detail) => detail !== "")
		: [];
	return { date, id, status, kind, conclusion, details };
}

/**
 * Today's date in `YYYY-MM-DD`.
 * @param now - optional epoch milliseconds, for tests.
 * @returns the ISO date.
 */
export function todayIso(now) {
	const at = now === undefined ? new Date() : new Date(now);
	return at.toISOString().slice(0, 10);
}

/**
 * Replace an entry with the same id, or append when the id is new.
 *
 * An update rewrites the entry in place — same line range, new fields — so a
 * file keeps its reading order across updates and `git diff` shows one changed
 * entry instead of a delete plus an append. An append goes at the end, after
 * the last entry, so prose above the entries is never displaced.
 *
 * @param text - the file's current text.
 * @param entry - a normalized entry from {@link makeEntry}.
 * @returns the new text.
 */
export function upsertEntry(text, entry) {
	const { entries } = parseMemoryFile(text);
	const lines = text.split("\n");
	const existing = entries.find((candidate) => candidate.id === entry.id);
	const rendered = renderEntry(entry).split("\n");
	if (existing !== undefined) {
		lines.splice(existing.startLine, existing.endLine - existing.startLine + 1, ...rendered);
		return lines.join("\n");
	}
	const last = entries.at(-1);
	if (last === undefined) {
		const trimmed = text.replace(/\n*$/, "");
		return `${trimmed === "" ? "" : `${trimmed}\n`}${renderEntry(entry)}\n`;
	}
	const after = lines.slice(last.endLine + 1);
	const before = lines.slice(0, last.endLine + 1);
	return [...before, ...rendered, ...after].join("\n");
}

/**
 * Drop every entry matching a predicate, leaving prose untouched.
 *
 * @param text - the file's current text.
 * @param predicate - called with each parsed entry; `true` removes it.
 * @returns `{ text, removed }` with the surviving text and the removed entries.
 */
export function removeEntries(text, predicate) {
	const { entries } = parseMemoryFile(text);
	const doomed = entries.filter((entry) => predicate(entry));
	if (doomed.length === 0) return { text, removed: [] };
	const lines = text.split("\n");
	for (const entry of [...doomed].reverse()) {
		lines.splice(entry.startLine, entry.endLine - entry.startLine + 1);
	}
	// Collapse a run of blank lines left behind, so repeated forgetting does
	// not grow the file with separators.
	const collapsed = [];
	for (const line of lines) {
		if (line.trim() === "" && collapsed.at(-1)?.trim() === "") continue;
		collapsed.push(line);
	}
	return { text: collapsed.join("\n"), removed: doomed };
}

/**
 * Age of an entry in whole days, relative to `now`.
 * @param entry - an entry with a `date`.
 * @param now - epoch milliseconds.
 * @returns the age in days, or `0` for an unparsable or future date.
 */
export function ageInDays(entry, now) {
	const at = Date.parse(`${entry.date}T00:00:00Z`);
	if (Number.isNaN(at)) return 0;
	const days = Math.floor((now - at) / DAY_MS);
	return days > 0 ? days : 0;
}

/**
 * Whether an entry is protected from age-based dropping.
 *
 * A standing constraint, an unfinished task, or an open bug is current
 * knowledge: age must not retire it, because nothing about getting older makes
 * it stop being true or undone.
 *
 * @param entry - the entry to classify.
 * @returns `true` when the entry must survive coarsening.
 */
export function isProtected(entry) {
	if (entry.status !== "active") return false;
	return entry.kind === "constraint" || entry.kind === "task" || entry.kind === "bug";
}

/**
 * Coarsen detail lines by age: recent keeps everything, middle keeps the tail,
 * old keeps nothing. Conclusions are never rewritten.
 *
 * @param entries - parsed entries.
 * @param options - `{ now, pressure }`; `pressure` of `1` is the normal
 *   schedule, higher values coarsen one tier earlier.
 * @returns the entries with adjusted `details` arrays.
 */
export function coarsenEntries(entries, options = {}) {
	const now = options.now ?? Date.now();
	const pressure = options.pressure ?? 1;
	const scale = pressure >= 2 ? 0.5 : 1;
	return entries.map((entry) => {
		// A standing constraint or unfinished work keeps its detail: getting
		// older does not make it less true or less undone, so age is the wrong
		// reason to thin it.
		if (isProtected(entry)) return entry;
		const age = ageInDays(entry, now);
		const details = entry.details ?? [];
		if (age <= DETAIL_DAYS * scale) return entry;
		if (age <= PHASE_DAYS * scale) {
			return { ...entry, details: details.slice(-PHASE_KEEP_DETAILS) };
		}
		return { ...entry, details: [] };
	});
}

/**
 * Inject priority of one entry: lower sorts first.
 *
 * Standing constraints outrank unfinished work, which outranks decisions, then
 * facts, then history. A `superseded` entry sorts last because it is kept only
 * as an audit trail.
 *
 * @param entry - the entry to rank.
 * @returns a numeric rank.
 */
export function priorityOf(entry) {
	if (entry.status === "superseded") return 5;
	if (entry.kind === "constraint") return 0;
	if (entry.status === "active" && (entry.kind === "task" || entry.kind === "bug")) return 1;
	if (entry.kind === "decision") return 2;
	if (entry.kind === "fact") return 3;
	return 4;
}

/**
 * Order entries for injection: by priority, then newest first, then id.
 *
 * The ordering is total and content-derived, so the same files always render
 * the same text. That stability is what keeps the injected section out of the
 * cached prefix's way: unchanged memory produces byte-identical text.
 *
 * @param entries - parsed entries.
 * @returns a new, sorted array.
 */
export function orderForInjection(entries) {
	return [...entries].sort((left, right) => {
		const byPriority = priorityOf(left) - priorityOf(right);
		if (byPriority !== 0) return byPriority;
		if (left.date !== right.date) return left.date < right.date ? 1 : -1;
		return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
	});
}

/**
 * Render one line for the injected section.
 * @param entry - the entry to render.
 * @returns a single compact line.
 */
export function renderInjectedLine(entry) {
	const marker = entry.status === "active" ? "" : ` (${entry.status})`;
	return `- [${entry.kind}] ${entry.date} ${entry.conclusion}${marker}`;
}

/**
 * Select the entries to inject and render them inside the budget.
 *
 * The budget is enforced on both characters and estimated tokens, because a
 * character cap alone under-counts CJK. Whatever does not fit is reported as a
 * count rather than silently dropped, and the caller is told where to read the
 * rest — an injected section that quietly hid knowledge would be worse than a
 * smaller one that says what it left out.
 *
 * @param entries - parsed entries from every file.
 * @param options - `{ maxChars, maxTokens, estimateTokens, header }`.
 * @returns `{ text, included, dropped }`.
 */
export function selectForInjection(entries, options = {}) {
	const maxChars = options.maxChars ?? INJECT_MAX_CHARS;
	const maxTokens = options.maxTokens ?? INJECT_MAX_TOKENS;
	const estimate = options.estimateTokens ?? estimateTokens;
	const header = options.header ?? "";
	const ordered = orderForInjection(entries.filter((entry) => entry.status !== "superseded"));
	const included = [];
	const lines = [];
	let chars = header === "" ? 0 : header.length + 1;
	let tokens = header === "" ? 0 : estimate(header);
	for (const entry of ordered) {
		const line = renderInjectedLine(entry);
		const nextChars = chars + line.length + 1;
		const nextTokens = tokens + estimate(line) + 1;
		// Skip rather than stop: one unusually long conclusion must not starve
		// every lower-priority entry behind it. Priority still decides what is
		// considered first, and the dropped count below keeps the omission
		// visible instead of silent.
		if (nextChars > maxChars || nextTokens > maxTokens) continue;
		included.push(entry);
		lines.push(line);
		chars = nextChars;
		tokens = nextTokens;
	}
	const dropped = ordered.length - included.length;
	const body = dropped > 0
		? `${lines.join("\n")}\n（另有 ${dropped} 条未注入：按容量择优，完整条目请用 project_memory 工具 action=read 读取）`
		: lines.join("\n");
	const text = header === "" ? body : `${header}\n${body}`;
	return { text, included, dropped };
}

/**
 * Total capacity of a set of files, as the store and the report both need it.
 *
 * @param files - `[{ name, text }]`.
 * @returns `{ chars, bytes, maxChars, maxBytes, targetChars, over, nearTarget }`.
 */
export function capacityOf(files) {
	let chars = 0;
	let bytes = 0;
	for (const file of files) {
		chars += file.text.length;
		bytes += byteLength(file.text);
	}
	return {
		chars,
		bytes,
		maxChars: MEMORY_TOTAL_MAX_CHARS,
		maxBytes: MEMORY_TOTAL_MAX_BYTES,
		targetChars: MEMORY_TARGET_CHARS,
		over: chars > MEMORY_TOTAL_MAX_CHARS || bytes > MEMORY_TOTAL_MAX_BYTES,
		nearTarget: chars > MEMORY_TARGET_CHARS
	};
}

/**
 * The file most over its own quota, which coarsens first under pressure.
 *
 * @param files - `[{ name, text }]`.
 * @returns the file name, or `undefined` when nothing is over quota.
 */
export function fileUnderMostPressure(files) {
	let worst;
	let worstRatio = 1;
	for (const file of files) {
		const quota = MEMORY_FILES.find((candidate) => candidate.name === file.name)?.quotaChars;
		if (quota === undefined) continue;
		const ratio = file.text.length / quota;
		if (ratio > worstRatio) {
			worstRatio = ratio;
			worst = file.name;
		}
	}
	return worst;
}

/**
 * Match entries for an explicit forget request.
 *
 * At least one selector is required: forgetting everything because no selector
 * was given would be the one destructive default this format must not have.
 *
 * @param entries - parsed entries.
 * @param selector - `{ id?, date?, query? }`; all given selectors must match.
 * @returns the matching entries.
 * @throws {Error} when no selector is given.
 */
export function matchForget(entries, selector = {}) {
	const { id, date, query } = selector;
	if (id === undefined && date === undefined && query === undefined) {
		throw new Error("project memory: forget needs at least one of id, date, or query");
	}
	return entries.filter((entry) => {
		if (id !== undefined && entry.id !== id) return false;
		if (date !== undefined && entry.date !== date) return false;
		if (query !== undefined) {
			const haystack = `${entry.id} ${entry.conclusion} ${(entry.details ?? []).join(" ")}`;
			if (!haystack.includes(query)) return false;
		}
		return true;
	});
}

/**
 * A file's starter text, so `memory init` writes something useful.
 * @param name - one of {@link MEMORY_FILE_NAMES}.
 * @returns the template text.
 */
export function templateFor(name) {
	const file = MEMORY_FILES.find((candidate) => candidate.name === name);
	const title = file?.title ?? "记忆";
	return [
		`# ${title}`,
		"",
		"条目格式（供人读写，程序按此解析）：",
		"",
		"```text",
		"- YYYY-MM-DD [id=稳定标识] [status=active|done|resolved|superseded] [kind=constraint|decision|task|bug|fact|history]: 当前完整结论",
		"  - 可选嵌套详情",
		"```",
		""
	].join("\n");
}
