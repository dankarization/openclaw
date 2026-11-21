import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { assertAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { runtimeConfigPublication } from "../config/runtime-config-publication.js";
import { getRuntimeConfigSnapshotMetadata } from "../config/runtime-snapshot.js";
import type { SessionEntry } from "../config/sessions.js";
import { canReadSessionAccess } from "../config/sessions/session-access.js";
import { resolveSqliteSessionKey } from "../config/sessions/session-accessor.sqlite-scope-helpers.js";
import { withSessionSourceValidation } from "../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { operatorScopeSatisfied } from "../shared/operator-scope-compat.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  prepareUserProfileRoleAuthority,
  prepareUserProfileSelectionAuthority,
} from "../state/user-channel-identity-operations.js";
import type { UserProfileIdentity } from "../state/user-profiles.types.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import { readGatewayAccessRevision } from "./gateway-access-revision.js";
import { openclawIdSubjectRolePolicy } from "./openclaw-id/tunnel-principal.js";
import {
  isNamedOperatorRoleEnforcementEnabled,
  isOperatorRoleEnforcedFor,
  operatorRoleSubject,
} from "./operator-role-enforcement.js";
import {
  authorizeCurrentOperatorRoleScopes,
  operatorSessionCap,
  resolveGatewayOperatorRoleActor,
  resolveOperatorRolePolicy,
  resolveOperatorRolePolicyForAssignment,
} from "./operator-role-policy.js";
import { authenticatedProfileUnavailableError } from "./server-methods/gateway-client-identity.js";
import type { GatewayClient, SessionMutationAuthorization } from "./server-methods/types.js";
import { resolveTelegramSessionDirect } from "./session-channel-direct-read.js";
import { resolveTelegramSessionGroup } from "./session-channel-group.js";
import {
  readTelegramSessionMembership,
  telegramSessionMembershipKey,
} from "./session-channel-read.js";
import { isSessionCreatorProfile, prepareSessionCreatorProfile } from "./session-creator.js";
import {
  SessionMutationAuthorizationChangedError,
  SessionSharingProfileFactsChangedError,
} from "./session-mutation-authorization-error.js";
import {
  authorizeSessionSharingTarget,
  canManageSessionSharing,
  isGatewayAdmin,
  isSessionSharingOwnerEquivalent,
  prepareSessionSharingRole,
  resolveSessionVisibility,
  sharingIdentity,
  type SessionSharingRoleParams,
  type SessionSharingTarget,
  type withSessionSharingTarget,
} from "./session-sharing-policy.js";
import type { GatewaySessionStoreSelection } from "./session-utils-store-retained.js";

