#!/usr/bin/env node
/**
 * Link the installed DeepSeek Harness packages this bundle imports into this
 * checkout, so a *local-path* install can resolve them (Node port of
 * scripts/dev-link.sh).
 *
 * Why this is needed: `dsh plugin add /abs/path` installs a `link:` dependency,
 * and Node's ESM resolver follows that symlink to this repository's real path.
 * Resolution then walks up from here and never reaches the profile's
 * node_modules. A git install has no such problem, so this is a development
 * convenience, not part of a normal install.
 *
 * The Windows difference is the `dsh` shim: there `dsh` on PATH is a .cmd file
 * that points at an npm package, not the JavaScript entry a shell script would
 * see. This port follows the shim to that package before applying the same
 * two-candidate lookup the shell script uses.
 *
 * Usage: node scripts/dev-link.mjs [directory containing @deepseek-ai/dsh-*]
 *   DSH_PACKAGE_DIR  same, via environment
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root; scripts/ is one level down. */
const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Packages this bundle imports; links are created for each. */
const PACKAGES = ["cordis", "dsh-tools", "dsh-commands", "dsh-system-prompt", "schemastery"];

const IS_WINDOWS = process.platform === "win32";

const packageDir = findPackageDir(process.argv[2] ?? process.env.DSH_PACKAGE_DIR ?? "");

const linkDir = path.join(here, "node_modules", "@deepseek-ai");
fs.mkdirSync(linkDir, { recursive: true });

for (const pkg of PACKAGES) {
	const target = path.join(packageDir, pkg);
	const link = path.join(linkDir, pkg);
	removeExistingLink(link);
	// 'junction' is the only directory link Windows can create without the
	// symlink privilege; elsewhere a plain directory symlink is the same thing.
	fs.symlinkSync(target, link, IS_WINDOWS ? "junction" : "dir");
	console.log(`dev-link: linked ${pkg}`);
}

console.log("dev-link: local-path installs can now resolve the harness packages");

/**
 * Resolve the directory holding the installed harness packages.
 *
 * The shell script resolves `dsh` to its JavaScript entry and tries
 * `<package>/node_modules/@deepseek-ai` and then the package's parent. On
 * Windows the PATH entry is an npm .cmd shim, so this reads that shim's sibling
 * package.json to find the same JavaScript entry first.
 *
 * @param explicit - a directory from argv or DSH_PACKAGE_DIR, or "".
 * @returns the directory containing cordis/ and dsh-tools/.
 */
function findPackageDir(explicit) {
	if (explicit !== "") return requirePackages(explicit);
	const shim = findDsh();
	if (shim === undefined) {
		console.error("dev-link: cannot find 'dsh' on PATH; pass the directory holding @deepseek-ai/dsh-* instead");
		process.exit(1);
	}
	const resolved = fs.realpathSync(shim);
	const dshPackage = IS_WINDOWS && /\.(cmd|bat)$/i.test(resolved) ? shimPackageDir(resolved) : path.dirname(path.dirname(resolved));
	if (dshPackage !== undefined) {
		for (const candidate of [path.join(dshPackage, "node_modules", "@deepseek-ai"), path.dirname(dshPackage)]) {
			if (hasPackages(candidate)) return candidate;
		}
	}
	return requirePackages("");
}

/**
 * Return a directory after checking it, or exit with the shell script's message.
 * @param directory - the candidate directory, or "" when unresolved.
 * @returns the same directory.
 */
function requirePackages(directory) {
	if (directory === "" || !hasPackages(directory)) {
		console.error(`dev-link: no cordis/dsh-tools under '${directory === "" ? "<unresolved>" : directory}'`);
		process.exit(1);
	}
	return path.resolve(directory);
}

/**
 * Whether a directory holds the two packages the shell script probes for.
 * @param directory - the directory to test.
 * @returns `true` when both `cordis` and `dsh-tools` are directories.
 */
function hasPackages(directory) {
	return isDirectory(path.join(directory, "cordis")) && isDirectory(path.join(directory, "dsh-tools"));
}

/**
 * The package directory behind an npm .cmd/.bat shim.
 * @param shim - the `.cmd`/`.bat` path.
 * @returns the `@deepseek-ai/dsh` directory, or `undefined` for another layout.
 */
function shimPackageDir(shim) {
	const root = path.join(path.dirname(shim), "node_modules", "@deepseek-ai", "dsh");
	try {
		const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
		const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.dsh;
		if (typeof bin !== "string") return undefined;
		const entry = path.resolve(root, bin);
		return fs.existsSync(entry) ? root : undefined;
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
 * Remove a previous link so re-running replaces it, as `ln -sfn` does.
 *
 * Windows junctions are directories to `unlink`, so the fallbacks try `rmdir`
 * and finally `rm`; none of them follows the link into the harness packages.
 * @param link - the path to remove if present.
 */
function removeExistingLink(link) {
	try {
		fs.lstatSync(link);
	} catch {
		return;
	}
	for (const remove of [() => fs.unlinkSync(link), () => fs.rmdirSync(link), () => fs.rmSync(link, { recursive: true, force: true })]) {
		try {
			remove();
			return;
		} catch {
			// Try the next removal form.
		}
	}
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
