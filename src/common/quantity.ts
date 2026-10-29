/** PostgreSQL numeric(12,3): one common boundary for DTO and assistant arguments. */
export const QUANTITY_MAX = 999_999_999.999;
export function validQuantity(value: unknown, allowZero = false): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= (allowZero ? 0 : 0.001)
    && value <= QUANTITY_MAX && Math.round(value * 1000) / 1000 === value;
}

/** Never combine incompatible units or advertise a known subtotal as a full total. */
export function quantitySummary(lots: Array<{ quantity: unknown; unit: string | null; known?: boolean }>) {
  const groups = new Map<string | null, { unit: string | null; milli: number; unknownLots: number }>();
  for (const lot of lots) {
    if (!(Number(lot.quantity) > 0)) continue;
    const unit = lot.unit?.trim() || null;
    let group = groups.get(unit);
    if (!group) groups.set(unit, group = { unit, milli: 0, unknownLots: 0 });
    if (lot.known === false) group.unknownLots++;
    else group.milli += Math.round(Number(lot.quantity) * 1000);
  }
  const values = [...groups.values()].sort((a,b)=>(a.unit ?? '').localeCompare(b.unit ?? ''));
  const unknown = values.reduce((n,g)=>n+g.unknownLots,0);
  const known = values.some(g=>g.milli>0);
  const quantityState = !values.length ? 'empty' : values.length > 1 ? 'incompatible_units'
    : unknown ? (known ? 'mixed' : 'unknown') : 'known';
  return {
    quantity: !values.length ? 0 : quantityState === 'known' ? values[0].milli/1000 : null,
    unit: values.length === 1 ? values[0].unit : null,
    quantityState,
    quantityBreakdown: values.map(g=>({unit:g.unit,knownQuantity:g.milli/1000,unknownLots:g.unknownLots})),
  };
}
