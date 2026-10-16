import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { MEMORY_TOTAL_MAX_CHARS, makeEntry, parseMemoryFile } from "../lib/entries.js";
import {
	compactMemory,
	entriesOf,
	forgetEntries,
	initMemory,
	memoryStatus,
	readMemory,
	reRenderEntries,
	revisionOf,
	workspaceRoot,
	writeEntry
} from "../lib/store.js";

/**
 * An in-memory filesystem port keyed by absolute path.
 * @param initial - seed files.
 * @returns a port plus its backing map.
 */
function fakeFs(initial = {}) {
	const files = new Map(Object.entries(initial));
	return {
		files,
		async read(target) {
			return files.has(target) ? files.get(target) : null;
		},
		async write(target, text) {
			files.set(target, text);
		},
		async mkdir() {},
		async rename(from, to) {
			files.set(to, files.get(from));
			files.delete(from);
		},
		exists(target) {
			return files.has(target);
		}
	};
}

/** Root used by the fake port. */
const ROOT = "/ws/.ai";

test("workspaceRoot finds the git root above a nested directory", async () => {
	const base = await mkdtemp(path.join(tmpdir(), "pm-root-"));
	await mkdir(path.join(base, ".git"));
	const nested = path.join(base, "a", "b");
	await mkdir(nested, { recursive: true });
	assert.equal(workspaceRoot(nested), base);
});

test("workspaceRoot falls back to the starting directory outside a repository", async () => {
	const base = await mkdtemp(path.join(tmpdir(), "pm-nogit-"));
	assert.equal(workspaceRoot(base), base);
});

test("workspaceRoot accepts a .git file, as a worktree has", async () => {
	const base = await mkdtemp(path.join(tmpdir(), "pm-worktree-"));
	await writeFile(path.join(base, ".git"), "gitdir: /elsewhere\n");
	const nested = path.join(base, "src");
	await mkdir(nested, { recursive: true });
	assert.equal(workspaceRoot(nested), base);
});

test("initMemory writes every template and the local ignore rule", async () => {
	const fs = fakeFs();
	const created = await initMemory(ROOT, fs);
	assert.deepEqual(created, ["project.md", "decisions.md", "tasks.md", "bugs.md", "memory.md"]);
	assert.equal(await fs.read(path.join(ROOT, ".gitignore")), ".local/\n");
	assert.equal(parseMemoryFile(await fs.read(path.join(ROOT, "project.md"))).entries.length, 0);
	assert.deepEqual(await initMemory(ROOT, fs), [], "a second init creates nothing");
});

test("writeEntry appends to the named file and leaves the others alone", async () => {
	const fs = fakeFs();
	const outcome = await writeEntry(ROOT, {
		file: "decisions.md",
		entry: { id: "retry", kind: "decision", conclusion: "重试退避 800ms 起", date: "2026-10-16" },
		fs
	});
	assert.equal(outcome.ok, true);
	const text = await fs.read(path.join(ROOT, "decisions.md"));
	assert.match(text, /\[id=retry\]/);
	assert.equal(await fs.read(path.join(ROOT, "tasks.md")), null, "an unrelated file is never created");
});

test("writeEntry refuses a file outside the whitelist", async () => {
	const fs = fakeFs();
	const outcome = await writeEntry(ROOT, { file: "../evil.md", entry: { id: "x", kind: "fact", conclusion: "x" }, fs });
	assert.equal(outcome.ok, false);
	assert.match(outcome.reason, /not a whitelisted memory file/);
	assert.equal(fs.files.size, 0);
});

test("writeEntry surfaces a validation error instead of writing", async () => {
	const fs = fakeFs();
	const outcome = await writeEntry(ROOT, { file: "memory.md", entry: { id: "x", kind: "bogus", conclusion: "x" }, fs });
	assert.equal(outcome.ok, false);
	assert.match(outcome.reason, /kind must be/);
	assert.equal(fs.files.size, 0);
});

test("writeEntry keeps a recovery copy of the previous text", async () => {
	const fs = fakeFs();
	await writeEntry(ROOT, { file: "tasks.md", entry: { id: "a", kind: "task", conclusion: "甲", date: "2026-10-16" }, fs });
	const first = await fs.read(path.join(ROOT, "tasks.md"));
	await writeEntry(ROOT, { file: "tasks.md", entry: { id: "b", kind: "task", conclusion: "乙", date: "2026-10-16" }, fs });
	assert.equal(await fs.read(path.join(ROOT, "tasks.md.bak")), first);
});

