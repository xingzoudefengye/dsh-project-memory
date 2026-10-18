#!/usr/bin/env node
/**
 * Verify one profile's project-memory wiring (Node port of scripts/check.sh):
 *   1. all four rows are present in the composed tree;
 *   2. the stable prompt section is placed where this bundle intends.
 *
 * The shell script cannot run on a stock Windows install — there is no bash,
 * and `dsh` is a `dsh.cmd` npm shim that Node refuses to spawn directly
 * (EINVAL). This port therefore finds `dsh` on PATH, and when it is a cmd/bat
 * shim with an npm-installed sibling it runs that package's JavaScript entry
 * with the current `node` instead. Anywhere else it spawns the shim as-is.
 *
 * Usage: node scripts/check.mjs [profile]   (default: web)
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Profile to inspect; the shell script defaults to `web` too. */
const PROFILE = process.argv[2] ?? "web";

/** Same resolution as the plugin: $DSH_HOME, else ~/.dsh. */
const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
const PROFILE_DIR = path.join(DSH_HOME, "profiles", PROFILE);

/** The four rows the bundle inserts, in patch order. */
const ROWS = ["project-memory", "project-memory-section", "tool-project-memory", "command-project-memory"];

/** Largest dump we are willing to buffer; this machine's is ~55 KB. */
const MAX_BUFFER = 64 * 1024 * 1024;

const IS_WINDOWS = process.platform === "win32";

if (!isDirectory(PROFILE_DIR)) {
	console.error(`FAIL: no such profile: ${PROFILE_DIR}`);
	process.exit(1);
}

/** The config dump, or exit 1 with the reason dsh could not produce it. */
const dump = dumpConfig();
const status = report(dump);
process.exitCode = status;

/**
 * Read `dsh --profile <p> --dump-config` into a temporary file and return it.
 * @returns the dump text.
 */
function dumpConfig() {
	const shim = findDsh();
	if (shim === undefined) {
		console.error("FAIL: cannot find 'dsh' on PATH — install DeepSeek Harness first");
		process.exit(1);
	}
	const result = runDsh(shim, ["--profile", PROFILE, "--dump-config"]);
	if (result.error !== undefined) {
		console.error(`FAIL: could not run ${shim}: ${result.error.message}`);
		process.exit(1);
	}
	if (result.status !== 0) {
		const detail = (result.stderr ?? "").trim();
		console.error(`FAIL: dsh --profile ${PROFILE} --dump-config exited with code ${result.status}${detail === "" ? "" : `: ${detail}`}`);
		process.exit(1);
	}
	const temporary = path.join(os.tmpdir(), `dsh-project-memory-check-${process.pid}-${Date.now().toString(36)}.txt`);
	try {
		fs.writeFileSync(temporary, result.stdout ?? "", "utf8");
		return fs.readFileSync(temporary, "utf8");
	} finally {
		try {
			fs.unlinkSync(temporary);
		} catch {
			// A leftover temp file must not turn a passing check into a failure.
		}
	}
}

/**
 * Print the same ok/FAIL/note lines as scripts/check.sh.
 * @param text - the composed config dump.
 * @returns the process exit code.
 */
function report(text) {
	let status = 0;
	for (const row of ROWS) {
		if (text.includes(`id: ${row}`)) {
			console.log(`ok:   ${row} is in the composed tree`);
		} else {
			console.error(`FAIL: ${row} is missing — install this bundle: dsh plugin --profile ${PROFILE} add github:xingzoudefengye/dsh-project-memory`);
			status = 1;
		}
	}
	if (text.includes("dsh-project-memory/section")) {
		console.log("ok:   the prompt section row is mounted");
	} else {
		console.error("FAIL: dsh-project-memory/section is not mounted");
		status = 1;
	}
	const globalDir = path.join(DSH_HOME, "project-memory");
	if (isDirectory(globalDir)) {
		console.log(`ok:   the global layer exists (${globalDir})`);
	} else {
		console.log("note: no global layer yet — create it with /memory init --global (optional, cross-project memory)");
	}
	return status;
}

/**
 * Run dsh with the given arguments, working around the Windows cmd shim.
 *
 * `spawnSync('dsh.cmd', …)` fails with EINVAL on current Node: a batch file is
 * not an executable image, and only `shell: true` (which then guesses the
 * quoting) can start it. The npm shim sits next to the package it launches, so
 * this runs that package's `bin` entry with the running node instead. That is
 * the same program the shim would have started, without cmd.exe in the middle.
 *
 * @param shim - the resolved dsh path.
 * @param args - arguments after the program name.
 * @returns the spawnSync result.
 */
function runDsh(shim, args) {
	if (IS_WINDOWS && /\.(cmd|bat)$/i.test(shim)) {
		const entry = npmShimEntry(shim);
		if (entry !== undefined) return spawnSync(process.execPath, [entry, ...args], options());
		// No sibling package (an unusual layout): let cmd.exe interpret the shim.
		const command = `"${shim}" ${args.map(quoteForCmd).join(" ")}`;
		return spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command], options());
	}
	return spawnSync(shim, args, options());
}

/** spawnSync options shared by every attempt. */
function options() {
	return { encoding: "utf8", maxBuffer: MAX_BUFFER, env: process.env };
}

/**
 * Resolve the JavaScript entry of an npm cmd/bat shim from its sibling package.
 * @param shim - the `.cmd`/`.bat` path on PATH.
 * @returns the absolute `bin` entry, or `undefined` when this is not npm's layout.
 */
function npmShimEntry(shim) {
	const root = path.join(path.dirname(shim), "node_modules", "@deepseek-ai", "dsh");
	try {
		const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
		const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.dsh;
		if (typeof bin !== "string") return undefined;
		const entry = path.resolve(root, bin);
		return fs.existsSync(entry) ? entry : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Find the dsh command on PATH, preferring the Windows shim over the
 * extensionless shell script that Windows cannot execute.
 * @returns the path, or `undefined`.
 */
function findDsh() {
	const names = IS_WINDOWS ? ["dsh.cmd", "dsh.exe", "dsh.bat", "dsh"] : ["dsh"];
	for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
		if (directory === "") continue;
		for (const name of names) {
			const candidate = path.join(directory, name);
			try {
				if (!fs.statSync(candidate).isFile()) continue;
				fs.accessSync(candidate, IS_WINDOWS ? fs.constants.F_OK : fs.constants.X_OK);
				return candidate;
			} catch {
				// Not here (or not executable): keep looking.
			}
		}
	}
	return undefined;
}

/**
 * Quote one argument for the cmd.exe fallback.
 * @param value - the argument.
 * @returns the quoted argument.
 */
function quoteForCmd(value) {
	return `"${String(value).replaceAll('"', '""')}"`;
}

/**
 * Whether a path exists and is a directory.
 * @param target - the path to test.
 * @returns `true` for an existing directory.
 */
function isDirectory(target) {
	try {
		return fs.statSync(target).isDirectory();
	} catch {
		return false;
	}
}
