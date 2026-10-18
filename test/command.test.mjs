import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import path from "node:path";
import test from "node:test";
import { apply } from "../lib/command.js";
import { ProjectMemory } from "../lib/service.js";

const WS = path.resolve("/ws");
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

/** A registered command plus the memory it edits. */
function setup(initial = {}, globalRoot = "/g") {
	const fs = fakeFs(initial);
	const ctx = new Context();
	const memory = new ProjectMemory(ctx, { fs, globalRoot });
	const registered = [];
	apply({ commands: { register: (definition) => registered.push(definition) }, projectMemory: memory });
	return { fs, memory, command: registered[0], agent: { session: { id: "s1", header: { cwd: path.join(WS, "src") } } } };
}

/** Run one `/memory` invocation body. */
const run = (command, agent, rawInput) => command.handler({ rawInput, agent });

const SEED = {
	[path.join(ROOT, "tasks.md")]: "- 2026-10-16 [id=budget] [status=active] [kind=task]: 恢复预算\n",
	[path.join(ROOT, "bugs.md")]: "- 2026-10-16 [id=flaky] [status=active] [kind=bug]: 偶发失败\n"
};

test("the command registers under the name memory", () => {
	const { command } = setup();
	assert.equal(command.name, "memory");
	assert.equal(typeof command.handler, "function");
});

test("an invocation with no subcommand reports status", async () => {
	const { command, agent } = setup(SEED);
	const result = await run(command, agent, "");
	assert.equal(result.kind, "success");
	assert.match(result.text, /Project memory:/);
	assert.match(result.text, /tasks\.md: 1 entries/);
});

test("status reports the coarsening target and the current state", async () => {
	const { command, agent } = setup(SEED);
	const result = await run(command, agent, " status");
	assert.match(result.text, /coarsening target/);
	assert.match(result.text, /Inside the coarsening target/);
});

test("check adds the coarsening plan", async () => {
	const { command, agent } = setup(SEED);
	const result = await run(command, agent, " check");
	assert.match(result.text, /Coarsening plan:/);
});

test("init creates the template files and says so once", async () => {
	const { command, agent, fs } = setup();
	const first = await run(command, agent, " init");
	assert.equal(first.kind, "success");
	assert.match(first.text, /Created project\.md/);
	assert.ok(fs.files.has(path.join(ROOT, "bugs.md")));
	const second = await run(command, agent, " init");
	assert.match(second.text, /already initialized/);
});

test("forget without a selector explains the requirement instead of removing anything", async () => {
	const { command, agent, fs } = setup(SEED);
	const result = await run(command, agent, " forget");
	assert.equal(result.kind, "error");
	assert.match(result.text, /at least one of id, date, or query/);
	assert.match(result.text, /Usage:/);
	assert.match(fs.files.get(path.join(ROOT, "bugs.md")), /flaky/, "nothing was removed");
});

test("forget previews by default and writes only with --apply", async () => {
	const { command, agent, fs } = setup(SEED);
	const preview = await run(command, agent, " forget --id flaky");
	assert.equal(preview.kind, "success");
	assert.match(preview.text, /Would forget 1 entries/);
	assert.match(preview.text, /偶发失败/);
	assert.match(preview.text, /Re-run with --apply/);
	assert.match(fs.files.get(path.join(ROOT, "bugs.md")), /flaky/, "preview is read-only");

	const applied = await run(command, agent, " forget --id flaky --apply");
	assert.equal(applied.kind, "success");
	assert.match(applied.text, /Forgot 1 entries/);
	assert.ok(!fs.files.get(path.join(ROOT, "bugs.md")).includes("flaky"));
});

test("forget says so when nothing matched", async () => {
	const { command, agent } = setup(SEED);
	const result = await run(command, agent, " forget --id nothing-like-this");
	assert.equal(result.kind, "success");
	assert.match(result.text, /No entries matched/);
});

test("forget accepts a query selector", async () => {
	const { command, agent, fs } = setup(SEED);
	const result = await run(command, agent, " forget --query 偶发 --apply");
	assert.equal(result.kind, "success");
	assert.ok(!fs.files.get(path.join(ROOT, "bugs.md")).includes("偶发"));
});

test("compact previews and applies", async () => {
	const heavy = Array.from({ length: 300 }, (_unused, index) =>
		[
			`- 2020-01-01 [id=old-${index}] [status=done] [kind=history]: 历史 ${index} 的结论，用来把容量推高。`,
			"  - 一段细节，够长。",
			"  - 一段细节，够长。",
			"  - 一段细节，够长。"
		].join("\n")
	).join("\n");
	const { command, agent, fs } = setup({ [path.join(ROOT, "memory.md")]: `${heavy}\n` });
	const before = fs.files.get(path.join(ROOT, "memory.md"));
	const preview = await run(command, agent, " compact");
	assert.match(preview.text, /Would coarsen/);
	assert.equal(fs.files.get(path.join(ROOT, "memory.md")), before, "preview is read-only");
	const applied = await run(command, agent, " compact --apply");
	assert.match(applied.text, /Coarsened/);
	assert.ok(fs.files.get(path.join(ROOT, "memory.md")).length < before.length);
});

test("compact says so when there is nothing to coarsen", async () => {
	const { command, agent } = setup(SEED);
	const result = await run(command, agent, " compact");
	assert.match(result.text, /Nothing to coarsen/);
});

test("an unknown subcommand or flag is an error with usage", async () => {
	const { command, agent } = setup(SEED);
	const unknown = await run(command, agent, " frobnicate");
	assert.equal(unknown.kind, "error");
	assert.match(unknown.text, /Unknown subcommand/);
	const badFlag = await run(command, agent, " status --wat");
	assert.equal(badFlag.kind, "error");
	assert.match(badFlag.text, /unrecognized argument/);
	const missingValue = await run(command, agent, " forget --id");
	assert.equal(missingValue.kind, "error");
	assert.match(missingValue.text, /--id needs a value/);
});

test("status --global reports the global layer, not the project", async () => {
	const { command, agent } = setup({
		...SEED,
		[path.join("/g", "memory.md")]: "- 2026-10-16 [id=pref] [status=active] [kind=fact]: 跨项目偏好\n"
	});
	const result = await run(command, agent, " status --global");
	assert.equal(result.kind, "success");
	assert.match(result.text, /Global memory:/);
	assert.match(result.text, /memory\.md: 1 entries/);
});

test("promote previews, then copies a project entry to the global layer", async () => {
	const { command, agent, fs } = setup(SEED);
	const preview = await run(command, agent, " promote --id budget");
	assert.equal(preview.kind, "success");
	assert.match(preview.text, /Would promote to global/);
	assert.match(preview.text, /恢复预算/);
	assert.equal(fs.files.has(path.join("/g", "tasks.md")), false, "preview writes nothing");
	const applied = await run(command, agent, " promote --id budget --apply");
	assert.equal(applied.kind, "success");
	assert.match(applied.text, /Promoted to global/);
	assert.match(fs.files.get(path.join("/g", "tasks.md")), /\[id=budget\]/);
	const missing = await run(command, agent, " promote --id nothing-like-this --apply");
	assert.equal(missing.kind, "error");
});
