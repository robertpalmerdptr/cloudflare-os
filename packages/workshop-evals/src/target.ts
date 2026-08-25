import { AgentSession, type AgentSessionOptions } from "@gadgets/integration-tests/agent-session";
import { cleanupFailure, Deadline } from "@gadgets/integration-tests/deadline";
import {
  startHarness, type Harness, type HarnessOptions, type WorkerConfig,
} from "@gadgets/integration-tests/harness";
import { NetworkInterceptor } from "@gadgets/integration-tests/network-interceptor";

/** Existing credentials used to run models from a local workerd Workshop. */
type LocalModelAccess = {
  kind: "gateway";
  gateway: string;
  accountId: string;
  apiToken: string;
} | {
  kind: "direct";
  accountId: string;
  apiToken: string;
};

/** Where one eval trial runs. Scenario definitions are target-independent. */
export type WorkshopTarget = {
  kind: "local";
  modelAccess: LocalModelAccess;
} | {
  kind: "preview";
  url: URL;
  accessToken: string;
};

function value(environment: NodeJS.ProcessEnv, key: string): string | undefined {
  const candidate = environment[key]?.trim();
  return candidate ? candidate : undefined;
}

/** Resolve the local or deployed-preview target from the eval process environment. */
export function resolveWorkshopTarget(
    environment: NodeJS.ProcessEnv = process.env): WorkshopTarget {
  const configuredTarget = value(environment, "WORKSHOP_EVAL_TARGET");
  if (configuredTarget !== undefined && configuredTarget !== "local") {
    let url: URL;
    try {
      url = new URL(configuredTarget);
    } catch {
      throw new Error("WORKSHOP_EVAL_TARGET must be local or an absolute HTTPS URL");
    }
    if (url.protocol !== "https:") {
      throw new Error("WORKSHOP_EVAL_TARGET previews require HTTPS");
    }
    const accessToken = value(environment, "CF_ACCESS_TOKEN");
    if (accessToken === undefined) {
      throw new Error("CF_ACCESS_TOKEN is required when WORKSHOP_EVAL_TARGET is a preview URL");
    }
    return { kind: "preview", url, accessToken };
  }

  const gateway = value(environment, "CF_AI_GATEWAY");
  const gatewayAccountId = value(environment, "CF_AI_GATEWAY_ACCOUNT_ID");
  const gatewayApiToken = value(environment, "CF_AI_GATEWAY_API_TOKEN");
  const gatewayValues = [gateway, gatewayAccountId, gatewayApiToken];
  if (gatewayValues.some(Boolean)) {
    if (!gateway || !gatewayAccountId || !gatewayApiToken) {
      throw new Error(
        "Local AI Gateway evals require CF_AI_GATEWAY, CF_AI_GATEWAY_ACCOUNT_ID, and " +
        "CF_AI_GATEWAY_API_TOKEN together",
      );
    }
    return {
      kind: "local",
      modelAccess: {
        kind: "gateway",
        gateway,
        accountId: gatewayAccountId,
        apiToken: gatewayApiToken,
      },
    };
  }

  const accountId = value(environment, "CLOUDFLARE_ACCOUNT_ID");
  const apiToken = value(environment, "CLOUDFLARE_API_TOKEN");
  if (accountId && apiToken) {
    return { kind: "local", modelAccess: { kind: "direct", accountId, apiToken } };
  }
  throw new Error(
    "Local Workshop evals need existing model credentials: configure the CF_AI_GATEWAY trio or " +
    "CLOUDFLARE_ACCOUNT_ID with CLOUDFLARE_API_TOKEN",
  );
}

function configureGateway(config: WorkerConfig, access: Extract<LocalModelAccess, {kind: "gateway"}>) {
  config.vars = {
    ...config.vars,
    CF_AI_GATEWAY: access.gateway,
    CF_AI_GATEWAY_ACCOUNT_ID: access.accountId,
    CF_AI_GATEWAY_API_TOKEN: access.apiToken,
    CF_AI_GATEWAY_PROVIDERS: "cloudflare",
  };
}

