import { Injectable } from '@nestjs/common';
import { DatabaseService, UserTx } from '../database/database.service';
import { dateOnly, dateRange, expiryLevel, todayVietnam } from '../common/date';
import { SnapshotService } from '../snapshot/snapshot.service';
import { filterInventory } from '../snapshot/snapshot.compute';
import { quantitySummary } from '../common/quantity';

export type InventoryItem = {
  productId: string; lotId?: string; name: string; category: string | null;
  quantity: number | null; unit: string | null; expiryDate: string | null;
  expiryLevel: string; status: 'in_stock' | 'out'; storageLocation: string | null;
};

@Injectable()
export class InventoryService {
  constructor(private readonly db: DatabaseService, private readonly snapshots: SnapshotService) {}

  async listIn(tx: UserTx, workspaceId: string, filters: { q?: string; category?: string; status?: string; expiryRange?: string; limit?: number } = {}): Promise<{ items: InventoryItem[]; total: number }> {
    const products = await tx.product.findMany({
      where: { workspaceId, archivedAt: null, ...(filters.category ? { category: filters.category } : {}), ...(filters.q ? { name: { contains: filters.q, mode: 'insensitive' } } : {}) },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    if (!products.length) return { items: [], total: 0 };
    const lots = await tx.inventoryLot.findMany({ where: { workspaceId, productId: { in: products.map((p) => p.id) } }, orderBy: [{ expiryDate: 'asc' }, { createdAt: 'asc' }] });
    const lotsByProduct=new Map<string,typeof lots>();
    for(const lot of lots){if(Number(lot.quantity)<=0)continue;const group=lotsByProduct.get(lot.productId);if(group)group.push(lot);else lotsByProduct.set(lot.productId,[lot]);}
    let items: InventoryItem[] = products.map((product) => {
      const positive = lotsByProduct.get(product.id)??[];
      const nearest = positive.find((lot) => lot.expiryDate) ?? positive[0];
      const quantities = quantitySummary(positive.map(lot=>({quantity:lot.quantity,unit:lot.unit,known:lot.quantityKnown})));
      return {
        productId: product.id, name: product.name, category: product.category,
        ...quantities, expiryDate: dateOnly(nearest?.expiryDate ?? null),
        expiryLevel: expiryLevel(nearest?.expiryDate ?? null),
        status: positive.length > 0 ? 'in_stock' : 'out',
        storageLocation: nearest?.storageLocation ?? positive.find((lot) => lot.storageLocation)?.storageLocation ?? null,
      };
    });
    if (filters.status) items = items.filter((i) => i.status === filters.status);
    if (filters.expiryRange) {
      const range = dateRange(filters.expiryRange);
      items = items.filter((i) => i.expiryDate && i.status === 'in_stock' && i.expiryDate >= range.from && i.expiryDate <= range.to);
    }
    return { total: items.length, items: items.slice(0, filters.limit ?? 50) };
  }

  async list(userId: string, workspaceId: string, filters: { q?: string; category?: string; status?: string; expiryRange?: string; limit?: number }) {
    const snapshot = await this.snapshots.get(userId, workspaceId);
    return filterInventory(snapshot.inventory, filters);
  }

  async detail(userId: string, workspaceId: string, productId: string) {
    return this.db.inWorkspace(userId, workspaceId, async (tx) => {
      const product = await tx.product.findFirst({ where: { id: productId, workspaceId, archivedAt: null } });
      if (!product) throw new Error('NOT_FOUND');
      const lots = await tx.inventoryLot.findMany({ where: { workspaceId, productId }, orderBy: [{ expiryDate: 'asc' }, { createdAt: 'asc' }] });
      const editable=await tx.$queryRaw<Array<{id:string;can_edit:boolean}>>`with access as materialized(select public.family_can_edit(${workspaceId}::uuid,null) as private_space,public.current_user_id() as actor)
        select id,(private_space or coalesce(created_by=actor,false)) as can_edit from public.inventory_lots cross join access where workspace_id=${workspaceId}::uuid and product_id=${productId}::uuid`;
      const canEdit=new Map(editable.map(row=>[row.id,row.can_edit]));
      const [productAccess]=await tx.$queryRaw<Array<{can_edit:boolean}>>`select public.family_can_edit(${workspaceId}::uuid,${product.createdBy}::uuid) as can_edit`;
      return { productId: product.id, name: product.name, category: product.category, status: lots.some(l=>Number(l.quantity)>0)?'in_stock':'out',createdBy:product.createdBy,canEdit:productAccess.can_edit,
        unit: product.defaultUnit, lots: lots.map((lot) => ({ lotId: lot.id, quantity: lot.quantityKnown ? Number(lot.quantity) : null, unit: lot.unit, expiryDate: dateOnly(lot.expiryDate), expiryLevel: expiryLevel(lot.expiryDate),
          priceVnd: lot.priceVnd === null ? null : Number(lot.priceVnd), storageLocation: lot.storageLocation, purchasedAt: lot.createdAt.toISOString(),createdBy:lot.createdBy,canEdit:canEdit.get(lot.id)??false })) };
    });
  }

  async expiringIn(tx: UserTx, workspaceId: string, range: string, includeExpired: boolean) {
    const bounds = dateRange(range);
    const from = includeExpired && range === 'next_7_days'
      ? dateRange('next_7_days', new Date(Date.parse(todayVietnam()) - 7 * 86400000).toISOString().slice(0, 10)).from
      : includeExpired && range === 'next_30_days'
        ? dateRange('next_30_days', new Date(Date.parse(todayVietnam()) - 30 * 86400000).toISOString().slice(0, 10)).from
        : bounds.from;
    const products = await tx.product.findMany({ where: { workspaceId, archivedAt: null } });
    const byId = new Map(products.map((p) => [p.id, p]));
    const lots = await tx.inventoryLot.findMany({ where: { workspaceId, quantity: { gt: 0 }, expiryDate: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${bounds.to}T00:00:00Z`) } }, orderBy: { expiryDate: 'asc' } });
    return { toolId: 'inventory.expiring', range, from: bounds.from, to: bounds.to,
      items: lots.filter((l) => byId.has(l.productId)).map((l) => ({
        productId: l.productId, lotId: l.id, name: byId.get(l.productId)!.name, category: byId.get(l.productId)!.category,
        quantity: l.quantityKnown ? Number(l.quantity) : null, unit: l.unit, expiryDate: dateOnly(l.expiryDate), expiryLevel: expiryLevel(l.expiryDate), status: 'in_stock',
      })) };
  }

  async candidatesIn(tx: UserTx, workspaceId: string, text: string) {
    return tx.product.findMany({ where: { workspaceId, archivedAt: null, name: { contains: text.slice(0, 60), mode: 'insensitive' } }, take: 10, select: { id: true, name: true, defaultUnit: true } });
  }
}
