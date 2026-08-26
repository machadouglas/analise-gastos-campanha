export const brl = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  maximumFractionDigits: 0,
});

export const num = new Intl.NumberFormat('pt-BR');

export function dataBR(iso: string | null | undefined): string {
  if (!iso) return '';
  return iso.split('-').reverse().join('/');
}

/** Converte uma célula vinda do DuckDB (Arrow) para texto exibível. */
export function celula(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
