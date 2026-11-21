import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { conectarDescartavel, encerrarDescartavel } from '../comercial/postgres-descartavel.ts';
import { carregarModulo } from '../acessos/teste-carregador.ts';

/**
 * RENOVAÇÃO DA CREDENCIAL do WhatsApp (20/11/2026) no PostgreSQL DESCARTÁVEL (modelo "083" da receita;
 * scripts/regressao-v1-selecao.cjs). Só roda com o opt-in do cluster sintético. A Meta é dublada (validarMeta):
 * nenhuma chamada externa. Cobre: renovação feliz (só a credencial muda, revisão +1, status e identidade iguais,
 * auditoria sem token), conta/número divergente recusado ANTES da Meta, número comprovado divergente, empresa sem
 * conexão, Equipe e senha antiga, tentativa de conexão não renova e de renovação não conecta, conexão alterada no
 * meio, isolamento entre empresas e troca de token de 60 dias por um sem validade.
 */
const env = {
  ADMIN_AUTH_SECRET: `segredo-sintetico-de-teste-${'x'.repeat(24)}`,
  KIDMAIS_DEPLOY_ENV: 'staging',
  META_APP_ID: '123456789',
  META_APP_SECRET: 'segredo-sintetico-com-mais-de-16',
  META_GRAPH_API_VERSION: 'v24.0',
  META_EMBEDDED_SIGNUP_CONFIG_ID: '987654321',
  META_OAUTH_REDIRECT_URI: 'https://staging.example.invalid/admin/configuracoes/whatsapp',
  META_EMBEDDED_SIGNUP_OPTIONS_JSON: JSON.stringify({ response_type: 'code', override_default_response_type: true }),
  META_EMBEDDED_SIGNUP_EVENT_NAME: 'FINISH',
  META_EMBEDDED_SIGNUP_MESSAGE_ORIGINS: 'https://www.facebook.com',
  WHATSAPP_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  WHATSAPP_CREDENTIAL_KEY_VERSION: '1',
};
Object.assign(process.env, env);

type Fn = (...args: never[]) => Promise<never>;
type Mod = Record<string, Fn>;
let client: Client;
const cache = new Map<string, Record<string, unknown>>();
const carregar = (f: string) => carregarModulo(f, { 'db/postgres': { db: () => client, withTransaction } }, cache) as Mod;

