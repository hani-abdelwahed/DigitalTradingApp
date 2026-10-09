export function fmt(value: number | null | undefined, dp: number): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function compact(value: number | null | undefined): string {
  if (value == null) return '—';
  return Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(value);
}

export function clock(timeMs: number): string {
  return new Date(timeMs).toLocaleTimeString('en-GB', { hour12: false });
}
