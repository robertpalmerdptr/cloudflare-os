import type { RpcCompatible, RpcStub } from "capnweb";
import type {
  AiChatMessage, AiChatAuthorInfo, AiModelConfig, AuthenticatedApi, GadgetClient, Overseer, PublicApi,
  WorkpieceId, WorkpieceSummary, WorkpiecesSubscriber,
} from "@gadgets/workshop-shared/api";
import { AgentTurnCompletion, loadAllChatHistory } from "./agent-session-internals.js";
import { cleanupFailure, Deadline } from "./deadline.js";
import { RpcTarget, connect, nextUsernames, signUp, stubFor, waitFor } from "./rpc-client.js";

const DEFAULT_TIMEOUT_MS = 120_000;

function connectTyped<Session extends RpcCompatible<Session>>(
    gadget: RpcStub<GadgetClient>, chatId: number): Promise<RpcStub<Session>>;
function connectTyped(gadget: RpcStub<GadgetClient>, chatId: number) {
  return gadget.connectToGadget(chatId);
}

/** Options for creating an isolated production Workshop agent session. */
export type AgentSessionOptions = {
  /** Model to use. It must appear in the account's `listModels()` result. Defaults to the first. */
  modelId?: string;
  /** Access application JWT. When present, authenticate as its Access identity instead of signing up. */
  accessToken?: string;
  /** Optional model to add to the fresh local account before its workspace opens. */
  userModel?: { profile: AiChatAuthorInfo; config: AiModelConfig };
  /** Hard limit for each agent turn. Defaults to two minutes. */
  timeoutMs?: number;
};

/** Authoritative state returned after one agent turn settles. */
export type AgentTurnResult = {
  /** Complete canonical chat history in ascending sequence order. */
  history: AiChatMessage[];
  /** Workpieces known when the turn finished. */
  workpieces: WorkpieceSummary[];
  /** Usage scoped exactly as described by the field names. */
  usage: {
    lastStepTokens?: number;
    agentChatCostUsd?: number;
    titleTokens?: number;
    titleCostUsd?: number;
  };
};


class WorkpieceSubscriber extends RpcTarget implements WorkpiecesSubscriber {
  readonly entries = new Map<WorkpieceId, WorkpieceSummary>();
  readonly readyPromise: Promise<void>;
  #resolveReady: () => void = () => {};

