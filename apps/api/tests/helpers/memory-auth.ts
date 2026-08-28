import { randomUUID } from "node:crypto";
import { AppError } from "../../src/lib/app-error.js";
import type {
  AuthRepository,
  AuthSessionRecord,
  AuthUserRecord,
  CreateGoogleOAuthChallengeInput,
  CreateMagicLinkChallengeInput,
  CreatePrimaryOAuthChallengeInput,
  CreateSessionInput,
  PrimaryIdentityProvider,
  PrimaryIdentityRecord,
  PrimaryOAuthChallengeRecord,
  ResolvePrimaryIdentityInput,
  ResolveGoogleUserInput
} from "../../src/modules/auth/auth-repository.js";
import type {
  MagicLinkEmailSender,
  MagicLinkMessage
} from "../../src/modules/auth/email-sender.js";

interface StoredChallenge extends CreateMagicLinkChallengeInput {
  consumed: boolean;
}

interface StoredSession {
  id: string;
  userId: string;
  deviceId: string | null;
  deviceName: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  tokenHash: string;
  idleExpiresAt: Date;
  revokedAt: Date | null;
}

interface StoredGoogleChallenge extends CreateGoogleOAuthChallengeInput {
  consumed: boolean;
}

interface StoredPrimaryChallenge extends CreatePrimaryOAuthChallengeInput {
  consumed: boolean;
}

interface StoredPrimaryIdentity extends PrimaryIdentityRecord {
  userId: string;
  providerSubject: string;
  revokedAt: Date | null;
}

export class MemoryAuthRepository implements AuthRepository {
  public readonly challenges: StoredChallenge[] = [];
  public readonly googleChallenges: StoredGoogleChallenge[] = [];
  public readonly primaryChallenges: StoredPrimaryChallenge[] = [];
  public readonly primaryIdentities: StoredPrimaryIdentity[] = [];
  public readonly googleIdentities = new Map<string, AuthUserRecord>();
  public readonly users = new Map<string, AuthUserRecord>();
  public readonly sessions: StoredSession[] = [];

  public async createMagicLinkChallenge(
    input: CreateMagicLinkChallengeInput
  ): Promise<void> {
    for (const challenge of this.challenges) {
      if (challenge.email === input.email) {
        challenge.consumed = true;
      }
    }
    this.challenges.push({ ...input, consumed: false });
  }

  public async createGoogleOAuthChallenge(
    input: CreateGoogleOAuthChallengeInput
  ): Promise<void> {
    this.googleChallenges.push({ ...input, consumed: false });
  }

  public async consumeGoogleOAuthChallenge(
    secretHash: string,
    now: Date
  ): Promise<{
    readonly codeVerifier: string;
    readonly nonce: string;
  } | null> {
    const challenge = this.googleChallenges.find(
      (candidate) =>
        candidate.secretHash === secretHash &&
        !candidate.consumed &&
        candidate.expiresAt > now
    );
    if (!challenge) {
      return null;
    }
    challenge.consumed = true;
    return {
      codeVerifier: challenge.codeVerifier,
      nonce: challenge.nonce
    };
  }

  public async resolveGoogleUser(
    input: ResolveGoogleUserInput
  ): Promise<AuthUserRecord> {
    const identity = this.googleIdentities.get(input.providerSubject);
    if (identity) {
      return identity;
    }
    if (this.users.has(input.email)) {
      throw new AppError(
        "GOOGLE_ACCOUNT_LINK_REQUIRED",
        "An existing user must explicitly link this Google account.",
        409
      );
    }
    const user: AuthUserRecord = {
      id: randomUUID(),
      email: input.email,
      displayName: input.displayName,
      status: "ACTIVE"
    };
    this.users.set(input.email, user);
    this.googleIdentities.set(input.providerSubject, user);
    return user;
  }

  public async createPrimaryOAuthChallenge(
    input: CreatePrimaryOAuthChallengeInput
  ): Promise<void> {
    this.primaryChallenges.push({ ...input, consumed: false });
  }

