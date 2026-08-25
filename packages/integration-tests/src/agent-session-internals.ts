import type { AiChatHistoryPage, AiChatMessage } from "@gadgets/workshop-shared/api";


export class AgentTurnCompletion {
  readonly promise: Promise<void>;
  #chatId: number | null;
  #resolve: () => void = () => {};
  #reject: (error: Error) => void = () => {};
  #stopAgent: () => Promise<void>;
  #hardTimeout: ReturnType<typeof setTimeout>;
  #signal: AbortSignal | undefined;
  #isSettled = false;
  #stopRequested = false;
  #following = false;

  constructor(
      chatId: number | null,
      stopAgent: () => Promise<void>,
      timeoutMs: number,
      signal?: AbortSignal) {
    this.#chatId = chatId;
    this.#stopAgent = stopAgent;
    this.#signal = signal;
    this.promise = new Promise<void>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = error => reject(error);
    });
    this.promise.catch(() => {});
    this.#hardTimeout = setTimeout(() => {
      this.#stopRequested = true;
      this.#requestStop();
      this.#fail(new Error(`Timed out after ${timeoutMs}ms waiting for the agent turn`));
    }, timeoutMs);
    signal?.addEventListener("abort", this.#onAbort, { once: true });
    if (signal?.aborted) this.#onAbort();
  }

  get settled(): boolean {
    return this.#isSettled;
  }

  attach(chatId: number): void {
    if (this.#chatId !== null && this.#chatId !== chatId) {
      throw new Error(`Agent turn is already attached to chat ${this.#chatId}`);
    }
    this.#chatId = chatId;
    if (this.#stopRequested) this.#requestStop();
  }


  follow(serverCompletion: PromiseLike<void>): void {
    if (this.#following) throw new Error("Agent turn completion is already being followed");
    this.#following = true;
    Promise.resolve(serverCompletion).then(
        () => this.#succeed(),
        error => this.#fail(error instanceof Error ? error : new Error(String(error))));
  }

  cancel(): void {
    if (this.#isSettled) return;
    this.#stopRequested = true;
    this.#requestStop();
    this.#fail(new Error("Agent turn was cancelled"));
  }

  dispose(): void {
    clearTimeout(this.#hardTimeout);
    this.#signal?.removeEventListener("abort", this.#onAbort);
  }

  #onAbort = (): void => {
    this.cancel();
  };

  #requestStop(): void {
    if (this.#chatId !== null) this.#stopAgent().catch(() => {});
  }

  #succeed(): void {
    if (this.#isSettled) return;
    this.#isSettled = true;
    this.dispose();
    this.#resolve();
  }

  #fail(error: Error): void {
    if (this.#isSettled) return;
    this.#isSettled = true;
    this.dispose();
    this.#reject(error);
  }
}

export async function loadAllChatHistory(
    loadPage: (beforeSequence?: number) => Promise<AiChatHistoryPage>): Promise<AiChatMessage[]> {
  let page = await loadPage();
  let messages = page.messages;
  const boundaries = new Set<number>();
  while (page.compacted) {
    const boundary = page.compacted.to;
    if (boundaries.has(boundary)) {
      throw new Error(`Chat history repeated compaction boundary ${boundary}`);
    }
    boundaries.add(boundary);
    page = await loadPage(boundary);
    messages = [...page.messages, ...messages];
  }
  return messages;
}