test("writeEntry detects a change made on disk since the read", async () => {
	const fs = fakeFs();
	const target = path.join(ROOT, "memory.md");
	await fs.write(target, "# 记忆\n");
	const originalRead = fs.read.bind(fs);
	// Simulate another writer landing between readMemory and the write.
	let tampered = false;
	fs.read = async (candidate) => {
		const text = await originalRead(candidate);
		if (!tampered && candidate === target) {
			tampered = true;
			await fs.write(target, "# 记忆\n\n- 2026-10-16 [id=other] [status=active] [kind=fact]: 别人写的\n");
			return text;
		}
		return text;
	};
	const outcome = await writeEntry(ROOT, { file: "memory.md", entry: { id: "mine", kind: "fact", conclusion: "我写的" }, fs });
	assert.equal(outcome.ok, false);
	assert.match(outcome.reason, /changed on disk/);
	assert.match(await fs.read(target), /别人写的/, "the other writer's content survives");
});

test("writeEntry coarsens older details rather than exceeding the ceiling", async () => {
	const fs = fakeFs();
	// Fill decisions.md with old, detail-heavy entries so coarsening has room.
	const old = Array.from({ length: 200 }, (_unused, index) =>
		[
			`- 2020-01-01 [id=old-${index}] [status=done] [kind=decision]: 早期决策 ${index} 的结论`,
			"  - 细节一，长度足够让整体超出容量上限，用来验证整理确实发生。",
			"  - 细节二，长度足够让整体超出容量上限，用来验证整理确实发生。",
			"  - 细节三，长度足够让整体超出容量上限，用来验证整理确实发生。"
		].join("\n")
	).join("\n");
	await fs.write(path.join(ROOT, "decisions.md"), `${old}\n`);
	const before = (await fs.read(path.join(ROOT, "decisions.md"))).length;
	assert.ok(before > MEMORY_TOTAL_MAX_CHARS, "the fixture starts over the ceiling");

	const outcome = await writeEntry(ROOT, {
		file: "decisions.md",
		entry: { id: "new", kind: "decision", conclusion: "新决策", date: "2026-10-16" },
		fs,
		now: Date.parse("2026-10-16T12:00:00Z")
	});
	assert.equal(outcome.ok, true);
	assert.equal(outcome.coarsened, true);
	const text = await fs.read(path.join(ROOT, "decisions.md"));
	assert.ok(text.length < before);
	assert.match(text, /\[id=new\]/, "the entry that was asked for is present");
	assert.match(text, /早期决策 0 的结论/, "conclusions survive coarsening");
	assert.ok(!text.includes("细节一"), "old details were dropped");
});

test("writeEntry refuses when coarsening cannot make room", async () => {
	const fs = fakeFs();
	const fresh = Array.from({ length: 400 }, (_unused, index) =>
		`- 2026-10-16 [id=recent-${index}] [status=active] [kind=constraint]: 受保护的约束 ${index}，不会因年龄被粗化，因此整理腾不出空间。`
	).join("\n");
	await fs.write(path.join(ROOT, "decisions.md"), `${fresh}\n`);
	const before = await fs.read(path.join(ROOT, "decisions.md"));
	const outcome = await writeEntry(ROOT, {
		file: "decisions.md",
		entry: { id: "another", kind: "decision", conclusion: "再加一条", date: "2026-10-16" },
		fs,
		now: Date.parse("2026-10-16T12:00:00Z")
	});
	assert.equal(outcome.ok, false);
	assert.match(outcome.reason, /exceed the memory ceiling/);
	assert.equal(await fs.read(path.join(ROOT, "decisions.md")), before, "the file is byte-identical after a refusal");
});

test("forgetEntries previews by default and writes only with apply", async () => {
	const fs = fakeFs();
	await writeEntry(ROOT, { file: "bugs.md", entry: { id: "flaky", kind: "bug", conclusion: "偶发失败", date: "2026-10-16" }, fs });
	await writeEntry(ROOT, { file: "bugs.md", entry: { id: "kept", kind: "bug", conclusion: "保留", date: "2026-10-16" }, fs });
	const before = await fs.read(path.join(ROOT, "bugs.md"));

	const preview = await forgetEntries(ROOT, { id: "flaky" }, { fs });
	assert.equal(preview.matches.length, 1);
	assert.equal(preview.applied, false);
	assert.equal(await fs.read(path.join(ROOT, "bugs.md")), before, "preview writes nothing");

	const applied = await forgetEntries(ROOT, { id: "flaky" }, { fs, apply: true });
	assert.equal(applied.applied, true);
	const text = await fs.read(path.join(ROOT, "bugs.md"));
	assert.ok(!text.includes("flaky"));
	assert.match(text, /kept/);
});

