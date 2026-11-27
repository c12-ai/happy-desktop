import { useState } from "react";
import { Banner } from "../../Banner";
import { Box } from "../../Box";
import { Button } from "../../Button";
import { Checkbox } from "../../Checkbox";
import { ConfirmPopover } from "../../ConfirmPopover";
import { IconTile } from "../../IconTile";
import { Spinner } from "../../Spinner";
import { TextField } from "../../TextField";
import { HappyAgentSettingsSection } from "./HappyAgentSettingsShell";
import { HappyAgentSettingsStatus } from "./HappyAgentSettingsStatus";

export interface HappyGatewayGeminiSettingsProps {
    readonly loading?: boolean;
    readonly unavailable?: boolean;
    readonly locked?: boolean;
    readonly busy?: boolean;
    readonly error?: string;
    readonly config?: {
        readonly keyPresent: boolean;
        readonly enabled: boolean;
        readonly modelIds: readonly string[];
        readonly candidates: readonly { readonly id: string; readonly name: string }[];
        readonly refreshedAt: string | null;
    };
    readonly selected: readonly string[];
    readonly onKeySave: (key: string) => void;
    readonly onDisconnect: () => void;
    readonly onVerify: () => void;
    readonly onModelSelect: (id: string, selected: boolean) => void;
    readonly onModelsSave: (enabled: boolean) => void;
    readonly onDisable: () => void;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function HappyGatewayGeminiSettings(props: HappyGatewayGeminiSettingsProps) {
    const [keyDraft, setKeyDraft] = useState<string | undefined>();
    const [confirming, setConfirming] = useState(false);
    const config = props.config;
    const locked = props.locked || props.busy;
    const eligibleSelection = props.selected.filter((id) =>
        config?.candidates.some((row) => row.id === id),
    );
    const changed =
        eligibleSelection.length !== config?.modelIds.length ||
        eligibleSelection.some((id) => !config.modelIds.includes(id));
    const unavailableModels = config?.modelIds.some(
        (id) => !config.candidates.some((row) => row.id === id),
    );
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
                                Only saved, enabled models appear in chat.
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
                                            onClick={() => setConfirming(!confirming)}
                                            size="small"
                                            variant="ghost"
                                        >
                                            Disconnect
                                        </Button>
                                        {confirming ? (
                                            <Box className="happy-agent-provider__account-confirm">
                                                <ConfirmPopover
                                                    title="Disconnect Google Gemini?"
                                                    message="This removes the stored key and model selection. The inference runtime may restart."
                                                    confirmLabel="Disconnect"
                                                    tone="danger"
                                                    onCancel={() => setConfirming(false)}
                                                    onConfirm={() => {
                                                        setConfirming(false);
                                                        if (!locked) props.onDisconnect();
                                                    }}
                                                />
                                            </Box>
                                        ) : null}
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
                                {unavailableModels ? (
                                    <Banner
                                        tone="warning"
                                        title="Some saved models were not discovered"
                                    >
                                        Review the remaining models and save a new selection.
                                    </Banner>
                                ) : null}
                                {config.candidates.length === 0 ? (
                                    <span className="happy-agent-provider__keys-note">
                                        No eligible models were discovered.
                                    </span>
                                ) : null}
                                {config.candidates.map(({ id, name }) => (
                                    <Checkbox
                                        key={id}
                                        label={name === id ? id : `${name} · ${id}`}
                                        checked={props.selected.includes(id)}
                                        disabled={locked}
                                        onChange={(selected) => props.onModelSelect(id, selected)}
                                    />
                                ))}
                                <Box className="happy-agent-provider__add">
                                    <Button
                                        disabled={
                                            locked ||
                                            !changed ||
                                            (config.enabled && !eligibleSelection.length)
                                        }
                                        onClick={() => props.onModelsSave(config.enabled)}
                                        size="small"
                                        variant="secondary"
                                    >
                                        Save models
                                    </Button>
                                    <Button
                                        disabled={
                                            locked || (!config.enabled && !eligibleSelection.length)
                                        }
                                        onClick={() =>
                                            config.enabled
                                                ? props.onDisable()
                                                : props.onModelsSave(true)
                                        }
                                        size="small"
                                        variant="secondary"
                                    >
                                        {config.enabled
                                            ? "Disable"
                                            : changed
                                              ? "Save and enable"
                                              : "Enable"}
                                    </Button>
                                </Box>
                            </>
                        ) : null}
                    </Box>
                ) : null}
            </article>
        </HappyAgentSettingsSection>
    );
}
