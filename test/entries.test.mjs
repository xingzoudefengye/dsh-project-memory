import assert from "node:assert/strict";
import test from "node:test";
import {
	MEMORY_TOTAL_MAX_CHARS,
	ageInDays,
	capacityOf,
	coarsenEntries,
	estimateTokens,
	fileUnderMostPressure,
	isProtected,
	makeEntry,
	matchForget,
	orderForInjection,
	parseMemoryFile,
	priorityOf,
	removeEntries,
	renderEntry,
	selectForInjection,
	templateFor,
	upsertEntry
} from "../lib/entries.js";

/** Epoch milliseconds for a date string, so ages are exact. */
const at = (iso) => Date.parse(`${iso}T12:00:00Z`);

/** A file with two entries and prose around them. */
const SAMPLE = [
	"# 决策",
	"",
	"这里是一些说明文字，不是条目。",
	"",
	"- 2026-10-16 [id=resume-budget] [status=active] [kind=task]: 实现冷恢复输入预算",
	"  - 阈值默认 100000 token",
	"  - 恢复后首个请求前检查",
	"- 2026-10-15 [id=retry] [status=done] [kind=decision]: 重试退避 800ms 起",
	"",
	"结尾说明。",
	""
].join("\n");

test("parses entries with their nested details and leaves prose alone", () => {
	const { entries } = parseMemoryFile(SAMPLE);
	assert.equal(entries.length, 2);
	assert.deepEqual(entries[0], {
		date: "2026-10-16",
		id: "resume-budget",
		status: "active",
		kind: "task",
		conclusion: "实现冷恢复输入预算",
		details: ["阈值默认 100000 token", "恢复后首个请求前检查"],
		startLine: 4,
		endLine: 6
	});
	assert.equal(entries[1].details.length, 0);
});

test("never treats a fenced example as an entry", () => {
	const text = [
		"# 记忆",
		"",
		"```text",
		"- 2026-10-16 [id=example] [status=active] [kind=fact]: 这是格式示例",
		"```",
		"",
		"- 2026-10-16 [id=real] [status=active] [kind=fact]: 这是真的条目"
	].join("\n");
	const { entries } = parseMemoryFile(text);
	assert.equal(entries.length, 1);
	assert.equal(entries[0].id, "real");
});

test("appends a new entry after the last one, keeping prose in place", () => {
	const text = [
		"# 任务",
		"",
		"- 2026-10-15 [id=a] [status=done] [kind=task]: 旧任务",
		"",
		"尾部说明。"
	].join("\n");
	const next = upsertEntry(text, makeEntry({ id: "b", kind: "task", conclusion: "新任务", date: "2026-10-16" }));
	const { entries } = parseMemoryFile(next);
	assert.deepEqual(entries.map((entry) => entry.id), ["a", "b"]);
	assert.match(next, /尾部说明。$/);
});

test("updates an entry in place instead of appending a duplicate", () => {
	const next = upsertEntry(
		SAMPLE,
		makeEntry({ id: "resume-budget", kind: "task", status: "done", conclusion: "实现冷恢复输入预算（已完成）", date: "2026-10-17" })
	);
	const { entries } = parseMemoryFile(next);
	assert.equal(entries.length, 2, "no duplicate id");
	assert.equal(entries[0].id, "resume-budget");
	assert.equal(entries[0].status, "done");
	assert.equal(entries[0].conclusion, "实现冷恢复输入预算（已完成）");
	assert.equal(entries[0].details.length, 0, "an update replaces details rather than merging them");
	assert.equal(entries[1].id, "retry", "the other entry is untouched");
});

test("removes matching entries and collapses the blank run they leave", () => {
	const text = [
		"# 任务",
		"",
		"- 2026-10-15 [id=a] [status=done] [kind=task]: 甲",
		"",
		"- 2026-10-16 [id=b] [status=done] [kind=task]: 乙"
	].join("\n");
	const { text: next, removed } = removeEntries(text, (entry) => entry.id === "a");
	assert.equal(removed.length, 1);
	assert.deepEqual(parseMemoryFile(next).entries.map((entry) => entry.id), ["b"]);
	assert.ok(!/\n\n\n/.test(next), "no triple newline left behind");
});

test("coarsens details by age while keeping conclusions", () => {
	const now = at("2026-10-16");
	const entries = [
		{ date: "2026-10-16", id: "fresh", status: "active", kind: "fact", conclusion: "新", details: ["1", "2", "3"] },
		{ date: "2026-10-01", id: "middle", status: "active", kind: "fact", conclusion: "中", details: ["1", "2", "3"] },
		{ date: "2026-08-01", id: "old", status: "active", kind: "fact", conclusion: "旧", details: ["1", "2", "3"] }
	];
	const [fresh, middle, old] = coarsenEntries(entries, { now });
	assert.deepEqual(fresh.details, ["1", "2", "3"], "under 7 days keeps every detail");
	assert.deepEqual(middle.details, ["2", "3"], "7-30 days keeps the tail");
	assert.deepEqual(old.details, [], "over 30 days keeps only the conclusion");
	assert.equal(old.conclusion, "旧", "the conclusion is never rewritten");
});

