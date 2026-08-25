import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiChatHistoryPage, AiChatMessage } from "@gadgets/workshop-shared/api";
import { AgentTurnCompletion, loadAllChatHistory } from "../src/agent-session-internals.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}


function message(sequence: number): AiChatMessage {
  return {
    chatId: 7,
    sequence,
    timestamp: new Date(sequence),
    author: { type: "user", id: "user", name: "User" },
    type: "message",
    message: String(sequence),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("AgentTurnCompletion", () => {
  it("settles only when the server reports the complete callback chain", async () => {
    const serverCompletion = deferred<void>();
    const completion = new AgentTurnCompletion(7, () => Promise.resolve(), 1_000);
    completion.follow(serverCompletion.promise);
    expect(completion.settled).toBe(false);

    serverCompletion.resolve();

    await expect(completion.promise).resolves.toBeUndefined();
  });


  it("stops the agent on timeout", async () => {
    vi.useFakeTimers();
    let stops = 0;
    const completion = new AgentTurnCompletion(
        7, () => { stops++; return Promise.resolve(); }, 100);
    await vi.advanceTimersByTimeAsync(100);

    await expect(completion.promise).rejects.toThrow("Timed out after 100ms");
    expect(stops).toBe(1);
  });

  it("stops the agent when cancelled", async () => {
    let stops = 0;
    const controller = new AbortController();
    const completion = new AgentTurnCompletion(
        7, () => { stops++; return Promise.resolve(); }, 1_000, controller.signal);
    controller.abort();

    await expect(completion.promise).rejects.toThrow("Agent turn was cancelled");
    expect(stops).toBe(1);
  });

  it("clears timers and abort listeners when disposed", () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const completion = new AgentTurnCompletion(
        7, () => Promise.resolve(), 1_000, controller.signal);
    completion.dispose();
    controller.abort();
    vi.runAllTimers();
    expect(completion.settled).toBe(false);
  });
});

it("loads history pages in authoritative ascending order", async () => {
  const pages = new Map<number | undefined, AiChatHistoryPage>([
    [undefined, { messages: [message(4), message(5)], compacted: { to: 4, summary: "tail" } }],
    [4, { messages: [message(2), message(3)], compacted: { to: 2, summary: "middle" } }],
    [2, { messages: [message(0), message(1)] }],
  ]);
  const history = await loadAllChatHistory(before => {
    const page = pages.get(before);
    if (!page) throw new Error(`No page for ${before}`);
    return Promise.resolve(page);
  });
  expect(history.map(entry => entry.sequence)).toEqual([0, 1, 2, 3, 4, 5]);
});

