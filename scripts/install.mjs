#!/usr/bin/env node
/**
 * Install (or remove) dsh-cookie-guard in a local DSH profile.
 *
 *   node scripts/install.mjs                     # install into ~/.dsh/profiles/desktop
 *   node scripts/install.mjs --profile web       # another profile
 *   node scripts/install.mjs --dry-run           # print the planned changes
 *   node scripts/install.mjs --legacy            # skip pnpm, hand-mount instead
 *   node scripts/install.mjs --uninstall         # undo everything it added
 *
 * Preferred route: declare the plugin as a `link:` dependency plus a
 * `dsh.profile.bundles` entry, then let pnpm materialize the symlink. That is
 * what the in-app plugin manager understands, so the plugin shows up on the
 * Plugins page and survives later plugin-manager installs.
 *
 * Fallback (--legacy, or when pnpm cannot run): copy the package into
 * `<profile>/node_modules/` and append an `- insert:` row to the profile's
 * `cordis.patch.yml`. The plugin then works but stays invisible to the Plugins
 * page, and a later plugin-manager install rebuilds node_modules and removes it.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_NAME = "dsh-cookie-guard";
const ROW_ID = "cookie-guard";
const MARKER = "# dsh-cookie-guard";
const LINK_TARGET = PACKAGE_ROOT.replace(/\\/g, "/");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
	const index = args.indexOf(name);
	return index === -1 || index === args.length - 1 ? fallback : args[index + 1];
};

const profileName = option("--profile", "desktop");
const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
const profileDir = path.join(dshHome, "profiles", profileName);
const manifestFile = path.join(profileDir, "package.json");
const patchFile = path.join(profileDir, "cordis.patch.yml");
const installDir = path.join(profileDir, "node_modules", PACKAGE_NAME);
const dryRun = flag("--dry-run");
const uninstall = flag("--uninstall");
const legacy = flag("--legacy");

const BLOCK = [
	MARKER + ": raise the host header budget and expire stale dsh-auth cookies",
	"- insert:",
	`    - id: ${ROW_ID}`,
	`      name: ${PACKAGE_NAME}`,
	"      config:",
	"        maxHeaderSize: 131072",
	"        cleanStale: true",
	"        log: true",
];

const COPY = ["package.json", "cordis.patch.yml", "lib", "locale", "icon.svg", "test", "README.md", "LICENSE"];

function fail(message) {
	console.error(`error: ${message}`);
	process.exit(1);
}

function backup(file) {
	const bak = `${file}.bak-cookie-guard`;
	if (fs.existsSync(file) && !fs.existsSync(bak)) fs.copyFileSync(file, bak);
}

/** Locate a pnpm that can install into this profile. */
function findPnpm() {
	if (process.env.DSH_PNPM) return { command: process.env.DSH_PNPM, args: [] };

	const root = path.join(dshHome, "dsh-runtimes");
	if (fs.existsSync(root)) {
		for (const runtime of fs.readdirSync(root)) {
			const deps = path.join(root, runtime, "dependencies");
			const pnpm = path.join(deps, "pnpm", "bin", "pnpm.mjs");
			const node = path.join(deps, "node", process.platform === "win32" ? "node.exe" : "bin/node");
			if (fs.existsSync(pnpm) && fs.existsSync(node)) return { command: node, args: [pnpm] };
		}
	}

	const which = spawnSync(process.platform === "win32" ? "where" : "which", ["pnpm"], { encoding: "utf8" });
	if (which.status === 0 && which.stdout.trim()) return { command: "pnpm", args: [] };
	return undefined;
}

function runPnpm(pnpm) {
	const result = spawnSync(pnpm.command, [...pnpm.args, "install"], { cwd: profileDir, stdio: "inherit" });
	return result.status === 0;
}

if (!fs.existsSync(profileDir)) fail(`profile directory not found: ${profileDir}`);
if (!fs.existsSync(manifestFile)) fail(`profile manifest not found: ${manifestFile}`);

