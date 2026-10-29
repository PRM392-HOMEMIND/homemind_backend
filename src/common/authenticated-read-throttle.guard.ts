import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/** Runs after AuthGuard; shared networks do not share an account's read budget. */
@Injectable()
export class AuthenticatedReadThrottleGuard extends ThrottlerGuard {
  protected async getTracker(request: Record<string, unknown>): Promise<string> {
    if (typeof request.userId !== 'string' || !/^[a-f0-9-]{36}$/i.test(request.userId)) {
      throw new UnauthorizedException();
    }
    return request.userId;
  }
}
