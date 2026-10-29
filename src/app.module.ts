import { Module } from '@nestjs/common';
import { DatabaseService } from './database/database.service';
import { AuthGuard } from './auth/auth.guard';
import { MeController } from './me/me.controller';
import { InventoryController } from './inventory/inventory.controller';
import { InventoryService } from './inventory/inventory.service';
import { ShoppingController } from './shopping/shopping.controller';
import { ShoppingService } from './shopping/shopping.service';
import { HomeController } from './home/home.controller';
import { HomeService } from './home/home.service';
import { AssistantController } from './assistant/assistant.controller';
import { AssistantService } from './assistant/assistant.service';
import { AiPlanner } from './assistant/planner';
import { NotificationsController,AccountNotificationsController } from './notifications/notifications.controller';
import { NotificationsService } from './notifications/notifications.service';
import { SnapshotService } from './snapshot/snapshot.service';
import { BootstrapController } from './snapshot/bootstrap.controller';
import { UpgradeController } from './billing/upgrade.controller';
import { PlanGuard } from './billing/plan-guard.service';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { ResetDeliveryService } from './auth/reset-delivery.service';
import { environment } from './config/env';
import { HealthController } from './health/health.controller';
import { BillingController, BillingPublicController } from './billing/billing.controller';
import { BillingService } from './billing/billing.service';
import { PayosProvider } from './billing/payos.provider';
import { SearchController } from './search/search.controller';
import { SearchService } from './search/search.service';
import { AuthenticatedReadThrottleGuard } from './common/authenticated-read-throttle.guard';
import { AdminModule } from './admin/admin.module';
import { FeedbackPopupPublicController } from './feedback-popup/feedback-popup.controller';
import { FeedbackPopupService } from './feedback-popup/feedback-popup.service';
import { FeedbackPopupReconciler } from './feedback-popup/feedback-popup.reconciler';
import { PublicCorsGuard } from './feedback-popup/feedback-popup.cors';
import { SpendingController } from './spending/spending.controller';
import { SpendingService } from './spending/spending.service';
import { FamilyService } from './family/family.service';
import { FamilyOwnerGuard } from './family/family-owner.guard';
import { FamilyAccountController, FamilyWorkspaceController } from './family/family.controller';
import { InfobipProvider } from './email/infobip.provider';
import { EmailChallengeService } from './auth/email-challenge.service';
import { EmailDeliveryService } from './email/email-delivery.service';

@Module({
  imports: [AdminModule, ThrottlerModule.forRoot([{ ttl: 60_000, limit: environment().authRateLimit }])],
  controllers: [AccountNotificationsController,FamilyAccountController,FamilyWorkspaceController,SearchController, BillingController, BillingPublicController, HealthController, AuthController, MeController, InventoryController, ShoppingController, HomeController, AssistantController, NotificationsController, BootstrapController, UpgradeController, FeedbackPopupPublicController, SpendingController],
  providers: [InfobipProvider,EmailChallengeService,EmailDeliveryService,FamilyOwnerGuard,FamilyService,AuthenticatedReadThrottleGuard, SearchService, BillingService, PayosProvider, AuthService, ResetDeliveryService, DatabaseService, SnapshotService, PlanGuard, AuthGuard, InventoryService, ShoppingService, HomeService, AiPlanner, AssistantService, NotificationsService, FeedbackPopupService, FeedbackPopupReconciler, PublicCorsGuard, SpendingService],
})
export class AppModule {}
