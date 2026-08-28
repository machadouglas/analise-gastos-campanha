"""Enriquecimento de fornecedores com o cadastro público de CNPJ (BrasilAPI).

Cache local em data/cache/cnpj/ e rate limit para respeitar a API pública.
"""

import json
import re
import time
from datetime import date
from math import ceil
from pathlib import Path

from curl_cffi import requests

DIR_CACHE = Path("data/cache/cnpj")
INTERVALO_SEGUNDOS = 1.5

# reconsulta contínua do cadastro: um registro "vence" depois deste prazo e a
# rotina diária reconsulta os mais antigos primeiro, num ritmo que percorre a
# base inteira dentro de um ciclo (sem estourar o --limite-cnpj da rotina)
REFRESH_APOS_DIAS = 30
CICLO_REFRESH_DIAS = 30


# marcador de cache negativo: CNPJ que a base pública não conhece (404) é fato
# estável — sem isso, o mesmo CNPJ seria reconsultado em toda rotina diária
MARCA_NAO_ENCONTRADO = {"nao_encontrado": True}


def _caminho_cache(cnpj: str) -> Path:
    return DIR_CACHE / f"{cnpj}.json"


def nao_encontrado(cnpj: str) -> bool:
    """True se a consulta já foi feita e a base pública respondeu 404."""
    cache = _caminho_cache(re.sub(r"\D", "", cnpj or ""))
    if not cache.exists():
        return False
    return bool(json.loads(cache.read_text(encoding="utf-8")).get("nao_encontrado"))


def consultar(cnpj: str, ignorar_cache: bool = False) -> dict | None:
    """Consulta um CNPJ na BrasilAPI (com cache, inclusive de 404).
    Retorna None para CPF/inválido, não encontrado ou erro transitório.
    `ignorar_cache` força ir à rede (reconsulta) — o resultado regrava o cache."""
    cnpj = re.sub(r"\D", "", cnpj or "")
    if len(cnpj) != 14:
        return None
    DIR_CACHE.mkdir(parents=True, exist_ok=True)
    cache = _caminho_cache(cnpj)
    if cache.exists() and not ignorar_cache:
        dados = json.loads(cache.read_text(encoding="utf-8"))
        return None if dados.get("nao_encontrado") else dados
    r = requests.get(f"https://brasilapi.com.br/api/cnpj/v1/{cnpj}", impersonate="chrome", timeout=60)
    time.sleep(INTERVALO_SEGUNDOS)
    if r.status_code == 404:
        cache.write_text(json.dumps(MARCA_NAO_ENCONTRADO), encoding="utf-8")
        print(f"[aviso] CNPJ {cnpj}: não encontrado na base pública (404, não será reconsultado)")
        return None
    if r.status_code != 200:
        # erro transitório (rate limit, 5xx): sem cache — tenta de novo amanhã
        print(f"[aviso] CNPJ {cnpj}: HTTP {r.status_code}")
        return None
    dados = json.loads(r.content.decode("utf-8"))
    cache.write_text(json.dumps(dados, ensure_ascii=False), encoding="utf-8")
    return dados


SITUACAO_NAO_ENCONTRADO = "NAO ENCONTRADO NA BASE PUBLICA"

COLUNAS_FORNECEDORES = (
    "cnpj, razao_social, data_abertura, situacao, porte, opcao_mei, "
    "cnae_principal, municipio, uf, capital_social, socios, "
    "dt_consulta, situacao_anterior, dt_situacao_anterior"
)


def _garantir_tabela(con) -> None:
    con.execute("""
        CREATE TABLE IF NOT EXISTS fornecedores (
            cnpj VARCHAR, razao_social VARCHAR, data_abertura VARCHAR,
            situacao VARCHAR, porte VARCHAR, opcao_mei BOOLEAN,
            cnae_principal VARCHAR, municipio VARCHAR, uf VARCHAR,
            capital_social DOUBLE, socios VARCHAR,
            dt_consulta DATE, situacao_anterior VARCHAR, dt_situacao_anterior DATE)
    """)
    # bases criadas antes do refresh contínuo: colunas novas entram com NULL
    # (dt_consulta NULL = "consulta de data desconhecida" — vai primeiro na fila)
    for coluna, tipo in [("dt_consulta", "DATE"), ("situacao_anterior", "VARCHAR"),
                         ("dt_situacao_anterior", "DATE")]:
        con.execute(f"ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS {coluna} {tipo}")


