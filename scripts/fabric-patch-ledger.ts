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
// Neither record is taken on trust. A FILES trailer must name exactly what its commit changes; a merge
// may carry only what git merges on its own; and PATCHES.md is read the way a reviewer sees it: text a
// renderer hides (comments, code fences) counts for nothing, and anything this parser cannot read with
// certainty -- an odd heading, an odd character, raw HTML -- fails the gate rather than being skipped.
//
//   node scripts/fabric-patch-ledger.ts [base-ref]     (default base: upstream-main)

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Upstream refuses contributions, so every patch is permanent. PATCHES.md sets the budget -- ten since
 * Chris raised it on 2026-09-17 -- and explains why the count is the cheap half of the rule. This
 * number must match it. A RETIRED entry no longer counts.
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
/**
 * A commit in base..HEAD: how many parents it has, its PATCH-ID and FILES trailers, and the paths it
 * itself changes -- for a merge, only what differs from the merge git would have made on its own.
 */
export interface Commit { commit: string; parents: number; id: string | null; files: string[]; changed: string[] }
/** Shipped, planned, or shipped and since undone (kept as the record, no longer counted). */
export type Status = "LANDED" | "NOT YET LANDED" | "RETIRED";
/** One `## \`id\` — …` entry in PATCHES.md. `files` is null when the entry has no **Files:** line. */
export interface LedgerEntry { id: string; status: Status; files: string[] | null; highChurn: string[] }
/** Every entry PATCHES.md records, plus anything in it the gate could not read with certainty. */
export interface Ledger { entries: LedgerEntry[]; errors: string[] }
/** What checkLedger needs; readRepo builds it from git and the working tree. */
export interface LedgerInput { diverged: Diverged[]; commits: Commit[]; ledger: Ledger }
/** Errors fail the gate; warnings are printed and do not. */
export interface Report { errors: string[]; warnings: string[] }

const isHighChurn = (path: string) => HIGH_CHURN.some((pattern) => pattern.test(path));
const isDownstreamOnly = (path: string) => NEW_FILE_ONLY.some((pattern) => pattern.test(path));

/**
 * The only characters PATCHES.md may hold: tab, printable ASCII, and the en dash, em dash and arrow it
 * already uses. Anything else is somewhere a renderer, an editor and this parser can disagree. A no-break
 * or other Unicode space is blank to JavaScript's trim() but text to CommonMark, so the line above it can
 * become a heading; a zero-width or direction mark in front of "##" hides a heading from this parser
 * while the source looks exactly like one; U+2028 is a line break to a JavaScript regex and not to
 * Markdown. Widen this only with characters that are visible and are not spaces or line breaks.
 */
const NOT_PLAIN = /[^\t\x20-\x7e\u2013\u2014\u2192]/u;

// Blank as CommonMark means it: nothing but spaces and tabs. Never trim(), which also strips Unicode
// spaces that CommonMark treats as text.
const isBlank = (line: string) => /^[ \t]*$/.test(line);

// The one heading shape an entry may take: literal single spaces, an em dash, then LANDED or RETIRED
// with a date, or exactly NOT YET LANDED, and nothing after. Anything looser is how an eleventh patch
// went uncounted.
const ENTRY_HEADING = /^## `([a-z0-9][a-z0-9._-]*)` — (?:(LANDED|RETIRED) \d{4}-\d{2}-\d{2}|NOT YET LANDED)$/;

/**
 * Match an entry heading, first dropping what a renderer drops from the end of one: trailing spaces or
 * tabs, and a closing run of #. Refusing those only produced knock-on errors for an identical heading.
 */