async function withTransaction<T>(work: (tx: Client) => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    const r = await work(client);
    await client.query('COMMIT');
    return r;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

const sufixo = randomBytes(3).toString('hex');
const ctx = () => ({ requestId: randomUUID(), ip: null, userAgent: 'teste-renovacao' });
const ids: Record<string, string> = {};
let svc: { auth: Mod; senha: { criarHashSenha: (s: string) => Promise<string> }; wpp: Mod; credencial: Record<string, (...a: never[]) => unknown> };

type Validada = { businessId: string; phoneNumberId: string; accessToken: string; tokenType: string; scopes: string[]; expiresAt: Date | null; displayPhoneNumber: string; verifiedName: string };
type Pedido = { businessId?: string; wabaId: string; phoneNumberId?: string };
/** Meta dublada: comprova o negócio e o número pedidos, com o token e a validade escolhidos (nenhuma rede). */
const metaCom = (accessToken: string, expiresAt: Date | null, sobrepor: Partial<Validada> = {}) => {
  const chamadas: Pedido[] = [];
  const fn = async (input: Pedido): Promise<Validada> => {
    chamadas.push(input);
    const phoneNumberId = input.phoneNumberId ?? '0';
    return { businessId: input.businessId ?? '1001', phoneNumberId, accessToken, tokenType: 'bearer', expiresAt,
      scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'], displayPhoneNumber: '+55 11 90000-0000', verifiedName: `Buffet ${phoneNumberId}`, ...sobrepor };
  };
  return Object.assign(fn, { chamadas });
};

async function sessaoDe(usuarioId: string, opcoes: { empresaAtiva?: string; reautenticadoHaMin?: number } = {}) {
  const nova = await withTransaction((tx) => (svc.auth.criarSessaoAdministrativa as unknown as (tx: Client, u: string, ip: null, ua: null) => Promise<{ id: string; token: string }>)(tx, usuarioId, null, null));
  if (opcoes.empresaAtiva) await client.query('UPDATE sessoes_administrativas SET empresa_ativa_id = $2::uuid WHERE id = $1::uuid', [nova.id, opcoes.empresaAtiva]);
  if (opcoes.reautenticadoHaMin)
    await client.query('UPDATE sessoes_administrativas SET criado_em = clock_timestamp() - make_interval(mins => $2), autenticado_em = clock_timestamp() - make_interval(mins => $2) WHERE id = $1::uuid', [nova.id, opcoes.reautenticadoHaMin]);
  const sessao = await (svc.auth.consultarSessao as unknown as (t: string) => Promise<Record<string, string>>)(nova.token);
  return { id: nova.id, token: nova.token, sessao };
}
async function codigoErro(p: Promise<unknown>) {
  try { await p; return 'OK'; }
  catch (error) { return (error as { code?: string }).code ?? (error as Error).message; }
}
const um = async <T>(sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows[0] as T;
const conta = async (sql: string, params: unknown[] = []) => Number((await client.query<{ n: number }>(sql, params)).rows[0].n);

type Inicio = { tentativaId: string; state: string };
const iniciarConexao = (s: { token: string }) => (svc.wpp.iniciarOnboardingWhatsapp as unknown as (t: string, c: unknown) => Promise<Inicio>)(s.token, ctx());
const iniciarRenovacao = (s: { token: string }) => (svc.wpp.iniciarRenovacaoWhatsapp as unknown as (t: string, c: unknown) => Promise<Inicio>)(s.token, ctx());
const concluirConexao = (s: { token: string }, ini: Inicio, evento: Pedido, validarMeta: unknown) =>
  (svc.wpp.concluirOnboardingWhatsapp as unknown as (r: unknown, t: string, c: unknown, d: unknown) => Promise<{ conexaoId: string }>)(
    { tentativaId: ini.tentativaId, state: ini.state, authorizationCode: 'codigo-sintetico-renovacao', ...evento }, s.token, ctx(), { validarMeta });
const concluirRenovacao = (s: { token: string }, ini: Inicio, evento: Pedido, validarMeta: unknown) =>
  (svc.wpp.concluirRenovacaoWhatsapp as unknown as (r: unknown, t: string, c: unknown, d: unknown) => Promise<{ conexaoId: string; estado: string; tokenExpiraEm: string | null }>)(
    { tentativaId: ini.tentativaId, state: ini.state, authorizationCode: 'codigo-sintetico-renovacao', ...evento }, s.token, ctx(), { validarMeta });
/** Fluxo completo de renovação com o evento dado. */
async function renovar(s: { token: string }, evento: Pedido, validarMeta: unknown) {
  return concluirRenovacao(s, await iniciarRenovacao(s), evento, validarMeta);
}

type Linha = { id: string; ambiente: string; empresa_id: string; meta_app_id: string; business_id: string; waba_id: string; phone_number_id: string; status: string; revisao: number;
  token_tipo: string; token_expira_em: string | null; credencial_cifrada: Buffer; credencial_iv: Buffer; credencial_tag: Buffer; criada_em: string; numero_exibicao: string; nome_verificado: string };
const linha = (id: string) => um<Linha>('SELECT *, token_expira_em::text AS token_expira_em, criada_em::text AS criada_em FROM whatsapp_conexoes WHERE id = $1', [id]);
const decifrar = (l: Linha, empresaId = l.empresa_id) => (svc.credencial.decifrarCredencialWhatsapp as unknown as (i: unknown, m: unknown) => string)(
  { ciphertext: l.credencial_cifrada, iv: l.credencial_iv, tag: l.credencial_tag },
  { ambiente: l.ambiente, appId: l.meta_app_id, businessId: l.business_id, wabaId: l.waba_id, phoneNumberId: l.phone_number_id, empresaId });
const IDENTIDADE = ['id', 'ambiente', 'empresa_id', 'meta_app_id', 'business_id', 'waba_id', 'phone_number_id', 'status', 'criada_em', 'numero_exibicao', 'nome_verificado'] as const;
const identidade = (l: Linha) => IDENTIDADE.map((k) => l[k]);
const EVENTO_A: Pedido = { businessId: '1001', wabaId: '2002', phoneNumberId: '5001' };

test.before(async () => {
  client = await conectarDescartavel();
  svc = {
    auth: carregar('lib/autenticacao/service.ts'),
    senha: carregar('lib/autenticacao/senha.ts') as unknown as { criarHashSenha: (s: string) => Promise<string> },
    wpp: carregar('lib/whatsapp/onboarding.service.ts'),
    credencial: carregar('lib/whatsapp/credencial.ts') as unknown as Record<string, (...a: never[]) => unknown>,
  };
});

test.after(async () => {
  if (client) await encerrarDescartavel(client);
});

test('renovação: fixtures sintéticas — duas empresas, Gestão de cada uma e Equipe da A', async () => {
  const hash = await svc.senha.criarHashSenha('senha-sintetica-renovacao');
  for (const chave of ['gestaoA', 'equipeA', 'gestaoB'])
    ids[chave] = (await client.query<{ id: string }>("INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel) VALUES ($1, $2, $3, 'ADMINISTRATIVO') RETURNING id",
      [`wren-${chave.toLowerCase()}-${sufixo}@exemplo.test`, `Pessoa ${chave}`, hash])).rows[0].id;
  await client.query("UPDATE usuarios_administrativos SET senha_alterada_em = clock_timestamp() - interval '1 hour' WHERE id = ANY($1::uuid[])", [Object.values(ids)]);
  for (const chave of ['A', 'B']) {
    ids[`empresa${chave}`] = (await client.query<{ id: string }>("INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id", [`wren-${chave.toLowerCase()}-${sufixo}`, `Buffet renovação ${chave}`])).rows[0].id;
    await client.query("UPDATE empresas SET status = 'ATIVA' WHERE id = $1", [ids[`empresa${chave}`]]);
  }
  const vinculo = async (usuario: string, empresa: string, papel: string) => {
    const m = (await client.query<{ id: string }>("INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1, $2, 'PENDENTE', clock_timestamp(), $3) RETURNING id", [empresa, usuario, papel])).rows[0].id;
    await client.query("UPDATE memberships SET status = 'ATIVA' WHERE id = $1", [m]);
  };
  await vinculo(ids.gestaoA, ids.empresaA, 'REPRESENTANTE_AUTORIZADO');
  await vinculo(ids.equipeA, ids.empresaA, 'ADMINISTRATIVO');
  await vinculo(ids.gestaoB, ids.empresaB, 'REPRESENTANTE_AUTORIZADO');
});

test('renovação: empresa sem conexão é recusada sem criar tentativa', async () => {
  const antes = await conta('SELECT count(*)::int AS n FROM whatsapp_onboarding_tentativas');
  assert.equal(await codigoErro(iniciarRenovacao(await sessaoDe(ids.gestaoA))), 'WHATSAPP_NAO_CONFIGURADO');
  assert.equal(await conta('SELECT count(*)::int AS n FROM whatsapp_onboarding_tentativas'), antes);
});

const statusTentativa = async (id: string) => (await um<{ status: string }>('SELECT status FROM whatsapp_onboarding_tentativas WHERE id = $1', [id])).status;
const EVENTO_B: Pedido = { businessId: '3001', wabaId: '3002', phoneNumberId: '6001' };

test('renovação: a A conecta com token de 60 dias; uma tentativa de RENOVAÇÃO INICIADA não serve para conectar', async () => {
  const sA = await sessaoDe(ids.gestaoA);
  const vence = new Date(Date.now() + 60 * 86_400_000);
  ids.conexaoA = (await concluirConexao(sA, await iniciarConexao(sA), EVENTO_A, metaCom('token-sintetico-60-dias', vence))).conexaoId;
  const l = await linha(ids.conexaoA);
  assert.equal(decifrar(l), 'token-sintetico-60-dias');
  assert.ok(l.token_expira_em, 'a conexão antiga tem validade');
  // MESMA sessão e tentativa de renovação ainda INICIADA levada à conclusão NORMAL: recusada pelo marcador da
  // renovação, sem chamar a Meta e sem consumir a tentativa.
  const s = await sessaoDe(ids.gestaoA);
  const ini = await iniciarRenovacao(s);
  const meta = metaCom('token-sintetico-nunca-conecta', null);
  assert.equal(await codigoErro(concluirConexao(s, ini, EVENTO_A, meta)), 'WHATSAPP_TENTATIVA_INVALIDA');
  assert.equal(meta.chamadas.length, 0, 'a Meta não é chamada');
  assert.equal(await statusTentativa(ini.tentativaId), 'INICIADA', 'a tentativa não foi consumida');
  assert.equal(await conta('SELECT count(*)::int AS n FROM whatsapp_conexoes WHERE empresa_id = $1', [ids.empresaA]), 1, 'nenhuma conexão nova');
  assert.equal((await linha(ids.conexaoA)).revisao, l.revisao, 'a conexão da A não mudou');
  // A mesma tentativa continua concluível pela RENOVAÇÃO (mesmo token e validade, para os testes seguintes).
  const r = await concluirRenovacao(s, ini, EVENTO_A, metaCom('token-sintetico-60-dias', vence));
  assert.equal(r.tokenExpiraEm, vence.toISOString(), 'a validade sai em ISO 8601 UTC');
  const consulta = await (svc.wpp.consultarConfiguracaoWhatsapp as unknown as (s: unknown) => Promise<{ conexao: { tokenExpiraEm: string | null; metaValidadaEm: string } }>)((await sessaoDe(ids.gestaoA)).sessao);
  assert.equal(consulta.conexao.tokenExpiraEm, vence.toISOString(), 'a tela recebe a validade em ISO 8601 UTC');
  assert.match(consulta.conexao.metaValidadaEm, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(await statusTentativa(ini.tentativaId), 'CONCLUIDA');
  const depois = await linha(ids.conexaoA);
  assert.equal(depois.revisao, l.revisao + 1);
  assert.equal(decifrar(depois), 'token-sintetico-60-dias');
  assert.ok(depois.token_expira_em, 'a validade continua registrada');
});

test('renovação: uma tentativa de CONEXÃO INICIADA não renova (sem o marcador de renovação)', async () => {
  // A B ainda não tem conexão: a conexão normal inicia, e a tentativa é levada à conclusão da RENOVAÇÃO.
  const sB = await sessaoDe(ids.gestaoB);
  const ini = await iniciarConexao(sB);
  const meta = metaCom('token-sintetico-nunca-renova', null);
  assert.equal(await codigoErro(concluirRenovacao(sB, ini, EVENTO_B, meta)), 'WHATSAPP_TENTATIVA_INVALIDA');
  assert.equal(meta.chamadas.length, 0, 'a Meta não é chamada');
  assert.equal(await statusTentativa(ini.tentativaId), 'INICIADA', 'a tentativa não foi consumida');
  assert.equal(await conta('SELECT count(*)::int AS n FROM whatsapp_conexoes WHERE empresa_id = $1', [ids.empresaB]), 0, 'nenhuma conexão');
  // A mesma tentativa continua concluível pela CONEXÃO normal.
  ids.conexaoB = (await concluirConexao(sB, ini, EVENTO_B, metaCom('token-sintetico-b', null))).conexaoId;
  assert.equal(await statusTentativa(ini.tentativaId), 'CONCLUIDA');
  assert.equal(await codigoErro(iniciarConexao(await sessaoDe(ids.gestaoB))), 'WHATSAPP_JA_CONFIGURADO');
});

/** O prazo da tentativa é imutável pelo gatilho; o teste o move só no cluster descartável, sem gatilhos nesta instrução. */
async function moverPrazo(tentativaId: string, intervalo: string) {
  await client.query('SET session_replication_role = replica');
  try { await client.query('UPDATE whatsapp_onboarding_tentativas SET criada_em = criada_em + d, atualizada_em = atualizada_em + d, expira_em = expira_em + d FROM (SELECT clock_timestamp() + $2::interval - expira_em AS d FROM whatsapp_onboarding_tentativas WHERE id = $1) x WHERE id = $1', [tentativaId, intervalo]); }
  finally { await client.query('SET session_replication_role = origin'); }
}

test('renovação: tentativa da pessoa na A no prazo bloqueia a B com 409 sem tocá-la; vencida, a rotina do SISTEMA a fecha (lock da A, auditoria) e a B inicia; corrida A×B nunca dá 500', async () => {
  const hash = await svc.senha.criarHashSenha('senha-sintetica-renovacao');
  ids.gestaoAB = (await client.query<{ id: string }>("INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel) VALUES ($1, 'Pessoa das duas', $2, 'ADMINISTRATIVO') RETURNING id",
    [`wren-gestaoab-${sufixo}@exemplo.test`, hash])).rows[0].id;
  await client.query("UPDATE usuarios_administrativos SET senha_alterada_em = clock_timestamp() - interval '1 hour' WHERE id = $1", [ids.gestaoAB]);
  for (const empresa of [ids.empresaA, ids.empresaB]) {
    const m = (await client.query<{ id: string }>("INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1, $2, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO') RETURNING id", [empresa, ids.gestaoAB])).rows[0].id;
    await client.query("UPDATE memberships SET status = 'ATIVA' WHERE id = $1", [m]);
  }
  const expirar = (id: string) => client.query("UPDATE whatsapp_onboarding_tentativas SET status = 'EXPIRADA', consumida_em = clock_timestamp(), erro_codigo = 'TENTATIVA_EXPIRADA', atualizada_em = clock_timestamp() WHERE id = $1", [id]);
  const iniA = await iniciarRenovacao(await sessaoDe(ids.gestaoAB, { empresaAtiva: ids.empresaA }));
  const jsonTentativaA = async () => (await um<{ j: Record<string, unknown> }>('SELECT to_jsonb(t) AS j FROM whatsapp_onboarding_tentativas t WHERE id = $1', [iniA.tentativaId])).j;
  const totalTentativasB = async () => Number((await um<{ n: string }>('SELECT count(*) AS n FROM whatsapp_onboarding_tentativas WHERE empresa_id = $1', [ids.empresaB])).n);
  const auditoriaSistema = async (id: string) => (await client.query<{ ator_tipo: string; usuario_id: string | null; dados_antes: Record<string, unknown>; dados_depois: Record<string, unknown> }>(
    "SELECT ator_tipo, usuario_id, dados_antes, dados_depois FROM auditoria WHERE acao = 'WHATSAPP_TENTATIVA_EXPIRADA_SISTEMA' AND entidade_id = $1", [id])).rows;
  // No prazo: 409 (não erro do índice), a tentativa da A intacta e nada criado na B.
  await moverPrazo(iniA.tentativaId, '5 minutes');
  const antesA = await jsonTentativaA();
  const antesB = await totalTentativasB();
  assert.equal(await codigoErro(iniciarRenovacao(await sessaoDe(ids.gestaoAB, { empresaAtiva: ids.empresaB }))), 'WHATSAPP_TENTATIVA_CONCORRENTE', 'no prazo: 409');
  assert.deepEqual(await jsonTentativaA(), antesA, 'no prazo: a tentativa da A ficou intacta');
  assert.equal(await totalTentativasB(), antesB, 'no prazo: nada criado na B');
  assert.equal((await auditoriaSistema(iniA.tentativaId)).length, 0, 'no prazo: a rotina do sistema não fecha');
  // Vencida, sem ninguém da A agir (a Gestão da A nem entra): a rotina do sistema fecha só ela e a B inicia.
  await moverPrazo(iniA.tentativaId, '-1 minute');
  const vencidaA = await jsonTentativaA();
  const iniB = await iniciarRenovacao(await sessaoDe(ids.gestaoAB, { empresaAtiva: ids.empresaB }));
  const fechadaA = await jsonTentativaA();
  assert.deepEqual([fechadaA.status, fechadaA.erro_codigo], ['EXPIRADA', 'TENTATIVA_EXPIRADA']);
  const mudou = Object.keys(fechadaA).filter((k) => JSON.stringify(fechadaA[k]) !== JSON.stringify(vencidaA[k])).sort();
  assert.deepEqual(mudou, ['atualizada_em', 'consumida_em', 'erro_codigo', 'status'], 'só o fechamento; identidade e prazo intactos');
  const aud = await auditoriaSistema(iniA.tentativaId);
  assert.equal(aud.length, 1, 'uma auditoria do sistema');
  assert.deepEqual([aud[0].ator_tipo, aud[0].usuario_id, aud[0].dados_antes.status, aud[0].dados_depois.status, aud[0].dados_depois.empresaId], ['SISTEMA', null, 'INICIADA', 'EXPIRADA', ids.empresaA]);
  assert.equal(await statusTentativa(iniB.tentativaId), 'INICIADA', 'a B iniciou');
  await expirar(iniB.tentativaId);
  // Corrida: a mesma pessoa inicia na A e na B ao mesmo tempo (locks de empresas diferentes). Uma vence, a outra 409; nunca 500.
  for (let rodada = 0; rodada < 3; rodada++) {
    const [ra, rb] = await Promise.allSettled([
      iniciarRenovacao(await sessaoDe(ids.gestaoAB, { empresaAtiva: ids.empresaA })),
      iniciarRenovacao(await sessaoDe(ids.gestaoAB, { empresaAtiva: ids.empresaB })),
    ]);
    const resultados = [ra, rb];
    const ok = resultados.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ tentativaId: string }>[];
    const recusas = resultados.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    assert.equal(ok.length, 1, 'rodada ' + rodada + ': exatamente uma inicia');
    assert.equal((recusas[0].reason as { code?: string }).code, 'WHATSAPP_TENTATIVA_CONCORRENTE', 'rodada ' + rodada + ': a outra recebe 409');
    await expirar(ok[0].value.tentativaId);
  }
});

test('renovação: Equipe e senha antiga são recusadas antes de qualquer tentativa', async () => {
  const antes = await conta('SELECT count(*)::int AS n FROM whatsapp_onboarding_tentativas');
  assert.equal(await codigoErro(iniciarRenovacao(await sessaoDe(ids.equipeA))), 'WHATSAPP_AUTORIZACAO_RECUSADA');
  assert.equal(await codigoErro(iniciarRenovacao(await sessaoDe(ids.gestaoA, { reautenticadoHaMin: 10 }))), 'WHATSAPP_REAUTENTICACAO_NECESSARIA');
  assert.equal(await conta('SELECT count(*)::int AS n FROM whatsapp_onboarding_tentativas'), antes);
});

test('renovação: WABA, negócio ou número diferentes no evento são recusados ANTES de chamar a Meta', async () => {
  const antes = await linha(ids.conexaoA);
  for (const [evento, rotulo] of [[{ ...EVENTO_A, wabaId: '9999' }, 'waba'], [{ ...EVENTO_A, businessId: '9999' }, 'negócio'], [{ ...EVENTO_A, phoneNumberId: '9999' }, 'número']] as const) {
    const meta = metaCom('token-sintetico-nunca', null);
    const s = await sessaoDe(ids.gestaoA);
    const ini = await iniciarRenovacao(s);
    assert.equal(await codigoErro(concluirRenovacao(s, ini, evento, meta)), 'WHATSAPP_RENOVACAO_DIVERGENTE', rotulo);
    assert.equal(meta.chamadas.length, 0, `${rotulo}: a Meta não é chamada`);
    assert.equal((await um<{ status: string; erro_codigo: string }>('SELECT status, erro_codigo FROM whatsapp_onboarding_tentativas WHERE id = $1', [ini.tentativaId])).status, 'FALHOU');
  }
  const depois = await linha(ids.conexaoA);
  assert.equal(depois.revisao, antes.revisao);
  assert.equal(decifrar(depois), 'token-sintetico-60-dias');
});

test('renovação: número COMPROVADO pela Meta diferente do conectado é recusado e nada é gravado', async () => {
  const antes = await linha(ids.conexaoA);
  const meta = metaCom('token-sintetico-outro-numero', null, { phoneNumberId: '7777' });
  assert.equal(await codigoErro(renovar(await sessaoDe(ids.gestaoA), { wabaId: '2002' }, meta)), 'WHATSAPP_RENOVACAO_DIVERGENTE');
  assert.equal(meta.chamadas.length, 1);
  assert.equal(meta.chamadas[0].phoneNumberId, '5001', 'sem número no evento, a Meta é consultada pelo número conectado');
  const negocio = metaCom('token-sintetico-outro-negocio', null, { businessId: '8888' });
  assert.equal(await codigoErro(renovar(await sessaoDe(ids.gestaoA), { wabaId: '2002' }, negocio)), 'WHATSAPP_RENOVACAO_DIVERGENTE');
  const depois = await linha(ids.conexaoA);
  assert.equal(depois.revisao, antes.revisao);
  assert.equal(decifrar(depois), 'token-sintetico-60-dias');
});

/**
 * Meta-client REAL com fetch dublado: evento só com wabaId e dono da WABA (owner_business_info) diferente do negócio
 * conectado. A validação recebe o negócio CONECTADO e recusa antes da inscrição: nenhum POST a subscribed_apps.
 */
test('renovação: dono da WABA divergente com evento só de waba é recusado SEM nenhum POST à Meta', async () => {
  const mc = carregar('lib/whatsapp/meta-client.ts') as unknown as { trocarCodigoEValidarAtivos: (i: unknown, c: unknown, f: typeof fetch) => Promise<unknown> };
  const pedidos: { metodo: string; url: string }[] = [];
  const dubleMeta = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    pedidos.push({ metodo: (init?.method ?? 'GET').toUpperCase(), url });
    if (url.includes('/oauth/access_token')) return Response.json({ access_token: 'token-sintetico-dono-alheio', token_type: 'bearer' });
    if (url.includes('/debug_token')) return Response.json({ data: { is_valid: true, app_id: '123456789', scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
      granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: ['2002'] }] } });
    if (url.includes('fields=id,owner_business_info')) return Response.json({ id: '2002', owner_business_info: { id: '1999' } });
    if (url.includes('/subscribed_apps')) return Response.json({ success: true });
    return Response.json({ data: [{ id: '5001', display_phone_number: '+55 11 95001-0000', verified_name: 'Buffet 5001', is_on_biz_app: true }] });
  }) as typeof fetch;
  const validarMeta = (input: unknown, cfg: unknown) => mc.trocarCodigoEValidarAtivos(input, cfg, dubleMeta);
  const antes = await linha(ids.conexaoA);
  const s = await sessaoDe(ids.gestaoA);
  const ini = await iniciarRenovacao(s);
  assert.equal(await codigoErro(concluirRenovacao(s, ini, { wabaId: '2002' }, validarMeta)), 'META_WABA_DIVERGENTE');
  assert.ok(pedidos.some((p) => p.url.includes('fields=id,owner_business_info')), 'o dono da WABA foi consultado');
  assert.equal(pedidos.filter((p) => p.url.includes('/subscribed_apps')).length, 0, 'nenhuma chamada a subscribed_apps');
  assert.equal(pedidos.filter((p) => p.metodo !== 'GET').length, 0, 'nenhuma escrita na Meta');
  const t = await um<{ status: string; erro_codigo: string }>('SELECT status, erro_codigo FROM whatsapp_onboarding_tentativas WHERE id = $1', [ini.tentativaId]);
  assert.deepEqual([t.status, t.erro_codigo], ['FALHOU', 'META_WABA_DIVERGENTE']);
  const depois = await linha(ids.conexaoA);
  assert.deepEqual(identidade(depois), identidade(antes));
  assert.equal(depois.revisao, antes.revisao);
  assert.equal(decifrar(depois), 'token-sintetico-60-dias');
});

