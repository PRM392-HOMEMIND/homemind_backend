import { ForbiddenException } from '@nestjs/common';
import { UserTx } from '../database/database.service';

export const REVIEWER_EMAIL = 'homemind.test@gmail.com';

/** Email is only a lookup optimisation; the operator-owned ID binding decides. */
export async function isBootstrappedReviewer(tx: UserTx, userId: string | null, email: string) {
  if (email !== REVIEWER_EMAIL) return false;
  const rows = await tx.$queryRaw<Array<{ bound: boolean }>>`
    select exists(select 1 from public.auth_reviewer_identity r
      join public.users u on u.id=r.user_id and u.email=r.email
      where r.singleton and r.email=${email} and (${userId}::uuid is null or u.id=${userId}::uuid)
        and u.status='ACTIVE' and u.email_verified_at is not null) as bound`;
  return rows[0].bound;
}

export function reviewerOperationUnavailable() {
  return new ForbiddenException({ code: 'ACCOUNT_OPERATION_UNAVAILABLE',
    message: 'Không thể thực hiện thao tác này. Vui lòng liên hệ hỗ trợ.' });
}
