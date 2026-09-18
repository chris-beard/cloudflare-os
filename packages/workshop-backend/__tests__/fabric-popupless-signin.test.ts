// Covers the `fabric-popupless-signin` patch: PendingLogin.redeem, which releases the session token
// to a caller holding both the ticket and the flow's nonce.
//
// A new file on purpose. This fork's patches keep their tests out of upstream's test files, so a
// patch adds conflict surface only where its behaviour lives. See PATCHES.md.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { PendingLogin } from "../src/auth/login-flow.js";
import { newSecretToken } from "../src/connect-handoff.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_PENDING_LOGIN: DurableObjectNamespace<PendingLogin>;
  }
}

let counter = 0;
const fresh = () => env.TEST_PENDING_LOGIN.getByName(`fabric-popupless-${++counter}`);

// Reported as values: a native RPC promise left to `.rejects` is also flagged as an unhandled
// rejection by the pool.
async function redeem(stub: DurableObjectStub<PendingLogin>, ticket: string): Promise<string> {
  try {
    return `token:${await stub.redeem(ticket)}`;
  } catch (err) {
    return `error:${(err as Error).message}`;
  }
}

async function receive(stub: DurableObjectStub<PendingLogin>): Promise<string> {
  try {
    const token = await stub.receive();
    return token === null ? "null" : `token:${token}`;
  } catch (err) {
    return `error:${(err as Error).message}`;
  }
}

const EXPIRED = "error:This sign-in attempt has expired. Please try again.";

describe("PendingLogin.redeem", () => {
  it("releases the token to a caller that holds both the ticket and the nonce", async () => {
    // The popup-less path: one call confirms and receives, because there is no second window to
    // split the two secrets across.
    const stub = fresh();
    await stub.begin();
    const { secret, hash } = await newSecretToken();
    await stub.deliver("alice@example.com:session", hash);

    expect(await redeem(stub, secret.toHex())).toBe("token:alice@example.com:session");
    // Single use, and the attempt is spent: a popup racing this one collects nothing.
    expect(await redeem(stub, secret.toHex())).toBe(EXPIRED);
    expect(await receive(stub)).toBe(EXPIRED);
    await runInDurableObject(stub, async (instance: PendingLogin) => {
      expect([...instance.ctx.storage.kv.list()]).toEqual([]);
    });
  });

  it("refuses a wrong or malformed ticket without spending the result", async () => {
    // Naming the attempt is not redeeming it: the nonce finds the object, the ticket proves the
    // flow finished. A guess must not consume what the right ticket is about to redeem.
    const stub = fresh();
    const { secret, hash } = await newSecretToken();
    await stub.deliver("alice@example.com:session", hash);

    const wrong = await newSecretToken();
    expect(await redeem(stub, wrong.secret.toHex())).toBe(EXPIRED);
    expect(await redeem(stub, "not-a-ticket")).toBe(EXPIRED);
    expect(await redeem(stub, secret.toHex())).toBe("token:alice@example.com:session");
  });

  it("refuses an attempt the gatekeeper has not answered yet", async () => {
    const stub = fresh();
    await stub.begin();
    const { secret } = await newSecretToken();
    expect(await redeem(stub, secret.toHex())).toBe(EXPIRED);
  });
});
