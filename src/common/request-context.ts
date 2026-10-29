import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export type RequestContext = { id: string; traced: boolean };
export const requestContext = new AsyncLocalStorage<RequestContext>();
export function withRequestContext<T>(next: () => T) {
  // Never trust client IDs as trace authority or reuse an identity's context.
  return requestContext.run({id:randomUUID(),traced:false},next);
}
