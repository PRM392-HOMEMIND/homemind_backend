import { Injectable } from '@nestjs/common';
import { environment } from '../config/env';

/** Add an email/SMS adapter before enabling verification or production reset delivery. */
export interface IdentifierVerificationProvider {
  sendVerification(userId: string, identifier: string): Promise<void>;
}
@Injectable()
export class ResetDeliveryService {
  async deliver(_identifier: string, token: string): Promise<{ devResetToken?: string }> {
    // Retired compatibility adapter. No raw reset credential can be disclosed in any mode.
    return {};
  }
}