export function canReceiveSessionEvent(params: {
  cfg: OpenClawConfig;
  policyConfig?: OpenClawConfig;
  client: GatewayClient;
  sessionKeys: readonly string[];
  agentId?: string;
  event?: string;
  payload?: unknown;
  prepared: {
    sharing:
      | ReturnType<typeof prepareSessionSharing>
      | (() => ReturnType<typeof prepareSessionSharing>);
    target: (sessionKey: string, agentId?: string) => SessionSharingTarget | null;
  };
}): boolean {
  const { cfg, policyConfig = cfg, client, sessionKeys, event } = params;
  const operatorActor = resolveGatewayOperatorRoleActor(client);
  if (
    operatorActor?.kind === "operator" &&
    authorizeCurrentOperatorRoleScopes(client, policyConfig)
  ) {
    return false;
  }
  if (isGatewayAdmin(client)) {
    return true;
  }
  const identity = sharingIdentity(client, operatorActor);
  if (!identity) {
    return (
      (!operatorScopeSatisfied("operator.sessions.read", client.connect.scopes ?? []) ||
        operatorActor?.kind === "system" ||
        operatorScopeSatisfied("operator.read", client.connect.scopes ?? [])) &&
      (!isNamedOperatorRoleEnforcementEnabled(policyConfig) ||
        isSessionSharingOwnerEquivalent(client, operatorActor)) &&
      event !== "session.suggestion" &&
      event !== "session.typing" &&
      ((Boolean(policyConfig.gateway?.roles) &&
        isSessionSharingOwnerEquivalent(client, operatorActor)) ||
        operatorActor?.kind === "system" ||
        client.authenticatedUserProfile?.profileId === GATEWAY_OWNER_PROFILE_ID ||
        sessionKeys.every((key) => {
          const target = params.prepared.target(key, params.agentId);
          return Boolean(
            target &&
            (!client.authenticatedGitHubIdentitySync ||
              resolveSessionVisibility(target.entry) !== "draft") &&
            canReadSessionAccess(policyConfig, target.canonicalKey, target.entry, () => false),
          );
        }))
    );
  }
  const preparedSharing = params.prepared.sharing;
  const sharing = typeof preparedSharing === "function" ? preparedSharing() : preparedSharing;
  const authorId =
    event === "session.suggestion" && params.payload && typeof params.payload === "object"
      ? (params.payload as { suggestion?: { author?: { id?: unknown } } }).suggestion?.author?.id // SAFETY: publishSuggestion emits SessionSuggestionEvent; this only reads the optional author id.
      : undefined;
  return sessionKeys.every((sessionKey) => {
    const target = params.prepared.target(sessionKey, params.agentId);
    // Deleted rows fail closed; their unscoped catalog invalidation still refreshes readers.
    if (!target) {
      return false;
    }
    const isCreator = sharing.isCreator(target.entry.createdActor);
    if (
      target.entry.incognito === true ||
      isIncognitoSessionKey(target.canonicalKey) ||
      !sharing.canReadTarget(target)
    ) {
      return false;
    }
    if (resolveSessionVisibility(target.entry) === "draft" && !isCreator) {
      return event === "session.typing" && canManageSessionSharing(sharing.roleForTarget(target));
    }
    return (
      event !== "session.suggestion" ||
      authorId === identity.id ||
      sharing.roleForTarget(target) !== "viewer"
    );
  });
}

type ChannelReadEntry = Pick<
  SessionEntry,
  "createdActor" | "createdVia" | "delivery" | "visibility" | "incognito" | "access"
>;

/** Extend a denied read only for a current linked route within the source audience. */
export function canReadChannelSession(params: {
  cfg: OpenClawConfig;
  key: string;
  entry: ChannelReadEntry;
  isCreator: ReturnType<typeof prepareSessionCreatorProfile>;
  scopes: readonly string[];
  channelRead: (key: string, entry: ChannelReadEntry) => boolean;
}): boolean {
  const { cfg, key, entry, isCreator, scopes, channelRead } = params;
  return Boolean(
    entry.visibility !== "draft" &&
    entry.incognito !== true &&
    !isIncognitoSessionKey(key) &&
    canReadSessionAccess(cfg, key, entry, isCreator) &&
    operatorScopeSatisfied("operator.sessions.read", scopes) &&
    (resolveTelegramSessionGroup(key, entry) || resolveTelegramSessionDirect(key, entry)) &&
    channelRead(key, entry),
  );
}

