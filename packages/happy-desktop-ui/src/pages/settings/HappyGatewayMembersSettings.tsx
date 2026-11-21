import { useState } from "react";
import { Banner } from "../../Banner";
import { Box } from "../../Box";
import { Button } from "../../Button";
import { CopyButton } from "../../CopyButton";
import { Modal } from "../../Modal";
import { ModalOverlay } from "../../ModalOverlay";
import { Spinner } from "../../Spinner";
import { TextField } from "../../TextField";
import { HappyAgentSettingsSection } from "./HappyAgentSettingsShell";

export interface HappyGatewayPersonRow {
    readonly id: string;
    readonly name: string;
    /** The owner's view only. */
    readonly email?: string;
    readonly role: "owner" | "member";
    readonly status: "active" | "no_password" | "removed";
    readonly self: boolean;
    /** When they last signed in, already worded. */
    readonly lastSignIn: string;
    readonly saving: boolean;
    /** Why the last change to this person was refused. */
    readonly refusal?: string;
}

export interface HappyGatewayInvitationRow {
    readonly id: string;
    /** Who it is for and when it ends, already worded. */
    readonly label: string;
    readonly detail: string;
    readonly saving: boolean;
}

export type HappyGatewayMembersNoticeView =
    | {
          readonly type: "link";
          /** What the link is and how long it lasts, already worded. */
          readonly title: string;
          readonly link: string;
      }
    | { readonly type: "refused"; readonly message: string };

export interface HappyGatewayMembersSettingsProps {
    readonly loading: boolean;
    readonly error?: string;
    /** Whether the reader is the owner, who alone invites, removes and restores. */
    readonly manage: boolean;
    readonly people: readonly HappyGatewayPersonRow[];
    readonly invitations: readonly HappyGatewayInvitationRow[];
    readonly inviting: boolean;
    readonly notice?: HappyGatewayMembersNoticeView;
    onInvite: () => void;
    onInvitationWithdraw: (invitationId: string) => void;
    onPasswordLink: (personId: string) => void;
    onRemove: (personId: string) => void;
    onRestore: (personId: string) => void;
    onNoticeDismiss: () => void;
}

const STATUS_LABELS: Record<HappyGatewayPersonRow["status"], string> = {
    active: "Active",
    no_password: "No password yet",
    removed: "Removed",
};

/**
 * Settings › Members on a server behind Happy Gateway: everyone sees who may
 * use the server; its owner also invites people with a link, makes password
 * links, and removes and restores people.
 */
