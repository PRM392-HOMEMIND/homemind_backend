import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { requireDisposableDatabase } from './disposable-database';
const loader=join(process.cwd(),'scripts/load-env.cjs');
const {ensureAuthSecrets}=require('../scripts/auth-secrets.cjs');
const owned:string[]=[];
afterEach(()=>{for(const path of owned.splice(0))rmSync(path,{recursive:true,force:true});});
describe('isolated local environment and persistent auth signing keys',()=>{
 it('billing DB tests accept disposable local/CI fixtures and reject normal databases',()=>{
  const check=(url:string,extra:NodeJS.ProcessEnv={})=>()=>requireDisposableDatabase({NODE_ENV:'test',MIGRATION_DATABASE_URL:url,...extra});
  expect(check('postgresql://synthetic@127.0.0.1:55432/homemind_billing_test')).not.toThrow();
  expect(check('postgresql://synthetic@localhost:55432/homemind_billing_test')).not.toThrow();
  expect(check('postgresql://synthetic@[::1]:55432/homemind_billing_test')).not.toThrow();
  expect(check('postgresql://synthetic@db:5432/homemind',{HOMEMIND_ISOLATED_CI:'1'})).not.toThrow();
  expect(check('postgresql://synthetic@db:5432/homemind_upgrade',{HOMEMIND_ISOLATED_CI:'1'})).not.toThrow();
  expect(check('postgresql://synthetic@db:5432/homemind_unit_test',{HOMEMIND_ISOLATED_CI:'1'})).not.toThrow();
  expect(check('postgresql://synthetic@production.example/prod_test')).toThrow();
  expect(check('postgresql://synthetic@production.example/prod_test',{HOMEMIND_ISOLATED_CI:'1'})).toThrow();
  expect(check('postgresql://synthetic@db:5432/homemind_unit_test')).toThrow();
  expect(check('postgresql://synthetic@127.0.0.1:55432/homemind_billing_test',{DATABASE_URL:'postgresql://synthetic@production.example/prod_test'})).toThrow();
  expect(check('https://localhost/homemind_billing_test')).toThrow();
  expect(check('postgresql://synthetic@127.0.0.1:5432/homemind',{HOMEMIND_ISOLATED_CI:'1'})).toThrow();
  expect(check('postgresql://synthetic@db:5432/homemind')).toThrow();
  expect(check('postgresql://synthetic@127.0.0.1:55432/homemind_billing_test',{NODE_ENV:'production'})).toThrow();
 });
 it('shell > .env.local > .env; production/test/CI ignore private files',()=>{
  const dir=mkdtempSync(join(tmpdir(),'homemind-env-test-'));owned.push(dir);
  writeFileSync(join(dir,'.env'),'SENTINEL_A=public\nSENTINEL_B=public\nSENTINEL_C=public\n');
  writeFileSync(join(dir,'.env.local'),'SENTINEL_A=private-synthetic\nSENTINEL_B=private-synthetic\n');
  for(const mode of ['development','test','production','ci']) {
   const env:NodeJS.ProcessEnv={...process.env,NODE_ENV:mode==='ci'?'development':mode,SENTINEL_A:'shell-synthetic'};
   delete env.CI;delete env.VITEST;if(mode==='ci')env.CI='true';
   const result=spawnSync(process.execPath,['-e',`require(${JSON.stringify(loader)}).loadEnvironment(); console.log(JSON.stringify([process.env.SENTINEL_A,process.env.SENTINEL_B??null,process.env.SENTINEL_C??null]));`],{cwd:dir,env,encoding:'utf8'});
   expect(result.status).toBe(0);
   expect(JSON.parse(result.stdout)).toEqual(mode==='development'?['shell-synthetic','private-synthetic','public']:['shell-synthetic',null,null]);
  }
 });
 it('missing/placeholder/duplicate secrets become three independent 64-byte CSPRNG hex values',()=>{
  const result=ensureAuthSecrets({AUTH_REFRESH_SECRET:'CHANGE_ME_WITH_AT_LEAST_32_RANDOM_BYTES'});
  const values=Object.values(result);expect(values).toHaveLength(3);expect(new Set(values).size).toBe(3);
  expect(values.every(v=>typeof v==='string'&&/^[a-f0-9]{128}$/.test(v))).toBe(true);
  const duplicate=randomBytes(64).toString('hex');
  expect(new Set(Object.values(ensureAuthSecrets({AUTH_ACCESS_SECRET:duplicate,AUTH_REFRESH_SECRET:duplicate}))).size).toBe(3);
 });
 it('valid existing keys survive repeat bootstrap without changing sessions',()=>{
  const settings={AUTH_ACCESS_SECRET:randomBytes(64).toString('hex'),AUTH_REFRESH_SECRET:randomBytes(64).toString('hex'),AUTH_RESET_SECRET:randomBytes(64).toString('hex')};
  expect(ensureAuthSecrets(settings)).toEqual(settings);expect(ensureAuthSecrets(ensureAuthSecrets(settings))).toEqual(settings);
 });
});