/** Share caller facts across synchronous selection/role projection, never across an await. */
export function prepareSessionSharing(
  params: Pick<SessionSharingRoleParams, "cfg" | "client">,
  prepared?: {
    aliases: ReadonlySet<string>;
    sessionCap: ReturnType<typeof operatorSessionCap>;
    isMember: (target: SessionSharingTarget, identityId: string) => boolean;
    channelRead?: (sessionKey: string, entry: ChannelReadEntry) => boolean;
  },
) {
  const identity = sharingIdentity(params.client, resolveGatewayOperatorRoleActor(params.client));
  const isCreator = prepareSessionCreatorProfile(identity?.id, prepared?.aliases);
  const sessionCap = prepared
    ? prepared.sessionCap
    : params.cfg && operatorSessionCap(params.client, params.cfg);
  const cap = { value: sessionCap };
  const resolveRole = prepareSessionSharingRole(params, cap, isCreator);
  const roleForTarget = (target: SessionSharingTarget, isMember?: boolean) =>
    resolveRole(
      target,
      isMember ?? (prepared && Boolean(identity && prepared.isMember(target, identity.id))),
    );
  const originalEntryFilter = createSessionListEntryFilter(params, isCreator, { sessionCap });
  const originalDirectEntryFilter = createSessionDirectEntryFilter(params, isCreator, {
    sessionCap,
  });
  const guardChannel = (filter: typeof originalEntryFilter): typeof originalEntryFilter => {
    if (!identity || isGatewayAdmin(params.client)) {
      return filter;
    }
    return (key, entry, member) => {
      // A verified channel member must still be inside the stored source audience.
      if (!canReadSessionAccess(params.cfg, key, entry, isCreator)) {
        return false;
      }
      if (filter?.(key, entry, member) !== false) {
        return true;
      }
      return Boolean(
        key &&
        params.cfg &&
        !authorizeCurrentOperatorRoleScopes(params.client, params.cfg) &&
        canReadChannelSession({
          cfg: params.cfg,
          key,
          entry,
          isCreator,
          scopes: params.client?.connect.scopes ?? [],
          channelRead: (channelKey, channelEntry) =>
            prepared?.channelRead?.(channelKey, channelEntry) ??
            readTelegramSessionMembership(params.client, params.cfg!, channelKey, channelEntry),
        }),
      );
    };
  };
  const entryFilter = guardChannel(originalEntryFilter);
  const directEntryFilter = guardChannel(originalDirectEntryFilter);
  return {
    identity,
    isCreator,
    sessionCap,
    entryFilter,
    directEntryFilter,
    canReadDirectTarget: (target: SessionSharingTarget) =>
      directEntryFilter?.(
        target.storeKey,
        target.entry,
        Boolean(sessionCap === "invited" && identity && prepared?.isMember(target, identity.id)),
      ) ?? true,
    canReadTarget: (target: SessionSharingTarget) =>
      entryFilter?.(
        target.storeKey,
        target.entry,
        Boolean(sessionCap === "invited" && identity && prepared?.isMember(target, identity.id)),
      ) ?? true,
    roleForTarget,
    authorizeTarget: (target: SessionSharingTarget, role = roleForTarget(target)) =>
      authorizeSessionSharingTarget({ ...params, target }, { ...cap, role }),
  };
}

export type PreparedSessionSharingProfiles = {
  admit: () => void;
  readCurrent: () => {
    profile: UserProfileIdentity | undefined;
    roleProfile: UserProfileIdentity | undefined;
  };
};

export type PreparedMutationSharing = {
  selection?: GatewaySessionStoreSelection;
  target: SessionSharingTarget | null;
  storageTarget: Pick<SessionSharingTarget, "agentId" | "canonicalKey" | "storePath">;
  members: readonly import("../config/sessions/session-membership-facts.types.js").SessionMember[];
  isMember?: (identityId: string) => boolean;
  assertCurrent: () => void;
};

/** Consume live authority or borrow prepared source facts in one synchronous frame. */
export function createSessionSharingConsumption(params: {
  client: GatewayClient | null;
  sharing: PreparedMutationSharing | undefined;
  getProfiles: () => PreparedSessionSharingProfiles | undefined;
}) {
  const current: {
    sharing: PreparedMutationSharing | undefined;
    profiles: PreparedSessionSharingProfiles | undefined;
    members: readonly string[] | undefined;
  } = { sharing: params.sharing, profiles: params.getProfiles(), members: undefined };
  const isMember = (_target: SessionSharingTarget, id: string) =>
    current.sharing
      ? (current.sharing.isMember?.(id) ??
        current.sharing.members.some((member) => member.identityId === id))
      : (current.members?.includes(id) ?? false);
  return Object.assign(current, {
    policy: (cfg: OpenClawConfig, members?: readonly string[]) => {
      const policy =
        current.sharing || current.profiles
          ? prepareProjectedSessionSharing({
              cfg,
              client: params.client,
              profiles: current.profiles,
              isMember,
              owner: current,
            })
          : undefined;
      current.members = members;
      return policy;
    },
    consume: <T>(
      prepared: PreparedMutationSharing | (() => PreparedMutationSharing) | undefined,
      consume: () => T,
      profiles: PreparedSessionSharingProfiles | undefined = params.getProfiles(),
    ): T =>
      withSessionSourceValidation(() => {
        const previous = {
          sharing: current.sharing,
          profiles: current.profiles,
          members: current.members,
        };
        Object.assign(current, {
          sharing: typeof prepared === "function" ? undefined : prepared,
          profiles,
        });
        try {
          profiles?.readCurrent();
          if (typeof prepared === "function") {
            // The reader validates its owner after the caller check, in this consuming frame.
            current.sharing = prepared();
          } else {
            prepared?.assertCurrent();
          }
          const result = consume();
          if (isPromiseLike(result)) {
            throw new Error("Sharing authorization consumers must remain synchronous");
          }
          return result;
        } finally {
          Object.assign(current, previous);
        }
      }),
  });
}

