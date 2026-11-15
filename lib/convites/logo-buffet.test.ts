import assert from 'node:assert/strict';
import test from 'node:test';
import { bytesDaLogo, marcaDoBuffet, mostrarLogoBuffet, preservarLogoBuffet, semLogoBuffet } from './logo-buffet.ts';
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
  assert.equal(comandoSchema.safeParse({ acao: 'logo_buffet', mostrar: false }).success, true);
  assert.equal(comandoSchema.safeParse({ acao: 'logo_buffet' }).success, false);
  assert.equal(comandoSchema.safeParse({ acao: 'logo_buffet', mostrar: true, extra: 1 }).success, false);
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
