import type { AgentTurnResult } from "@gadgets/integration-tests/agent-session";
import { Deadline, runWithCleanup } from "@gadgets/integration-tests/deadline";
import type { AiChatMessage } from "@gadgets/workshop-shared/api";
import { createHarness, type JsonValue } from "vitest-evals";
import { EVAL_OVERHEAD_BUDGET_MS, EVAL_RUN_BUDGET_MS, type EvalIdentity } from "./config.js";
import type { EvalRunInput, EvalRunOutput, EvalTask, EvalTurnResult } from "./task.js";
import { measureHistory, toTranscriptEvents } from "./transcript.js";
import { openWorkshopTarget } from "./target.js";
import type { WorkshopTarget } from "./target.js";
import { EvalVerifier } from "./verifier.js";

/** Adapt one real Workshop task to the generic vitest-evals harness contract. */
export function createWorkshopHarness(
    task: EvalTask, target: WorkshopTarget, identity: EvalIdentity, gatesRun: boolean) {
  return createHarness<EvalRunInput, EvalRunOutput>({
    name: "workshop-agent",
    run: async ({ input, signal }) => {
      const startedAt = Date.now();
      const runDeadline = Deadline.after(EVAL_RUN_BUDGET_MS);
      const opened = await openWorkshopTarget(
          target, input.model, runDeadline, EVAL_OVERHEAD_BUDGET_MS);

      return runWithCleanup(async () => {
        const turns: EvalTurnResult[] = [];
        let history: AiChatMessage[] = [];
        let usage: AgentTurnResult["usage"] = {};

        for (const turn of task.turns) {
          const agentStartedAt = Date.now();
          const result = await opened.session.run(turn.prompt, signal, runDeadline);
          const agentDurationMs = Date.now() - agentStartedAt;
          ({ history } = result);
          usage = result.usage;

          const verificationStartedAt = Date.now();
          const verifier = new EvalVerifier(
              opened.session, result.workpieces, runDeadline);
          turns.push({
            checks: await verifier.collect(turn.verify),
            agentDurationMs,
            verificationDurationMs: Date.now() - verificationStartedAt,
          });
        }

        const { toolCalls, ...metrics } = measureHistory(history);
        const usageMetadata: Record<string, JsonValue> = {};
        if (usage.lastStepTokens !== undefined) usageMetadata.lastStepTokens = usage.lastStepTokens;
        if (usage.titleTokens !== undefined) usageMetadata.titleTokens = usage.titleTokens;
        if (usage.agentChatCostUsd !== undefined) {
          usageMetadata.agentChatCostUsd = usage.agentChatCostUsd;
        }
        if (usage.titleCostUsd !== undefined) usageMetadata.titleCostUsd = usage.titleCostUsd;
        return {
          output: { turns, metrics },
          events: toTranscriptEvents(history),
          usage: {
            provider: "cloudflare",
            model: input.model,
            toolCalls,
            metadata: usageMetadata,
          },
          timings: { totalMs: Date.now() - startedAt },
          errors: history.flatMap(message =>
            message.type === "error" ? [{ name: "AgentError", message: message.message }] : []),
          metadata: {
            taskId: task.id,
            gatesRun,
            target: target.kind,
            ...identity,
          },
        };
      }, opened.close);
    },
  });
}