/** Worker authorization also serves callers without a connection-owned profile projection. */
export async function prepareSessionSharingProfiles(
  client: GatewayClient | null,
  mode: "selection" | "custody" = "selection",
  options: OpenClawStateDatabaseOptions = {},
): Promise<PreparedSessionSharingProfiles> {
  const actor = resolveGatewayOperatorRoleActor(client);
  const actorKind = actor?.kind;
  const identityId = sharingIdentity(client, actor)?.id;
  const roleProfileId = actor?.kind === "operator" ? actor.profileId : undefined;
  const runAuthority = client?.internal?.operatorRunAuthority;
  let admitted = runAuthority !== undefined;
  const unavailable = () => {
    throw new SessionMutationAuthorizationChangedError(authenticatedProfileUnavailableError());
  };
  const requesterChanged = () => {
    throw new SessionMutationAuthorizationChangedError(
      errorShape(ErrorCodes.FORBIDDEN, "Gateway requester authority changed"),
    );
  };
  const prepare = async (profileId: string | undefined) => {
    if (!profileId) {
      return () => undefined;
    }
    const retained = client?.preparedSessionProfile;
    if (retained?.aliases.has(profileId)) {
      const canonicalProfileId = retained.profileId;
      return () => {
        const current = client?.preparedSessionProfile;
        if (!current) {
          return unavailable();
        }
        if (
          !current.aliases.has(profileId) ||
          (mode === "selection" && current.profileId !== canonicalProfileId)
        ) {
          return requesterChanged();
        }
        return admitted ? retained : current;
      };
    }
    const prepared = await prepareUserProfileRoleAuthority(profileId, options);
    const selection = prepared && (await prepareUserProfileSelectionAuthority(profileId, options));
    const profile = prepared && { ...prepared, aliases: new Set(prepared.aliases) };
    return () => {
      if (prepared && !prepared.isCurrent()) {
        prepared.readSource();
        if (!admitted || !selection?.isCurrent() || selection.profileId !== prepared.profileId) {
          throw new SessionSharingProfileFactsChangedError(
            authenticatedProfileUnavailableError(),
            prepared.readSource,
          );
        }
      }
      return profile;
    };
  };
  const readProfile = await prepare(identityId);
  const readRoleProfile = roleProfileId === identityId ? readProfile : await prepare(roleProfileId);
  const readCurrent = () => {
    const currentActor = resolveGatewayOperatorRoleActor(client);
    if (
      currentActor?.kind !== actorKind ||
      (currentActor?.kind === "operator" && currentActor.profileId !== roleProfileId) ||
      sharingIdentity(client, currentActor)?.id !== identityId ||
      client?.internal?.operatorRunAuthority !== runAuthority
    ) {
      return requesterChanged();
    }
    if (runAuthority) {
      assertAdmittedRunOperatorAuthority(runAuthority);
      runAuthority.assertCurrent();
    }
    return { profile: readProfile(), roleProfile: readRoleProfile() };
  };
  readCurrent();
  return {
    readCurrent,
    admit: () => {
      readCurrent();
      admitted = true;
    },
  };
}

/** Refresh changed profile facts only before the synchronous consumer has begun effects. */
async function withCurrentSessionSharingProfiles<T>(
  client: GatewayClient | null,
  read: (profiles: PreparedSessionSharingProfiles, beginConsume: () => void) => Promise<T>,
): Promise<T> {
  let consumed = false;
  let readSource: () => OpenClawStateDatabaseOptions = () => ({});
  for (let attempt = 0; ; attempt += 1) {
    const source = readSource();
    try {
      const profiles = await prepareSessionSharingProfiles(client, "custody", source);
      readSource();
      return await read(profiles, () => {
        consumed = true;
      });
    } catch (error) {
      if (consumed || attempt >= 1 || !(error instanceof SessionSharingProfileFactsChangedError)) {
        throw error;
      }
      readSource = error.readSource;
    }
  }
}

