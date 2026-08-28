import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import { Toaster } from 'sonner';
import { Layout } from '@/components/app/layout';
import { Spinner } from '@/components/ui/spinner';

// Páginas em chunks próprios: quem abre a Home não baixa o console SQL nem o
// grafo de conexões (as páginas exportam nomeado, daí o .then).
const Home = lazy(() => import('@/pages/home').then((m) => ({ default: m.Home })));
const Consultar = lazy(() => import('@/pages/consultar').then((m) => ({ default: m.Consultar })));
const Explorar = lazy(() => import('@/pages/explorar').then((m) => ({ default: m.Explorar })));
const Candidato = lazy(() => import('@/pages/candidato').then((m) => ({ default: m.Candidato })));
const Partido = lazy(() => import('@/pages/partido').then((m) => ({ default: m.Partido })));
const Metodologia = lazy(() => import('@/pages/metodologia').then((m) => ({ default: m.Metodologia })));
const Fornecedor = lazy(() => import('@/pages/fornecedor').then((m) => ({ default: m.Fornecedor })));

function Carregando() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center text-muted-foreground">
      <Spinner className="h-6 w-6" />
    </div>
  );
}

export function App() {
  return (
    <Layout>
      <Suspense fallback={<Carregando />}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/explorar" element={<Explorar />} />
          <Route path="/candidato/:sq" element={<Candidato />} />
          <Route path="/partido/:sigla" element={<Partido />} />
          <Route path="/fornecedor/:id" element={<Fornecedor />} />
          <Route path="/consultar" element={<Consultar />} />
          <Route path="/metodologia" element={<Metodologia />} />
          <Route path="*" element={<Home />} />
        </Routes>
      </Suspense>
      <Toaster richColors position="top-right" />
    </Layout>
  );
}
