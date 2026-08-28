"""Fixtures compartilhadas: banco DuckDB em memória com o schema mínimo dos
arquivos do TSE e as MESMAS views tipadas da carga real (carga.criar_views),
para que os testes exercitem o SQL de produção, não uma cópia."""

import sys
from pathlib import Path

import duckdb
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from src import carga, historico  # noqa: E402

COLS_DESPESAS = [
    "DT_GERACAO", "HH_GERACAO", "SQ_PRESTADOR_CONTAS", "SQ_CANDIDATO",
    "NM_CANDIDATO", "NR_CANDIDATO", "SG_PARTIDO", "DS_CARGO", "SG_UF",
    "SQ_DESPESA", "NM_FORNECEDOR", "NM_FORNECEDOR_RFB", "NR_CPF_CNPJ_FORNECEDOR",
    "DS_CNAE_FORNECEDOR", "DS_TIPO_FORNECEDOR", "SQ_CANDIDATO_FORNECEDOR",
    "SG_PARTIDO_FORNECEDOR", "DS_CARGO_FORNECEDOR", "DS_ORIGEM_DESPESA",
    "DS_DESPESA", "DS_TIPO_DOCUMENTO", "VR_DESPESA_CONTRATADA", "DT_DESPESA",
]

COLS_RECEITAS = [
    "DT_GERACAO", "HH_GERACAO", "SQ_PRESTADOR_CONTAS", "SQ_CANDIDATO",
    "NM_CANDIDATO", "NR_CANDIDATO", "SG_PARTIDO", "DS_CARGO", "SG_UF",
    "SQ_RECEITA", "NM_DOADOR", "NM_DOADOR_RFB", "NR_CPF_CNPJ_DOADOR",
    "DS_FONTE_RECEITA", "DS_ORIGEM_RECEITA", "DS_ESPECIE_RECEITA",
    "VR_RECEITA", "DT_RECEITA",
]

DESPESA_PADRAO = {
    "DT_GERACAO": "20/08/2026", "HH_GERACAO": "04:00:00",
    "SQ_PRESTADOR_CONTAS": "900001", "SQ_CANDIDATO": "160001",
    "NM_CANDIDATO": "FULANO", "NR_CANDIDATO": "12345", "SG_PARTIDO": "XYZ",
    "DS_CARGO": "Deputado Estadual", "SG_UF": "XX",
    "SQ_DESPESA": "1", "NM_FORNECEDOR": "FORNECEDOR LTDA",
    "NM_FORNECEDOR_RFB": "#NULO", "NR_CPF_CNPJ_FORNECEDOR": "11222333000144",
    "DS_CNAE_FORNECEDOR": "Publicidade", "DS_TIPO_FORNECEDOR": "PESSOA JURÍDICA",
    "SQ_CANDIDATO_FORNECEDOR": "-1", "SG_PARTIDO_FORNECEDOR": "#NULO",
    "DS_CARGO_FORNECEDOR": "#NULO",
    "DS_ORIGEM_DESPESA": "Publicidade por materiais impressos",
    "DS_DESPESA": "BANDEIRA", "DS_TIPO_DOCUMENTO": "Nota Fiscal",
    "VR_DESPESA_CONTRATADA": "100,00", "DT_DESPESA": "15/08/2026",
}

RECEITA_PADRAO = {
    "DT_GERACAO": "20/08/2026", "HH_GERACAO": "04:00:00",
    "SQ_PRESTADOR_CONTAS": "900001", "SQ_CANDIDATO": "160001",
    "NM_CANDIDATO": "FULANO", "NR_CANDIDATO": "12345", "SG_PARTIDO": "XYZ",
    "DS_CARGO": "Deputado Estadual", "SG_UF": "XX",
    "SQ_RECEITA": "1", "NM_DOADOR": "DOADOR DA SILVA", "NM_DOADOR_RFB": "#NULO",
    "NR_CPF_CNPJ_DOADOR": "99888777000166",
    "DS_FONTE_RECEITA": "OUTROS RECURSOS",
    "DS_ORIGEM_RECEITA": "Recursos de pessoas jurídicas",
    "DS_ESPECIE_RECEITA": "Transferência eletrônica",
    "VR_RECEITA": "1000,00", "DT_RECEITA": "10/08/2026",
}


