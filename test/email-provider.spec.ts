import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InfobipProvider, mimeEmail, providerStatus } from '../src/email/infobip.provider';
import { emailConfig } from '../src/email/email.config';
import { notificationRegistry, notificationTemplate, otpTemplate, otpTitles } from '../src/email/email.templates';

const email='owned@example.invalid',key=randomBytes(32).toString('hex');
function configured(){vi.stubEnv('EMAIL_DELIVERY_MODE','infobip');vi.stubEnv('AUTH_OTP_SECRET',randomBytes(32).toString('hex'));vi.stubEnv('INFOBIP_BASE_URL','https://owned-test.api.infobip.com');vi.stubEnv('INFOBIP_API_KEY',key);vi.stubEnv('INFOBIP_EMAIL_FROM','no-reply@example.invalid');}
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
describe('Infobip v4 JSON MIME adapter and safe email renderer (mock HTTP)',()=>{
  it('validates HTTPS account origin, credentials, sender, independent secret and bounded concurrency',()=>{
    for(const [name,value] of [['INFOBIP_BASE_URL','http://owned-test.api.infobip.com'],['INFOBIP_BASE_URL','https://evil.invalid'],['INFOBIP_BASE_URL','https://owned-test.api.infobip.com/evil'],['INFOBIP_API_KEY',''],['INFOBIP_EMAIL_FROM','bad'],['AUTH_OTP_SECRET',key],['EMAIL_WORKER_CONCURRENCY','100']]){
      configured();vi.stubEnv(name,value);expect(()=>emailConfig()).toThrow();
    }
  });
  it('fails closed without a provider; never sends on module import/build or falls back to console',async()=>{
    vi.stubEnv('EMAIL_DELIVERY_MODE','disabled');const network=vi.fn();vi.stubGlobal('fetch',network);
    expect(await new InfobipProvider().send(email,otpTemplate('REGISTER','000042',new Date()),randomUUID())).toMatchObject({state:'failed',code:'EMAIL_DISABLED'});expect(network).not.toHaveBeenCalled();
  });
  it('submits one destination, HomeMind name, true multipart HTML/text, client message ID, high priority; no CC/BCC',async()=>{
    configured();const id=randomUUID(),content=otpTemplate('REGISTER','000042',new Date(Date.now()+60000));
    const network=vi.fn().mockResolvedValue(new Response(JSON.stringify({messages:[{messageId:id,status:{groupId:1,name:'PENDING_ACCEPTED'}}]}),{status:200}));vi.stubGlobal('fetch',network);
    expect(await new InfobipProvider().send(email,content,id,true)).toMatchObject({state:'accepted',messageId:id});
    const [url,request]=network.mock.calls[0];expect(url).toBe('https://owned-test.api.infobip.com/email/4/mime');
    const payload=JSON.parse(request.body);expect(payload.destinations).toEqual([email]);expect(payload.clientPriority).toBe('HIGH');expect(payload.messageId).toBe(id);
    const mime=Buffer.from(payload.mimeMessage,'base64').toString();expect(mime).toContain('From: HomeMind');expect(mime).toContain('multipart/alternative');expect(mime).toContain('text/plain');expect(mime).toContain('text/html');expect(mime).not.toContain('\r\nCc:');expect(mime).not.toContain('\r\nBcc:');
    expect(request.redirect).toBe('error');expect(payload).not.toHaveProperty('notifyUrl');expect(payload).not.toHaveProperty('trackingUrl');
  });
  for(const status of [400,401,403,429,500,503])it(`HTTP ${status} is sanitized and retries only transient failures`,async()=>{
    configured();vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('private provider error '+key,{status})));
    const result=await new InfobipProvider().send(email,otpTemplate('RESET','000042',new Date()),randomUUID());
    expect(result).toMatchObject({state:'failed',code:'EMAIL_HTTP_'+status,retryable:status===429||status>=500});expect(JSON.stringify(result)).not.toContain(key);
  });
  it('lost response/timeout/malformed success are unknown, not automatically retried',async()=>{
    configured();for(const network of [vi.fn().mockRejectedValue(new Error('timeout '+key)),vi.fn().mockResolvedValue(new Response('{}',{status:200}))]){
      vi.stubGlobal('fetch',network);expect(await new InfobipProvider().send(email,otpTemplate('RESET','000042',new Date()),randomUUID())).toMatchObject({state:'unknown'});expect(network).toHaveBeenCalledTimes(1);
    }
  });
  it('handles per-message rejection even with HTTP 200 and hard-bounce suppression',async()=>{
    configured();const id=randomUUID();vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({messages:[{messageId:id,status:{groupId:5,name:'REJECTED_DOMAIN_NOT_VERIFIED'}}]}))));
    expect(await new InfobipProvider().send(email,otpTemplate('REGISTER','000042',new Date()),id)).toMatchObject({state:'failed'});
    expect(providerStatus({groupId:2,name:'HARD_BOUNCE'})).toBe('suppressed');expect(providerStatus({groupId:3,name:'DELIVERED'})).toBe('delivered');
  });
  it('queries only an owned message report; never retrieves the global one-shot report stream',async()=>{
    configured();const id=randomUUID(),network=vi.fn().mockResolvedValue(new Response(JSON.stringify({results:[{messageId:id,status:{groupId:3,name:'DELIVERED'}}]})));vi.stubGlobal('fetch',network);
    expect(await new InfobipProvider().report(id)).toMatchObject({state:'delivered',messageId:id});expect(network.mock.calls[0][0]).toBe('https://owned-test.api.infobip.com/email/4/reports?messageId='+id);
  });
  it('bounds concurrent provider work and returns explicit pressure instead of unlimited waiting',async()=>{
    configured();vi.stubEnv('EMAIL_WORKER_CONCURRENCY','2');let finish!:()=>void;const blocked=new Promise<void>(resolve=>finish=resolve);
    vi.stubGlobal('fetch',vi.fn(async()=>{await blocked;return new Response('{}');}));const provider=new InfobipProvider(),content=otpTemplate('REGISTER','000042',new Date());
    const a=provider.send(email,content,randomUUID()),b=provider.send(email,content,randomUUID());expect(await provider.send(email,content,randomUUID())).toMatchObject({code:'EMAIL_BUSY',retryable:true});finish();await Promise.all([a,b]);
  });
  it('all purposes render Vietnamese code as text with exact TTL wording; no OTP in subject/preheader/links',()=>{
    for(const purpose of Object.keys(otpTitles) as Array<keyof typeof otpTitles>){const content=otpTemplate(purpose,'000042',new Date());expect(content.text).toContain('60 giây kể từ khi được tạo');expect(content.subject).not.toContain('000042');expect(content.html).toContain('000042');expect(content.html).not.toContain('href=');expect(content.html).not.toContain('{{pin}}');}
  });
  it('registry templates are contextual, escape hostile data, reject unmapped events, exclude login/logout',()=>{
    for(const [kind,category] of Object.entries(notificationRegistry)){
      const content=notificationTemplate({kind,title:'Đã cập nhật',summary:'Sự việc',detail:'Món sữa: thêm 2 hộp. <img src=x onerror=alert(1)>',occurredAt:new Date()});
      if(category===null){expect(content).toBeNull();continue;}
      expect(content!.html).toContain('&lt;img');expect(content!.html).not.toContain('<img src=x');expect(content!.text).toContain('thêm 2 hộp');expect(content!.text).toContain('giờ Việt Nam');
    }
    expect(()=>notificationTemplate({kind:'unexpected',title:'x',summary:'x',detail:'x',occurredAt:new Date()})).toThrow('UNMAPPED');
    expect(()=>mimeEmail('no-reply@example.invalid',email,{subject:'Subject\r\nBcc: evil',html:'',text:''},randomUUID())).toThrow('HEADER');
  });
});
