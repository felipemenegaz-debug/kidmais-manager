import assert from 'node:assert/strict';
import test from 'node:test';
import { bytesDaLogo, colunasDoConteudo, marcaDoBuffet, mostrarLogoBuffet, paraBuffet, preservarLogoBuffet, semLogoBuffet } from './logo-buffet.ts';
import { conteudoSchema, comandoSchema, inicioConteudo } from './domain.ts';

type C = { nome: string; logoBuffet?: boolean };
const LOGO = 'data:image/png;base64,' + Buffer.from('logo').toString('base64');

test('ausente = ligado; só false desliga', () => {
  assert.equal(mostrarLogoBuffet(undefined), true);
  assert.equal(mostrarLogoBuffet({}), true);
  assert.equal(mostrarLogoBuffet({ logoBuffet: true }), true);
  assert.equal(mostrarLogoBuffet({ logoBuffet: false }), false);
});

test('salvar preserva o valor gravado, venha o que vier da tela', () => {
  assert.deepEqual(preservarLogoBuffet<C>({ nome: 'a', logoBuffet: true }, { logoBuffet: false }), { nome: 'a', logoBuffet: false });
  assert.deepEqual(preservarLogoBuffet<C>({ nome: 'a', logoBuffet: false }, {}), { nome: 'a' });
  assert.deepEqual(preservarLogoBuffet<C>({ nome: 'a' }, null), { nome: 'a' });
  assert.deepEqual(semLogoBuffet({ nome: 'a', logoBuffet: false }), { nome: 'a' });
});