def montar_banco() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute(f"CREATE TABLE despesas_contratadas ({', '.join(c + ' VARCHAR' for c in COLS_DESPESAS)})")
    con.execute(f"CREATE TABLE receitas ({', '.join(c + ' VARCHAR' for c in COLS_RECEITAS)})")
    con.execute("""
        CREATE TABLE despesas_pagas (DT_GERACAO VARCHAR, SQ_PRESTADOR_CONTAS VARCHAR,
            SG_UF VARCHAR, VR_PAGTO_DESPESA VARCHAR, DT_PAGTO_DESPESA VARCHAR);
        CREATE TABLE receitas_doador_originario (SQ_PRESTADOR_CONTAS VARCHAR,
            NR_CPF_CNPJ_DOADOR_ORIGINARIO VARCHAR, NM_DOADOR_ORIGINARIO VARCHAR,
            NM_DOADOR_ORIGINARIO_RFB VARCHAR, VR_RECEITA VARCHAR);
        CREATE TABLE candidatos (SQ_CANDIDATO VARCHAR, NR_CANDIDATO VARCHAR,
            NM_CANDIDATO VARCHAR, NM_URNA_CANDIDATO VARCHAR, DS_CARGO VARCHAR,
            SG_PARTIDO VARCHAR, SG_UF VARCHAR, DS_SITUACAO_CANDIDATURA VARCHAR);
        CREATE TABLE bens (SQ_CANDIDATO VARCHAR, SG_UF VARCHAR,
            DS_TIPO_BEM_CANDIDATO VARCHAR, DS_BEM_CANDIDATO VARCHAR,
            VR_BEM_CANDIDATO VARCHAR, DT_ULT_ATUAL_BEM_CANDIDATO VARCHAR);
    """)
    carga.criar_views(con)
    return con


def _inserir(con, tabela, colunas, padrao, ajustes):
    linha = {**padrao, **ajustes}
    extras = set(ajustes) - set(colunas)
    assert not extras, f"colunas desconhecidas: {extras}"
    con.execute(
        f"INSERT INTO {tabela} ({', '.join(colunas)}) VALUES ({', '.join('?' for _ in colunas)})",
        [linha[c] for c in colunas],
    )


def inserir_despesa(con, **ajustes):
    _inserir(con, "despesas_contratadas", COLS_DESPESAS, DESPESA_PADRAO, ajustes)


def inserir_receita(con, **ajustes):
    _inserir(con, "receitas", COLS_RECEITAS, RECEITA_PADRAO, ajustes)


def inserir_pagamento(con, valor="100,00", sq_prestador="900001", data="16/08/2026"):
    con.execute(
        "INSERT INTO despesas_pagas VALUES ('20/08/2026', ?, 'XX', ?, ?)",
        [sq_prestador, valor, data],
    )


def inserir_bem(con, valor="50000,00", sq_candidato="160001", tipo="Casa"):
    con.execute(
        "INSERT INTO bens VALUES (?, 'XX', ?, 'BEM DECLARADO', ?, '15/07/2026')",
        [sq_candidato, tipo, valor],
    )


def extrair_dia(con, data, despesas=(), receitas=()):
    """Simula a extração de um dia: recria as tabelas brutas e versiona.
    `despesas`/`receitas` são listas de dicts de ajustes sobre os padrões."""
    con.execute("DELETE FROM despesas_contratadas")
    con.execute("DELETE FROM receitas")
    for d in despesas:
        inserir_despesa(con, DT_GERACAO=data, **d)
    for r in receitas:
        inserir_receita(con, DT_GERACAO=data, **r)
    historico.versionar(con)


@pytest.fixture
def banco():
    con = montar_banco()
    yield con
    con.close()
