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
# nome para sobreviver a colunas novas do TSE sem lista manual por tabela
_PADRAO_COLUNA_CPF = re.compile(r"CPF|contraparte_id", re.IGNORECASE)

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


def selecao_publicavel(con, origem: str, sal_cpf: str) -> str:
    """Lista de colunas de `origem` pronta para publicação: CPFs pseudonimizados,
    colunas pessoais sem uso descartadas, todo o resto intacto."""
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
        partes.append(f"{sql_pseudonimo(ref, sal_cpf)} AS {ref}" if coluna_sensivel(c) else ref)
    return ", ".join(partes)
