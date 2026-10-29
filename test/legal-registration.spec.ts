import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { RegisterDto } from '../src/auth/auth.dto';

const valid={displayName:'Owned legal fixture',email:'owned@example.invalid',password:'owned-test-password',workspaceType:'household',acceptedTerms:true,acceptedPrivacy:true};
describe('registration legal validation',()=>{
  for (const field of ['acceptedTerms','acceptedPrivacy']) {
    for (const value of [undefined,false,'true',1,null]) {
      it(`${field}=${String(value)} is rejected`,async()=>{
        const errors=await validate(plainToInstance(RegisterDto,{...valid,[field]:value}));
        expect(errors.some(error=>error.property===field)).toBe(true);
      });
    }
  }
  it('accepts both explicit booleans and rejects client timestamps',async()=>{
    expect(await validate(plainToInstance(RegisterDto,valid))).toHaveLength(0);
    const errors=await validate(plainToInstance(RegisterDto,{...valid,termsAcceptedAt:'2000-01-01'}),{whitelist:true,forbidNonWhitelisted:true});
    expect(errors.some(error=>error.property==='termsAcceptedAt')).toBe(true);
  });
});