test("forgetEntries refuses to run without a selector", async () => {
	const fs = fakeFs();
	await assert.rejects(() => forgetEntries(ROOT, {}, { fs }), /at least one of id, date, or query/);
});

test("compactMemory only acts when the target is exceeded", async () => {
	const fs = fakeFs();
	await writeEntry(ROOT, { file: "memory.md", entry: { id: "small", kind: "fact", conclusion: "很小", date: "2026-10-16" }, fs });
	const quiet = await compactMemory(ROOT, { fs, apply: true });
	assert.equal(quiet.applied, false);
	assert.deepEqual(quiet.files, []);

	const bulky = Array.from({ length: 300 }, (_unused, index) =>
		[
			`- 2020-01-01 [id=bulk-${index}] [status=done] [kind=history]: 历史记录 ${index} 的结论`,
			"  - 一段足够长的细节，用来把文件推到整理目标之上，从而触发整理。"
		].join("\n")
	).join("\n");
	await fs.write(path.join(ROOT, "memory.md"), `${bulky}\n`);
	const busy = await compactMemory(ROOT, { fs, apply: true, now: Date.parse("2026-10-16T12:00:00Z") });
	assert.equal(busy.applied, true);
	assert.ok(busy.after.chars < busy.before.chars);
});

test("memoryStatus reports per-file entries and the shared ceiling", async () => {
	const fs = fakeFs();
	await writeEntry(ROOT, { file: "tasks.md", entry: { id: "a", kind: "task", conclusion: "甲", date: "2026-10-16" }, fs });
	await writeEntry(ROOT, { file: "bugs.md", entry: { id: "b", kind: "bug", conclusion: "乙", date: "2026-10-16" }, fs });
	const status = await memoryStatus(ROOT, fs);
	assert.equal(status.entries, 2);
	assert.equal(status.report.maxChars, MEMORY_TOTAL_MAX_CHARS);
	assert.equal(status.files.find((file) => file.name === "tasks.md").entries, 1);
});

test("entriesOf tags every entry with the file it came from", async () => {
	const files = [
		{ name: "tasks.md", text: "- 2026-10-16 [id=a] [status=active] [kind=task]: 甲\n" },
		{ name: "bugs.md", text: "- 2026-10-16 [id=b] [status=active] [kind=bug]: 乙\n" }
	];
	assert.deepEqual(entriesOf(files).map((entry) => [entry.id, entry.file]), [["a", "tasks.md"], ["b", "bugs.md"]]);
});

test("readMemory reports a revision that changes with the text", async () => {
	const fs = fakeFs({ [path.join(ROOT, "project.md")]: "# 项目\n" });
	const [file] = await readMemory(ROOT, fs);
	assert.equal(file.revision, revisionOf("# 项目\n"));
	assert.notEqual(file.revision, revisionOf("# 项目\n\n"));
});

test("reRenderEntries trims details without moving prose", () => {
	const text = [
		"# 决策",
		"",
		"说明在前。",
		"",
		"- 2020-01-01 [id=a] [status=done] [kind=decision]: 甲",
		"  - 细节一",
		"  - 细节二",
		"  - 细节三",
		"",
		"说明在后。",
		""
	].join("\n");
	const { entries } = parseMemoryFile(text);
	const rebuilt = reRenderEntries(text, entries.map((entry) => ({ ...entry, details: ["细节三"] })));
	assert.equal(rebuilt, [
		"# 决策",
		"",
		"说明在前。",
		"",
		"- 2020-01-01 [id=a] [status=done] [kind=decision]: 甲",
		"  - 细节三",
		"",
		"说明在后。",
		""
	].join("\n"));
});

test("reRenderEntries is a no-op when nothing was thinned", () => {
	const text = "- 2026-10-16 [id=a] [status=active] [kind=fact]: 甲\n  - 细节\n";
	const { entries } = parseMemoryFile(text);
	assert.equal(reRenderEntries(text, entries), text);
});

test("makeEntry is the single place an entry is normalized", async () => {
	const fs = fakeFs();
	await writeEntry(ROOT, { file: "memory.md", entry: makeEntry({ id: "x", kind: "fact", conclusion: "  多余   空白  ", date: "2026-10-16" }), fs });
	assert.match(await fs.read(path.join(ROOT, "memory.md")), /: 多余 空白$/m);
});
