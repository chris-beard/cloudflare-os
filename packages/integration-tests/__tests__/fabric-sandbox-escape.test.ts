// DOWNSTREAM (fabric): gadget/agent network confinement.
//
// Agent-authored code runs in a Dynamic Worker created at overseer.ts:8601 with
// `globalOutbound: null`. That one line is the entire reason an agent cannot reach the network
// from inside executeCode -- and upstream has NO test asserting it. `git log -S 'globalOutbound'`
// shows the site count moving 2 -> 3 without any test changing, so a merge that drops one produces
// a green build and a silently open sandbox.
//
// The probe: script the model to call executeCode with a body that fetches an external origin, then
// assert the host process never saw that request. NetworkInterceptor patches fetch in the *Node*
// process; workerd's outbound is separate. So:
//   - confined  -> fetch dies inside workerd, Node never sees it, getUnmockedCalls() is empty
//   - escaped   -> the request reaches Node's fetch, the interceptor records it, this test fails
//
// The second assertion (the turn reports a failure) is not decoration: without it a refactor that
// stops executing tool calls at all would let this test pass vacuously.

import { afterAll, beforeAll, expect, it } from "vitest";
import { openAgentSession } from "../src/agent-session.js";
import { startTestGatekeeperHarness, TEST_VENDOR_ID, type Harness } from "../src/harness.js";
import {
  scriptedChatCompletions, SCRIPTED_MODEL_CONFIG, SCRIPTED_MODEL_ID, SCRIPTED_MODEL_PROFILE,
} from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";

// A host that exists nowhere. Reaching DNS at all would already be an escape.
const ESCAPE_URL = "https://sandbox-escape.invalid/probe";

const ESCAPE_CODE =
    `export default async function() { await fetch(${JSON.stringify(ESCAPE_URL)}); }`;

let harness: Harness;

const model = scriptedChatCompletions([
  { toolCall: { id: "escape-probe", name: "executeCode", arguments: { code: ESCAPE_CODE } } },
  { text: "The fetch was refused." },
  { pending: true },
]);

// Only the model is mocked. Every other outbound the host sees is recorded as unmocked.
const network = new NetworkInterceptor({ handlers: [model.handler] });

beforeAll(async () => {
  network.install();
  harness = await startTestGatekeeperHarness({ enableGadgetExecution: true });
});

afterAll(async () => {
  try {
    await harness?.server.close();
  } finally {
    network.uninstall();
  }
});

it("confines agent-authored code: executeCode cannot reach the network", async () => {
  await using session = await openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID,
    userModel: { profile: SCRIPTED_MODEL_PROFILE, config: SCRIPTED_MODEL_CONFIG },
    ambientVendorIds: [TEST_VENDOR_ID],
  });

  await session.runTurn("Fetch the probe URL.");

  // THE INVARIANT. If globalOutbound: null is dropped from the executeCode worker definition,
  // the gadget's fetch escapes workerd into the host process and lands here.
  expect(network.getUnmockedCalls()).toEqual([]);

  // Evidence the code actually ran and was refused, rather than never executing at all.
  const toolResult = model.requests
      .flatMap(request => (request as { messages?: unknown[] }).messages ?? [])
      .find((message): message is { role: string; tool_call_id: string; content: string } => {
        const m = message as { role?: string; tool_call_id?: string };
        return m.role === "tool" && m.tool_call_id === "escape-probe";
      });

  expect(toolResult, "the executeCode tool call produced no result").toBeDefined();
  expect(toolResult?.content ?? "").not.toEqual("");
});