  public async consumePrimaryOAuthChallenge(
    secretHash: string,
    provider: PrimaryIdentityProvider,
    authenticatedUserId: string | null,
    now: Date
  ): Promise<PrimaryOAuthChallengeRecord | null> {
    const challenge = this.primaryChallenges.find(
      (candidate) =>
        candidate.secretHash === secretHash &&
        candidate.provider === provider &&
        !candidate.consumed &&
        candidate.expiresAt > now &&
        ((candidate.intent === "LOGIN" && candidate.userId === null) ||
          (candidate.intent === "LINK" &&
            candidate.userId === authenticatedUserId))
    );
    if (!challenge) return null;
    challenge.consumed = true;
    return {
      provider: challenge.provider,
      intent: challenge.intent,
      userId: challenge.userId,
      codeVerifier: challenge.codeVerifier,
      nonce: challenge.nonce
    };
  }

  public async resolvePrimaryIdentityUser(
    input: ResolvePrimaryIdentityInput
  ): Promise<AuthUserRecord> {
    const identity = this.primaryIdentities.find(
      (candidate) =>
        candidate.provider === input.provider &&
        candidate.providerSubject === input.providerSubject &&
        !candidate.revokedAt
    );
    if (identity) {
      const user = [...this.users.values()].find(
        (candidate) => candidate.id === identity.userId
      );
      if (!user) throw new Error("memory_identity_user_missing");
      return user;
    }
    const email = requireVerifiedEmail(input);
    if (this.users.has(email)) {
      throw new AppError(
        "LOGIN_IDENTITY_LINK_REQUIRED",
        "An existing user must explicitly link this login method.",
        409
      );
    }
    const user: AuthUserRecord = {
      id: randomUUID(),
      email,
      displayName: input.displayName,
      status: "ACTIVE"
    };
    this.users.set(email, user);
    this.primaryIdentities.push({
      userId: user.id,
      provider: input.provider,
      providerSubject: input.providerSubject,
      email,
      linkedAt: input.now,
      lastUsedAt: input.now,
      revokedAt: null
    });
    return user;
  }

  public async linkPrimaryIdentity(
    userId: string,
    input: ResolvePrimaryIdentityInput
  ): Promise<PrimaryIdentityRecord> {
    const email = requireVerifiedEmail(input);
    const subjectIdentity = this.primaryIdentities.find(
      (candidate) =>
        candidate.provider === input.provider &&
        candidate.providerSubject === input.providerSubject &&
        !candidate.revokedAt
    );
    if (subjectIdentity && subjectIdentity.userId !== userId) {
      throw new AppError(
        "LOGIN_IDENTITY_ALREADY_IN_USE",
        "This login identity is already linked to another user.",
        409
      );
    }
    const providerIdentity = this.primaryIdentities.find(
      (candidate) =>
        candidate.userId === userId && candidate.provider === input.provider
    );
    if (
      providerIdentity &&
      !providerIdentity.revokedAt &&
      providerIdentity.providerSubject !== input.providerSubject
    ) {
      throw new AppError(
        "LOGIN_PROVIDER_ALREADY_LINKED",
        "This provider is already linked.",
        409
      );
    }
    if (providerIdentity) {
      Object.assign(providerIdentity, {
        providerSubject: input.providerSubject,
        email,
        lastUsedAt: input.now,
        revokedAt: null
      });
      return providerIdentity;
    }
    const identity: StoredPrimaryIdentity = {
      userId,
      provider: input.provider,
      providerSubject: input.providerSubject,
      email,
      linkedAt: input.now,
      lastUsedAt: input.now,
      revokedAt: null
    };
    this.primaryIdentities.push(identity);
    return identity;
  }

  public async listPrimaryIdentities(
    userId: string
  ): Promise<readonly PrimaryIdentityRecord[]> {
    return this.primaryIdentities.filter(
      (identity) => identity.userId === userId && !identity.revokedAt
    );
  }

  public async unlinkPrimaryIdentity(
    userId: string,
    provider: PrimaryIdentityProvider,
    now: Date
  ): Promise<void> {
    const active = this.primaryIdentities.filter(
      (identity) => identity.userId === userId && !identity.revokedAt
    );
    if (active.length <= 1) {
      throw new AppError(
        "LAST_LOGIN_IDENTITY_REQUIRED",
        "The last login identity cannot be removed.",
        409
      );
    }
    const target = active.find((identity) => identity.provider === provider);
    if (!target) {
      throw new AppError(
        "LOGIN_IDENTITY_NOT_FOUND",
        "The login identity was not found.",
        404
      );
    }
    const index = this.primaryIdentities.indexOf(target);
    this.primaryIdentities[index] = { ...target, revokedAt: now };
  }

