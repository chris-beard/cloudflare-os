// DOWNSTREAM (fabric): the patch ledger gate.
//
// The health metric for this fork is not the merge-conflict count -- a trial merge across a
// 105-commit gap produced two textual conflicts while the kernel rewrote 77-83% of its lines, so
// conflicts are a lying green light. The metric is: every file that differs from upstream is either
// a new file upstream will never create, or is claimed by a recorded patch.
//
// A patch is recorded twice, on purpose, and the two must agree:
//   - a commit on `distro` carrying `PATCH-ID:` and `FILES:` trailers (what actually shipped), and
//   - a `## \`<id>\` — LANDED` section in PATCHES.md (why no seam reaches it, when to re-review).
// A static allowlist cannot tell a recorded patch from an unrecorded one; this can.
//
//   node scripts/fabric-patch-ledger.ts [base-ref]     (default base: upstream-main)

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Upstream refuses contributions, so every patch is permanent. Three is the hard ceiling. */
export const MAX_PATCHES = 3;

/**
 * Files no patch may touch. Past this line the fork is an unfunded rewrite of the kernel, not a
 * distro: these are the highest-churn files in the repo (overseer.ts alone takes ~232 diff hunks a
 * month) or the public API every gatekeeper compiles against.
 */
export const FORBIDDEN = [
  /^packages\/workshop-backend\/src\/overseer\.ts$/,
  /^packages\/workshop-backend\/src\/agent\.ts$/,
  /^packages\/workshop-backend\/src\/server\.ts$/,
  /^packages\/workshop-backend\/src\/ai-models\.ts$/,
  /^packages\/workshop-shared\/src\/api\.ts$/,
  /^packages\/workshop-frontend\//,
];

/** Paths upstream will never create. They must be ADDED here, never modified. */
export const NEW_FILE_ONLY = [
  /^packages\/[^/]+\/__tests__\/fabric-[^/]+$/,
  /^packages\/workshop-backend\/src\/fabric\//,
  /^scripts\/fabric-[^/]+$/,
  /^\.github\/workflows\/fabric-ci\.yml$/,
  /^(PATCHES|DOWNSTREAM-REVIEW)\.md$/,
];

export interface Diverged { status: string; path: string }
export interface Trailer { commit: string; id: string; files: string[] }
export interface LedgerEntry { id: string; landed: boolean }
export interface Report { errors: string[]; warnings: string[] }

/** Read the `## \`id\` — LANDED` / `— NOT YET LANDED` headings out of PATCHES.md. */
export function parseLedger(markdown: string): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  for (const match of markdown.matchAll(/^##\s+`([^`]+)`\s*[—–-]+\s*(NOT YET LANDED|LANDED)\b/gm)) {
    entries.push({ id: match[1]!, landed: match[2] === "LANDED" });
  }
  return entries;
}

export function checkLedger(input: {
  diverged: Diverged[]; trailers: Trailer[]; ledger: LedgerEntry[];
}): Report {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { diverged, trailers, ledger } = input;

  if (ledger.length > MAX_PATCHES) {
    errors.push(
      `PATCHES.md records ${ledger.length} patches (landed or planned); the ceiling is ` +
      `${MAX_PATCHES}. A fourth means re-scoping, not raising the number.`);
  }

  const landed = new Set(ledger.filter((entry) => entry.landed).map((entry) => entry.id));
  const planned = new Set(ledger.filter((entry) => !entry.landed).map((entry) => entry.id));
  const shipped = new Set(trailers.map((trailer) => trailer.id));

  for (const id of shipped) {
    if (planned.has(id)) {
      errors.push(`${id} is shipped (has a PATCH-ID commit) but PATCHES.md still says NOT YET LANDED.`);
    } else if (!landed.has(id)) {
      errors.push(`${id} is shipped but has no "LANDED" section in PATCHES.md explaining why.`);
    }
  }
  for (const id of landed) {
    if (!shipped.has(id)) {
      errors.push(`PATCHES.md marks ${id} LANDED but no commit carries "PATCH-ID: ${id}".`);
    }
  }

  const claimed = new Map<string, string>();
  for (const trailer of trailers) {
    if (trailer.files.length === 0) {
      errors.push(`${trailer.id} (${trailer.commit}) has no FILES trailer, so nothing it changes is claimed.`);
    }
    for (const file of trailer.files) {
      if (FORBIDDEN.some((pattern) => pattern.test(file))) {
        errors.push(
          `${trailer.id} patches ${file}, which is on the forbidden list. That is the documented ` +
          `signal to stop and re-scope.`);
      }
      claimed.set(file, trailer.id);
    }
  }

  const divergedPaths = new Set(diverged.map((entry) => entry.path));
  for (const { status, path } of diverged) {
    if (NEW_FILE_ONLY.some((pattern) => pattern.test(path))) {
      if (!status.startsWith("A")) {
        errors.push(
          `${path} is a downstream-only path but upstream has it too (status ${status}), so it can ` +
          `now conflict. Rename it.`);
      }
      continue;
    }
    if (!claimed.has(path)) {
      errors.push(
        `${path} differs from upstream but no PATCH-ID commit claims it. Record it as a patch, move ` +
        `it behind a seam, or revert it.`);
    }
  }

  for (const [file, id] of claimed) {
    if (!divergedPaths.has(file)) {
      warnings.push(
        `${id} claims ${file}, which no longer differs from upstream. Upstream may have absorbed ` +
        `the change -- consider retiring the patch.`);
    }
  }

  return { errors, warnings };
}

function git(args: string[]): string {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

export function readRepo(base: string, root: string): Parameters<typeof checkLedger>[0] {
  const diverged = git(["diff", "--name-status", "--no-renames", `${base}...HEAD`])
    .split("\n").filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split("\t");
      return { status: status!, path: rest.join("\t") };
    });

  const trailers = git([
    "log", "--format=%h%x1f%(trailers:key=PATCH-ID,valueonly,separator=%x20)" +
      "%x1f%(trailers:key=FILES,valueonly,separator=%x20)%x1e",
    `${base}..HEAD`,
  ])
    .split("\x1e").map((record) => record.trim()).filter(Boolean)
    .map((record) => record.split("\x1f"))
    .filter(([, id]) => id && id.trim())
    .map(([commit, id, files]) => ({
      commit: commit!, id: id!.trim(), files: (files ?? "").split(/\s+/).filter(Boolean),
    }));

  const ledger = parseLedger(readFileSync(join(root, "PATCHES.md"), "utf8"));
  return { diverged, trailers, ledger };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const base = process.argv[2] ?? "upstream-main";
  const root = git(["rev-parse", "--show-toplevel"]).trim();
  const input = readRepo(base, root);
  const { errors, warnings } = checkLedger(input);

  const landed = input.ledger.filter((entry) => entry.landed).length;
  console.log(
    `Patch ledger vs ${base}: ${input.diverged.length} diverged file(s), ` +
    `${landed} landed / ${input.ledger.length} recorded (ceiling ${MAX_PATCHES}).`);
  for (const warning of warnings) console.log(`::warning::${warning}`);
  for (const error of errors) console.log(`::error::${error}`);
  if (errors.length) process.exit(1);
  console.log("Every divergence is a downstream-only file or a recorded patch.");
}