test('renovação: gestão autorizada para a WABA conectada, mas envio restrito a OUTRA → recusa sem POST e credencial anterior preservada', async () => {
  const mc = carregar('lib/whatsapp/meta-client.ts') as unknown as { trocarCodigoEValidarAtivos: (i: unknown, c: unknown, f: typeof fetch) => Promise<unknown> };
  const pedidos: { metodo: string; url: string }[] = [];
  const dubleMeta = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    pedidos.push({ metodo: (init?.method ?? 'GET').toUpperCase(), url });
    if (url.includes('/oauth/access_token')) return Response.json({ access_token: 'token-sintetico-envio-alheio', token_type: 'bearer' });
    if (url.includes('/debug_token')) return Response.json({ data: { is_valid: true, app_id: '123456789', scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
      granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: ['2002'] }, { scope: 'whatsapp_business_messaging', target_ids: ['9999'] }] } });
    if (url.includes('fields=id,owner_business_info')) return Response.json({ id: '2002', owner_business_info: { id: '1001' } });
    if (url.includes('/subscribed_apps')) return Response.json({ success: true });
    return Response.json({ data: [{ id: '5001', display_phone_number: '+55 11 95001-0000', verified_name: 'Buffet 5001', is_on_biz_app: true }] });
  }) as typeof fetch;
  const antes = await linha(ids.conexaoA);
  const s = await sessaoDe(ids.gestaoA);
  const ini = await iniciarRenovacao(s);
  assert.equal(await codigoErro(concluirRenovacao(s, ini, EVENTO_A, (input: unknown, cfg: unknown) => mc.trocarCodigoEValidarAtivos(input, cfg, dubleMeta))), 'META_ENVIO_NAO_AUTORIZADO');
  assert.equal(pedidos.filter((p) => p.url.includes('/subscribed_apps')).length, 0, 'nenhuma inscrição');
  assert.equal(pedidos.filter((p) => p.metodo !== 'GET').length, 0, 'nenhuma escrita na Meta');
  const tt = await um<{ status: string; erro_codigo: string }>('SELECT status, erro_codigo FROM whatsapp_onboarding_tentativas WHERE id = $1', [ini.tentativaId]);
  assert.deepEqual([tt.status, tt.erro_codigo], ['FALHOU', 'META_ENVIO_NAO_AUTORIZADO']);
  const depois = await linha(ids.conexaoA);
  assert.equal(depois.revisao, antes.revisao);
  assert.equal(decifrar(depois), 'token-sintetico-60-dias', 'a credencial anterior continua');
});

