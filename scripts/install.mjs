#!/usr/bin/env node
/**
 * Install (or remove) dsh-cookie-guard in a local DSH profile.
 *
 *   node scripts/install.mjs                     # install into ~/.dsh/profiles/desktop
 *   node scripts/install.mjs --profile web       # another profile
 *   node scripts/install.mjs --dry-run           # print what would change
 *   node scripts/install.mjs --uninstall         # remove the row and the copied package
 *
 * The official route is `dsh plugin --profile <name> add dsh-cookie-guard` once the
 * package is published. This script exists for machines where pnpm cannot write its
 * global store, and it only touches two things: the profile's node_modules copy of
 * this package, and the `- insert:` block at the end of the profile's cordis.patch.yml.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_NAME = "dsh-cookie-guard";
const MARKER = "# dsh-cookie-guard";
const ROW_ID = "cookie-guard";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
	const index = args.indexOf(name);
	return index === -1 || index === args.length - 1 ? fallback : args[index + 1];
};

const profileName = option("--profile", "desktop");
const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
const profileDir = path.join(dshHome, "profiles", profileName);
const patchFile = path.join(profileDir, "cordis.patch.yml");
const installDir = path.join(profileDir, "node_modules", PACKAGE_NAME);
const dryRun = flag("--dry-run");
const uninstall = flag("--uninstall");

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

if (!fs.existsSync(profileDir)) fail(`profile directory not found: ${profileDir}`);
if (!fs.existsSync(patchFile)) fail(`profile patch file not found: ${patchFile}`);

/** Drop every cookie-guard block, keeping whatever the user added around it. */
function stripBlock(lines) {
	const kept = [];
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		if (!line.startsWith(MARKER)) {
			kept.push(line);
			continue;
		}
		// Skip the marker line and the `- insert:` block that follows it.
		i += 1;
		if (i < lines.length && lines[i].trim() === "- insert:") {
			i += 1;
			while (i < lines.length) {
				const next = lines[i];
				if (next.trim() === "" || next.startsWith("  ")) {
					i += 1;
					continue;
				}
				break;
			}
			i -= 1;
		}
	}
	while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();
	return kept;
}

function writePatch(lines) {
	const text = lines.join("\n") + "\n";
	if (dryRun) {
		console.log(`[dry-run] would write ${patchFile}:\n${text.split("\n").slice(-9).join("\n")}`);
		return;
	}
	fs.writeFileSync(patchFile, text);
}

const existing = fs.readFileSync(patchFile, "utf8").split(/\r?\n/);
const backup = patchFile + ".bak-cookie-guard";
if (!dryRun && !fs.existsSync(backup)) fs.copyFileSync(patchFile, backup);

const stripped = stripBlock(existing);

if (uninstall) {
	if (!dryRun) {
		fs.rmSync(installDir, { recursive: true, force: true });
	}
	writePatch(stripped);
	console.log(`removed ${PACKAGE_NAME} from profile "${profileName}".`);
	console.log("restart DSH to unload the plugin.");
	process.exit(0);
}

if (!dryRun) {
	fs.rmSync(installDir, { recursive: true, force: true });
	fs.mkdirSync(installDir, { recursive: true });
	for (const entry of COPY) {
		const from = path.join(PACKAGE_ROOT, entry);
		if (!fs.existsSync(from)) continue;
		fs.cpSync(from, path.join(installDir, entry), { recursive: true });
	}
}
writePatch([...stripped, "", ...BLOCK]);

console.log(`profile:  ${profileDir}`);
console.log(`package:  ${installDir}${dryRun ? " (dry-run)" : ""}`);
console.log(`patch:    ${patchFile}${dryRun ? " (dry-run)" : ""}`);
console.log(`row:      ${ROW_ID} → ${PACKAGE_NAME}`);
console.log("");
console.log("restart DSH to load the plugin.");
