import { createStore } from "zustand/vanilla";
import type { UserError } from "../types.js";
import {
    HappyCloudRequestRefusal,
    type HappyCloudRequest,
} from "./happyAgentProviderCredentials.js";
import { happyAgentUserError, referencesPreserve } from "./happyAgentSupport.js";

/**
 * Settings › Members on a server behind Happy Gateway, which signs people in
 * itself: who may use the server, invitation links, password links, and
 * removing and restoring people. The gateway answers `v0/gateway/members`
 * itself: everyone signed in reads who is there, the owner alone also reads
 * emails and open links and makes changes. A server without a gateway
 * answers 404.
 */

/** One person the gateway signs in. */
export interface HappyGatewayPerson {
    readonly id: string;
    readonly name: string;
    /** Shown to the owner only; `null` for anyone else, or when none was given. */
    readonly email: string | null;
    readonly role: "owner" | "member";
    /** `no_password`: invited or moved here, and has not chosen a password yet. */
    readonly status: "active" | "no_password" | "removed";
    readonly self: boolean;
    /** Times in milliseconds since the epoch. */
    readonly createdAt: number;
    readonly lastSignInAt: number | null;
    /** Open connections; the owner's view only, 0 for anyone else. */
    readonly openConnections: number;
    /** A change this window asked for and the gateway hasn't answered. */
    readonly saving: boolean;
    /** Why the last change to this person was refused; cleared by the next attempt. */
    readonly refusal?: UserError;
}

/** An open link: unused, not withdrawn, not expired. Its secret is never shown again. */
export interface HappyGatewayInvitation {
    readonly id: string;
    /** `join` makes a new member; `reset` sets a new password for `personId`. */
    readonly kind: "join" | "reset";
    readonly personId: string | null;
    readonly createdAt: number;
    readonly expiresAt: number;
    readonly saving: boolean;
}

/** What the invitation area says: a link just made, shown this once, or why a change was refused. */
export type HappyGatewayMembersNotice =
    | {
          readonly type: "link";
          readonly kind: "join" | "reset";
          /** The person a password link is for. */
          readonly personName?: string;
          readonly link: string;
          readonly expiresAt: number;
      }
    | { readonly type: "refused"; readonly error: UserError };

export interface HappyGatewayMembersSnapshot {
    /** True until the first answer, so nothing is claimed early. */
    readonly loading: boolean;
    /**
     * `owner`: the reader manages members here. `member`: the reader sees who
     * is here and changes nothing. `absent`: no gateway answers on this server.
     */
    readonly access: "owner" | "member" | "absent";
    readonly people: readonly HappyGatewayPerson[];
    readonly invitations: readonly HappyGatewayInvitation[];
    /** Whether an invitation link is being made. */
    readonly inviting: boolean;
    readonly notice?: HappyGatewayMembersNotice;
    /** Why the list could not be read. */
    readonly error?: UserError;
}

export interface HappyGatewayMembersStore {
    get(): HappyGatewayMembersSnapshot;
    /** The first subscriber starts the reads, re-read every few seconds until the last one leaves. */
    subscribe(listener: () => void): () => void;
    invitationCreate(): void;
    invitationWithdraw(invitationId: string): void;
    passwordLinkCreate(personId: string): void;
    personRemove(personId: string): void;
    personRestore(personId: string): void;
    noticeDismiss(): void;
    [Symbol.dispose](): void;
}

const POLL_INTERVAL_MS = 5_000;
const ROUTE = "v0/gateway/members";

interface Read {
    readonly manage: boolean;
    readonly people: readonly Omit<HappyGatewayPerson, "saving" | "refusal">[];
    readonly invitations: readonly Omit<HappyGatewayInvitation, "saving">[];
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)
        : undefined;
}

function listOf(value: unknown, key: string): Record<string, unknown>[] {
    const list = recordOf(value)?.[key];
    if (!Array.isArray(list)) return [];
    return (list as unknown[]).flatMap((entry): Record<string, unknown>[] => {
        const record = recordOf(entry);
        return record === undefined ? [] : [record];
    });
}

