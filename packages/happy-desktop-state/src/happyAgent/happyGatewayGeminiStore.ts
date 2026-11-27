const PATH = "/v0/cloud/providers/google-gemini";
export const HAPPY_GATEWAY_GEMINI_PROVIDER_ID = "google_gemini";

export interface HappyGatewayGeminiConfig {
    readonly revision: string;
    readonly keyPresent: boolean;
    readonly enabled: boolean;
    readonly modelIds: readonly string[];
    readonly candidates: readonly { readonly id: string; readonly name: string }[];
    readonly refreshedAt: string | null;
}

export interface HappyGatewayGeminiSnapshot {
    readonly access: "loading" | "absent" | "ready" | "unavailable";
    readonly config?: HappyGatewayGeminiConfig;
    readonly selected: readonly string[];
    readonly busy?: "key" | "disconnect" | "verify" | "models";
    readonly stale?: boolean;
    readonly error?: string;
}

export interface HappyGatewayGeminiStore {
    get(): HappyGatewayGeminiSnapshot;
    subscribe(listener: () => void): () => void;
    keySave(secret: string): void;
    keyDisconnect(): void;
    catalogVerify(): void;
    modelSelect(id: string, selected: boolean): void;
    modelsSave(enabled: boolean): void;
    providerDisable(): void;
}

export const happyGatewayGeminiEmpty: HappyGatewayGeminiSnapshot = {
    access: "loading",
    selected: [],
};

function configRead(value: unknown): HappyGatewayGeminiConfig | undefined {
    if (typeof value !== "object" || value === null) return;
    const { revision, keyPresent, enabled, modelIds, candidates, refreshedAt } = value as Record<
        string,
        unknown
    >;
    if (
        typeof revision !== "string" ||
        !revision ||
        typeof keyPresent !== "boolean" ||
        typeof enabled !== "boolean" ||
        !Array.isArray(modelIds) ||
        !modelIds.every((id) => typeof id === "string") ||
        !Array.isArray(candidates) ||
        !candidates.every(
            (model) => model && typeof model.id === "string" && typeof model.name === "string",
        ) ||
        !(
            refreshedAt === null ||
            (typeof refreshedAt === "string" && Number.isFinite(Date.parse(refreshedAt)))
        )
    )
        return;
    // Copy only the documented safe fields, never an opaque response or error body.
    return {
        revision,
        keyPresent,
        enabled,
        modelIds,
        candidates: candidates.map(({ id, name }) => ({ id, name })),
        refreshedAt,
    };
}

