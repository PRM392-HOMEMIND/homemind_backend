import { CanActivate, Catch, ExceptionFilter, ExecutionContext, ArgumentsHost, HttpException, Injectable, UnauthorizedException, ForbiddenException, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { Request, Response } from 'express';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import * as argon2 from 'argon2';
import { AdminDatabase } from './admin.database';

export const ADMIN_COOKIE = '__Host-homemind-admin';
const PRE_COOKIE = '__Host-homemind-admin-csrf';
type Session = { id:string; admin_id:string; email:string; family_id:string; expires_at:Date; token_hash:string; rotated_at:Date|null; revoked_at:Date|null; last_seen_at:Date; status:string; created_at:Date; password_changed_at:Date };
export type AdminRequest = Request & { admin?:Session; adminToken?:string; requestId?:string; auditScopeHash?:string };
const digest = (x:string) => createHash('sha256').update(x).digest('hex');
function equal(a:string,b:string) { const x=Buffer.from(a),y=Buffer.from(b); return x.length===y.length && timingSafeEqual(x,y); }
function cookie(req:Request,name:string) { const parts=(req.headers.cookie||'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(name+'=')); return parts.length===1?parts[0].slice(name.length+1):''; }
function setCookie(res:Response,name:string,value:string,maxAge:number) { res.cookie(name,value,{secure:true,httpOnly:true,sameSite:'strict',path:'/',maxAge}); }
@Injectable()
export class AdminAuth {
  private readonly dummy = argon2.hash(randomBytes(32),{type:argon2.argon2id});
  constructor(readonly db:AdminDatabase) {}
  sign(purpose:string,value:string) { return createHmac('sha256',this.db.config?.key || '').update('homemind.admin.'+purpose+'.'+value).digest('base64url'); }
  async audit(req:AdminRequest,action:string,outcome:'SUCCESS'|'DENIED'|'ERROR',rows:number|null=null,target:string|null=null) {
    const endpoint=typeof req.route?.path==='string'?req.method+' '+req.route.path:action;
    await this.db.query('INSERT INTO admin.audit_logs(actor_id,request_id,action,target_id,outcome,row_count,scope_hash) VALUES($1::uuid,$2::uuid,$3,$4::uuid,$5,$6,$7) RETURNING id',req.admin?.admin_id || null,req.requestId!,endpoint,target,outcome,rows,req.auditScopeHash || null);
  }
  origin(req:AdminRequest,res:Response) {
    req.requestId=randomUUID();res.setHeader('X-Request-ID',req.requestId);res.setHeader('Cache-Control','private, no-store');res.setHeader('Vary','Origin');
    const origin=req.headers.origin;
    if (origin && !this.db.config?.origins.includes(origin)) throw new ForbiddenException({code:'ADMIN_ORIGIN_DENIED',message:'Origin not allowed.'});
    if (origin) {res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Access-Control-Allow-Credentials','true');res.setHeader('Access-Control-Expose-Headers','X-Request-ID');}
    if (!['GET','HEAD','OPTIONS'].includes(req.method) && (!origin || req.headers['sec-fetch-site']==='cross-site')) throw new ForbiddenException({code:'ADMIN_ORIGIN_DENIED',message:'Approved Origin required.'});
  }
  async csrf(req:AdminRequest,res:Response) {
    this.db.available();
    const principals=await this.db.query<{id:string}>('SELECT id FROM admin.principals WHERE bootstrap_key=\'initial\'');
    if(!principals.length)throw new ServiceUnavailableException({code:'ADMIN_BOOTSTRAP_BLOCKED',message:'Admin has not been provisioned.'});
    if (req.adminToken) return { csrfToken:this.sign('csrf',req.adminToken),expiresIn:900 };
    const nonce=randomBytes(32).toString('base64url'),payload=nonce+'.'+(Date.now()+300000);
    setCookie(res,PRE_COOKIE,payload+'.'+this.sign('precsrf',payload),300000);
    return {csrfToken:nonce,expiresIn:300};
  }
  verifyCsrf(req:AdminRequest,pre=false) {
    const header=req.headers['x-homemind-admin-csrf']; if(typeof header!=='string') throw new ForbiddenException({code:'ADMIN_CSRF_INVALID',message:'CSRF required.'});
    if(!pre && req.adminToken && equal(header,this.sign('csrf',req.adminToken))) return;
    if(pre) { const value=cookie(req,PRE_COOKIE),p=value.split('.'); if(p.length===3 && /^\d{13}$/.test(p[1]) && Number(p[1])>Date.now() && Number(p[1])<=Date.now()+300000 && equal(p[2],this.sign('precsrf',p[0]+'.'+p[1])) && equal(header,p[0])) return; }
    throw new ForbiddenException({code:'ADMIN_CSRF_INVALID',message:'Invalid CSRF.'});
  }
  async authenticate(req:AdminRequest,optional=false) {
    const token=cookie(req,ADMIN_COOKIE);
    if(!/^[A-Za-z0-9_-]{43}$/.test(token)) { if(optional && !token) return; throw new UnauthorizedException(); }
    const rows=await this.db.query<Session>('SELECT s.id,s.admin_id,s.family_id,s.token_hash,s.created_at,s.last_seen_at,s.expires_at,s.revoked_at,s.rotated_at,p.email,p.status,p.password_changed_at FROM admin.sessions s JOIN admin.principals p ON p.id=s.admin_id WHERE s.token_hash=$1',digest(token));
    const s=rows[0];
    if(s?.rotated_at) { await this.db.query('UPDATE admin.sessions SET revoked_at=coalesce(revoked_at,now()) WHERE family_id=$1::uuid RETURNING id',s.family_id); throw new UnauthorizedException({code:'ADMIN_SESSION_REPLAY',message:'Sign in again.'}); }
    if(!s || s.status!=='ACTIVE' || s.revoked_at || s.expires_at.getTime()<=Date.now() || s.last_seen_at.getTime()+900000<=Date.now() || s.password_changed_at>s.created_at) throw new UnauthorizedException();
    req.admin=s; req.adminToken=token;
    await this.db.query('UPDATE admin.sessions SET last_seen_at=now() WHERE id=$1::uuid AND revoked_at IS NULL RETURNING id',s.id);
  }
  async login(req:AdminRequest,res:Response,email:string,password:string) {
    this.verifyCsrf(req,true);
    const keys=[this.sign('limit-ip',req.ip || 'unknown'),this.sign('limit-account',email)];
    const allowed=await this.db.transaction(async tx=>{
      for(const key of keys) {
        const rows=await tx.$queryRawUnsafe<{attempts:number}[]>('INSERT INTO admin.login_limits(key,started_at,attempts) VALUES($1,now(),1) ON CONFLICT(key) DO UPDATE SET started_at=CASE WHEN admin.login_limits.started_at<now()-interval \'60 seconds\' THEN now() ELSE admin.login_limits.started_at END,attempts=CASE WHEN admin.login_limits.started_at<now()-interval \'60 seconds\' THEN 1 ELSE admin.login_limits.attempts+1 END RETURNING attempts',key);
        if(rows[0].attempts>10) return false;
      }
      await tx.$executeRawUnsafe("DELETE FROM admin.login_limits WHERE key IN (SELECT key FROM admin.login_limits WHERE started_at<now()-interval '10 minutes' LIMIT 100)");return true;
    });
    if(!allowed) throw new HttpException({code:'ADMIN_RATE_LIMITED',message:'Try after 60 seconds.'},429);
    const principals=await this.db.query<{id:string;password_hash:string;status:string}>('SELECT id,password_hash,status FROM admin.principals WHERE email=$1',email);
    const p=principals[0];const valid=await argon2.verify(p?.password_hash || await this.dummy,password);
    if(!valid || !p || p.status!=='ACTIVE') {await this.audit(req,'auth.login','DENIED');throw new UnauthorizedException({code:'ADMIN_INVALID_CREDENTIALS',message:'Invalid credentials.'});}
    const token=randomBytes(32).toString('base64url');
    const session=await this.db.transaction(async tx=>{
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',p.id);
      const current=await tx.$queryRawUnsafe<{status:string;password_hash:string}[]>('SELECT status,password_hash FROM admin.principals WHERE id=$1::uuid',p.id);
      if(current[0]?.status!=='ACTIVE' || current[0].password_hash!==p.password_hash) throw new UnauthorizedException();
      await tx.$executeRawUnsafe('UPDATE admin.sessions SET revoked_at=coalesce(revoked_at,now()) WHERE id IN (SELECT id FROM admin.sessions WHERE admin_id=$1::uuid AND revoked_at IS NULL ORDER BY created_at DESC,id DESC OFFSET 9)',p.id);
      const rows=await tx.$queryRawUnsafe<Session[]>('INSERT INTO admin.sessions(admin_id,family_id,token_hash,expires_at,client) VALUES($1::uuid,$2::uuid,$3,now()+interval \'8 hours\',$4) RETURNING id,admin_id,family_id,expires_at',p.id,randomUUID(),digest(token),req.headers['user-agent']?.includes('Mozilla')?'browser':'other');
      await tx.$executeRawUnsafe("INSERT INTO admin.audit_logs(actor_id,request_id,action,outcome) VALUES($1::uuid,$2::uuid,'auth.login','SUCCESS')",p.id,req.requestId!);return rows[0];
    });
    setCookie(res,ADMIN_COOKIE,token,8*3600000);setCookie(res,PRE_COOKIE,'',0);
    return {id:p.id,email,role:'SYSTEM_ADMIN',sessionId:session.id,expiresAt:session.expires_at,csrfToken:this.sign('csrf',token)};
  }
  async refresh(req:AdminRequest,res:Response) {
    this.verifyCsrf(req);const s=req.admin!,token=randomBytes(32).toString('base64url');
    const result=await this.db.transaction(async tx=>{
      const old=await tx.$queryRawUnsafe<{id:string}[]>('UPDATE admin.sessions SET rotated_at=now(),revoked_at=now() WHERE id=$1::uuid AND revoked_at IS NULL AND rotated_at IS NULL RETURNING id',s.id);
      if(!old.length) return null;
      const rows=await tx.$queryRawUnsafe<{id:string}[]>('INSERT INTO admin.sessions(admin_id,family_id,token_hash,expires_at,client) SELECT admin_id,family_id,$2,expires_at,client FROM admin.sessions WHERE id=$1::uuid RETURNING id',s.id,digest(token));
      await tx.$executeRawUnsafe("INSERT INTO admin.audit_logs(actor_id,request_id,action,outcome) VALUES($1::uuid,$2::uuid,'auth.refresh','SUCCESS')",s.admin_id,req.requestId!);return rows[0];
    });
    if(!result) {await this.db.query('UPDATE admin.sessions SET revoked_at=coalesce(revoked_at,now()) WHERE family_id=$1::uuid RETURNING id',s.family_id);throw new UnauthorizedException({code:'ADMIN_SESSION_REPLAY',message:'Sign in again.'});}
    setCookie(res,ADMIN_COOKIE,token,Math.max(0,s.expires_at.getTime()-Date.now()));
    return {sessionId:result.id,expiresAt:s.expires_at,csrfToken:this.sign('csrf',token)};
  }
  async logout(req:AdminRequest,res:Response,all=false,id?:string) {
    this.verifyCsrf(req);
    await this.db.transaction(async tx=>{
      const rows=await tx.$queryRawUnsafe<{id:string}[]>('UPDATE admin.sessions SET revoked_at=coalesce(revoked_at,now()) WHERE admin_id=$1::uuid AND ($2::boolean OR id=$3::uuid) RETURNING id',req.admin!.admin_id,all,id || req.admin!.id);
      if(!rows.length) throw new HttpException('Session not found.',404);
      await tx.$executeRawUnsafe('INSERT INTO admin.audit_logs(actor_id,request_id,action,outcome,target_id) VALUES($1::uuid,$2::uuid,$3,\'SUCCESS\',$4::uuid)',req.admin!.admin_id,req.requestId!,all?'auth.logout-all':id?'auth.revoke':'auth.logout',id || req.admin!.id);
    });
    if(all || !id || id===req.admin!.id) setCookie(res,ADMIN_COOKIE,'',0);
    return {revoked:true};
  }
}
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly auth:AdminAuth) {}
  async canActivate(ctx:ExecutionContext) {
    const req=ctx.switchToHttp().getRequest<AdminRequest>(),res=ctx.switchToHttp().getResponse<Response>();
    const name=ctx.getHandler().name;
    const publicRoute=name==='login' || name==='csrf' || name==='preflight';
    try {
      this.auth.origin(req,res);
      if(name==='preflight')return true;
      if(['login','csrf','me','refresh','logout','logoutAll','sessions','revoke','meta','user','workspace','payment','notification','audit'].includes(name) && Object.keys(req.query).length)throw new BadRequestException('No query allowed.');
      if(req.method==='GET' && req.body && Object.keys(req.body).length)throw new BadRequestException('No body allowed.');
      await this.auth.authenticate(req,publicRoute);
      if(!publicRoute && !['GET','HEAD','OPTIONS'].includes(req.method)) this.auth.verifyCsrf(req);return true;
    }
    catch(e) { if(this.auth.db.config) await this.auth.audit(req,'access.'+ctx.getHandler().name,'DENIED');throw e; }
  }
}
@Catch()
export class AdminErrorFilter implements ExceptionFilter {
  catch(error:unknown,host:ArgumentsHost) {
    const req=host.switchToHttp().getRequest<AdminRequest>(),res=host.switchToHttp().getResponse<Response>();
    const status=error instanceof HttpException?error.getStatus():503;
    const body=error instanceof HttpException?error.getResponse():null;
    const code=typeof body==='object' && body && 'code' in body?String(body.code):({400:'INVALID_REQUEST',401:'ADMIN_UNAUTHORIZED',403:'ADMIN_FORBIDDEN',404:'NOT_FOUND',409:'CONFLICT',429:'ADMIN_RATE_LIMITED'} as Record<number,string>)[status] || 'ADMIN_UNAVAILABLE';
    // Validation metadata contains only fixed field names/codes, never rejected values.
    const fields:{field:string;code:string}[]=[];
    if(status===400) {
      const messages=typeof body==='object' && body && 'message' in body ? (body as {message:unknown}).message : [];
      if(Array.isArray(messages)) {
        for(const field of ['email','password','enabled','expectedRevision'])if(messages.some(m=>typeof m==='string' && m.startsWith(field+' ')))fields.push({field,code:'INVALID_VALUE'});
        if(messages.some(m=>typeof m==='string' && m.startsWith('property ')))fields.push({field:'request',code:'UNKNOWN_PROPERTY'});
      }
      if(!fields.length)fields.push({field:'request',code:'INVALID_VALUE'});
    }
    if(status===401)setCookie(res,ADMIN_COOKIE,'',0);
    res.setHeader('Cache-Control','private, no-store');res.status(status).json({error:{code,message:status===400?'Invalid request.':status===503?'Admin unavailable.':'Request denied.',requestId:req.requestId || randomUUID(),fields}});
  }
}