const numberOf = (value: unknown): number => (typeof value === "number" ? value : 0);

function readOf(answer: unknown): Read {
    return {
        manage: recordOf(answer)?.manage === true,
        people: listOf(answer, "people").map((person) => ({
            id: String(person.id),
            name: String(person.name),
            email: typeof person.email === "string" ? person.email : null,
            role: person.role === "owner" ? "owner" : "member",
            status:
                person.status === "removed" || person.status === "no_password"
                    ? person.status
                    : "active",
            self: person.self === true,
            createdAt: numberOf(person.createdAt),
            lastSignInAt: typeof person.lastSignInAt === "number" ? person.lastSignInAt : null,
            openConnections: numberOf(person.openConnections),
        })),
        invitations: listOf(answer, "invitations").map((invitation) => ({
            id: String(invitation.id),
            kind: invitation.kind === "reset" ? "reset" : "join",
            personId: typeof invitation.personId === "string" ? invitation.personId : null,
            createdAt: numberOf(invitation.createdAt),
            expiresAt: numberOf(invitation.expiresAt),
        })),
    };
}

function linkNoticeOf(answer: unknown, personName?: string): HappyGatewayMembersNotice | undefined {
    const link = recordOf(answer)?.link;
    const invitation = recordOf(recordOf(answer)?.invitation);
    if (typeof link !== "string" || invitation === undefined) return undefined;
    return {
        type: "link",
        kind: invitation.kind === "reset" ? "reset" : "join",
        ...(personName === undefined ? {} : { personName }),
        link,
        expiresAt: numberOf(invitation.expiresAt),
    };
}

