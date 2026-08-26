// Proxy dos dados publicados no GitHub Releases para a mesma origem do site.
// Necessário porque os assets de release do GitHub não enviam cabeçalhos CORS,
// o que impediria o navegador de lê-los diretamente.
const BASE = "https://github.com/machadouglas/analise-gastos-campanha/releases/download/dados/";

export async function onRequest({ params, request }) {
  const nome = params.arquivo;
  if (!/^[\w.-]+$/.test(nome)) return new Response("nome inválido", { status: 400 });

  const cabecalhos = {};
  const range = request.headers.get("Range");
  if (range) cabecalhos["Range"] = range;

  const upstream = await fetch(BASE + nome, { headers: cabecalhos, redirect: "follow" });
  const h = new Headers();
  for (const c of ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified"]) {
    const v = upstream.headers.get(c);
    if (v) h.set(c, v);
  }
  h.set("Access-Control-Allow-Origin", "*");
  // dados mudam 1x/dia; cache curto no navegador/CDN é suficiente
  h.set("Cache-Control", nome.endsWith(".json") ? "public, max-age=300" : "public, max-age=3600");
  return new Response(upstream.body, { status: upstream.status, headers: h });
}
