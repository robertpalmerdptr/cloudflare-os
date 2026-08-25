# Workshop agent evals

These evals run the production Workshop agent, execute the Gadget it creates, and verify the result
through the Gadget's real RPC.

The package uses the workerd and Cap'n Web helpers from `@gadgets/integration-tests`. `vitest-evals`
owns transcript normalization, scoring, reports, traces, and CI result reduction.

Live cases stay under `evals/**/*.eval.ts`. The package's cached `test` task includes only
`src/**/*.test.ts`, so `pnpm test` never runs a model. The root `pnpm evals` script builds first, then
invokes the live package script directly; model credentials do not pass through a cached Vite+ task.

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

Optional controls:

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

A **turn** is one user request followed by the agent working until it settles. Every turn in an eval
uses the same chat and workspace. A two-turn eval builds something, verifies it, sends a follow-up
request, then verifies the changed result. The number of internal LLM turns and tool calls is not
fixed; the report records what the agent used.

## Run against a preview

Provide the preview router URL and an Access application JWT for the user that runs the scenarios:

```sh
export WORKSHOP_EVAL_TARGET='https://pr123-branch-router.example.workers.dev'
export CF_ACCESS_TOKEN=...
pnpm evals
```

The preview supplies its own model catalog and Workers AI binding. The runner does not need separate
model credentials in this mode. The same task prompts and verifiers run locally and on the preview.

The target commit defaults to the current checkout. Set `WORKSHOP_EVAL_TARGET_COMMIT` to the deployed
40-character Git SHA when the preview came from another revision.

## Inspect results

The run writes `.wrangler/evals/results.json` in this package. Open the report UI with:

```sh
pnpm evals:ui
```

For each trial, the report shows:

- how many task requirements passed, plus pass rate across repeated trials
- total task duration and the time spent in each agent turn and verifier
- LLM turns, tool calls, and tool errors; a report can derive the failure rate from the two counts
- agent errors and provider errors present in the transcript
- provider-reported tokens and cost when available
- model, local or preview target, and trial number
- runner commit, target commit, and task version

`taskVersion` is a SHA-256 hash of the prompts. Verifier and gating-policy changes remain attributable
through the runner commit without changing the task version.

The current tasks use deterministic code and RPC checks. They do not use an LLM judge.

## CI

The **Workshop evals** workflow is manual-only. Start it with `workflow_dispatch`; leave models blank
to use the suite defaults, or provide a comma-separated override. It uses existing repository AI
Gateway credentials, native Vitest sharding, and the official `getsentry/vitest-evals` action to
publish one combined report.

## Add a scenario

Add `evals/<name>.eval.ts`. Define the prompt and RPC verifier with `defineEvalTask()`, then register
the task with `defineTaskEval()`. Keep the scenario in one file.

Whether a failed eval gates the run is configuration, not part of the task. Use
`WORKSHOP_EVAL_GATING_TASKS` locally or the manual workflow's **gatingTasks** input.

Verify user-visible behavior and stable RPC contracts without requiring one implementation
technique. Multi-turn tasks should re-check earlier behavior after each extension.