export function createSessionSharingInputAuthority(
  ownedParams: { client: GatewayClient | null; preparedProfiles?: PreparedSessionSharingProfiles },
  authorization: SessionMutationAuthorization,
  readSharing: () => Parameters<Parameters<typeof withSessionSharingTarget>[1]>[0],
): SessionMutationAuthorization["admittedInputAuthority"] {
  const { withCurrent, withPreparedCurrent } = authorization;
  if (!withCurrent || !withPreparedCurrent) {
    return undefined;
  }
  return {
    // Transport/source custody owns lifetime; profile selection ends at input acceptance.
    assertLifetimeCurrent: () => {},
    prepareForSourceScope: () =>
      withCurrentSessionSharingProfiles(ownedParams.client, async (profiles) => {
        profiles.readCurrent();
        ownedParams.preparedProfiles = profiles;
      }),
    withCurrent: (consume) =>
      withCurrentSessionSharingProfiles(ownedParams.client, (profiles, beginConsume) => {
        ownedParams.preparedProfiles = profiles;
        return withCurrent(() => {
          beginConsume();
          const read = readSharing();
          return consume(
            {
              agentId: read.storageTarget.agentId,
              storePath: read.storageTarget.storePath,
              sessionKey: resolveSqliteSessionKey(
                read.target?.storeKey ?? read.storageTarget.canonicalKey,
                read.storageTarget.agentId,
              ),
              entry: read.target?.entry,
              readSource: read.target?.readSource,
              members: read.members,
            },
            read.assertCurrent,
          );
        });
      }),
    withPreparedCurrent,
  };
}

type ProjectedSessionSharing = ReturnType<typeof prepareSessionSharing> & {
  policy: ReturnType<typeof resolveOperatorRolePolicy>;
  getCacheKey: () => string;
};
type ProjectedSharingSnapshot = {
  facts: readonly unknown[];
  key?: string;
  sharing?: ProjectedSessionSharing;
};
const projectedSharingKeys = new WeakMap<object, ProjectedSharingSnapshot>();
const emptyProfileAliases: ReadonlySet<string> = new Set();

