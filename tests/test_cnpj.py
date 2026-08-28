"""Cache do enriquecimento de CNPJ — em especial o cache NEGATIVO: um 404 da
base pública é fato estável e não pode ser reconsultado a cada rotina diária."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from src import cnpj  # noqa: E402
from tests.conftest import extrair_dia  # noqa: E402


class RespostaFalsa:
    def __init__(self, status, corpo=b"{}"):
        self.status_code = status
        self.content = corpo


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


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
