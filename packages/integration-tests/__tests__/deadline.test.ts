import { afterEach, describe, expect, it, vi } from "vitest";
import { Deadline, runWithCleanup } from "../src/deadline.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("Deadline", () => {
  it("bounds an operation by the shared absolute deadline", async () => {
    vi.useFakeTimers();
    const deadline = Deadline.after(50);
    const result = deadline.run("a stuck operation", () => new Promise<never>(() => {}));
    const assertion = expect(result).rejects.toThrow("Timed out waiting for a stuck operation");

    await vi.advanceTimersByTimeAsync(50);

    await assertion;
  });

  it("does not restart the budget for later operations", async () => {
    vi.useFakeTimers();
    const deadline = Deadline.after(50);
    await vi.advanceTimersByTimeAsync(30);
    const result = deadline.run("the second operation", () => new Promise<never>(() => {}));
    const assertion = expect(result).rejects.toThrow("Timed out waiting for the second operation");

    await vi.advanceTimersByTimeAsync(20);

    await assertion;
  });
});

describe("runWithCleanup", () => {
  it("preserves the trial failure when cleanup also fails", async () => {
    const trialError = new Error("trial failed");
    const cleanupError = new Error("cleanup failed");

    const result = runWithCleanup(
        async () => { throw trialError; },
        async () => { throw cleanupError; });

    await expect(result).rejects.toMatchObject({
      errors: [trialError, cleanupError],
      message: "Trial failed, and cleanup also failed",
    });
  });
});
