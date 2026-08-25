import { afterEach, expect, it, vi } from "vitest";
import { Deadline } from "../src/deadline.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}

const fakes = vi.hoisted(() => {
  const authenticated = {
    [Symbol.dispose]: vi.fn(),
    completeOnboarding: vi.fn(() => Promise.resolve()),
    isOnboardingCompleted: vi.fn(() => Promise.resolve(true)),
    listModels: vi.fn(() => Promise.resolve([{ type: "agent", id: "model", name: "Model" }])),
    listOutputFormats: vi.fn(() => Promise.resolve([{}])),
    newGadget: vi.fn(),
    setPreferredModel: vi.fn(() => Promise.resolve()),
  };
  const overseer = {
    [Symbol.dispose]: vi.fn(),
    deleteSelf: vi.fn(() => Promise.resolve()),
    getChatHistory: vi.fn(() => Promise.resolve({ messages: [] })),
    listChats: vi.fn(() => Promise.resolve([{
      id: 7,
      title: "Built",
      started: new Date(0),
      lastActive: new Date(1),
      totalTokens: 123,
      totalCost: 0.45,
      titleTokens: 12,
      titleCost: 0.01,
    }])),
    newChat: vi.fn(() => new Promise<number>(() => {})),
    stopAgent: vi.fn(() => Promise.resolve()),
    subscribeToWorkpieces: vi.fn((subscriber: { ready(): void }) => {
      subscriber.ready();
      return Promise.resolve({ [Symbol.dispose]: vi.fn() });
    }),
    waitForAgentTurn: vi.fn(() => Promise.resolve()),
  };
  authenticated.newGadget.mockResolvedValue(overseer);
  return {
    authenticated,
    overseer,
    publicApi: { [Symbol.dispose]: vi.fn() },
  };
});

vi.mock("../src/rpc-client.js", () => ({
  RpcTarget: class { readonly testTarget = true; },
  connect: () => fakes.publicApi,
  nextUsernames: () => ["agent1"],
  signUp: () => Promise.resolve(fakes.authenticated),
  stubFor: <T extends object>(target: T) =>
    Object.assign(target, { [Symbol.dispose]: vi.fn() }),
  waitFor: async <T>(_what: string, attempt: () => Promise<T | null>) => {
    const result = await attempt();
    if (result === null) throw new Error("test wait did not settle");
    return result;
  },
}));

import { AgentSession } from "../src/agent-session.js";

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

it("deletes a workspace when session setup reaches its deadline", async () => {
  vi.useFakeTimers();
  fakes.authenticated.listOutputFormats.mockReturnValueOnce(new Promise<never>(() => {}));
  const result = AgentSession.create(
      new URL("http://127.0.0.1:8787"), {}, Deadline.after(25), 25);
  const assertion = expect(result).rejects.toThrow("Timed out waiting for output formats");

  await vi.advanceTimersByTimeAsync(25);

  await assertion;
  expect(fakes.overseer.deleteSelf).toHaveBeenCalledOnce();
});

it("bounds the RPC that starts a turn and still permits workspace deletion", async () => {
  vi.useFakeTimers();
  const session = await AgentSession.create(new URL("http://127.0.0.1:8787"));
  const result = session.run("Build it", undefined, Deadline.after(25));
  const assertion = expect(result).rejects.toThrow("Timed out waiting for the agent turn to start");

  await vi.advanceTimersByTimeAsync(25);

  await assertion;
  await session.deleteWorkspace(Deadline.after(25));
  expect(fakes.overseer.deleteSelf).toHaveBeenCalledOnce();
});

it("waits for the server to finish queued callback turns", async () => {
  const serverCompletion = deferred<void>();
  fakes.overseer.newChat.mockResolvedValueOnce(7);
  fakes.overseer.waitForAgentTurn.mockReturnValueOnce(serverCompletion.promise);
  const session = await AgentSession.create(new URL("http://127.0.0.1:8787"));
  const result = session.run("Build it", undefined, Deadline.after(1_000));
  let settled = false;
  void result.then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);

  serverCompletion.resolve();

  await expect(result).resolves.toMatchObject({
    history: [],
    usage: {
      lastStepTokens: 123,
      agentChatCostUsd: 0.45,
      titleTokens: 12,
      titleCostUsd: 0.01,
    },
  });
  expect(fakes.overseer.waitForAgentTurn).toHaveBeenCalledWith(7);
  await session.deleteWorkspace(Deadline.after(25));
});
