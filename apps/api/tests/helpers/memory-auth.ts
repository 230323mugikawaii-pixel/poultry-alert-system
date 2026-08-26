import { randomUUID } from "node:crypto";
import { AppError } from "../../src/lib/app-error.js";
import type {
  AuthRepository,
  AuthSessionRecord,
  AuthUserRecord,
  CreateGoogleOAuthChallengeInput,
  CreateMagicLinkChallengeInput,
  CreateSessionInput,
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

export class MemoryAuthRepository implements AuthRepository {
  public readonly challenges: StoredChallenge[] = [];
  public readonly googleChallenges: StoredGoogleChallenge[] = [];
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

export class MemoryMagicLinkEmailSender implements MagicLinkEmailSender {
  public readonly messages: MagicLinkMessage[] = [];

  public async sendMagicLink(message: MagicLinkMessage): Promise<void> {
    this.messages.push(message);
  }
}
