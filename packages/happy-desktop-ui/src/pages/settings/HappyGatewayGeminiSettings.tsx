import { useState } from "react";
import { Banner } from "../../Banner";
import { Box } from "../../Box";
import { Button } from "../../Button";
import { ConfirmPopover } from "../../ConfirmPopover";
import { IconTile } from "../../IconTile";
import { Spinner } from "../../Spinner";
import { Switch } from "../../Switch";
import { TextField } from "../../TextField";
import { HappyAgentSettingsSection } from "./HappyAgentSettingsShell";
import { HappyAgentSettingsStatus } from "./HappyAgentSettingsStatus";
import {
    HappyAgentProviderModelToggle,
    modelMeta,
    type HappyAgentProviderModelRow,
} from "./HappyAgentProviderSettings";

export interface HappyGatewayGeminiSettingsProps {
    readonly loading?: boolean;
    readonly unavailable?: boolean;
    readonly locked?: boolean;
    readonly busy?: boolean;
    readonly error?: string;
    readonly config?: {
        readonly revision: string;
        readonly keyPresent: boolean;
        readonly enabled: boolean;
        readonly modelIds: readonly string[];
        readonly candidates: readonly {
            readonly id: string;
            readonly name: string;
            readonly contextWindow?: number;
        }[];
        readonly refreshedAt: string | null;
    };
    readonly catalogModels?: readonly HappyAgentProviderModelRow[];
    readonly onKeySave: (key: string) => void;
    readonly onDisconnect: (revision: string) => void;
    readonly onVerify: () => void;
    readonly onModelEnabledChange: (id: string, enabled: boolean) => void;
    readonly onProviderEnabledChange: (enabled: boolean) => void;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function HappyGatewayGeminiSettings(props: HappyGatewayGeminiSettingsProps) {
    const [keyDraft, setKeyDraft] = useState<string | undefined>();
    const [disconnectRevision, setDisconnectRevision] = useState<string>();
    const config = props.config;
    const locked = props.locked || props.busy;
    const candidates = new Map(config?.candidates.map((row) => [row.id, row]));
    const catalog = new Map(props.catalogModels?.map((row) => [row.modelId, row]));
    const modelIds = [...new Set([...candidates.keys(), ...(config?.modelIds ?? [])])];
    const keySubmit = () => {
        if (locked || !keyDraft?.trim()) return;
        setKeyDraft(undefined);
        props.onKeySave(keyDraft);
    };
    return (
        <HappyAgentSettingsSection>
            <article
                className="happy-agent-provider"
                data-happy-desktop-ui="gateway-gemini-settings"
                aria-busy={props.loading || props.busy}
            >
                <header className="happy-agent-provider__header">
                    <Box className="happy-agent-provider__identity">
                        <IconTile icon="globe" tone="indigo" />
                        <Box className="happy-agent-provider__naming">
                            <span className="happy-agent-provider__name">Google Gemini</span>
                            <span className="happy-agent-provider__meta">
                                Selecting a model enables Gemini and makes that model available in
                                chat.
                            </span>
                        </Box>
                    </Box>
                    {config ? (
                        <HappyAgentSettingsStatus
                            label={
                                config.enabled
                                    ? "Enabled"
                                    : config.keyPresent
                                      ? "Disabled"
                                      : "Not connected"
                            }
                            variant={config.enabled ? "success" : "neutral"}
                        />
                    ) : null}
                    {props.loading || props.busy ? <Spinner size={16} /> : null}
                    {config ? (
                        <Box className="happy-agent-provider__account">
                            <Switch
                                aria-label="Google Gemini enabled"
                                checked={config.enabled}
                                disabled={
                                    locked ||
                                    !config.keyPresent ||
                                    (!config.enabled && config.modelIds.length === 0)
                                }
                                onChange={(enabled) => {
                                    if (enabled) props.onProviderEnabledChange(true);
                                    else setDisconnectRevision(config.revision);
                                }}
                            />
                            {disconnectRevision === config.revision ? (
                                <Box className="happy-agent-provider__account-confirm">
                                    <ConfirmPopover
                                        title="Disconnect Google Gemini?"
                                        message="This deletes the stored API key and clears the model selection. Workbench cannot recover the key. The inference runtime may restart."
                                        confirmLabel="Delete key and disconnect"
                                        tone="danger"
                                        onCancel={() => setDisconnectRevision(undefined)}
                                        onConfirm={() => {
                                            setDisconnectRevision(undefined);
                                            if (!locked) props.onDisconnect(disconnectRevision);
                                        }}
                                    />
                                </Box>
                            ) : null}
                        </Box>
                    ) : null}
                </header>
                {props.unavailable ? (
                    <Banner tone="warning" title="Gemini settings unavailable">
                        Waiting for the Gateway to answer.
                    </Banner>
                ) : null}
                {props.error ? (
                    <Banner tone="warning" title="Google Gemini">
                        {props.error}
                    </Banner>
                ) : null}
                {config?.keyPresent ? (
                    <Box className="happy-agent-provider__models">
                        {modelIds.map((id) => {
                            const model = catalog.get(id);
                            const candidate = candidates.get(id);
                            const checked = config.modelIds.includes(id);
                            const description = modelMeta({
                                modelId: id,
                                contextWindow: candidate?.contextWindow ?? model?.contextWindow,
                                efforts: model?.efforts ?? [],
                            });
                            const hint = !candidates.has(id)
                                ? "Not in latest discovery"
                                : undefined;
                            const last = config.enabled && checked && config.modelIds.length === 1;
                            return (
                                <HappyAgentProviderModelToggle
                                    key={id}
                                    name={candidate?.name ?? model?.name ?? id}
                                    description={[
                                        description,
                                        hint,
                                        last
                                            ? "Turning off this model disconnects Gemini and deletes its key"
                                            : undefined,
                                    ]
                                        .filter(Boolean)
                                        .join(" — ")}
                                    checked={checked}
                                    disabled={locked}
                                    onChange={(enabled) => {
                                        if (last && !enabled)
                                            setDisconnectRevision(config.revision);
                                        else props.onModelEnabledChange(id, enabled);
                                    }}
                                />
                            );
                        })}
                        {modelIds.length === 0 ? (
                            <span
                                className="happy-agent-provider__models-empty"
                                data-happy-desktop-ui="happy-agent-provider-models-empty"
                            >
                                No eligible models were discovered.
                            </span>
                        ) : null}
                    </Box>
                ) : null}
                {config ? (
                    <Box className="happy-agent-provider__keys">
                        <Box className="happy-agent-provider__add">
                            <Button
                                disabled={locked}
                                onClick={() => setKeyDraft("")}
                                size="small"
                                variant="secondary"
                            >
                                {config.keyPresent ? "Replace key" : "Connect"}
                            </Button>
                            {config.keyPresent ? (
                                <>
                                    <Button
                                        disabled={locked}
                                        onClick={props.onVerify}
                                        size="small"
                                        variant="secondary"
                                    >
                                        Verify with Google
                                    </Button>
                                    <Box className="happy-agent-provider__account">
                                        <Button
                                            disabled={locked}
                                            onClick={() => setDisconnectRevision(config.revision)}
                                            size="small"
                                            variant="ghost"
                                        >
                                            Disconnect
                                        </Button>
                                    </Box>
                                </>
                            ) : null}
                        </Box>
                        {keyDraft !== undefined ? (
                            <Box className="happy-agent-provider__key-form">
                                <TextField
                                    autoComplete="off"
                                    autoFocus
                                    disabled={locked}
                                    label="Google Gemini API key"
                                    onSubmit={keySubmit}
                                    onValueChange={setKeyDraft}
                                    type="password"
                                    value={keyDraft}
                                />
                                <Box className="happy-agent-provider__add">
                                    <Button
                                        disabled={locked || !keyDraft.trim()}
                                        onClick={keySubmit}
                                        size="small"
                                    >
                                        Verify and save key
                                    </Button>
                                    <Button
                                        onClick={() => setKeyDraft(undefined)}
                                        size="small"
                                        variant="ghost"
                                    >
                                        Cancel
                                    </Button>
                                </Box>
                            </Box>
                        ) : null}
                        {config.keyPresent ? (
                            <>
                                <span className="happy-agent-provider__keys-note">
                                    {config.refreshedAt === null
                                        ? "Models have not been verified."
                                        : `Last verified ${dateFormat.format(new Date(config.refreshedAt))}.`}
                                </span>
                            </>
                        ) : null}
                    </Box>
                ) : null}
            </article>
        </HappyAgentSettingsSection>
    );
}
