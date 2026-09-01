"""Pseudonimização de CPFs nos dados publicados.

A prestação de contas do TSE traz o CPF completo de doadores e fornecedores
pessoa física (a anonimização `-4` vale para outros arquivos, não para este).
O site nunca exibe o número — e os Parquet públicos também não devem
redistribuí-lo em massa: são cidadãos comuns, não figuras públicas.

Todo valor de 11 dígitos nas colunas de CPF vira um código determinístico
`pf-` + 16 hex de sha256(sal || cpf). As junções, contagens e a rede seguem
funcionando (mesma pessoa = mesmo código, estável entre publicações), mas o
número não é recuperável sem o sal — que vive fora do repositório, na
variável de ambiente RADAR_SAL_CPF (como o GH_TOKEN). CNPJs (14 dígitos)
são dados públicos de empresas e ficam intactos. Nomes não são tocados.
"""

import os
import re

VARIAVEL = "RADAR_SAL_CPF"

# colunas que carregam CPF/CNPJ da contraparte ou CPF puro; identificadas pelo
# nome para sobreviver a colunas novas do TSE sem lista manual por tabela.
# NR_DOCUMENTO/NR_DOCUMENTO_DOACAO entram porque o TSE grava ali o PRÓPRIO CPF
# da contraparte em centenas de linhas (medido em 01/09/2026: 245 recibos de
# doação e 213 documentos de despesa idênticos ao CPF já mascarado na coluna ao
# lado) — e NM_* porque há linhas com o CPF digitado no campo de nome. Como o
# mascaramento só toca valores de EXATAMENTE 11 dígitos, nomes e números de
# nota legítimos passam intactos.
_PADRAO_COLUNA_CPF = re.compile(r"CPF|contraparte_id|^NR_DOCUMENTO|^NM_", re.IGNORECASE)

# colunas pessoais do consulta_cand que nada no projeto usa — não se publica
COLUNAS_DESCARTADAS = {"DS_EMAIL", "NR_TITULO_ELEITORAL_CANDIDATO"}


def sal() -> str:
    v = os.environ.get(VARIAVEL, "").strip()
    if not v:
        raise RuntimeError(
            f"defina {VARIAVEL} (sal secreto e ESTÁVEL da pseudonimização de CPF) para "
            "exportar. Sem estabilidade os códigos pf- mudariam a cada publicação e "
            "todos os links de fichas de pessoa física quebrariam."
        )
    return v


def coluna_sensivel(nome: str) -> bool:
    return bool(_PADRAO_COLUNA_CPF.search(nome))


def sql_pseudonimo(coluna: str, sal_cpf: str) -> str:
    """Expressão SQL (DuckDB) que troca um CPF de 11 dígitos pelo código pf-…;
    qualquer outro valor (CNPJ, '-1', '#NULO') passa intacto."""
    s = sal_cpf.replace("'", "''")
    return (
        f"CASE WHEN regexp_matches({coluna}, '^[0-9]{{11}}$') "
        f"THEN 'pf-' || substr(sha256('{s}' || {coluna}), 1, 16) "
        f"ELSE {coluna} END"
    )


def sql_hash_publicavel(coluna: str, sal_cpf: str) -> str:
    """`hash_linha` é md5 do conteúdo cru — CPF incluso. Publicado como está,
    permitiria a quem já conhece um CPF confirmá-lo (recalculando o md5 com os
    demais campos, que são públicos). Na publicação ele vira um código salgado
    `h-…`, estável e ainda utilizável como identidade de linha; só valores com
    cara de md5 cru são tocados (idempotente, como o pf-…)."""
    s = sal_cpf.replace("'", "''")
    return (
        f"CASE WHEN regexp_matches({coluna}, '^[0-9a-f]{{32}}$') "
        f"THEN 'h-' || substr(sha256('{s}' || {coluna}), 1, 16) "
        f"ELSE {coluna} END"
    )


def selecao_publicavel(con, origem: str, sal_cpf: str) -> str:
    """Lista de colunas de `origem` pronta para publicação: CPFs pseudonimizados,
    hash de linha salgado, colunas pessoais sem uso descartadas, o resto intacto."""
    colunas = [
        r[0] for r in con.execute(
            """
            SELECT column_name FROM information_schema.columns
            WHERE table_name = ? ORDER BY ordinal_position
            """,
            [origem],
        ).fetchall()
    ]
    partes = []
    for c in colunas:
        if c in COLUNAS_DESCARTADAS:
            continue
        ref = f'"{c}"'
        if c == "hash_linha":
            partes.append(f"{sql_hash_publicavel(ref, sal_cpf)} AS {ref}")
        elif coluna_sensivel(c):
            partes.append(f"{sql_pseudonimo(ref, sal_cpf)} AS {ref}")
        else:
            partes.append(ref)
    return ", ".join(partes)
