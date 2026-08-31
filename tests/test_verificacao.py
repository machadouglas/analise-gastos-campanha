"""Testes da guarda de queda de volume (arquivo truncado do TSE).

Uma queda brusca no retrato inteiro geraria uma enxurrada de falsas
'remoções' — a rotina precisa recusar publicar nesse cenário.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from src import verificacao  # noqa: E402
from tests.conftest import extrair_dia  # noqa: E402


def _dia_com_n_despesas(banco, data, n):
    extrair_dia(banco, data, despesas=[
        {"SQ_DESPESA": str(i), "DS_DESPESA": f"ITEM {i}", "VR_DESPESA_CONTRATADA": "10,00"}
        for i in range(n)
    ])


def test_primeira_extracao_nao_tem_base_de_comparacao(banco):
    _dia_com_n_despesas(banco, "20/08/2026", 10)
    ok, detalhe = verificacao.queda_de_volume(banco, "despesas_contratadas")
    assert ok
    assert "primeira extração" in detalhe


def test_crescimento_e_queda_pequena_passam(banco):
    _dia_com_n_despesas(banco, "20/08/2026", 10)
    _dia_com_n_despesas(banco, "21/08/2026", 12)
    ok, _ = verificacao.queda_de_volume(banco, "despesas_contratadas")
    assert ok
    _dia_com_n_despesas(banco, "22/08/2026", 11)  # -8%: dentro da tolerância
    ok, _ = verificacao.queda_de_volume(banco, "despesas_contratadas")
    assert ok


def test_queda_brusca_e_recusada(banco):
    _dia_com_n_despesas(banco, "20/08/2026", 10)
    _dia_com_n_despesas(banco, "21/08/2026", 3)  # -70%: arquivo suspeito
    ok, detalhe = verificacao.queda_de_volume(banco, "despesas_contratadas")
    assert not ok
    assert "10 -> 3" in detalhe


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))


# --- guardas das views de mudança -------------------------------------------
# A régua de remoção é a afirmação mais forte do site ("apagaram a declaração").
# Estas checagens só valem se REPROVAREM quando alguém as afrouxa — por isso
# aqui a regressão é injetada de propósito, redefinindo a view.


def _cenario_com_edicao_e_remocao(banco):
    """Uma nota corrigida (só o valor) e outra que sumiu de vez."""
    extrair_dia(banco, "20/08/2026", despesas=[
        {"SQ_DESPESA": "1", "DS_DESPESA": "CARRO DE SOM", "VR_DESPESA_CONTRATADA": "50000,00"},
        {"SQ_DESPESA": "2", "DS_DESPESA": "PANFLETO", "VR_DESPESA_CONTRATADA": "800,00"},
    ])
    extrair_dia(banco, "21/08/2026", despesas=[
        {"SQ_DESPESA": "1", "DS_DESPESA": "CARRO DE SOM", "VR_DESPESA_CONTRATADA": "5000,00"},
    ])


# o banco sintético é pequeno demais para as guardas de volume; aqui só
# interessam as checagens das views de mudança
def _falhas_de_mudanca(banco):
    marcas = ("removida e alterada", "nenhuma remoção", "linhas mortas")
    return [f for f in verificacao.verificar(banco) if f.startswith(marcas)]


def test_verificacao_aprova_as_views_corretas(banco):
    _cenario_com_edicao_e_remocao(banco)
    assert _falhas_de_mudanca(banco) == []


def test_verificacao_reprova_remocao_que_engole_retificacao(banco):
    """Régua afrouxada: a view volta a chamar de remoção o que só foi corrigido
    (era o comportamento até 31/08/2026). A rotina tem de barrar a publicação."""
    _cenario_com_edicao_e_remocao(banco)
    banco.execute("""
        CREATE OR REPLACE VIEW v_removidas_despesas_contratadas AS
        SELECT h.* FROM hist_despesas_contratadas h
        WHERE h.dt_ultima_extracao < (SELECT MAX(dt_ultima_extracao)
                                      FROM hist_despesas_contratadas)
    """)
    falhas = _falhas_de_mudanca(banco)
    assert "nenhuma remoção tem versão viva equivalente (despesas_contratadas)" in falhas
    assert "removida e alterada nunca são a mesma linha (despesas_contratadas)" in falhas


def test_verificacao_reprova_linha_morta_sem_destino(banco):
    """Se uma linha morta não é retransmissão, nem retificação, nem placeholder,
    nem remoção, ela sumiu da contabilidade — a decomposição tem de acusar."""
    _cenario_com_edicao_e_remocao(banco)
    banco.execute("""
        CREATE OR REPLACE VIEW v_removidas_despesas_contratadas AS
        SELECT * FROM hist_despesas_contratadas WHERE FALSE
    """)
    falhas = _falhas_de_mudanca(banco)
    assert "linhas mortas se decompõem sem sobra (despesas_contratadas)" in falhas
