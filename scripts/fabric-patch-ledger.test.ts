// DOWNSTREAM (fabric): tests for the patch ledger gate. Pure -- no git, no repo state -- except the
// readRepo tests near the end, which build a throwaway repository, because what a merge changes can
// only come from git itself.
//
// The fixtures mirror the real tree at distro-2026-09-18: PATCHES.md's four entries with their real
// **Files:** and **High-churn:** lines, the commits in upstream-main..HEAD with their real trailers and
// diffs, and the twelve diverged files. Each "bypass N" test replays a failing input from
// the adversarial review of 52c699f5, and each "re-attack N" test one from the second review, of
// 07c9eb98. The gate accepted every one of them; each test requires it to be refused.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkLedger, parseLedger, readRepo, LEDGER_TITLE, type Commit, type Diverged,
} from "./fabric-patch-ledger.ts";

const LOGIN_FLOW = "packages/workshop-backend/src/auth/login-flow.ts";
const USER = "packages/workshop-backend/src/user.ts";
const SERVER = "packages/workshop-backend/src/server.ts";
const API = "packages/workshop-shared/src/api.ts";
const OVERSEER = "packages/workshop-backend/src/overseer.ts";
const SHARING = "packages/workshop-backend/src/sharing.ts";
const USAGE_CHECKER = "packages/workshop-backend/src/ai-gateway-billing/limits/usage-checker.ts";

// Characters that look like nothing, or like a newline, in an editor. Built from code points so the
// source of this file holds none of them.
const NBSP = String.fromCodePoint(0xa0);
const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCodePoint(0x2029);
const FENCE = "```";

const LEDGER = `${LEDGER_TITLE}

Every commit on \`distro\` that modifies an upstream file is recorded here and carries a matching
\`PATCH-ID\` trailer. The gate refuses a high-churn file that a patch's entry does not name on its
\`**High-churn:**\` line.

---

## \`fabric-entitlements\` — NOT YET LANDED

**Files:** \`${USAGE_CHECKER}\`

**Review if:** any non-empty diff under \`packages/workshop-backend/src/ai-gateway-billing/\`.

---

## \`fabric-user-lifecycle\` — NOT YET LANDED

**Files:** \`packages/workshop-backend/src/user-directory.ts\`, \`${USER}\`

**Review if:** either file changes shape, particularly the directory's storage layout.

---

## \`fabric-display-name\` — LANDED 2026-09-17

**Files:** \`${LOGIN_FLOW}\`,
\`${USER}\`

**Why no seam:** \`loginOrCreateViaGatekeeper\` seeds a new account's display name from the email.

---

## \`fabric-popupless-signin\` — LANDED 2026-09-17

**Files:** \`${LOGIN_FLOW}\`,
\`${SERVER}\`, \`${API}\`

**High-churn:** \`${SERVER}\`, \`${API}\` — taken deliberately (see Budget note below); the patch ledger gate refuses a high-churn file a patch does not name here.

**Budget note:** the fourth of ten, and the first taken deliberately in two of the high-churn files.
`;

const ENTITLEMENTS_HEADING = "## `fabric-entitlements` — NOT YET LANDED";
const DISPLAY_NAME_HEADING = "## `fabric-display-name` — LANDED 2026-09-17\n";
const DISPLAY_NAME_FILES = `\`${LOGIN_FLOW}\`,\n\`${USER}\`\n`;
const DISPLAY_NAME_WHY = "**Why no seam:** `loginOrCreateViaGatekeeper`";
const POPUPLESS_HEADING = "## `fabric-popupless-signin` — LANDED 2026-09-17\n";

const patchCommit = (commit: string, id: string, files: string[], changed = files): Commit =>
  ({ commit, parents: 1, id, files, changed });
const plainCommit = (commit: string, ...changed: string[]): Commit =>
  ({ commit, parents: 1, id: null, files: [], changed });
/** A merge, and what it changes beyond git's own merge (readRepo's --remerge-diff; nothing when clean). */
const mergeCommit = (commit: string, ...changed: string[]): Commit =>
  ({ commit, parents: 2, id: null, files: [], changed });

const DISPLAY_NAME = patchCommit("09fe09f1", "fabric-display-name", [LOGIN_FLOW, USER], [
  "PATCHES.md", "packages/workshop-backend/__tests__/fabric-display-name.test.ts", LOGIN_FLOW, USER,
]);
const POPUPLESS = patchCommit("00d4a845", "fabric-popupless-signin", [LOGIN_FLOW, SERVER, API], [
  "PATCHES.md", "packages/workshop-backend/__tests__/fabric-popupless-signin.test.ts", LOGIN_FLOW, SERVER, API,
]);

const HISTORY: Commit[] = [
  plainCommit("07c9eb98", "PATCHES.md", "scripts/fabric-patch-ledger.test.ts", "scripts/fabric-patch-ledger.ts"),
  plainCommit("52c699f5", ".github/workflows/fabric-ci.yml", "PATCHES.md",
    "scripts/fabric-patch-ledger.test.ts", "scripts/fabric-patch-ledger.ts"),
  mergeCommit("fa5666f8"),
  plainCommit("e0774969", "PATCHES.md"),
  mergeCommit("d82ccb92"),
  POPUPLESS,
  plainCommit("dc112929", ".github/workflows/fabric-ci.yml",
    "scripts/fabric-patch-ledger.test.ts", "scripts/fabric-patch-ledger.ts"),
  mergeCommit("5b579fc3"),
  DISPLAY_NAME,
  plainCommit("cc64c2fd", ".github/workflows/fabric-ci.yml"),
  plainCommit("656cec3e", "packages/gatekeeper-context/__tests__/fabric-cross-domain.test.ts"),
  plainCommit("8eee2aee", "packages/integration-tests/__tests__/fabric-sandbox-escape.test.ts"),
];

const TODAY: Diverged[] = [
  { status: "A", path: ".github/workflows/fabric-ci.yml" },
  { status: "A", path: "PATCHES.md" },
  { status: "A", path: "packages/gatekeeper-context/__tests__/fabric-cross-domain.test.ts" },
  { status: "A", path: "packages/integration-tests/__tests__/fabric-sandbox-escape.test.ts" },
  { status: "A", path: "packages/workshop-backend/__tests__/fabric-display-name.test.ts" },
  { status: "A", path: "packages/workshop-backend/__tests__/fabric-popupless-signin.test.ts" },
  { status: "M", path: LOGIN_FLOW },
  { status: "M", path: SERVER },
  { status: "M", path: USER },
  { status: "M", path: API },
  { status: "A", path: "scripts/fabric-patch-ledger.test.ts" },
  { status: "A", path: "scripts/fabric-patch-ledger.ts" },
];

