/**
 * Filesystem side of project memory: where the `.ai/` root is, how the five
 * files are read and rewritten, and the capacity rules every write obeys.
 *
 * Two invariants shape this module. First, a write is all-or-nothing: the
 * text is validated against the hard ceiling *before* anything touches disk,
 * and it lands through a temporary file plus a rename, so a crash cannot leave
 * a half-written memory file. Second, an external edit wins: if a file changed
 * between the read and the write, the write fails loudly instead of silently
 * reverting whatever a human or another tool put there.
 *
 * The filesystem is a port, not an import, so the rules above are testable
 * without touching a real directory and a deployment can route I/O through the
 * harness's own filesystem service.
 *
 * @module dsh-project-memory/store
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	MEMORY_FILES,
	MEMORY_FILE_NAMES,
	MEMORY_TARGET_CHARS,
	capacityOf,
	coarsenEntries,
	fileUnderMostPressure,
	makeEntry,
	parseMemoryFile,
	removeEntries,
	renderEntry,
	templateFor,
	upsertEntry
} from "./entries.js";

/** Directory under the workspace root that holds memory, committable to git. */
export const MEMORY_DIR = ".ai";

/** Subdirectory for machine state that must not be committed. */
export const MEMORY_LOCAL_DIR = ".local";

/** The `.gitignore` this package maintains inside `.ai/`. */
const GITIGNORE_TEXT = `${MEMORY_LOCAL_DIR}/\n`;

/** Default filesystem port backed by `node:fs/promises`. */
export const nodeFs = {
	async read(target) {
		try {
			return await readFile(target, "utf8");
		} catch (error) {
			if (error?.code === "ENOENT") return null;
			throw error;
		}
	},
	async write(target, text) {
		await writeFile(target, text, "utf8");
	},
	async mkdir(target) {
		await mkdir(target, { recursive: true });
	},
	async rename(from, to) {
		await rename(from, to);
	},
	exists(target) {
		return existsSync(target);
	}
};

/**
 * Walk up from a directory to the workspace root that owns it.
 *
 * A `.git` entry — file or directory, since a worktree and a submodule use a
 * file — marks the root, which is what makes memory shared by everyone working
 * in that checkout rather than trapped in whatever subdirectory an agent
 * happened to start in.
 *
 * @param start - the directory to start from.
 * @param fs - filesystem port; defaults to {@link nodeFs}.
 * @returns the workspace root.
 */