test('renovação: falha da Meta marca a tentativa FALHOU e não toca a conexão', async () => {
  const antes = await linha(ids.conexaoA);
  const s = await sessaoDe(ids.gestaoA);
  const ini = await iniciarRenovacao(s);
  const falha = async () => { throw new Error('rede sintética'); };
  assert.equal(await codigoErro(concluirRenovacao(s, ini, EVENTO_A, falha)), 'META_VALIDACAO_FALHOU');
  assert.equal((await um<{ status: string }>('SELECT status FROM whatsapp_onboarding_tentativas WHERE id = $1', [ini.tentativaId])).status, 'FALHOU');
  assert.equal((await linha(ids.conexaoA)).revisao, antes.revisao);
});

test('renovação feliz com o número na segunda página: só a credencial muda, com status e identidade iguais', async () => {
  const antes = await linha(ids.conexaoA);
  const jsonAntes = (await um<{ j: Record<string, unknown> }>('SELECT to_jsonb(c) AS j FROM whatsapp_conexoes c WHERE id = $1', [ids.conexaoA])).j;
  const s = await sessaoDe(ids.gestaoA);
  const ini = await iniciarRenovacao(s);
  const mc = carregar('lib/whatsapp/meta-client.ts') as unknown as { trocarCodigoEValidarAtivos: (i: unknown, c: unknown, f: typeof fetch) => Promise<unknown> };
  const paginas: (string | null)[] = [];
  const dubleMeta: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/oauth/access_token')) return Response.json({ access_token: 'token-sintetico-sem-validade', token_type: 'bearer' });
    if (url.pathname.endsWith('/debug_token')) return Response.json({ data: { is_valid: true, app_id: '123456789', scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
      granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: ['2002'] }] } });
    if (url.searchParams.has('fields') && url.pathname === '/v24.0/2002') return Response.json({ id: '2002', owner_business_info: { id: '1001' } });
    if (url.pathname === '/v24.0/2002/subscribed_apps') return Response.json({ success: true });
    assert.equal(url.pathname, '/v24.0/2002/phone_numbers');
    const cursor = url.searchParams.get('after');
    paginas.push(cursor);
    return cursor === 'segunda'
      ? Response.json({ data: [{ id: '5001', display_phone_number: '+55 11 95001-0000', verified_name: 'Buffet 5001', is_on_biz_app: true }] })
      : Response.json({ data: [{ id: '5999' }], paging: { next: 'pagina-seguinte', cursors: { after: 'segunda' } } });
  };
  const meta = (input: unknown, cfg: unknown) => mc.trocarCodigoEValidarAtivos(input, cfg, dubleMeta);
  const r = await concluirRenovacao(s, ini, { wabaId: '2002' }, meta);
  assert.deepEqual(paginas, [null, 'segunda']);
  assert.deepEqual([r.conexaoId, r.estado, r.tokenExpiraEm], [ids.conexaoA, 'CONFIGURADA_SEM_WEBHOOK_OTP', null]);
  const depois = await linha(ids.conexaoA);
  assert.deepEqual(identidade(depois), identidade(antes), 'identidade, número e status não mudam');
  // Contrato do UPDATE: só credencial (cifrada, iv, tag, versão), tipo, escopos, validade, meta_validada_em, revisao e atualizada_em.
  const jsonDepois = (await um<{ j: Record<string, unknown> }>('SELECT to_jsonb(c) AS j FROM whatsapp_conexoes c WHERE id = $1', [ids.conexaoA])).j;
  const permitidas = new Set(['credencial_cifrada', 'credencial_iv', 'credencial_tag', 'credencial_chave_versao', 'token_tipo', 'escopos', 'token_expira_em', 'meta_validada_em', 'revisao', 'atualizada_em']);
  const mudaram = Object.keys(jsonDepois).filter((k) => JSON.stringify(jsonDepois[k]) !== JSON.stringify(jsonAntes[k]));
  assert.deepEqual(mudaram.filter((k) => !permitidas.has(k)), [], 'nenhuma coluna fora do contrato mudou');
  for (const k of ['credencial_cifrada', 'credencial_iv', 'credencial_tag', 'token_expira_em', 'meta_validada_em', 'revisao', 'atualizada_em']) assert.ok(mudaram.includes(k), `${k} mudou`);
  assert.equal(depois.status, 'CONFIGURADA');
  assert.equal(depois.revisao, antes.revisao + 1);
  assert.equal(depois.token_expira_em, null, 'o vencimento antigo foi substituído');
  assert.equal(decifrar(depois), 'token-sintetico-sem-validade');
  assert.throws(() => decifrar(depois, ids.empresaB), /integridade/, 'a credencial nova continua presa à empresa');
  assert.equal(await conta("SELECT count(*)::int AS n FROM whatsapp_conexoes WHERE empresa_id = $1", [ids.empresaA]), 1, 'nenhuma conexão nova');
  const t = await um<{ status: string; conexao_id: string }>('SELECT status, conexao_id FROM whatsapp_onboarding_tentativas WHERE id = $1', [ini.tentativaId]);
  assert.deepEqual([t.status, t.conexao_id], ['CONCLUIDA', ids.conexaoA]);
  const aud = await um<{ dados_antes: Record<string, unknown>; dados_depois: Record<string, unknown> }>(
    "SELECT dados_antes, dados_depois FROM auditoria WHERE acao = 'WHATSAPP_CREDENCIAL_RENOVADA' AND entidade_id = $1 ORDER BY criado_em DESC LIMIT 1", [ids.conexaoA]);
  assert.equal(aud.dados_antes.revisao, antes.revisao);
  assert.ok(aud.dados_antes.tokenExpiraEm, 'a auditoria guarda a validade anterior');
  assert.deepEqual([aud.dados_depois.revisao, aud.dados_depois.tokenExpiraEm, aud.dados_depois.status, aud.dados_depois.empresaId], [antes.revisao + 1, null, 'CONFIGURADA', ids.empresaA]);
  const todasAuditorias = JSON.stringify((await client.query("SELECT dados_antes, dados_depois FROM auditoria WHERE acao LIKE 'WHATSAPP_%'")).rows);
  assert.doesNotMatch(todasAuditorias, /token-sintetico/, 'nenhuma auditoria guarda token');
  // A tentativa concluída não pode ser usada de novo.
  assert.equal(await codigoErro(concluirRenovacao(s, ini, { wabaId: '2002' }, metaCom('token-sintetico-replay', null))), 'WHATSAPP_TENTATIVA_CONSUMIDA');
  assert.equal(decifrar(await linha(ids.conexaoA)), 'token-sintetico-sem-validade');
});

