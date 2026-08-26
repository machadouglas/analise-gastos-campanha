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
