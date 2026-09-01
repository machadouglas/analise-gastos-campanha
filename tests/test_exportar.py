"""Parquet do estado atual (despesas_atual/receitas_atual): o site consulta a
extração mais recente sem baixar o histórico inteiro. Estes testes garantem que
o arquivo leva só o conteúdo vivo, sem placeholders e com a coluna `valor`."""

import sys
from pathlib import Path

import duckdb
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from src import exportar  # noqa: E402
from tests.conftest import extrair_dia  # noqa: E402


def _exportados(banco, tmp_path, monkeypatch):
    monkeypatch.setattr(exportar, "DIR_EXPORT", tmp_path)
    exportar.exportar(banco)
    return tmp_path


def test_parquet_estado_atual_leva_so_o_vivo_e_sem_placeholder(banco, tmp_path, monkeypatch):
    extrair_dia(banco, "20/08/2026",
                despesas=[
                    {"SQ_DESPESA": "1", "VR_DESPESA_CONTRATADA": "100,00"},
                    {"SQ_DESPESA": "2", "DS_DESPESA": "REMOVIDA DEPOIS",
                     "VR_DESPESA_CONTRATADA": "50,00"},
                ],
                receitas=[{"SQ_RECEITA": "1", "VR_RECEITA": "1000,00"}])
    extrair_dia(banco, "21/08/2026",
                despesas=[
                    {"SQ_DESPESA": "1", "VR_DESPESA_CONTRATADA": "100,00"},
                    # linha-placeholder do SPCE: sem contraparte E sem valor — não é fato
                    {"SQ_DESPESA": "-1", "NR_CPF_CNPJ_FORNECEDOR": "-1",
                     "NM_FORNECEDOR": "#NULO", "VR_DESPESA_CONTRATADA": "0,00"},
                ],
                receitas=[{"SQ_RECEITA": "1", "VR_RECEITA": "1000,00"}])
    saida = _exportados(banco, tmp_path, monkeypatch)

    despesas = duckdb.query(
        f"SELECT DS_DESPESA, valor FROM '{(saida / 'despesas_atual.parquet').as_posix()}' ORDER BY 1"
    ).fetchall()
    # só o conteúdo vivo na última extração: sem a removida, sem o placeholder
    assert despesas == [("BANDEIRA", pytest.approx(100.0))]

    receitas = duckdb.query(
        f"SELECT valor FROM '{(saida / 'receitas_atual.parquet').as_posix()}'"
    ).fetchall()
    assert receitas == [(pytest.approx(1000.0),)]


def test_valor_do_estado_atual_multiplica_qt_linhas(banco, tmp_path, monkeypatch):
    # 3 itens idênticos de R$ 10 = uma linha de conteúdo com valor total R$ 30,
    # mesma régua da view do site
    extrair_dia(banco, "20/08/2026", despesas=[
        {"SQ_DESPESA": "1", "DS_DESPESA": "ADESIVO", "VR_DESPESA_CONTRATADA": "10,00"}
        for _ in range(3)
    ])
    saida = _exportados(banco, tmp_path, monkeypatch)
    linhas = duckdb.query(
        f"SELECT qt_linhas, valor FROM '{(saida / 'despesas_atual.parquet').as_posix()}'"
    ).fetchall()
    assert linhas == [(3, pytest.approx(30.0))]


def test_stamp_codigo_muda_quando_o_pipeline_muda(tmp_path):
    """O gate da rotina só exporta quando o fingerprint muda — e o fingerprint
    precisa enxergar o CÓDIGO, não só o dado do TSE. Sem isso, um deploy num dia
    de 304 nunca chega ao release (aconteceu com despesas_alteradas.parquet em
    31/08/2026)."""
    (tmp_path / "a.py").write_text("x = 1", encoding="utf-8")
    antes = exportar.stamp_codigo(tmp_path)
    assert antes == exportar.stamp_codigo(tmp_path)  # determinístico
    (tmp_path / "a.py").write_text("x = 2", encoding="utf-8")
    assert exportar.stamp_codigo(tmp_path) != antes  # deploy muda o carimbo


