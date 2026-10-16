import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Downloads selected Waza rules from GitHub and injects them into the system
 * prompt as the `waza_rules` section.
 *
 * Config (optional): <agent-dir>/extensions/pi-waza-rules/config.json
 * Config and cache live in the agent dir, not in the package directory, so git
 * and npm installs behave the same and package updates cannot overwrite them.
 *   {
 *     "ref": "main",                                          // "main" or a release tag like "v3.24.0"
 *     "rules": ["waza-routing", "anti-patterns", "clarity"],  // which rules to load, in injection order
 *     "checkIntervalHours": 24                                // 0 = check on every session start
 *   }
 *
 * Contract:
 * - Rules are cached in <agent-dir>/extensions/pi-waza-rules/.cache/<ref>/<name>.md. The marker file
 *   .checked in that directory records the last complete check: its mtime is the check
 *   time and its content lists configured rules GitHub did not have.
 * - An update check runs when the marker is missing or older than the interval,
 *   or when a configured rule is neither cached nor listed as not found. It lists
 *   rules/ through the GitHub contents API and downloads only files whose git
 *   blob sha differs from the locally computed one. GITHUB_TOKEN or GH_TOKEN, if
 *   set, is sent to api.github.com only.
 * - Any network or write failure keeps the local copies, reports a warning and
 *   leaves the marker untouched so the next session retries.
 * - Every request has its own timeout and is aborted on session shutdown.
 * - If nothing can be loaded, the section is removed rather than left stale.
 */

const SECTION = "waza_rules";
const REPO = "tw93/Waza";
const FETCH_TIMEOUT_MS = 5000;
const DEFAULT_RULES = ["waza-routing", "anti-patterns", "clarity"];
// Same constraints as Waza's scripts/setup-rule.sh.
const RULE_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const REF_RE = /^(?:main|v\d+\.\d+\.\d+)$/;
const MARKER = ".checked";

const stateDir = () => join(getAgentDir(), "extensions", "pi-waza-rules");

interface Config {
	ref: string;
	rules: string[];
	checkIntervalHours: number;
}

interface Loaded {
	text: string;
	files: string[];
	missing: string[];
	warnings: string[];
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

function readConfig(warnings: Set<string>): Config {
	const path = join(stateDir(), "config.json");
	const cfg: Config = { ref: "main", rules: [...DEFAULT_RULES], checkIntervalHours: 24 };

	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf-8"));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			warnings.add(`invalid ${path} (${errMsg(err)}); using defaults`);
		}
		return cfg;
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		warnings.add(`${path} must contain a JSON object; using defaults`);
		return cfg;
	}

	const { ref, rules, checkIntervalHours } = raw as Record<string, unknown>;
	if (ref !== undefined) {
		if (typeof ref === "string" && REF_RE.test(ref)) cfg.ref = ref;
		else warnings.add(`ignoring ref ${JSON.stringify(ref)}: must be "main" or a release tag like v3.24.0`);
	}
	if (rules !== undefined) {
		if (Array.isArray(rules)) {
			const invalid = rules.filter((r) => typeof r !== "string" || !RULE_RE.test(r));
			if (invalid.length > 0) warnings.add(`ignoring invalid rule names: ${invalid.map((r) => JSON.stringify(r)).join(", ")}`);
			cfg.rules = [...new Set(rules.filter((r): r is string => typeof r === "string" && RULE_RE.test(r)))];
		} else {
			warnings.add("ignoring rules: must be an array of rule names");
		}
	}
	if (checkIntervalHours !== undefined) {
		if (typeof checkIntervalHours === "number" && Number.isFinite(checkIntervalHours) && checkIntervalHours >= 0) {
			cfg.checkIntervalHours = checkIntervalHours;
		} else {
			warnings.add("ignoring checkIntervalHours: must be a number >= 0");
		}
	}
	return cfg;
}

function readBuf(file: string): Buffer | null {
	try {
		return readFileSync(file);
	} catch {
		return null;
	}
}

/** Git blob sha1, the value GitHub's contents API reports as `sha`. */
function blobSha(buf: Buffer): string {
	return createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
}

function readMarker(dir: string): { mtimeMs: number; notFound: Set<string> } | null {
	try {
		const file = join(dir, MARKER);
		const parsed = JSON.parse(readFileSync(file, "utf-8")) as { notFound?: unknown };
		const names = Array.isArray(parsed.notFound) ? parsed.notFound.filter((n): n is string => typeof n === "string") : [];
		return { mtimeMs: statSync(file).mtimeMs, notFound: new Set(names) };
	} catch {
		return null;
	}
}

function needsCheck(cfg: Config, dir: string): boolean {
	if (cfg.checkIntervalHours === 0) return true;
	const marker = readMarker(dir);
	if (!marker) return true;
	if (Date.now() - marker.mtimeMs >= cfg.checkIntervalHours * 3_600_000) return true;
	return cfg.rules.some((name) => !marker.notFound.has(name) && !existsSync(join(dir, `${name}.md`)));
}

