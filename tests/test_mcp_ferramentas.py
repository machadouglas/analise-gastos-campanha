"""As ferramentas do MCP contra os Parquet PUBLICADOS por um pipeline real.

O fixture reaproveita o cenário do E2E (zip no formato do TSE → carregar →
versionar → agregados → exportar) e monta o banco do MCP a partir do diretório
exportado — exatamente o que o container faz com o release. Duas garantias:

1. cada ferramenta responde sobre o dado mascarado (pf-…/h-…), com as chaves
   que o modelo vai ler;
2. a ferramenta `sql` devolve o MESMO resultado que a execução direta para
   cada consulta pronta do console do site — gate, teto e formatação não
   alteram o dado.
"""

import asyncio
import json
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from src import agregados, carga, exportar, historico, privacidade  # noqa: E402
from src.mcp import dados, servidor  # noqa: E402
from tests.test_consultas_do_site import _consultas  # noqa: E402
from tests.test_e2e_pipeline import _publicar_zip_do_dia  # noqa: E402

ANO = 2026
CNPJ_FORNECEDOR = "11222333000144"


@pytest.fixture(scope="module")
def banco(tmp_path_factory):
    """Pipeline real em tmp → export → banco do MCP (uma vez por módulo)."""
    from src import cnpj

    tmp = tmp_path_factory.mktemp("mcp-e2e")
    mp = pytest.MonkeyPatch()
    mp.setattr(carga, "DIR_RAW", tmp / "raw")
    mp.setattr(carga, "CAMINHO_BANCO", tmp / "db" / "gastos.duckdb")
    mp.setattr(exportar, "DIR_EXPORT", tmp / "export")
    mp.setenv(privacidade.VARIAVEL, "sal-de-teste")
    try:
        _publicar_zip_do_dia(carga.DIR_RAW, "20/08/2026",
                             com_removida=True, valor_editada="100,00", sq_editada="505")
        carga.carregar(ANO)
        con = carga.conectar()
        historico.versionar(con)
        con.close()
        _publicar_zip_do_dia(carga.DIR_RAW, "21/08/2026",
                             com_removida=False, valor_editada="150,00", sq_editada="905")
        carga.carregar(ANO)
        con = carga.conectar()
        historico.versionar(con)
        cnpj._garantir_tabela(con)
        con.execute("""
            INSERT INTO fornecedores VALUES
            (?, 'FORNECEDOR LTDA OFICIAL', '2025-11-15', 'ATIVA', 'ME',
             false, 'Agências de publicidade', 'SÃO PAULO', 'XX', 10000.0,
             'SÓCIO UM', DATE '2026-08-21', NULL, NULL)
        """, [CNPJ_FORNECEDOR])
        agregados.materializar(con)
        exportar.exportar(con)
        con.close()
        b = dados.construir_de_diretorio(tmp / "export", tmp / "radar.duckdb")
        servidor.usar_banco(b)
        yield b
        b.fechar()
    finally:
        mp.undo()


def _rodar(coro):
    return asyncio.run(coro)


def _sem_cpf_cru(obj) -> None:
    texto = json.dumps(obj, ensure_ascii=False, default=str)
    assert not re.search(r'"\d{11}"', texto), "valor de 11 dígitos (CPF cru?) na resposta"


def test_toda_resposta_traz_versao(banco):
    r = _rodar(servidor.visao_geral())
    assert r["versao_dado"] == banco.versao_dado == "2026-08-21"
    assert r["versao_codigo"]
    assert r["totais"]["candidatos_com_gastos"] > 0
    assert "despesas_atual" in r["tabelas_disponiveis"]


def test_buscar_e_ficha_do_candidato(banco):
    r = _rodar(servidor.buscar_candidato("candidato 0001", uf="xx"))
    assert r["n"] >= 1
    achado = next(c for c in r["candidatos"] if c["sq_candidato"] == "160001")
    assert achado["nome"] == "CANDIDATO 0001" and achado["tem_movimento"]
    # por número de urna, com filtro de cargo parcial
    r = _rodar(servidor.buscar_candidato("10001", cargo="estadual"))
    assert [c["sq_candidato"] for c in r["candidatos"]] == ["160001"]
    # registro sem movimento também aparece
    r = _rodar(servidor.buscar_candidato("CAND 1050"))
    assert r["n"] == 1 and r["candidatos"][0]["tem_movimento"] is False

    f = _rodar(servidor.ficha_candidato("160001"))
    assert f["registro"]["nome_urna"] == "CAND 0001"
    assert f["sem_movimento"] is False
    assert f["indicadores"]["total_contratado"] > 0
    assert f["gasto_por_categoria"] and f["maiores_fornecedores"]
    assert f["patrimonio_declarado"]["total"] == pytest.approx(350000.0)
    assert isinstance(f["sinais_fora_da_curva"], list)
    assert "total_contratado" in f["grupo_de_comparacao"]
    _sem_cpf_cru(f)

    f = _rodar(servidor.ficha_candidato("161050"))
    assert f["sem_movimento"] is True and f["indicadores"] is None

    from mcp.server.mcpserver.exceptions import ToolError

    with pytest.raises(ToolError):
        _rodar(servidor.ficha_candidato("999999"))