def test_fingerprint_inclui_o_carimbo_do_codigo(banco, monkeypatch):
    """Mesmo banco, código 'novo' → fingerprint novo (a rotina exporta)."""
    extrair_dia(banco, "20/08/2026",
                despesas=[{"SQ_DESPESA": "1", "VR_DESPESA_CONTRATADA": "100,00"}])
    fp = exportar.fingerprint(banco)
    monkeypatch.setattr(exportar, "stamp_codigo", lambda raiz=None: "deploy-novo")
    assert exportar.fingerprint(banco) != fp


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))


# --- retificações publicadas (despesas_alteradas/receitas_alteradas) ---------
# O antes/depois é pareado no backend de propósito: parear no front seria a
# terceira cópia da régua que decide o que NÃO é remoção.


def test_parquet_de_alteradas_traz_o_antes_e_o_depois(banco, tmp_path, monkeypatch):
    extrair_dia(banco, "20/08/2026", despesas=[
        {"SQ_DESPESA": "1", "DS_DESPESA": "CARRO DE SOM",
         "VR_DESPESA_CONTRATADA": "50000,00"}])
    extrair_dia(banco, "21/08/2026", despesas=[
        {"SQ_DESPESA": "999", "DS_DESPESA": "CARRO DE SOM",  # SQ novo + valor corrigido
         "VR_DESPESA_CONTRATADA": "5000,00"}])
    saida = _exportados(banco, tmp_path, monkeypatch)

    linhas = duckdb.query(
        "SELECT campo_alterado, valor_antes, valor_depois, sucessores "
        f"FROM '{(saida / 'despesas_alteradas.parquet').as_posix()}'"
    ).fetchall()
    assert linhas == [("valor", pytest.approx(50000.0), pytest.approx(5000.0), 1)]

    # e a mesma declaração NÃO pode estar na conta de removidas
    removidas = duckdb.query(
        f"SELECT COUNT(*) FROM '{(saida / 'despesas_removidas.parquet').as_posix()}'"
    ).fetchone()
    assert removidas == (0,)


def test_alteradas_tem_uma_linha_por_declaracao_e_conta_a_ambiguidade(banco, tmp_path, monkeypatch):
    """Com N versões mortas e M vivas casando entre si, o JOIN devolvia N×M
    combinações — uma nota corrigida virava 12 linhas na tela. A linha é uma por
    declaração morta, e quando há mais de uma sucessora possível o parquet diz
    quantas, em vez de eleger uma e apresentá-la como a resposta."""
    extrair_dia(banco, "20/08/2026", despesas=[
        {"SQ_DESPESA": "1", "DS_DESPESA": "PANFLETO", "VR_DESPESA_CONTRATADA": "100,00"}])
    # duas declarações vivas diferem da morta em um só campo (o valor): as duas
    # servem de sucessora e não há como saber qual substituiu qual
    extrair_dia(banco, "21/08/2026", despesas=[
        {"SQ_DESPESA": "2", "DS_DESPESA": "PANFLETO", "VR_DESPESA_CONTRATADA": "300,00"},
        {"SQ_DESPESA": "3", "DS_DESPESA": "PANFLETO", "VR_DESPESA_CONTRATADA": "900,00"}])
    saida = _exportados(banco, tmp_path, monkeypatch)

    linhas = duckdb.query(
        "SELECT valor_antes, valor_depois, sucessores "
        f"FROM '{(saida / 'despesas_alteradas.parquet').as_posix()}'"
    ).fetchall()
    assert len(linhas) == 1, "uma linha por declaração morta, não por combinação"
    # o representante é o de valor mais próximo — determinístico entre publicações
    assert linhas == [(pytest.approx(100.0), pytest.approx(300.0), 2)]
