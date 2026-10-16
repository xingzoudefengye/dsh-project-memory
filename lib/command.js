/**
 * `/memory` — the human half of project memory.
 *
 * Everything destructive lives here rather than in a tool: forgetting is
 * previewed by default and only writes with an explicit `--apply`, so the one
 * operation that removes knowledge cannot happen because a model decided to
 * call something. The same preview-then-apply shape governs coarsening, for
 * the same reason.
 *
 * @module dsh-project-memory/command
 */

import { CommandDefinitionId } from "@deepseek-ai/dsh-commands/brand";

/** Loader row identity. */
export const name = "command-project-memory";

/** The command registry and the memory service. */
export const inject = ["commands", "projectMemory"];

const USAGE = [
	"Usage: /memory [status|check|init|compact|forget|promote] [--global] [options]",
	"  status [--global]      capacity, per-file counts (default)",
	"  check [--global]       status plus the coarsening plan",
	"  init [--global]        create missing memory template files",
	"  compact [--global] [--apply]",
	"                         coarsen older details; preview unless --apply",
	"  forget [--global] --id <id> | --date <YYYY-MM-DD> | --query <text> [--apply]",
	"                         remove matching entries; preview unless --apply",
	"  promote --id <id> [--apply]",
	"                         copy one project entry to the global layer; preview unless --apply"
].join("\n");

/**
 * Register `/memory` for every composed human-command adapter.
 * @param ctx - context carrying the command registry and the memory service.
 */
export function apply(ctx) {
	ctx.commands.register({
		definitionId: CommandDefinitionId("dsh-project-memory/memory"),
		name: "memory",
		description: "Inspect or maintain memory: this workspace's .ai/ by default, the global layer with --global",
		handler: (invocation) => run(ctx, invocation)
	});
}

/**
 * Execute one `/memory` invocation.
 * @param ctx - context carrying the memory service.
 * @param invocation - the command invocation.
 * @returns a command result.
 */
async function run(ctx, invocation) {
	const tokens = invocation.rawInput.trim().split(/\s+/).filter((token) => token !== "");
	const subcommand = tokens.shift() ?? "status";
	const flags = parseFlags(tokens);
	if (flags.error !== undefined) return { kind: "error", text: `${flags.error}\n${USAGE}` };
	const agent = invocation.agent;
	const global = flags.global === true;
	switch (subcommand) {
		case "status": return { kind: "success", text: await report(ctx, agent, false, global) };
		case "check": return { kind: "success", text: await report(ctx, agent, true, global) };
		case "init": {
			if (global) {
				const created = await ctx.projectMemory.initGlobal();
				return { kind: "success", text: created.length === 0 ? "Global memory already initialized." : `Created global ${created.join(", ")}.` };
			}
			const created = await ctx.projectMemory.init(agent);
			return { kind: "success", text: created.length === 0 ? "Project memory already initialized." : `Created ${created.join(", ")}.` };
		}
		case "compact": {
			const result = global
				? await ctx.projectMemory.compactGlobal({ apply: flags.apply })
				: await ctx.projectMemory.compact(agent, { apply: flags.apply });
			if (result.files.length === 0) return { kind: "success", text: "Nothing to coarsen." };
			const head = flags.apply ? "Coarsened" : "Would coarsen";
			return { kind: "success", text: `${head}${global ? " (global)" : ""}: ${result.files.join(", ")}\n  ${result.before.chars} → ${result.after.chars} chars (target ${result.before.targetChars})` };
		}
		case "forget": {
			let preview;
			try {
				preview = global
					? await ctx.projectMemory.forgetGlobal({ id: flags.id, date: flags.date, query: flags.query }, { apply: false })
					: await ctx.projectMemory.forget(agent, { id: flags.id, date: flags.date, query: flags.query }, { apply: false });
			} catch (error) {
				return { kind: "error", text: `${error instanceof Error ? error.message : String(error)}\n${USAGE}` };
			}
			if (preview.matches.length === 0) return { kind: "success", text: "No entries matched." };
			const list = preview.matches.map((entry) => `  ${entry.file}: ${entry.date} [id=${entry.id}] ${entry.conclusion}`).join("\n");
			if (flags.apply !== true) return { kind: "success", text: `Would forget ${preview.matches.length} entries${global ? " (global)" : ""}:\n${list}\nRe-run with --apply to write.` };
			const applied = global
				? await ctx.projectMemory.forgetGlobal({ id: flags.id, date: flags.date, query: flags.query }, { apply: true })
				: await ctx.projectMemory.forget(agent, { id: flags.id, date: flags.date, query: flags.query }, { apply: true });
			if (applied.applied !== true) return { kind: "error", text: applied.reason ?? "The forget did not apply." };
			return { kind: "success", text: `Forgot ${applied.matches.length} entries from ${applied.files.join(", ")}${global ? " (global)" : ""}.` };
		}
		case "promote": {
			if (flags.id === undefined) return { kind: "error", text: `promote needs --id\n${USAGE}` };
			const result = await ctx.projectMemory.promote(agent, flags.id, { apply: flags.apply });
			if (!result.ok) return { kind: "error", text: result.reason ?? "The promote did not apply." };
			const line = `${result.file}: ${result.entry.date} [id=${result.entry.id}] ${result.entry.conclusion}`;
			if (flags.apply !== true) return { kind: "success", text: `Would promote to global:\n  ${line}\nRe-run with --apply to write.` };
			return { kind: "success", text: `Promoted to global:\n  ${line}` };
		}
		default: return { kind: "error", text: `Unknown subcommand ${JSON.stringify(subcommand)}\n${USAGE}` };
	}
}