test('a logo só sai como PNG, JPEG ou WebP em base64', () => {
  assert.equal(bytesDaLogo(LOGO)?.tipo, 'image/png');
  assert.equal(bytesDaLogo(LOGO)?.bytes.toString(), 'logo');
  for (const ruim of [null, '', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:text/html;base64,PGI+', 'https://exemplo.invalid/logo.png', 'data:image/png;base64,', 'data:image/png;base64,@@'])
    assert.equal(bytesDaLogo(ruim), null, String(ruim));
});

test('schema: logoBuffet é opcional no conteúdo e a ação do buffet é estrita', () => {
  const base = inicioConteudo(null);
  const caminhos = (v: unknown) => { const r = conteudoSchema.safeParse(v); return r.success ? [] : r.error.issues.map(i => i.path.join('.')); };
  assert.deepEqual(caminhos({ ...base, logoBuffet: false }), caminhos(base));
  assert.ok(caminhos({ ...base, logoBuffet: 'sim' }).includes('logoBuffet'));
  const ok = { acao: 'logo_buffet', sessao: S, seq: 1 };
  assert.equal(comandoSchema.safeParse({ ...ok, mostrar: false }).success, true);
  assert.equal(comandoSchema.safeParse({ acao: 'logo_buffet' }).success, false);
  assert.equal(comandoSchema.safeParse({ ...ok, mostrar: true, extra: 1 }).success, false);
  // Formato antigo (sem sessão e seq) não vale mais.
  assert.equal(comandoSchema.safeParse({ acao: 'logo_buffet', mostrar: false }).success, false);
});

const S = '22222222-2222-4222-8222-222222222222';
const A = '33333333-3333-4333-8333-333333333333', B = '44444444-4444-4444-8444-444444444444';
const P = (arteId = A, extra: object = {}) => ({ modo: 'sobre', arteId, x: 50, y: 80, largura: 18, fundo: false, ...extra });
const valido = (v: unknown) => comandoSchema.safeParse(v).success;

test('schema da etapa 3: limites, extras, comando vazio, posição sem arteId, sem origem, artes distintas', () => {
  const base = { acao: 'logo_buffet', sessao: S, seq: 1 };
  assert.equal(valido({ ...base }), false, 'comando vazio');
  assert.equal(valido({ ...base, posicoes: [P()] }), true);
  assert.equal(valido({ ...base, posicoes: [] }), false, 'lista vazia');
  assert.equal(valido({ ...base, posicoes: [P(A), P(B), P('55555555-5555-4555-8555-555555555555'), P('66666666-6666-4666-8666-666666666666')] }), true);
  assert.equal(valido({ ...base, posicoes: [P(A), P(B), P('55555555-5555-4555-8555-555555555555'), P('66666666-6666-4666-8666-666666666666'), P('77777777-7777-4777-8777-777777777777')] }), false, 'mais de 4');
  assert.equal(valido({ ...base, posicoes: [P(A), P(A)] }), false, 'arte repetida');
  const { arteId: _a, ...semArte } = P(); void _a;
  assert.equal(valido({ ...base, posicoes: [semArte] }), false, 'sem arteId');
  assert.equal(valido({ ...base, posicoes: [P(A, { origem: 'buffet' })] }), false, 'origem é do servidor');
  assert.equal(valido({ ...base, posicoes: [P(A, { extra: 1 })] }), false);
  for (const [campo, ruim] of [['x', -0.1], ['x', 100.1], ['y', 101], ['largura', 7.9], ['largura', 40.1], ['modo', 'meio'], ['fundo', 'sim']] as const)
    assert.equal(valido({ ...base, posicoes: [P(A, { [campo]: ruim })] }), false, campo + '=' + ruim);
  for (const [campo, bom] of [['x', 0], ['x', 100], ['largura', 8], ['largura', 40]] as const)
    assert.equal(valido({ ...base, posicoes: [P(A, { [campo]: bom })] }), true, campo + '=' + bom);
  for (const seq of [0, -1, 1.5, 2 ** 31 + 1, '1']) assert.equal(valido({ ...base, seq, mostrar: true }), false, 'seq ' + seq);
  assert.equal(valido({ ...base, seq: 2 ** 31, mostrar: true }), true);
  assert.equal(valido({ ...base, sessao: 'nao-uuid', mostrar: true }), false);
  // Sessão: só `substitui` opcional, uuid.
  assert.equal(valido({ acao: 'logo_sessao' }), true);
  assert.equal(valido({ acao: 'logo_sessao', substitui: S }), true);
  assert.equal(valido({ acao: 'logo_sessao', substitui: 'x' }), false);
  assert.equal(valido({ acao: 'logo_sessao', sessao: S }), false);
});

test('conteúdo aceita o mapa por arte com origem e as listas internas, com limites', () => {
  const base = inicioConteudo(null);
  const ok = (v: object) => !conteudoSchema.safeParse({ ...base, ...v }).error?.issues.some(i => String(i.path[0]).startsWith('logo'));
  assert.ok(ok({ logoPosicoes: { [A]: P(A, { origem: 'reservada' }) } }));
  assert.ok(!ok({ logoPosicoes: { [A]: P(A) } }), 'gravado sem origem');
  assert.ok(!ok({ logoPosicoes: { nao: P(A, { origem: 'buffet' }) } }), 'chave não uuid');
  assert.ok(ok({ logoGeracoes: [A], logoSemNome: [A, B], logoOrdem: { sessoes: [{ id: S, mostrar: 3, posicoes: { [A]: 2 } }] } }));
  assert.ok(!ok({ logoGeracoes: Array(6).fill(A) }));
  assert.ok(!ok({ logoOrdem: { sessoes: Array.from({ length: 21 }, () => ({ id: S })) } }));
});

type CL = { nome: string; logoBuffet?: boolean; logoPosicoes?: unknown; logoOrdem?: unknown; logoGeracoes?: unknown; logoSemNome?: unknown };
const gravado: CL = { nome: 'g', logoBuffet: false, logoPosicoes: { [A]: P(A, { origem: 'reservada' }) }, logoOrdem: { sessoes: [{ id: S }] }, logoGeracoes: [B], logoSemNome: [A] };
const forjado: CL = { nome: 'tela', logoBuffet: true, logoPosicoes: { [A]: P(A, { x: 1, origem: 'buffet' }) }, logoOrdem: { sessoes: [] }, logoGeracoes: [], logoSemNome: [] };

test('salvar/publicar: vale o gravado (logoBuffet e logoPosicoes); listas internas só no rascunho, do gravado', () => {
  const conteudo = preservarLogoBuffet(forjado, gravado);
  assert.deepEqual(conteudo, { nome: 'tela', logoBuffet: false, logoPosicoes: gravado.logoPosicoes });
  const { rascunho, publicado } = colunasDoConteudo(conteudo, gravado);
  assert.deepEqual(publicado, { nome: 'tela', logoBuffet: false, logoPosicoes: gravado.logoPosicoes });
  assert.deepEqual(rascunho, { ...publicado, logoOrdem: gravado.logoOrdem, logoGeracoes: gravado.logoGeracoes, logoSemNome: gravado.logoSemNome });
  assert.notEqual(rascunho, publicado, 'dois objetos (dois parâmetros)');
  // Sem histórico gravado: o rascunho fica sem as chaves, mesmo que a tela envie.
  const semHistorico = colunasDoConteudo(preservarLogoBuffet(forjado, {}), {});
  assert.deepEqual(semHistorico.rascunho, { nome: 'tela' });
  assert.deepEqual(semHistorico.publicado, { nome: 'tela' });
});

test('leituras: buffet sem logoOrdem/logoGeracoes; família sem nenhum campo da logo', () => {
  assert.ok(gravado.logoOrdem && gravado.logoGeracoes && gravado.logoSemNome, 'origem com as chaves');
  assert.deepEqual(Object.keys(paraBuffet(gravado)).sort(), ['logoBuffet', 'logoPosicoes', 'logoSemNome', 'nome']);
  assert.deepEqual(paraBuffet(gravado).logoSemNome, [A]);
  const familia = semLogoBuffet(gravado) as Record<string, unknown>;
  for (const k of ['logoBuffet', 'logoPosicoes', 'logoOrdem', 'logoGeracoes', 'logoSemNome']) assert.ok(!(k in familia), k);
  assert.deepEqual(familia, { nome: 'g' });
});

function executor(r: { estrutura?: boolean; perfis?: number; logo?: string | null; padrao?: unknown }) {
  const consultas: string[] = [];
  return { consultas, async query(sql: string) {
    consultas.push(sql);
    if (sql.includes('to_regclass')) return { rows: [{ ok: r.estrutura ?? true }] };
    if (sql.includes('FROM public.perfil_empresas p')) return { rows: Array.from({ length: r.perfis ?? 1 }, (_, i) => ({ id: `p${i}` })) };
    if (sql.includes('perfil_empresa_revisoes')) return { rows: r.logo === undefined ? [] : [{ logo: r.logo, padrao: r.padrao ?? null }] };
    throw new Error('SQL inesperado: ' + sql);
  } } as never;
}

test('marca do buffet: lida da revisão aplicada; tolerante a ausência e ambiguidade', async () => {
  assert.deepEqual(await marcaDoBuffet(executor({ logo: LOGO, padrao: false }), 'e'), { logoDataUrl: LOGO, padrao: false });
  assert.deepEqual(await marcaDoBuffet(executor({ logo: LOGO }), 'e'), { logoDataUrl: LOGO, padrao: true });
  assert.deepEqual(await marcaDoBuffet(executor({ logo: 'data:image/svg+xml;base64,PHN2Zz4=' }), 'e'), { logoDataUrl: null, padrao: true });
  assert.deepEqual(await marcaDoBuffet(executor({}), 'e'), { logoDataUrl: null, padrao: true });
  assert.deepEqual(await marcaDoBuffet(executor({ perfis: 2, logo: LOGO, padrao: false }), 'e'), { logoDataUrl: null, padrao: true });
  assert.deepEqual(await marcaDoBuffet(executor({ perfis: 0 }), 'e'), { logoDataUrl: null, padrao: true });
  const semEstrutura = executor({ estrutura: false });
  assert.deepEqual(await marcaDoBuffet(semEstrutura, 'e'), { logoDataUrl: null, padrao: true });
  assert.equal((semEstrutura as unknown as { consultas: string[] }).consultas.length, 1);
});