test("pressure coarsens one tier earlier", () => {
	const now = at("2026-10-16");
	const entries = [{ date: "2026-10-12", id: "x", status: "active", kind: "fact", conclusion: "x", details: ["1", "2", "3"] }];
	assert.deepEqual(coarsenEntries(entries, { now })[0].details, ["1", "2", "3"]);
	assert.deepEqual(coarsenEntries(entries, { now, pressure: 2 })[0].details, ["2", "3"]);
});

test("coarsening leaves protected entries entirely alone", () => {
	const now = at("2026-10-16");
	const entries = [
		{ date: "2020-01-01", id: "c", status: "active", kind: "constraint", conclusion: "约束", details: ["1", "2", "3"] },
		{ date: "2020-01-01", id: "t", status: "active", kind: "task", conclusion: "任务", details: ["1", "2", "3"] },
		{ date: "2020-01-01", id: "b", status: "active", kind: "bug", conclusion: "缺陷", details: ["1", "2", "3"] },
		{ date: "2020-01-01", id: "d", status: "done", kind: "task", conclusion: "已完成", details: ["1", "2", "3"] }
	];
	const [constraint, task, bug, done] = coarsenEntries(entries, { now });
	assert.deepEqual(constraint.details, ["1", "2", "3"]);
	assert.deepEqual(task.details, ["1", "2", "3"]);
	assert.deepEqual(bug.details, ["1", "2", "3"]);
	assert.deepEqual(done.details, [], "a finished task is not protected");
});

test("standing constraints and unfinished work are protected from age", () => {
	const now = at("2026-10-16");
	assert.equal(isProtected({ status: "active", kind: "constraint", date: "2020-01-01" }), true);
	assert.equal(isProtected({ status: "active", kind: "task", date: "2020-01-01" }), true);
	assert.equal(isProtected({ status: "active", kind: "bug", date: "2020-01-01" }), true);
	assert.equal(isProtected({ status: "done", kind: "task", date: "2020-01-01" }), false);
	assert.equal(isProtected({ status: "active", kind: "fact", date: "2020-01-01" }), false);
});

test("orders constraints first, then unfinished work, then newest", () => {
	const entries = [
		{ date: "2026-10-16", id: "f1", status: "active", kind: "fact", conclusion: "事实" },
		{ date: "2026-10-10", id: "c1", status: "active", kind: "constraint", conclusion: "约束" },
		{ date: "2026-10-16", id: "t1", status: "active", kind: "task", conclusion: "任务" },
		{ date: "2026-10-15", id: "d1", status: "active", kind: "decision", conclusion: "决策" },
		{ date: "2026-10-16", id: "s1", status: "superseded", kind: "decision", conclusion: "作废" }
	];
	assert.deepEqual(orderForInjection(entries).map((entry) => entry.id), ["c1", "t1", "d1", "f1", "s1"]);
	assert.equal(priorityOf({ status: "superseded", kind: "constraint" }), 5, "superseded sinks regardless of kind");
});

test("injection respects the character budget and reports what it left out", () => {
	const entries = Array.from({ length: 50 }, (_unused, index) => ({
		date: "2026-10-16",
		id: `e${String(index).padStart(2, "0")}`,
		status: "active",
		kind: "fact",
		conclusion: `第 ${index} 条事实，用来把预算撑满。`
	}));
	const { text, included, dropped } = selectForInjection(entries, { maxChars: 300, maxTokens: 1_000_000 });
	assert.ok(text.length <= 300 + 80, "stays inside the budget apart from the dropped-count note");
	assert.equal(included.length + dropped, 50);
	assert.ok(dropped > 0, "the fixture is large enough to drop some");
	assert.match(text, /另有 \d+ 条未注入/);
});

test("injection respects the token budget even when characters fit", () => {
	const entries = Array.from({ length: 30 }, (_unused, index) => ({
		date: "2026-10-16",
		id: `e${index}`,
		status: "active",
		kind: "fact",
		conclusion: "约束内容".repeat(4)
	}));
	const byChars = selectForInjection(entries, { maxChars: 100_000, maxTokens: 1_000_000 });
	const byTokens = selectForInjection(entries, { maxChars: 100_000, maxTokens: 50 });
	assert.ok(byTokens.included.length < byChars.included.length);
	assert.ok(byTokens.dropped > 0);
});

test("one oversized entry does not starve the smaller ones behind it", () => {
	const entries = [
		{ date: "2026-10-16", id: "huge", status: "active", kind: "constraint", conclusion: "长".repeat(500) },
		{ date: "2026-10-15", id: "small", status: "active", kind: "fact", conclusion: "短条目" }
	];
	const { text, included } = selectForInjection(entries, { maxChars: 200, maxTokens: 1_000_000 });
	assert.deepEqual(included.map((entry) => entry.id), ["small"], "the entry that fits is still injected");
	assert.ok(!text.includes("长长长"));
	assert.match(text, /另有 1 条未注入/);
});

