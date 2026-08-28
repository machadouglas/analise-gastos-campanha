"""Catálogo de fontes do TSE e download dos arquivos.

O CDN do TSE (Akamai) bloqueia clientes HTTP comuns por fingerprint TLS,
por isso o download usa curl_cffi com impersonação de navegador.
"""

import time
from pathlib import Path

from curl_cffi import requests

CDN = "https://cdn.tse.jus.br/estatistica/sead/odsele"
DIR_RAW = Path("data/raw")

# Conjuntos de dados por ano. {ano} é substituído no download.
CONJUNTOS = {
    "prestacao": f"{CDN}/prestacao_contas/prestacao_de_contas_eleitorais_candidatos_{{ano}}.zip",
    "candidatos": f"{CDN}/consulta_cand/consulta_cand_{{ano}}.zip",
    "bens": f"{CDN}/bem_candidato/bem_candidato_{{ano}}.zip",
    "cnpj_campanha": f"{CDN}/prestacao_contas/CNPJ_campanha_{{ano}}.zip",
}


def baixar_conjunto(
    conjunto: str, ano: int, forcar: bool = False, condicional: bool = False
) -> tuple[Path, bool]:
    """Baixa um conjunto de dados do TSE para data/raw/{ano}/.

    Com `condicional=True` e o zip já em disco, pergunta ao CDN via
    If-Modified-Since se há versão nova — um 304 evita rebaixar dezenas de MB
    quando o TSE ainda serve a mesma extração. Retorna (caminho, baixou_novo).
    """
    url = CONJUNTOS[conjunto].format(ano=ano)
    destino = DIR_RAW / str(ano) / url.rsplit("/", 1)[-1]
    marca = destino.with_suffix(destino.suffix + ".lastmod")
    if destino.exists() and not forcar and not condicional:
        print(f"[ok] {destino} já existe (use --forcar para rebaixar)")
        return destino, False
    destino.parent.mkdir(parents=True, exist_ok=True)
    cabecalhos = {}
    if condicional and destino.exists() and marca.exists():
        cabecalhos["If-Modified-Since"] = marca.read_text(encoding="utf-8").strip()
    print(f"[baixando] {url}")
    inicio = time.time()
    r = requests.get(url, impersonate="chrome", timeout=600, stream=True, headers=cabecalhos)
    if r.status_code == 304:
        r.close()
        print(f"[ok] {destino.name}: TSE ainda serve a mesma versão (304) — download pulado")
        return destino, False
    if r.status_code != 200:
        r.close()
        raise RuntimeError(f"HTTP {r.status_code} ao baixar {url}")
    # grava em .part e renomeia no fim: download interrompido não deixa
    # zip corrompido que uma rodada futura sem --forcar tomaria por pronto
    parcial = destino.with_suffix(destino.suffix + ".part")
    baixado, marco = 0, 0
    with open(parcial, "wb") as f:
        for pedaco in r.iter_content():
            f.write(pedaco)
            baixado += len(pedaco)
            if baixado - marco >= 50_000_000:  # progresso a cada 50 MB
                marco = baixado
                print(f"[baixando] {destino.name}: {baixado / 1e6:.0f} MB...")
    parcial.replace(destino)
    ultima_modificacao = r.headers.get("Last-Modified")
    if ultima_modificacao:
        marca.write_text(ultima_modificacao, encoding="utf-8")
    print(f"[ok] {destino} ({baixado / 1e6:.1f} MB em {time.time() - inicio:.0f}s)")
    return destino, True
