export function todayVietnam(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function dateOnly(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

export function expiryLevel(value: Date | null, today = todayVietnam()): 'ok' | 'attention' | 'soon' | 'urgent' | 'expired' {
  if (!value) return 'ok';
  const days = Math.round((Date.parse(dateOnly(value)!) - Date.parse(today)) / 86400000);
  if (days < 0) return 'expired';
  if (days <= 2) return 'urgent';
  if (days <= 7) return 'soon';
  if (days <= 30) return 'attention';
  return 'ok';
}

export function dateRange(range: string, today = todayVietnam()): { from: string; to: string } {
  const date = new Date(`${today}T00:00:00Z`);
  const add = (n: number) => new Date(date.getTime() + n * 86400000).toISOString().slice(0, 10);
  if (range === 'expired') return { from: '0001-01-01', to: add(-1) };
  if (range === 'next_7_days') return { from: today, to: add(7) };
  if (range === 'next_30_days') return { from: today, to: add(30) };
  if (range === 'this_week') {
    const offset = (date.getUTCDay() + 6) % 7;
    return { from: add(-offset), to: add(6 - offset) };
  }
  if (range === 'this_month') {
    return { from: `${today.slice(0, 7)}-01`, to: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).toISOString().slice(0, 10) };
  }
  throw new Error('VALIDATION_ERROR');
}