interface Scenario { diverged?: Diverged[]; commits?: Commit[]; markdown?: string }

function run({ diverged = TODAY, commits = HISTORY, markdown = LEDGER }: Scenario = {}) {
  return checkLedger({ diverged, commits, ledger: parseLedger(markdown) });
}

/** Replace text that must occur exactly once, so a fixture edit can never silently miss. */
function edit(markdown: string, anchor: string, replacement: string): string {
  assert.equal(markdown.split(anchor).length, 2, `fixture anchor must occur exactly once: ${anchor}`);
  return markdown.replace(anchor, () => replacement);
}

function assertRefused(errors: string[], pattern: RegExp, label = "") {
  assert.ok(errors.some((error) => pattern.test(error)), `${label} expected ${pattern}, got:\n${errors.join("\n")}`);
}

/** Entries after the four real ones: six make ten recorded, seven make eleven. */
const planned = (count: number) =>
  Array.from({ length: count }, (_, n) => `\n---\n\n## \`fabric-planned-${n}\` — NOT YET LANDED\n`).join("");

/**
 * fabric-display-name also taking `file`: honestly in its trailer, its diff, its **Files:** line and the
 * divergence -- so the only thing left to decide is the **High-churn:** acknowledgement.
 */
function displayNameTakes(file: string, acknowledge: boolean): Required<Scenario> {
  let markdown = edit(LEDGER, DISPLAY_NAME_FILES, `\`${LOGIN_FLOW}\`,\n\`${USER}\`, \`${file}\`\n`);
  if (acknowledge) markdown = edit(markdown, DISPLAY_NAME_WHY, `**High-churn:** \`${file}\`\n\n${DISPLAY_NAME_WHY}`);
  const patch = { ...DISPLAY_NAME, files: [...DISPLAY_NAME.files, file], changed: [...DISPLAY_NAME.changed, file] };
  return {
    markdown,
    commits: HISTORY.map((commit) => (commit === DISPLAY_NAME ? patch : commit)),
    diverged: [...TODAY, { status: "M", path: file }],
  };
}

const NOT_ACKNOWLEDGED = /overseer\.ts, a high-churn kernel file, but its own PATCHES\.md entry does not list it/;
const UNRECOGNISED = /unrecognised ledger heading/;
const notPlain = (codePoint: number) =>
  new RegExp(`contains "<U\\+${codePoint.toString(16).toUpperCase().padStart(4, "0")}>"`);

// --- The checks the gate has always made ---------------------------------------------------------

test("reads landed and planned entries, with their **Files:** and **High-churn:** lines", () => {
  assert.deepEqual(parseLedger(LEDGER), {
    errors: [],
    entries: [
      { id: "fabric-entitlements", status: "NOT YET LANDED", files: [USAGE_CHECKER], highChurn: [] },
      { id: "fabric-user-lifecycle", status: "NOT YET LANDED", files: ["packages/workshop-backend/src/user-directory.ts", USER], highChurn: [] },
      { id: "fabric-display-name", status: "LANDED", files: [LOGIN_FLOW, USER], highChurn: [] },
      { id: "fabric-popupless-signin", status: "LANDED", files: [LOGIN_FLOW, SERVER, API], highChurn: [SERVER, API] },
    ],
  });
});

test("passes when every divergence is downstream-only or claimed by a recorded patch", () => {
  assert.deepEqual(run(), { errors: [], warnings: [] });
});

test("reads a CRLF PATCHES.md the same as an LF one", () => {
  assert.deepEqual(parseLedger(LEDGER.replaceAll("\n", "\r\n")), parseLedger(LEDGER));
});

test("fails on a kernel edit no patch claims", () => {
  // No commit in the range made it (a merge resolution did, say): only the file list can see it.
  const { errors } = run({ diverged: [...TODAY, { status: "M", path: SHARING }] });
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /sharing\.ts differs from upstream but no PATCH-ID commit claims it/);
});

test("fails when a patch ships without a PATCHES.md explanation", () => {
  const { errors } = run({ markdown: `${LEDGER_TITLE}\n\n${ENTITLEMENTS_HEADING}\n` });
  assertRefused(errors, /fabric-display-name is shipped but has no "LANDED" or "RETIRED" section/);
});

test("fails when PATCHES.md claims a patch nothing shipped", () => {
  const { errors } = run({ commits: HISTORY.filter((commit) => commit !== DISPLAY_NAME) });
  assertRefused(errors, /marks fabric-display-name LANDED but no commit carries/);
});

test("fails when a shipped patch is still marked NOT YET LANDED", () => {
  const { errors } = run({
    commits: [patchCommit("abc12345", "fabric-entitlements", [USAGE_CHECKER]), ...HISTORY],
    diverged: [...TODAY, { status: "M", path: USAGE_CHECKER }],
  });
  assertRefused(errors, /fabric-entitlements is shipped .* still says NOT YET LANDED/);
});

test("refuses an eleventh patch even while it is only planned, and accepts the tenth", () => {
  assert.deepEqual(run({ markdown: LEDGER + planned(6) }).errors, []);
  assertRefused(run({ markdown: LEDGER + planned(7) }).errors, /records 11 patches .* ceiling is 10/);
});

test("refuses a patch to a high-churn file its own PATCHES.md entry does not acknowledge", () => {
  assertRefused(run(displayNameTakes(OVERSEER, false)).errors, NOT_ACKNOWLEDGED);
});

test("accepts a high-churn file only on the patch's own **High-churn:** line", () => {
  assert.deepEqual(run(displayNameTakes(OVERSEER, true)), { errors: [], warnings: [] });
  const taken = displayNameTakes(OVERSEER, false);
  // Named under a DIFFERENT patch's entry, it acknowledges nothing for this one.
  const elsewhere = edit(taken.markdown, "**Review if:** either file",
    `**High-churn:** \`${OVERSEER}\`\n\n**Review if:** either file`);
  assertRefused(run({ ...taken, markdown: elsewhere }).errors, NOT_ACKNOWLEDGED);
  // Mentioned anywhere but the **High-churn:** line, it acknowledges nothing either.
  const inProse = edit(taken.markdown, DISPLAY_NAME_WHY, `This touches \`${OVERSEER}\`.\n\n${DISPLAY_NAME_WHY}`);
  assertRefused(run({ ...taken, markdown: inProse }).errors, NOT_ACKNOWLEDGED);
});

