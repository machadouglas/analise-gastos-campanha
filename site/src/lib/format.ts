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

/** Formata CNPJ (14 dígitos) ou CPF (11 dígitos); qualquer outro valor volta como está. */
export function cnpjCpf(id: string): string {
  if (/^\d{14}$/.test(id)) return id.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (/^\d{11}$/.test(id)) return id.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return id;
}

/** Ids de fornecedor com ficha própria: CNPJ/CPF real (não '-1', '#NULO' ou anonimizado). */
export function temFichaFornecedor(id: unknown): id is string {
  return typeof id === 'string' && (/^\d{11}$/.test(id) || /^\d{14}$/.test(id));
}

/** Converte uma célula vinda do DuckDB (Arrow) para texto exibível. */
export function celula(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
