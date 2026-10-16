import { BadRequestException, CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { environment } from '../config/env';

/** Public routes of the homepage feedback popup (path after the global /v1 prefix). */
export const PUBLIC_FEEDBACK_PATH = /^\/v1\/public\/feedback-popup(?:\/|$)/;
const ALLOWED_METHODS = ['GET', 'POST'];
const ALLOWED_HEADERS = ['content-type', 'idempotency-key', 'authorization'];

/**
 * Exact-origin CORS for the public website. Never `*`, never credentialed: the
 * routes use no cookies, and an optional Bearer token travels in a header.
 * CORS is browser hygiene only; authorisation is enforced by the backend.
 */
export function applyPublicCors(request: Request, response: Response, preflight = false): void {
  response.vary('Origin');
  const origin = request.headers.origin;
  if (origin === undefined) return; // non-browser client
  if (typeof origin !== 'string' || !environment().publicWebOrigins.includes(origin)) {
    throw new ForbiddenException({ code: 'ORIGIN_NOT_ALLOWED', message: 'Nguồn truy cập không được phép.', details: null });
  }
  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Access-Control-Expose-Headers', 'Retry-After');
  if (!preflight) return;
  const method = String(request.headers['access-control-request-method'] ?? '').toUpperCase();
  const headers = String(request.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map(item => item.trim()).filter(Boolean);
  if (!ALLOWED_METHODS.includes(method) || headers.some(item => !ALLOWED_HEADERS.includes(item))) throw new BadRequestException();
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Idempotency-Key, Authorization');
  response.setHeader('Access-Control-Max-Age', '600');
}

/** Runs before the rate limiter so 429 and validation errors are readable by the website. */
@Injectable()
export class PublicCorsGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    // OPTIONS handlers validate the preflight themselves.
    if (request.method !== 'OPTIONS') applyPublicCors(request, http.getResponse<Response>());
    return true;
  }
}

/**
 * Error responses produced outside a guard (body parser failures) still need the
 * CORS headers, otherwise the browser reports an opaque network error.
 */
export function publicCorsForError(request: Request, response: Response): void {
  if (!PUBLIC_FEEDBACK_PATH.test(request.originalUrl?.split('?')[0] ?? '')) return;
  const origin = request.headers.origin;
  response.vary('Origin');
  if (typeof origin === 'string' && environment().publicWebOrigins.includes(origin)) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Access-Control-Expose-Headers', 'Retry-After');
  }
}