test("refuses a patch with no FILES trailer", () => {
  const { errors } = run({ commits: HISTORY.map((commit) => (commit === DISPLAY_NAME ? { ...commit, files: [] } : commit)) });
  assertRefused(errors, /fabric-display-name \(09fe09f1\) has no FILES trailer/);
});

test("refuses a downstream-only path that upstream also has", () => {
  // A fabric-* file that upstream created would be modified rather than added, and so conflict.
  const { errors } = run({
    diverged: TODAY.map((entry) => (entry.path === "PATCHES.md" ? { ...entry, status: "M" } : entry)),
  });
  assertRefused(errors, /PATCHES\.md is a downstream-only path but upstream has it too/);
});

test("warns, without failing, when upstream has absorbed a patched file", () => {
  const { errors, warnings } = run({ diverged: TODAY.filter((entry) => entry.path !== USER) });
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((warning) => /user\.ts, which no longer differs from upstream/.test(warning)));
});

// --- Bypass 1: a FILES trailer taken on trust ------------------------------------------------------
// Review input: fabric-entitlements LANDED, its trailer claiming only usage-checker.ts, while
// server.ts already diverged under fabric-popupless-signin. The gate could not tell whether the
// commit had also edited server.ts.

function entitlementsShips(changed: string[]): Required<Scenario> {
  return {
    markdown: edit(LEDGER, ENTITLEMENTS_HEADING, "## `fabric-entitlements` — LANDED 2026-09-18"),
    commits: [patchCommit("cafe0001", "fabric-entitlements", [USAGE_CHECKER], changed), ...HISTORY],
    diverged: [...TODAY, { status: "M", path: USAGE_CHECKER }],
  };
}

test("bypass 1: refuses a patch commit that changes a kernel file its FILES trailer does not list", () => {
  // Changing only what it claims, it passes: the fix refuses the lie, not the patch.
  assert.deepEqual(run(entitlementsShips([USAGE_CHECKER])), { errors: [], warnings: [] });
  assertRefused(run(entitlementsShips([USAGE_CHECKER, SERVER])).errors,
    /fabric-entitlements \(cafe0001\) changes packages\/workshop-backend\/src\/server\.ts, but its FILES trailer does not list it/);
});

test("bypass 1: refuses a commit with no PATCH-ID that edits a file a patch claims", () => {
  const { errors } = run({ commits: [plainCommit("cafe0002", SERVER), ...HISTORY] });
  assertRefused(errors, /cafe0002 changes packages\/workshop-backend\/src\/server\.ts, which differs from upstream, but carries no PATCH-ID/);
});

test("bypass 1: every patch that touches a high-churn file must name it on its own entry", () => {
  // Claimed honestly in its trailer and on its **Files:** line, server.ts is still refused:
  // fabric-popupless-signin's acknowledgement is its own, not the file's.
  const ships = entitlementsShips([USAGE_CHECKER, SERVER]);
  const { errors } = run({
    diverged: ships.diverged,
    markdown: edit(ships.markdown, `**Files:** \`${USAGE_CHECKER}\``, `**Files:** \`${USAGE_CHECKER}\`, \`${SERVER}\``),
    commits: ships.commits.map((commit) =>
      (commit.id === "fabric-entitlements" ? { ...commit, files: [USAGE_CHECKER, SERVER] } : commit)),
  });
  assert.equal(errors.length, 1, errors.join("\n"));
  assert.match(errors[0]!, /fabric-entitlements patches packages\/workshop-backend\/src\/server\.ts, a high-churn kernel file/);
});

// --- Bypass 2: an eleventh patch uncounted because its heading was slightly off --------------------
// Review input: the real PATCHES.md, six correct planned entries (ten recorded), and an eleventh
// written as each of these. Every one renders as a heading (or reads as one) and was skipped.

const ELEVENTH = [
  " ## `fabric-eleventh` — NOT YET LANDED", // one leading space: the same H2 when rendered
  "## `fabric-eleventh` — Not yet landed",
  "## `fabric-eleventh` — PLANNED",
  "## fabric-eleventh — NOT YET LANDED",
  "## `fabric-eleventh`: NOT YET LANDED",
  "## `fabric-eleventh` (NOT YET LANDED)",
  "### `fabric-eleventh` — NOT YET LANDED",
  "`fabric-eleventh` — NOT YET LANDED\n---", // setext: underlined text is an H2
  "`fabric-eleventh` — NOT YET LANDED\n===",
  `## \`fabric-eleventh\` — NOT${NBSP}YET LANDED`, // identical on screen, even in the source
  "> ## `fabric-eleventh` — NOT YET LANDED",
  // Found while checking the second review: setext headings inside a quote or a list item, which a
  // renderer shows as headings (checked against micromark) and the gate read as plain text.
  "> `fabric-eleventh` — NOT YET LANDED\n> ---",
  "1. `fabric-eleventh` — NOT YET LANDED\n    ===",
  "- notes\n\n  - `fabric-eleventh` — NOT YET LANDED\n    ---",
];

test("bypass 2: refuses every heading after the title that is not an exact entry heading", () => {
  for (const heading of ELEVENTH) {
    const { errors } = run({ markdown: `${LEDGER}${planned(6)}\n---\n\n${heading}\n` });
    assertRefused(errors, UNRECOGNISED, `accepted ${JSON.stringify(heading)}:`);
  }
});

test("bypass 2: a malformed entry heading cannot hide in the preamble or pose as the title", () => {
  const inPreamble = edit(LEDGER, "\n---\n\n## `fabric-entitlements`",
    "\n ## `fabric-eleventh` — NOT YET LANDED\n\n---\n\n## `fabric-entitlements`");
  assertRefused(run({ markdown: inPreamble }).errors, UNRECOGNISED);
  const asTitle = edit(LEDGER, `${LEDGER_TITLE}\n`, "# `fabric-eleventh` — NOT YET LANDED\n");
  assertRefused(run({ markdown: asTitle }).errors, /must start with the line "# Downstream patches"/);
});

// --- Bypass 3: another entry's **High-churn:** line credited to the patch above it -----------------

