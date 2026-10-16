import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import path from "node:path";
import test from "node:test";
import { ProjectMemory } from "../lib/service.js";
import { apply } from "../lib/tool.js";

/** Workspace root the fake port pretends to see. */
const WS = "/ws";
const ROOT = path.join(WS, ".ai");

/**
 * An in-memory filesystem port keyed by absolute path.
 * @param initial - seed files.
 * @returns a port plus its backing map.
 */
function fakeFs(initial = {}) {
	const files = new Map(Object.entries({ [path.join(WS, ".git")]: "", ...initial }));
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

/** A registered tool plus the memory it writes to. */
function setup(initial = {}) {
	const fs = fakeFs(initial);
	const ctx = new Context();
	const memory = new ProjectMemory(ctx, { fs });
	const registered = [];
	apply({ tools: { register: (definition) => registered.push(definition) }, projectMemory: memory });
	return { fs, memory, tool: registered[0], agent: { session: { id: "s1", header: { cwd: path.join(WS, "src") } } } };
}

/** Call the tool's execute with an owning agent. */
const run = (tool, agent, args) => tool.execute(args, { agent });

test("the tool registers under the expected name and actions", () => {
	const { tool } = setup();
	assert.equal(tool.name, "project_memory");
	assert.deepEqual(tool.parameters.properties.action.enum, ["write", "read", "list"]);
	assert.ok(tool.parameters.required.includes("action"), "action is the only required argument");
	assert.deepEqual(tool.parameters.required, ["action"]);
	assert.deepEqual(tool.parameters.properties.file.enum, ["project.md", "decisions.md", "tasks.md", "bugs.md", "memory.md"]);
});

test("write records one entry into the named file", async () => {
	const { tool, agent, fs } = setup();
	const result = await run(tool, agent, { action: "write", file: "decisions.md", id: "retry", kind: "decision", conclusion: "重试退避 800ms 起" });
	assert.equal(result.ok, true);
	assert.match(result.text, /Recorded retry in decisions\.md/);
	assert.match(fs.files.get(path.join(ROOT, "decisions.md")), /\[id=retry\]/);
});

test("write with an existing id updates in place", async () => {
	const { tool, agent, fs } = setup();
	await run(tool, agent, { action: "write", file: "tasks.md", id: "a", kind: "task", conclusion: "第一版" });
	await run(tool, agent, { action: "write", file: "tasks.md", id: "a", kind: "task", status: "done", conclusion: "第二版" });
	const text = fs.files.get(path.join(ROOT, "tasks.md"));
	assert.equal(text.match(/\[id=a\]/g).length, 1);
	assert.match(text, /第二版/);
	assert.match(text, /status=done/);
});

test("write refuses each missing required argument with a usable message", async () => {
	const { tool, agent } = setup();
	for (const [args, expected] of [
		[{ action: "write", id: "a", kind: "task", conclusion: "x" }, /needs file/],
		[{ action: "write", file: "tasks.md", kind: "task", conclusion: "x" }, /needs id/],
		[{ action: "write", file: "tasks.md", id: "a", conclusion: "x" }, /needs kind/],
		[{ action: "write", file: "tasks.md", id: "a", kind: "task" }, /needs conclusion/]
	]) {
		const result = await run(tool, agent, args);
		assert.equal(result.ok, false);
		assert.match(result.text, expected);
	}
});

test("the schema refuses a file outside the whitelist before any write is attempted", async () => {
	const { tool, agent, fs } = setup();
	await assert.rejects(
		() => run(tool, agent, { action: "write", file: "../outside.md", id: "a", kind: "task", conclusion: "x" }),
		/must be one of/
	);
	assert.equal(fs.files.has(path.join(WS, "outside.md")), false);
});

test("the schema refuses an unknown kind or action", async () => {
	const { tool, agent } = setup();
	await assert.rejects(() => run(tool, agent, { action: "write", file: "tasks.md", id: "a", kind: "nonsense", conclusion: "x" }), /must be one of/);
	await assert.rejects(() => run(tool, agent, { action: "nonsense" }), /must be one of/);
});

test("write reports coarsening when the ceiling forced it", async () => {
	const heavy = Array.from({ length: 300 }, (_unused, index) =>
		[
			`- 2020-01-01 [id=old-${index}] [status=done] [kind=history]: 历史 ${index} 的结论，用来把容量推高。`,
			"  - 一段细节，够长。",
			"  - 一段细节，够长。",
			"  - 一段细节，够长。"
		].join("\n")
	).join("\n");
	const { tool, agent } = setup({ [path.join(ROOT, "memory.md")]: `${heavy}\n` });
	const result = await run(tool, agent, { action: "write", file: "memory.md", id: "new", kind: "fact", conclusion: "新事实" });
	assert.equal(result.ok, true);
	assert.match(result.text, /coarsened/);
});

test("read returns full entries including details", async () => {
	const { tool, agent } = setup({
		[path.join(ROOT, "decisions.md")]: "- 2026-10-16 [id=retry] [status=active] [kind=decision]: 重试退避 800ms 起\n  - 依据是 OpenCode 402 抖动\n"
	});
	const result = await run(tool, agent, { action: "read" });
	assert.equal(result.ok, true);
	assert.match(result.text, /decisions\.md:/);
	assert.match(result.text, /依据是 OpenCode 402 抖动/);
});

test("read filters by file, id, and query", async () => {
	const { tool, agent } = setup({
		[path.join(ROOT, "decisions.md")]: "- 2026-10-16 [id=retry] [status=active] [kind=decision]: 重试退避\n",
		[path.join(ROOT, "tasks.md")]: "- 2026-10-16 [id=budget] [status=active] [kind=task]: 恢复预算\n"
	});
	assert.match((await run(tool, agent, { action: "read", file: "tasks.md" })).text, /budget/);
	assert.ok(!(await run(tool, agent, { action: "read", file: "tasks.md" })).text.includes("retry"));
	assert.match((await run(tool, agent, { action: "read", id: "retry" })).text, /重试退避/);
	assert.match((await run(tool, agent, { action: "read", query: "恢复预算" })).text, /budget/);
});

test("read says so when nothing matches", async () => {
	const { tool, agent } = setup();
	const result = await run(tool, agent, { action: "read", query: "不存在" });
	assert.equal(result.ok, true);
	assert.match(result.text, /No matching/);
});

test("list reports capacity and counts", async () => {
	const { tool, agent } = setup({
		[path.join(ROOT, "tasks.md")]: "- 2026-10-16 [id=a] [status=active] [kind=task]: 甲\n"
	});
	const result = await run(tool, agent, { action: "list" });
	assert.equal(result.ok, true);
	assert.match(result.text, /tasks\.md: 1 entries/);
	assert.match(result.text, /Inside the coarsening target/);
});

test("a tool call without an owning agent is an error, not a silent success", async () => {
	const { tool } = setup();
	await assert.rejects(() => tool.execute({ action: "list" }, {}), /owning agent session/);
});
