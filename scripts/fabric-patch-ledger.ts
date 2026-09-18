// DOWNSTREAM (fabric): the patch ledger gate.
//
// The health metric for this fork is not the merge-conflict count -- a trial merge across a
// 105-commit gap produced two textual conflicts while the kernel rewrote 77-83% of its lines, so
// conflicts are a lying green light. The metric is: every file that differs from upstream is either
// a new file upstream will never create, or is claimed by a recorded patch.
//
// A patch is recorded twice, on purpose, and the two must agree:
//   - commits on `distro` carrying `PATCH-ID:` and `FILES:` trailers (what actually shipped), and
//   - a `## \`<id>\` — LANDED <date>` entry in PATCHES.md whose **Files:** line lists the same files
//     (why no seam reaches it, when to re-review).
// A static allowlist cannot tell a recorded patch from an unrecorded one; this can.
//
// Neither record is taken on trust. A FILES trailer is checked against the diff of the commit that
// carries it, and PATCHES.md is read the way a reviewer sees it: text a renderer hides (comments,
// code fences) counts for nothing, and anything this parser cannot read with certainty -- an odd
// heading, an odd line break, raw HTML -- fails the gate rather than being skipped.
//
//   node scripts/fabric-patch-ledger.ts [base-ref]     (default base: upstream-main)

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Upstream refuses contributions, so every patch is permanent. PATCHES.md sets the budget -- ten since
 * Chris raised it on 2026-09-17 -- and explains why the count is the cheap half of the rule. This
 * number must match it.
 */
export const MAX_PATCHES = 10;

/**
 * Files a patch may touch only on purpose. These are the highest-churn files in the repo (overseer.ts
 * alone takes ~232 diff hunks a month) or the public API every gatekeeper compiles against, so a patch
 * here is re-read on every merge. The patch's own PATCHES.md entry must name each one on its
 * `**High-churn:**` line: an acknowledgement a reviewer sees, never a side effect of a FILES trailer.
 */
export const HIGH_CHURN = [
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

/**
 * PATCHES.md's first line, and the only heading allowed that is not an entry. Pinned exactly because
 * the preamble is otherwise the one place a malformed entry heading could sit uncounted.
 */
export const LEDGER_TITLE = "# Downstream patches";

/** A path that differs between the merge base and HEAD, with git's name-status letter. */
export interface Diverged { status: string; path: string }
/** A commit in base..HEAD: its PATCH-ID and FILES trailers, and the paths its own diff changes. */
export interface Commit { commit: string; merge: boolean; id: string | null; files: string[]; changed: string[] }
/** One `## \`id\` — …` entry in PATCHES.md. `files` is null when the entry has no **Files:** line. */
export interface LedgerEntry { id: string; landed: boolean; files: string[] | null; highChurn: string[] }
/** Every entry PATCHES.md records, plus anything in it the gate could not read with certainty. */
export interface Ledger { entries: LedgerEntry[]; errors: string[] }
/** What checkLedger needs; readRepo builds it from git and the working tree. */
export interface LedgerInput { diverged: Diverged[]; commits: Commit[]; ledger: Ledger }
/** Errors fail the gate; warnings are printed and do not. */
export interface Report { errors: string[]; warnings: string[] }

const isHighChurn = (path: string) => HIGH_CHURN.some((pattern) => pattern.test(path));
const isDownstreamOnly = (path: string) => NEW_FILE_ONLY.some((pattern) => pattern.test(path));

// The one heading shape an entry may take: literal single spaces, an em dash, a dated LANDED or an
// exact NOT YET LANDED, nothing after. Anything looser is how an eleventh patch went uncounted.
const ENTRY_HEADING = /^## `([a-z0-9][a-z0-9._-]*)` — (LANDED \d{4}-\d{2}-\d{2}|NOT YET LANDED)$/;

// Anything a Markdown renderer could show as an ATX heading: any level, any indent, inside a quote
// or list item, or after a Unicode space (JavaScript's \s includes NBSP). Deliberately broader than
// CommonMark, so no heading slips past ENTRY_HEADING by being written slightly differently.
const LOOKS_LIKE_HEADING = /^(?:\s|>|[-*+]\s|\d{1,9}[.)]\s)*#{1,6}(?:\s|$)/;
// A line of = or - directly under paragraph text turns that text into a (setext) heading.
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/;
// `---` and friends. A section ends here: text after a break is not visibly part of the entry above.
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