test("bypass 3: a **High-churn:** line counts only inside its own entry's section", () => {
  const taken = displayNameTakes(OVERSEER, false);
  const ack = `**High-churn:** \`${OVERSEER}\``;
  const cases = {
    // Review input: a skipped heading merged the next entry's text into fabric-display-name's section.
    "under a skipped heading": edit(taken.markdown, POPUPLESS_HEADING,
      ` ## \`fabric-overseer-hook\` — NOT YET LANDED\n\n${ack}\n\n${POPUPLESS_HEADING}`),
    // Review input (second review): under a later non-entry heading.
    "under a non-entry heading": edit(taken.markdown, `---\n\n${POPUPLESS_HEADING}`,
      `## Retired patches\n\n${ack}\n\n---\n\n${POPUPLESS_HEADING}`),
    // After a thematic break the text is visibly not part of the entry above.
    "after a thematic break": edit(taken.markdown, `---\n\n${POPUPLESS_HEADING}`,
      `---\n\n${ack}\n\n${POPUPLESS_HEADING}`),
    // Found by fuzzing against micromark: a rule inside a quote or a list item renders as a rule too.
    "after a rule in a quote": edit(taken.markdown, `---\n\n${POPUPLESS_HEADING}`,
      `> ---\n\n${ack}\n\n---\n\n${POPUPLESS_HEADING}`),
    "after a rule in a list item": edit(taken.markdown, `---\n\n${POPUPLESS_HEADING}`,
      `-\n    ***\n\n${ack}\n\n---\n\n${POPUPLESS_HEADING}`),
  };
  for (const [label, markdown] of Object.entries(cases)) {
    assertRefused(run({ ...taken, markdown }).errors, NOT_ACKNOWLEDGED, `${label}:`);
  }
});

test("bypass 3: an entry gets one **High-churn:** line and one **Files:** line", () => {
  const churnTwice = edit(LEDGER, "**Budget note:**", `**High-churn:** \`${OVERSEER}\`\n\n**Budget note:**`);
  assertRefused(run({ markdown: churnTwice }).errors, /fabric-popupless-signin has a second \*\*High-churn:\*\* line/);
  const filesTwice = edit(LEDGER, DISPLAY_NAME_WHY, `**Files:** \`${SHARING}\`\n\n${DISPLAY_NAME_WHY}`);
  assertRefused(run({ markdown: filesTwice }).errors, /fabric-display-name has a second \*\*Files:\*\* line/);
});

// --- Bypass 4: an acknowledgement hidden from reviewers --------------------------------------------
// Review input: under fabric-display-name's heading, with that patch claiming overseer.ts.

test("bypass 4: an acknowledgement in an HTML comment or a code fence acknowledges nothing", () => {
  const taken = displayNameTakes(OVERSEER, false);
  const ack = `**High-churn:** \`${OVERSEER}\``;
  for (const hidden of [`<!--\n${ack}\n-->`, `<!-- ${ack} -->`, `${FENCE}md\n${ack}\n${FENCE}`, `~~~\n${ack}\n~~~`]) {
    const markdown = edit(taken.markdown, DISPLAY_NAME_HEADING, `${DISPLAY_NAME_HEADING}\n${hidden}\n`);
    assertRefused(run({ ...taken, markdown }).errors, NOT_ACKNOWLEDGED, `accepted ${JSON.stringify(hidden)}:`);
  }
});

// --- Bypass 5: a hidden or fake LANDED section -----------------------------------------------------
// Review input: a shipped fabric-sneak claiming sharing.ts, with a LANDED section only a regex sees.

const SNEAK: Required<Omit<Scenario, "markdown">> = {
  commits: [patchCommit("cafe0003", "fabric-sneak", [SHARING]), ...HISTORY],
  diverged: [...TODAY, { status: "M", path: SHARING }],
};
const NO_SNEAK_SECTION = /fabric-sneak is shipped but has no "LANDED" or "RETIRED" section/;
const REVIEW_IF = "**Review if:** either file changes shape, particularly the directory's storage layout.";

test("bypass 5: a LANDED heading inside an HTML comment or code fence is no entry", () => {
  for (const heading of ["## `fabric-sneak` — LANDED", "## `fabric-sneak` — LANDED 2026-09-18"]) {
    const cases = [
      `${LEDGER}\n<!--\n${heading}\n-->\n`,
      `${LEDGER}\nTemplate for a new entry:\n\n${FENCE}md\n${heading.replace("2026-09-18", "YYYY-MM-DD")}\n${FENCE}\n`,
      `${LEDGER}\n${FENCE}md\n${heading}\n${FENCE}\n`,
    ];
    for (const markdown of cases) assertRefused(run({ ...SNEAK, markdown }).errors, NO_SNEAK_SECTION, markdown);
  }
});

test("bypass 5: refuses U+2028, U+2029 and a lone CR, which make a heading for one reader only", () => {
  for (const separator of [LINE_SEPARATOR, PARAGRAPH_SEPARATOR, "\r"]) {
    const markdown = edit(LEDGER, REVIEW_IF, `${REVIEW_IF}${separator}## \`fabric-sneak\` — LANDED 2026-09-18`);
    const { errors } = run({ ...SNEAK, markdown });
    assertRefused(errors, notPlain(separator.codePointAt(0)!));
    assertRefused(errors, NO_SNEAK_SECTION);
  }
  // The same trick supplying an acknowledgement after fabric-display-name's section.
  const taken = displayNameTakes(OVERSEER, false);
  const markdown = edit(taken.markdown, "from the email.",
    `from the email.${LINE_SEPARATOR}## \`fabric-display-name\` — LANDED 2026-09-17${LINE_SEPARATOR}**High-churn:** \`${OVERSEER}\``);
  assertRefused(run({ ...taken, markdown }).errors, NOT_ACKNOWLEDGED);
});

// --- Bypass 6: an eleventh patch shipped under an existing PATCH-ID --------------------------------

