import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { carregarModulo } from '../acessos/teste-carregador.ts';

const EMPRESA_A = '11111111-1111-4111-8111-111111111111';
const EMPRESA_B = '22222222-2222-4222-8222-222222222222';

function rotas(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => { const p = path.join(dir, n); return statSync(p).isDirectory() ? rotas(p) : n === 'route.ts' ? [p.replace(/\\/g, '/')] : []; });
}

test('cobertura: toda API administrativa de Marketing passa pela guarda; plano e capacidade exceto origem manual (básico do CRM)', () => {
  const lista = rotas('app/api/admin/marketing');
  assert.ok(lista.length >= 9, String(lista.length));
  const basicas = ['app/api/admin/marketing/atribuicoes/route.ts', 'app/api/admin/marketing/origens/route.ts'];
  for (const r of lista) {
    const f = readFileSync(r, 'utf8');
    assert.ok(f.includes('exigirApiAdminCrmDisponivel'), `${r}: guarda administrativa`);
    assert.ok(!/empresaId\s*:\s*(corpo|input|acao)\./.test(f), `${r}: empresa nunca vem do corpo`);
    if (basicas.includes(r)) { assert.match(f, /plano: false/, r); continue; }
    assert.ok(!/plano: false/.test(f), `${r}: Marketing exige o plano`);
    assert.ok(/rotaMarketing\(/.test(f) || /exigirRecursoPlano\(tx, tenant\.empresaComprovada, "MARKETING"\)/.test(f), `${r}: plano MARKETING`);
    assert.ok(/MARKETING_(VISUALIZAR|CAMPANHAS_EDITAR|SITE_EDITAR|SITE_PUBLICAR|DOMINIO_CONFIGURAR|AUTOMACOES_GERIR)|exigirGestaoNoTenant/.test(f), `${r}: capacidade ou Gestão`);
  }
  // Contato captado (dado do Marketing) não fica aberto pela rota básica de origem.
  assert.match(readFileSync('app/api/admin/marketing/atribuicoes/route.ts', 'utf8'), /if \(alvoTipo !== "CONTATO"\) return;/);
});

type Resposta = { status: number; json(): Promise<{ ok: boolean; codigo?: string; data?: unknown }> };
type ModHttp = { rotaMarketing(request: unknown, guarda: unknown, opcoes: unknown, work: (ctx: { tenant: { empresaComprovada: string } }) => Promise<unknown>): Promise<Resposta> };

function carregarHttp(cenario: { papel: string; concessoes?: string[]; plano?: boolean; erroSql?: { code: string; message: string } }) {
  const tenant = { empresaComprovada: EMPRESA_A, membershipId: 'm-1', usuarioId: 'u-1', papelAtual: cenario.papel };
  const tx = { async query(sql: string) {
    if (cenario.erroSql) throw Object.assign(new Error(cenario.erroSql.message), { code: cenario.erroSql.code });
    if (/FROM marketing_membership_capacidades/.test(sql)) return { rows: (cenario.concessoes ?? []).map((capacidade) => ({ capacidade })), rowCount: 0 };
    return { rows: [], rowCount: 0 };
  } };
  return carregarModulo('lib/marketing/http.ts', {
    'db/postgres': { db: () => tx, withTransaction: async (w: (t: unknown) => unknown) => w(tx) },
    'saas/provar-tenant': { withTenantTransaction: async (_s: unknown, _e: unknown, w: (t: unknown, te: unknown) => unknown) => w(tx, tenant) },
    'assinatura/recursos-plano': { exigirRecursoPlano: async () => { if (cenario.plano === false) throw Object.assign(new Error('Fora do plano'), { name: 'ClienteServiceError', code: 'RECURSO_FORA_DO_PLANO', httpStatus: 403, details: {} }); } },
    'clientes/services': { isClienteServiceError: (e: { name?: string }) => e?.name === 'ClienteServiceError' },
  }) as unknown as ModHttp;
}
const guarda = async () => ({ id: 's', usuario_id: 'u-1', empresa_ativa_id: EMPRESA_A });

test('permissões: Equipe sem concessão recebe 403; concessão de visualizar libera leitura e não libera edição; Gestão tem tudo', async () => {
  const semConcessao = await carregarHttp({ papel: 'ADMINISTRATIVO' }).rotaMarketing({}, guarda, { capacidade: 'MARKETING_VISUALIZAR' }, async () => 'dados');
  assert.equal(semConcessao.status, 403);
  assert.equal((await semConcessao.json()).codigo, 'MARKETING_SEM_PERMISSAO');
  const leitura = carregarHttp({ papel: 'ADMINISTRATIVO', concessoes: ['MARKETING_VISUALIZAR'] });
  assert.equal((await leitura.rotaMarketing({}, guarda, { capacidade: 'MARKETING_VISUALIZAR' }, async () => 'ok')).status, 200);
  assert.equal((await leitura.rotaMarketing({}, guarda, { capacidade: 'MARKETING_SITE_PUBLICAR' }, async () => 'ok')).status, 403);
  const editor = carregarHttp({ papel: 'ADMINISTRATIVO', concessoes: ['MARKETING_CAMPANHAS_EDITAR'] });
  assert.equal((await editor.rotaMarketing({}, guarda, { capacidade: 'MARKETING_VISUALIZAR' }, async () => 'ok')).status, 200, 'edição inclui ver');
  const gestao = carregarHttp({ papel: 'REPRESENTANTE_AUTORIZADO' });
  const r = await gestao.rotaMarketing({}, guarda, { capacidade: 'MARKETING_DOMINIO_CONFIGURAR' }, async ({ tenant }) => tenant.empresaComprovada);
  assert.deepEqual(await r.json(), { ok: true, data: EMPRESA_A }, 'empresa é sempre a comprovada pela sessão');
});

test('plano sem Marketing: 403 do plano antes de qualquer leitura; schema ausente: 503 sem detalhe interno', async () => {
  let leu = false;
  const fora = await carregarHttp({ papel: 'REPRESENTANTE_AUTORIZADO', plano: false }).rotaMarketing({}, guarda, { capacidade: 'MARKETING_VISUALIZAR' }, async () => { leu = true; });
  assert.equal(fora.status, 403);
  assert.equal(leu, false);
  const semSchema = await carregarHttp({ papel: 'ADMINISTRATIVO', erroSql: { code: '42P01', message: 'relation "marketing_membership_capacidades" does not exist' } })
    .rotaMarketing({}, guarda, { capacidade: 'MARKETING_VISUALIZAR' }, async () => 'x');
  assert.equal(semSchema.status, 503);
  assert.equal((await semSchema.json()).codigo, 'MARKETING_INDISPONIVEL');
});

type ModDominio = { executarAcaoDominio(tx: unknown, empresa: string, usuario: string, acao: unknown, provedor: unknown, env: unknown): Promise<{ status?: string; ids?: string[] }> };
const dominios = carregarModulo('lib/marketing/dominios/servico.ts', {}) as unknown as ModDominio;
const ENV = { ADMIN_AUTH_ORIGIN: 'https://manager.exemplo.com.br' };

function txDominio(opcoes: { hostEmUso?: boolean; status?: string; empresaDoDominio?: string } = {}) {
  const sqls: Array<{ sql: string; p: unknown[] }> = [];
  return { sqls, async query(sql: string, p: unknown[] = []) {
    sqls.push({ sql, p });
    if (/FROM marketing_sites WHERE id/.test(sql)) return { rows: p[1] === EMPRESA_A ? [{ id: p[0] }] : [], rowCount: 0 };
    if (/count\(\*\)::text AS n FROM marketing_dominios/.test(sql)) return { rows: [{ n: '0' }], rowCount: 1 };
    if (/INSERT INTO marketing_dominios/.test(sql)) {
      if (opcoes.hostEmUso) throw Object.assign(new Error('duplicate'), { code: '23505', constraint: 'marketing_dominios_host_uk' });
      return { rows: [{ id: 'd-1' }], rowCount: 1 };
    }
    if (/FROM marketing_dominios WHERE id = \$1::uuid AND empresa_id = \$2::uuid FOR UPDATE/.test(sql)) {
      return p[1] === (opcoes.empresaDoDominio ?? EMPRESA_A) ? { rows: [{ id: p[0], site_id: 's-1', host: 'festas.alegria.com.br', principal: true, status: opcoes.status ?? 'PENDENTE_DNS',
        simulado: true, provedor: 'SIMULADO', token_verificacao: 'a'.repeat(32), verificado_em: null, ativado_em: null, removido_em: null, ultima_verificacao: {} }] } : { rows: [] };
    }
    return { rows: [], rowCount: 0 };
  } };
}
const provedor = (ok: boolean) => ({ nome: 'SIMULADO', simulado: true, verificar: async () => ({ ok, txt: ok, apontamento: ok, detalhe: ok ? 'ok' : 'TXT ausente', simulado: true, verificadoEm: 'agora' }),
  provisionar: async () => ({ ok: true, detalhe: 'simulado' }), liberar: async () => undefined });

test('domínio: host inválido, reservado ou já vinculado a outra empresa recebem recusa genérica', async () => {
  await assert.rejects(dominios.executarAcaoDominio(txDominio(), EMPRESA_A, 'u', { acao: 'solicitar', siteId: 's-1', host: 'não é host' }, provedor(true), ENV), { code: 'MARKETING_DOMINIO_INVALIDO' });
  await assert.rejects(dominios.executarAcaoDominio(txDominio(), EMPRESA_A, 'u', { acao: 'solicitar', siteId: 's-1', host: 'x.manager.exemplo.com.br' }, provedor(true), ENV), { code: 'MARKETING_DOMINIO_INDISPONIVEL' });
  await assert.rejects(dominios.executarAcaoDominio(txDominio({ hostEmUso: true }), EMPRESA_A, 'u', { acao: 'solicitar', siteId: 's-1', host: 'https://Festas.Alegria.com.br/promo' }, provedor(true), ENV),
    (e: { code: string; message: string }) => e.code === 'MARKETING_DOMINIO_INDISPONIVEL' && !/empresa|outra|alegria/i.test(e.message));
  const ok = await dominios.executarAcaoDominio(txDominio(), EMPRESA_A, 'u', { acao: 'solicitar', siteId: 's-1', host: 'alegria.com.br', incluirWww: true }, provedor(true), ENV);
  assert.equal(ok.ids?.length, 2, 'raiz + www');
});

test('domínio: verificação simulada ativa só com DNS conferido; falha fica visível; ação de outra empresa = 404', async () => {
  const tx1 = txDominio();
  assert.equal((await dominios.executarAcaoDominio(tx1, EMPRESA_A, 'u', { acao: 'verificar', id: 'd-1' }, provedor(false), ENV)).status, 'FALHOU');
  const tx2 = txDominio();
  assert.equal((await dominios.executarAcaoDominio(tx2, EMPRESA_A, 'u', { acao: 'verificar', id: 'd-1' }, provedor(true), ENV)).status, 'ATIVO');
  await assert.rejects(dominios.executarAcaoDominio(txDominio(), EMPRESA_B, 'u', { acao: 'remover', id: 'd-1' }, provedor(true), ENV), { code: 'MARKETING_NAO_ENCONTRADO' });
  await assert.rejects(dominios.executarAcaoDominio(txDominio({ status: 'REMOVIDO' }), EMPRESA_A, 'u', { acao: 'verificar', id: 'd-1' }, provedor(true), ENV), { code: 'MARKETING_DOMINIO_REMOVIDO' });
});

type ModContato = { POST(request: unknown, ctx: { params: Promise<{ slug: string }> }): Promise<Resposta> };
function rotaContato(site: unknown, gravacoes: unknown[]) {
  return carregarModulo('app/api/publico/marketing/[slug]/contato/route.ts', {
    'db/postgres': { db: () => ({}), withTransaction: async (w: (t: unknown) => unknown) => { gravacoes.push('tx'); return w({}); } },
    'marketing/site/publico': { sitePublicoPorSlug: async () => site },
    'marketing/contatos': { ...carregarModulo('lib/marketing/contatos.ts', { 'db/postgres': { db: () => ({}) } }), capturarContatoPublico: async () => { gravacoes.push('contato'); return { contatoId: 'c', repetido: false }; } },
  }) as unknown as ModContato;
}
function pedido(corpo: unknown, headers: Record<string, string> = {}) {
  const h = new Headers({ host: 'localhost:3000', ...headers });
  return { headers: h, async text() { return JSON.stringify(corpo); } };
}
const SITE = { siteId: 's', empresaId: EMPRESA_A, estabelecimentoId: null, conteudo: { formulario: { ativo: true } } };
const params = { params: Promise.resolve({ slug: 'alegria' }) };

test('formulário público: resposta igual para robô (honeypot) e pedido real; site inexistente 404; origem cruzada 403; dados inválidos 400', async () => {
  const valido = { nome: 'Ana', telefone: '11999990000', chave: 'k'.repeat(20) };
  const g1: unknown[] = [];
  const real = await rotaContato(SITE, g1).POST(pedido(valido), params);
  const g2: unknown[] = [];
  const robo = await rotaContato(SITE, g2).POST(pedido({ ...valido, website: 'http://spam' }), params);
  assert.equal(real.status, 202);
  assert.equal(robo.status, 202);
  assert.deepEqual(await robo.json(), await real.json());
  assert.deepEqual(g1, ['tx', 'contato']);
  assert.deepEqual(g2, [], 'robô não grava nada');
  assert.equal((await rotaContato(null, []).POST(pedido(valido), params)).status, 404);
  assert.equal((await rotaContato({ ...SITE, conteudo: { formulario: { ativo: false } } }, []).POST(pedido(valido), params)).status, 404);
  assert.equal((await rotaContato(SITE, []).POST(pedido(valido, { origin: 'https://atacante.example' }), params)).status, 403);
  const invalido = await rotaContato(SITE, []).POST(pedido({ nome: 'A', chave: 'x' }), params);
  assert.equal(invalido.status, 400);
});

type ModRotasPublicas = { viaDominioConfirmada(host: string, cabecalhos: Headers): { tipo: string; host: string } | null };
const rotasPublicas = carregarModulo('lib/marketing/site/rotas-publicas.ts', { 'db/postgres': { db: () => { throw new Error('sem banco'); } } }) as unknown as ModRotasPublicas;

test('domínio: /sd/<host> só vale com o mesmo Host recebido (reescrita do proxy); outro Host, IP ou caminho malformado = null', () => {
  const via = (param: string, cabecalhos: Record<string, string>) => rotasPublicas.viaDominioConfirmada(param, new Headers(cabecalhos));
  assert.deepEqual(via('festas.alegria.com.br', { host: 'Festas.Alegria.com.br:443' }), { tipo: 'DOMINIO', host: 'festas.alegria.com.br' });
  assert.deepEqual(via('festas.alegria.com.br', { host: 'localhost:3000', 'x-forwarded-host': 'festas.alegria.com.br' }), { tipo: 'DOMINIO', host: 'festas.alegria.com.br' }, 'dev: Host interno sem ponto');
  assert.equal(via('festas.alegria.com.br', { host: 'outro.com.br' }), null);
  assert.equal(via('festas.alegria.com.br', { host: 'outro.com.br', 'x-forwarded-host': 'festas.alegria.com.br' }), null, 'Host válido manda');
  assert.equal(via('festas.alegria.com.br', { host: '127.0.0.1:3000' }), null);
  assert.equal(via('%E0%A4%A', { host: 'festas.alegria.com.br' }), null);
  assert.equal(via('festas.alegria.com.br', {}), null);
});