test('renovação: conexão alterada no meio (renovada por outra via ou desconectada) recusa a conclusão', async () => {
  // 1) Revisão mudou entre o início e a conclusão.
  const s = await sessaoDe(ids.gestaoA);
  const ini = await iniciarRenovacao(s);
  await client.query("UPDATE whatsapp_conexoes SET nome_verificado = nome_verificado, revisao = revisao + 1, atualizada_em = clock_timestamp() WHERE id = $1", [ids.conexaoA]);
  const meta = metaCom('token-sintetico-corrida', null);
  assert.equal(await codigoErro(concluirRenovacao(s, ini, EVENTO_A, meta)), 'WHATSAPP_RENOVACAO_CONEXAO_ALTERADA');
  assert.equal(meta.chamadas.length, 0, 'recusada antes da Meta');
  // 2) Revisão muda DEPOIS da Meta (durante a validação): a segunda transação recusa e nada é gravado.
  const s2 = await sessaoDe(ids.gestaoA);
  const ini2 = await iniciarRenovacao(s2);
  const corrida = Object.assign(async (input: Pedido) => {
    await client.query("UPDATE whatsapp_conexoes SET revisao = revisao + 1, atualizada_em = clock_timestamp() WHERE id = $1", [ids.conexaoA]);
    return metaCom('token-sintetico-corrida-2', null)(input);
  }, {});
  const revisaoAntes = (await linha(ids.conexaoA)).revisao;
  assert.equal(await codigoErro(concluirRenovacao(s2, ini2, EVENTO_A, corrida)), 'WHATSAPP_RENOVACAO_CONEXAO_ALTERADA');
  const l = await linha(ids.conexaoA);
  assert.equal(l.revisao, revisaoAntes + 1, 'só o UPDATE da corrida');
  assert.equal(decifrar(l), 'token-sintetico-sem-validade');
  assert.equal((await um<{ status: string }>('SELECT status FROM whatsapp_onboarding_tentativas WHERE id = $1', [ini2.tentativaId])).status, 'FALHOU');
  // 3) Desconectada no meio: recusa e a conexão continua DESCONECTADA (a renovação nunca reconecta).
  const s3 = await sessaoDe(ids.gestaoB);
  const ini3 = await iniciarRenovacao(s3);
  await (svc.wpp.desconectarWhatsapp as unknown as (r: unknown, t: string, c: unknown) => Promise<unknown>)({ conexaoId: ids.conexaoB, motivo: 'Teste da renovação' }, (await sessaoDe(ids.gestaoB)).token, ctx());
  assert.equal(await codigoErro(concluirRenovacao(s3, ini3, EVENTO_B, metaCom('token-sintetico-z', null))), 'WHATSAPP_RENOVACAO_CONEXAO_ALTERADA');
  assert.equal((await linha(ids.conexaoB)).status, 'DESCONECTADA');
});

