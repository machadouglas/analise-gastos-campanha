import { Route, Routes } from 'react-router-dom';
import { Toaster } from 'sonner';
import { Layout } from '@/components/app/layout';
import { Home } from '@/pages/home';
import { Consultar } from '@/pages/consultar';
import { Explorar } from '@/pages/explorar';
import { Candidato } from '@/pages/candidato';
import { Partido } from '@/pages/partido';
import { Fornecedor } from '@/pages/fornecedor';

export function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/explorar" element={<Explorar />} />
        <Route path="/candidato/:sq" element={<Candidato />} />
        <Route path="/partido/:sigla" element={<Partido />} />
        <Route path="/fornecedor/:id" element={<Fornecedor />} />
        <Route path="/consultar" element={<Consultar />} />
        <Route path="*" element={<Home />} />
      </Routes>
      <Toaster richColors position="top-right" />
    </Layout>
  );
}