/** Settings-owned discovery view; the daemon's independent catalog feeds chat. */
export function happyGatewayGeminiStoreCreate(request: typeof fetch): HappyGatewayGeminiStore {
    const listeners = new Set<() => void>();
    let state = happyGatewayGeminiEmpty;
    let read: AbortController | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const set = (next: HappyGatewayGeminiSnapshot) => {
        state = next;
        for (const listener of listeners) listener();
    };
    const load = async (): Promise<void> => {
        if (read || state.busy || listeners.size === 0) return;
        const pending = new AbortController();
        read = pending;
        try {
            const response = await request(PATH, {
                cache: "no-store",
                credentials: "same-origin",
                redirect: "error",
                signal: pending.signal,
            });
            if (pending.signal.aborted) return;
            if ([401, 403, 404].includes(response.status)) {
                if (state.access !== "absent") set({ access: "absent", selected: [] });
                return;
            }
            if (!response.ok) throw new Error();
            const config = configRead(await response.json());
            if (pending.signal.aborted) return;
            if (!config) throw new Error();
            if (state.config?.revision !== config.revision || state.access !== "ready") {
                const changed =
                    state.config !== undefined && state.config.revision !== config.revision;
                set({
                    access: "ready",
                    config,
                    selected: config.modelIds,
                    ...(changed
                        ? {
                              error: "Gemini settings changed. Review the model selection before saving.",
                          }
                        : {}),
                });
            } else if (state.stale) {
                const { stale: _, ...previous } = state;
                set({ ...previous, config, selected: config.modelIds });
            }
        } catch {
            if (!pending.signal.aborted && !state.stale)
                set(
                    state.config
                        ? {
                              ...state,
                              stale: true,
                              error: "Gemini settings couldn’t be checked. Waiting for the server.",
                          }
                        : { access: "unavailable", selected: [] },
                );
        } finally {
            if (read === pending) read = undefined;
        }
    };
    const write = async (
        busy: NonNullable<HappyGatewayGeminiSnapshot["busy"]>,
        suffix: string,
        method: string,
        body?:
            | { readonly secret: string }
            | { readonly modelIds: readonly string[]; readonly enabled: boolean },
    ): Promise<void> => {
        const config = state.config;
        if (
            listeners.size === 0 ||
            state.access !== "ready" ||
            !config ||
            state.busy ||
            state.stale
        )
            return;
        read?.abort();
        read = undefined;
        const { error: _, ...previous } = state;
        set({ ...previous, busy });
        try {
            const response = await request(PATH + suffix, {
                method,
                cache: "no-store",
                credentials: "same-origin",
                redirect: "error",
                headers: {
                    "If-Match": config.revision,
                    ...(body === undefined ? {} : { "Content-Type": "application/json" }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            if ([401, 403, 404].includes(response.status)) {
                set({ access: "absent", selected: [] });
                return;
            }
            if (!response.ok) {
                // Never display or retain untrusted upstream response text.
                const answer = (await response.json().catch(() => undefined)) as
                    | { error?: { code?: unknown } }
                    | undefined;
                const code = answer?.error?.code;
                if (response.status === 409 && code === "stale_state") {
                    set({
                        ...previous,
                        stale: true,
                        selected: config.modelIds,
                        error: "Gemini settings changed. Review the model selection before saving.",
                    });
                    void load();
                    return;
                }
                const error =
                    code === "rollback_failed"
                        ? "Gemini settings could not be restored. Ask an administrator to check the server."
                        : code === "apply_rolled_back"
                          ? "The server could not apply this change. The previous settings were restored."
                          : response.status === 429 || code === "busy"
                            ? "Gemini is busy. Try again shortly."
                            : busy === "key"
                              ? "The Gemini key could not be verified or saved."
                              : busy === "verify"
                                ? "Gemini verification failed. The displayed models are from the last successful check."
                                : "The Gemini change could not be saved.";
                set({ ...previous, error });
                return;
            }
            const next = configRead(await response.json());
            if (!next) throw new Error();
            set({ access: "ready", config: next, selected: next.modelIds });
        } catch {
            set({
                ...previous,
                stale: true,
                error: "The server did not confirm the Gemini change. Checking its current settings.",
            });
            void load();
        }
    };
    return {
        get: () => state,
        subscribe(listener) {
            listeners.add(listener);
            if (listeners.size === 1) {
                void load();
                timer = setInterval(() => {
                    void load();
                }, 5_000);
            }
            return () => {
                listeners.delete(listener);
                if (!listeners.size) {
                    clearInterval(timer);
                    read?.abort();
                    read = undefined;
                    if (!state.busy) state = happyGatewayGeminiEmpty;
                }
            };
        },
        keySave: (secret) => {
            if (secret.trim()) void write("key", "/credentials", "PUT", { secret: secret.trim() });
        },
        keyDisconnect: () => {
            if (state.config?.keyPresent) void write("disconnect", "/credentials", "DELETE");
        },
        catalogVerify: () => {
            if (state.config?.keyPresent) void write("verify", "/refresh", "POST");
        },
        modelSelect(id, selected) {
            if (
                state.busy ||
                state.stale ||
                !state.config?.candidates.some((model) => model.id === id)
            )
                return;
            const next = new Set(state.selected);
            if (selected) next.add(id);
            else next.delete(id);
            set({ ...state, selected: [...next] });
        },
        modelsSave(enabled) {
            const config = state.config;
            if (!config?.keyPresent) return;
            const modelIds = state.selected.filter((id) =>
                config.candidates.some((model) => model.id === id),
            );
            if (!enabled || modelIds.length > 0)
                void write("models", "/models", "PUT", { enabled, modelIds });
        },
        providerDisable() {
            const config = state.config;
            if (config?.enabled)
                void write("models", "/models", "PUT", {
                    enabled: false,
                    modelIds: config.modelIds,
                });
        },
    };
}