export function workspaceRoot(start, fs = nodeFs) {
	let current = path.resolve(start);
	for (;;) {
		if (fs.exists(path.join(current, ".git"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return path.resolve(start);
		current = parent;
	}
}

/**
 * Content hash of a file's text, used to detect an edit between read and write.
 * @param text - the file's text, or `null` when the file does not exist.
 * @returns a short stable digest.
 */
export function revisionOf(text) {
	return createHash("sha256").update(text ?? "\u0000absent").digest("hex").slice(0, 16);
}

/**
 * Read the five files under one root.
 *
 * @param root - the `.ai` directory.
 * @param fs - filesystem port; defaults to {@link nodeFs}.
 * @returns `[{ name, text, revision }]` in {@link MEMORY_FILES} order; a file
 *   that does not exist reads as empty text.
 */
export async function readMemory(root, fs = nodeFs) {
	const files = [];
	for (const file of MEMORY_FILES) {
		const text = (await fs.read(path.join(root, file.name))) ?? "";
		files.push({ name: file.name, text, revision: revisionOf(text) });
	}
	return files;
}

/**
 * Every entry across the five files, tagged with the file it came from.
 *
 * @param files - the result of {@link readMemory}.
 * @returns `[{ ...entry, file }]`.
 */
export function entriesOf(files) {
	const all = [];
	for (const file of files) {
		for (const entry of parseMemoryFile(file.text).entries) all.push({ ...entry, file: file.name });
	}
	return all;
}

/**
 * Write one file through a temporary path, keeping a recovery copy.
 *
 * @param root - the `.ai` directory.
 * @param name - a whitelisted file name.
 * @param text - the new content.
 * @param fs - filesystem port; defaults to {@link nodeFs}.
 */
async function writeAtomic(root, name, text, fs) {
	await fs.mkdir(root);
	const target = path.join(root, name);
	const previous = await fs.read(target);
	if (previous !== null && previous !== "") {
		// One recovery copy, overwritten each time: enough to undo the latest
		// write without growing the workspace with a backup history.
		await fs.write(`${target}.bak`, previous);
	}
	const temporary = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`;
	await fs.write(temporary, text);
	await fs.rename(temporary, target);
}

/**
 * Ensure the `.ai` directory exists with its template files and ignore rule.
 *
 * @param root - the `.ai` directory.
 * @param fs - filesystem port; defaults to {@link nodeFs}.
 * @returns the file names created (empty when everything already existed).
 */
export async function initMemory(root, fs = nodeFs) {
	await fs.mkdir(root);
	const created = [];
	for (const file of MEMORY_FILES) {
		const target = path.join(root, file.name);
		if (await fs.read(target) !== null) continue;
		await writeAtomic(root, file.name, templateFor(file.name), fs);
		created.push(file.name);
	}
	const ignore = path.join(root, ".gitignore");
	if (await fs.read(ignore) === null) await fs.write(ignore, GITIGNORE_TEXT);
	return created;
}

/**
 * The result of one attempted write.
 * @typedef {object} WriteOutcome
 * @property {boolean} ok - whether the file changed.
 * @property {string} file - the file the write targeted.
 * @property {string} [reason] - why the write was refused.
 * @property {number} [chars] - the resulting total characters.
 * @property {number} [bytes] - the resulting total bytes.
 * @property {boolean} [coarsened] - whether older details were trimmed to fit.
 * @property {string} [error] - a validation error, when one was thrown.
 */

/**
 * Validate, coarsen if needed, and write one entry.
 *
 * The entry is inserted first and the *result* is measured, because a single
 * entry can push a file past the ceiling and the honest answer is about the
 * file that would exist, not the one that does. When the result is over the
 * ceiling the older details are coarsened once; if it is still over, the write
 * is refused and the previous text is left exactly as it was.
 *
 * @param root - the `.ai` directory.
 * @param request - `{ file, entry, now?, fs?, coarsen? }`.
 * @returns a {@link WriteOutcome}; `ok: false` carries the reason.
 */
export async function writeEntry(root, request) {
	const fs = request.fs ?? nodeFs;
	const name = request.file;
	if (!MEMORY_FILE_NAMES.includes(name)) {
		return { ok: false, file: String(name), reason: `not a whitelisted memory file (expected one of ${MEMORY_FILE_NAMES.join(", ")})` };
	}
	let entry;
	try {
		entry = makeEntry({ ...request.entry, now: request.now });
	} catch (error) {
		return { ok: false, file: name, reason: error.message, error: error.message };
	}
	const files = await readMemory(root, fs);
	const target = files.find((file) => file.name === name);
	const nextText = upsertEntry(target.text, entry);
	return commitText(root, files, name, nextText, { fs, now: request.now, coarsen: request.coarsen !== false });
}

/**
 * Apply a candidate text to one file, coarsening other files when needed.
 *
 * @param root - the `.ai` directory.
 * @param files - the current files from {@link readMemory}.
 * @param name - the file being written.
 * @param nextText - the candidate content for that file.
 * @param options - `{ fs, now, coarsen }`.
 * @returns a {@link WriteOutcome}.
 */
async function commitText(root, files, name, nextText, options) {
	const fs = options.fs ?? nodeFs;
	const now = options.now ?? Date.now();
	const candidate = files.map((file) => (file.name === name ? { ...file, text: nextText } : file));
	let report = capacityOf(candidate);
	let coarsened = false;
	if (report.over && options.coarsen !== false) {
		// Coarsen the file under the most pressure first: that is where detail
		// is cheapest to give up, and it keeps unrelated files intact.
		const victim = fileUnderMostPressure(candidate) ?? name;
		const file = candidate.find((entry) => entry.name === victim);
		const { entries } = parseMemoryFile(file.text);
		const thinned = coarsenEntries(entries, { now, pressure: 2 });
		const rebuilt = reRenderEntries(file.text, thinned);
		const replaced = candidate.map((entry) => (entry.name === victim ? { ...entry, text: rebuilt } : entry));
		const thinnedReport = capacityOf(replaced);
		if (thinnedReport.chars < report.chars) {
			coarsened = true;
			candidate.splice(0, candidate.length, ...replaced);
			report = thinnedReport;
		}
	}
	if (report.over) {
		return {
			ok: false,
			file: name,
			reason: `would exceed the memory ceiling (${report.chars}/${report.maxChars} chars, ${report.bytes}/${report.maxBytes} bytes); coarsen or forget entries first`,
			chars: report.chars,
			bytes: report.bytes
		};
	}
	const target = candidate.find((file) => file.name === name);
	const current = files.find((file) => file.name === name);
	// A file that does not exist and an empty file are the same state to every
	// caller here, so compare them the same way; reading raw `null` would make
	// the first write to a fresh root look like a concurrent edit.
	const onDisk = (await fs.read(path.join(root, name))) ?? "";
	if (revisionOf(onDisk) !== current.revision) {
		return { ok: false, file: name, reason: "the file changed on disk while this write was being prepared; re-read and retry" };
	}
	await writeAtomic(root, name, target.text, fs);
	return { ok: true, file: name, chars: report.chars, bytes: report.bytes, coarsened };
}

/**
 * Re-render entries after coarsening, leaving every other line where it was.
 *
 * Coarsening only ever trims detail lines, so the edit is a splice per entry:
 * prose above, between, and below entries keeps its exact position, and a file
 * a human arranged stays arranged.
 *
 * @param original - the file's text before coarsening.
 * @param thinned - the entries returned by `coarsenEntries`.
 * @returns the rebuilt text.
 */
export function reRenderEntries(original, thinned) {
	const { entries } = parseMemoryFile(original);
	const lines = original.split("\n");
	const byId = new Map(thinned.map((entry) => [entry.id, entry]));
	for (const entry of [...entries].reverse()) {
		const next = byId.get(entry.id);
		if (next === undefined) continue;
		const rendered = renderEntry(next);
		if (rendered === renderEntry(entry)) continue;
		lines.splice(entry.startLine, entry.endLine - entry.startLine + 1, ...rendered.split("\n"));
	}
	return lines.join("\n");
}

/**
 * Forget entries across the five files.
 *
 * @param root - the `.ai` directory.
 * @param selector - `{ id?, date?, query? }`; at least one is required.
 * @param options - `{ apply?, fs? }`; without `apply` nothing is written.
 * @returns `{ matches, applied, files }`, where `matches` names what would go.
 */
export async function forgetEntries(root, selector, options = {}) {
	const fs = options.fs ?? nodeFs;
	const files = await readMemory(root, fs);
	const matches = [];
	const planned = [];
	for (const file of files) {
		const { entries } = parseMemoryFile(file.text);
		const doomed = match(entries, selector);
		if (doomed.length === 0) continue;
		matches.push(...doomed.map((entry) => ({ ...entry, file: file.name })));
		const ids = new Set(doomed.map((entry) => entry.id));
		const { text } = removeEntries(file.text, (entry) => ids.has(entry.id));
		planned.push({ name: file.name, text });
	}
	if (options.apply !== true || planned.length === 0) {
		return { matches, applied: false, files: planned.map((file) => file.name) };
	}
	for (const file of planned) {
		const current = files.find((candidate) => candidate.name === file.name);
		const onDisk = await fs.read(path.join(root, file.name));
		if (revisionOf(onDisk) !== current.revision) {
			return { matches, applied: false, files: [], reason: `${file.name} changed on disk; nothing was written` };
		}
		await writeAtomic(root, file.name, file.text, fs);
	}
	return { matches, applied: true, files: planned.map((file) => file.name) };
}

/**
 * Local copy of {@link matchForget}, kept private so this module does not
 * re-export a second public matcher.
 * @param entries - parsed entries.
 * @param selector - `{ id?, date?, query? }`.
 * @returns the matching entries.
 */
function match(entries, selector) {
	const { id, date, query } = selector ?? {};
	if (id === undefined && date === undefined && query === undefined) {
		throw new Error("project memory: forget needs at least one of id, date, or query");
	}
	return entries.filter((entry) => {
		if (id !== undefined && entry.id !== id) return false;
		if (date !== undefined && entry.date !== date) return false;
		if (query !== undefined && !`${entry.id} ${entry.conclusion} ${(entry.details ?? []).join(" ")}`.includes(query)) return false;
		return true;
	});
}

/**
 * Coarsen one root's files until they fit the target, writing what changed.
 *
 * @param root - the `.ai` directory.
 * @param options - `{ now?, fs?, apply? }`.
 * @returns `{ before, after, files, applied }` capacity reports.
 */
export async function compactMemory(root, options = {}) {
	const fs = options.fs ?? nodeFs;
	const files = await readMemory(root, fs);
	const before = capacityOf(files);
	if (!before.nearTarget) return { before, after: before, files: [], applied: false };
	const now = options.now ?? Date.now();
	const planned = [];
	for (const file of files) {
		const { entries } = parseMemoryFile(file.text);
		if (entries.length === 0) continue;
		const thinned = coarsenEntries(entries, { now, pressure: 2 });
		const text = reRenderEntries(file.text, thinned);
		if (text !== file.text) planned.push({ name: file.name, text });
	}
	const after = capacityOf(files.map((file) => planned.find((plan) => plan.name === file.name) ?? file));
	if (options.apply !== true) return { before, after, files: planned.map((file) => file.name), applied: false };
	for (const file of planned) await writeAtomic(root, file.name, file.text, fs);
	return { before, after, files: planned.map((file) => file.name), applied: true };
}

/**
 * A human-readable capacity report for one root.
 *
 * @param root - the `.ai` directory.
 * @param fs - filesystem port; defaults to {@link nodeFs}.
 * @returns `{ report, files, entries, exists }`.
 */
export async function memoryStatus(root, fs = nodeFs) {
	const exists = fs.exists(root);
	const files = await readMemory(root, fs);
	const report = capacityOf(files);
	return {
		report,
		exists,
		files: files.map((file) => ({
			name: file.name,
			chars: file.text.length,
			entries: parseMemoryFile(file.text).entries.length
		})),
		entries: entriesOf(files).length
	};
}