test("bypass 6: a patch's FILES trailers must equal its entry's **Files:** list", () => {
  // Review input: ten recorded, and a second fabric-display-name commit claiming sharing.ts.
  const { errors } = run({
    markdown: LEDGER + planned(6),
    commits: [patchCommit("cafef00d", "fabric-display-name", [SHARING]), ...HISTORY],
    diverged: [...TODAY, { status: "M", path: SHARING }],
  });
  assertRefused(errors, /fabric-display-name's FILES trailers claim packages\/workshop-backend\/src\/sharing\.ts, but its PATCHES\.md \*\*Files:\*\* line does not list it/);
  // And the other way round: the entry lists a file no fabric-display-name commit claims.
  const listed = edit(LEDGER, DISPLAY_NAME_FILES, `\`${LOGIN_FLOW}\`,\n\`${USER}\`, \`${SHARING}\`\n`);
  assertRefused(run({ markdown: listed }).errors,
    /fabric-display-name's PATCHES\.md \*\*Files:\*\* line lists packages\/workshop-backend\/src\/sharing\.ts, but no "PATCH-ID: fabric-display-name" commit claims it/);
});

test("bypass 6: a LANDED entry needs a readable **Files:** line", () => {
  const missing = edit(LEDGER, `**Files:** ${DISPLAY_NAME_FILES}\n`, "");
  assertRefused(run({ markdown: missing }).errors, /fabric-display-name is LANDED but its PATCHES\.md entry has no readable \*\*Files:\*\* line/);
  const prose = edit(LEDGER, `**Files:** ${DISPLAY_NAME_FILES}`, `**Files:** the login flow and \`${USER}\`\n`);
  assertRefused(run({ markdown: prose }).errors, /fabric-display-name's \*\*Files:\*\* line \(PATCHES\.md line \d+\) must be only backticked paths/);
});

// --- Bypass 7: a duplicate entry supplying the acknowledgement -------------------------------------

test("bypass 7: refuses a second entry for the same patch id, and it acknowledges nothing", () => {
  const taken = displayNameTakes(OVERSEER, false);
  const ack = `**High-churn:** \`${OVERSEER}\``;
  // Review input, verbatim: its undated LANDED is itself no longer a heading the gate accepts.
  const verbatim = run({ ...taken, markdown: `${taken.markdown}\n## \`fabric-display-name\` — LANDED\n\n${ack}\n` }).errors;
  assertRefused(verbatim, UNRECOGNISED);
  assertRefused(verbatim, NOT_ACKNOWLEDGED);
  // Written as an exact entry heading, it is a duplicate; the first entry is the one that counts.
  const duplicate = `\n---\n\n${DISPLAY_NAME_HEADING}\n**Files:** \`${OVERSEER}\`\n\n${ack}\n`;
  const { errors } = run({ ...taken, markdown: taken.markdown + duplicate });
  assertRefused(errors, /fabric-display-name has more than one entry in PATCHES\.md/);
  assertRefused(errors, NOT_ACKNOWLEDGED);
  // Duplicates still count toward the ceiling: four real, six planned and the duplicate make eleven.
  assertRefused(run({ markdown: LEDGER + planned(6) + duplicate }).errors, /records 11 patches/);
});

// --- Bypass 8: a negated acknowledgement, and loose status text ------------------------------------

test("bypass 8: a **High-churn:** line must lead with its backticked paths, and its prose holds none", () => {
  const taken = displayNameTakes(OVERSEER, false);
  const malformed = /fabric-display-name's \*\*High-churn:\*\* line .* acknowledges nothing/;
  for (const line of [
    `**High-churn:** none. (An early draft touched \`${OVERSEER}\`; this patch does not.)`, // review input
    `**High-churn:** deliberately, \`${OVERSEER}\``,
    `**High-churn:** \`${OVERSEER}\` — and \`${SERVER}\` in a follow-up`,
    `**High-churn:** \`${OVERSEER}\` and \`${SERVER}\``,
  ]) {
    const markdown = edit(taken.markdown, DISPLAY_NAME_WHY, `${line}\n\n${DISPLAY_NAME_WHY}`);
    const { errors } = run({ ...taken, markdown });
    assertRefused(errors, malformed, `accepted ${JSON.stringify(line)}:`);
    assertRefused(errors, NOT_ACKNOWLEDGED);
  }
});

test("bypass 8: an entry heading's status must be exact, not merely begin with LANDED", () => {
  for (const heading of [
    "##\n`fabric-sneak` — LANDED", // review input: an empty heading, then a paragraph
    "## `fabric-sneak` — LANDED? No: planned, still under review", // review input
    "## `fabric-sneak` — LANDED",
    "## `fabric-sneak` — LANDED 2026-09-18 # still under review",
    "## `fabric-sneak` — NOT YET LANDED 2026-09-18",
    "## `fabric-sneak` — RETIRED",
  ]) {
    const { errors } = run({ ...SNEAK, markdown: `${LEDGER}\n---\n\n${heading}\n` });
    assertRefused(errors, UNRECOGNISED, `accepted ${JSON.stringify(heading)}:`);
    assertRefused(errors, NO_SNEAK_SECTION);
  }
});

// --- Structure the gate refuses rather than guesses at ----------------------------------------------

test("a **High-churn:** line names only high-churn files that its entry's **Files:** line lists", () => {
  const notHighChurn = edit(LEDGER, DISPLAY_NAME_WHY, `**High-churn:** \`${USER}\`\n\n${DISPLAY_NAME_WHY}`);
  assertRefused(run({ markdown: notHighChurn }).errors, /names packages\/workshop-backend\/src\/user\.ts on its \*\*High-churn:\*\* line, but that is not a high-churn file/);
  const notInFiles = edit(LEDGER, DISPLAY_NAME_WHY, `**High-churn:** \`${OVERSEER}\`\n\n${DISPLAY_NAME_WHY}`);
  assertRefused(run({ markdown: notInFiles }).errors, /names packages\/workshop-backend\/src\/overseer\.ts on its \*\*High-churn:\*\* line but not on its \*\*Files:\*\* line/);
});

test("refuses field lines it would otherwise misread: outside an entry, glued to a paragraph, or malformed", () => {
  const taken = displayNameTakes(OVERSEER, false);
  const ack = `**High-churn:** \`${OVERSEER}\``;
  const outside = edit(taken.markdown, "\n---\n\n## `fabric-entitlements`", `\n${ack}\n\n---\n\n## \`fabric-entitlements\``);
  assertRefused(run({ ...taken, markdown: outside }).errors, /line is outside any patch entry/);
  const glued = edit(taken.markdown, "from the email.", `from the email.\n${ack}`);
  assertRefused(run({ ...taken, markdown: glued }).errors, /must start its own paragraph/);
  for (const line of [`**High-Churn:** \`${OVERSEER}\``, `**High-churn**: \`${OVERSEER}\``, `> ${ack}`, `- ${ack}`]) {
    const markdown = edit(taken.markdown, DISPLAY_NAME_WHY, `${line}\n\n${DISPLAY_NAME_WHY}`);
    assertRefused(run({ ...taken, markdown }).errors, /looks like a \*\*Files:\*\* or \*\*High-churn:\*\* line but is not exactly one/, line);
  }
});

test("refuses raw HTML, which can fold away the text after it", () => {
  const taken = displayNameTakes(OVERSEER, true);
  const ack = `**High-churn:** \`${OVERSEER}\``;
  const folded = edit(taken.markdown, ack, `<details>\n\n${ack}`);
  assertRefused(run({ ...taken, markdown: folded }).errors, /raw HTML/);
  const inline = edit(LEDGER, "from the email.", "from the email <!-- or not -->.");
  assertRefused(run({ markdown: inline }).errors, /raw HTML/);
});

test("refuses a comment or fence whose end a renderer could see differently", () => {
  const cases: Array<[string, RegExp]> = [
    [`${LEDGER}\n<!-- note --> visible\n`, /text after "-->" is rendered/],
    [`${LEDGER}\n<!-- note --!> visible\n-->\n`, /"--!>" ends an HTML comment early/],
    [`${LEDGER}\n<!--\n`, /HTML comment is never closed/],
    [`${LEDGER}\n${FENCE}\n`, /code fence is never closed/],
    [`${LEDGER}\n  ${FENCE}\ncode\n  ${FENCE}\n`, /start a code fence at column 0/],
  ];
  for (const [markdown, pattern] of cases) assertRefused(parseLedger(markdown).errors, pattern);
});

test("refuses a PATCH-ID on a merge commit: a patch is the commit that makes the change", () => {
  const commits = HISTORY.map((commit) =>
    (commit.commit === "d82ccb92" ? { ...commit, id: "fabric-popupless-signin", files: [SERVER] } : commit));
  assertRefused(run({ commits }).errors, /fabric-popupless-signin \(d82ccb92\) carries PATCH-ID on a merge commit/);
});

// --- Re-attack 1: a merge supplying a patched file's content ----------------------------------------
// Review input: (a) a real merge of a side branch that only adds a test file, with server.ts edited
// before committing; (b) a fake merge (second parent an ancestor of the first, so no conflict is
// possible) editing server.ts; (c) the same editing user.ts. The gate skipped every merge. readRepo now
// gives a merge's `changed` as what differs from git's own merge; these tests take that as given, and
// the readRepo tests below check git produces it.

test("re-attack 1: refuses a merge that changes a patched file beyond what git merges on its own", () => {
  for (const path of [SERVER, USER, LOGIN_FLOW]) {
    const { errors } = run({ commits: [mergeCommit("cafe0004", path), ...HISTORY] });
    assert.equal(errors.length, 1, errors.join("\n"));
    assert.ok(errors[0]!.startsWith(`cafe0004 is a merge that changes ${path} beyond what git merges on its own`), errors[0]);
  }
  // Settling PATCHES.md by hand, or a kernel file back to upstream's text, leaves nothing unrecorded.
  assert.deepEqual(run({ commits: [mergeCommit("cafe0005", "PATCHES.md", SHARING), ...HISTORY] }).errors, []);
});

test("re-attack 1: refuses an octopus merge, whose own changes git cannot show", () => {
  const { errors } = run({ commits: [{ ...mergeCommit("cafe0006"), parents: 3 }, ...HISTORY] });
  assertRefused(errors, /cafe0006 merges 3 parents at once/);
});

test("re-attack 1: a FILES trailer may not claim a file its commit does not change", () => {
  // Review input: fabric-display-name also lists sharing.ts, in its FILES trailer and on its **Files:**
  // line, while sharing.ts diverges -- a claim that some other commit, or a merge, could then fill.
  const { errors } = run({
    markdown: edit(LEDGER, DISPLAY_NAME_FILES, `\`${LOGIN_FLOW}\`,\n\`${USER}\`, \`${SHARING}\`\n`),
    commits: HISTORY.map((commit) => (commit === DISPLAY_NAME ? { ...commit, files: [...commit.files, SHARING] } : commit)),
    diverged: [...TODAY, { status: "M", path: SHARING }],
  });
  assert.equal(errors.length, 1, errors.join("\n"));
  assert.match(errors[0]!, /fabric-display-name \(09fe09f1\) lists packages\/workshop-backend\/src\/sharing\.ts in its FILES trailer but does not change it/);
});

// --- Re-attacks 2 and 3: characters a renderer and this parser read differently ----------------------

test("re-attack 2: a line holding only a Unicode space is text, so the line above it can be a heading", () => {
  // Review input (a): an eleventh entry, underlined, over a line holding only a Unicode space.
  const spaces = [0xa0, 0x1680, 0x2000, 0x2003, 0x2007, 0x200a, 0x202f, 0x3000, 0xfeff];
  for (const space of spaces) {
    const markdown = `${LEDGER}${planned(6)}\n---\n\n\`fabric-eleventh\` — NOT YET LANDED\n${String.fromCodePoint(space)}\n---\n`;
    const { errors } = run({ markdown });
    assertRefused(errors, notPlain(space));
    assertRefused(errors, UNRECOGNISED); // and read as the heading a renderer shows
  }
  // Review input (b): the same trick, with ===, moving an acknowledgement under fabric-display-name.
  const taken = displayNameTakes(OVERSEER, false);
  const markdown = edit(taken.markdown, `---\n\n${POPUPLESS_HEADING}`,
    `\`fabric-overseer-hook\` — NOT YET LANDED\n${NBSP}\n===\n\n**High-churn:** \`${OVERSEER}\`\n\n---\n\n${POPUPLESS_HEADING}`);
  const { errors } = run({ ...taken, markdown });
  assertRefused(errors, notPlain(0xa0));
  assertRefused(errors, NOT_ACKNOWLEDGED);
  // A line of spaces and tabs is still a blank line, as CommonMark says.
  assert.deepEqual(parseLedger(edit(LEDGER, `\n\n${DISPLAY_NAME_WHY}`, `\n \t\n${DISPLAY_NAME_WHY}`)), parseLedger(LEDGER));
});

test("re-attack 3: an invisible character in front of a heading is refused wherever it sits", () => {
  // Review input: 16 characters that render as nothing, before, inside and after the "##".
  const invisible = [0x200b, 0x200c, 0x200d, 0x2060, 0x200e, 0x200f, 0x202a, 0x202e, 0x2066, 0xad, 0x34f,
    0xfe0f, 0x180e, 0x3164, 0x2800, 0xe0020];
  for (const codePoint of invisible) {
    const char = String.fromCodePoint(codePoint);
    for (const heading of [`${char}## `, `#${char}# `, `##${char} `]) {
      const { errors } = run({ markdown: `${LEDGER}${planned(6)}\n---\n\n${heading}\`fabric-eleventh\` — NOT YET LANDED\n` });
      assertRefused(errors, notPlain(codePoint), `accepted ${JSON.stringify(heading)}:`);
    }
  }
  // Review input: the section shift, a ZWSP heading moving an acknowledgement under fabric-display-name.
  const taken = displayNameTakes(OVERSEER, false);
  const markdown = edit(taken.markdown, `---\n\n${POPUPLESS_HEADING}`,
    `${String.fromCodePoint(0x200b)}## \`fabric-overseer-hook\` — NOT YET LANDED\n\n**High-churn:** \`${OVERSEER}\`\n\n---\n\n${POPUPLESS_HEADING}`);
  assertRefused(run({ ...taken, markdown }).errors, notPlain(0x200b));
});

// --- Re-attack 5: forms that render correctly and were refused ----------------------------------------

test("re-attack 5: accepts what renders the same -- a BOM, a heading's trailing space or closing #s, a tab, an autolink", () => {
  const accepted = {
    "leading BOM": `${String.fromCodePoint(0xfeff)}${LEDGER}`,
    "trailing space": edit(LEDGER, POPUPLESS_HEADING, POPUPLESS_HEADING.replace("\n", " \n")),
    "closing ##": edit(LEDGER, POPUPLESS_HEADING, POPUPLESS_HEADING.replace("\n", " ##\n")),
    "tab after **Files:**": edit(LEDGER, `**Files:** \`${USAGE_CHECKER}\``, `**Files:**\t\`${USAGE_CHECKER}\``),
    "autolink": edit(LEDGER, "from the email.", "from the email (<https://workos.com/docs/user-management>)."),
  };
  for (const [label, markdown] of Object.entries(accepted)) {
    assert.deepEqual(parseLedger(markdown), parseLedger(LEDGER), label);
  }
});

test("re-attack 5: still refuses what it cannot tell apart safely, and says how to write it", () => {
  // Telling a code span from raw HTML needs a full parser: `Promise<void>` could be either.
  const codeSpan = edit(LEDGER, "from the email.", "from the email, returning `Promise<void>`.");
  assertRefused(run({ markdown: codeSpan }).errors, /raw HTML .*code span counts too .*write around it/);
  // A list directly above a rule renders as list and rule, but written flush it can be a heading.
  const listThenRule = edit(LEDGER, "from the email.\n\n---", "from the email.\n\n- one\n- two\n---");
  assertRefused(run({ markdown: listThenRule }).errors, /"- two" underlined by "---" \(put a blank line above a rule\)/);
});

// --- Re-attack 6: retiring a patch ----------------------------------------------------------------
// Review input: fabric-display-name reverted by a commit carrying its PATCH-ID, and its entry removed.
// A PATCH-ID commit stays in upstream-main..HEAD forever, so the entry could never go, and its slot
// never came back. A RETIRED entry stays as the record and frees the slot, once it has left nothing.

function entitlementsRetired(stillDiverged: boolean): Required<Scenario> {
  return {
    markdown: edit(LEDGER, ENTITLEMENTS_HEADING, "## `fabric-entitlements` — RETIRED 2026-09-18"),
    commits: [
      patchCommit("cafe0008", "fabric-entitlements", [USAGE_CHECKER]), // the revert
      patchCommit("cafe0007", "fabric-entitlements", [USAGE_CHECKER]),
      ...HISTORY,
    ],
    diverged: stillDiverged ? [...TODAY, { status: "M", path: USAGE_CHECKER }] : TODAY,
  };
}

test("re-attack 6: a patch reverted and marked RETIRED passes and frees its slot", () => {
  const retired = entitlementsRetired(false);
  assert.deepEqual(run(retired), { errors: [], warnings: [] });
  // Three counted (display-name, popupless, user-lifecycle) plus seven planned is ten; eight is eleven.
  assert.deepEqual(run({ ...retired, markdown: retired.markdown + planned(7) }).errors, []);
  assertRefused(run({ ...retired, markdown: retired.markdown + planned(8) }).errors, /records 11 patches/);
});

test("re-attack 6: RETIRED is refused while the patch's files still differ from upstream", () => {
  assertRefused(run(entitlementsRetired(true)).errors,
    /fabric-entitlements is RETIRED but packages\/workshop-backend\/src\/ai-gateway-billing\/limits\/usage-checker\.ts, which it patched, still differs/);
  // The review's own case: user.ts reverted, but login-flow.ts still differs because
  // fabric-popupless-signin patches it too. The gate works per file, so it cannot tell whose lines
  // remain there, and the retirement waits until login-flow.ts matches upstream.
  const { errors } = run({
    markdown: edit(LEDGER, DISPLAY_NAME_HEADING, "## `fabric-display-name` — RETIRED 2026-09-18\n"),
    commits: [patchCommit("cafe0009", "fabric-display-name", [USER]), ...HISTORY],
    diverged: TODAY.filter((entry) => entry.path !== USER),
  });
  assert.equal(errors.length, 1, errors.join("\n"));
  assert.match(errors[0]!, /fabric-display-name is RETIRED but packages\/workshop-backend\/src\/auth\/login-flow\.ts, which it patched, still differs/);
});

test("re-attack 6: a patch that never shipped cannot be RETIRED", () => {
  const markdown = edit(LEDGER, ENTITLEMENTS_HEADING, "## `fabric-entitlements` — RETIRED 2026-09-18");
  assertRefused(run({ markdown }).errors, /marks fabric-entitlements RETIRED but no commit carries/);
});

// --- readRepo against a real repository (re-attacks 1 and 4) -----------------------------------------
// What a merge changes, and whether the script runs at all, come from git and node themselves, so
// they are checked in a throwaway repository whose path holds a space.

const KERNEL = "src/kernel.ts";
const KERNEL_LEDGER = `${LEDGER_TITLE}\n\n## \`fabric-k\` — LANDED 2026-09-18\n\n**Files:** \`${KERNEL}\`\n`;
const SCRIPT = fileURLToPath(new URL("./fabric-patch-ledger.ts", import.meta.url));

/**
 * kernel.ts: twenty lines, some replaced. Upstream's change (line 2) and the patch's (line 19) sit far
 * enough apart to be separate hunks, as they usually are in a real file.
 */
const kernelText = (changes: Record<number, string>, extra = "") =>
  `${Array.from({ length: 20 }, (_, i) => changes[i + 1] ?? `line ${i + 1}`).join("\n")}\n${extra}`;
const UPSTREAM_0 = kernelText({});
const UPSTREAM_1 = kernelText({ 2: "upstream's line 2" });
const PATCHED = kernelText({ 2: "upstream's line 2", 19: "the patch's line 19" });
const BACKDOORED = kernelText({ 2: "upstream's line 2", 19: "the patch's line 19" }, "export const backdoor = 1;\n");

/**
 * upstream: u0, then u1 (changes line 2). distro: u1 + a fabric-k patch (changes line 19). side: the
 * patch + a new fabric-* test file. PATCHES.md and a copy of the gate sit untracked in the tree.
 */
function throwawayRepo() {
  const dir = mkdtempSync(join(tmpdir(), "fabric ledger "));
  // Isolated from the user's git config (signing, hooks, aliases), for setup and for readRepo alike.
  const saved = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" });
  const env = {
    ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
  };
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const cleanup = () => {
    rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  git("init", "-q", "-b", "upstream");
  write(KERNEL, UPSTREAM_0);
  git("add", KERNEL);
  git("commit", "-qm", "u0");
  const u0 = git("rev-parse", "HEAD");
  write(KERNEL, UPSTREAM_1);
  git("commit", "-qam", "u1");
  git("checkout", "-qb", "distro");
  write(KERNEL, PATCHED);
  git("commit", "-qam", `patch\n\nPATCH-ID: fabric-k\nFILES: ${KERNEL}`);
  const patch = git("rev-parse", "HEAD");
  git("checkout", "-qb", "side");
  write("packages/x/__tests__/fabric-x.test.ts", "export {};\n");
  git("add", "packages/x/__tests__/fabric-x.test.ts");
  git("commit", "-qm", "side");
  git("checkout", "-q", "distro");
  write("PATCHES.md", KERNEL_LEDGER);
  mkdirSync(join(dir, "scripts"));
  copyFileSync(SCRIPT, join(dir, "scripts", "fabric-patch-ledger.ts"));
  symlinkSync(join(dir, "scripts"), join(dir, "linked scripts"));

  /** A merge commit of `parents` whose tree is the patch's, with kernel.ts set to `kernel` if given. */
  const fakeMerge = (kernel: string | null, ...parents: string[]) => {
    git("checkout", "-q", "--detach", patch);
    if (kernel !== null) {
      write(KERNEL, kernel);
      git("add", KERNEL);
    }
    const tree = git("write-tree");
    git("reset", "-q", "--hard"); // tracked files only: PATCHES.md and the gate's copy stay
    return git("commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent]), "-m", "merge");
  };
  /** Point HEAD at `commit` and read the repo as the gate does. */
  const readAt = (commit: string) => {
    git("checkout", "-q", "--detach", commit);
    const input = readRepo("upstream", dir);
    return { input, merge: input.commits[0]!, report: checkLedger(input) };
  };
  return { dir, git, write, u0, patch, fakeMerge, readAt, cleanup };
}

test("readRepo: a clean merge changes nothing; each of the review's merges changes the file it edited", () => {
  const repo = throwawayRepo();
  try {
    const { git, write, u0, patch, fakeMerge, readAt } = repo;
    const REFUSED = new RegExp(`is a merge that changes ${KERNEL.replace(".", "\\.")} beyond what git merges on its own`);

    git("checkout", "-q", "--detach", patch);
    git("merge", "-q", "--no-ff", "--no-edit", "side");
    const clean = readAt(git("rev-parse", "HEAD"));
    assert.deepEqual([clean.merge.parents, clean.merge.changed], [2, []]);
    assert.deepEqual(clean.report, { errors: [], warnings: [] });

    // A clean upstream merge where both sides changed kernel.ts, two lines apart, changes nothing of its
    // own either. (Comparing with the parents -- `--cc` -- flags this one: its combined hunk differs
    // from both.) This is the merge an upstream sync makes, so it must pass.
    git("checkout", "-q", "upstream");
    write(KERNEL, kernelText({ 2: "upstream's line 2", 17: "upstream's line 17" }));
    git("commit", "-qam", "u2");
    git("checkout", "-q", "--detach", patch);
    git("merge", "-q", "--no-edit", "upstream");
    const sync = readAt(git("rev-parse", "HEAD"));
    assert.deepEqual([sync.merge.parents, sync.merge.changed], [2, []]);
    assert.deepEqual(sync.report, { errors: [], warnings: [] });

    // (a) a real merge, with kernel.ts edited before committing.
    git("checkout", "-q", "--detach", patch);
    git("merge", "-q", "--no-ff", "--no-commit", "side");
    write(KERNEL, BACKDOORED);
    git("add", KERNEL);
    git("commit", "-qm", "merge side");
    const cases = {
      "(a) real merge, edited": git("rev-parse", "HEAD"),
      // (b) a fake merge: its second parent is an ancestor of the first, so nothing can conflict.
      "(b) fake merge, edited": fakeMerge(BACKDOORED, patch, `${patch}~1`),
      // Beyond the review: a second parent that is OLD upstream, whose line 2 the merge restores --
      // undoing an upstream change, a security fix say. Each hunk matches one parent or the other, so
      // the review's suggested `git diff-tree --cc -p` shows nothing; the remerge shows it.
      "old upstream restored": fakeMerge(kernelText({ 19: "the patch's line 19" }), patch, u0),
    };
    for (const [label, commit] of Object.entries(cases)) {
      const { merge, report } = readAt(commit);
      assert.deepEqual([merge.parents, merge.changed], [2, [KERNEL]], label);
      assertRefused(report.errors, REFUSED, `${label}:`);
    }

    const octopus = readAt(fakeMerge(null, patch, "side", u0));
    assert.equal(octopus.merge.parents, 3);
    assertRefused(octopus.report.errors, /merges 3 parents at once/);
  } finally {
    repo.cleanup();
  }
});

test("re-attack 4: the gate runs from a path with a space, or through a symlink, and fails closed", () => {
  // The old guard compared import.meta.url with `file://${argv[1]}`: through either path it printed
  // nothing and exited 0, gate never run. (On macOS the temporary directory is itself behind a symlink.)
  const repo = throwawayRepo();
  try {
    const { dir, git, patch, fakeMerge } = repo;
    const gate = (scripts: string) =>
      spawnSync(process.execPath, [join(dir, scripts, "fabric-patch-ledger.ts"), "upstream"], { cwd: dir, encoding: "utf8" });

    git("checkout", "-q", "--detach", patch);
    for (const scripts of ["scripts", "linked scripts"]) {
      const result = gate(scripts);
      assert.equal(result.status, 0, `${scripts}: ${result.stdout}${result.stderr}`);
      assert.match(result.stdout, /Patch ledger vs upstream: 1 diverged file\(s\), 1 landed \/ 1 recorded/);
    }

    git("checkout", "-q", "--detach", fakeMerge(BACKDOORED, patch, `${patch}~1`));
    for (const scripts of ["scripts", "linked scripts"]) {
      const result = gate(scripts);
      assert.equal(result.status, 1, `${scripts}: ${result.stdout}${result.stderr}`);
      assert.match(result.stdout, /::error::.* is a merge that changes src\/kernel\.ts/);
    }
  } finally {
    repo.cleanup();
  }
});
