import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as nodemailer from 'nodemailer';
import { emailConfig } from './email.config';

export type EmailContent = { subject: string; html: string; text: string };
export type EmailOutcome = { state: 'accepted' | 'delivered' | 'failed' | 'suppressed' | 'unknown'; messageId: string; code?: string; retryable?: boolean };
export function providerStatus(status: { groupId?: number; name?: string } | undefined): EmailOutcome['state'] {
  if (!status) return 'unknown';
  if (/BLOCK|SUPPRESS|COMPLAINT|HARD_BOUNCE/.test(status.name || '')) return 'suppressed';
  return status.groupId === 3 ? 'delivered' : [2, 4, 5].includes(status.groupId || 0) ? 'failed' : [1, 6].includes(status.groupId || 0) ? 'accepted' : 'unknown';
}
const base64Lines = (text: string) => Buffer.from(text).toString('base64').match(/.{1,76}/g)?.join('\r\n') || '';
export function mimeEmail(from: string, to: string, content: EmailContent, messageId: string) {
  if ([from, to, content.subject, messageId].some(s => /[\r\n]/.test(s))) throw Error('EMAIL_HEADER_INVALID');
  const boundary = 'homemind_' + randomUUID().replace(/-/g, '');
  const related = 'related_' + randomUUID().replace(/-/g, '');
  const body = [`From: HomeMind <${from}>`, `To: <${to}>`, `Subject: =?UTF-8?B?${Buffer.from(content.subject).toString('base64')}?=`,
    `Date: ${new Date().toUTCString()}`, `Message-ID: <${messageId}@${from.split('@')[1]}>`, 'MIME-Version: 1.0',
    `Content-Type: multipart/related; boundary="${related}"`, '', `--${related}`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', base64Lines(content.text),
    `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', base64Lines(content.html), `--${boundary}--`,
    `--${related}`, 'Content-Type: image/png', 'Content-ID: <homemind-logo>', 'Content-Disposition: inline; filename="homemind-logo.png"', 'Content-Transfer-Encoding: base64', '',
    readFileSync(join(__dirname,'../../assets/email-logo.png')).toString('base64').match(/.{1,76}/g)!.join('\r\n'), `--${related}--`, ''];
  return Buffer.from(body.join('\r\n')).toString('base64');
}
@Injectable()
export class InfobipProvider {
  private readonly config = emailConfig();
  private active = 0;
  private smtpTransporter: nodemailer.Transporter | null = null;

  private getSmtpTransporter() {
    if (!this.smtpTransporter) {
      this.smtpTransporter = nodemailer.createTransport({
        host: this.config.smtpHost,
        port: this.config.smtpPort,
        secure: this.config.smtpSecure,
        auth: {
          user: this.config.smtpUser,
          pass: this.config.smtpPass,
        },
      });
    }
    return this.smtpTransporter;
  }

  available() { return ['infobip', 'smtp', 'development'].includes(this.config.mode); }

  async send(to: string, content: EmailContent, messageId: string, security = false): Promise<EmailOutcome> {
    if (!this.available()) return { state: 'failed', messageId, code: 'EMAIL_DISABLED' };

    if (this.config.mode === 'development') {
      console.log(`\n================== [EMAIL DEV LOG] ==================`);
      console.log(`To: ${to}`);
      console.log(`Subject: ${content.subject}`);
      console.log(`Body:\n${content.text}`);
      console.log(`====================================================\n`);
      return { state: 'delivered', messageId, code: 'DEV_LOGGED' };
    }

    if (this.config.mode === 'smtp') {
      try {
        const transporter = this.getSmtpTransporter();
        await transporter.sendMail({
          from: this.config.smtpFrom,
          to,
          subject: content.subject,
          text: content.text,
          html: content.html,
        });
        return { state: 'delivered', messageId, code: 'SMTP_SENT' };
      } catch (error) {
        console.error('SMTP send error:', error);
        return { state: 'failed', messageId, code: 'SMTP_ERROR', retryable: true };
      }
    }

    if (this.active >= this.config.concurrency) return { state: 'failed', messageId, code: 'EMAIL_BUSY', retryable: true };
    this.active++;
    try {
      // v4 JSON MIME is deliberate: v4 /messages discards text when HTML is present.
      const response = await fetch(this.config.baseUrl + '/email/4/mime', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.config.timeoutMs),
        headers: { Authorization: 'App ' + this.config.key, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ from: this.config.from, destinations: [to], messageId, mimeMessage: mimeEmail(this.config.from, to, content, messageId), clientPriority: security ? 'HIGH' : 'STANDARD' }),
      });
      if (!response.ok) return { state: 'failed', messageId, code: 'EMAIL_HTTP_' + response.status,
        retryable: response.status === 429 || response.status >= 500 };
      const payload = await response.json() as { messages?: Array<{ messageId?: string; status?: { groupId?: number; name?: string } }> };
      const message = payload.messages?.find(m => m.messageId === messageId) ?? (payload.messages?.length === 1 ? payload.messages[0] : undefined);
      if (!message?.messageId) return { state: 'unknown', messageId, code: 'EMAIL_RESPONSE_INVALID' };
      return { state: providerStatus(message.status), messageId: message.messageId, code: message.status?.name?.replace(/[^A-Z0-9_]/g, '').slice(0, 80) };
    } catch {
      // A lost response can mean the provider accepted it. Never blindly replay.
      return { state: 'unknown', messageId, code: 'EMAIL_SUBMIT_UNKNOWN' };
    } finally { this.active--; }
  }

  async report(messageId: string): Promise<EmailOutcome | null> {
    if (!this.available()) return null;
    if (this.config.mode === 'smtp' || this.config.mode === 'development') {
      return { state: 'delivered', messageId, code: 'DELIVERED' };
    }
    // Filter by our owned message only; never drain another application's one-shot reports.
    const response = await fetch(this.config.baseUrl + '/email/4/reports?messageId=' + encodeURIComponent(messageId), {
      redirect: 'error', signal: AbortSignal.timeout(this.config.timeoutMs), headers: { Authorization: 'App ' + this.config.key, Accept: 'application/json' },
    });
    if (!response.ok) throw Error('EMAIL_REPORT_HTTP_' + response.status);
    const payload = await response.json() as { results?: Array<{ messageId: string; status: { groupId?: number; name?: string } }> };
    const result = payload.results?.find(row => row.messageId === messageId);
    return result ? { state: providerStatus(result.status), messageId, code: result.status?.name?.replace(/[^A-Z0-9_]/g, '').slice(0, 80) } : null;
  }
}