  constructor() {
    super();
    this.readyPromise = new Promise<void>(resolve => { this.#resolveReady = resolve; });
  }

  entry(summary: WorkpieceSummary): void { this.entries.set(summary.id, summary); }
  removed(id: WorkpieceId): void { this.entries.delete(id); }
  ready(): void { this.#resolveReady(); }
}


/**
 * Drives the production Workshop RPC lifecycle for one fresh user and workspace.
 *
 * The class deliberately does not interpret agent output. Callers own verification and evaluation.
 * Dispose the session when finished; verifier stubs returned by this class remain caller-owned.
 */
export class AgentSession implements Disposable {
  readonly #modelId: string;
  #publicApi: RpcStub<PublicApi>;
  #authenticatedApi: RpcStub<AuthenticatedApi>;
  #overseer: RpcStub<Overseer>;
  #workpieceSubscriber = new WorkpieceSubscriber();
  #workpieceSubscriberStub: RpcStub<WorkpieceSubscriber> | undefined;
  #workpieceSubscription: RpcStub<{}> | undefined;
  #chatId: number | undefined;
  #turn: AgentTurnCompletion | undefined;
  #timeoutMs: number;
  #disposed = false;
  #failed = false;

  private constructor(
      publicApi: RpcStub<PublicApi>,
      authenticatedApi: RpcStub<AuthenticatedApi>,
      overseer: RpcStub<Overseer>,
      modelId: string,
      timeoutMs: number) {
    this.#publicApi = publicApi;
    this.#authenticatedApi = authenticatedApi;
    this.#overseer = overseer;
    this.#modelId = modelId;
    this.#timeoutMs = timeoutMs;
  }

  /** Create a fresh account, finish first-time model setup, and open an isolated workspace. */
  static async create(
      baseUrl: URL,
      options: AgentSessionOptions = {},
      deadline = Deadline.after(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      cleanupTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS): Promise<AgentSession> {
    const publicApi = connect(baseUrl, { accessToken: options.accessToken });
    let authenticatedApi: RpcStub<AuthenticatedApi> | undefined;
    let overseer: RpcStub<Overseer> | undefined;
    let session: AgentSession | undefined;
    try {
      let authenticated: RpcStub<AuthenticatedApi>;
      if (options.accessToken === undefined) {
        const username = nextUsernames("agent").at(0);
        if (username === undefined) throw new Error("Failed to allocate an integration-test username");
        authenticated = await deadline.run(
            "creating the eval account", () => signUp(publicApi, username));
      } else {
        authenticated = await deadline.run(
            "authenticating the preview account", () => publicApi.authenticateFromCfAccess());
      }
      authenticatedApi = authenticated;

      const userModel = options.userModel;
      if (userModel !== undefined) {
        await deadline.run("adding the eval model", () =>
          authenticated.addModel(userModel.profile, userModel.config));
      }
      const models = await deadline.run("listing eval models", () => authenticated.listModels());
      const modelId = AgentSession.#selectModel(models, options.modelId);
      const onboardingCompleted = await deadline.run(
          "reading onboarding state", () => authenticated.isOnboardingCompleted());
      if (!onboardingCompleted) {
        await deadline.run(
            "selecting the eval model", () => authenticated.setPreferredModel(modelId));
        await deadline.run(
            "completing eval onboarding", () => authenticated.completeOnboarding());
      }
      const workspace = await deadline.run(
          "creating the eval workspace", () => authenticated.newGadget());
      overseer = workspace;
      const createdSession = new AgentSession(
          publicApi, authenticated, workspace, modelId,
          options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      session = createdSession;
      await deadline.run(
          "subscribing to the eval workspace", () => createdSession.#initializeWorkpieces());
      await deadline.run(
          "output formats", () => createdSession.#waitForOutputFormats());
      return createdSession;
    } catch (error) {
      if (session === undefined) {
        overseer?.[Symbol.dispose]();
        authenticatedApi?.[Symbol.dispose]();
        publicApi[Symbol.dispose]();
      } else {
        try {
          await session.deleteWorkspace(Deadline.after(cleanupTimeoutMs));
        } catch (cleanupError) {
          throw cleanupFailure(
              error, cleanupError, "Opening the agent session failed, and cleanup also failed");
        } finally {
          session[Symbol.dispose]();
        }
      }
      throw error;
    }
  }

  /**
   * Send a prompt. The first call creates a chat; later calls continue that same chat.
   * History is fetched through every compaction page after the turn settles.
   */
  async run(
      prompt: string,
      signal?: AbortSignal,
      deadline = Deadline.after(this.#timeoutMs)): Promise<AgentTurnResult> {
    this.#assertUsable();
    if (this.#turn !== undefined) throw new Error("An agent turn is already running");

    const existingChatId = this.#chatId ?? null;
    const completion = new AgentTurnCompletion(
        existingChatId,
        () => this.#stopCurrentAgent(),
        deadline.remainingMs,
        signal);
    this.#turn = completion;
    try {
      let chatId = this.#chatId;
      if (chatId === undefined) {
        chatId = await deadline.run(
            "the agent turn to start", () => this.#overseer.newChat(prompt, this.#modelId));
        this.#chatId = chatId;
        completion.attach(chatId);
      } else {
        const continuedChatId = chatId;
        await deadline.run(
            "the agent turn RPC",
            () => this.#overseer.sendChatMessage(continuedChatId, prompt, this.#modelId));
      }
      completion.follow(this.#overseer.waitForAgentTurn(chatId));
      await completion.promise;

      const [history, chats] = await deadline.run("loading final chat state", () => Promise.all([
        this.#loadHistory(chatId),
        this.#overseer.listChats(),
      ]));
      const metadata = chats.find(chat => chat.id === chatId);
      if (metadata === undefined) throw new Error(`Chat ${chatId} disappeared after its agent turn`);
      const usage: AgentTurnResult["usage"] = {};
      if (metadata.totalTokens !== undefined) usage.lastStepTokens = metadata.totalTokens;
      if (metadata.titleTokens !== undefined) usage.titleTokens = metadata.titleTokens;
      if (metadata.titleCost !== undefined) usage.titleCostUsd = metadata.titleCost;
      if (metadata.totalCost !== undefined) usage.agentChatCostUsd = metadata.totalCost;
      return {
        history,
        workpieces: [...this.#workpieceSubscriber.entries.values()],
        usage,
      };
    } catch (error) {
      this.#failed = true;
      throw error;
    } finally {
      completion.dispose();
      if (this.#turn === completion) this.#turn = undefined;
    }
  }

  /** Connect a caller-owned typed verifier stub to this session's provisional chat branch. */
  async connectToGadget<Session extends RpcCompatible<Session>>(
      id: WorkpieceId): Promise<RpcStub<Session>> {
    this.#assertUsable();
    if (this.#chatId === undefined) throw new Error("The session has no chat branch yet");
    using gadget = await this.#overseer.getGadget(id);
    return connectTyped<Session>(gadget, this.#chatId);
  }

  async #waitForOutputFormats(): Promise<void> {
    await waitFor(
        "the output formats to install (is workshop-backend built? see its README)", async () => {
      const offers = await this.#authenticatedApi.listOutputFormats();
      return offers.length > 0 ? true : null;
    });
  }

  /** Delete the isolated workspace, including after a failed turn. */
  async deleteWorkspace(deadline = Deadline.after(this.#timeoutMs)): Promise<void> {
    if (this.#disposed) throw new Error("AgentSession is disposed");
    if (this.#turn !== undefined) throw new Error("Cannot delete the workspace during an agent turn");
    await deadline.run("deleting the eval workspace", () => this.#overseer.deleteSelf());
    this[Symbol.dispose]();
  }

  /** Dispose subscriptions, callback targets, RPC capabilities, and the WebSocket session. */
  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#turn?.cancel();
    this.#turn?.dispose();
    this.#workpieceSubscription?.[Symbol.dispose]();
    this.#workpieceSubscriberStub?.[Symbol.dispose]();
    this.#overseer[Symbol.dispose]();
    this.#authenticatedApi[Symbol.dispose]();
    this.#publicApi[Symbol.dispose]();
  }

  async #initializeWorkpieces(): Promise<void> {
    this.#workpieceSubscriberStub = stubFor(this.#workpieceSubscriber);
    this.#workpieceSubscription = await this.#overseer.subscribeToWorkpieces(
        this.#workpieceSubscriberStub);
    await this.#workpieceSubscriber.readyPromise;
  }

  async #loadHistory(chatId: number): Promise<AiChatMessage[]> {
    return loadAllChatHistory(before => this.#overseer.getChatHistory(chatId, before));
  }


  #stopCurrentAgent(): Promise<void> {
    if (this.#chatId === undefined) return Promise.resolve();
    return this.#overseer.stopAgent(this.#chatId);
  }

  #assertUsable(): void {
    if (this.#disposed) throw new Error("AgentSession is disposed");
    if (this.#failed) throw new Error("AgentSession cannot be reused after a failed or cancelled turn");
  }

  static #selectModel(models: AiChatAuthorInfo[], requested: string | undefined): string {
    const first = models.at(0);
    if (first === undefined) throw new Error("The Workshop exposes no configured agent models");
    if (requested === undefined) return first.id;
    if (!models.some(model => model.id === requested)) {
      throw new Error(`Model "${requested}" is not available to this account`);
    }
    return requested;
  }
}
