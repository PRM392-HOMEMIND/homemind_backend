import { Injectable } from '@nestjs/common';
import { DatabaseService, UserTx } from '../database/database.service';
import { InventoryService } from '../inventory/inventory.service';
import { ShoppingService } from '../shopping/shopping.service';
import { SnapshotService } from '../snapshot/snapshot.service';

@Injectable()
export class HomeService {
  constructor(private readonly db: DatabaseService, private readonly inventory: InventoryService, private readonly shopping: ShoppingService, private readonly snapshots: SnapshotService) {}

  async summaryIn(tx: UserTx, workspaceId: string) {
    const inventory = await this.inventory.listIn(tx, workspaceId, { limit: 100000 });
    const shopping = await this.shopping.listIn(tx, workspaceId);
    const entitlement = await tx.$queryRaw<Array<{ plan: string; product_limit: number | null }>>`
      select e->>'plan' as plan,(e->>'productLimit')::integer as product_limit
      from (select public.billing_effective(${workspaceId}::uuid) as e) effective`;
    const expiringSoon = inventory.items.filter((item) => item.status === 'in_stock' && ['soon','urgent'].includes(item.expiryLevel));
    const expired = inventory.items.filter((item) => item.status === 'in_stock' && item.expiryLevel === 'expired');
    return {
      toolId: 'home.summary', totalProducts: inventory.total,
      inStockCount: inventory.items.filter((i) => i.status === 'in_stock').length,
      outCount: inventory.items.filter((i) => i.status === 'out').length,
      expiredCount: expired.length, expiringSoonCount: expiringSoon.length,
      shoppingNeededCount: shopping.total,
      plan: entitlement[0]?.plan ?? 'free',
      freePlanLimit: entitlement[0] ? entitlement[0].product_limit : 30, productCountTowardLimit: inventory.total,
      expiringSoon, expired,
      alerts: [...expired, ...expiringSoon].map((i) => ({ type: 'expiry', severity: i.expiryLevel, productId: i.productId, title: i.name,
        subtitle: `Hết hạn ${i.expiryDate}`, expiryDate: i.expiryDate, cta: 'buy' })),
    };
  }

  async summary(userId: string, workspaceId: string) {
    // Đọc từ snapshot (1 truy vấn, có cache) thay vì ~10 truy vấn trong một transaction.
    return (await this.snapshots.get(userId, workspaceId)).home;
  }
}
