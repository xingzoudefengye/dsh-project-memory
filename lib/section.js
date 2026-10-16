/**
 * The stable prompt section that carries project memory into a session.
 *
 * The section renders the service's *frozen* projection, so within one session
 * the injected text is byte-identical on every request and cannot push the
 * provider's cached prefix around. Preparing that projection is asynchronous
 * file I/O, which a synchronous prompt section cannot do — so this row starts
 * the read when the agent is created and awaits it once per step, closing the
 * gap rather than letting the first assembly race the filesystem.
 *
 * The placement is a literal order rather than `getSectionOrder(...)`: that
 * map is upstream's own vocabulary, and a bundle inventing a name inside it
 * would break on the next harness release. Just below the harness-source note
 * keeps project knowledge in the prompt's tail, after the tool guidance.
 *
 * @module dsh-project-memory/section
 */

/** Loader row identity. */
export const name = "project-memory-section";

/** The prompt registry and the memory service. */
export const inject = ["systemPrompt", "projectMemory"];

/** Sort order inside the system prompt; see the module note for why it is literal. */
const SECTION_ORDER = 9_500;

/** Section name, unique within the composed prompt. */
const SECTION_NAME = "project-memory";

/**
 * Install the section and its projection lifecycle.
 * @param ctx - owning cordis context.
 */
export function apply(ctx) {
	ctx.systemPrompt.section({
		name: SECTION_NAME,
		order: SECTION_ORDER,
		text: (context) => ctx.projectMemory.injected(context.agent)
	});
	ctx.on("agent/created", ({ agent }) => {
		// Fire and forget: the first assembly usually happens after a human
		// acts, and the awaited call below is what makes it certain.
		void ctx.projectMemory.prepare(agent);
	});
	ctx.on("agent/pre-step", async ({ agent }, next) => {
		try {
			await ctx.projectMemory.prepare(agent);
		} catch {
			// prepare() already swallows its own failures; this guards the
			// policy itself, which must never break a turn.
		}
		return next();
	});
	ctx.on("agent/disposed", ({ agent }) => {
		ctx.projectMemory.release(agent);
	});
}