// The two fields the gate reads, only in this exact form at the start of a line.
const FIELD = /^\*\*(Files|High-churn):\*\*(?: (.*))?$/;
// Anything a reader might take for one of them. Seen but not in exact form, it is an error rather than
// silently ignored, so an entry never shows a reviewer a field the gate did not read.
const LOOKS_LIKE_FIELD = /^(?:\s|>|[-*+]\s|\d{1,9}[.)]\s)*(?:\*\*|__)\s*(?:files|high[\s-]*churn)\b/i;
const PATH_LIST = "`[^`\\s]+`(?:, `[^`\\s]+`)*";
const FILES_VALUE = new RegExp(`^(${PATH_LIST})$`);
// Paths first, then optional prose after " — ". The prose may not hold backticks, so a path in it --
// "none (an early draft touched `overseer.ts`)" -- can never be read, or misread, as acknowledged.
const HIGH_CHURN_VALUE = new RegExp(`^(${PATH_LIST})(?: — [^\`]+)?$`);

/** Render a line for an error message with invisible or look-alike characters spelled out. */
function show(line: string): string {
  const visible = line.replace(/[^\x20-\x7e\u2013\u2014\u2192]/gu, (char) =>
    `<U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}>`);
  return `"${visible}"`;
}

/**
 * Blank out every line a renderer hides -- whole-line HTML comments and fenced code blocks -- keeping
 * line numbers. An acknowledgement or LANDED heading in there is invisible to a reviewer (or shown only
 * as code), so it must count for nothing. Where this scan and a Markdown renderer could disagree about
 * where hidden text ends, it reports an error instead of guessing.
 */
