import { expect, it, vi } from "vitest";
import {
    happyGatewayGeminiStoreCreate,
    type HappyGatewayGeminiConfig,
} from "./happyGatewayGeminiStore.js";

const path = "/v0/cloud/providers/google-gemini";
const fixture = { id: "gemini-fixture", name: "Gemini fixture" };
const initial: HappyGatewayGeminiConfig = {
    revision: "initial",
    keyPresent: false,
    enabled: false,
    modelIds: [],
    candidates: [],
    refreshedAt: null,
};

it("keeps discovery separate from active models and recovers stale writes without replay", async () => {
    let config = initial;
    let mode = "normal";
    let writes = 0;
    let validWriteOnlyTransport = true;
    const value = crypto.randomUUID();
    const request: typeof fetch = async (input, init) => {
        const url = String(input);
        validWriteOnlyTransport &&=
            init?.cache === "no-store" &&
            init.redirect === "error" &&
            init.credentials === "same-origin" &&
            !url.includes(value);
        if (!init?.method) return Response.json({ ...config, ignored: value });
        writes++;
        if (new Headers(init.headers).get("If-Match") !== config.revision)
            return Response.json(
                { error: { code: "stale_state", message: value } },
                { status: 409 },
            );
        if (url === `${path}/credentials` && init.method === "PUT") {
            validWriteOnlyTransport &&= JSON.parse(String(init.body)).secret === value;
            config = { ...config, revision: `${writes}`, keyPresent: true };
        } else if (url === `${path}/refresh`) {
            validWriteOnlyTransport &&= init.body === undefined;
            if (mode === "failure")
                return Response.json({ error: { message: value } }, { status: 502 });
            config = {
                ...config,
                revision: `${writes}`,
                candidates: mode === "empty" ? [] : [fixture],
                refreshedAt: "2026-01-01T12:00:00Z",
            };
        } else if (url === `${path}/models`) {
            validWriteOnlyTransport &&= !String(init.body).includes(value);
            config = { ...config, ...JSON.parse(String(init.body)), revision: `${writes}` };
        } else if (url === `${path}/credentials` && init.method === "DELETE") {
            config = { ...initial, revision: `${writes}` };
        } else throw new Error("Unexpected fixture route");
        return Response.json(config);
    };
    const store = happyGatewayGeminiStoreCreate(request);
    const stop = store.subscribe(() => undefined);
    const idle = () => vi.waitFor(() => expect(store.get().busy).toBeUndefined());
    try {
        await vi.waitFor(() => expect(store.get().access).toBe("ready"));
        store.keySave(value);
        await idle();
        expect(store.get().config?.keyPresent).toBe(true);
        mode = "empty";
        store.catalogVerify();
        await idle();
        expect(store.get().config?.candidates).toEqual([]);
        mode = "normal";
        store.catalogVerify();
        await idle();
        expect(store.get().config?.candidates).toEqual([fixture]);
        expect(store.get().config?.modelIds).toEqual([]);
        expect(config.enabled).toBe(false);
        mode = "failure";
        store.catalogVerify();
        await idle();
        expect(store.get().error).toMatch(/last successful check/);
        expect(JSON.stringify(store.get()).includes(value)).toBe(false);
        config = { ...config, revision: "concurrent" };
        const previousWrites = writes;
        store.modelEnabledUpdate(fixture.id, true);
        await vi.waitFor(() => expect(store.get().config?.revision).toBe("concurrent"));
        expect(writes).toBe(previousWrites + 1);
        expect(config.enabled).toBe(false);
        expect(store.get().config?.modelIds).toEqual([]);
        const writesBeforeEnable = writes;
        store.modelEnabledUpdate(fixture.id, true);
        expect(store.get().config?.enabled).toBe(false);
        await idle();
        expect(writes).toBe(writesBeforeEnable + 1);
        expect(config.modelIds).toEqual([fixture.id]);
        expect(config.enabled).toBe(true);
        const enabledRevision = config.revision;
        const enabledWrites = writes;
        store.providerEnabledUpdate(false);
        store.modelEnabledUpdate(fixture.id, false);
        store.keyDisconnect("wrong-revision");
        expect(writes).toBe(enabledWrites);
        expect(config.modelIds).toEqual([fixture.id]);
        expect(config.enabled).toBe(true);
        expect(config.keyPresent).toBe(true);
        store.keyDisconnect(enabledRevision);
        await idle();
        expect(config.keyPresent).toBe(false);
        expect(config.candidates).toEqual([]);
        expect(validWriteOnlyTransport).toBe(true);
    } finally {
        stop();
    }
});

it("loads model context directly from the credential save and ignores malformed or absent limits", async () => {
    const request = vi.fn<typeof fetch>(async (_input, init) => {
        if (!init?.method) return Response.json(initial);
        expect(init.method).toBe("PUT");
        return Response.json({
            ...initial,
            revision: "verified",
            keyPresent: true,
            candidates: [
                { ...fixture, contextWindow: 1048576 },
                { id: "legacy", name: "Legacy" },
                { id: "invalid", name: "Invalid", contextWindow: "128000" },
                { id: "fractional", name: "Fractional", contextWindow: 0.5 },
            ],
        });
    });
    const store = happyGatewayGeminiStoreCreate(request);
    const unsubscribe = store.subscribe(() => undefined);
    try {
        await vi.waitFor(() => expect(store.get().access).toBe("ready"));
        store.keySave(crypto.randomUUID());
        await vi.waitFor(() => expect(store.get().config?.revision).toBe("verified"));
        expect(store.get().config?.candidates).toEqual([
            { ...fixture, contextWindow: 1048576 },
            { id: "legacy", name: "Legacy" },
            { id: "invalid", name: "Invalid" },
            { id: "fractional", name: "Fractional" },
        ]);
        expect(store.get().config?.modelIds).toEqual([]);
        expect(store.get().config?.enabled).toBe(false);
        expect(request.mock.calls.map(([url]) => url)).toEqual([path, `${path}/credentials`]);
    } finally {
        unsubscribe();
    }
});

