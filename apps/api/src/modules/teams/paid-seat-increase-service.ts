import { AppError } from "../../lib/app-error.js";
import {
  derivePaidInvitationPassword,
  prepareInvitationCredential
} from "../invitations/invitation-credential.js";
import type {
  SeatLimitChangeResult,
  TeamRepository
} from "./team-repository.js";

export interface PaidSeatIncreaseServiceOptions {
  readonly repository: TeamRepository;
  readonly tokenPepper: string;
  readonly invitationTtlDays: number;
  readonly now?: () => Date;
}

export class PaidSeatIncreaseService {
  private readonly now: () => Date;

  public constructor(private readonly options: PaidSeatIncreaseServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  public async apply(input: {
    readonly changeId: string;
    readonly paymentEventId: string;
  }): Promise<
    SeatLimitChangeResult & { readonly invitationPassword: string | null }
  > {
    if (!/^[A-Za-z0-9._:-]{8,191}$/.test(input.paymentEventId)) {
      throw new AppError(
        "PAYMENT_EVENT_INVALID",
        "決済イベントIDが正しくありません。",
        400
      );
    }

    const now = this.now();
    const credential = await prepareInvitationCredential({
      now,
      ttlDays: this.options.invitationTtlDays,
      password: derivePaidInvitationPassword({
        tokenPepper: this.options.tokenPepper,
        changeId: input.changeId,
        paymentEventId: input.paymentEventId
      })
    });
    const result = await this.options.repository.applyPaidSeatIncrease({
      ...input,
      now,
      invitation: {
        passwordHash: credential.passwordHash,
        expiresAt: credential.expiresAt
      }
    });
    return {
      ...result,
      invitationPassword: result.invitation ? credential.password : null
    };
  }
}
