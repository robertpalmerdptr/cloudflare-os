# Workshop agent evals

These evals run the production Workshop agent, execute the Gadget it creates, and verify the result
through the Gadget's real RPC.

The package uses the workerd and Cap'n Web helpers from `@gadgets/integration-tests`. `vitest-evals`
owns transcript normalization, scoring, reports, traces, and CI result reduction.

Eval definitions live in `evals/**/*.eval.ts`. Unit tests live in `src/**/*.test.ts`, so `pnpm test`
never calls a model. `pnpm evals` builds the repository and then runs the live evals without Vite+
task caching, which would strip the model credentials.

## Run locally

Use an existing AI Gateway configuration:

```sh
export CF_AI_GATEWAY=...
export CF_AI_GATEWAY_ACCOUNT_ID=...
export CF_AI_GATEWAY_API_TOKEN=...
pnpm evals
```

A Wrangler OAuth token can call Workers AI directly for local development:

```sh
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_API_TOKEN=...
pnpm evals
```

You can change the models, number of trials, and gating tasks:

```sh
export WORKSHOP_EVAL_MODELS='@cf/zai-org/glm-5.2,@cf/moonshotai/kimi-k2.7-code'
export WORKSHOP_EVAL_TRIALS=3
export WORKSHOP_EVAL_GATING_TASKS='appointment-desk,expense-ledger'
```

The defaults are both models, one trial, and every eval gating the run. Set
`WORKSHOP_EVAL_GATING_TASKS` to a comma-separated subset, or to an empty string for a reporting-only
run.

A **trial** is one complete run of one eval with one model. `WORKSHOP_EVAL_TRIALS=3` repeats every
model-and-eval pair three times. With three evals and two models, that produces 18 trials. The manual
workflow exposes the same value as its `trials` input.

A **turn** is one user request and all agent work it starts, including queued callback turns. Every
turn in an eval uses the same chat and workspace. A two-turn eval builds something, verifies it,
sends a follow-up request, and verifies the changed result. The report records the LLM turns and tool
calls the agent needed; the eval does not prescribe either count.

## Run against a preview

Provide the preview router URL and an Access application JWT for the user that runs the scenarios:

```sh
export WORKSHOP_EVAL_TARGET='https://pr123-branch-router.example.workers.dev'
export CF_ACCESS_TOKEN=...
pnpm evals
```

The preview supplies its model catalog and Workers AI binding. The runner uses the same prompts and
checks as a local run, but only local workerd runs can block network access outside the model routes.

The target commit defaults to the current checkout. Set `WORKSHOP_EVAL_TARGET_COMMIT` to the deployed
40-character Git SHA when the preview came from another revision.

## Inspect results

The run writes `.wrangler/evals/results.json` in this package. Open the report UI with:

```sh
pnpm evals:ui
```

For each trial, the report shows:

- requirements passed and pass rate across repeated trials
- total duration, agent time, and verification time
- LLM turns, tool calls, and tool errors
- agent and provider errors from the transcript
- tokens for the last agent step and automatic title, plus cumulative agent-chat cost and title cost,
  when the providers report them
- model, local or preview target, and trial number
- runner commit, target commit, and task version

`taskVersion` is a SHA-256 hash of the prompts. The runner commit identifies verifier and gating
changes without changing the task version. Scores come from code and RPC checks, not an LLM judge.

## CI

The **Workshop evals** workflow is manual-only. Start it with `workflow_dispatch`; leave models blank
to use the suite defaults, or provide a comma-separated override. It uses existing repository AI
Gateway credentials, native Vitest sharding, and the official `getsentry/vitest-evals` action to
publish one combined report.

## Add a scenario

You can define an eval by adding `evals/<name>.eval.ts`. The API is:

```ts
type EvalTask = {
  id: string;
  turns: readonly [EvalTurn, ...EvalTurn[]];
};

type EvalTurn = {
  prompt: string;
  verify(verifier: EvalVerifier): Promise<void>;
};

type EvalCheckOutcome = {
  pass: boolean;
  evidence?: unknown;
};
```

Call `defineEvalTask()` with the prompt and checks, then pass the result to `defineTaskEval()`. The
task ID must use lowercase words separated by hyphens, and prompts cannot be empty. Both errors are
reported before a model runs.

Inside `verify()`, use `verifier.connect<YourRpcType>("Exact Gadget Title")` and
`verifier.check("stable-check-id", async () => ({ pass, evidence }))`. Check the result a user asked
for, not which tools or implementation technique the agent chose. A later turn should re-check any
earlier behavior its requested change could break.

Every eval fails `pnpm evals` by default. `WORKSHOP_EVAL_GATING_TASKS` can select a subset or make an
explicit reporting-only run.