function allowsModelEgress(access: LocalModelAccess, url: URL): boolean {
  const account = encodeURIComponent(access.accountId);
  if (access.kind === "gateway") {
    const gateway = encodeURIComponent(access.gateway);
    const inferencePrefix = `/v1/${account}/${gateway}/`;
    const logPrefix = `/client/v4/accounts/${account}/ai-gateway/gateways/${gateway}/logs/`;
    return (url.origin === "https://gateway.ai.cloudflare.com" &&
            url.pathname.startsWith(inferencePrefix)) ||
      (url.origin === "https://api.cloudflare.com" && url.pathname.startsWith(logPrefix));
  }
  const inferencePrefix = `/client/v4/accounts/${account}/ai/v1`;
  return url.origin === "https://api.cloudflare.com" &&
    url.pathname.startsWith(inferencePrefix);
}

function denyUnexpectedEgress(): Response {
  return new Response("External network access is disabled during this eval.", { status: 403 });
}

async function closeLocalTarget(
    harness: Harness,
    interceptor: NetworkInterceptor,
    deadline: Deadline,
    session?: AgentSession): Promise<void> {
  session?.[Symbol.dispose]();
  const errors: unknown[] = [];
  try {
    await deadline.run("closing the local Workshop", () => harness.server.close());
  } catch (error) {
    errors.push(error);
  } finally {
    interceptor.uninstall();
  }
  const unmockedCalls = interceptor.getUnmockedCalls();
  if (unmockedCalls.length > 0) {
    errors.push(new Error(`Unexpected eval egress: ${unmockedCalls.join(", ")}`));
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Local Workshop cleanup failed");
}

/** Open one isolated trial against local workerd or a deployed Access preview. */
export async function openWorkshopTarget(
    target: WorkshopTarget, model: string, runDeadline: Deadline, cleanupTimeoutMs: number) {
  if (target.kind === "preview") {
    const session = await AgentSession.create(target.url, {
      accessToken: target.accessToken,
      modelId: model,
    }, runDeadline, cleanupTimeoutMs);
    return {
      session,
      close: async () => {
        try {
          await session.deleteWorkspace(Deadline.after(cleanupTimeoutMs));
        } finally {
          session[Symbol.dispose]();
        }
      },
    };
  }

  const modelAccess = target.modelAccess;
  const harnessOptions: HarnessOptions = {
    gatekeepers: [],
    enableGadgetExecution: true,
    deadline: runDeadline,
  };
  if (modelAccess.kind === "gateway") {
    harnessOptions.patchWorkshop = config => configureGateway(config, modelAccess);
  }
  const sessionOptions: AgentSessionOptions = { modelId: model };
  if (modelAccess.kind === "direct") {
    sessionOptions.userModel = {
      profile: { type: "agent", id: model, name: model },
      config: {
        provider: "cloudflare",
        model,
        accountId: modelAccess.accountId,
        apiToken: modelAccess.apiToken,
      },
    };
  }

  const interceptor = new NetworkInterceptor(
      [denyUnexpectedEgress], url => allowsModelEgress(modelAccess, url));
  interceptor.install();
  let harness: Harness;
  try {
    harness = await startHarness(harnessOptions);
  } catch (error) {
    interceptor.uninstall();
    throw error;
  }
  try {
    const session = await AgentSession.create(
        harness.url, sessionOptions, runDeadline, cleanupTimeoutMs);
    return {
      session,
      close: () => closeLocalTarget(
          harness, interceptor, Deadline.after(cleanupTimeoutMs), session),
    };
  } catch (error) {
    try {
      await closeLocalTarget(
          harness, interceptor, Deadline.after(cleanupTimeoutMs));
    } catch (cleanupError) {
      throw cleanupFailure(
          error, cleanupError, "Opening the Workshop failed, and cleanup also failed");
    }
    throw error;
  }
}
