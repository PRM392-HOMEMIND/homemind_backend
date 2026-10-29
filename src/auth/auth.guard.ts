import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service';

export type AuthRequest = Request & { userId: string; userEmail?: string; sessionId: string };
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ') || header.length > 4096) throw new UnauthorizedException();
    Object.assign(request, await this.auth.authenticate(header.slice(7)));
    return true;
  }
}
