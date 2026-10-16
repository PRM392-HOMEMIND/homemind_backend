import { describe,it,expect, beforeAll, afterAll, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { ScopedCursor,pageSize } from '../src/common/scoped-cursor';
describe('bounded signed metadata cursor',()=>{
 beforeAll(()=>{vi.stubEnv('DATABASE_URL','postgresql://unused:unused@127.0.0.1:1/unused');
  for(const key of ['AUTH_ACCESS_SECRET','AUTH_REFRESH_SECRET','AUTH_RESET_SECRET'])vi.stubEnv(key,randomBytes(32).toString('hex'));
  vi.stubEnv('NODE_ENV','test');vi.stubEnv('PAYOS_ENABLED','false');});
 afterAll(()=>vi.unstubAllEnvs());
 it('binds every cursor to its authenticated scope',()=>{const c=new ScopedCursor(),v=c.encode('owner/ws/q/filter',{rank:1,id:'owned'});
  expect(c.decode(v,'owner/ws/q/filter')).toEqual({rank:1,id:'owned'});
  expect(()=>c.decode(v,'other/ws/q/filter')).toThrow();expect(()=>c.decode(v+'x','owner/ws/q/filter')).toThrow();
 });
 it('rejects oversized/malformed paging without defaulting',()=>{
  expect(pageSize()).toBe(20);expect(pageSize('50')).toBe(50);
  for(const x of ['0','51','1.5','NaN','-1'])expect(()=>pageSize(x)).toThrow();
  expect(()=>new ScopedCursor().decode('x'.repeat(2049),'scope')).toThrow();
 });
});
