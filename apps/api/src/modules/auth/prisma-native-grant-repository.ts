import type { DatabaseClient } from "../../db/client.js";
import type {
  NativeGrantRepository,
  NativeProvider
} from "./native-auth-service.js";
import { invalidNativeGrant } from "./native-auth-service.js";

export class PrismaNativeGrantRepository implements NativeGrantRepository {
  public constructor(private readonly db: DatabaseClient) {}
  public async create(input: Parameters<NativeGrantRepository["create"]>[0]) {
    await this.db.nativeLoginGrant.create({ data: input });
  }
  public async owns(stateHash: string) {
    return (
      (await this.db.nativeLoginGrant.count({ where: { stateHash } })) === 1
    );
  }
  public claimCallback(
    stateHash: string,
    bindingHash: string,
    provider: NativeProvider,
    now: Date
  ) {
    return this.db.$transaction(async (tx) => {
      const changed = await tx.nativeLoginGrant.updateMany({
        where: {
          stateHash,
          bindingHash,
          provider,
          callbackClaimedAt: null,
          expiresAt: { gt: now }
        },
        data: { callbackClaimedAt: now }
      });
      return changed.count === 1
        ? tx.nativeLoginGrant.findUnique({ where: { stateHash } })
        : null;
    });
  }
  public async issueCode(
    id: string,
    userId: string,
    codeHash: string,
    now: Date
  ) {
    const changed = await this.db.nativeLoginGrant.updateMany({
      where: {
        id,
        callbackClaimedAt: { not: null },
        codeHash: null,
        consumedAt: null,
        expiresAt: { gt: now }
      },
      data: {
        userId,
        codeHash,
        codeExpiresAt: new Date(now.getTime() + 60_000)
      }
    });
    if (changed.count !== 1) throw invalidNativeGrant();
  }
  public consumeCode(codeHash: string, codeChallenge: string, now: Date) {
    return this.db.$transaction(async (tx) => {
      const changed = await tx.nativeLoginGrant.updateMany({
        where: {
          codeHash,
          codeChallenge,
          consumedAt: null,
          codeExpiresAt: { gt: now },
          expiresAt: { gt: now },
          userId: { not: null }
        },
        data: { consumedAt: now }
      });
      if (changed.count !== 1) return null;
      const row = await tx.nativeLoginGrant.findUniqueOrThrow({
        where: { codeHash }
      });
      return tx.user.findFirst({
        where: { id: row.userId!, status: "ACTIVE", deletedAt: null },
        select: { id: true, email: true, displayName: true, status: true }
      });
    });
  }
}
