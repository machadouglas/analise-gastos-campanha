"""Acesso aos dados PUBLICADOS — o release `dados` do GitHub, a mesma fonte
que o site consome. Usado pela prévia local (scripts/previa-local.py) e pelo
servidor MCP (src/mcp/): os dois leem o que a rotina publicou, nunca o banco
da extração.

Só biblioteca padrão: o release é servido por CDN comum (não pelo CDN do TSE),
então urllib basta — sem curl_cffi, sem extensão httpfs do DuckDB.
"""

import hashlib
import json
import os
import shutil
import urllib.request
from pathlib import Path

REPO_PADRAO = "machadouglas/analise-gastos-campanha"
TAG_RELEASE = "dados"
AGENTE = "radar-dos-gastos (+https://github.com/machadouglas/analise-gastos-campanha)"


def repo() -> str:
    return os.environ.get("GH_REPO", REPO_PADRAO)


def base_url(repositorio: str | None = None) -> str:
    return f"https://github.com/{repositorio or repo()}/releases/download/{TAG_RELEASE}"


def _abrir(url: str, timeout: float):
    if not url.startswith("https://"):
        raise ValueError(f"só https: {url}")
    pedido = urllib.request.Request(url, headers={"User-Agent": AGENTE})  # noqa: S310
    return urllib.request.urlopen(pedido, timeout=timeout)  # noqa: S310 — esquema conferido acima


def baixar_resumo(base: str | None = None, timeout: float = 60) -> dict:
    """O resumo.json publicado (metadados + md5 por parquet em `arquivos`)."""
    with _abrir(f"{base or base_url()}/resumo.json", timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def baixar_arquivo(nome: str, destino: Path, base: str | None = None,
                   timeout: float = 300) -> Path:
    """Baixa um arquivo do release para `destino` (escrita atômica: .parte +
    rename, para um download interrompido nunca virar arquivo válido)."""
    destino.parent.mkdir(parents=True, exist_ok=True)
    parcial = destino.with_name(destino.name + ".parte")
    with _abrir(f"{base or base_url()}/{nome}", timeout) as r, open(parcial, "wb") as f:
        shutil.copyfileobj(r, f)
    parcial.replace(destino)
    return destino


def md5(caminho: Path) -> str:
    h = hashlib.md5(usedforsecurity=False)
    with open(caminho, "rb") as f:
        for bloco in iter(lambda: f.read(1 << 20), b""):
            h.update(bloco)
    return h.hexdigest()