const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
manifest.dependencies = manifest.dependencies ?? {};
manifest.dsh = manifest.dsh ?? {};
manifest.dsh.profile = manifest.dsh.profile ?? {};
manifest.dsh.profile.bundles = manifest.dsh.profile.bundles ?? [];

/** Drop every cookie-guard mount block, keeping whatever the user added around it. */
function stripMount(lines) {
	const kept = [];
	for (let i = 0; i < lines.length; i += 1) {
		if (!lines[i].startsWith(MARKER)) {
			kept.push(lines[i]);
			continue;
		}
		i += 1;
		if (i < lines.length && lines[i].trim() === "- insert:") {
			i += 1;
			while (i < lines.length && (lines[i].trim() === "" || lines[i].startsWith("  "))) i += 1;
			i -= 1;
		}
	}
	while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();
	return kept;
}

function writeManifest() {
	if (dryRun) {
		console.log(`[dry-run] would write ${manifestFile}`);
		console.log(`  dependencies["${PACKAGE_NAME}"] = "link:${LINK_TARGET}"`);
		console.log(`  dsh.profile.bundles += ${PACKAGE_NAME}`);
		return;
	}
	fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
}

function writePatch(lines) {
	if (!fs.existsSync(patchFile)) return;
	const text = lines.length === 0 ? "" : lines.join("\n") + "\n";
	if (dryRun) {
		console.log(`[dry-run] would write ${patchFile} (${text.length} bytes)`);
		return;
	}
	fs.writeFileSync(patchFile, text);
}

const patchLines = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, "utf8").split(/\r?\n/) : [];

if (uninstall) {
	delete manifest.dependencies[PACKAGE_NAME];
	manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((name) => name !== PACKAGE_NAME);
	backup(manifestFile);
	writeManifest();

	if (!dryRun) {
		const pnpm = findPnpm();
		if (pnpm) runPnpm(pnpm);
		fs.rmSync(installDir, { recursive: true, force: true });
	}
	writePatch(stripMount(patchLines));

	console.log(`removed ${PACKAGE_NAME} from profile "${profileName}".`);
	console.log("restart DSH to unload the plugin.");
	process.exit(0);
}

manifest.dependencies[PACKAGE_NAME] = `link:${LINK_TARGET}`;
if (!manifest.dsh.profile.bundles.includes(PACKAGE_NAME)) manifest.dsh.profile.bundles.push(PACKAGE_NAME);
backup(manifestFile);
writeManifest();

const pnpm = legacy ? undefined : findPnpm();
let installed = false;

if (pnpm) {
	if (dryRun) {
		console.log(`[dry-run] would run: ${pnpm.command} ${[...pnpm.args, "install"].join(" ")} (cwd ${profileDir})`);
		installed = true;
	} else {
		installed = runPnpm(pnpm);
		if (!installed) console.warn("pnpm install failed; falling back to a hand-mounted copy.");
	}
}

if (dryRun) {
	// nothing else to do
} else if (installed) {
	// pnpm owns node_modules; keep the profile patch free of our own row so the
	// bundle patch stays the single mount point.
	writePatch(stripMount(patchLines));
} else {
	fs.rmSync(installDir, { recursive: true, force: true });
	fs.mkdirSync(installDir, { recursive: true });
	for (const entry of COPY) {
		const from = path.join(PACKAGE_ROOT, entry);
		if (!fs.existsSync(from)) continue;
		fs.cpSync(from, path.join(installDir, entry), { recursive: true });
	}
	backup(patchFile);
	writePatch([...stripMount(patchLines), "", ...BLOCK]);
	console.warn("hand-mounted the package and added a cordis.patch.yml row.");
	console.warn("the Plugins page will not list it, and a later plugin-manager install may remove it.");
	console.warn("re-run with a working pnpm (or --legacy) if that happens.");
}

console.log(`profile:  ${profileDir}`);
console.log(`package:  ${installDir}${dryRun ? " (dry-run)" : ""}`);
console.log(`bundles:  ${manifest.dsh.profile.bundles.slice(-2).join(", ")}`);
console.log("");
console.log("restart DSH to load the plugin.");