test("injection is deterministic: same entries always render the same text", () => {
	const entries = [
		{ date: "2026-10-16", id: "b", status: "active", kind: "fact", conclusion: "乙" },
		{ date: "2026-10-16", id: "a", status: "active", kind: "fact", conclusion: "甲" }
	];
	const first = selectForInjection(entries, {}).text;
	const shuffled = selectForInjection([...entries].reverse(), {}).text;
	assert.equal(first, shuffled);
});

test("superseded entries are retained but never injected", () => {
	const entries = [{ date: "2026-10-16", id: "x", status: "superseded", kind: "decision", conclusion: "作废的决策" }];
	const { text, included } = selectForInjection(entries, {});
	assert.equal(included.length, 0);
	assert.ok(!text.includes("作废的决策"));
});

test("capacity reports both character and byte ceilings", () => {
	const files = [{ name: "project.md", text: "x".repeat(MEMORY_TOTAL_MAX_CHARS + 1) }];
	const report = capacityOf(files);
	assert.equal(report.over, true);
	assert.equal(report.nearTarget, true);
	assert.equal(capacityOf([{ name: "project.md", text: "短" }]).over, false);
});

test("multi-byte content is measured in bytes, not code units", () => {
	const report = capacityOf([{ name: "memory.md", text: "中".repeat(30_000) }]);
	assert.equal(report.chars, 30_000);
	assert.equal(report.bytes, 90_000);
	assert.equal(report.over, true, "over the byte ceiling even though it is near the char ceiling");
});

test("pressure points at the file most over its own quota", () => {
	const files = [
		{ name: "project.md", text: "x".repeat(100) },
		{ name: "decisions.md", text: "x".repeat(12_000) }
	];
	assert.equal(fileUnderMostPressure(files), "decisions.md");
	assert.equal(fileUnderMostPressure([{ name: "project.md", text: "x" }]), undefined);
});

test("forget refuses to run without a selector", () => {
	const entries = [{ date: "2026-10-16", id: "a", status: "active", kind: "fact", conclusion: "甲", details: [] }];
	assert.throws(() => matchForget(entries, {}), /at least one of id, date, or query/);
	assert.equal(matchForget(entries, { id: "a" }).length, 1);
	assert.equal(matchForget(entries, { id: "b" }).length, 0);
	assert.equal(matchForget(entries, { query: "甲" }).length, 1);
	assert.equal(matchForget(entries, { id: "a", date: "2026-01-01" }).length, 0, "all selectors must match");
});

test("makeEntry rejects an unusable id, kind, or conclusion", () => {
	assert.throws(() => makeEntry({ id: "has space", kind: "fact", conclusion: "x" }), /id must be/);
	assert.throws(() => makeEntry({ id: "ok", kind: "nope", conclusion: "x" }), /kind must be/);
	assert.throws(() => makeEntry({ id: "ok", kind: "fact", conclusion: "   " }), /conclusion must not be empty/);
	assert.throws(() => makeEntry({ id: "ok", kind: "fact", conclusion: "x", status: "nope" }), /status must be/);
	assert.throws(() => makeEntry({ id: "ok", kind: "fact", conclusion: "x", date: "16/10/2026" }), /YYYY-MM-DD/);
});

test("makeEntry normalizes whitespace in the conclusion", () => {
	const entry = makeEntry({ id: "ok", kind: "fact", conclusion: "  多   空格\n换行  ", date: "2026-10-16" });
	assert.equal(entry.conclusion, "多 空格 换行");
});

test("ageInDays treats a future or unparsable date as zero", () => {
	assert.equal(ageInDays({ date: "2026-10-16" }, at("2026-10-20")), 4);
	assert.equal(ageInDays({ date: "2026-10-20" }, at("2026-10-16")), 0);
	assert.equal(ageInDays({ date: "not-a-date" }, at("2026-10-16")), 0);
});

test("token estimate counts CJK closer to one token per character", () => {
	assert.equal(estimateTokens("中文四个字"), 5);
	assert.equal(estimateTokens("abcd"), 1);
	assert.ok(estimateTokens("中".repeat(100)) > estimateTokens("a".repeat(100)));
});

test("round-trips an entry through render and parse", () => {
	const entry = makeEntry({
		id: "round-trip",
		kind: "decision",
		status: "active",
		conclusion: "结论",
		details: ["细节一", "细节二"],
		date: "2026-10-16"
	});
	const parsed = parseMemoryFile(`${renderEntry(entry)}\n`).entries[0];
	assert.deepEqual({ ...parsed, startLine: undefined, endLine: undefined }, { ...entry, startLine: undefined, endLine: undefined });
});

test("templates document the format inside a fence so it is not self-parsing", () => {
	for (const name of ["project.md", "decisions.md", "tasks.md", "bugs.md", "memory.md"]) {
		const text = templateFor(name);
		assert.equal(parseMemoryFile(text).entries.length, 0, `${name} template must not contain live entries`);
	}
});
