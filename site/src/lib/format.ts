import { md5 } from './md5';

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

/** Um id de contraparte é pessoa física? Nos dados publicados o CPF já vem
 *  pseudonimizado pelo backend como `pf-<16 hex>` (src/privacidade.py); o CPF
 *  cru de 11 dígitos só aparece em dados de publicações antigas. */
export function ePessoaFisica(id: string): boolean {
  return /^pf-[0-9a-f]{16}$/.test(id) || /^\d{11}$/.test(id);
}

/** Formata CNPJ (14 dígitos) completo; pessoa física sai sem o documento.
 *  O CPF é público nos arquivos do TSE, mas pessoa física não é figura pública:
 *  minimização (LGPD) — a publicação pseudonimiza e a exibição não revela. */
export function cnpjCpf(id: string): string {
  if (/^\d{14}$/.test(id)) return id.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (ePessoaFisica(id)) return 'CPF protegido';
  // '-1'/'#NULO' são códigos do TSE para "sem contraparte" — não são um documento
  if (id === '-1' || id === '#NULO') return '—';
  return id;
}

/** Ids de fornecedor com ficha própria: CNPJ ou pessoa física identificada
 *  (não '-1', '#NULO' ou anonimizado). */
export function temFichaFornecedor(id: unknown): id is string {
  return typeof id === 'string' && (ePessoaFisica(id) || /^\d{14}$/.test(id));
}

/** URL da ficha do fornecedor. Pessoa física usa o identificador opaco `pf-…`
 *  publicado pelo backend; para dados antigos (CPF cru), o hash local mantém o
 *  CPF fora do endereço, do histórico e dos logs. */
export function urlFornecedor(id: string): string {
  if (/^\d{11}$/.test(id)) return `/fornecedor/pf-${md5(id).slice(0, 16)}`;
  return `/fornecedor/${id}`;
}

/** Converte uma célula vinda do DuckDB (Arrow) para texto exibível. */
export function celula(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
