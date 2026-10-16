/**
 * `project_memory` — the model-facing half of project memory.
 *
 * One tool with an action rather than three tools, because every tool schema
 * is paid for on every request: the injected summary already carries the
 * standing knowledge, so what the model needs here is a way to *add* to it and
 * a way to *read back* the detail that the bounded summary had to leave out.
 * Forgetting stays a human command, since the one destructive operation should
 * not be one model call away.
 *
 * @module dsh-project-memory/tool
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import { KINDS, MEMORY_FILE_NAMES, STATUSES, renderEntry } from "./entries.js";

/** Loader row identity. */
export const name = "tool-project-memory";

/** The tool registry and the memory service. */
export const inject = ["tools", "projectMemory"];

/** Character ceiling for one `read` result. */
const READ_MAX_CHARS = 8_000;

const DESCRIPTION = [
	"Read or update this workspace's bounded project memory (the `.ai/` files).",
	"The memory is shared through the repository, so it is where a durable decision, a standing constraint, an unfinished task, a known bug, or a settled fact belongs — not chat narration, not secrets, and not anything the repository already states plainly.",
	"Use action=write to record or update one entry (updating by the same id replaces it in place).",
	"Use action=read to get full entries, including the detail the injected summary omitted for budget reasons.",
	"Use action=list to see capacity and counts before writing when the memory may be near its ceiling.",
	"A summary of the highest-priority entries is already in your system prompt; do not re-read it before every write."
].join(" ");

/**
 * Register `project_memory` on `ctx.tools`.
 * @param ctx - registrant context carrying the tool registry and the service.
 */
export function apply(ctx) {
	ctx.tools.register(
		defineTool({
			name: "project_memory",
			description: DESCRIPTION,
			parameters: {
				action: {
					type: "string",
					required: true,
					enum: ["write", "read", "list"],
					description: "write: add or update one entry. read: fetch full entries. list: capacity and counts."
				},
				file: {
					type: "string",
					enum: MEMORY_FILE_NAMES,
					description: "Which memory file: project.md (orientation), decisions.md, tasks.md, bugs.md, memory.md. Required for write; optional for read."
				},
				id: {
					type: "string",
					description: "Stable entry identifier, a single token without spaces. Writing with an existing id updates that entry; reading with it selects that entry."
				},
				kind: {
					type: "string",
					enum: KINDS,
					description: "write only. constraint: a rule that must keep holding. decision: a settled choice. task: work not finished. bug: a known defect. fact: durable project knowledge. history: background worth keeping."
				},
				status: {
					type: "string",
					enum: STATUSES,
					description: "write only. Defaults to active. done and resolved retire an entry from the injected summary but keep it in the file; superseded marks a decision that no longer applies."
				},
				conclusion: {
					type: "string",
					description: "write only. The current, complete conclusion in one line. State what is true now, not the story of how it was found."
				},
				details: {
					type: "array",
					items: { type: "string" },
					description: "write only. Optional supporting lines. Older entries have their details coarsened first when the memory approaches its capacity."
				},
				query: {
					type: "string",
					description: "read only. Substring to match against id, conclusion, and details."
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						text: {
							type: "string",
							required: true,
							description: "The result to show the model."
						},
						ok: {
							type: "boolean",
							required: true,
							description: "Whether the request was carried out."
						}
					}
				},
				render: (_args, value) => [{ type: "text", text: value.text }]
			},
			async execute(args, exec) {
				const agent = exec.agent;
				if (agent === undefined) throw new Error("project_memory requires an owning agent session");
				switch (args.action) {
					case "write": return writeAction(ctx, agent, args);
					case "read": return readAction(ctx, agent, args);
					case "list": return listAction(ctx, agent);
					/* v8 ignore next 2 -- the enum is enforced by the tool schema */
					default: return { ok: false, text: `unknown action ${JSON.stringify(args.action)}` };
				}
			},
			presentCall: () => ({
				card: "generic",
				title: "Project memory",
				kind: "other",
				rawInput: {}
			})
		})
	);
}

/**
 * Record one entry.
 * @param ctx - context carrying the memory service.
 * @param agent - the owning agent.
 * @param args - tool arguments.
 * @returns `{ ok, text }`.
 */
async function writeAction(ctx, agent, args) {
	if (args.file === undefined) return { ok: false, text: "write needs file." };
	if (args.id === undefined) return { ok: false, text: "write needs id — a stable token such as `resume-budget` or `no-remote-pushes`." };
	if (args.kind === undefined) return { ok: false, text: "write needs kind." };
	if (args.conclusion === undefined) return { ok: false, text: "write needs conclusion — the complete current conclusion in one line." };
	const outcome = await ctx.projectMemory.write(agent, {
		file: args.file,
		entry: {
			id: args.id,
			kind: args.kind,
			conclusion: args.conclusion,
			...(args.status === undefined ? {} : { status: args.status }),
			...(Array.isArray(args.details) ? { details: args.details } : {})
		}
	});
	if (!outcome.ok) return { ok: false, text: `Not written to ${outcome.file}: ${outcome.reason}` };
	const trimmed = outcome.coarsened ? " Older entries had their details coarsened to stay inside the ceiling." : "";
	return { ok: true, text: `Recorded ${args.id} in ${outcome.file} (memory now ${outcome.chars}/${outcome.bytes} chars/bytes).${trimmed}` };
}

/**
 * Read full entries back.
 * @param ctx - context carrying the memory service.
 * @param agent - the owning agent.
 * @param args - tool arguments.
 * @returns `{ ok, text }`.
 */
async function readAction(ctx, agent, args) {
	const { entries } = await ctx.projectMemory.load(agent);
	let selected = entries;
	if (args.file !== undefined) selected = selected.filter((entry) => entry.file === args.file);
	if (args.id !== undefined) selected = selected.filter((entry) => entry.id === args.id);
	if (args.query !== undefined) {
		const needle = args.query;
		selected = selected.filter((entry) => `${entry.id} ${entry.conclusion} ${(entry.details ?? []).join(" ")}`.includes(needle));
	}
	if (selected.length === 0) return { ok: true, text: "No matching project-memory entries." };
	const lines = [];
	let chars = 0;
	let omitted = 0;
	for (const entry of selected) {
		const block = `${entry.file}: ${renderEntry(entry)}`;
		if (chars + block.length > READ_MAX_CHARS) {
			omitted += 1;
			continue;
		}
		lines.push(block);
		chars += block.length + 1;
	}
	const tail = omitted === 0 ? "" : `\n(${omitted} more matching entries omitted for length.)`;
	return { ok: true, text: `${lines.join("\n")}${tail}` };
}

/**
 * Report capacity and counts.
 * @param ctx - context carrying the memory service.
 * @param agent - the owning agent.
 * @returns `{ ok, text }`.
 */
async function listAction(ctx, agent) {
	const status = await ctx.projectMemory.status(agent);
	const rows = status.files.map((file) => `  ${file.name}: ${file.entries} entries, ${file.chars} chars`);
	return {
		ok: true,
		text: [
			`Project memory at ${status.report.chars}/${status.report.maxChars} chars and ${status.report.bytes}/${status.report.maxBytes} bytes (coarsening target ${status.report.targetChars}).`,
			...rows,
			status.report.over
				? "Over the ceiling: forget or resolve entries before writing more."
				: status.report.nearTarget
					? "Past the coarsening target: the next write may coarsen older details."
					: "Inside the coarsening target."
		].join("\n")
	};
}