test('renovação: isolamento — a Gestão da B não renova a conexão da A, nem com a tentativa da A', async () => {
  const sA = await sessaoDe(ids.gestaoA);
  const iniA = await iniciarRenovacao(sA);
  const antes = await linha(ids.conexaoA);
  // A B não tem conexão CONFIGURADA (desconectada acima): não inicia.
  assert.equal(await codigoErro(iniciarRenovacao(await sessaoDe(ids.gestaoB))), 'WHATSAPP_NAO_CONFIGURADO');
  // As duas conclusões devem recusar a B enquanto outra conexão ainda mantém a linha da A travada.
  const sB = await sessaoDe(ids.gestaoB);
  const bloqueadora = await conectarDescartavel({ travar: false });
  const meta = metaCom('token-sintetico-b-na-a', null);
  try {
    await bloqueadora.query('BEGIN');
    await bloqueadora.query('SELECT id FROM whatsapp_onboarding_tentativas WHERE id=$1 FOR UPDATE', [iniA.tentativaId]);
    await client.query("SET lock_timeout = '2s'");
    for (const concluir of [concluirRenovacao, concluirConexao]) {
      assert.equal(await codigoErro(concluir(sB, iniA, EVENTO_A, meta)), 'WHATSAPP_TENTATIVA_INVALIDA',
        '403 com a linha alheia ainda travada; esperar por ela causaria 55P03');
    }
    assert.equal(meta.chamadas.length, 0);
  } finally {
    try { await client.query('RESET lock_timeout'); }
    finally { await encerrarDescartavel(bloqueadora, false); }
  }
  assert.equal((await linha(ids.conexaoA)).revisao, antes.revisao);
  assert.equal(decifrar(await linha(ids.conexaoA)), 'token-sintetico-sem-validade');
});