/** Returns verified contents by rule name. Throws if the rule listing fails or `shutdown` aborts. */
async function sync(cfg: Config, dir: string, warnings: Set<string>, shutdown: AbortSignal): Promise<Map<string, Buffer>> {
	// Each request gets its own timeout; the shared shutdown signal cancels all of them.
	const request = (url: string, headers?: Record<string, string>) =>
		fetch(url, { headers, signal: AbortSignal.any([shutdown, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) });

	const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
	const res = await request(`https://api.github.com/repos/${REPO}/contents/rules?ref=${cfg.ref}`, {
		Accept: "application/vnd.github+json",
		"User-Agent": "pi-waza-rules",
		...(token ? { Authorization: `Bearer ${token}` } : {}),
	});
	if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
	const list = (await res.json()) as Array<{ name: string; sha: string; type: string }>;
	const remote = new Map(list.filter((e) => e.type === "file").map((e) => [e.name, e.sha]));

	const fresh = new Map<string, Buffer>();
	const notFound: string[] = [];
	let complete = true;
	for (const name of cfg.rules) {
		shutdown.throwIfAborted();
		const sha = remote.get(`${name}.md`);
		if (!sha) {
			warnings.add(`rule "${name}" not found in ${REPO}@${cfg.ref}`);
			notFound.push(name);
			continue;
		}
		const file = join(dir, `${name}.md`);
		try {
			const local = readBuf(file);
			if (local && blobSha(local) === sha) {
				fresh.set(name, local);
				continue;
			}
			const raw = await request(`https://raw.githubusercontent.com/${REPO}/${cfg.ref}/rules/${name}.md`);
			if (!raw.ok) throw new Error(`download returned ${raw.status}`);
			const buf = Buffer.from(await raw.arrayBuffer());
			// raw.githubusercontent.com is CDN-cached and can lag the API right after a push.
			if (blobSha(buf) !== sha) throw new Error("downloaded content does not match GitHub sha");
			fresh.set(name, buf);
			if (!save(file, buf, warnings)) complete = false;
		} catch (err) {
			shutdown.throwIfAborted();
			complete = false;
			warnings.add(`failed to update "${name}" (${errMsg(err)}); using local copy if any`);
		}
	}
	if (complete) save(join(dir, MARKER), Buffer.from(JSON.stringify({ notFound })), warnings);
	return fresh;
}

function save(file: string, buf: Buffer, warnings: Set<string>): boolean {
	// Per-process temp name so concurrent sessions never share a temp file.
	const tmp = `${file}.${process.pid}.tmp`;
	try {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(tmp, buf);
		renameSync(tmp, file);
		return true;
	} catch (err) {
		rmSync(tmp, { force: true });
		warnings.add(`cannot write cache in ${dirname(file)} (${errMsg(err)}); using downloaded copy for this session`);
		return false;
	}
}

async function load(shutdown: AbortSignal): Promise<Loaded> {
	const warnings = new Set<string>();
	const cfg = readConfig(warnings);
	const dir = join(stateDir(), ".cache", cfg.ref);

	let fresh = new Map<string, Buffer>();
	if (cfg.rules.length > 0 && needsCheck(cfg, dir)) {
		try {
			fresh = await sync(cfg, dir, warnings, shutdown);
		} catch (err) {
			warnings.add(`update check failed (${errMsg(err)}); using local copies`);
		}
	}

	const parts: string[] = [];
	const files: string[] = [];
	const missing: string[] = [];
	for (const name of cfg.rules) {
		const text = (fresh.get(name) ?? readBuf(join(dir, `${name}.md`)))?.toString("utf-8").trim();
		if (text) {
			parts.push(text);
			files.push(name);
		} else {
			missing.push(name);
		}
	}
	return { text: parts.join("\n\n"), files, missing, warnings: [...warnings] };
}

export default function wazaRules(pi: ExtensionAPI) {
	let controller = new AbortController();
	let pending: Promise<Loaded> | null = null;

	pi.on("session_start", async (_event, ctx) => {
		controller.abort(); // a replaced session must not leave requests running
		controller = new AbortController();
		const { signal } = controller;
		const current = (pending = load(signal));
		const loaded = await current;
		if (signal.aborted) return; // shut down while loading; ctx is no longer valid
		const problems = [...loaded.warnings];
		if (loaded.missing.length > 0) problems.push(`missing: ${loaded.missing.join(", ")}`);

		if (loaded.files.length === 0 && problems.length === 0) {
			ctx.ui.notify("Waza rules disabled (empty rules list)", "info");
		} else if (loaded.files.length === 0) {
			ctx.ui.notify(`Waza rules not loaded: ${problems.join("; ")}`, "warning");
		} else if (problems.length > 0) {
			ctx.ui.notify(`Waza rules active (${loaded.files.join(", ")}); ${problems.join("; ")}`, "warning");
		} else {
			ctx.ui.notify(`Waza rules active (${loaded.files.join(", ")})`, "info");
		}
	});

	pi.on("session_shutdown", () => {
		controller.abort();
		pending = null;
	});

	pi.on("before_agent_start", async (event) => {
		// Await the session_start download in case Pi does not wait for it.
		const loaded = await (pending ??= load(controller.signal));
		const sections = event.systemPromptOptions.sections;
		if (loaded.text) {
			sections[SECTION] = loaded.text;
		} else {
			delete sections[SECTION];
		}
	});
}
