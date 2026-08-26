"""Testes do versionamento de extrações com cenários sintéticos.

É a peça mais crítica do projeto: se o diff diário mentir, o site mente.
"""

import sys
from pathlib import Path

import duckdb
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from src import historico  # noqa: E402

COLUNAS = (
    "DT_GERACAO, HH_GERACAO, SQ_CANDIDATO, NM_CANDIDATO, NR_CANDIDATO, SG_PARTIDO, "
    "DS_CARGO, SG_UF, SQ_DESPESA, NM_FORNECEDOR, DS_DESPESA, VR_DESPESA_CONTRATADA"
)


def montar_banco():
    con = duckdb.connect()
    con.execute(f"""
        CREATE TABLE despesas_contratadas ({', '.join(c + ' VARCHAR' for c in COLUNAS.split(', '))});
        CREATE TABLE receitas (DT_GERACAO VARCHAR, HH_GERACAO VARCHAR, SQ_CANDIDATO VARCHAR,
            NM_CANDIDATO VARCHAR, NR_CANDIDATO VARCHAR, SG_PARTIDO VARCHAR, DS_CARGO VARCHAR,
            SG_UF VARCHAR, SQ_RECEITA VARCHAR, NM_DOADOR VARCHAR, VR_RECEITA VARCHAR);
    """)
    return con


def inserir_despesa(con, dia, sq, descricao, valor, repeticoes=1):
    for _ in range(repeticoes):
        con.execute(
            "INSERT INTO despesas_contratadas VALUES (?, '04:00:00', '160001', 'FULANO', "
            "'12345', 'XYZ', 'Deputado Estadual', 'XX', ?, 'FORNECEDOR LTDA', ?, ?)",
            [dia, sq, descricao, valor],
        )


def dia(con, data, despesas):
    """Simula a extração de um dia: recria a tabela bruta e versiona."""
    con.execute("DELETE FROM despesas_contratadas")
    for sq, descricao, valor, rep in despesas:
        inserir_despesa(con, data, sq, descricao, valor, rep)
    historico.versionar(con)


def contar(con, sql):
    return con.execute(sql).fetchone()[0]


def test_primeira_extracao_registra_tudo_sem_mudancas():
    con = montar_banco()
    dia(con, "20/08/2026", [("1", "BANDEIRA", "100,00", 1), ("2", "CARRO DE SOM", "5000,00", 1)])
    assert contar(con, "SELECT COUNT(*) FROM hist_despesas_contratadas") == 2
    assert contar(con, "SELECT COUNT(*) FROM v_removidas_despesas_contratadas") == 0
    assert contar(con, "SELECT COUNT(*) FROM v_alteradas_despesas_contratadas") == 0


def test_linha_removida_e_detectada():
    con = montar_banco()
    dia(con, "20/08/2026", [("1", "BANDEIRA", "100,00", 1), ("2", "CARRO DE SOM", "5000,00", 1)])
    dia(con, "21/08/2026", [("1", "BANDEIRA", "100,00", 1)])  # a despesa 2 sumiu
    removidas = con.execute(
        "SELECT DS_DESPESA, dt_primeira_extracao, dt_ultima_extracao "
        "FROM v_removidas_despesas_contratadas"
    ).fetchall()
    assert len(removidas) == 1
    assert removidas[0][0] == "CARRO DE SOM"
    assert str(removidas[0][1])[:10] == "2026-08-20"
    assert str(removidas[0][2])[:10] == "2026-08-20"  # visível só no dia 20


def test_valor_alterado_gera_versao_e_flag_de_alteracao():
    con = montar_banco()
    dia(con, "20/08/2026", [("1", "CARRO DE SOM", "50000,00", 1)])
    dia(con, "21/08/2026", [("1", "CARRO DE SOM", "5000,00", 1)])  # valor editado
    assert contar(con, "SELECT COUNT(*) FROM hist_despesas_contratadas") == 2  # duas versões
    alteradas = con.execute(
        "SELECT VR_DESPESA_CONTRATADA FROM v_alteradas_despesas_contratadas ORDER BY dt_primeira_extracao"
    ).fetchall()
    assert [a[0] for a in alteradas] == ["50000,00", "5000,00"]


def test_linhas_identicas_legitimas_sao_contadas_nao_perdidas():
    con = montar_banco()
    # 3 unidades idênticas do mesmo item (padrão real dos arquivos do TSE)
    dia(con, "20/08/2026", [("1", "ADESIVO", "10,00", 3)])
    linha = con.execute(
        "SELECT qt_linhas FROM hist_despesas_contratadas WHERE DS_DESPESA = 'ADESIVO'"
    ).fetchone()
    assert linha[0] == 3


def test_mudanca_de_quantidade_e_detectada():
    con = montar_banco()
    dia(con, "20/08/2026", [("1", "ADESIVO", "10,00", 3)])
    dia(con, "21/08/2026", [("1", "ADESIVO", "10,00", 2)])  # uma unidade sumiu
    # a versão com qt=3 morre no dia 20; nasce a versão com qt=2
    vivas = con.execute(
        "SELECT qt_linhas FROM hist_despesas_contratadas "
        "WHERE dt_ultima_extracao = DATE '2026-08-21'"
    ).fetchall()
    assert [v[0] for v in vivas] == [2]


def test_dias_sem_mudanca_sao_idempotentes():
    con = montar_banco()
    despesas = [("1", "BANDEIRA", "100,00", 1)]
    dia(con, "20/08/2026", despesas)
    dia(con, "21/08/2026", despesas)
    dia(con, "22/08/2026", despesas)
    assert contar(con, "SELECT COUNT(*) FROM hist_despesas_contratadas") == 1
    janela = con.execute(
        "SELECT dt_primeira_extracao, dt_ultima_extracao FROM hist_despesas_contratadas"
    ).fetchone()
    assert str(janela[0])[:10] == "2026-08-20"
    assert str(janela[1])[:10] == "2026-08-22"


def test_registro_de_extracoes_cobre_todos_os_dias():
    con = montar_banco()
    dia(con, "20/08/2026", [("1", "BANDEIRA", "100,00", 1)])
    dia(con, "21/08/2026", [("1", "BANDEIRA", "100,00", 1)])
    dias = [str(r[0])[:10] for r in con.execute(
        "SELECT dt_extracao FROM extracoes ORDER BY 1").fetchall()]
    assert dias == ["2026-08-20", "2026-08-21"]


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
