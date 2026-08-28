import { Link, useLocation } from 'react-router-dom';
import { BarChart3, BookOpen, Radar, Terminal } from 'lucide-react';
import { cn } from '@/lib/utils';

const REPO = 'https://github.com/machadouglas/analise-gastos-campanha';

const navegacao = [
  { nome: 'Radar', href: '/', icone: Radar },
  { nome: 'Explorar', href: '/explorar', icone: BarChart3 },
  { nome: 'Consultar (SQL + IA)', href: '/consultar', icone: Terminal },
  // a tese do site é o método — a metodologia merece porta de entrada no topo
  { nome: 'Metodologia', href: '/metodologia', icone: BookOpen },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();

  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#conteudo"
        className="sr-only z-[60] rounded-md bg-[#10244A] px-4 py-2 text-sm font-semibold text-white focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Pular para o conteúdo
      </a>
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <nav className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
          <Link to="/" className="transition-opacity hover:opacity-80">
            <span className="inline-flex items-center gap-2">
              <Radar className="h-6 w-6 text-[#264E9B]" />
              <span className="text-lg font-bold tracking-tight">
                Radar<span className="text-brand"> das Contas</span>
              </span>
            </span>
          </Link>
          <div className="flex items-center gap-2 sm:gap-4">
            {navegacao.map((item) => (
              <Link
                key={item.href}
                to={item.href}
                className={cn(
                  'flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                  pathname === item.href
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                )}
              >
                <item.icone className="h-4 w-4" />
                <span className="hidden sm:inline">{item.nome}</span>
              </Link>
            ))}
          </div>
        </nav>
      </header>

      <main id="conteudo" className="flex-1">{children}</main>

      <footer className="border-t bg-muted/30">
        <div className="mx-auto max-w-7xl px-6 py-12 text-sm text-muted-foreground">
          <p className="max-w-3xl">
            <strong className="text-foreground">Metodologia.</strong> Dados oficiais do{' '}
            <a className="underline underline-offset-4 hover:text-foreground" href="https://dadosabertos.tse.jus.br" rel="noopener">
              Portal de Dados Abertos do TSE
            </a>
            , extraídos diariamente. Os dados são declaratórios: refletem o que os próprios candidatos
            informam e podem ser retificados. Remoções e alterações são indícios a investigar,{' '}
            <strong className="text-foreground">nunca acusações</strong>. CPFs são anonimizados pelo próprio TSE.
          </p>
          <div className="mt-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-6">
              <Link className="hover:text-foreground" to="/metodologia">Metodologia</Link>
              <a className="hover:text-foreground" href={REPO} rel="noopener">Código-fonte</a>
              <a className="hover:text-foreground" href={`${REPO}/releases/tag/dados`} rel="noopener">
                Dados em Parquet
              </a>
            </div>
            <p>Projeto de código e dados abertos, sem fins lucrativos.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
