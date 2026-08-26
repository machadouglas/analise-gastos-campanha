"""Catálogo de fontes do TSE e download dos arquivos.

O CDN do TSE (Akamai) bloqueia clientes HTTP comuns por fingerprint TLS,
por isso o download usa curl_cffi com impersonação de navegador.
"""

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


def baixar_conjunto(conjunto: str, ano: int, forcar: bool = False) -> Path:
    """Baixa um conjunto de dados do TSE para data/raw/{ano}/. Retorna o caminho do zip."""
    url = CONJUNTOS[conjunto].format(ano=ano)
    destino = DIR_RAW / str(ano) / url.rsplit("/", 1)[-1]
    if destino.exists() and not forcar:
        print(f"[ok] {destino} já existe (use --forcar para rebaixar)")
        return destino
    destino.parent.mkdir(parents=True, exist_ok=True)
    print(f"[baixando] {url}")
    r = requests.get(url, impersonate="chrome", timeout=600)
    if r.status_code != 200:
        raise RuntimeError(f"HTTP {r.status_code} ao baixar {url}")
    destino.write_bytes(r.content)
    print(f"[ok] {destino} ({len(r.content) / 1e6:.1f} MB)")
    return destino
