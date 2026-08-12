#!/usr/bin/env node
// Verifies the VSIX produced by `npm run package`:
//   - a fresh VSIX exists for the current name/version and was created after
//     the local build (a stale artifact cannot pass);
//   - required runtime/docs/media files are present and development-only data
//     is excluded per .vscodeignore;
//   - the packaged extension/dist/extension.js is byte-for-byte identical to
//     the locally built bundle (sha256 comparison).
// Pure Node, no network and no package-manager downloads. The packager's exit
// code alone never turns a broken package into a success.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const vsixPath = join(root, `${pkg.name}-${pkg.version}.vsix`);
const bundlePath = join(root, "dist", "extension.js");

const failures = [];
const fail = (msg) => failures.push(msg);

if (!existsSync(bundlePath)) {
	console.error(
		`No local build at ${bundlePath}. Run 'npm run compile' first.`,
	);
	process.exit(1);
}

if (!existsSync(vsixPath)) {
	fail(`No VSIX produced at expected path ${vsixPath}`);
	console.error("Package verification FAILED:");
	for (const msg of failures) {
		console.error(`  - ${msg}`);
	}
	process.exit(1);
}

const vsixMtime = statSync(vsixPath).mtimeMs;
const bundleMtime = statSync(bundlePath).mtimeMs;
if (vsixMtime < bundleMtime) {
	fail(
		`VSIX at ${vsixPath} predates the local build; it was not produced by this packaging run.`,
	);
}

const vsixBuffer = readFileSync(vsixPath);
const entries = readZipCentralDirectory(vsixBuffer);

const packagedBundleName = "extension/dist/extension.js";
const packagedBundle = entries.find((e) => e.name === packagedBundleName);

if (!packagedBundle) {
	fail(`VSIX does not contain ${packagedBundleName}`);
} else {
	const localHash = sha256(readFileSync(bundlePath));
	const packagedHash = sha256(extractEntry(vsixBuffer, packagedBundle));
	if (localHash !== packagedHash) {
		fail(
			`Packaged bundle hash (${packagedHash}) does not match local build (${localHash}).`,
		);
	} else {
		console.log(`Bundle hash OK: ${packagedHash}`);
	}
}

const requiredFiles = [
	"extension/package.json",
	"extension/dist/extension.js",
	"extension/readme.md",
	"extension/changelog.md",
	"extension/LICENSE.txt",
	"extension/media/icon.svg",
	"extension/media/marketplace/icon.png",
	"extension/media/webview/home.css",
	"extension/media/webview/home.js",
	"extension/media/webview/sidebar.css",
	"extension/media/webview/sidebar.js",
	"extension/docs/roadmap.md",
];

for (const required of requiredFiles) {
	if (!entries.some((e) => e.name === required)) {
		fail(`VSIX is missing required file: ${required}`);
	}
}

const forbiddenPrefixes = [
	"extension/src",
	"extension/scripts",
	"extension/node_modules",
	"extension/feature",
	"extension/.git",
	"extension/.vscode",
	"extension/.agentspace",
	"extension/.codegraph",
];

const forbiddenFiles = [
	"extension/esbuild.js",
	"extension/tsconfig.json",
	"extension/biome.json",
	"extension/vitest.config.ts",
	"extension/bun.lock",
	"extension/pnpm-lock.yaml",
	"extension/pnpm-workspace.yaml",
	"extension/AGENTS.md",
	"extension/.vscodeignore",
	"extension/media/webview/_test_home.html",
	"extension/media/webview/_test_sidebar.html",
];

for (const entry of entries) {
	const name = entry.name;
	if (name === "[Content_Types].xml" || name === "extension.vsixmanifest") {
		continue;
	}
	if (name.endsWith(".map")) {
		fail(`VSIX contains a source map (development-only): ${name}`);
	}
	for (const prefix of forbiddenPrefixes) {
		if (name.startsWith(prefix)) {
			fail(`VSIX contains development-only path: ${name}`);
		}
	}
}

for (const forbidden of forbiddenFiles) {
	if (entries.some((e) => e.name === forbidden)) {
		fail(`VSIX contains development-only file: ${forbidden}`);
	}
}

const packagedPkgEntry = entries.find(
	(e) => e.name === "extension/package.json",
);
if (packagedPkgEntry) {
	const packagedPkg = JSON.parse(
		extractEntry(vsixBuffer, packagedPkgEntry).toString("utf8"),
	);
	const identity = {
		name: pkg.name,
		publisher: pkg.publisher,
		version: pkg.version,
	};
	for (const [key, expected] of Object.entries(identity)) {
		if (packagedPkg[key] !== expected) {
			fail(
				`Packaged package.json ${key} is '${packagedPkg[key]}', expected '${expected}'.`,
			);
		}
	}
}

if (failures.length > 0) {
	console.error("Package verification FAILED:");
	for (const msg of failures) {
		console.error(`  - ${msg}`);
	}
	process.exit(1);
}

console.log(`Package verification OK: ${vsixPath} (${entries.length} entries)`);

function sha256(buffer) {
	return createHash("sha256").update(buffer).digest("hex");
}

function readZipCentralDirectory(buffer) {
	const eocd = findEndOfCentralDirectory(buffer);
	const count = eocd.readUInt16LE(10);
	const cdOffset = eocd.readUInt32LE(16);
	const entries = [];
	let pos = cdOffset;
	for (let i = 0; i < count; i++) {
		if (buffer.readUInt32LE(pos) !== 0x02014b50) {
			throw new Error("zip: invalid central directory signature");
		}
		const method = buffer.readUInt16LE(pos + 10);
		const compSize = buffer.readUInt32LE(pos + 20);
		const nameLen = buffer.readUInt16LE(pos + 28);
		const extraLen = buffer.readUInt16LE(pos + 30);
		const commentLen = buffer.readUInt16LE(pos + 32);
		const localOffset = buffer.readUInt32LE(pos + 42);
		const name = buffer.subarray(pos + 46, pos + 46 + nameLen).toString("utf8");
		entries.push({ name, method, compSize, localOffset });
		pos += 46 + nameLen + extraLen + commentLen;
	}
	return entries;
}

function findEndOfCentralDirectory(buffer) {
	for (let i = buffer.length - 22; i >= 0; i--) {
		if (buffer.readUInt32LE(i) === 0x06054b50) {
			const commentLen = buffer.readUInt16LE(i + 20);
			if (i + 22 + commentLen === buffer.length) {
				return buffer.subarray(i, i + 22);
			}
		}
	}
	throw new Error("zip: end of central directory not found");
}

function extractEntry(buffer, entry) {
	const nameLen = buffer.readUInt16LE(entry.localOffset + 26);
	const extraLen = buffer.readUInt16LE(entry.localOffset + 28);
	const dataStart = entry.localOffset + 30 + nameLen + extraLen;
	const data = buffer.subarray(dataStart, dataStart + entry.compSize);
	if (entry.method === 0) {
		return data;
	}
	if (entry.method === 8) {
		return inflateRawSync(data);
	}
	throw new Error(
		`zip: unsupported compression method ${entry.method} for ${entry.name}`,
	);
}
