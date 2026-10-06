/* Foto oficial do candidato no DivulgaCandContas (hotlink — nada é copiado nem
   armazenado por nós).

   O endereço NÃO usa o CD_ELEICAO dos dados abertos: o DivulgaCand identifica a
   eleição por um código próprio (o `id` de /divulga/rest/v1/eleicao/ordinarias),
   e em 2026 as duas eleições do registro (6257 federal, 6259 estadual) estão sob
   o mesmo id. Com o código dos dados abertos o serviço não responde 404 — devolve
   200 com uma silhueta genérica (4.704 bytes, igual para todos), e foi só isso que
   o site mostrou até 06/10/2026. Código fora desta tabela não vira URL: caem as
   iniciais, nunca a silhueta. */
export const ELEICAO_DIVULGACAND: Readonly<Record<string, string>> = {
  '6257': '20322002026',
  '6259': '20322002026',
};

export function urlFotoCandidato(
  cdEleicao: string | null | undefined,
  sq: string | null | undefined,
  sgUe: string | null | undefined,
): string | null {
  const id = cdEleicao ? ELEICAO_DIVULGACAND[cdEleicao] : undefined;
  if (!id || !sq || !sgUe) return null;
  return `https://divulgacandcontas.tse.jus.br/divulga/rest/arquivo/img/${id}/${sq}/${sgUe}`;
}
