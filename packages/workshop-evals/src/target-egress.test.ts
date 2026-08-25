import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Deadline } from "@gadgets/integration-tests/deadline";

const fakes = vi.hoisted(() => ({
  requestUrls: [] as string[],
  responseStatuses: [] as number[],
  session: { [Symbol.dispose]: vi.fn() },
  server: { close: vi.fn(() => Promise.resolve()) },
}));

vi.mock("@gadgets/integration-tests/agent-session", () => ({
  AgentSession: { create: vi.fn(() => Promise.resolve(fakes.session)) },
}));

vi.mock("@gadgets/integration-tests/harness", () => ({
  startHarness: vi.fn(async () => {
    for (const url of fakes.requestUrls) fakes.responseStatuses.push((await fetch(url)).status);
    return {
      url: new URL("http://127.0.0.1:8787"),
      server: fakes.server,
    };
  }),
}));

import { openWorkshopTarget, type WorkshopTarget } from "./target.js";

const realFetch = globalThis.fetch;

beforeEach(() => {
  fakes.requestUrls = [];
  fakes.responseStatuses = [];
  globalThis.fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.clearAllMocks();
});

it("allows only the direct Workers AI OpenAI-compatible route", async () => {
  fakes.requestUrls = [
    "https://api.cloudflare.com/client/v4/accounts/account-id/ai/v1/chat/completions",
  ];
  const target: WorkshopTarget = {
    kind: "local",
    modelAccess: { kind: "direct", accountId: "account-id", apiToken: "token" },
  };

  const opened = await openWorkshopTarget(target, "@cf/model", Deadline.none(), 25);
  await opened.close();

  expect(globalThis.fetch).toHaveBeenCalledOnce();
  expect(fakes.responseStatuses).toEqual([204]);
});

it("allows AI Gateway inference and cost-log routes", async () => {
  fakes.requestUrls = [
    "https://gateway.ai.cloudflare.com/v1/account-id/gateway/workers-ai/@cf/model",
    "https://api.cloudflare.com/client/v4/accounts/account-id/ai-gateway/gateways/gateway/logs/log-id",
  ];
  const target: WorkshopTarget = {
    kind: "local",
    modelAccess: {
      kind: "gateway",
      gateway: "gateway",
      accountId: "account-id",
      apiToken: "token",
    },
  };

  const opened = await openWorkshopTarget(target, "@cf/model", Deadline.none(), 25);
  await opened.close();

  expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  expect(fakes.responseStatuses).toEqual([204, 204]);
});

it("returns a deterministic denial for every other outbound route", async () => {
  fakes.requestUrls = ["https://example.com/collect"];
  const target: WorkshopTarget = {
    kind: "local",
    modelAccess: { kind: "direct", accountId: "account-id", apiToken: "token" },
  };

  const opened = await openWorkshopTarget(target, "@cf/model", Deadline.none(), 25);
  await opened.close();

  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(fakes.responseStatuses).toEqual([403]);
});
