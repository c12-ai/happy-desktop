import type { HappyCloudRequest } from "./happyAgentProviderCredentials.js";

/**
 * What the server keeps out of this reader's view, and the bot it sends them
 * to instead. Happy Gateway answers both in `/v0/permissions` (`hiddenIds`
 * and `teamAssistantBotId`): a member does not see the admin bots, their
 * agents, their workspaces or the agents working there. The gateway already
 * leaves them out of the lists and refuses them by ID; this is what keeps
 * events, the feed and search from bringing them back. A server that sends
 * neither field hides nothing.
 *
 * Held once for the window: IDs are unique across servers, so one set serves
 * every connection.
 */
export interface HappyAgentHiddenIds {
    readonly ids: ReadonlySet<string>;
    /** Every admin bot is hidden, also one announced before the next poll names it. */
    readonly adminBots: boolean;
    readonly teamAssistantBotId: string | null;
}

const NONE: HappyAgentHiddenIds = { ids: new Set(), adminBots: false, teamAssistantBotId: null };
const POLL_MS = 10_000;

let current = NONE;
const listeners = new Set<() => void>();

export function happyAgentHiddenIds(): HappyAgentHiddenIds {
    return current;
}

/** Whether any of these IDs is hidden from the reader. */
export function happyAgentHiddenHas(...ids: readonly unknown[]): boolean {
    if (current.ids.size === 0) return false;
    return ids.some((id) => typeof id === "string" && current.ids.has(id));
}

/** Whether a feed cluster (`<kind>:<id>`) gathers from something hidden. */
export function happyAgentHiddenClusterHas(cluster: string): boolean {
    const colon = cluster.indexOf(":");
    return colon > 0 && happyAgentHiddenHas(cluster.slice(colon + 1));
}

/** Hears every change of the hidden set; answers how to stop. */
export function happyAgentHiddenSubscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Takes in a `/v0/permissions` answer. One without the fields hides nothing. */
export function happyAgentHiddenReceive(answer: unknown): void {
    const record =
        typeof answer === "object" && answer !== null ? (answer as Record<string, unknown>) : {};
    const hidden =
        typeof record.hiddenIds === "object" && record.hiddenIds !== null
            ? (record.hiddenIds as Record<string, unknown>)
            : {};
    const ids = new Set<string>();
    for (const list of [hidden.bots, hidden.agents, hidden.workspaces])
        if (Array.isArray(list)) for (const id of list) if (typeof id === "string") ids.add(id);
    const teamAssistantBotId =
        typeof record.teamAssistantBotId === "string" ? record.teamAssistantBotId : null;
    const adminBots = record.hidesAdminBots === true;
    // What an event taught stays hidden until the server's own answer names it.
    for (const id of learned) ids.add(id);
    if (
        teamAssistantBotId === current.teamAssistantBotId &&
        adminBots === current.adminBots &&
        ids.size === current.ids.size &&
        [...ids].every((id) => current.ids.has(id))
    )
        return;
    current = { ids, adminBots, teamAssistantBotId };
    for (const listener of [...listeners]) listener();
}

const learned = new Set<string>();

/**
 * Whether a bot an event carries is an admin bot hidden from this reader. One is then hidden at
 * once, with its workspace and agent, rather than at the next poll.
 */
export function happyAgentHiddenAdminBot(bot: unknown): boolean {
    if (!current.adminBots || typeof bot !== "object" || bot === null) return false;
    const record = bot as {
        id?: unknown;
        isAdmin?: unknown;
        workspaceId?: unknown;
        agent?: { id?: unknown };
    };
    if (record.isAdmin !== true) return false;
    const ids = new Set(current.ids);
    for (const id of [record.id, record.workspaceId, record.agent?.id])
        if (typeof id === "string") {
            ids.add(id);
            learned.add(id);
        }
    current = { ...current, ids };
    for (const listener of [...listeners]) listener();
    return true;
}

/**
 * Asks the server every ten seconds, and whenever the window comes back into
 * focus. A failed read keeps what is held. Answers how to stop.
 */
export function happyAgentHiddenPoll(request: HappyCloudRequest): () => void {
    let stopped = false;
    let asking = false;
    const ask = (): void => {
        if (stopped || asking) return;
        asking = true;
        request("GET", "v0/permissions").then(
            (answer) => {
                asking = false;
                if (!stopped) happyAgentHiddenReceive(answer);
            },
            () => {
                asking = false;
            },
        );
    };
    ask();
    const timer = setInterval(ask, POLL_MS);
    const target = typeof window === "undefined" ? undefined : window;
    target?.addEventListener("focus", ask);
    return () => {
        stopped = true;
        clearInterval(timer);
        target?.removeEventListener("focus", ask);
    };
}

/**
 * The bot that helps this reader with the server: the Chief of Staff where the
 * reader sees it, otherwise the Team Assistant the server names.
 */
export function happyAgentAssistantBot<
    T extends { readonly id: string; readonly systemKey?: string | null },
>(bots: readonly T[]): T | undefined {
    const chief = bots.find((bot) => bot.systemKey === "chief_of_staff");
    if (chief !== undefined && !happyAgentHiddenHas(chief.id)) return chief;
    const assistant = current.teamAssistantBotId;
    return assistant === null ? undefined : bots.find((bot) => bot.id === assistant);
}
