"""Cache do enriquecimento de CNPJ — em especial o cache NEGATIVO: um 404 da
base pública é fato estável e não pode ser reconsultado a cada rotina diária —
e a reconsulta contínua: os cadastros mais antigos são reconsultados primeiro,
num ciclo que percorre a base, preservando a situação anterior quando muda."""

import json
import sys
from datetime import date
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from src import cnpj  # noqa: E402
from tests.conftest import extrair_dia  # noqa: E402


class RespostaFalsa:
    def __init__(self, status, corpo=b"{}"):
        self.status_code = status
        self.content = corpo


def resposta_ok(situacao="ATIVA", razao="FORNECEDOR LTDA"):
    corpo = json.dumps({
        "razao_social": razao,
        "descricao_situacao_cadastral": situacao,
        "data_inicio_atividade": "2020-01-01",
    }).encode("utf-8")
    return RespostaFalsa(200, corpo)


@pytest.fixture
def cache_isolado(tmp_path, monkeypatch):
    monkeypatch.setattr(cnpj, "DIR_CACHE", tmp_path)
    monkeypatch.setattr(cnpj, "INTERVALO_SEGUNDOS", 0)
    return tmp_path


def test_404_e_cacheado_e_nao_reconsulta(cache_isolado, monkeypatch):
    chamadas = []
    monkeypatch.setattr(cnpj.requests, "get",
                        lambda *a, **k: chamadas.append(1) or RespostaFalsa(404))
    assert cnpj.consultar("11222333000144") is None
    assert cnpj.nao_encontrado("11222333000144")
    # segunda consulta: resolvida pelo cache, sem tocar a rede
    monkeypatch.setattr(cnpj.requests, "get",
                        lambda *a, **k: pytest.fail("não deveria consultar a rede de novo"))
    assert cnpj.consultar("11222333000144") is None
    assert len(chamadas) == 1


def test_erro_transitorio_nao_vira_cache(cache_isolado, monkeypatch):
    monkeypatch.setattr(cnpj.requests, "get", lambda *a, **k: RespostaFalsa(429))
    assert cnpj.consultar("11222333000144") is None
    assert not cnpj.nao_encontrado("11222333000144")  # amanhã tenta de novo


def test_sucesso_e_cacheado(cache_isolado, monkeypatch):
    corpo = b'{"cnpj": "11222333000144", "razao_social": "FORNECEDOR LTDA"}'
    monkeypatch.setattr(cnpj.requests, "get", lambda *a, **k: RespostaFalsa(200, corpo))
    assert cnpj.consultar("11222333000144")["razao_social"] == "FORNECEDOR LTDA"
    monkeypatch.setattr(cnpj.requests, "get",
                        lambda *a, **k: pytest.fail("não deveria consultar a rede de novo"))
    assert cnpj.consultar("11222333000144")["razao_social"] == "FORNECEDOR LTDA"


def test_enriquecer_tira_o_404_da_fila(banco, cache_isolado, monkeypatch):
    """CNPJ 404 vira registro-tombstone em `fornecedores`: some da fila de
    pendentes e conta como verificado — sem ocupar vaga todo dia."""
    extrair_dia(banco, "20/08/2026", despesas=[{"SQ_DESPESA": "1"}])
    monkeypatch.setattr(cnpj.requests, "get", lambda *a, **k: RespostaFalsa(404))
    assert cnpj.enriquecer_em_massa(banco, limite=10) == 1
    situacao = banco.execute(
        "SELECT situacao FROM fornecedores WHERE cnpj = '11222333000144'"
    ).fetchone()[0]
    assert situacao == "NAO ENCONTRADO NA BASE PUBLICA"
    # rotina seguinte: fila vazia, zero consultas
    monkeypatch.setattr(cnpj.requests, "get",
                        lambda *a, **k: pytest.fail("não deveria consultar a rede de novo"))
    assert cnpj.enriquecer_em_massa(banco, limite=10) == 0


def _fornecedor(con, numero, situacao="ATIVA", dt_consulta=None):
    cnpj._garantir_tabela(con)
    con.execute(
        "INSERT INTO fornecedores (cnpj, situacao, dt_consulta) VALUES (?, ?, ?)",
        [numero, situacao, dt_consulta],
    )


def test_refresh_reconsulta_os_mais_antigos_primeiro(banco, cache_isolado, monkeypatch):
    extrair_dia(banco, "20/08/2026", despesas=[
        {"SQ_DESPESA": "1", "NR_CPF_CNPJ_FORNECEDOR": "11111111000111"},
        {"SQ_DESPESA": "2", "NR_CPF_CNPJ_FORNECEDOR": "22222222000122"},
    ])
    _fornecedor(banco, "11111111000111", dt_consulta=date(2026, 6, 1))
    _fornecedor(banco, "22222222000122", dt_consulta=date(2026, 7, 1))
    chamadas = []
    monkeypatch.setattr(cnpj.requests, "get",
                        lambda url, **k: chamadas.append(url) or resposta_ok())
    # sem pendentes e limite 1: reconsulta só o cadastro mais antigo
    assert cnpj.enriquecer_em_massa(banco, limite=1, hoje=date(2026, 8, 28)) == 1
    assert len(chamadas) == 1 and "11111111000111" in chamadas[0]
    dt = banco.execute(
        "SELECT dt_consulta FROM fornecedores WHERE cnpj = '11111111000111'"
    ).fetchone()[0]
    assert str(dt) == "2026-08-28"


