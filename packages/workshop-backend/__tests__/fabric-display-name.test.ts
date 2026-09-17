// DOWNSTREAM (fabric): gatekeeper-supplied display name. Covers PATCH-ID fabric-display-name.
//
// Upstream seeds a new account's display name from the identity string's local-part, which assumes
// that string is an email address. This distro keys accounts on an opaque, stable WorkOS user id
// instead -- so an email change cannot strand a user in a new, empty workspace, and the personal
// identifier stays out of the Durable Object name. An opaque id has no local-part, so without the
// patch every account is created named "user_01KG8V3HVEF295G2GVXSVHBCA5".
//
// The patch is deliberately optional: callers that pass no name keep upstream's exact behaviour,
// which is what keeps it a small, re-derivable diff across merges.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { UserDurableObject } from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

type UserInternals = UserDurableObject & {
  storage: { profile: { get(): { name?: string; id?: string } | undefined } };
};

const PRINCIPAL = "user_01KG8V3HVEF295G2GVXSVHBCA5";

async function profileAfterLogin(
  name: string, principal: string, displayName?: string,
): Promise<{ name?: string; id?: string } | undefined> {
  const id = env.TEST_USER.idFromName(name);
  const stub = env.TEST_USER.get(id);
  // Signature is (identity, allowCreate, displayName?) after the patch.
  await (stub as unknown as {
    loginOrCreateViaGatekeeper(i: string, a: boolean, d?: string): Promise<string | null>;
  }).loginOrCreateViaGatekeeper(principal, true, displayName);
  return runInDurableObject(stub, (instance) => (instance as UserInternals).storage.profile.get());
}

describe("gatekeeper-supplied display name", () => {
  it("uses the name the gatekeeper supplied", async () => {
    const profile = await profileAfterLogin("supplied", PRINCIPAL, "Chris Beard");
    expect(profile?.name).toBe("Chris Beard");
  });

  it("keys the account on the principal regardless of the display name", async () => {
    // The display name is cosmetic; the identity must remain the opaque principal.
    const profile = await profileAfterLogin("keyed", PRINCIPAL, "Chris Beard");
    expect(profile?.id).toBe(PRINCIPAL);
  });

  it("falls back to upstream's behaviour when no name is supplied", async () => {
    // What keeps this patch small: absent the argument, nothing about upstream changes.
    const profile = await profileAfterLogin("absent", "someone@example.com");
    expect(profile?.name).toBe("someone");
  });

  it("falls back rather than accepting a blank name", async () => {
    // A gatekeeper that returns "" or "   " must not produce a nameless account.
    const profile = await profileAfterLogin("blank", "someone@example.com", "   ");
    expect(profile?.name).toBe("someone");
  });

  it("does not leave an opaque principal as the display name", async () => {
    // The regression this patch exists to prevent, stated as its own assertion.
    const profile = await profileAfterLogin("regression", PRINCIPAL, "Chris Beard");
    expect(profile?.name).not.toBe(PRINCIPAL);
    expect(profile?.name).not.toMatch(/^user_[0-9A-Z]{20,}$/);
  });
});
