// DOWNSTREAM (fabric): tests for the patch ledger gate. Pure -- no git, no repo state.

import assert from "node:assert/strict";
import test from "node:test";
import { checkLedger, parseLedger, type Diverged, type Trailer } from "./fabric-patch-ledger.ts";

const LEDGER = `
## \`fabric-entitlements\` — NOT YET LANDED
## \`fabric-user-lifecycle\` — NOT YET LANDED
## \`fabric-display-name\` — LANDED 2026-09-17
`;

const PATCH: Trailer = {
  commit: "09fe09f1",
  id: "fabric-display-name",
  files: [
    "packages/workshop-backend/src/auth/login-flow.ts",
    "packages/workshop-backend/src/user.ts",
  ],
};

const TODAY: Diverged[] = [
  { status: "A", path: ".github/workflows/fabric-ci.yml" },
  { status: "A", path: "PATCHES.md" },
  { status: "A", path: "packages/workshop-backend/__tests__/fabric-display-name.test.ts" },
  { status: "M", path: "packages/workshop-backend/src/auth/login-flow.ts" },
  { status: "M", path: "packages/workshop-backend/src/user.ts" },
];

function run(diverged = TODAY, trailers = [PATCH], markdown = LEDGER) {
  return checkLedger({ diverged, trailers, ledger: parseLedger(markdown) });
}

test("reads landed and planned entries from PATCHES.md", () => {
  assert.deepEqual(parseLedger(LEDGER), [
    { id: "fabric-entitlements", landed: false, highChurn: [] },
    { id: "fabric-user-lifecycle", landed: false, highChurn: [] },
    { id: "fabric-display-name", landed: true, highChurn: [] },
  ]);
});

test("passes when every divergence is downstream-only or claimed by a recorded patch", () => {
  assert.deepEqual(run(), { errors: [], warnings: [] });
});

test("fails on a kernel edit no patch claims", () => {
  const { errors } = run([...TODAY, {
    status: "M", path: "packages/workshop-backend/src/sharing.ts",
  }]);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /sharing\.ts differs from upstream but no PATCH-ID commit claims it/);
});

test("fails when a patch ships without a PATCHES.md explanation", () => {
  const { errors } = run(TODAY, [PATCH], "## `fabric-entitlements` — NOT YET LANDED");
  assert.ok(errors.some((error) => /fabric-display-name is shipped but has no "LANDED" section/.test(error)));
});

test("fails when PATCHES.md claims a patch nothing shipped", () => {
  const { errors } = run(TODAY, [], LEDGER);
  assert.ok(errors.some((error) => /marks fabric-display-name LANDED but no commit carries/.test(error)));
});

test("fails when a shipped patch is still marked NOT YET LANDED", () => {
  const entitlements: Trailer = {
    commit: "abc12345", id: "fabric-entitlements",
    files: ["packages/workshop-backend/src/ai-gateway-billing/limits/usage-checker.ts"],
  };
  const { errors } = run(
    [...TODAY, { status: "M", path: entitlements.files[0]! }], [PATCH, entitlements]);
  assert.ok(errors.some((error) => /fabric-entitlements is shipped .* still says NOT YET LANDED/.test(error)));
});

test("refuses an eleventh patch even while it is only planned, and accepts the tenth", () => {
  const planned = (count: number) =>
    Array.from({ length: count }, (_, n) => `## \`fabric-planned-${n}\` — NOT YET LANDED`).join("\n");
  // LEDGER records three, so seven more planned make ten and eight make eleven.
  assert.deepEqual(run(TODAY, [PATCH], `${LEDGER}\n${planned(7)}\n`).errors, []);
  const { errors } = run(TODAY, [PATCH], `${LEDGER}\n${planned(8)}\n`);
  assert.ok(errors.some((error) => /records 11 patches .* ceiling is 10/.test(error)));
});

const GOD_FILE = "packages/workshop-backend/src/overseer.ts";
const GOD_PATCH: Trailer = { ...PATCH, files: [...PATCH.files, GOD_FILE] };
const WITH_GOD_FILE: Diverged[] = [...TODAY, { status: "M", path: GOD_FILE }];

test("refuses a patch to a high-churn file its own PATCHES.md entry does not acknowledge", () => {
  const { errors } = run(WITH_GOD_FILE, [GOD_PATCH]);
  assert.ok(errors.some((error) => /overseer\.ts, a high-churn kernel file, but its own PATCHES\.md entry/.test(error)));
});

test("accepts a high-churn file only on the patch's own **High-churn:** line", () => {
  const own = LEDGER.replace("LANDED 2026-09-17", `LANDED 2026-09-17\n\n**High-churn:** \`${GOD_FILE}\``);
  assert.deepEqual(run(WITH_GOD_FILE, [GOD_PATCH], own), { errors: [], warnings: [] });
  // Named under a DIFFERENT patch's entry, it acknowledges nothing for this one.
  const elsewhere = LEDGER.replace(
    "## `fabric-user-lifecycle` — NOT YET LANDED",
    `## \`fabric-user-lifecycle\` — NOT YET LANDED\n**High-churn:** \`${GOD_FILE}\``);
  assert.ok(run(WITH_GOD_FILE, [GOD_PATCH], elsewhere).errors.some((error) => /high-churn kernel file/.test(error)));
  // Mentioned anywhere but the **High-churn:** line, it acknowledges nothing either.
  const inProse = LEDGER.replace("LANDED 2026-09-17", `LANDED 2026-09-17\n\nThis touches \`${GOD_FILE}\`.`);
  assert.ok(run(WITH_GOD_FILE, [GOD_PATCH], inProse).errors.some((error) => /high-churn kernel file/.test(error)));
});

test("refuses a patch with no FILES trailer", () => {
  const { errors } = run(TODAY.filter((entry) => entry.status === "A"), [{ ...PATCH, files: [] }]);
  assert.ok(errors.some((error) => /has no FILES trailer/.test(error)));
});

test("refuses a downstream-only path that upstream also has", () => {
  // A fabric-* file that upstream created would be modified rather than added, and so conflict.
  const { errors } = run(TODAY.map((entry) =>
    entry.path === "PATCHES.md" ? { ...entry, status: "M" } : entry));
  assert.ok(errors.some((error) => /PATCHES\.md is a downstream-only path but upstream has it too/.test(error)));
});

test("warns, without failing, when upstream has absorbed a patched file", () => {
  const { errors, warnings } = run(
    TODAY.filter((entry) => !entry.path.endsWith("/user.ts")));
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((warning) => /user\.ts, which no longer differs from upstream/.test(warning)));
});