it("does not issue management mutations after an owner-only read is refused", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(null, { status: 403 }));
    const store = happyGatewayGeminiStoreCreate(request);
    const stop = store.subscribe(() => undefined);
    try {
        await vi.waitFor(() => expect(store.get().access).toBe("absent"));
        store.keySave(crypto.randomUUID());
        store.catalogVerify();
        store.providerEnabledUpdate(true);
        expect(request).toHaveBeenCalledTimes(1);
    } finally {
        stop();
    }
});

it("activates an old staged selection only on a nonempty edit confirmed by the server", async () => {
    const staged = {
        ...initial,
        keyPresent: true,
        modelIds: ["existing", fixture.id],
        candidates: [fixture],
    };
    let rateLimited = true;
    const request = vi.fn<typeof fetch>(async (url, init) => {
        if (!init?.method) return Response.json(staged);
        expect(url).toBe(`${path}/models`);
        expect(init.method).toBe("PUT");
        expect(new Headers(init.headers).get("If-Match")).toBe(staged.revision);
        const update = JSON.parse(String(init.body));
        expect(update).toEqual({ enabled: true, modelIds: ["existing"] });
        if (rateLimited) return Response.json({ error: { code: "too_soon" } }, { status: 429 });
        return Response.json({ ...staged, ...update, revision: "enabled" });
    });
    const store = happyGatewayGeminiStoreCreate(request);
    const stop = store.subscribe(() => undefined);
    try {
        await vi.waitFor(() => expect(store.get().config).toEqual(staged));
        expect(request).toHaveBeenCalledTimes(1);
        store.modelEnabledUpdate(fixture.id, false);
        await vi.waitFor(() => expect(store.get().error).toContain("This switch wasn’t saved"));
        expect(store.get().config).toEqual(staged);
        expect(request).toHaveBeenCalledTimes(2);
        rateLimited = false;
        store.modelEnabledUpdate(fixture.id, false);
        await vi.waitFor(() => expect(store.get().config?.revision).toBe("enabled"));
        expect(store.get().config).toMatchObject({
            enabled: true,
            modelIds: ["existing"],
            keyPresent: true,
        });
        expect(request).toHaveBeenCalledTimes(3);
    } finally {
        stop();
    }
});

it("keeps saved undiscovered models through other toggles and preserves confirmed state on refusal", async () => {
    const absent = "older-fixture";
    let config = {
        ...initial,
        keyPresent: true,
        enabled: true,
        modelIds: [absent],
        candidates: [fixture],
    };
    let refuse = false;
    let cooling = false;
    const request = vi.fn<typeof fetch>(async (_input, init) => {
        if (!init?.method) return Response.json(config);
        expect(new Headers(init.headers).get("If-Match")).toBe(config.revision);
        if (cooling) return Response.json({ error: { code: "too_soon" } }, { status: 429 });
        if (refuse) return Response.json({ error: { code: "apply_rolled_back" } }, { status: 502 });
        const { modelIds, enabled } = JSON.parse(String(init.body));
        config = { ...config, modelIds, enabled, revision: `${Number(config.revision) || 0}1` };
        return Response.json(config);
    });
    const store = happyGatewayGeminiStoreCreate(request);
    const stop = store.subscribe(() => undefined);
    const idle = () => vi.waitFor(() => expect(store.get().busy).toBeUndefined());
    try {
        await vi.waitFor(() => expect(store.get().access).toBe("ready"));
        expect(request).toHaveBeenCalledTimes(1);
        store.modelEnabledUpdate(fixture.id, true);
        expect(store.get().config?.modelIds).toEqual([absent]);
        await idle();
        expect(store.get().config?.modelIds).toEqual([absent, fixture.id]);
        refuse = true;
        store.modelEnabledUpdate(absent, false);
        await idle();
        expect(store.get().config?.modelIds).toEqual([absent, fixture.id]);
        expect(store.get().error).toContain("previous settings were restored");
        expect(request).toHaveBeenCalledTimes(3);
        refuse = false;
        store.modelEnabledUpdate(absent, false);
        await idle();
        store.modelEnabledUpdate(absent, true);
        expect(store.get().config?.modelIds).toEqual([fixture.id]);
        expect(request).toHaveBeenCalledTimes(4);
        cooling = true;
        store.keyDisconnect(config.revision);
        await idle();
        expect(store.get().config?.modelIds).toEqual([fixture.id]);
        expect(store.get().config?.enabled).toBe(true);
        expect(store.get().config?.keyPresent).toBe(true);
        expect(store.get().error).toContain("Try again shortly");
        expect(request).toHaveBeenCalledTimes(5);
    } finally {
        stop();
    }
});