def test_refresh_nao_reconsulta_cadastro_recente(banco, cache_isolado, monkeypatch):
    extrair_dia(banco, "20/08/2026", despesas=[{"SQ_DESPESA": "1"}])
    _fornecedor(banco, "11222333000144", dt_consulta=date(2026, 8, 20))  # 8 dias atrás
    monkeypatch.setattr(cnpj.requests, "get",
                        lambda *a, **k: pytest.fail("cadastro recente não deveria ir à rede"))
    assert cnpj.enriquecer_em_massa(banco, limite=10, hoje=date(2026, 8, 28)) == 0


def test_pendentes_tem_prioridade_sobre_refresh(banco, cache_isolado, monkeypatch):
    extrair_dia(banco, "20/08/2026", despesas=[
        {"SQ_DESPESA": "1", "NR_CPF_CNPJ_FORNECEDOR": "11111111000111"},
        {"SQ_DESPESA": "2", "NR_CPF_CNPJ_FORNECEDOR": "22222222000122"},
    ])
    _fornecedor(banco, "11111111000111", dt_consulta=date(2026, 1, 1))  # vencidíssimo
    chamadas = []
    monkeypatch.setattr(cnpj.requests, "get",
                        lambda url, **k: chamadas.append(url) or resposta_ok())
    # limite 1: a vaga vai para o pendente novo, não para a reconsulta
    assert cnpj.enriquecer_em_massa(banco, limite=1, hoje=date(2026, 8, 28)) == 1
    assert len(chamadas) == 1 and "22222222000122" in chamadas[0]


def test_mudanca_de_situacao_preserva_a_anterior(banco, cache_isolado, monkeypatch):
    extrair_dia(banco, "20/08/2026", despesas=[{"SQ_DESPESA": "1"}])
    _fornecedor(banco, "11222333000144", situacao="ATIVA", dt_consulta=date(2026, 6, 1))
    monkeypatch.setattr(cnpj.requests, "get", lambda *a, **k: resposta_ok(situacao="BAIXADA"))
    assert cnpj.enriquecer_em_massa(banco, limite=10, hoje=date(2026, 8, 28)) == 1
    situacao, anterior, dt_mudanca = banco.execute(
        "SELECT situacao, situacao_anterior, dt_situacao_anterior FROM fornecedores "
        "WHERE cnpj = '11222333000144'").fetchone()
    assert (situacao, anterior, str(dt_mudanca)) == ("BAIXADA", "ATIVA", "2026-08-28")
    # ciclo seguinte sem mudança: o registro da mudança antiga não é apagado
    assert cnpj.enriquecer_em_massa(banco, limite=10, hoje=date(2026, 10, 15)) == 1
    situacao, anterior, dt_mudanca = banco.execute(
        "SELECT situacao, situacao_anterior, dt_situacao_anterior FROM fornecedores "
        "WHERE cnpj = '11222333000144'").fetchone()
    assert (situacao, anterior, str(dt_mudanca)) == ("BAIXADA", "ATIVA", "2026-08-28")


def test_refresh_ignora_o_cache_de_arquivo(banco, cache_isolado, monkeypatch):
    """A reconsulta vai à rede mesmo com cache local — senão nunca detectaria
    mudança nenhuma (o cache de arquivo não expira sozinho)."""
    extrair_dia(banco, "20/08/2026", despesas=[{"SQ_DESPESA": "1"}])
    monkeypatch.setattr(cnpj.requests, "get", lambda *a, **k: resposta_ok(situacao="ATIVA"))
    assert cnpj.consultar("11222333000144")["descricao_situacao_cadastral"] == "ATIVA"
    _fornecedor(banco, "11222333000144", situacao="ATIVA", dt_consulta=date(2026, 6, 1))
    monkeypatch.setattr(cnpj.requests, "get", lambda *a, **k: resposta_ok(situacao="INAPTA"))
    cnpj.enriquecer_em_massa(banco, limite=10, hoje=date(2026, 8, 28))
    situacao = banco.execute(
        "SELECT situacao FROM fornecedores WHERE cnpj = '11222333000144'").fetchone()[0]
    assert situacao == "INAPTA"


def test_refresh_de_404_vira_tombstone_com_situacao_anterior(banco, cache_isolado, monkeypatch):
    """Empresa que existia e sumiu da base pública: o tombstone entra no lugar,
    mas a situação anterior fica registrada."""
    extrair_dia(banco, "20/08/2026", despesas=[{"SQ_DESPESA": "1"}])
    _fornecedor(banco, "11222333000144", situacao="ATIVA", dt_consulta=date(2026, 6, 1))
    monkeypatch.setattr(cnpj.requests, "get", lambda *a, **k: RespostaFalsa(404))
    assert cnpj.enriquecer_em_massa(banco, limite=10, hoje=date(2026, 8, 28)) == 1
    situacao, anterior = banco.execute(
        "SELECT situacao, situacao_anterior FROM fornecedores WHERE cnpj = '11222333000144'"
    ).fetchone()
    assert (situacao, anterior) == (cnpj.SITUACAO_NAO_ENCONTRADO, "ATIVA")


def test_refresh_com_erro_transitorio_nao_toca_o_registro(banco, cache_isolado, monkeypatch):
    extrair_dia(banco, "20/08/2026", despesas=[{"SQ_DESPESA": "1"}])
    _fornecedor(banco, "11222333000144", situacao="ATIVA", dt_consulta=date(2026, 6, 1))
    monkeypatch.setattr(cnpj.requests, "get", lambda *a, **k: RespostaFalsa(429))
    assert cnpj.enriquecer_em_massa(banco, limite=10, hoje=date(2026, 8, 28)) == 0
    situacao, dt = banco.execute(
        "SELECT situacao, dt_consulta FROM fornecedores WHERE cnpj = '11222333000144'"
    ).fetchone()
    assert (situacao, str(dt)) == ("ATIVA", "2026-06-01")  # continua na fila de amanhã


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
