import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { ScopedCursor } from '../common/scoped-cursor';
import { invalidateWorkspace } from '../common/workspace-cache';
import { normalizeEmail } from '../auth/identifiers';
import { environment } from '../config/env';

@Injectable()
export class FamilyService {
  private readonly cursors=new ScopedCursor();
  constructor(private readonly db:DatabaseService){}
  async assertOwner(user:string,workspace:string){
    const role=await this.db.asUser(user,tx=>tx.workspaceMember.findFirst({where:{userId:user,workspaceId:workspace,role:'owner'},select:{role:true}}));
    if(!role)throw new ForbiddenException('Chỉ chủ nhóm được quản lý thành viên.');
  }
  async workspaces(user:string){return {items:await this.db.asUser(user,async tx=>(await tx.$queryRaw<Array<{data:unknown}>>`select public.workspace_directory() as data`)[0].data)};}
  private entries(value:string){
    const list=value.split(',').map(email=>email.trim().toLowerCase());
    if(list.length<1||list.length>5)throw new BadRequestException('Mỗi lần chỉ kiểm tra tối đa5 email.');
    return list.map(email=>{try{return {email:normalizeEmail(email),valid:true};}catch{return {email,valid:false};}});
  }
  private fingerprint(user:string,workspace:string,row:{email:string;recipientId:string|null}){
    return createHmac('sha256',environment().accessSecret).update(JSON.stringify(['family-preview-v1',user,workspace,row.email,row.recipientId])).digest('hex');
  }
  private safeResults(rows:Array<{email:string;code:string;blockedUntil?:string}>){
    const messages:Record<string,string>={INVALID_EMAIL:'Email không hợp lệ.',DUPLICATE_EMAIL:'Email bị trùng trong danh sách.',ACCOUNT_INACTIVE:'Tài khoản không thể nhận lời mời.',SELF_INVITATION:'Bạn không thể tự mời chính mình.',ALREADY_MEMBER:'Đã là thành viên.',ALREADY_FAMILY:'Tài khoản đã tham gia một nhóm Family.',ALREADY_PENDING:'Đã có lời mời đang chờ.',INVITE_COOLDOWN:'Đã từ chối ba lần. Chờ đủ24 giờ.',FAMILY_CAPACITY:'Không đủ chỗ cho cả danh sách.',READY:'Có thể mời.'};
    return rows.map(r=>({email:r.email,code:r.code,message:r.code==='EMAIL_NOT_REGISTERED'?`Email ${r.email} chưa được đăng ký tài khoản HomeMind.`:messages[r.code],blockedUntil:r.blockedUntil??null}));
  }
  private async preview(user:string,workspace:string,value:string){
    await this.assertOwner(user,workspace);
    const entries=this.entries(value);
    const data=await this.db.asUser(user,async tx=>(await tx.$queryRaw<Array<{data:{results:Array<{email:string;code:string;recipientId:string|null;blockedUntil?:string}>;canSubmit:boolean;availableSeats:number;serverNow:string}}>>`
     select public.family_validate_batch(${workspace}::uuid,${JSON.stringify(entries)}::jsonb) as data`)[0].data);
    return {data,entries};
  }
  async validateBatch(user:string,workspace:string,value:string){
    const {data}=await this.preview(user,workspace,value);
    return {...data,results:this.safeResults(data.results),validationToken:data.canSubmit?this.cursors.encode(JSON.stringify(['family-preview',user,workspace]),{fingerprints:data.results.map(r=>this.fingerprint(user,workspace,r))}):null};
  }
  async createBatch(user:string,workspace:string,value:string,validationToken:string,key:string){
    await this.assertOwner(user,workspace);
    const entries=this.entries(value);
    const receipt=await this.db.asUser(user,async tx=>(await tx.$queryRaw<Array<{data:Record<string,unknown>|null}>>`select public.family_batch_receipt(${workspace}::uuid,${key}::uuid) as data`)[0].data);
    if(receipt){
      if(JSON.stringify(receipt.requestEmails)!==JSON.stringify(entries.map(e=>e.email)))throw new ConflictException({code:'IDEMPOTENCY_CONFLICT',message:'Mã yêu cầu đã dùng với danh sách khác.'});
      const {requestEmails,...safe}=receipt;return {...safe,replayed:true};
    }
    const expected=this.cursors.decode(validationToken,JSON.stringify(['family-preview',user,workspace])) as {fingerprints:string[]}|null;
    if(!expected||!Array.isArray(expected.fingerprints))throw new BadRequestException('Cần kiểm tra email trước khi gửi.');
    const {data}=await this.preview(user,workspace,value);
    if(!data.canSubmit||JSON.stringify(expected.fingerprints)!==JSON.stringify(data.results.map(r=>this.fingerprint(user,workspace,r))))
      throw new ConflictException({code:'INVITATION_VALIDATION_CHANGED',message:'Danh sách đã thay đổi. Kiểm tra lại trước khi gửi.',details:{results:this.safeResults(data.results)}});
    const targets=data.results.map(r=>({email:r.email,recipientId:r.recipientId}));
    const result=await this.db.asUser(user,async tx=>{
      await tx.$executeRaw`set local lock_timeout='2000ms'`;await tx.$executeRaw`set local statement_timeout='5000ms'`;
      return (await tx.$queryRaw<Array<{data:Record<string,unknown>}>>`select public.family_create_batch(${workspace}::uuid,${JSON.stringify(targets)}::jsonb,${key}::uuid,${environment().familyInviteDays}::integer) as data`)[0].data;
    });
    invalidateWorkspace(workspace);const {requestEmails,...safe}=result;return safe;
  }
  async select(user:string,workspace:string){
    const data=await this.db.asUser(user,async tx=>(await tx.$queryRaw<Array<{id:string}>>`select public.workspace_context(${workspace}::uuid) as id`)[0]);
    invalidateWorkspace(workspace);return {workspaceId:data.id};
  }
  async overview(user:string,workspace:string){return this.db.asUser(user,async tx=>(await tx.$queryRaw<Array<{data:unknown}>>`select public.family_read(${workspace}::uuid) as data`)[0].data);}
  async invitation(user:string,id:string){return this.db.asUser(user,async tx=>(await tx.$queryRaw<Array<{data:unknown}>>`select public.family_invitation_detail(${id}::uuid) as data`)[0].data);}
  async invitations(user:string,workspace:string|null,limit:number,cursor?:string){
    const scope=JSON.stringify(['family-invitations',user,workspace,'created-desc-id-desc']);
    const p=this.cursors.decode(cursor,scope) as {time:string;id:string}|null;
    if(p&&(!Number.isFinite(Date.parse(p.time))||!/^[0-9a-f-]{36}$/i.test(p.id)))throw new BadRequestException('Cursor không hợp lệ.');
    const rows=await this.db.asUser(user,async tx=>(await tx.$queryRaw<Array<{data:Array<{id:string;createdAt:string}>}>>`
     select public.family_invitation_list(${workspace}::uuid,${limit+1}::integer,${p?.time??null}::timestamptz,${p?.id??null}::uuid) as data`)[0].data);
    const items=rows.slice(0,limit),last=items.at(-1),hasMore=rows.length>limit;
    return {items,hasMore,nextCursor:hasMore&&last?this.cursors.encode(scope,{time:last.createdAt,id:last.id}):null};
  }
  async operation(user:string,action:string,workspace:string|null,target:string|null,email:string|null,key:string){
    if(workspace&&['invite','cancel','remove','end'].includes(action))await this.assertOwner(user,workspace);
    let normalized:string|null=null;
    if(email!==null){try{normalized=normalizeEmail(email);}catch{throw new BadRequestException('Email không hợp lệ.');}}
    const result=await this.db.asUser(user,async tx=>{
      await tx.$executeRaw`set local lock_timeout='2000ms'`;
      await tx.$executeRaw`set local statement_timeout='5000ms'`;
      return (await tx.$queryRaw<Array<{data:Record<string,unknown>}>>`
       select public.family_operation(${action},${workspace}::uuid,${target}::uuid,${normalized},${key}::uuid,${environment().familyInviteDays}::integer) as data`)[0].data;
    });
    if(workspace)invalidateWorkspace(workspace);
    if(result.blocked)throw new ConflictException({code:'FAMILY_INVITE_COOLDOWN',message:'Đã có ba lần từ chối. Hãy chờ đủ 24 giờ.',details:{blockedUntil:result.blockedUntil,serverNow:result.serverNow}});
    return result;
  }
}

// Handled by Le Nguyen Quoc Hung
