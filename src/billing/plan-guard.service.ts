import { Injectable } from '@nestjs/common';
import { SnapshotService } from '../snapshot/snapshot.service';
import { PlanLimitException } from './plan-limit.exception';
export { PlanLimitException } from './plan-limit.exception';

/**
 * Chặn cứng khi vượt hạn mức sản phẩm của gói (workspace_entitlements.product_limit;
 * Miễn phí = 30). Chỉ món MỚI mới bị chặn: nhập thêm lô cho sản phẩm đã có vẫn được.
 */
@Injectable()
export class PlanGuard {
  constructor(private readonly snapshots: SnapshotService) {}

  async assertCanAddProduct(userId: string, workspaceId: string, input: { productName?: string | null; productCandidateId?: string | null }): Promise<void> {
    const snapshot = await this.snapshots.get(userId, workspaceId);
    const { freePlanLimit: limit, productCountTowardLimit: count, plan } = snapshot.home;
    if (limit === null || count < limit) return; // gói không giới hạn hoặc còn chỗ
    const name = input.productName?.trim().toLowerCase();
    const alreadyExists = snapshot.products.some(
      (product) => (!!input.productCandidateId && product.id === input.productCandidateId) || (!!name && product.name.trim().toLowerCase() === name),
    );
    if (alreadyExists) return;
    throw new PlanLimitException(plan, limit, count);
  }
}