/**
 * Render the capacity report.
 * @param ctx - context carrying the memory service.
 * @param agent - the owning agent.
 * @param withPlan - whether to include the coarsening preview.
 * @returns the report text.
 */
async function report(ctx, agent, withPlan, global = false) {
	const status = global ? await ctx.projectMemory.statusGlobal() : await ctx.projectMemory.status(agent);
	const scope = global ? "Global" : "Project";
	const lines = [
		`${scope} memory: ${status.report.chars}/${status.report.maxChars} chars, ${status.report.bytes}/${status.report.maxBytes} bytes, ${status.entries} entries`,
		`  coarsening target ${status.report.targetChars}; injected budget is separate and bounded per request`
	];
	for (const file of status.files) lines.push(`  ${file.name}: ${file.entries} entries, ${file.chars} chars`);
	if (status.report.over) lines.push("OVER the ceiling: resolve or forget entries before writing more.");
	else if (status.report.nearTarget) lines.push("Past the coarsening target: the next write may coarsen older details.");
	else lines.push("Inside the coarsening target.");
	if (withPlan) {
		const plan = global ? await ctx.projectMemory.compactGlobal({ apply: false }) : await ctx.projectMemory.compact(agent, { apply: false });
		lines.push(plan.files.length === 0 ? "Coarsening plan: nothing to do." : `Coarsening plan: ${plan.files.join(", ")} (${plan.before.chars} → ${plan.after.chars} chars)`);
	}
	return lines.join("\n");
}

/**
 * Parse `/memory` flags.
 * @param tokens - arguments after the subcommand.
 * @returns `{ id, date, query, apply, global, error }`.
 */
function parseFlags(tokens) {
	const flags = { apply: false, global: false };
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === "--apply") {
			flags.apply = true;
			continue;
		}
		if (token === "--global") {
			flags.global = true;
			continue;
		}
		if (token === "--id" || token === "--date" || token === "--query") {
			const value = tokens[index + 1];
			if (value === undefined) {
				flags.error = `${token} needs a value`;
				return flags;
			}
			flags[token.slice(2)] = value;
			index += 1;
			continue;
		}
		flags.error = `unrecognized argument ${JSON.stringify(token)}`;
		return flags;
	}
	return flags;
}