function entryHeading(line: string): { id: string; status: Status } | null {
  const match = ENTRY_HEADING.exec(line.replace(/(?:[ \t]+#+)?[ \t]*$/, ""));
  return match ? { id: match[1]!, status: (match[2] ?? "NOT YET LANDED") as Status } : null;
}

// Anything a Markdown renderer could show as an ATX heading: any level, any indent, inside a quote
// or list item. Deliberately broader than CommonMark, so no heading slips past ENTRY_HEADING by being
// written slightly differently.
const LOOKS_LIKE_HEADING = /^(?:\s|>|[-*+]\s|\d{1,9}[.)]\s)*#{1,6}(?:\s|$)/;
// A run of = or - directly under paragraph text turns that text into a (setext) heading -- inside a
// quote (`> ---`) or a list item (indented to any depth) too, so any such prefix is allowed.
const SETEXT_UNDERLINE = /^[ \t>]*(?:=+|-+)[ \t]*$/;
// `---` and friends, in CommonMark's exact form (at most three spaces in, no prefix). A line this
// matches is never taken for paragraph text, so it must not match more: `    ***` continues a
// paragraph, and an underline below it makes a heading the setext check would then not see.
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
// Where a section ends: a rule at any depth, inside a quote or list item too, because a reader sees
// the text after any rule as apart from the entry above. Ending a section too eagerly only turns a
// later field into an error, never a pass, so this one may match more than a renderer would.
const SECTION_BREAK = /^(?:[ \t>]|[-*+][ \t]|\d{1,9}[.)][ \t])*([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

// The two fields the gate reads, only in this exact form at the start of a line.
const FIELD = /^\*\*(Files|High-churn):\*\*(?:[ \t]+(.*))?$/;
// Anything a reader might take for one of them. Seen but not in exact form, it is an error rather than
// silently ignored, so an entry never shows a reviewer a field the gate did not read.
const LOOKS_LIKE_FIELD = /^(?:\s|>|[-*+]\s|\d{1,9}[.)]\s)*(?:\*\*|__)\s*(?:files|high[\s-]*churn)\b/i;
const PATH_LIST = "`[^`\\s]+`(?:, `[^`\\s]+`)*";
const FILES_VALUE = new RegExp(`^(${PATH_LIST})$`);
// Paths first, then optional prose after " — ". The prose may not hold backticks, so a path in it --
// "none (an early draft touched `overseer.ts`)" -- can never be read, or misread, as acknowledged.
const HIGH_CHURN_VALUE = new RegExp(`^(${PATH_LIST})(?: — [^\`]+)?$`);

// A URI autolink (<https://...>) is a link, never HTML: no tag name can hold the colon after its scheme.
const AUTOLINK = /<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\p{Cc} ]*>/gu;

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
        if (!isBlank(line.slice(end + 3))) {
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
 * Read PATCHES.md's entries -- id, status, the **Files:** list and the **High-churn:** list -- failing
 * closed on anything whose reading is uncertain. The file is: the title line, a preamble, then entries.
 * An entry's section runs to the next heading or thematic break, and holds at most one of each field.
 * Every heading after the title must be an exact entry heading.
 */
export function parseLedger(markdown: string): Ledger {
  const errors: string[] = [];
  const entries: LedgerEntry[] = [];

  // A leading byte-order mark belongs to the editor, and every renderer drops it; so does the gate.
  const raw = markdown.replace(/^\uFEFF/, "").split(/\r?\n/);

  // Line breaks are ours to decide (\n or \r\n only), and so is every other character: see NOT_PLAIN.
  raw.forEach((line, index) => {
    const odd = NOT_PLAIN.exec(line);
    if (odd) {
      errors.push(
        `PATCHES.md line ${index + 1} contains ${show(odd[0])}. PATCHES.md may hold only printable ` +
        `ASCII, tabs and – — →: anything else can be invisible, pass for a space or a line break, or ` +
        `make a heading for one reader and not another.`);
    }
  });

  const lines = hideInvisible(raw, errors);
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
    !isBlank(line) && !LOOKS_LIKE_HEADING.test(line) && !THEMATIC_BREAK.test(line);

  for (const [index, line] of lines.entries()) {
    const n = index + 1;
    const previous = index > 0 ? lines[index - 1]! : "";
    if (index === 0 && line === LEDGER_TITLE) continue;

    // A <details>, a hidden element or an unclosed tag can fold away the text after it, and telling a
    // tag from a code span needs a full Markdown parser. PATCHES.md has no use for raw HTML.
    if (/<[A-Za-z/!?]/.test(line.replace(AUTOLINK, ""))) {
      errors.push(
        `PATCHES.md line ${n}: raw HTML is not allowed outside a whole-line comment, because it can hide ` +
        `what follows it. A "<" inside a code span counts too (the gate does not parse code spans), so ` +
        `write around it.`);
    }

    if (isBlank(line)) {
      endField();
      continue;
    }

    const setext = SETEXT_UNDERLINE.test(line) && isParagraphText(previous);
    if (LOOKS_LIKE_HEADING.test(line) || setext) {
      endField();
      const heading = setext ? null : entryHeading(line);
      if (!heading) {
        errors.push(
          `unrecognised ledger heading on PATCHES.md line ${setext ? n - 1 : n}: ` +
          `${setext ? `${show(previous)} underlined by ${show(line)} (put a blank line above a rule)` : show(line)}. ` +
          `After the title, every heading must be exactly "## \`<id>\` — LANDED YYYY-MM-DD", ` +
          `"## \`<id>\` — NOT YET LANDED" or "## \`<id>\` — RETIRED YYYY-MM-DD".`);
        entry = null;
        continue;
      }
      if (entries.some((existing) => existing.id === heading.id)) {
        errors.push(`${heading.id} has more than one entry in PATCHES.md (again on line ${n}). One patch, one entry.`);
      }
      entry = { id: heading.id, status: heading.status, files: null, highChurn: [] };
      entries.push(entry);
      given = new Set();
      continue;
    }

    if (SECTION_BREAK.test(line)) {
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
      } else if (!isBlank(previous) && !entryHeading(previous)) {
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

  // Every entry counts, landed or planned, duplicate or not: the budget is spent when it is written
  // down. Only a RETIRED entry -- undone, and checked below to have left nothing behind -- is free.
  const counted = entries.filter((entry) => entry.status !== "RETIRED");
  if (counted.length > MAX_PATCHES) {
    errors.push(
      `PATCHES.md records ${counted.length} patches (landed or planned); the ceiling is ` +
      `${MAX_PATCHES} (PATCHES.md). Re-scope, or retire a patch (revert it and mark it RETIRED), ` +
      `before recording another.`);
  }

  // A duplicate id is already an error; the first entry is the one a reader finds, so it is the one used.
  const entryById = new Map<string, LedgerEntry>();
  for (const entry of entries) if (!entryById.has(entry.id)) entryById.set(entry.id, entry);
  const withStatus = (status: Status) =>
    new Set(entries.filter((entry) => entry.status === status).map((entry) => entry.id));
  const landed = withStatus("LANDED");
  const planned = withStatus("NOT YET LANDED");
  const retired = withStatus("RETIRED");

  // A patch is the commit that makes the change, which the FILES and High-churn checks below hold to
  // its entry. A merge is never one: its own changes are checked with the unpatched commits further down.
  for (const merge of commits.filter((commit) => commit.parents > 1 && commit.id !== null)) {
    errors.push(
      `${merge.id} (${merge.commit}) carries PATCH-ID on a merge commit. Put it on the commit that ` +
      `makes the change.`);
  }
  const patches = commits.filter((commit) => commit.parents <= 1 && commit.id !== null);
  const shipped = new Set(patches.map((patch) => patch.id!));

  for (const id of shipped) {
    if (planned.has(id)) {
      errors.push(`${id} is shipped (has a PATCH-ID commit) but PATCHES.md still says NOT YET LANDED.`);
    } else if (!landed.has(id) && !retired.has(id)) {
      errors.push(`${id} is shipped but has no "LANDED" or "RETIRED" section in PATCHES.md explaining why.`);
    }
  }
  for (const id of landed) {
    if (!shipped.has(id)) {
      errors.push(`PATCHES.md marks ${id} LANDED but no commit carries "PATCH-ID: ${id}".`);
    }
  }
  for (const id of retired) {
    if (!shipped.has(id)) {
      errors.push(
        `PATCHES.md marks ${id} RETIRED but no commit carries "PATCH-ID: ${id}". A patch that never ` +
        `shipped is deleted from PATCHES.md, not retired.`);
    }
  }

  // The entry's **Files:** list and the trailers must name the same files, both ways. Otherwise an
  // unrelated change can ship under an existing PATCH-ID without its entry visibly changing.
  for (const entry of entryById.values()) {
    if (entry.status === "NOT YET LANDED") continue;
    if (entry.files === null) {
      errors.push(`${entry.id} is ${entry.status} but its PATCHES.md entry has no readable **Files:** line.`);
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

  const divergedPaths = new Set(diverged.map((entry) => entry.path));
  const claimed = new Map<string, string>();
  for (const patch of patches) {
    if (patch.files.length === 0) {
      errors.push(`${patch.id} (${patch.commit}) has no FILES trailer, so nothing it changes is claimed.`);
    }
    // A trailer is a claim to check, not a fact. It must name exactly what its commit changes: every
    // kernel file the commit edits, and nothing it leaves alone -- a claim on an untouched file would
    // cover lines some other commit put there.
    for (const path of patch.changed) {
      if (!isDownstreamOnly(path) && !patch.files.includes(path)) {
        errors.push(
          `${patch.id} (${patch.commit}) changes ${path}, but its FILES trailer does not list it. List ` +
          `it (and on the patch's PATCHES.md entry), or move the change into a patch of its own.`);
      }
    }
    for (const file of patch.files) {
      if (!patch.changed.includes(file)) {
        errors.push(
          `${patch.id} (${patch.commit}) lists ${file} in its FILES trailer but does not change it. A ` +
          `trailer names exactly what its commit changes.`);
      }
      if (isHighChurn(file) && !entryById.get(patch.id!)?.highChurn.includes(file)) {
        errors.push(
          `${patch.id} patches ${file}, a high-churn kernel file, but its own PATCHES.md entry does not ` +
          `list it on a **High-churn:** line. Say why no seam reaches it there, or re-scope.`);
      }
      if (!retired.has(patch.id!)) {
        claimed.set(file, patch.id!);
      } else if (divergedPaths.has(file) && !isDownstreamOnly(file)) {
        // Retired means undone. The gate works per file, so it cannot tell whose lines remain in a file
        // another patch still changes; it accepts the retirement once the file is upstream's again.
        errors.push(
          `${patch.id} is RETIRED but ${file}, which it patched, still differs from upstream. Revert its ` +
          `change first; if another patch keeps ${file} diverged, ${patch.id} stays LANDED until that ` +
          `file matches upstream again.`);
      }
    }
  }

  // A file one patch claims is not free for any other commit to edit: whoever touches a diverged kernel
  // file must be a PATCH-ID commit, which the checks above then hold to its entry. That includes a
  // merge. Its own changes are what differs from the merge git would have made unaided -- a conflict
  // resolved by hand, or an edit slipped in -- and a merge cannot carry a PATCH-ID for them.
  for (const commit of commits) {
    if (commit.parents > 2) {
      errors.push(
        `${commit.commit} merges ${commit.parents} parents at once. git re-merges only two, so the gate ` +
        `cannot see what this merge changed by hand. Merge one branch at a time.`);
    }
    if (commit.parents <= 1 && commit.id !== null) continue; // a patch commit: checked above
    for (const path of commit.changed) {
      if (!divergedPaths.has(path) || isDownstreamOnly(path)) continue;
      errors.push(
        commit.parents > 1
          ? `${commit.commit} is a merge that changes ${path} beyond what git merges on its own (a ` +
            `conflict resolved by hand, or an edit). That file differs from upstream, so the change ` +
            `belongs in a PATCH-ID commit: move the patch's conflicting lines aside in one before the ` +
            `merge, let git merge the file cleanly, and restore them in one after.`
          : `${commit.commit} changes ${path}, which differs from upstream, but carries no PATCH-ID. ` +
            `Every commit that edits a patched file is part of a recorded patch.`);
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

function git(args: string[], cwd?: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

/**
 * The paths a commit itself changes. For an ordinary commit, its diff against its parent. For a merge,
 * what differs from the merge git makes on its own (--remerge-diff): nothing for a clean merge, like
 * all three on distro so far, and the file for a conflict resolved by hand or an edit slipped in.
 * Comparing with the parents instead (`--cc`) is not enough: a merge whose second parent is an OLD
 * upstream commit can restore that commit's lines and look as if it merely picked a side.
 */
function changedBy(sha: string, parents: number, root: string): string[] {
  // git skips an octopus merge's remerge-diff silently, printing nothing; checkLedger refuses one outright.
  if (parents > 2) return [];
  const args = parents === 2
    ? ["show", "--remerge-diff", "--format=", "--name-only", "-z", "--no-renames", "--no-color",
      "--no-show-signature", sha]
    : ["diff-tree", "--no-commit-id", "--name-only", "-z", "-r", "--no-renames", "--root", sha];
  return git(args, root).split("\0").filter(Boolean);
}

/** Gather checkLedger's input from git (base..HEAD) and the working tree's PATCHES.md. */
export function readRepo(base: string, root: string): LedgerInput {
  // -z throughout, so a path is the same string in every list whatever characters it holds.
  const fields = git(["diff", "--name-status", "-z", "--no-renames", `${base}...HEAD`], root).split("\0");
  if (fields.pop() !== "" || fields.length % 2 !== 0) throw new Error("unexpected `git diff --name-status -z` output");
  const diverged: Diverged[] = [];
  for (let i = 0; i < fields.length; i += 2) diverged.push({ status: fields[i]!, path: fields[i + 1]! });

  const commits = git([
    "log", "--no-show-signature",
    "--format=%H%x1f%h%x1f%P%x1f%(trailers:key=PATCH-ID,valueonly,separator=%x20)" +
      "%x1f%(trailers:key=FILES,valueonly,separator=%x20)%x1e",
    `${base}..HEAD`,
  ], root)
    .split("\x1e").map((record) => record.trim()).filter(Boolean)
    .map((record) => {
      const [sha, commit, parentList, id, files] = record.split("\x1f");
      const parents = (parentList ?? "").split(/\s+/).filter(Boolean).length;
      return {
        commit: commit!, parents, id: id?.trim() || null,
        files: (files ?? "").split(/\s+/).filter(Boolean), changed: changedBy(sha!, parents, root),
      };
    });

  const ledger = parseLedger(readFileSync(join(root, "PATCHES.md"), "utf8"));
  return { diverged, commits, ledger };
}

// Run the gate when this file is the program, not when the tests import it. This used to compare
// import.meta.url with `file://${argv[1]}`, which is false for a path with a space (the URL encodes it)
// or one reached through a symlink (the URL resolves it) -- and then the gate printed nothing and
// passed. import.meta.main is exact. A Node too old to have it fails here rather than skip the gate.
if (typeof import.meta.main !== "boolean") {
  throw new Error("fabric-patch-ledger needs import.meta.main (Node 22.18+ or 24.2+) to know it was run.");
}
if (import.meta.main) {
  const base = process.argv[2] ?? "upstream-main";
  const root = git(["rev-parse", "--show-toplevel"]).trim();
  const input = readRepo(base, root);
  const { errors, warnings } = checkLedger(input);

  const count = (status: Status) => input.ledger.entries.filter((entry) => entry.status === status).length;
  const retired = count("RETIRED");
  console.log(
    `Patch ledger vs ${base}: ${input.diverged.length} diverged file(s), ` +
    `${count("LANDED")} landed / ${input.ledger.entries.length - retired} recorded ` +
    `(ceiling ${MAX_PATCHES})${retired ? `, ${retired} retired` : ""}.`);
  for (const warning of warnings) console.log(`::warning::${warning}`);
  for (const error of errors) console.log(`::error::${error}`);
  if (errors.length) process.exit(1);
  console.log("Every divergence is a downstream-only file or a recorded patch.");
}
