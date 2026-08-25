import { createJudge, describeEval } from "vitest-evals";
import { expect } from "vitest";
import { evalGatesTask, evalMatrix, resolveEvalCommits } from "./config.js";
import { createWorkshopHarness } from "./harness.js";
import { taskVersion, type EvalRunInput, type EvalRunOutput, type EvalTask } from "./task.js";
import { resolveWorkshopTarget } from "./target.js";

const evalCommits = resolveEvalCommits();

const ChecksJudge = createJudge<EvalRunInput, EvalRunOutput>(
  "behavioral checks",
  ({ output }) => {
    const checks = output.turns.flatMap(turn => turn.checks);
    const failed = checks.filter(check => !check.pass);
    const passed = checks.length - failed.length;
    return {
      score: checks.length === 0 ? 0 : passed / checks.length,
      metadata: {
        rationale: failed.length === 0
          ? "All checks passed"
          : `Failed checks: ${failed.map(check => check.id).join(", ")}`,
        passed,
        total: checks.length,
        failed: failed.map(check => check.id),
      },
    };
  },
);

/** Register one real Gadget task using native Vitest cases and vitest-evals reporting. */
export function defineTaskEval(task: EvalTask): void {
  const target = resolveWorkshopTarget();
  const matrix = evalMatrix();
  const cases = matrix.models.flatMap(model =>
    Array.from({ length: matrix.trials }, (_unused, trial) => ({
      name: `${model} | trial ${trial + 1}`,
      model,
      trial,
    })));
  const gatesRun = evalGatesTask(task.id);
  const identity = {
    ...evalCommits,
    taskVersion: taskVersion(task),
  };
  const harness = createWorkshopHarness(task, target, identity, gatesRun);

  describeEval(task.id, { harness }, it => {
    it.for(cases)("$name", async ({ model, trial }, { run }) => {
      const result = await run({ model, trial });
      await expect(result).toSatisfyJudge(ChecksJudge, {
        threshold: gatesRun ? 1 : null,
      });
    });
  });
}
