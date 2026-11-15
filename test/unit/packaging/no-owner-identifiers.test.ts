/**
 * The published package must not name the owner's machines, VPS or gateway,
 * carry a private-network address, or embed a home-directory path.
 *
 * The repository is mirrored publicly, so the forbidden names are stored only
 * as sha256 digests of their lowercase form. Every identifier-shaped token in
 * the built .js files under dist and bin/sinter, and every hyphen-joined run of its parts, is
 * hashed and compared. Needs `pnpm build` first; skips when dist is absent.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const DIST = path.join(ROOT, "dist");

const FORBIDDEN_NAME_DIGESTS = new Set([
		"dc96e9e7c1b7bee0add41ae8f98836cb1b75911d1510285f5c4ed0a2431adf95",
		"74e00167985829947706f57392435431232b2a930b9a56bc086b2f8a801a39e1",
		"881a1395cb2afbaaaabe954b77d33813d36bf8f7da1f7163bef5686a8fa9c951",
		"ac6d0b19457bf4104c1e2ce96aaedf15368d66d0f4da253573372745ab2f9d35",
		"6eff0a857bab0e9b67feac875c1667d55241db63a0d8ecebaa17c34ec19d3f36",
		"66634a2be625f483d0bf82449bc2363ff981486a6f53e4272d45ae17843bf8c4",
]);

function shippedFiles(): string[] {
	const out: string[] = [path.join(ROOT, "bin", "sinter")];
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".js")) out.push(full);
		}
	};
	// No dist means nothing was built; the first test then fails and says so.
	if (fs.existsSync(DIST)) walk(DIST);
	return out;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Every hyphen-joined contiguous run of a token's parts. */
export function candidateNames(token: string): string[] {
	const parts = token.split("-").filter(Boolean);
	const out: string[] = [];
	for (let i = 0; i < parts.length; i++) {
		for (let j = i + 1; j <= parts.length; j++) out.push(parts.slice(i, j).join("-"));
	}
	return out;
}

/** RFC1918 and CGNAT (100.64/10) host addresses. Network ids (x.0) are allowed;
 * link-local is not checked because the SSRF blocklist names metadata addresses. */
export function privateHostAddresses(text: string): string[] {
	const found: string[] = [];
	for (const m of text.matchAll(/(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.])/g)) {
		const [a, b, , d] = [m[1], m[2], m[3], m[4]].map(Number);
		if (d === 0) continue;
		const isPrivate = a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
			|| (a === 100 && b >= 64 && b <= 127);
		if (isPrivate) found.push(m[0]);
	}
	return found;
}

describe("published package carries no owner identifiers", () => {
	const files = shippedFiles();

	it("scans the built package (run pnpm build first)", () => {
		expect(files).toContain(path.join(DIST, "index.js"));
		expect(files).toContain(path.join(ROOT, "bin", "sinter"));
	});

	it("names none of the owner's machines, VPS or gateway", () => {
		const hits: string[] = [];
		for (const file of files) {
			const text = fs.readFileSync(file, "utf8").toLowerCase();
			for (const token of new Set(text.match(/[a-z0-9][a-z0-9-]{3,40}/g) ?? [])) {
				for (const name of candidateNames(token)) {
					if (FORBIDDEN_NAME_DIGESTS.has(sha(name))) hits.push(`${path.relative(ROOT, file)}: ${sha(name).slice(0, 12)}`);
				}
			}
		}
		expect(hits).toEqual([]);
	});

	it("carries no private-network host address", () => {
		const hits = files.flatMap((file) =>
			privateHostAddresses(fs.readFileSync(file, "utf8")).map((ip) => `${path.relative(ROOT, file)}: ${ip}`));
		expect(hits).toEqual([]);
	});

	it("embeds no home-directory path", () => {
		const hits = files.filter((file) => /\/home\/[a-z0-9_-]+\/|\/Users\/[A-Za-z0-9_-]+\//.test(fs.readFileSync(file, "utf8")));
		expect(hits.map((f) => path.relative(ROOT, f))).toEqual([]);
	});
});

describe("owner-identifier scanners", () => {
	it("splits tokens into every hyphen run", () => {
		expect(candidateNames("a-b-c")).toEqual(["a", "a-b", "a-b-c", "b", "b-c", "c"]);
		expect(candidateNames("")).toEqual([]);
	});

	it("flags private host addresses and skips network ids and public ones", () => {
		expect(privateHostAddresses("x 10.0.0.0 192.168.1.20 8.8.8.8 <internal-host> 1.2.3.4.5")).toEqual(["192.168.1.20", "<internal-host>"]);
		expect(privateHostAddresses("")).toEqual([]);
	});
});