def _inserir_fornecedor(con, numero: str, dados: dict | None, hoje: date) -> None:
    if dados is None:
        # registro-tombstone: consulta respondida (404) — sai da fila e conta
        # como CNPJ verificado; a reconsulta por idade tenta de novo no ciclo
        con.execute(
            f"INSERT INTO fornecedores ({COLUNAS_FORNECEDORES}) VALUES "
            "(?, NULL, NULL, ?, NULL, NULL, NULL, NULL, NULL, 0, NULL, ?, NULL, NULL)",
            [numero, SITUACAO_NAO_ENCONTRADO, hoje],
        )
        return
    r = resumir(dados)
    con.execute(
        f"INSERT INTO fornecedores ({COLUNAS_FORNECEDORES}) VALUES "
        "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)",
        [numero, r["razao_social"], r["data_abertura"], r["situacao"], r["porte"],
         bool(r["opcao_mei"]), r["cnae_principal"], r["municipio"], r["uf"],
         float(r["capital_social"] or 0), r["socios"], hoje],
    )


def _atualizar_fornecedor(con, numero: str, dados: dict | None, hoje: date) -> bool:
    """Regrava o cadastro reconsultado; preserva a situação anterior quando ela
    muda (matéria-prima da futura red flag "baixado/inapto após receber").
    Retorna True se a situação mudou."""
    antiga, anterior, dt_anterior = con.execute(
        "SELECT situacao, situacao_anterior, dt_situacao_anterior "
        "FROM fornecedores WHERE cnpj = ?", [numero]).fetchone()
    r = resumir(dados) if dados else None
    nova = r["situacao"] if r else SITUACAO_NAO_ENCONTRADO
    mudou = antiga is not None and nova != antiga
    if mudou:
        anterior, dt_anterior = antiga, hoje
        print(f"[cnpj] MUDANÇA DE SITUAÇÃO: {numero}: '{antiga}' -> '{nova}'")
    if r is None:
        con.execute(
            "UPDATE fornecedores SET situacao = ?, dt_consulta = ?, "
            "situacao_anterior = ?, dt_situacao_anterior = ? WHERE cnpj = ?",
            [SITUACAO_NAO_ENCONTRADO, hoje, anterior, dt_anterior, numero],
        )
    else:
        con.execute(
            "UPDATE fornecedores SET razao_social = ?, data_abertura = ?, situacao = ?, "
            "porte = ?, opcao_mei = ?, cnae_principal = ?, municipio = ?, uf = ?, "
            "capital_social = ?, socios = ?, dt_consulta = ?, "
            "situacao_anterior = ?, dt_situacao_anterior = ? WHERE cnpj = ?",
            [r["razao_social"], r["data_abertura"], r["situacao"], r["porte"],
             bool(r["opcao_mei"]), r["cnae_principal"], r["municipio"], r["uf"],
             float(r["capital_social"] or 0), r["socios"], hoje,
             anterior, dt_anterior, numero],
        )
    return mudou


