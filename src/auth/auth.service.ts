import { BadRequestException, ConflictException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Prisma, User } from '@prisma/client';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import { SignJWT, jwtVerify } from 'jose';
import { DatabaseService, UserTx } from '../database/database.service';
import { environment } from '../config/env';
import { ChangeIdentifiersDto, RegisterDto } from './auth.dto';
import { normalizeEmail, normalizeIdentifier, normalizePhone } from './identifiers';
import { ResetDeliveryService } from './reset-delivery.service';
import { EmailChallengeService, ChallengeProof, Challenge } from './email-challenge.service';
import { InfobipProvider } from '../email/infobip.provider';
import { OtpPurpose } from '../email/email.templates';
import { isBootstrappedReviewer, reviewerOperationUnavailable } from './reviewer-policy';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sessionError = () => new UnauthorizedException('Phiên đăng nhập không hợp lệ hoặc đã hết hạn.');
export type SessionMetadata = { userAgent?: string; ip?: string; requestId?: string; authContract?: '2' };

@Injectable()
export class AuthService {
  private readonly config = environment();
  private readonly signingKey = new TextEncoder().encode(this.config.accessSecret);
  // Verify a real hash for unknown accounts as well, avoiding a fast username oracle.
  private readonly dummyHash = argon2.hash(randomBytes(32), { type: argon2.argon2id });
  constructor(private readonly db: DatabaseService, private readonly delivery: ResetDeliveryService,
    readonly challenges: EmailChallengeService = new EmailChallengeService(db, new InfobipProvider())) {}

