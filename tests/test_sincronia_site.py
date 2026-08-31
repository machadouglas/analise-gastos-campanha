"""Sincronia backend ↔ front: as regras que o site espelha do Python.

O site reimplementa em SQL (DuckDB-WASM) três regras definidas aqui no backend.
Cada uma vivia como comentário "manter em sincronia" — estes testes leem os
arquivos do front e falham quando as cópias divergem.
"""

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from src import analises, historico, resumo  # noqa: E402

RAIZ = Path(__file__).parent.parent
CONSULTAS_TS = (RAIZ / "site" / "src" / "lib" / "consultas.ts").read_text(encoding="utf-8")
DUCKDB_TS = (RAIZ / "site" / "src" / "lib" / "duckdb.ts").read_text(encoding="utf-8")


def test_categorias_sem_nota_iguais_no_front():
    """CATEGORIAS_SEM_NOTA_ESPERADA em consultas.ts == src/analises.py."""
    bloco = re.search(
        r"CATEGORIAS_SEM_NOTA_ESPERADA = \[(.*?)\]", CONSULTAS_TS, re.DOTALL
    )
    assert bloco, "lista CATEGORIAS_SEM_NOTA_ESPERADA não encontrada em consultas.ts"
    do_front = re.findall(r"'([^']+)'", bloco.group(1))
    assert do_front == list(analises.CATEGORIAS_SEM_NOTA_ESPERADA)


def test_condicao_sem_nota_igual_no_front():
    """A régua do 'sem documento fiscal' é a mesma nos dois lados: documento não
    fiscal (nota OU cupom), fornecedor PJ e categoria em que a nota é a norma."""
    for doc in analises.DOCUMENTOS_FISCAIS:
        assert f"NOT ILIKE '%{doc}%'" in CONSULTAS_TS, f"documento fiscal '{doc}' ausente do site"
    # fornecedor PJ e o corte pela norma medida
    assert "LENGTH(NR_CPF_CNPJ_FORNECEDOR) = 14" in CONSULTAS_TS
    assert "FROM norma_documento WHERE exige_documento" in CONSULTAS_TS
    # e o fallback sem o parquet novo continua sendo a lista fixa
    assert "SQL_CATEGORIAS_SEM_NOTA" in CONSULTAS_TS


def test_norma_documento_e_a_tabela_que_o_site_espera():
    """O site registra `norma_documento` no boot e lê a coluna exige_documento;
    o backend precisa publicar exatamente esse nome de tabela e de coluna."""
    agregados_py = (RAIZ / "src" / "agregados.py").read_text(encoding="utf-8")
    exportar_py = (RAIZ / "src" / "exportar.py").read_text(encoding="utf-8")
    assert "CREATE OR REPLACE TABLE norma_documento" in agregados_py
    assert "AS exige_documento" in agregados_py
    assert "norma_documento.parquet" in exportar_py
    assert "'norma_documento'" in DUCKDB_TS


def test_sinais_do_fora_da_curva_iguais_no_front():
    """SINAIS_CTE/SINAIS_FILTRO em consultas.ts espelham METRICAS_SINAL:
    mesmas métricas E mesmos filtros de elegibilidade (ex.: razão só > 1)."""
    bloco = re.search(r"SINAIS_FILTRO = \[(.*?)\]", CONSULTAS_TS, re.DOTALL)
    assert bloco, "lista SINAIS_FILTRO não encontrada em consultas.ts"
    filtro_front = re.findall(r"'([^']+)'", bloco.group(1))
    nomes_backend = [nome for nome, _, _ in resumo.METRICAS_SINAL]
    assert filtro_front == nomes_backend

    # a saturação das métricas percentuais tem de valer nos dois lados: sem isso
    # o sinal de % nunca dispara (p95 no teto) num deles e dispara no outro
    assert "LIKE 'pct_%'" in CONSULTAS_TS
    assert "LIKE 'pct_%'" in resumo.CONDICAO_SINAL
    assert str(int(resumo.TETO_PERCENTUAL)) in CONSULTAS_TS

    cte = re.search(r"SINAIS_CTE = `(.*?)`", CONSULTAS_TS, re.DOTALL)
    assert cte, "SINAIS_CTE não encontrada em consultas.ts"
    for nome, _, filtro in resumo.METRICAS_SINAL:
        assert f"'{nome}'" in cte.group(1) or f", {nome}" in cte.group(1), (
            f"métrica {nome} ausente do SINAIS_CTE do site"
        )
        assert filtro in cte.group(1), (
            f"filtro de elegibilidade '{filtro}' da métrica {nome} ausente do SINAIS_CTE do site"
        )


def test_essencia_das_removidas_igual_no_front():
    """As views despesas_removidas/receitas_removidas do site usam o MESMO
    conjunto de colunas de essência do versionamento (src/historico.py) para
    descartar retransmissões renumeradas."""
    for tabela, alias in (("despesas_contratadas", "d"), ("receitas", "r")):
        for coluna in historico.ESSENCIA[tabela]:
            esperado = f"v.{coluna} = {alias}.{coluna}"
            assert esperado in DUCKDB_TS, (
                f"coluna de essência {coluna} ({tabela}) fora da view de removidas do site: "
                f"esperava '{esperado}' em site/src/lib/duckdb.ts"
            )


def test_paginas_nao_burlam_a_view_de_removidas():
    """Nenhuma página consulta remoção 'na unha' (dt_ultima_extracao < MAX sem a
    view) — foi exatamente o desvio metodológico da ficha do fornecedor."""
    paginas = (RAIZ / "site" / "src" / "pages").glob("*.tsx")
    for pagina in paginas:
        fonte = pagina.read_text(encoding="utf-8")
        assert "dt_ultima_extracao < (SELECT MAX" not in fonte, (
            f"{pagina.name} calcula remoções direto do histórico; use as views "
            "despesas_removidas/receitas_removidas (mesma régua do backend)"
        )


if __name__ == "__main__":
    import pytest

    sys.exit(pytest.main([__file__, "-v"]))


def test_situacao_nao_encontrada_igual_no_front():
    """SITUACAO_NAO_ENCONTRADA em consultas.ts == SITUACAO_NAO_ENCONTRADO em
    src/cnpj.py. É a lápide gravada quando a base pública responde 404: o site
    troca o bloco de cadastro por um aviso quando a encontra, e um texto
    divergente faria o aviso nunca aparecer (voltando a exibir a string crua)."""
    from src import cnpj

    achado = re.search(
        r"SITUACAO_NAO_ENCONTRADA = '([^']+)'", CONSULTAS_TS
    )
    assert achado, "SITUACAO_NAO_ENCONTRADA não encontrada em consultas.ts"
    assert achado.group(1) == cnpj.SITUACAO_NAO_ENCONTRADO
