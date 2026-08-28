import { describe, expect, it } from 'vitest';
import { separarStatements, validarLeitura } from './sql-gate';

describe('separarStatements', () => {
  it('consulta simples vira um statement único', () => {
    expect(separarStatements('SELECT 1').map((s) => s.trim())).toEqual(['SELECT 1']);
  });

  it('separa statements de nível superior', () => {
    const partes = separarStatements('SELECT 1; DROP TABLE x').map((s) => s.trim());
    expect(partes).toEqual(['SELECT 1', 'DROP TABLE x']);
  });

  it("';' dentro de string não separa", () => {
    const partes = separarStatements("SELECT 'a;b' AS x").map((s) => s.trim());
    expect(partes).toEqual(["SELECT 'a;b' AS x"]);
  });

  it("aspa escapada por duplicação ('') não fecha a string", () => {
    const partes = separarStatements("SELECT 'D''AVILA; ainda dentro' AS x").map((s) => s.trim());
    expect(partes).toHaveLength(1);
  });

  it("';' dentro de identificador entre aspas duplas não separa", () => {
    expect(separarStatements('SELECT 1 AS "a;b"')).toHaveLength(1);
  });

  it('remove comentários de linha e de bloco', () => {
    const partes = separarStatements('SELECT 1 -- comentário; DROP\n, 2 /* outro; DROP */, 3');
    expect(partes).toHaveLength(1);
    expect(partes[0]).not.toContain('DROP');
  });

  it('comentário não engole o resto da consulta multilinha', () => {
    const partes = separarStatements('-- cabeçalho\nSELECT 1;\nSELECT 2').map((s) => s.trim());
    expect(partes.filter(Boolean)).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it("';' dentro de dollar-quoting não separa", () => {
    expect(separarStatements("SELECT $$a;b$$ AS x")).toHaveLength(1);
    expect(separarStatements('SELECT $tag$a;b$tag$ AS x')).toHaveLength(1);
  });

  it('string sem fechamento não trava (vai até o fim)', () => {
    expect(separarStatements("SELECT 'aberta")).toHaveLength(1);
  });
});

describe('validarLeitura', () => {
  it.each(['SELECT 1', 'WITH x AS (SELECT 1) SELECT * FROM x', 'DESCRIBE despesas_atual',
    'SUMMARIZE indicadores', 'FROM despesas_atual LIMIT 5', '  select 1', '-- oi\nSELECT 1'])(
    'aceita leitura: %s',
    (sql) => expect(validarLeitura(sql)).toBeNull(),
  );

  it.each(['DROP TABLE despesas', 'CREATE TABLE x AS SELECT 1', 'INSTALL httpfs',
    'COPY despesas TO \'x.csv\'', 'UPDATE despesas SET valor = 0', 'SET memory_limit = \'1GB\''])(
    'rejeita escrita/DDL: %s',
    (sql) => expect(validarLeitura(sql)).toContain('leitura'),
  );

  it('rejeita escrita escondida atrás de um SELECT (multi-statement)', () => {
    expect(validarLeitura('SELECT 1; CREATE TABLE x AS SELECT 2')).toContain('leitura');
    expect(validarLeitura('SELECT 1; INSTALL httpfs')).toContain('leitura');
  });

  it('não se deixa enganar por comentário que "esconde" o resto', () => {
    // stripping ingênuo de '--' quebraria aqui: o -- está dentro de string
    expect(validarLeitura("SELECT '--'; DROP TABLE x")).toContain('leitura');
  });

  it('consulta vazia ou só comentário é rejeitada', () => {
    expect(validarLeitura('')).toBeTruthy();
    expect(validarLeitura('-- só comentário')).toBeTruthy();
  });

  it('vários SELECTs são permitidos (o console mostra o último resultado)', () => {
    expect(validarLeitura('SELECT 1; SELECT 2')).toBeNull();
  });
});