function hideInvisible(lines: string[], errors: string[]): string[] {
  const visible: string[] = [];
  let fence: { marker: string; line: number } | null = null;
  let commentFrom: number | null = null;

  for (const [index, line] of lines.entries()) {
    const n = index + 1;
    if (fence) {
      visible.push("");
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1]![0] === fence.marker[0] && close[1]!.length >= fence.marker.length) fence = null;
      continue;
    }
    if (commentFrom !== null || line.startsWith("<!--")) {
      visible.push("");
      commentFrom ??= n;
      // A browser ends a comment at the first --> (so `<!-->` is already closed), and at --!> too;
      // Markdown ends the block at the line holding -->. Refuse text where the two would disagree.
      const end = line.indexOf("-->");
      if (line.slice(0, end < 0 ? undefined : end).includes("--!>")) {
        errors.push(`PATCHES.md line ${n}: "--!>" ends an HTML comment early in a browser. Remove it.`);
      }
      if (end >= 0) {
        if (line.slice(end + 3).trim() !== "") {
          errors.push(
            `PATCHES.md line ${n}: text after "-->" is rendered, not hidden. End a comment at the end of ` +
            `its line.`);
        }
        commentFrom = null;
      }
      continue;
    }
    const open = /^(?:(`{3,})[^`]*|(~{3,}).*)$/.exec(line);
    if (open) {
      fence = { marker: open[1] ?? open[2]!, line: n };
      visible.push("");
      continue;
    }
    // Indented, a fence can belong to a list item and close where this scan would not see it.
    if (/^ {1,3}(?:`{3,}|~{3,})/.test(line)) {
      errors.push(`PATCHES.md line ${n}: start a code fence at column 0 so where it ends is unambiguous.`);
    }
    visible.push(line);
  }

  if (fence) errors.push(`PATCHES.md line ${fence.line}: code fence is never closed.`);
  if (commentFrom !== null) errors.push(`PATCHES.md line ${commentFrom}: HTML comment is never closed.`);
  return visible;
}

/**
 * Read PATCHES.md's entries -- id, LANDED or not, the **Files:** list and the **High-churn:** list --
 * failing closed on anything whose reading is uncertain. The file is: the title line, a preamble, then
 * entries. An entry's section runs to the next heading or thematic break, and holds at most one of
 * each field. Every heading after the title must be an exact entry heading.
 */
export function parseLedger(markdown: string): Ledger {
  const errors: string[] = [];
  const entries: LedgerEntry[] = [];

  // Line breaks are ours to decide: \n or \r\n only. U+2028/U+2029 and friends split a line for
  // JavaScript's multiline ^ (and some renderers) but not for CommonMark, and a lone \r splits it for
  // CommonMark but not for us. Either way a heading could exist for one reader and not the other.
  markdown.split("\n").forEach((line, index) => {
    const odd = /[\r\v\f\u0085\u2028\u2029]/.exec(line.replace(/\r$/, ""));
    if (odd) {
      errors.push(
        `PATCHES.md line ${index + 1} contains ${show(odd[0])}, an unusual line or paragraph separator. ` +
        `Use a plain newline.`);
    }
  });

  const lines = hideInvisible(markdown.split(/\r?\n/), errors);
  if (lines[0] !== LEDGER_TITLE) {
    errors.push(`PATCHES.md must start with the line "${LEDGER_TITLE}"; found ${show(lines[0] ?? "")}.`);
  }

  let entry: LedgerEntry | null = null; // null in the preamble and after a thematic break
  let given = new Set<string>(); // fields this entry has already had
  let field: { name: string; entry: LedgerEntry; text: string; line: number } | null = null;

  const endField = () => {
    if (!field) return;
    const { name, entry: owner, text, line } = field;
    field = null;
    const match = (name === "Files" ? FILES_VALUE : HIGH_CHURN_VALUE).exec(text.trim());
    if (!match) {
      errors.push(
        name === "Files"
          ? `${owner.id}'s **Files:** line (PATCHES.md line ${line}) must be only backticked paths ` +
            `separated by ", ".`
          : `${owner.id}'s **High-churn:** line (PATCHES.md line ${line}) must start with the backticked ` +
            `paths separated by ", ", optionally followed by " — " and prose with no backticks. As ` +
            `written it acknowledges nothing.`);
      return;
    }
    const paths = [...match[1]!.matchAll(/`([^`]+)`/g)].map((path) => path[1]!);
    if (name === "Files") owner.files = paths;
    else owner.highChurn = paths;
  };

  const isParagraphText = (line: string) =>
    line.trim() !== "" && !LOOKS_LIKE_HEADING.test(line) && !THEMATIC_BREAK.test(line);

  for (const [index, line] of lines.entries()) {
    const n = index + 1;
    const previous = index > 0 ? lines[index - 1]! : "";
    if (index === 0 && line === LEDGER_TITLE) continue;

    // A <details>, a hidden element or an unclosed tag can fold away the text after it, and telling a
    // tag from a code span needs a full Markdown parser. PATCHES.md has no use for raw HTML.
    if (/<[A-Za-z/!?]/.test(line)) {
      errors.push(
        `PATCHES.md line ${n}: raw HTML (or a <link>) is not allowed outside a whole-line comment, ` +
        `because it can hide what follows it.`);
    }

    if (line.trim() === "") {
      endField();
      continue;
    }

    const setext = SETEXT_UNDERLINE.test(line) && isParagraphText(previous);
    if (LOOKS_LIKE_HEADING.test(line) || setext) {
      endField();
      const match = setext ? null : ENTRY_HEADING.exec(line);
      if (!match) {
        errors.push(
          `unrecognised ledger heading on PATCHES.md line ${setext ? n - 1 : n}: ` +
          `${setext ? `${show(previous)} underlined by ${show(line)}` : show(line)}. After the title, ` +
          `every heading must be exactly "## \`<id>\` — LANDED YYYY-MM-DD" or "## \`<id>\` — NOT YET LANDED".`);
        entry = null;
        continue;
      }
      const id = match[1]!;
      if (entries.some((existing) => existing.id === id)) {
        errors.push(`${id} has more than one entry in PATCHES.md (again on line ${n}). One patch, one entry.`);
      }
      entry = { id, landed: match[2]!.startsWith("LANDED"), files: null, highChurn: [] };
      entries.push(entry);
      given = new Set();
      continue;
    }

    if (THEMATIC_BREAK.test(line)) {
      endField();
      entry = null;
      continue;
    }

    if (LOOKS_LIKE_FIELD.test(line)) {
      endField();
      const match = FIELD.exec(line);
      if (!match) {
        errors.push(
          `PATCHES.md line ${n}: ${show(line)} looks like a **Files:** or **High-churn:** line but is not ` +
          `exactly one, at the start of the line, so the gate cannot read it.`);
      } else if (!entry) {
        errors.push(
          `PATCHES.md line ${n}: this **${match[1]}:** line is outside any patch entry, so it names ` +
          `nothing. Put it in the entry it belongs to.`);
      } else if (previous.trim() !== "" && !ENTRY_HEADING.test(previous)) {
        // Glued to the line above, it renders inside that paragraph rather than as a field of its own.
        errors.push(`PATCHES.md line ${n}: a **${match[1]}:** line must start its own paragraph.`);
      } else if (given.has(match[1]!)) {
        errors.push(`${entry.id} has a second **${match[1]}:** line (PATCHES.md line ${n}). An entry gets one.`);
      } else {
        given.add(match[1]!);
        field = { name: match[1]!, entry, text: match[2] ?? "", line: n };
      }
      continue;
    }

    // A field's paragraph continues until a blank line (the Files list wraps across lines).
    if (field) field.text += ` ${line.trim()}`;
  }
  endField();

  for (const { id, files, highChurn } of entries) {
    for (const path of highChurn) {
      if (!isHighChurn(path)) {
        errors.push(`${id} names ${path} on its **High-churn:** line, but that is not a high-churn file.`);
      }
      if (!files?.includes(path)) {
        errors.push(`${id} names ${path} on its **High-churn:** line but not on its **Files:** line.`);
      }
    }
  }

  return { entries, errors };
}

/** Hold the commits, the divergence and PATCHES.md to each other. Pure, so the tests need no git. */
export function checkLedger(input: LedgerInput): Report {
  const errors: string[] = [...input.ledger.errors];
  const warnings: string[] = [];
  const { diverged, commits } = input;
  const { entries } = input.ledger;

  // Every entry counts, landed or planned, duplicate or not: the budget is spent when it is written down.
  if (entries.length > MAX_PATCHES) {
    errors.push(
      `PATCHES.md records ${entries.length} patches (landed or planned); the ceiling is ` +
      `${MAX_PATCHES} (PATCHES.md). Re-scope, or retire a patch, before recording another.`);
  }

  // A duplicate id is already an error; the first entry is the one a reader finds, so it is the one used.
  const entryById = new Map<string, LedgerEntry>();
  for (const entry of entries) if (!entryById.has(entry.id)) entryById.set(entry.id, entry);

  const patches = commits.filter((commit) => commit.id !== null);
  const landed = new Set(entries.filter((entry) => entry.landed).map((entry) => entry.id));
  const planned = new Set(entries.filter((entry) => !entry.landed).map((entry) => entry.id));
  const shipped = new Set(patches.map((patch) => patch.id!));

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

  // The entry's **Files:** list and the trailers must name the same files, both ways. Otherwise an
  // unrelated change can ship under an existing PATCH-ID without its entry visibly changing.
  for (const entry of entryById.values()) {
    if (!entry.landed) continue;
    if (entry.files === null) {
      errors.push(`${entry.id} is LANDED but its PATCHES.md entry has no readable **Files:** line.`);
      continue;
    }
    const trailed = new Set(patches.filter((patch) => patch.id === entry.id).flatMap((patch) => patch.files));
    if (trailed.size === 0) continue; // no commit at all: reported above
    for (const file of trailed) {
      if (!entry.files.includes(file)) {
        errors.push(
          `${entry.id}'s FILES trailers claim ${file}, but its PATCHES.md **Files:** line does not list ` +
          `it. A new change needs its own entry, or this one must say so.`);
      }
    }
    for (const file of entry.files) {
      if (!trailed.has(file)) {
        errors.push(
          `${entry.id}'s PATCHES.md **Files:** line lists ${file}, but no "PATCH-ID: ${entry.id}" commit ` +
          `claims it.`);
      }
    }
  }

  const claimed = new Map<string, string>();
  for (const patch of patches) {
    if (patch.merge) {
      // A merge's own diff is not read (see readRepo), so a trailer there would claim what nothing checks.
      errors.push(
        `${patch.id} (${patch.commit}) carries PATCH-ID on a merge commit. Put it on the commit that ` +
        `makes the change.`);
    }
    if (patch.files.length === 0) {
      errors.push(`${patch.id} (${patch.commit}) has no FILES trailer, so nothing it changes is claimed.`);
    }
    // A trailer is a claim to check, not a fact: every kernel file the commit changes must be on it.
    for (const path of patch.changed) {
      if (!isDownstreamOnly(path) && !patch.files.includes(path)) {
        errors.push(
          `${patch.id} (${patch.commit}) changes ${path}, but its FILES trailer does not list it. List ` +
          `it (and on the patch's PATCHES.md entry), or move the change into a patch of its own.`);
      }
    }
    for (const file of patch.files) {
      if (isHighChurn(file) && !entryById.get(patch.id!)?.highChurn.includes(file)) {
        errors.push(
          `${patch.id} patches ${file}, a high-churn kernel file, but its own PATCHES.md entry does not ` +
          `list it on a **High-churn:** line. Say why no seam reaches it there, or re-scope.`);
      }
      claimed.set(file, patch.id!);
    }
  }

  const divergedPaths = new Set(diverged.map((entry) => entry.path));
  // A file one patch claims is not free for any other commit to edit: whoever touches a diverged
  // kernel file must carry a PATCH-ID of their own, which the checks above then hold to its entry.
  for (const commit of commits) {
    if (commit.merge || commit.id !== null) continue;
    for (const path of commit.changed) {
      if (divergedPaths.has(path) && !isDownstreamOnly(path)) {
        errors.push(
          `${commit.commit} changes ${path}, which differs from upstream, but carries no PATCH-ID. ` +
          `Every commit that edits a patched file is part of a recorded patch.`);
      }
    }
  }

  for (const { status, path } of diverged) {
    if (isDownstreamOnly(path)) {
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

/** Gather checkLedger's input from git (base..HEAD) and the working tree's PATCHES.md. */
export function readRepo(base: string, root: string): LedgerInput {
  const diverged = git(["diff", "--name-status", "--no-renames", `${base}...HEAD`])
    .split("\n").filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split("\t");
      return { status: status!, path: rest.join("\t") };
    });

  const commits = git([
    "log", "--format=%H%x1f%h%x1f%P%x1f%(trailers:key=PATCH-ID,valueonly,separator=%x20)" +
      "%x1f%(trailers:key=FILES,valueonly,separator=%x20)%x1e",
    `${base}..HEAD`,
  ])
    .split("\x1e").map((record) => record.trim()).filter(Boolean)
    .map((record) => {
      const [sha, commit, parents, id, files] = record.split("\x1f");
      const merge = (parents ?? "").trim().split(/\s+/).length > 1;
      // What the commit really changes, against its only parent. A merge is left out: resolving an
      // upstream merge legitimately rewrites patched files, and its result is still held to the rule
      // that every diverged file is claimed.
      const changed = merge
        ? []
        : git(["diff-tree", "--no-commit-id", "--name-only", "-r", "--no-renames", "--root", sha!])
          .split("\n").filter(Boolean);
      return {
        commit: commit!, merge, id: id?.trim() || null,
        files: (files ?? "").split(/\s+/).filter(Boolean), changed,
      };
    });

  const ledger = parseLedger(readFileSync(join(root, "PATCHES.md"), "utf8"));
  return { diverged, commits, ledger };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const base = process.argv[2] ?? "upstream-main";
  const root = git(["rev-parse", "--show-toplevel"]).trim();
  const input = readRepo(base, root);
  const { errors, warnings } = checkLedger(input);

  const landed = input.ledger.entries.filter((entry) => entry.landed).length;
  console.log(
    `Patch ledger vs ${base}: ${input.diverged.length} diverged file(s), ` +
    `${landed} landed / ${input.ledger.entries.length} recorded (ceiling ${MAX_PATCHES}).`);
  for (const warning of warnings) console.log(`::warning::${warning}`);
  for (const error of errors) console.log(`::error::${error}`);
  if (errors.length) process.exit(1);
  console.log("Every divergence is a downstream-only file or a recorded patch.");
}