export function prepareProjectedSessionSharing(params: {
  cfg: OpenClawConfig;
  client: GatewayClient | null;
  isMember: (target: SessionSharingTarget, identityId: string) => boolean;
  profiles?: Pick<PreparedSessionSharingProfiles, "readCurrent">;
  /** Retained consumers lend current membership; viewer facts still revalidate on every call. */
  owner?: object;
  channelRead?: (sessionKey: string, entry: ChannelReadEntry) => boolean;
}): ProjectedSessionSharing {
  const { cfg, client, isMember } = params;
  if (!params.profiles && client?.internal?.syntheticClient) {
    prepareGatewayRecipientProfile(client);
  }
  const actor = resolveGatewayOperatorRoleActor(client);
  const identity = sharingIdentity(client, actor);
  const retained = client?.preparedSessionProfile;
  const { profile, roleProfile } = params.profiles?.readCurrent() ?? {
    profile: identity && retained?.aliases.has(identity.id) ? retained : undefined,
    roleProfile:
      actor?.kind === "operator" && retained?.aliases.has(actor.profileId) ? retained : undefined,
  };
  const retainedSnapshot = params.owner ? projectedSharingKeys.get(params.owner) : undefined;
  const publication = runtimeConfigPublication.current;
  const principal = client?.internal?.openclawIdPrincipal;
  const subject = operatorRoleSubject(roleProfile);
  const rolesEnforced = isOperatorRoleEnforcedFor(cfg, subject) || subject.openclawIdMember;
  const policy =
    actor?.kind === "system"
      ? undefined
      : actor?.kind === "operator" && client?.internal?.operatorRunAuthority
        ? resolveOperatorRolePolicy(client, cfg)
        : openclawIdSubjectRolePolicy(principal, () =>
            retainedSnapshot?.sharing &&
            publication?.config === cfg &&
            retainedSnapshot.facts[0] === cfg &&
            retainedSnapshot.facts[1] === publication.revision &&
            retainedSnapshot.facts[11] === rolesEnforced &&
            retainedSnapshot.facts[16] === roleProfile &&
            retainedSnapshot.facts[17] === roleProfile?.role &&
            retainedSnapshot.facts[18] === roleProfile?.githubLogin &&
            retainedSnapshot.facts[19] === roleProfile?.profileId
              ? retainedSnapshot.sharing.policy
              : resolveOperatorRolePolicyForAssignment(
                  roleProfile?.profileId,
                  roleProfile?.role ?? null,
                  cfg,
                  roleProfile?.githubLogin ?? null,
                  operatorRoleSubject(roleProfile),
                ),
          );
  const ownerEquivalent =
    !identity && rolesEnforced && isSessionSharingOwnerEquivalent(client, actor);
  const scopes = client?.connect?.scopes;
  let channelKey = telegramSessionMembershipKey(client, cfg);
  const readSnapshot = (): ProjectedSharingSnapshot => {
    const viewer = params.owner ?? client ?? cfg;
    const previous = projectedSharingKeys.get(viewer);
    const facts = previous?.facts;
    // Compare live authority directly; only misses need a new fact snapshot.
    if (
      facts &&
      facts[0] === cfg &&
      facts[1] === getRuntimeConfigSnapshotMetadata() &&
      facts[2] === readGatewayAccessRevision() &&
      facts[3] === actor?.kind &&
      facts[4] === (actor?.kind === "operator" ? actor.profileId : undefined) &&
      facts[5] === identity?.id &&
      facts[6] === client?.authenticatedUserProfile?.profileId &&
      facts[7] === client?.authenticatedUserId &&
      facts[8] === Boolean(client?.authenticatedGitHubIdentitySync) &&
      facts[9] === profile &&
      facts[10] === policy &&
      facts[11] === rolesEnforced &&
      facts[12] === (scopes !== undefined) &&
      facts[13] === ownerEquivalent &&
      facts[14] === policy?.sessions.others &&
      facts[15] === (params.owner ? isMember : undefined) &&
      facts[16] === roleProfile &&
      facts[17] === roleProfile?.role &&
      facts[18] === roleProfile?.githubLogin &&
      facts[19] === roleProfile?.profileId &&
      facts[20] === channelKey &&
      facts.length === 21 + (scopes?.length ?? 0)
    ) {
      let i = 0;
      while (i < (scopes?.length ?? 0) && facts[21 + i] === scopes?.[i]) {
        i++;
      }
      if (i === (scopes?.length ?? 0)) {
        return previous;
      }
    }
    const next: unknown[] = [
      cfg,
      getRuntimeConfigSnapshotMetadata(),
      readGatewayAccessRevision(),
      actor?.kind,
      actor?.kind === "operator" ? actor.profileId : undefined,
      identity?.id,
      client?.authenticatedUserProfile?.profileId,
      client?.authenticatedUserId,
      Boolean(client?.authenticatedGitHubIdentitySync),
      profile,
      policy,
      rolesEnforced,
      scopes !== undefined,
      ownerEquivalent,
      policy?.sessions.others,
      params.owner ? isMember : undefined,
      roleProfile,
      roleProfile?.role,
      roleProfile?.githubLogin,
      roleProfile?.profileId,
      channelKey,
    ];
    const snapshot = { facts: scopes?.length ? next.concat(scopes) : next };
    projectedSharingKeys.set(viewer, snapshot);
    return snapshot;
  };
  let snapshot = params.owner ? readSnapshot() : undefined;
  if (snapshot?.sharing) {
    return snapshot.sharing;
  }
  const sharing = {
    ...prepareSessionSharing(params, {
      aliases: profile?.aliases ?? emptyProfileAliases,
      sessionCap: policy?.sessions.others,
      isMember,
      channelRead: params.channelRead,
    }),
    policy,
    /** Connection facts follow config/access publications, independently of row revisions. */
    getCacheKey() {
      const currentChannelKey = telegramSessionMembershipKey(client, cfg);
      if (currentChannelKey !== channelKey) {
        channelKey = currentChannelKey;
        snapshot = undefined;
      }
      snapshot ??= readSnapshot();
      return (snapshot.key ??= JSON.stringify([
        actor,
        identity?.id,
        client?.authenticatedUserProfile?.profileId,
        client?.authenticatedUserId,
        Boolean(client?.authenticatedGitHubIdentitySync),
        scopes?.toSorted(),
        profile?.profileId,
        // oxlint-disable-next-line unicorn/no-array-sort -- The Set spread is a private array.
        profile && [...profile.aliases].sort(),
        policy,
        rolesEnforced,
        // Equal effective scopes can retain different source sharing authority.
        ownerEquivalent,
        channelKey,
      ]));
    },
  };
  if (snapshot) {
    snapshot.sharing = sharing;
  }
  return sharing;
}

