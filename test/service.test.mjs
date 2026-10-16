import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import path from "node:path";
import test from "node:test";
import { parseMemoryFile } from "../lib/entries.js";
import { ProjectMemory } from "../lib/service.js";

/** Workspace root the fake port pretends to see. */
const WS = "/ws";

/** `.ai` directory under that root. */
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

/** An agent whose session starts in a nested directory of the workspace. */
const agent = (id = "s1") => ({ session: { id, header: { cwd: path.join(WS, "src", "deep") } } });

/** A service wired to a fresh context and fake port. */
function service(initial = {}) {
	const fs = fakeFs(initial);
	const ctx = new Context();
	return { ctx, fs, memory: new ProjectMemory(ctx, { fs }) };
}

test("the memory root is the .ai directory at the workspace root", () => {
	const { memory } = service();
	assert.equal(memory.root(agent()), ROOT);
});

test("the root falls back to the session cwd outside a repository", () => {
	const fs = fakeFs();
	fs.files.delete(path.join(WS, ".git"));
	const memory = new ProjectMemory(new Context(), { fs });
	assert.equal(memory.root(agent()), path.join(WS, "src", "deep", ".ai"));
});

test("prepare freezes a projection that injected returns synchronously", async () => {
	const { memory } = service({
		[path.join(ROOT, "decisions.md")]: "- 2026-10-16 [id=retry] [status=active] [kind=decision]: 重试退避 800ms 起\n"
	});
	const target = agent();
	await memory.prepare(target);
	const frozen = memory.injected(target);
	assert.match(frozen, /项目记忆/);
	assert.match(frozen, /重试退避 800ms 起/);
});

test("an absent or empty memory directory projects nothing and does not throw", async () => {
	const { memory } = service();
	const target = agent();
	assert.equal(await memory.prepare(target), "");
	assert.equal(memory.injected(target), "");
});

test("prepare is idempotent, and force re-reads", async () => {
	const decisions = path.join(ROOT, "decisions.md");
	const { memory, fs } = service({ [decisions]: "- 2026-10-16 [id=a] [status=active] [kind=fact]: 第一版\n" });
	const target = agent();
	await memory.prepare(target);
	assert.match(memory.injected(target), /第一版/);
	fs.files.set(decisions, "- 2026-10-16 [id=a] [status=active] [kind=fact]: 第二版\n");
	await memory.prepare(target);
	assert.match(memory.injected(target), /第一版/, "the projection stays frozen inside the session");
	await memory.prepare(target, { force: true });
	assert.match(memory.injected(target), /第二版/);
});

test("a mid-session write does not disturb the frozen projection", async () => {
	const { memory } = service();
	const target = agent();
	await memory.prepare(target);
	const outcome = await memory.write(target, {
		file: "tasks.md",
		entry: { id: "fresh", kind: "task", conclusion: "会话中写入的任务", date: "2026-10-16" }
	});
	assert.equal(outcome.ok, true);
	assert.ok(!memory.injected(target).includes("会话中写入的任务"), "the frozen text is unchanged");
	await memory.prepare(target, { force: true });
	assert.match(memory.injected(target), /会话中写入的任务/, "a refresh picks it up");
});

test("init creates the templates and then projects nothing", async () => {
	const { memory, fs } = service();
	const target = agent();
	const created = await memory.init(target);
	assert.deepEqual(created, ["project.md", "decisions.md", "tasks.md", "bugs.md", "memory.md"]);
	assert.equal(fs.files.get(path.join(ROOT, ".gitignore")), ".local/\n");
	assert.equal(memory.injected(target), "", "a fresh template set holds no entries");
	assert.equal(parseMemoryFile(fs.files.get(path.join(ROOT, "project.md"))).entries.length, 0);
});

test("status reports capacity across the files", async () => {
	const { memory } = service({
		[path.join(ROOT, "tasks.md")]: "- 2026-10-16 [id=a] [status=active] [kind=task]: 甲\n",
		[path.join(ROOT, "bugs.md")]: "- 2026-10-16 [id=b] [status=active] [kind=bug]: 乙\n"
	});
	const status = await memory.status(agent());
	assert.equal(status.entries, 2);
	assert.equal(status.files.find((file) => file.name === "tasks.md").entries, 1);
});

test("forget previews through the service and applies only when asked", async () => {
	const bugs = path.join(ROOT, "bugs.md");
	const { memory, fs } = service({
		[bugs]: "- 2026-10-16 [id=flaky] [status=active] [kind=bug]: 偶发\n- 2026-10-16 [id=kept] [status=active] [kind=bug]: 保留\n"
	});
	const target = agent();
	const preview = await memory.forget(target, { id: "flaky" });
	assert.equal(preview.matches.length, 1);
	assert.equal(preview.applied, false);
	assert.match(fs.files.get(bugs), /flaky/, "preview leaves the file alone");
	const applied = await memory.forget(target, { id: "flaky" }, { apply: true });
	assert.equal(applied.applied, true);
	assert.ok(!fs.files.get(bugs).includes("flaky"));
});

test("release drops the snapshot so the next session re-reads", async () => {
	const { memory } = service({
		[path.join(ROOT, "memory.md")]: "- 2026-10-16 [id=a] [status=active] [kind=fact]: 事实\n"
	});
	const target = agent();
	await memory.prepare(target);
	assert.notEqual(memory.injected(target), "");
	memory.release(target);
	assert.equal(memory.injected(target), "");
});

test("the service registers itself on the context", () => {
	const { ctx } = service();
	assert.equal(typeof ctx.projectMemory.prepare, "function");
});

test("a session without an id projects nothing rather than throwing", async () => {
	const { memory } = service();
	assert.equal(await memory.prepare({ session: {} }), "");
	assert.equal(memory.injected({ session: {} }), "");
	assert.equal(memory.injected(undefined), "");
});