export function HappyGatewayMembersSettings(props: HappyGatewayMembersSettingsProps) {
    const [removing, setRemoving] = useState<HappyGatewayPersonRow | undefined>();
    if (props.error)
        return (
            <Banner tone="danger" title="Members unavailable">
                {props.error}
            </Banner>
        );
    if (props.loading)
        return (
            <Box className="happy-agent-settings__pending">
                <Spinner size={16} />
                <span>Reading the members…</span>
            </Box>
        );
    return (
        <div className="happy-agent-members" data-happy-desktop-ui="happy-gateway-members">
            <HappyAgentSettingsSection
                description={
                    props.manage
                        ? "Everyone who can sign in to this server. Removing someone signs them out at once; restoring them lets them sign in again with their password."
                        : "Everyone who can sign in to this server. Its owner invites and removes people."
                }
                title="Members"
            >
                <Box className="happy-agent-members__list">
                    {props.people.map((person) => (
                        <Box
                            className="happy-agent-members__row"
                            data-happy-desktop-ui="happy-gateway-person"
                            data-status={person.status}
                            key={person.id}
                        >
                            <Box className="happy-agent-members__text">
                                <span className="happy-agent-members__name">
                                    {person.self ? `${person.name} (you)` : person.name}
                                </span>
                                {person.refusal === undefined ? (
                                    <span className="happy-agent-members__meta">
                                        {[person.email, person.lastSignIn]
                                            .filter((part) => part)
                                            .join(" · ")}
                                    </span>
                                ) : (
                                    <span
                                        className="happy-agent-members__meta"
                                        data-tone="danger"
                                        title={person.refusal}
                                    >
                                        {person.refusal}
                                    </span>
                                )}
                            </Box>
                            {person.saving ? <Spinner size={16} /> : null}
                            <span
                                className="happy-agent-members__role"
                                data-tone={person.status === "removed" ? "danger" : undefined}
                            >
                                {person.role === "owner" ? "Owner" : "Member"} ·{" "}
                                {STATUS_LABELS[person.status]}
                            </span>
                            {props.manage && person.status !== "removed" ? (
                                <Button
                                    disabled={person.saving}
                                    onClick={() => props.onPasswordLink(person.id)}
                                    size="small"
                                    variant="ghost"
                                >
                                    New password link
                                </Button>
                            ) : null}
                            {props.manage && person.role !== "owner" ? (
                                person.status === "removed" ? (
                                    <Button
                                        disabled={person.saving}
                                        onClick={() => props.onRestore(person.id)}
                                        size="small"
                                        variant="secondary"
                                    >
                                        Restore
                                    </Button>
                                ) : (
                                    <Button
                                        aria-label={`Remove ${person.name}`}
                                        disabled={person.saving}
                                        onClick={() => setRemoving(person)}
                                        size="small"
                                        variant="ghost"
                                    >
                                        Remove
                                    </Button>
                                )
                            ) : null}
                        </Box>
                    ))}
                </Box>
            </HappyAgentSettingsSection>
            {props.manage ? (
                <HappyAgentSettingsSection
                    description="An invitation link lets one person join, for seven days. A password link lets someone choose a new password, for a day. Each link is shown only once, so copy it before you close it."
                    title="Invitations"
                >
                    <Box
                        className="happy-agent-members__notice"
                        data-happy-desktop-ui="happy-gateway-notice"
                        data-kind={props.notice?.type ?? "idle"}
                    >
                        {props.notice === undefined ? (
                            <span className="happy-agent-members__meta">
                                Create a link, then send it to the person yourself.
                            </span>
                        ) : props.notice.type === "link" ? (
                            <Box className="happy-agent-members__email">
                                <TextField
                                    aria-label={props.notice.title}
                                    fullWidth
                                    readOnly
                                    size="small"
                                    value={props.notice.link}
                                />
                            </Box>
                        ) : (
                            <Box className="happy-agent-members__text">
                                <span
                                    className="happy-agent-members__refused"
                                    data-tone="danger"
                                    title={props.notice.message}
                                >
                                    {props.notice.message}
                                </span>
                            </Box>
                        )}
                        {props.notice?.type === "link" ? (
                            <CopyButton
                                caption="Copy link"
                                label="Copy link"
                                text={props.notice.link}
                            />
                        ) : null}
                        {props.notice === undefined ? null : (
                            <Button onClick={props.onNoticeDismiss} size="small" variant="ghost">
                                Done
                            </Button>
                        )}
                    </Box>
                    {props.notice?.type === "link" ? (
                        <span
                            className="happy-agent-members__meta"
                            data-happy-desktop-ui="happy-gateway-notice-title"
                        >
                            {props.notice.title} Shown only once: copy it now.
                        </span>
                    ) : null}
                    <Box className="happy-agent-members__actions">
                        <Button
                            loading={props.inviting}
                            onClick={props.onInvite}
                            size="small"
                            variant="secondary"
                        >
                            Create invitation link
                        </Button>
                    </Box>
                    {props.invitations.map((invitation) => (
                        <Box
                            className="happy-agent-members__row"
                            data-happy-desktop-ui="happy-gateway-invitation"
                            key={invitation.id}
                        >
                            <Box className="happy-agent-members__text">
                                <span className="happy-agent-members__name">
                                    {invitation.label}
                                </span>
                                <span className="happy-agent-members__meta">
                                    {invitation.detail}
                                </span>
                            </Box>
                            <Button
                                disabled={invitation.saving}
                                onClick={() => props.onInvitationWithdraw(invitation.id)}
                                size="small"
                                variant="ghost"
                            >
                                Withdraw
                            </Button>
                        </Box>
                    ))}
                </HappyAgentSettingsSection>
            ) : null}
            {removing ? (
                <ModalOverlay onDismiss={() => setRemoving(undefined)}>
                    <Modal
                        footer={
                            <>
                                <Button onClick={() => setRemoving(undefined)} variant="ghost">
                                    Cancel
                                </Button>
                                <Button
                                    onClick={() => {
                                        props.onRemove(removing.id);
                                        setRemoving(undefined);
                                    }}
                                    variant="danger"
                                >
                                    Remove
                                </Button>
                            </>
                        }
                        onClose={() => setRemoving(undefined)}
                        size="small"
                        title={`Remove ${removing.name}?`}
                        tone="danger"
                    >
                        <Box className="happy-agent-members__confirm">
                            <p>
                                They are signed out at once and cannot sign in until you restore
                                them. Their conversations stay.
                            </p>
                        </Box>
                    </Modal>
                </ModalOverlay>
            ) : null}
        </div>
    );
}
