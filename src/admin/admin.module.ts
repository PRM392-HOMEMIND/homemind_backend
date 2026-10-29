import { Module } from '@nestjs/common';
import { AdminDatabase } from './admin.database';
import { AdminAuth, AdminGuard } from './admin.auth';
import { AdminRead } from './admin.read';
import { AdminAuthController, AdminReadController } from './admin.controller';
import { AdminFeedback } from './admin.feedback';
import { AdminFeedbackController } from './admin.feedback.controller';
@Module({controllers:[AdminAuthController,AdminReadController,AdminFeedbackController],providers:[AdminDatabase,AdminAuth,AdminGuard,AdminRead,AdminFeedback]})
export class AdminModule {}
