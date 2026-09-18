// DOWNSTREAM (fabric): tests for the patch ledger gate. Pure -- no git, no repo state.
//
// The fixtures mirror the real tree at distro-2026-09-18: PATCHES.md's four entries with their real
// **Files:** and **High-churn:** lines, the eleven commits in upstream-main..HEAD with their real
// trailers and diffs, and the twelve diverged files. Each "bypass N" test replays a failing input from
// the adversarial review of 52c699f5 (which the gate then accepted) and requires it to be refused.

import assert from "node:assert/strict";
import test from "node:test";
import { checkLedger, parseLedger, LEDGER_TITLE, type Commit, type Diverged } from "./fabric-patch-ledger.ts";

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

const DISPLAY_NAME_HEADING = "## `fabric-display-name` — LANDED 2026-09-17\n";
const DISPLAY_NAME_FILES = `\`${LOGIN_FLOW}\`,\n\`${USER}\`\n`;
const DISPLAY_NAME_WHY = "**Why no seam:** `loginOrCreateViaGatekeeper`";
const POPUPLESS_HEADING = "## `fabric-popupless-signin` — LANDED 2026-09-17\n";

const patchCommit = (commit: string, id: string, files: string[], changed = files): Commit =>
  ({ commit, merge: false, id, files, changed });
const plainCommit = (commit: string, ...changed: string[]): Commit =>
  ({ commit, merge: false, id: null, files: [], changed });
const mergeCommit = (commit: string): Commit => ({ commit, merge: true, id: null, files: [], changed: [] });

const DISPLAY_NAME = patchCommit("09fe09f1", "fabric-display-name", [LOGIN_FLOW, USER], [
  "PATCHES.md", "packages/workshop-backend/__tests__/fabric-display-name.test.ts", LOGIN_FLOW, USER,
]);
const POPUPLESS = patchCommit("00d4a845", "fabric-popupless-signin", [LOGIN_FLOW, SERVER, API], [
  "PATCHES.md", "packages/workshop-backend/__tests__/fabric-popupless-signin.test.ts", LOGIN_FLOW, SERVER, API,
]);

const HISTORY: Commit[] = [
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

// --- The checks the gate has always made ---------------------------------------------------------

test("reads landed and planned entries, with their **Files:** and **High-churn:** lines", () => {
  assert.deepEqual(parseLedger(LEDGER), {
    errors: [],
    entries: [
      { id: "fabric-entitlements", landed: false, files: [USAGE_CHECKER], highChurn: [] },
      { id: "fabric-user-lifecycle", landed: false, files: ["packages/workshop-backend/src/user-directory.ts", USER], highChurn: [] },
      { id: "fabric-display-name", landed: true, files: [LOGIN_FLOW, USER], highChurn: [] },
      { id: "fabric-popupless-signin", landed: true, files: [LOGIN_FLOW, SERVER, API], highChurn: [SERVER, API] },
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
  const { errors } = run({ markdown: `${LEDGER_TITLE}\n\n## \`fabric-entitlements\` — NOT YET LANDED\n` });
  assertRefused(errors, /fabric-display-name is shipped but has no "LANDED" section/);
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
    markdown: edit(LEDGER, "## `fabric-entitlements` — NOT YET LANDED", "## `fabric-entitlements` — LANDED 2026-09-18"),
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
const NO_SNEAK_SECTION = /fabric-sneak is shipped but has no "LANDED" section/;
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
    assertRefused(errors, /unusual line or paragraph separator/);
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
    "## `fabric-sneak` — LANDED 2026-09-18 ",
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

test("refuses a PATCH-ID on a merge commit, whose own diff the gate does not read", () => {
  const commits = HISTORY.map((commit) =>
    (commit.commit === "d82ccb92" ? { ...commit, id: "fabric-popupless-signin", files: [SERVER] } : commit));
  assertRefused(run({ commits }).errors, /fabric-popupless-signin \(d82ccb92\) carries PATCH-ID on a merge commit/);
});