  public async consumeMagicLink(
    secretHash: string,
    now: Date
  ): Promise<AuthUserRecord | null> {
    const challenge = this.challenges.find(
      (candidate) =>
        candidate.secretHash === secretHash &&
        !candidate.consumed &&
        candidate.expiresAt > now
    );
    if (!challenge) {
      return null;
    }
    challenge.consumed = true;
    const existing = this.users.get(challenge.email);
    if (existing) {
      return existing;
    }
    const user: AuthUserRecord = {
      id: randomUUID(),
      email: challenge.email,
      displayName: null,
      status: "ACTIVE"
    };
    this.users.set(challenge.email, user);
    return user;
  }

  public async createSession(
    input: CreateSessionInput
  ): Promise<AuthSessionRecord> {
    const active = this.sessions
      .filter(
        (session) =>
          session.userId === input.userId &&
          !session.revokedAt &&
          session.expiresAt > new Date()
      )
      .sort(
        (first, second) =>
          first.createdAt.getTime() - second.createdAt.getTime()
      );
    const countToRevoke = active.length - input.maxActiveSessions + 1;
    for (const session of active.slice(0, Math.max(countToRevoke, 0))) {
      session.revokedAt = new Date();
    }

    const now = new Date();
    const session: StoredSession = {
      id: randomUUID(),
      userId: input.userId,
      deviceId: randomUUID(),
      deviceName: input.deviceName,
      tokenHash: input.tokenHash,
      createdAt: now,
      lastSeenAt: now,
      idleExpiresAt: input.idleExpiresAt,
      expiresAt: input.expiresAt,
      revokedAt: null
    };
    this.sessions.push(session);
    return session;
  }

  public async findActiveSession(
    tokenHash: string,
    now: Date
  ): Promise<{
    readonly user: AuthUserRecord;
    readonly session: AuthSessionRecord;
  } | null> {
    const session = this.sessions.find(
      (candidate) =>
        candidate.tokenHash === tokenHash &&
        !candidate.revokedAt &&
        candidate.idleExpiresAt > now &&
        candidate.expiresAt > now
    );
    if (!session) {
      return null;
    }
    const user = [...this.users.values()].find(
      ({ id }) => id === session.userId
    );
    return user ? { user, session } : null;
  }

  public async touchSession(
    sessionId: string,
    now: Date,
    idleExpiresAt: Date
  ): Promise<void> {
    const session = this.sessions.find(({ id }) => id === sessionId);
    if (session && !session.revokedAt) {
      session.lastSeenAt = now;
      session.idleExpiresAt = idleExpiresAt;
    }
  }

  public async listSessions(
    userId: string
  ): Promise<readonly AuthSessionRecord[]> {
    return this.sessions.filter(
      (session) => session.userId === userId && !session.revokedAt
    );
  }

  public async revokeSession(
    userId: string,
    sessionId: string,
    now: Date
  ): Promise<boolean> {
    const session = this.sessions.find(
      (candidate) =>
        candidate.userId === userId &&
        candidate.id === sessionId &&
        !candidate.revokedAt
    );
    if (!session) {
      return false;
    }
    session.revokedAt = now;
    return true;
  }

  public async revokeAllSessions(userId: string, now: Date): Promise<void> {
    for (const session of this.sessions) {
      if (session.userId === userId && !session.revokedAt) {
        session.revokedAt = now;
      }
    }
  }
}

function requireVerifiedEmail(input: ResolvePrimaryIdentityInput): string {
  if (!input.email || !input.emailVerified) {
    throw new AppError(
      "LOGIN_EMAIL_NOT_VERIFIED",
      "A verified email address is required.",
      403
    );
  }
  return input.email;
}

export class MemoryMagicLinkEmailSender implements MagicLinkEmailSender {
  public readonly messages: MagicLinkMessage[] = [];

  public async sendMagicLink(message: MagicLinkMessage): Promise<void> {
    this.messages.push(message);
  }
}
