import { SessionTerminatedError } from "./errors";

export const DEFAULT_EVENT_TIMEOUT_MS = 30_000;

export type ProvisioningState =
  "connected" | "active" | "credential-received" | "completed" | "terminal";

/**
 * Terminal provisioning state machine. Once terminal, no protocol message
 * may be sent again and the session UUID must never be reused; retrying
 * means a fresh connection, keyring, session, and UUID.
 */
export class ProvisioningLifecycle {
  #state: ProvisioningState = "connected";
  #terminalError: SessionTerminatedError | null = null;
  readonly #terminalListeners = new Set<
    (error: SessionTerminatedError) => void
  >();
  readonly #whenTerminal: Promise<SessionTerminatedError>;

  constructor() {
    this.#whenTerminal = new Promise((resolve) => {
      this.#terminalListeners.add(resolve);
    });
  }

  get state(): ProvisioningState {
    return this.#state;
  }

  get terminalError(): SessionTerminatedError | null {
    return this.#terminalError;
  }

  /** Resolves with the terminal error once the session turns terminal. */
  get whenTerminal(): Promise<SessionTerminatedError> {
    return this.#whenTerminal;
  }

  onTerminal(listener: (error: SessionTerminatedError) => void): () => void {
    if (this.#terminalError) {
      listener(this.#terminalError);
      return () => {};
    }
    this.#terminalListeners.add(listener);
    return () => this.#terminalListeners.delete(listener);
  }

  markActive(): void {
    this.assertActive("state change");
    if (this.#state === "connected") this.#state = "active";
  }

  markCredentialReceived(): void {
    this.assertActive("state change");
    this.#state = "credential-received";
  }

  markCompleted(): void {
    if (this.#state === "terminal") {
      throw this.#terminalError ?? new SessionTerminatedError("unknown");
    }
    this.#state = "completed";
  }

  fail(reason: string, cause?: unknown): SessionTerminatedError {
    if (!this.#terminalError) {
      this.#terminalError = new SessionTerminatedError(reason, undefined);
      if (cause instanceof Error && reason !== cause.message) {
        this.#terminalError.cause = cause;
      }
      this.#state = "terminal";
      for (const listener of [...this.#terminalListeners]) {
        listener(this.#terminalError);
      }
      this.#terminalListeners.clear();
    }
    return this.#terminalError;
  }

  assertActive(what: string): void {
    if (this.#terminalError) {
      throw new SessionTerminatedError(
        this.#terminalError.reason,
        `${what} after terminal failure: ${this.#terminalError.message}`,
      );
    }
  }
}

export class OperationTimeoutError extends Error {
  constructor(what: string) {
    super(`Timed out waiting for ${what}`);
    this.name = "OperationTimeoutError";
  }
}

/** Cancel the deadline timer when another operation wins the race. */
export async function withEventDeadline<T>(
  promise: Promise<T>,
  lifecycle: ProvisioningLifecycle,
  what: string,
  timeoutMs = DEFAULT_EVENT_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new OperationTimeoutError(what)),
      timeoutMs,
    );
  });
  try {
    const result = await Promise.race([
      promise,
      lifecycle.whenTerminal,
      timeout,
    ]);
    if (result instanceof SessionTerminatedError) throw result;
    return result;
  } catch (error) {
    lifecycle.fail(`${what}-failed`, error);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