def enriquecer_em_massa(con, limite: int = 250, hoje: date | None = None) -> int:
    """Mantém a tabela `fornecedores`: consulta os CNPJs ainda não enriquecidos
    (maiores valores primeiro) e, com a folga do limite, reconsulta os cadastros
    mais antigos (vencidos há REFRESH_APOS_DIAS+), num ritmo que percorre a base
    num ciclo de ~CICLO_REFRESH_DIAS dias. O limite por execução respeita a API
    pública; a rotina diária vai completando o restante."""
    hoje = hoje or date.today()
    _garantir_tabela(con)
    pendentes = con.execute(f"""
        SELECT NR_CPF_CNPJ_FORNECEDOR AS cnpj, ROUND(SUM(VR), 2) AS total
        FROM v_despesas
        WHERE LENGTH(NR_CPF_CNPJ_FORNECEDOR) = 14
          AND NR_CPF_CNPJ_FORNECEDOR NOT IN (SELECT cnpj FROM fornecedores)
        GROUP BY 1 ORDER BY total DESC LIMIT {int(limite)}
    """).fetchall()

    novos = 0
    if pendentes:
        print(f"[cnpj] enriquecendo {len(pendentes)} fornecedores novos (maiores valores primeiro)...")
        for i, (numero, _) in enumerate(pendentes, 1):
            if i % 25 == 0:
                print(f"[cnpj] {i}/{len(pendentes)} consultados ({novos} novos até aqui)")
            dados = consultar(numero)
            if not dados and not nao_encontrado(numero):
                continue  # erro transitório: tenta de novo amanhã
            _inserir_fornecedor(con, numero, dados, hoje)
            novos += 1

    # folga do limite vira reconsulta: os cadastros mais antigos primeiro, só os
    # vencidos, e no máximo o necessário para fechar o ciclo (base/ciclo por dia)
    atualizados = mudancas = 0
    restante = int(limite) - len(pendentes)
    total_base = con.execute("SELECT COUNT(*) FROM fornecedores").fetchone()[0]
    if restante > 0 and total_base:
        quota = min(restante, max(1, ceil(total_base / CICLO_REFRESH_DIAS)))
        vencidos = con.execute("""
            SELECT f.cnpj FROM fornecedores f
            JOIN (SELECT NR_CPF_CNPJ_FORNECEDOR AS cnpj, SUM(VR) AS total
                  FROM v_despesas WHERE LENGTH(NR_CPF_CNPJ_FORNECEDOR) = 14
                  GROUP BY 1) d USING (cnpj)
            WHERE f.dt_consulta IS NULL OR f.dt_consulta <= ?::DATE - ?::INTEGER
            ORDER BY f.dt_consulta ASC NULLS FIRST, d.total DESC
            LIMIT ?
        """, [hoje, REFRESH_APOS_DIAS, quota]).fetchall()
        if vencidos:
            print(f"[cnpj] reconsultando {len(vencidos)} cadastros vencidos "
                  f"(mais antigos primeiro; ciclo ~{CICLO_REFRESH_DIAS} dias)...")
        for (numero,) in vencidos:
            dados = consultar(numero, ignorar_cache=True)
            if not dados and not nao_encontrado(numero):
                continue  # erro transitório: permanece vencido e volta amanhã
            mudancas += _atualizar_fornecedor(con, numero, dados, hoje)
            atualizados += 1

    if not pendentes and not atualizados:
        print(f"[cnpj] nada a fazer: sem pendentes e nenhum cadastro vencido (>{REFRESH_APOS_DIAS} dias)")
        return 0
    print(f"[cnpj] {novos} novos, {atualizados} reconsultados, {mudancas} mudanças de situação "
          f"(base: {con.execute('SELECT COUNT(*) FROM fornecedores').fetchone()[0]})")
    return novos + atualizados


def resumir(dados: dict) -> dict:
    """Campos mais relevantes para a análise."""
    socios = [s.get("nome_socio") for s in dados.get("qsa") or []]
    return {
        "cnpj": dados.get("cnpj"),
        "razao_social": dados.get("razao_social"),
        "data_abertura": dados.get("data_inicio_atividade"),
        "situacao": dados.get("descricao_situacao_cadastral"),
        "porte": dados.get("porte"),
        "opcao_mei": dados.get("opcao_pelo_mei"),
        "cnae_principal": dados.get("cnae_fiscal_descricao"),
        "municipio": dados.get("municipio"),
        "uf": dados.get("uf"),
        "capital_social": dados.get("capital_social"),
        "socios": ", ".join(filter(None, socios)),
    }