  private tokenHash(token: string, kind: 'refresh' | 'reset') {
    return createHmac('sha256', kind === 'refresh' ? this.config.refreshSecret : this.config.resetSecret).update(token).digest('hex');
  }
  async lockUser(tx: UserTx, userId: string) {
    await tx.$executeRaw`select pg_advisory_xact_lock(hashtextextended(${userId}, 0))`;
  }
  private async setContext(tx: UserTx, userId: string) {
    await tx.$queryRaw`select set_config('app.user_id', ${userId}, true)`;
  }
  private active(user: User) {
    if (user.status !== 'ACTIVE') throw new ForbiddenException('Tài khoản đã bị vô hiệu hóa hoặc đã xóa.');
  }
  private passwordPolicy(value: string) {
    if (value.length < 8 || value.length > 128 || !value.trim()) throw new BadRequestException('Mật khẩu mới phải có từ 8 đến 128 ký tự.');
  }
  private async passwordMatches(hash: string, value: string) {
    try { return await argon2.verify(hash, value); } catch { return false; }
  }
  async verifyCurrent(tx: UserTx, userId: string, password: string) {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) throw sessionError();
    this.active(user);
    if (!await this.passwordMatches(user.passwordHash, password)) throw new UnauthorizedException({ code: 'CURRENT_PASSWORD_INVALID', message: 'Mật khẩu hiện tại chưa đúng.' });
    return user;
  }
  private conflict(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ConflictException({ code: 'IDENTIFIER_IN_USE', message: 'Email hoặc số điện thoại đã được sử dụng.' });
    }
    throw error;
  }
  async newSession(tx: UserTx, userId: string, metadata: SessionMetadata, familyId: string = randomUUID()) {
    const subject = await tx.user.findUnique({ where: { id: userId } });
    if (!subject?.email || !subject.emailVerifiedAt || subject.status !== 'ACTIVE') throw sessionError();
    const refreshToken = randomBytes(48).toString('base64url');
    const session = await tx.refreshSession.create({ data: {
      userId, familyId, tokenHash: this.tokenHash(refreshToken, 'refresh'),
      expiresAt: new Date(Date.now() + this.config.refreshTtl * 1000),
      userAgent: metadata.userAgent?.slice(0, 300), ip: metadata.ip?.slice(0, 80),
    } });
    return { session, refreshToken };
  }
  async response(user: User, issued: Awaited<ReturnType<AuthService['newSession']>>) {
    const accessToken = await new SignJWT({ sid: issued.session.id, typ: 'access' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setSubject(user.id).setIssuedAt()
      .setExpirationTime(`${this.config.accessTtl}s`).setIssuer(this.config.issuer).setAudience(this.config.audience).sign(this.signingKey);
    const profile = await this.db.asUser(user.id, tx => tx.profile.findUnique({ where: { id: user.id } }));
    return {
      accessToken, refreshToken: issued.refreshToken, expiresIn: this.config.accessTtl,
      refreshExpiresIn: this.config.refreshTtl,
      user: { id: user.id, email: user.email, phone: user.phone, displayName: profile?.displayName ?? '', status: user.status },
    };
  }
  async register(body: RegisterDto, metadata: SessionMetadata) {
    if (body.acceptedTerms !== true || body.acceptedPrivacy !== true) {
      throw new BadRequestException({ code: 'LEGAL_ACCEPTANCE_REQUIRED', message: 'Vui lòng đồng ý Điều khoản sử dụng và Chính sách bảo mật.' });
    }
    this.passwordPolicy(body.password);
    const email = normalizeEmail(body.email ?? '');
    const phone = body.phone?.trim() ? normalizePhone(body.phone) : null;
    if (!body.displayName.trim()) throw new BadRequestException('Vui lòng nhập tên hiển thị.');
    if (!['household','store'].includes(body.workspaceType || 'household')) throw new BadRequestException('Loại workspace không hợp lệ.');
    const passwordHash = await argon2.hash(body.password, { type: argon2.argon2id });
    if (await this.db.user.findUnique({ where: { email } }) || (phone && await this.db.user.findUnique({ where: { phone } }))) throw new ConflictException({code:'IDENTIFIER_IN_USE',message:'Email hoặc số điện thoại đã được sử dụng.'});
    return this.challenges.request('REGISTER', email, null, { displayName:body.displayName.trim(),phone,passwordHash,workspaceType:body.workspaceType || 'household',acceptedAt:new Date().toISOString() }, this.challenges.digest('registration-input',email,phone || '',body.password,body.displayName.trim(),body.workspaceType || 'household'), metadata.ip,undefined,metadata.requestId);
  }
  async login(identifier: string, password: string, metadata: SessionMetadata) {
    let where: ReturnType<typeof normalizeIdentifier>;
    try { where = normalizeIdentifier(identifier); } catch {
      await this.passwordMatches(await this.dummyHash, password);
      throw new UnauthorizedException('Email, số điện thoại hoặc mật khẩu chưa đúng.');
    }
    const candidate = await this.db.user.findUnique({ where });
    const valid = await this.passwordMatches(candidate?.passwordHash ?? await this.dummyHash, password);
    if (!candidate || !valid) throw new UnauthorizedException('Email, số điện thoại hoặc mật khẩu chưa đúng.');
    this.active(candidate);
    if (!candidate.email) {
      // Password-proven phone-only legacy identity gets only a short add-email capability.
      const capability = randomBytes(48).toString('base64url'), id = randomUUID();
      const digest = this.challenges.digest('legacy', id, capability);
      await this.db.$executeRaw`insert into public.auth_legacy_email_proofs(id,user_id,proof_hash,fingerprint,expires_at) values(${id}::uuid,${candidate.id}::uuid,${digest},${candidate.passwordHash},clock_timestamp()+interval '5 minutes')`;
      throw new ForbiddenException({code:'EMAIL_REQUIRED',message:'Vui lòng bổ sung và xác minh email để tiếp tục.',details:{legacyId:id,legacyProof:capability}});
    }
    if (!candidate.emailVerifiedAt) {
      const challenge = await this.challenges.request('VERIFY_EMAIL',candidate.email,candidate.id,{},candidate.passwordHash,metadata.ip);
      throw new ForbiddenException({code:'EMAIL_VERIFICATION_REQUIRED',message:'Vui lòng xác minh email để tiếp tục.',details:challenge});
    }
    if ('phone' in where) throw new UnauthorizedException('Vui lòng đăng nhập bằng email và mật khẩu.');
    const result = await this.db.$transaction(async tx => {
      await this.lockUser(tx, candidate.id);
      const user = await tx.user.findUniqueOrThrow({ where: { id: candidate.id } });
      this.active(user);
      if (user.passwordHash !== candidate.passwordHash) throw sessionError();
      await this.setContext(tx, user.id);
      await tx.$queryRaw`select set_config('app.auth_action','login',true)`;
      return { user, issued: await this.newSession(tx, user.id, metadata) };
    });
    return this.response(result.user, result.issued);
  }
  async authenticate(token: string) {
    try {
      const { payload } = await jwtVerify(token, this.signingKey, {
        algorithms: ['HS256'], issuer: this.config.issuer, audience: this.config.audience,
        requiredClaims: ['sub', 'sid', 'typ', 'iat', 'exp'],
      });
      if (payload.typ !== 'access' || !payload.sub || !uuid.test(payload.sub) || typeof payload.sid !== 'string' || !uuid.test(payload.sid)) throw sessionError();
      const {session,user}=await this.db.identity(payload.sub,async tx=>({
        session:await tx.refreshSession.findUnique({where:{id:payload.sid as string}}),
        user:await tx.user.findUnique({where:{id:payload.sub}}),
      }));
      if (!user || !user.email || !user.emailVerifiedAt || user.status !== 'ACTIVE' || !session || session.userId !== user.id || session.revokedAt || session.expiresAt <= new Date()
        || typeof payload.iat !== 'number' || payload.iat < Math.floor(user.passwordChangedAt.getTime() / 1000)) throw sessionError();
      return { userId: user.id, userEmail: user.email ?? undefined, sessionId: session.id };
    } catch { throw sessionError(); }
  }
  async refresh(token: string, metadata: SessionMetadata) {
    const tokenHash = this.tokenHash(token, 'refresh');
    const candidate = await this.db.refreshSession.findUnique({ where: { tokenHash } });
    if (!candidate) throw sessionError();
    const result = await this.db.$transaction(async tx => {
      await this.lockUser(tx, candidate.userId);
      const old = await tx.refreshSession.findUniqueOrThrow({ where: { id: candidate.id } });
      const user = await tx.user.findUniqueOrThrow({ where: { id: old.userId } });
      if (old.revokedAt || old.replacedBySessionId) {
        // Commit this revocation before returning 401; throwing inside the transaction would undo it.
        await tx.refreshSession.updateMany({ where: { familyId: old.familyId, userId: old.userId, revokedAt: null }, data: { revokedAt: new Date() } });
        return null;
      }
      if (old.expiresAt <= new Date() || user.status !== 'ACTIVE' || !user.email || !user.emailVerifiedAt) return null;
      const issued = await this.newSession(tx, user.id, metadata, old.familyId);
      await tx.refreshSession.update({ where: { id: old.id }, data: { revokedAt: new Date(), replacedBySessionId: issued.session.id } });
      return { user, issued };
    });
    if (!result) throw sessionError();
    return this.response(result.user, result.issued);
  }
  async logout(token: string) {
    await this.db.$transaction(async tx => {
      await tx.$queryRaw`select set_config('app.auth_action','logout',true)`;
      await tx.refreshSession.updateMany({ where: { tokenHash: this.tokenHash(token, 'refresh'), revokedAt: null }, data: { revokedAt: new Date() } });
    });
    return { ok: true };
  }
  async logoutAll(userId: string) {
    await this.db.$transaction(async tx => {
      await this.lockUser(tx, userId);
      await tx.$queryRaw`select set_config('app.auth_action','logout_all',true)`;
      await tx.refreshSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    });
    return { ok: true };
  }
  async replacePassword(tx: UserTx, userId: string, passwordHash: string) {
    const user = await tx.user.update({ where: { id: userId }, data: { passwordHash, passwordChangedAt: new Date() } });
    await tx.refreshSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await tx.passwordResetToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: new Date() } });
    return user;
  }
  async changePassword(userId: string, currentPassword: string, newPassword: string, metadata: SessionMetadata) {
    this.passwordPolicy(newPassword);
    const hash = await argon2.hash(newPassword, { type: argon2.argon2id });
    const result = await this.db.$transaction(async tx => {
      await this.lockUser(tx, userId);
      const user = await this.verifyCurrent(tx, userId, currentPassword);
      if (user.email && await isBootstrappedReviewer(tx,user.id,user.email)) {
        // A v1 client only understands challenges. Fail before mutation rather
        // than handing it a nonexistent challenge or silently changing its password.
        if (metadata.authContract !== '2') throw new ForbiddenException({code:'CLIENT_UPDATE_REQUIRED',message:'Vui lòng cập nhật ứng dụng để tiếp tục.'});
        await this.replacePassword(tx,user.id,hash);
        return {user,completed:true};
      }
      return {user,completed:false};
    });
    if (result.completed) return {ok:true,reauthenticationRequired:true} as const;
    const user=result.user;
    if (!user.email || !user.emailVerifiedAt) throw sessionError();
    return this.challenges.request('CHANGE_PASSWORD',user.email,user.id,{passwordHash:hash,nextPasswordDigest:this.challenges.digest('new-password',newPassword)},user.passwordHash,metadata.ip,undefined,metadata.requestId);
  }
  async forgot(identifier: string, metadata: SessionMetadata = {}) {
    let user: User | null = null;
    try { user = await this.db.user.findUnique({ where: normalizeIdentifier(identifier) }); } catch (error) {
      if (!(error instanceof BadRequestException)) throw error;
    }
    const email=normalizeEmail(identifier);
    if (user && await isBootstrappedReviewer(this.db,user.id,email)) throw reviewerOperationUnavailable();
    const eligible=user?.status==='ACTIVE'&&!!user.emailVerifiedAt ? user : null;
    const challenge=await this.challenges.request('RESET',email,eligible?.id || null,{},eligible?.passwordHash || '', metadata.ip,undefined,metadata.requestId);
    return {accepted:true,message:'Nếu tài khoản đủ điều kiện, mã xác nhận sẽ được gửi.',...challenge};
  }
  async reset(token: string, newPassword: string) {
    // Retired raw-token path fails closed, including old dev-disclosed tokens.
    throw new BadRequestException({code:'OTP_PROOF_REQUIRED',message:'Vui lòng xác minh OTP trước khi đặt lại mật khẩu.'});
  }
  private async boundUser(tx: UserTx, row: Challenge) {
    if (!row.user_id) throw sessionError();
    await this.lockUser(tx,row.user_id);
    const user=await tx.user.findUnique({where:{id:row.user_id}});
    if (!user || user.status!=='ACTIVE' || user.passwordHash!==row.fingerprint) throw sessionError();
    if (row.purpose==='LEGACY_EMAIL' ? user.email!==null : row.purpose==='CHANGE_EMAIL_NEW' ? user.email!==row.payload.oldEmail : user.email!==row.email) throw sessionError();
    return user;
  }
  async verifyEmailChallenge(proof: ChallengeProof, purpose: OtpPurpose, code: string, metadata: SessionMetadata, userId?: string) {
    const result=await this.challenges.verify(proof,purpose,code,async(tx,row,now)=>{
      if (['CHANGE_PASSWORD','CHANGE_EMAIL_OLD','CHANGE_EMAIL_NEW'].includes(purpose) && row.user_id!==userId) throw sessionError();
      if(purpose==='REGISTER') {
        const p=row.payload;
        if (await tx.user.findUnique({where:{email:row.email}})) throw new ConflictException({code:'IDENTIFIER_IN_USE',message:'Email đã được sử dụng.'});
        let user:User;
        try {user=await tx.user.create({data:{email:row.email,phone:p.phone,passwordHash:p.passwordHash,emailVerifiedAt:now,termsAcceptedAt:new Date(p.acceptedAt),privacyAcceptedAt:new Date(p.acceptedAt)}});}catch(e){this.conflict(e);}
        await this.setContext(tx,user.id);
        await tx.$queryRaw`select public.provision_home(${user.id}::uuid,${p.displayName},${p.workspaceType})`;
        return {user,issued:await this.newSession(tx,user.id,metadata)};
      }
      const user=await this.boundUser(tx,row);
      if(purpose==='RESET'||purpose==='CHANGE_EMAIL_OLD') return this.challenges.ticket(tx,row,now);
      if(purpose==='CHANGE_PASSWORD') {
        await this.replacePassword(tx,user.id,row.payload.passwordHash);
        return {ok:true,reauthenticationRequired:true};
      }
      if(purpose==='CHANGE_EMAIL_NEW') {
        try {await tx.user.update({where:{id:user.id},data:{email:row.email,emailVerifiedAt:now}});}catch(e){this.conflict(e);}
        await tx.refreshSession.updateMany({where:{userId:user.id,revokedAt:null},data:{revokedAt:now}});
        return {ok:true,reauthenticationRequired:true};
      }
      const verified=await tx.user.update({where:{id:user.id},data:{email:row.email,emailVerifiedAt:now}});
      await tx.refreshSession.updateMany({where:{userId:user.id,revokedAt:null},data:{revokedAt:now}});
      return {user:verified,issued:await this.newSession(tx,user.id,metadata)};
    });
    return 'user' in result && result.user && result.issued ? this.response(result.user,result.issued) : result;
  }
  async resetWithTicket(proof: ChallengeProof,ticket:string,newPassword:string) {
    this.passwordPolicy(newPassword);
    const hash=await argon2.hash(newPassword,{type:argon2.argon2id});
    return this.challenges.useTicket(proof,'RESET',ticket,async(tx,row)=>{
      const user=await this.boundUser(tx,row);
      if(!user.emailVerifiedAt)throw sessionError();
      await this.replacePassword(tx,user.id,hash);
      return {ok:true,reauthenticationRequired:true};
    });
  }
  async requestEmailChange(userId:string,currentPassword:string,metadata:SessionMetadata) {
    const user=await this.db.$transaction(tx=>this.verifyCurrent(tx,userId,currentPassword));
    if(!user.email||!user.emailVerifiedAt)throw sessionError();
    if(await isBootstrappedReviewer(this.db,user.id,user.email))throw reviewerOperationUnavailable();
    return this.challenges.request('CHANGE_EMAIL_OLD',user.email,user.id,{},user.passwordHash,metadata.ip);
  }
  async requestNewEmail(userId:string,proof:ChallengeProof,ticket:string,email:string,metadata:SessionMetadata) {
    const normalized=normalizeEmail(email);
    return this.challenges.useTicket(proof,'CHANGE_EMAIL_OLD',ticket,async(tx,row)=>{
      if(row.user_id!==userId)throw sessionError();
      const user=await this.boundUser(tx,row);
      if(user.email===normalized||await tx.user.findUnique({where:{email:normalized}}))throw new ConflictException({code:'IDENTIFIER_IN_USE',message:'Chọn email mới chưa được sử dụng.'});
      return this.challenges.request('CHANGE_EMAIL_NEW',normalized,user.id,{oldEmail:user.email},user.passwordHash,metadata.ip,tx);
    });
  }
  async addLegacyEmail(id:string,proof:string,email:string,metadata:SessionMetadata) {
    const normalized=normalizeEmail(email);
    return this.db.$transaction(async tx=>{
      const row=(await tx.$queryRaw<Array<{user_id:string;proof_hash:string;fingerprint:string;expires_at:Date;used_at:Date|null}>>`select * from public.auth_legacy_email_proofs where id=${id}::uuid for update`)[0];
      if(!row||row.used_at||row.expires_at<=new Date()||row.proof_hash!==this.challenges.digest('legacy',id,proof))throw sessionError();
      const user=await tx.user.findUnique({where:{id:row.user_id}});
      if(!user||user.status!=='ACTIVE'||user.email||user.passwordHash!==row.fingerprint)throw sessionError();
      if(await tx.user.findUnique({where:{email:normalized}}))throw new ConflictException({code:'IDENTIFIER_IN_USE',message:'Email đã được sử dụng.'});
      const challenge=await this.challenges.request('LEGACY_EMAIL',normalized,user.id,{},user.passwordHash,metadata.ip,tx);
      await tx.$executeRaw`update public.auth_legacy_email_proofs set used_at=clock_timestamp() where id=${id}::uuid`;
      return challenge;
    });
  }
  async identifiers(userId: string, body: ChangeIdentifiersDto) {
    if (body.newEmail === undefined && body.newPhone === undefined) throw new BadRequestException('Vui lòng nhập thông tin cần thay đổi.');
    try {
      return await this.db.$transaction(async tx => {
        await this.lockUser(tx, userId);
        const user = await this.verifyCurrent(tx, userId, body.currentPassword);
        const email = body.newEmail === undefined ? user.email : body.newEmail?.trim() ? normalizeEmail(body.newEmail) : null;
        const phone = body.newPhone === undefined ? user.phone : body.newPhone?.trim() ? normalizePhone(body.newPhone) : null;
        if (!email || email!==user.email) throw new BadRequestException({code:'OTP_PROOF_REQUIRED',message:'Đổi email cần xác minh địa chỉ hiện tại và địa chỉ mới.'});
        await tx.user.update({ where: { id: userId }, data: { email, phone,
          ...(email !== user.email ? { emailVerifiedAt: null } : {}), ...(phone !== user.phone ? { phoneVerifiedAt: null } : {}) } });
        return { ok: true, email, phone };
      });
    } catch (error) { this.conflict(error); }
  }
  async closeAccount(userId: string, password: string, status: 'DISABLED' | 'DELETED') {
    try {
      await this.db.$transaction(async tx => {
        await tx.$executeRaw`select public.family_lock()`;
        await this.lockUser(tx, userId);
        const subject=await this.verifyCurrent(tx, userId, password);
        if(subject.email && await isBootstrappedReviewer(tx,subject.id,subject.email))throw reviewerOperationUnavailable();
        await this.setContext(tx, userId);
        await tx.$executeRaw`select public.close_account_workspaces(${userId}::uuid)`;
        await tx.user.update({ where: { id: userId }, data: { status, deletedAt: status === 'DELETED' ? new Date() : null } });
        await tx.refreshSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
        await tx.passwordResetToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: new Date() } });
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('OWNER_TRANSFER_REQUIRED')) throw new ConflictException({ code: 'OWNER_TRANSFER_REQUIRED', message: 'Vui lòng chuyển quyền sở hữu workspace có thành viên khác trước khi đóng tài khoản.' });
      throw error;
    }
    return { ok: true, status };
  }
}

// Handled by Le Nguyen Quoc Hung