def test_remocoes_e_correcoes_sao_as_do_backend(banco):
    """A ferramenta lê o parquet pronto: uma remoção e uma retificação, as
    mesmas que o E2E confere direto no export."""
    r = _rodar(servidor.declaracoes_removidas())
    assert [d["descricao"] for d in r["declaracoes"]] == ["CARRO DE SOM QUE SOME"]
    assert r["valor_total"] > 0
    sq = r["declaracoes"][0]["sq_candidato"]
    f = _rodar(servidor.ficha_candidato(sq))
    assert [d["descricao"] for d in f["declaracoes_removidas"]] == ["CARRO DE SOM QUE SOME"]

    corrigidas = [c for sq_ in {sq, "160001"}
                  for c in (_rodar(servidor.ficha_candidato(sq_))["declaracoes_corrigidas"] or [])]
    todas = _rodar(servidor.sql("SELECT campo_alterado, valor_antes, valor_depois FROM despesas_alteradas"))
    assert todas["linhas"] == [{"campo_alterado": "valor", "valor_antes": 100.0, "valor_depois": 150.0}]
    assert all(c["campo_alterado"] == "valor" for c in corrigidas)


def test_ficha_do_fornecedor_e_privacidade(banco):
    f = _rodar(servidor.ficha_fornecedor("11.222.333/0001-44"))
    assert f["id"] == CNPJ_FORNECEDOR and f["tipo_id"] == "cnpj"
    assert f["perfil"]["candidatos"] > 1
    assert f["cadastro_rfb"]["razao_social"] == "FORNECEDOR LTDA OFICIAL"
    assert f["cadastro_rfb"]["data_abertura"] == "2025-11-15"
    assert f["candidatos_atendidos"] and f["maiores_notas"]
    assert f["cnpj_nao_encontrado_na_base_publica"] is False

    # pessoa física: o id é o código pf-… publicado; o CPF nunca aparece
    pf = _rodar(servidor.sql(
        "SELECT NR_CPF_CNPJ_FORNECEDOR AS id FROM despesas_atual "
        "WHERE NM_FORNECEDOR = 'PRESTADOR PESSOA FISICA' LIMIT 1"))["linhas"][0]["id"]
    assert pf.startswith("pf-")
    f = _rodar(servidor.ficha_fornecedor(pf))
    assert f["tipo_id"] == "pessoa_fisica_pseudonimizada" and f["cadastro_rfb"] is None
    _sem_cpf_cru(f)

    from mcp.server.mcpserver.exceptions import ToolError

    with pytest.raises(ToolError):
        _rodar(servidor.ficha_fornecedor("123"))


def test_ficha_do_partido_e_visoes(banco):
    p = _rodar(servidor.ficha_partido("xyz"))
    assert p["partido"] == "XYZ" and p["totais"]["candidatos_com_movimento"] > 0
    assert p["maiores_candidatos"]

    c = _rodar(servidor.fornecedores_compartilhados(uf="XX"))
    assert any(f["fornecedor_id"] == CNPJ_FORNECEDOR for f in c["fornecedores"])
    assert all(f["candidatos"] >= 2 for f in c["fornecedores"])

    fc = _rodar(servidor.fora_da_curva(uf="XX"))
    assert isinstance(fc["candidatos"], list)
    for cand in fc["candidatos"]:
        assert cand["sinais"] and all(s["valor"] > s["p95_do_grupo"] for s in cand["sinais"])

    from mcp.server.mcpserver.exceptions import ToolError

    with pytest.raises(ToolError):
        _rodar(servidor.fora_da_curva(sinal="inexistente"))

    g = _rodar(servidor.gastos_por_categoria(uf="XX"))
    assert g["categorias"] and g["categorias"][0]["total"] > 0
    s = _rodar(servidor.sem_nota())
    assert isinstance(s["candidatos"], list)


@pytest.mark.parametrize("rotulo,consulta", _consultas(), ids=[r for r, _ in _consultas()])
def test_sql_devolve_o_mesmo_que_a_execucao_direta(banco, rotulo, consulta):
    """Gate + teto + formatação não alteram o resultado: linha a linha igual ao
    cursor cru (sobre o mesmo banco), para cada consulta pronta do console."""
    pela_ferramenta = _rodar(servidor.sql(consulta))
    cur = banco.cursor()
    cur.execute(consulta)
    colunas = [d[0] for d in cur.description]
    direto = [dict(zip(colunas, (dados.json_seguro(v) for v in linha), strict=True))
              for linha in cur.fetchmany(500)]
    cur.close()
    assert pela_ferramenta["colunas"] == colunas
    assert pela_ferramenta["linhas"] == direto


def test_sql_recusa_e_explica(banco):
    from mcp.server.mcpserver.exceptions import ToolError

    with pytest.raises(ToolError, match="recusada"):
        _rodar(servidor.sql("DELETE FROM despesas_atual"))
    with pytest.raises(ToolError, match="DuckDB"):
        _rodar(servidor.sql("SELECT coluna_inexistente FROM despesas_atual"))
    with pytest.raises(ToolError, match="DuckDB"):
        _rodar(servidor.sql("SELECT * FROM read_csv('/etc/passwd')"))