export function happyGatewayMembersStoreCreate(deps: {
    /** The server's own routes, over the connection's transport. */
    readonly request: HappyCloudRequest;
}): HappyGatewayMembersStore {
    const store = createStore<HappyGatewayMembersSnapshot>()(() => ({
        loading: true,
        access: "absent",
        people: [],
        invitations: [],
        inviting: false,
    }));
    const listeners = new Set<() => void>();
    const saving = new Set<string>();
    const refusals = new Map<string, UserError>();
    let last: Read | undefined;
    let disposed = false;
    let reading = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const publish = (): void => {
        if (!last) return;
        const read = last;
        const current = store.getState();
        const { error: _cleared, ...rest } = current;
        store.setState(
            {
                ...rest,
                loading: false,
                access: read.manage ? "owner" : "member",
                people: referencesPreserve(
                    current.people,
                    read.people.map((person) => ({
                        ...person,
                        saving: saving.has(person.id),
                        ...(refusals.has(person.id) ? { refusal: refusals.get(person.id)! } : {}),
                    })),
                ),
                invitations: referencesPreserve(
                    current.invitations,
                    read.invitations.map((invitation) => ({
                        ...invitation,
                        saving: saving.has(invitation.id),
                    })),
                ),
            },
            true,
        );
    };

    const timerCancel = (): void => {
        if (timer === undefined) return;
        clearTimeout(timer);
        timer = undefined;
    };

    const schedule = (): void => {
        if (disposed || listeners.size === 0 || timer !== undefined) return;
        timer = setTimeout(() => {
            timer = undefined;
            load();
        }, POLL_INTERVAL_MS);
    };

    function load(): void {
        if (disposed || listeners.size === 0 || reading) return;
        timerCancel();
        reading = true;
        void deps.request("GET", ROUTE).then(
            (answer) => {
                reading = false;
                if (disposed) return;
                last = readOf(answer);
                publish();
                schedule();
            },
            (error: unknown) => {
                reading = false;
                if (disposed) return;
                const status = error instanceof HappyCloudRequestRefusal ? error.status : undefined;
                // No gateway on this server: not asked again.
                if (status === 404) {
                    last = undefined;
                    store.setState(
                        {
                            loading: false,
                            access: "absent",
                            people: [],
                            invitations: [],
                            inviting: false,
                        },
                        true,
                    );
                    return;
                }
                // A failed refresh keeps what was read; only the first read shows the error.
                if (store.getState().loading)
                    store.setState({ loading: false, error: happyAgentUserError(error) }, false);
                schedule();
            },
        );
    }

    const reread = (): void => {
        timerCancel();
        load();
    };

    const refused = (error: unknown): void => {
        store.setState({ notice: { type: "refused", error: happyAgentUserError(error) } }, false);
    };

    /** Marks one person or invitation as changing until the gateway answers. */
    const change = (
        id: string,
        send: () => Promise<unknown>,
        done: (answer: unknown) => void = () => undefined,
        failed: (error: unknown) => void = (error) => {
            refusals.set(id, happyAgentUserError(error));
            publish();
        },
    ): void => {
        if (disposed || saving.has(id)) return;
        saving.add(id);
        refusals.delete(id);
        publish();
        void send().then(
            (answer) => {
                saving.delete(id);
                if (disposed) return;
                done(answer);
                publish();
                reread();
            },
            (error: unknown) => {
                saving.delete(id);
                if (disposed) return;
                publish();
                failed(error);
            },
        );
    };

    const person = (personId: string): string => `${ROUTE}/people/${encodeURIComponent(personId)}`;

    return {
        get: store.getState,
        subscribe(listener) {
            const unsubscribe = store.subscribe(listener);
            listeners.add(listener);
            if (listeners.size === 1) load();
            return () => {
                unsubscribe();
                listeners.delete(listener);
                if (listeners.size === 0) timerCancel();
            };
        },
        invitationCreate() {
            if (disposed || store.getState().inviting) return;
            const { notice: _previous, ...rest } = store.getState();
            store.setState({ ...rest, inviting: true }, true);
            void deps.request("POST", `${ROUTE}/invitations`, {}).then(
                (answer) => {
                    if (disposed) return;
                    const notice = linkNoticeOf(answer);
                    store.setState({ inviting: false, ...(notice ? { notice } : {}) }, false);
                    reread();
                },
                (error: unknown) => {
                    if (disposed) return;
                    store.setState({ inviting: false }, false);
                    refused(error);
                },
            );
        },
        invitationWithdraw(invitationId) {
            change(
                invitationId,
                () =>
                    deps.request(
                        "DELETE",
                        `${ROUTE}/invitations/${encodeURIComponent(invitationId)}`,
                    ),
                undefined,
                refused,
            );
        },
        passwordLinkCreate(personId) {
            const name = store.getState().people.find((entry) => entry.id === personId)?.name;
            change(
                personId,
                () => deps.request("POST", `${person(personId)}/password-link`, {}),
                (answer) => {
                    const notice = linkNoticeOf(answer, name);
                    if (notice) store.setState({ notice }, false);
                },
            );
        },
        personRemove(personId) {
            change(personId, () => deps.request("POST", `${person(personId)}/remove`, {}));
        },
        personRestore(personId) {
            change(personId, () => deps.request("POST", `${person(personId)}/restore`, {}));
        },
        noticeDismiss() {
            const { notice: _dismissed, ...rest } = store.getState();
            store.setState(rest, true);
        },
        [Symbol.dispose]() {
            disposed = true;
            timerCancel();
            listeners.clear();
        },
    };
}

const INERT_SNAPSHOT: HappyGatewayMembersSnapshot = {
    loading: false,
    access: "absent",
    people: [],
    invitations: [],
    inviting: false,
};

/** Where no gateway can answer: it never reads and never changes. */
export const happyGatewayMembersStoreNoop: HappyGatewayMembersStore = {
    get: () => INERT_SNAPSHOT,
    subscribe: () => () => undefined,
    invitationCreate: () => undefined,
    invitationWithdraw: () => undefined,
    passwordLinkCreate: () => undefined,
    personRemove: () => undefined,
    personRestore: () => undefined,
    noticeDismiss: () => undefined,
    [Symbol.dispose]: () => undefined,
};
