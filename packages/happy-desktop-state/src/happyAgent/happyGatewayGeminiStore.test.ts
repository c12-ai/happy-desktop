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
        expect(store.get().selected).toEqual([]);
        expect(config.enabled).toBe(false);
        mode = "failure";
        store.catalogVerify();
        await idle();
        expect(store.get().error).toMatch(/last successful check/);
        expect(JSON.stringify(store.get()).includes(value)).toBe(false);
        store.modelSelect(fixture.id, true);
        config = { ...config, revision: "concurrent" };
        const previousWrites = writes;
        store.modelsSave(true);
        await vi.waitFor(() => expect(store.get().config?.revision).toBe("concurrent"));
        expect(writes).toBe(previousWrites + 1);
        expect(config.enabled).toBe(false);
        expect(store.get().selected).toEqual([]);
        store.modelSelect(fixture.id, true);
        store.modelsSave(false);
        await idle();
        expect(config.modelIds).toEqual([fixture.id]);
        expect(config.enabled).toBe(false);
        store.modelsSave(true);
        await idle();
        expect(config.enabled).toBe(true);
        store.modelSelect(fixture.id, false);
        store.providerDisable();
        await idle();
        expect(config.modelIds).toEqual([fixture.id]);
        expect(config.enabled).toBe(false);
        store.keyDisconnect();
        await idle();
        expect(config.keyPresent).toBe(false);
        expect(config.candidates).toEqual([]);
        expect(validWriteOnlyTransport).toBe(true);
    } finally {
        stop();
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
        store.modelsSave(true);
        expect(request).toHaveBeenCalledTimes(1);
    } finally {
        stop();
    }
});