export function createSessionListEntryFilter(
  params: Pick<SessionSharingRoleParams, "cfg" | "client"> & {
    membership?: ReadonlySet<string>;
  },
  isCreator?: ReturnType<typeof prepareSessionCreatorProfile>,
  prepared?: { sessionCap: ReturnType<typeof operatorSessionCap> },
):
  | ((sessionKey: string | undefined, entry: ChannelReadEntry, isMember?: boolean) => boolean)
  | undefined {
  const operatorActor = resolveGatewayOperatorRoleActor(params.client);
  const identity = sharingIdentity(params.client, operatorActor);
  if (
    isGatewayAdmin(params.client) ||
    (!identity &&
      (operatorActor?.kind === "system" ||
        (!params.cfg?.gateway?.roles &&
          params.client?.authenticatedUserProfile?.profileId === GATEWAY_OWNER_PROFILE_ID)))
  ) {
    return undefined;
  }
  if (!identity) {
    if (isNamedOperatorRoleEnforcementEnabled(params.cfg)) {
      return isSessionSharingOwnerEquivalent(params.client, operatorActor)
        ? undefined
        : () => false;
    }
    return (key, entry) =>
      (!params.client?.authenticatedGitHubIdentitySync ||
        resolveSessionVisibility(entry) !== "draft") &&
      canReadSessionAccess(params.cfg, key, entry, () => false);
  }
  const sessionCap = prepared
    ? prepared.sessionCap
    : params.cfg && operatorSessionCap(params.client, params.cfg);
  return createProfileSessionEntryFilter(
    { profileId: identity.id, sessionCap, cfg: params.cfg, membership: params.membership },
    isCreator,
  );
}

/** Existing roleless readers retain direct access to legacy unset rows only. */
export function createSessionDirectEntryFilter(
  ...args: Parameters<typeof createSessionListEntryFilter>
): ReturnType<typeof createSessionListEntryFilter> {
  const [params] = args;
  const filter = createSessionListEntryFilter(...args);
  if (
    params.cfg?.gateway?.roles ||
    (params.client?.authenticatedGitHubIdentitySync &&
      !sharingIdentity(params.client, resolveGatewayOperatorRoleActor(params.client))) ||
    !operatorScopeSatisfied("operator.read", params.client?.connect?.scopes ?? [])
  ) {
    return filter;
  }
  return (key, entry, isMember) =>
    (entry.access === undefined &&
      entry.incognito !== true &&
      !isIncognitoSessionKey(key) &&
      resolveSessionVisibility(entry) !== "draft") ||
    filter?.(key, entry, isMember) !== false;
}

export function createProfileSessionEntryFilter(
  params: {
    profileId: string;
    sessionCap?: ReturnType<typeof operatorSessionCap>;
    cfg?: OpenClawConfig;
    membership?: ReadonlySet<string>;
  },
  isCreator?: ReturnType<typeof prepareSessionCreatorProfile>,
) {
  // Unprepared filters (notably preview) may survive yields and must read current aliases.
  const creatorMatches = isCreator ?? ((actor) => isSessionCreatorProfile(actor, params.profileId));
  return (
    sessionKey: string | undefined,
    entry: Pick<SessionEntry, "createdActor" | "visibility" | "incognito" | "access">,
    isMember = params.membership?.has(params.profileId),
  ) =>
    entry.incognito !== true &&
    !isIncognitoSessionKey(sessionKey) &&
    canReadSessionAccess(params.cfg, sessionKey, entry, creatorMatches) &&
    (creatorMatches(entry.createdActor) ||
      (params.sessionCap !== "none" &&
        // Projection callbacks may pass metadata as the third argument; only true grants membership.
        (params.sessionCap !== "invited" || isMember === true) &&
        resolveSessionVisibility(entry) !== "draft"));
}
