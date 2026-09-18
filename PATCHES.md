# Downstream patches

Every commit on `distro` that modifies an upstream file is recorded here and carries a matching
`PATCH-ID` trailer. CI asserts the two agree, and that `git diff --name-only upstream-main...distro`
lists nothing but these files plus new-file-only paths.

**The budget is three. It is currently full.** A fourth patch, or any patch landing in
`overseer.ts`, `agent.ts`, `server.ts`, `ai-models.ts`, `workshop-shared/src/api.ts` or
`workshop-frontend/`, is the documented signal to stop and re-scope — at that point this is not a
fork with patches, it is an unfunded rewrite of someone else's kernel.

> **That signal has fired.** `fabric-popupless-signin` (2026-09-17) is the fourth patch and lands in
> two of the named files, `server.ts` and `workshop-shared/src/api.ts`. It was authorised
> deliberately, for a reason recorded in its entry below, and the budget question it raises is open
> rather than settled: either this replaces one of the two unlanded patches, or the budget is
> larger than three and should say so. Do not treat this precedent as the rule relaxing by itself.

Why so strict: upstream refuses outside contributions (CONTRIBUTING.md) and closed an outside
security report unmerged, so every line here is permanent divergence with no upstream path. Upstream
also rewrote 77–83% of its hottest kernel files in a four-week window, so a patch's cost is not its
size but how often the code under it moves.

Each entry states what no seam reaches, because "could this have been a wrapper?" is the question to
re-ask on every merge.

---

## `fabric-entitlements` — NOT YET LANDED

**Files:** `packages/workshop-backend/src/ai-gateway-billing/limits/usage-checker.ts`

**Why no seam:** `checkUsageAndBalance` is a static import in `overseer.ts`; the entitlement source
is hardcoded to the vendor id `"cloudflare"` (`user.ts:93,687`) and `api.cloudflare.com`
(`cloudflare/account-service.ts:12`). No binding, no interface, no env-selected provider.

**Shape:** one guarded early return behind `env.FABRIC_ENTITLEMENTS`, above upstream's untouched
Cloudflare branch. All logic in a new, never-conflicting `src/fabric/entitlements.ts`. `overseer.ts`
is touched zero times — it already calls the function and consumes only
`{allowed, reason, shouldUseByok, byokRouting}`.

**Review if:** any non-empty diff under `packages/workshop-backend/src/ai-gateway-billing/`, or
`overseer.ts:7108-7133` changes shape. Low churn here proves little — the whole subsystem is 5
commits old and sits on upstream's active billing frontier. Expect to rewrite it from scratch the
day Cloudflare ships real billing.

---

## `fabric-user-lifecycle` — NOT YET LANDED

**Files:** `packages/workshop-backend/src/user-directory.ts`, `packages/workshop-backend/src/user.ts`

**Why no seam:** `user-directory.ts` contains no delete of any kind — erasure is not merely
unimplemented, it is inexpressible. `UserDurableObject` has no `purgeSelf`.

**Review if:** either file changes shape, particularly the directory's storage layout.

---

## `fabric-display-name` — LANDED 2026-09-17

**Files:** `packages/workshop-backend/src/auth/login-flow.ts`,
`packages/workshop-backend/src/user.ts`

**Why no seam:** `loginOrCreateViaGatekeeper` seeds a new account's display name from
`email.split("@")[0]`, and nothing lets a gatekeeper influence it. `AccountDescription.displayName`
already exists and every vendor implements it, but core never asks for it on the login path.

**Why it was needed:** this distro keys accounts on an opaque, stable WorkOS user id rather than an
email, so that changing an email cannot strand a user in a new empty workspace, a tenant dimension
can be added without migrating every Durable Object, and the personal identifier stays out of the DO
name, the session-token prefix, the directory row and `cf-aig-metadata.user`. An opaque id has no
local-part, so without this every account is created named `user_01KG8V3HVEF295G2GVXSVHBCA5`.

**Shape:** `#deliver` additionally calls `account.describe()` and passes `displayName` through; the
argument is optional and a missing, blank or failed name falls back to upstream's exact behaviour.
~31 lines across two files, the larger half in `auth/` — 3 commits in 6 weeks, among the coldest
directories in the repo.

**Review if:** `loginOrCreateViaGatekeeper`'s signature changes, `#deliver` stops calling
`getAuthenticatedEmail`, or `AccountDescription` drops `displayName`.

**Covered by:** `packages/workshop-backend/__tests__/fabric-display-name.test.ts`. Verified to fail
without the patch — 2 of its 5 cases go red, while the three fallback cases stay green because they
assert upstream's own behaviour.

**Deliberately not patched:** the profile avatar. `AccountDescription.avatar` is a `{url}`, but the
user avatar is an uploaded image in KV — a different mechanism — so auto-populating it would put an
external fetch on the sign-in path. A blank avatar is an ordinary state; this is not worth a patch.

---

## `fabric-popupless-signin` — LANDED 2026-09-17

**Files:** `packages/workshop-backend/src/auth/login-flow.ts`,
`packages/workshop-backend/src/server.ts`, `packages/workshop-shared/src/api.ts`

**Why no seam:** the session token is minted inside the kernel and released only by
`LoginAttempt.receive()`, on an `RpcTarget` constructed per attempt and returned over the live Cap'n
Web connection (`server.ts:715`). It is deliberately unaddressable — "the client redeems the login
result through a capability rather than a guessable id" — so nothing outside the kernel can reach a
token, and `confirmLogin` (the one call a session-less page can make) returns `void`. A deployment
cannot add a redemption path from its own code.

**Why it was needed:** sign-in did not work at all in a browser embedded in another application — an
in-app browser, a desktop app's web pane — because `window.open()` returns null there for a genuine
user click, with no pop-up setting the user can allow. Measured in one such pane on 2026-09-17, with
the deployed bundle verified byte-identical to a build that opens the popup inside the gesture. The
pop-up is not the identity provider's requirement: WorkOS's own SDKs never call `window.open` —
AuthKit signs in with a full-page redirect and finishes with a cookie — and their Electron SDK
defaults to handing off to the system browser precisely to keep OAuth out of embedded webviews.

**Shape:** `PendingLogin.redeem(ticket)` confirms and releases in one step, ~8 lines beside the
existing `confirm`/`receive` pair it is built from; `PublicApiImpl.redeemLogin(ticket, nonce)` is the
same nonce→object lookup `confirmLogin` already does; `api.ts` gains one method. The popup path is
untouched and still preferred, because splitting the two secrets across two windows is what stops the
window touring the provider's pages from ever holding a token. The fallback requires BOTH secrets,
which is the pairing public OAuth clients already rely on: the ticket arrives in the URL like an
authorization code, the nonce waits in the tab's own sessionStorage like a PKCE verifier and never
travels.

**Review if:** `PendingLogin`'s result shape or `#result()` changes, `confirmLogin`'s lookup changes,
or upstream adds a redirect-based sign-in — which would retire this patch outright.

**Covered by:** `packages/workshop-backend/__tests__/fabric-popupless-signin.test.ts` (a new file, so
it adds no conflict surface): the release, a wrong ticket refused without spending the result, and an
attempt the gatekeeper has not answered.

**Budget note:** this is the fourth patch and touches two files the rule above names. See the callout
at the top — the question of what gives way is open.
