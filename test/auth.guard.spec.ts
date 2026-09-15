import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { AuthGuard, AuthRequest } from '../src/auth/auth.guard';

const token = 'local-access-token';
const request = (authorization?: string) => ({
  headers: { authorization },
} as unknown as AuthRequest);
const context = (value: AuthRequest) => ({
  switchToHttp: () => ({ getRequest: () => value }),
} as unknown as ExecutionContext);

describe('HomeMind Auth guard', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('từ chối request thiếu bearer token', async () => {
    const auth = { authenticate: vi.fn() };
    await expect(new AuthGuard(auth as never).canActivate(context(request()))).rejects.toThrow();
    expect(auth.authenticate).not.toHaveBeenCalled();
  });

  it('lấy danh tính từ dịch vụ xác minh JWT và session local', async () => {
    const authenticate = vi.fn().mockResolvedValue({ userId: '11111111-1111-4111-8111-111111111111', userEmail: 'a@example.com', sessionId: 's1' });
    const req = request(`Bearer ${token}`);
    expect(await new AuthGuard({ authenticate } as never).canActivate(context(req))).toBe(true);
    expect(req.userId).toBe('11111111-1111-4111-8111-111111111111');
    expect(authenticate).toHaveBeenCalledWith(token);
    expect(req.sessionId).toBe('s1');
  });

  it('từ chối token khi JWT hoặc session không hợp lệ', async () => {
    const authenticate = vi.fn().mockRejectedValue(new Error('Unauthorized'));
    await expect(new AuthGuard({ authenticate } as never).canActivate(context(request(`Bearer ${token}`)))).rejects.toThrow();
  });
});