/** r6: conferência de uma conclusão sem resposta legível — fecha a vencida em andamento, sob o lock, só na empresa comprovada. */
const conferir = (s: { token: string }, tentativaId: unknown) =>
  (svc.wpp.conferirTentativaWhatsapp as unknown as (r: unknown, t: string, c: unknown) => Promise<{ tentativa: { id: string; status: string; expira_em: string } | null }>)(
    { tentativaId }, s.token, ctx());
const jsonTentativa = async (id: string) => (await um<{ j: Record<string, unknown> }>('SELECT to_jsonb(t) AS j FROM whatsapp_onboarding_tentativas t WHERE id = $1', [id])).j;
const auditoriasExpiradas = async (id: string) => (await client.query<{ ator_tipo: string; usuario_id: string | null; dados_antes: Record<string, unknown>; dados_depois: Record<string, unknown> }>(
  "SELECT ator_tipo, usuario_id, dados_antes, dados_depois FROM auditoria WHERE acao = 'WHATSAPP_TENTATIVA_EXPIRADA_SISTEMA' AND entidade_id = $1", [id])).rows;

test('conferência: no prazo só lê; mesmo sem segredo da Meta, fecha VALIDANDO vencida e mantém a credencial', async () => {
  const s = await sessaoDe(ids.gestaoA, { reautenticadoHaMin: 10 }); // conferir não exige senha recente
  const aberta = await um<{ id: string }>("SELECT id FROM whatsapp_onboarding_tentativas WHERE empresa_id = $1 AND usuario_id = $2 AND status = 'INICIADA'", [ids.empresaA, ids.gestaoA]);
  assert.ok(aberta?.id, 'tentativa da A em aberto (do teste anterior)');
  await moverPrazo(aberta.id, '5 minutes');
  const antes = await jsonTentativa(aberta.id);
  const r1 = await conferir(s, aberta.id);
  assert.deepEqual([r1.tentativa?.id, r1.tentativa?.status], [aberta.id, 'INICIADA']);
  assert.match(String(r1.tentativa?.expira_em), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(await jsonTentativa(aberta.id), antes, 'no prazo: nada escrito');
  assert.equal((await auditoriasExpiradas(aberta.id)).length, 0);
  // Processo caiu no meio da validação: VALIDANDO e depois o prazo passa. A conferência fecha.
  await client.query("UPDATE whatsapp_onboarding_tentativas SET status = 'VALIDANDO', consumida_em = clock_timestamp(), atualizada_em = clock_timestamp() WHERE id = $1", [aberta.id]);
  await moverPrazo(aberta.id, '-1 minute');
  const credencialAntes = decifrar(await linha(ids.conexaoA));
  const revisaoAntes = (await linha(ids.conexaoA)).revisao;
  const vencida = await jsonTentativa(aberta.id);
  // Ausência do segredo sintético de teste. O ambiente continua definido.
  delete process.env.META_APP_SECRET;
  try {
    const r2 = await conferir(s, aberta.id);
    assert.equal(r2.tentativa?.status, 'EXPIRADA');
  } finally {
    process.env.META_APP_SECRET = env.META_APP_SECRET;
  }
  const fechada = await jsonTentativa(aberta.id);
  const mudou = Object.keys(fechada).filter((k) => JSON.stringify(fechada[k]) !== JSON.stringify(vencida[k])).sort();
  assert.deepEqual(mudou, ['atualizada_em', 'erro_codigo', 'status'], 'só o fechamento (consumida_em já vinha do VALIDANDO)');
  const aud = await auditoriasExpiradas(aberta.id);
  assert.equal(aud.length, 1);
  assert.deepEqual([aud[0].ator_tipo, aud[0].usuario_id, aud[0].dados_antes.status, aud[0].dados_depois.status, aud[0].dados_depois.empresaId], ['SISTEMA', null, 'VALIDANDO', 'EXPIRADA', ids.empresaA]);
  assert.equal(decifrar(await linha(ids.conexaoA)), credencialAntes, 'a credencial anterior continua');
  assert.equal((await linha(ids.conexaoA)).revisao, revisaoAntes);
  // Segunda conferência: idempotente, sem nova auditoria.
  assert.equal((await conferir(s, aberta.id)).tentativa?.status, 'EXPIRADA');
  assert.equal((await auditoriasExpiradas(aberta.id)).length, 1);
});

test('conferência: outra empresa, id inexistente, Equipe e entrada inválida não escrevem; a dona fecha a INICIADA vencida', async () => {
  // Tentativas no prazo deixadas na A pelos testes anteriores bloqueariam o início (uma por empresa): fechadas aqui.
  await client.query("UPDATE whatsapp_onboarding_tentativas SET status = 'EXPIRADA', consumida_em = clock_timestamp(), erro_codigo = 'TENTATIVA_EXPIRADA', atualizada_em = clock_timestamp() WHERE empresa_id = $1 AND status IN ('INICIADA','VALIDANDO')", [ids.empresaA]);
  const sA = await sessaoDe(ids.gestaoA);
  const ini = await iniciarRenovacao(sA);
  await moverPrazo(ini.tentativaId, '-1 minute');
  const vencida = await jsonTentativa(ini.tentativaId);
  // Gestão da B com o id da A: nada a ver, nada escrito.
  assert.deepEqual(await conferir(await sessaoDe(ids.gestaoB), ini.tentativaId), { tentativa: null });
  assert.deepEqual(await conferir(await sessaoDe(ids.gestaoA), randomUUID()), { tentativa: null });
  assert.equal(await codigoErro(conferir(await sessaoDe(ids.equipeA), ini.tentativaId)), 'WHATSAPP_AUTORIZACAO_RECUSADA');
  assert.equal(await codigoErro(conferir(sA, 'nao-e-uuid')), 'WHATSAPP_DADOS_INVALIDOS');
  assert.deepEqual(await jsonTentativa(ini.tentativaId), vencida, 'nenhuma escrita pelos de fora');
  assert.equal((await auditoriasExpiradas(ini.tentativaId)).length, 0);
  const r = await conferir(await sessaoDe(ids.gestaoA), ini.tentativaId);
  assert.equal(r.tentativa?.status, 'EXPIRADA');
  const aud = await auditoriasExpiradas(ini.tentativaId);
  assert.deepEqual([aud.length, aud[0].dados_antes.status], [1, 'INICIADA']);
  // A conclusão que chegasse depois é recusada e a credencial não muda.
  const antes = decifrar(await linha(ids.conexaoA));
  assert.notEqual(await codigoErro(concluirRenovacao(sA, ini, EVENTO_A, metaCom('token-sintetico-tardio', null))), 'OK');
  assert.equal(decifrar(await linha(ids.conexaoA)), antes);
});

const auditoriasSubstituidas = async (id: string) => (await client.query<{ ator_tipo: string; usuario_id: string | null; dados_antes: Record<string, unknown>; dados_depois: Record<string, unknown> }>(
  "SELECT ator_tipo, usuario_id, dados_antes, dados_depois FROM auditoria WHERE acao = 'WHATSAPP_TENTATIVA_SUBSTITUIDA' AND entidade_id = $1", [id])).rows;

test('r7: a preparação nova da MESMA pessoa na MESMA empresa substitui a INICIADA dela (auditoria USUARIO); VALIDANDO e a de outra pessoa seguem no 409', async () => {
  await client.query("UPDATE whatsapp_onboarding_tentativas SET status = 'EXPIRADA', consumida_em = clock_timestamp(), erro_codigo = 'TENTATIVA_EXPIRADA', atualizada_em = clock_timestamp() WHERE empresa_id = $1 AND status IN ('INICIADA','VALIDANDO')", [ids.empresaA]);
  const s1 = await sessaoDe(ids.gestaoA);
  const ini1 = await iniciarRenovacao(s1);
  const antes = await jsonTentativa(ini1.tentativaId);
  // Senha confirmada de novo (sessão nova, como na tela depois da senha vencer): a preparação nova substitui a anterior.
  const s2 = await sessaoDe(ids.gestaoA);
  const ini2 = await iniciarRenovacao(s2);
  assert.notEqual(ini2.tentativaId, ini1.tentativaId);
  const velha = await jsonTentativa(ini1.tentativaId);
  assert.deepEqual([velha.status, velha.erro_codigo], ['EXPIRADA', 'TENTATIVA_SUBSTITUIDA']);
  const mudou = Object.keys(velha).filter((k) => JSON.stringify(velha[k]) !== JSON.stringify(antes[k])).sort();
  assert.deepEqual(mudou, ['atualizada_em', 'consumida_em', 'erro_codigo', 'status'], 'só o fechamento; identidade e prazo intactos');
  const aud = await auditoriasSubstituidas(ini1.tentativaId);
  assert.equal(aud.length, 1, 'uma auditoria da substituição');
  assert.deepEqual([aud[0].ator_tipo, aud[0].usuario_id, aud[0].dados_antes.status, aud[0].dados_depois.status, aud[0].dados_depois.erroCodigo, aud[0].dados_depois.empresaId],
    ['USUARIO', ids.gestaoA, 'INICIADA', 'EXPIRADA', 'TENTATIVA_SUBSTITUIDA', ids.empresaA]);
  // A substituída não conclui (nem pela sessão antiga, nem pela nova) e a Meta não é chamada.
  const credencial = decifrar(await linha(ids.conexaoA));
  const meta = metaCom('token-sintetico-substituida', null);
  assert.equal(await codigoErro(concluirRenovacao(s1, ini1, EVENTO_A, meta)), 'WHATSAPP_TENTATIVA_CONSUMIDA');
  assert.equal(await codigoErro(concluirRenovacao(s2, ini1, EVENTO_A, meta)), 'WHATSAPP_TENTATIVA_INVALIDA');
  assert.equal(meta.chamadas.length, 0);
  assert.equal(decifrar(await linha(ids.conexaoA)), credencial);
  assert.equal(await statusTentativa(ini2.tentativaId), 'INICIADA', 'a nova segue aberta');
  // VALIDANDO (pedido em andamento) nunca é substituída: 409 e nada muda.
  await client.query("UPDATE whatsapp_onboarding_tentativas SET status = 'VALIDANDO', consumida_em = clock_timestamp(), atualizada_em = clock_timestamp() WHERE id = $1", [ini2.tentativaId]);
  const validando = await jsonTentativa(ini2.tentativaId);
  assert.equal(await codigoErro(iniciarRenovacao(await sessaoDe(ids.gestaoA))), 'WHATSAPP_TENTATIVA_CONCORRENTE');
  assert.deepEqual(await jsonTentativa(ini2.tentativaId), validando, 'VALIDANDO intacta');
  assert.equal((await auditoriasSubstituidas(ini2.tentativaId)).length, 0);
  await client.query("UPDATE whatsapp_onboarding_tentativas SET status = 'EXPIRADA', erro_codigo = 'TENTATIVA_EXPIRADA', atualizada_em = clock_timestamp() WHERE id = $1", [ini2.tentativaId]);
  // Tentativa de OUTRA pessoa na mesma empresa: 409 e intacta.
  const outra = await iniciarRenovacao(await sessaoDe(ids.gestaoAB, { empresaAtiva: ids.empresaA }));
  const daOutra = await jsonTentativa(outra.tentativaId);
  assert.equal(await codigoErro(iniciarRenovacao(await sessaoDe(ids.gestaoA))), 'WHATSAPP_TENTATIVA_CONCORRENTE');
  assert.deepEqual(await jsonTentativa(outra.tentativaId), daOutra, 'a da outra pessoa ficou intacta');
  assert.equal((await auditoriasSubstituidas(outra.tentativaId)).length, 0);
  await client.query("UPDATE whatsapp_onboarding_tentativas SET status = 'EXPIRADA', consumida_em = clock_timestamp(), erro_codigo = 'TENTATIVA_EXPIRADA', atualizada_em = clock_timestamp() WHERE id = $1", [outra.tentativaId]);
});

test('r7: a substituição vale também para a conexão normal (empresa sem conexão ativa)', async () => {
  // A B foi desconectada acima: a Gestão da B pode preparar uma conexão nova; a segunda preparação substitui a primeira.
  const c1 = await iniciarConexao(await sessaoDe(ids.gestaoB));
  const c2 = await iniciarConexao(await sessaoDe(ids.gestaoB));
  const velha = await jsonTentativa(c1.tentativaId);
  assert.deepEqual([velha.status, velha.erro_codigo], ['EXPIRADA', 'TENTATIVA_SUBSTITUIDA']);
  assert.equal((await auditoriasSubstituidas(c1.tentativaId)).length, 1);
  assert.equal(await statusTentativa(c2.tentativaId), 'INICIADA');
  await client.query("UPDATE whatsapp_onboarding_tentativas SET status = 'EXPIRADA', consumida_em = clock_timestamp(), erro_codigo = 'TENTATIVA_EXPIRADA', atualizada_em = clock_timestamp() WHERE id = $1", [c2.tentativaId]);
});
