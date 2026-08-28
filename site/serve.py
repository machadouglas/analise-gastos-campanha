"""Servidor local do build (site/dist) com fallback de SPA.

Rotas do app (/candidato/..., /explorar...) não existem como arquivo — este
servidor devolve o index.html para qualquer caminho sem extensão, o mesmo
papel que o arquivo _redirects cumpre no Cloudflare Pages em produção.
Uso: python site/serve.py [porta]  (padrão 8778)
"""

import http.server
import os
import sys
from functools import partial
from pathlib import Path

DIST = Path(__file__).parent / "dist"


class HandlerSPA(http.server.SimpleHTTPRequestHandler):
    def send_head(self):
        caminho = self.path.split("?")[0].split("#")[0]
        arquivo = self.translate_path(caminho)
        # rota de app: sem arquivo correspondente e sem extensão -> index.html
        if not os.path.exists(arquivo) and "." not in os.path.basename(caminho):
            self.path = "/index.html"
        return super().send_head()


def main() -> None:
    porta = int(sys.argv[1]) if len(sys.argv) > 1 else 8778
    servidor = http.server.ThreadingHTTPServer(
        ("", porta), partial(HandlerSPA, directory=str(DIST))
    )
    print(f"servindo {DIST} em http://localhost:{porta} (com fallback de SPA)")
    servidor.serve_forever()


if __name__ == "__main__":
    main()
