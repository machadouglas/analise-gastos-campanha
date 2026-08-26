"""Enriquecimento de fornecedores com o cadastro público de CNPJ (BrasilAPI).

Cache local em data/cache/cnpj/ e rate limit para respeitar a API pública.
"""

import json
import re
import time
from pathlib import Path

from curl_cffi import requests

DIR_CACHE = Path("data/cache/cnpj")
INTERVALO_SEGUNDOS = 1.5


def consultar(cnpj: str) -> dict | None:
    """Consulta um CNPJ na BrasilAPI (com cache). Retorna None para CPF/inválido."""
    cnpj = re.sub(r"\D", "", cnpj or "")
    if len(cnpj) != 14:
        return None
    DIR_CACHE.mkdir(parents=True, exist_ok=True)
    cache = DIR_CACHE / f"{cnpj}.json"
    if cache.exists():
        return json.loads(cache.read_text(encoding="utf-8"))
    r = requests.get(f"https://brasilapi.com.br/api/cnpj/v1/{cnpj}", impersonate="chrome", timeout=60)
    time.sleep(INTERVALO_SEGUNDOS)
    if r.status_code != 200:
        print(f"[aviso] CNPJ {cnpj}: HTTP {r.status_code}")
        return None
    dados = json.loads(r.content.decode("utf-8"))
    cache.write_text(json.dumps(dados, ensure_ascii=False), encoding="utf-8")
    return dados


def enriquecer_em_massa(con, limite: int = 250) -> int:
    """Consulta os CNPJs de fornecedores ainda não enriquecidos (maiores valores
    primeiro) e mantém a tabela `fornecedores` no banco. O limite por execução
    respeita a API pública; a rotina diária vai completando o restante."""
    con.execute("""
        CREATE TABLE IF NOT EXISTS fornecedores (
            cnpj VARCHAR, razao_social VARCHAR, data_abertura VARCHAR,
            situacao VARCHAR, porte VARCHAR, opcao_mei BOOLEAN,
            cnae_principal VARCHAR, municipio VARCHAR, uf VARCHAR,
            capital_social DOUBLE, socios VARCHAR)
    """)
    pendentes = con.execute(f"""
        SELECT NR_CPF_CNPJ_FORNECEDOR AS cnpj, ROUND(SUM(VR), 2) AS total
        FROM v_despesas
        WHERE LENGTH(NR_CPF_CNPJ_FORNECEDOR) = 14
          AND NR_CPF_CNPJ_FORNECEDOR NOT IN (SELECT cnpj FROM fornecedores)
        GROUP BY 1 ORDER BY total DESC LIMIT {int(limite)}
    """).fetchall()
    if not pendentes:
        print("[cnpj] nenhum fornecedor pendente de enriquecimento")
        return 0
    print(f"[cnpj] enriquecendo {len(pendentes)} fornecedores (BrasilAPI, com cache)...")
    novos = 0
    for numero, _ in pendentes:
        dados = consultar(numero)
        if not dados:
            continue
        r = resumir(dados)
        con.execute(
            "INSERT INTO fornecedores VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [numero, r["razao_social"], r["data_abertura"], r["situacao"], r["porte"],
             bool(r["opcao_mei"]), r["cnae_principal"], r["municipio"], r["uf"],
             float(r["capital_social"] or 0), r["socios"]],
        )
        novos += 1
    print(f"[cnpj] {novos} fornecedores enriquecidos (total na base: "
          f"{con.execute('SELECT COUNT(*) FROM fornecedores').fetchone()[0]})")
    return novos


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
