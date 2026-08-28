// Proxy dos dados publicados no GitHub Releases para a mesma origem do site.
// Necessário porque os assets de release do GitHub não enviam cabeçalhos CORS,
// o que impediria o navegador de lê-los diretamente.
const BASE = "https://github.com/machadouglas/analise-gastos-campanha/releases/download/dados/";

export async function onRequest({ params, request }) {
  // só leitura: qualquer outro verbo não tem significado aqui
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response("método não permitido", { status: 405, headers: { Allow: "GET, HEAD" } });

  // allowlist estrita do que o release publica (nada de "..", "/" ou extensões estranhas)
  const nome = params.arquivo;
  if (!/^[a-z0-9_]+\.(parquet|json)$/.test(nome))
    return new Response("nome inválido", { status: 400 });

  // Range (leituras parciais do DuckDB-WASM) e revalidação condicional seguem
  // para o upstream — sem repassar If-None-Match o ETag devolvido seria decorativo.
  const cabecalhos = {};
  for (const c of ["Range", "If-None-Match", "If-Modified-Since"]) {
    const v = request.headers.get(c);
    if (v) cabecalhos[c] = v;
  }

  // respostas completas (sem Range) ficam no cache da CDN — sem isso, cada
  // visitante desce até o GitHub. Respostas 206 não são cacheáveis pela Cache API.
  const cache = caches.default;
  const chave = new Request(new URL(request.url).toString().split("?")[0], { method: "GET" });
  if (request.method === "GET" && !cabecalhos["Range"]) {
    const emCache = await cache.match(chave);
    if (emCache) return emCache;
  }

  const upstream = await fetch(BASE + nome, {
    method: request.method,
    headers: cabecalhos,
    redirect: "follow",
  });
  const h = new Headers();
  for (const c of ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified"]) {
    const v = upstream.headers.get(c);
    if (v) h.set(c, v);
  }
  h.set("Access-Control-Allow-Origin", "*");
  // dados mudam 1x/dia; cache curto no navegador/CDN é suficiente.
  // Erros nunca entram em cache — um 404 transitório cacheado por 1h derrubaria a página.
  const ok = upstream.ok || upstream.status === 206 || upstream.status === 304;
  h.set(
    "Cache-Control",
    ok ? (nome.endsWith(".json") ? "public, max-age=300" : "public, max-age=3600") : "no-store",
  );
  const resposta = new Response(upstream.status === 304 ? null : upstream.body, {
    status: upstream.status,
    headers: h,
  });
  if (request.method === "GET" && !cabecalhos["Range"] && upstream.status === 200)
    await cache.put(chave, resposta.clone());
  return resposta;
}
