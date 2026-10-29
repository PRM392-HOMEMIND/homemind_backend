import { ConflictException, Injectable, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { environment } from '../config/env';
import { invalidateWorkspace } from '../common/workspace-cache';
import { PayosProvider } from './payos.provider';
type Order = {id:string; workspace_id:string; order_code:bigint|string; channel:string; description:string;
  price_snapshot:{amount:number;plan:string}; payment_link_id:string|null; status:string; lease_id:string; create_attempted:boolean; cancel_requested:boolean; expires_at:string};
export type PublicPayment = {id:string; status:string; financialState:string; fulfillment:string; checkoutUrl:string|null; [key:string]:unknown};
@Injectable()
export class BillingService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private draining = false;
  private stopped = false;
  private activeWork?: Promise<unknown>;
  constructor(private readonly db:DatabaseService, private readonly provider:PayosProvider) {}
  onModuleInit() {
    if (!this.provider.enabled) return;
    this.timer=setInterval(()=>{ if (!this.draining && !this.stopped) {
      this.draining=true;
      this.activeWork=this.sync(null).catch(()=>undefined).finally(()=>{this.draining=false;});
    }},10000);
    this.timer.unref();
  }
  async onModuleDestroy() { this.stopped=true; if(this.timer) clearInterval(this.timer); await this.activeWork; }
  async plans() {
    const plans = await this.db.$queryRaw<Array<{id:string;plan:string;amount:number;currency:string;duration_seconds:number;voice_limit:number;workspace_type:string;policy_version:string;product_limit:number|null}>>`
      select id,plan,amount,currency,duration_seconds,voice_limit,workspace_type,policy_version,product_limit from public.billing_prices where active order by amount`;
    return {plans:plans.map(p=>({id:p.id,plan:p.plan,amount:p.amount,currency:p.currency,
      durationSeconds:p.duration_seconds,voiceLimit:p.voice_limit,policyVersion:p.policy_version,
      productLimit:p.product_limit,workspaceTypes:[p.workspace_type],transition:'immediate_upgrade',autoRenew:false})),checkoutEnabled:this.provider.enabled};
  }
  async read(userId:string,workspaceId:string,id:string|null,offset=0) {
    const rows=await this.db.asUser(userId,tx=>tx.$queryRaw<Array<{result:PublicPayment}>>`
      select public.billing_read(${workspaceId}::uuid,${id}::uuid,${offset}::int) as result`);
    return rows[0].result;
  }
  async create(userId:string,workspaceId:string,priceId:string,key:string) {
    this.requireEnabled();
    const hash=createHash('sha256').update(JSON.stringify({priceId,transition:'immediate_upgrade'})).digest('hex');
    const rows=await this.db.asUser(userId,tx=>tx.$queryRaw<Array<{result:PublicPayment}>>`
      select public.billing_prepare(${workspaceId}::uuid,${priceId},${key}::uuid,${hash},${environment().billingNamespace}::int,${this.provider.channel}) as result`);
    const payment=rows[0].result;
    await this.sync(payment.id);
    return this.read(userId,workspaceId,payment.id);
  }
  async reconcile(userId:string,workspaceId:string,id:string) {
    this.requireEnabled(); await this.read(userId,workspaceId,id);
    await this.sync(id); return this.read(userId,workspaceId,id);
  }
  async cancel(userId:string,workspaceId:string,id:string) {
    this.requireEnabled(); const payment=await this.read(userId,workspaceId,id);
    if(payment.financialState==='PAID') throw new ConflictException({code:'PAYMENT_ALREADY_PAID',message:'Đơn đã thanh toán; không thể hủy.'});
    await this.system('request_cancel',id,{});
    await this.sync(id,true);
    const result=await this.read(userId,workspaceId,id);
    if(result.financialState==='PAID' || result.financialState==='PARTIAL') throw new ConflictException({code:'PAYMENT_HAS_FUNDS',message:'Đơn đã nhận tiền; cần kiểm tra trước khi hủy.'});
    if(result.status==='REVIEW') throw new ConflictException({code:'PAYMENT_REQUIRES_REVIEW',message:'Đơn thanh toán cần được kiểm tra.'});
    if(!['CANCELLED','EXPIRED'].includes(result.status)) throw this.cancelPending();
    return result;
  }
  private cancelPending() { return new ServiceUnavailableException({code:'PAYMENT_CANCEL_PENDING',message:'Đã ghi nhận yêu cầu hủy; chưa xác nhận được trạng thái với nhà cung cấp.'}); }
  private requireEnabled() { if(!this.provider.enabled) throw new ServiceUnavailableException({code:'BILLING_NOT_CONFIGURED',message:'Thanh toán chưa được cấu hình.'}); }
  async system<T>(action:string,id:string|null,data:object):Promise<T> {
    const rows=await this.db.$queryRaw<Array<{result:T}>>`select public.billing_system(${action},${id}::uuid,${JSON.stringify({...data,channel:this.provider.channel})}::jsonb) as result`;
    return rows[0].result;
  }
  async sync(id:string|null,cancel=false):Promise<void> {
    const order=await this.system<Order|null>('claim',id,{}); if(!order) return;
    cancel=cancel || order.cancel_requested;
    try {
      const code=Number(order.order_code); if(!Number.isSafeInteger(code)) throw new Error('PROVIDER_IDENTITY_CONFLICT');
      let link=await this.provider.get(code);
      if(link && !order.payment_link_id && !order.create_attempted) { await this.system('review',order.id,{}); return; }
      if(link && !order.payment_link_id && link.status==='PENDING' && link.amountPaid===0) {
        await this.system('recover_create',order.id,{...link,leaseId:order.lease_id});
        order.payment_link_id=link.id;
      }
      if(!link && !order.payment_link_id && new Date(order.expires_at).getTime()<=Date.now()) {
        await this.system('expire_absent',order.id,{leaseId:order.lease_id}); return;
      }
      // A previous create may have reached the provider. Keep its cancellation
      // intent durable and look it up later; never send another create POST.
      if(!link && cancel) throw this.cancelPending();
      if(!link && !cancel && !order.payment_link_id && new Date(order.expires_at).getTime()>Date.now()) {
        const config=environment();
        await this.system('begin_create',order.id,{leaseId:order.lease_id});
        const created=await this.provider.create({orderCode:code,amount:order.price_snapshot.amount,description:order.description,
          returnUrl:config.payosReturnUrl,cancelUrl:config.payosCancelUrl,expiredAt:Math.floor(new Date(order.expires_at).getTime()/1000)});
        await this.system('attach',order.id,created); link=await this.provider.get(code);
      }
      if(link) {
        const settled=await this.system<PublicPayment>('settle',order.id,link);
        if(cancel && settled.financialState==='UNPAID' && settled.status!=='REVIEW' && settled.fulfillment!=='REVIEW'
          && ['PENDING','PROCESSING'].includes(link.status) && link.amountPaid===0 && order.payment_link_id && link.id===order.payment_link_id) {
          await this.system('settle',order.id,await this.provider.cancel(code));
        }
      }
    } catch(error) {
      if(error instanceof Error && (error.message.includes('PROVIDER_IDENTITY_CONFLICT') || error.message==='PROVIDER_CREATE_REJECTED')) await this.system('review',order.id,{});
      if(cancel) throw this.cancelPending();
    } finally {
      await this.system('release',order.id,{leaseId:order.lease_id}); invalidateWorkspace(order.workspace_id);
    }
  }
  async webhook(body:unknown) {
    const data=await this.provider.verify(body);
    const inbox=await this.system<{id:string|null;durable:boolean}>('inbox',null,data);
    if(inbox.id) {
      const link=await this.provider.get(data.orderCode);
      if(!link) throw new ServiceUnavailableException({code:'PROVIDER_UNAVAILABLE',message:'Chưa tra cứu được đơn thanh toán.'});
      await this.system('settle',inbox.id,link);
    }
    return {code:'00',desc:'Accepted'};
  }
}
