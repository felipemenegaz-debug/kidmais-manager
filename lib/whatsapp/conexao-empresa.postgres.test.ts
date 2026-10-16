import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Client } from 'pg';
import { conectarDescartavel, encerrarDescartavel } from '../comercial/postgres-descartavel.ts';
import { carregarModulo } from '../acessos/teste-carregador.ts';

/**
 * WhatsApp POR EMPRESA (083) no PostgreSQL DESCARTÁVEL (modelo "083" da receita; scripts/regressao-v1-selecao.cjs).
 * Só roda com o opt-in do cluster sintético. A Meta é dublada (validarMeta): nenhuma chamada externa.
 * Cobre: rollback/reaplicação com conexão antiga da plataforma preservada, conexão pela Gestão da empresa comprovada,
 * isolamento entre empresas, mesmo número em duas empresas, Equipe e senha antiga recusadas, troca de empresa no meio
 * do fluxo, desconexão (só na própria empresa) e nova conexão depois dela, credencial presa à empresa.
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
const ctx = () => ({ requestId: randomUUID(), ip: null, userAgent: 'teste-083' });
const ids: Record<string, string> = {};
let svc: { auth: Mod; senha: { criarHashSenha: (s: string) => Promise<string> }; wpp: Mod; credencial: Record<string, (...a: never[]) => unknown> };

/** Meta dublada: devolve o número pedido como validado (nenhuma rede). */
const metaOk = async (input: { phoneNumberId: string }) => ({
  accessToken: `token-sintetico-${input.phoneNumberId}`, tokenType: 'bearer', scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
  expiresAt: null, displayPhoneNumber: `+55 11 9${input.phoneNumberId.slice(-4).padStart(4, '0')}-0000`, verifiedName: `Buffet ${input.phoneNumberId}`,
});

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

/** Fluxo completo da Gestão: iniciar → (Meta) → concluir com o número pedido. */
async function conectar(s: { token: string }, phoneNumberId: string, validarMeta = metaOk) {
  const ini = await (svc.wpp.iniciarOnboardingWhatsapp as unknown as (t: string, c: unknown) => Promise<{ tentativaId: string; state: string }>)(s.token, ctx());
  return (svc.wpp.concluirOnboardingWhatsapp as unknown as (r: unknown, t: string, c: unknown, d: unknown) => Promise<{ conexaoId: string }>)(
    { tentativaId: ini.tentativaId, state: ini.state, authorizationCode: 'codigo-sintetico-083', businessId: '1001', wabaId: '2002', phoneNumberId }, s.token, ctx(), { validarMeta });
}
const consultar = (s: { sessao: unknown }) => (svc.wpp.consultarConfiguracaoWhatsapp as unknown as (s: unknown) => Promise<{ estado: string; empresa: string | null; conexao: null | { id: string; phoneNumberId: string } }>)(s.sessao);
const desconectar = (s: { token: string }, conexaoId: string, motivo = 'Troca de número da empresa') =>
  (svc.wpp.desconectarWhatsapp as unknown as (r: unknown, t: string, c: unknown) => Promise<{ estado: string }>)({ conexaoId, motivo }, s.token, ctx());

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

test('083: rollback em banco sem conexão de empresa, conexão antiga da plataforma preservada e reaplicação com postcheck limpo', async () => {
  const down = readFileSync('database/rollback/20261016_083_whatsapp_conexao_empresa_down.sql', 'utf8');
  const up = readFileSync('database/migrations/20261016_083_whatsapp_conexao_empresa.sql', 'utf8');
  await client.query(down);
  assert.equal(await conta("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'whatsapp_conexoes' AND column_name = 'empresa_id'"), 0);
  // Código novo no banco ainda sem a 083 (deploy antes do aplicador): 503 claro, nenhum erro de SQL.
  const core = carregar('lib/whatsapp/onboarding-core.ts') as unknown as { exigirEsquemaPorEmpresa: (tx: Client) => Promise<void> };
  assert.equal(await codigoErro(core.exigirEsquemaPorEmpresa(client)), 'WHATSAPP_ATUALIZACAO_PENDENTE');
  // Estado da 018: uma conexão da plataforma (sem empresa), como poderia existir em staging.
  const operador = (await client.query<{ id: string }>("INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel) VALUES ($1, 'Operador 083', $2, 'REPRESENTANTE_AUTORIZADO') RETURNING id",
    [`op083-${sufixo}@exemplo.test`, await svc.senha.criarHashSenha('senha-operador-083')])).rows[0].id;
  ids.legada = (await client.query<{ id: string }>(`INSERT INTO whatsapp_conexoes (ambiente, meta_app_id, business_id, waba_id, phone_number_id, numero_exibicao, nome_verificado, coexistencia_confirmada,
      status, escopos, credencial_cifrada, credencial_iv, credencial_tag, credencial_chave_versao, token_tipo, meta_validada_em, criada_por_usuario_id, sessao_referencia_id, criada_em, atualizada_em)
    VALUES ('STAGING', '123456789', '9001', '9002', '9003', '+55 11 90000-0000', 'Kidmais', true, 'CONFIGURADA', ARRAY['whatsapp_business_management'], '\\x01'::bytea,
      decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'), 1, 'bearer', now(), $1, gen_random_uuid(), now(), now()) RETURNING id`, [operador])).rows[0].id;
  await client.query(readFileSync('database/checks/20261016_083_precheck.sql', 'utf8'));
  await client.query(up);
  await client.query(readFileSync('database/checks/20261016_083_postcheck.sql', 'utf8'));
  const legada = await um<{ empresa_id: string | null; status: string }>('SELECT empresa_id, status FROM whatsapp_conexoes WHERE id = $1', [ids.legada]);
  assert.deepEqual([legada.empresa_id, legada.status], [null, 'CONFIGURADA'], 'a conexão antiga fica como estava (sem empresa, inerte)');
  // Nova conexão CONFIGURADA sem empresa é recusada pelo CHECK (código antigo depois da 083).
  await assert.rejects(client.query(`INSERT INTO whatsapp_conexoes (ambiente, meta_app_id, business_id, waba_id, phone_number_id, numero_exibicao, nome_verificado, coexistencia_confirmada,
      status, escopos, credencial_cifrada, credencial_iv, credencial_tag, credencial_chave_versao, token_tipo, meta_validada_em, criada_por_usuario_id, sessao_referencia_id, criada_em, atualizada_em)
    VALUES ('PRODUCTION', '123456789', '9101', '9102', '9103', '+55 11 90000-0001', 'Sem empresa', true, 'CONFIGURADA', ARRAY['x'], '\\x01'::bytea,
      decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'), 1, 'bearer', now(), $1, gen_random_uuid(), now(), now())`, [operador]),
    (e: { code?: string; constraint?: string }) => e.code === '23514' && e.constraint === 'whatsapp_conexoes_empresa_obrigatoria_check');
});

test('083 R2: pós-check recusa objetos homônimos com definição errada (controles negativos, cada um desfeito por ROLLBACK)', async () => {
  const pos = readFileSync('database/checks/20261016_083_postcheck.sql', 'utf8');
  await client.query(pos); // controle positivo: a 083 aplicada passa
  const semFk = (tabela: string) => `DO $x$ DECLARE n text; BEGIN
      SELECT conname INTO n FROM pg_constraint WHERE conrelid = '${tabela}'::regclass AND contype = 'f' AND confrelid = 'empresas'::regclass;
      EXECUTE format('ALTER TABLE ${tabela} DROP CONSTRAINT %I', n); END $x$;`;
  const m018 = readFileSync('database/migrations/20260912_018_whatsapp_onboarding.sql', 'utf8').replace(/\r\n/g, '\n');
  const funcao018 = m018.slice(m018.indexOf('CREATE OR REPLACE FUNCTION public.kidmais_whatsapp_conexao_proteger()'), m018.indexOf('CREATE OR REPLACE FUNCTION public.kidmais_whatsapp_tentativa_proteger()'));
  const superusuario = (await um<{ rolsuper: boolean }>('SELECT rolsuper FROM pg_roles WHERE rolname = current_user')).rolsuper;
  const casos: Array<[string, string, RegExp]> = [
    ['índice sem unicidade', `DROP INDEX whatsapp_conexoes_numero_configurado_uk;
      CREATE INDEX whatsapp_conexoes_numero_configurado_uk ON whatsapp_conexoes (ambiente, phone_number_id) WHERE status = 'CONFIGURADA';`, /índice whatsapp_conexoes_numero_configurado_uk/],
    ['índice com predicado incompleto', `DROP INDEX whatsapp_conexoes_empresa_configurada_uk;
      CREATE UNIQUE INDEX whatsapp_conexoes_empresa_configurada_uk ON whatsapp_conexoes (ambiente, empresa_id) WHERE status = 'CONFIGURADA';`, /índice whatsapp_conexoes_empresa_configurada_uk/],
    ['índice com colunas em outra ordem', `DROP INDEX whatsapp_conexoes_empresa_configurada_uk;
      CREATE UNIQUE INDEX whatsapp_conexoes_empresa_configurada_uk ON whatsapp_conexoes (empresa_id, ambiente) WHERE status = 'CONFIGURADA' AND empresa_id IS NOT NULL;`, /índice whatsapp_conexoes_empresa_configurada_uk/],
    ['índice homônimo em outra tabela', `DROP INDEX whatsapp_tentativas_empresa_ativa_uk;
      CREATE UNIQUE INDEX whatsapp_tentativas_empresa_ativa_uk ON whatsapp_conexoes (ambiente, empresa_id) WHERE status IN ('INICIADA', 'VALIDANDO') AND empresa_id IS NOT NULL;`, /índice whatsapp_tentativas_empresa_ativa_uk/],
    ['índice antigo de volta', `CREATE UNIQUE INDEX whatsapp_conexoes_ambiente_configurada_uk ON whatsapp_conexoes (ambiente) WHERE status = 'CONFIGURADA' AND empresa_id IS NULL;`, /índice antigo/],
    ['FK ausente (conexões)', semFk('whatsapp_conexoes'), /FK de empresa_id para empresas\(id\) ausente ou inválida em whatsapp_conexoes/],
    ['FK ausente (tentativas)', semFk('whatsapp_onboarding_tentativas'), /FK de empresa_id para empresas\(id\) ausente ou inválida em whatsapp_onboarding_tentativas/],
    ['FK para outra tabela', `${semFk('whatsapp_conexoes')}
      ALTER TABLE whatsapp_conexoes ADD CONSTRAINT whatsapp_conexoes_empresa_id_fkey FOREIGN KEY (empresa_id) REFERENCES usuarios_administrativos (id);`, /FK de empresa_id/],
    ['FK não validada', `${semFk('whatsapp_conexoes')}
      ALTER TABLE whatsapp_conexoes ADD CONSTRAINT whatsapp_conexoes_empresa_id_fkey FOREIGN KEY (empresa_id) REFERENCES empresas (id) NOT VALID;`, /FK de empresa_id/],
    ['coluna com tipo errado', `${semFk('whatsapp_conexoes')}
      ALTER TABLE whatsapp_conexoes ALTER COLUMN empresa_id TYPE text USING empresa_id::text;`, /coluna empresa_id ausente ou com tipo diferente de uuid em whatsapp_conexoes/],
    ['CHECK permissivo', `ALTER TABLE whatsapp_conexoes DROP CONSTRAINT whatsapp_conexoes_empresa_obrigatoria_check;
      ALTER TABLE whatsapp_conexoes ADD CONSTRAINT whatsapp_conexoes_empresa_obrigatoria_check CHECK (true) NOT VALID;`, /CHECK whatsapp_conexoes_empresa_obrigatoria_check/],
    ['CHECK homônimo na tabela errada', `ALTER TABLE whatsapp_conexoes DROP CONSTRAINT whatsapp_conexoes_empresa_obrigatoria_check;
      ALTER TABLE whatsapp_onboarding_tentativas ADD CONSTRAINT whatsapp_conexoes_empresa_obrigatoria_check CHECK (status <> 'CONFIGURADA' OR empresa_id IS NOT NULL) NOT VALID;`, /CHECK whatsapp_conexoes_empresa_obrigatoria_check/],
    ['CHECK das tentativas com lista diferente', `ALTER TABLE whatsapp_onboarding_tentativas DROP CONSTRAINT whatsapp_tentativas_empresa_obrigatoria_check;
      ALTER TABLE whatsapp_onboarding_tentativas ADD CONSTRAINT whatsapp_tentativas_empresa_obrigatoria_check CHECK (empresa_id IS NOT NULL OR status IN ('CONCLUIDA', 'EXPIRADA', 'RECUSADA', 'FALHOU', 'INICIADA')) NOT VALID;`, /CHECK whatsapp_tentativas_empresa_obrigatoria_check/],
    ['gatilho desligado', `ALTER TABLE whatsapp_conexoes DISABLE TRIGGER whatsapp_conexoes_proteger_trg;`, /gatilho whatsapp_conexoes_proteger_trg/],
    ['gatilho ausente', `DROP TRIGGER whatsapp_tentativas_proteger_trg ON whatsapp_onboarding_tentativas;`, /gatilho whatsapp_tentativas_proteger_trg/],
    ['gatilho sem DELETE', `DROP TRIGGER whatsapp_conexoes_proteger_trg ON whatsapp_conexoes;
      CREATE TRIGGER whatsapp_conexoes_proteger_trg BEFORE UPDATE ON whatsapp_conexoes FOR EACH ROW EXECUTE FUNCTION kidmais_whatsapp_conexao_proteger();`, /gatilho whatsapp_conexoes_proteger_trg/],
    ['gatilho com WHEN', `DROP TRIGGER whatsapp_conexoes_proteger_trg ON whatsapp_conexoes;
      CREATE TRIGGER whatsapp_conexoes_proteger_trg BEFORE UPDATE OR DELETE ON whatsapp_conexoes FOR EACH ROW WHEN (false) EXECUTE FUNCTION kidmais_whatsapp_conexao_proteger();`, /gatilho whatsapp_conexoes_proteger_trg/],
    ['gatilho homônimo na tabela errada', `DROP TRIGGER whatsapp_conexoes_proteger_trg ON whatsapp_conexoes;
      CREATE TRIGGER whatsapp_conexoes_proteger_trg BEFORE UPDATE OR DELETE ON whatsapp_onboarding_tentativas FOR EACH ROW EXECUTE FUNCTION kidmais_whatsapp_conexao_proteger();`, /gatilho whatsapp_conexoes_proteger_trg/],
    ['função com o corpo da 018 (sem empresa_id)', funcao018, /função do gatilho whatsapp_conexoes_proteger_trg/],
  ];
  if (superusuario) casos.push(['índice inválido (indisvalid=false)', `UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'whatsapp_conexoes_numero_configurado_uk'::regclass;`, /índice whatsapp_conexoes_numero_configurado_uk/]);
  for (const [rotulo, adulteracao, esperado] of casos) {
    await client.query('BEGIN');
    try {
      await client.query(adulteracao);
      await assert.rejects(client.query(pos), esperado, rotulo);
    } finally {
      await client.query('ROLLBACK');
    }
  }
  await client.query(pos); // tudo desfeito: volta a passar
  assert.ok(casos.length >= 19, `${casos.length} controles negativos (índice inválido ${superusuario ? 'incluído' : 'omitido: papel sem superusuário'})`);
});

test('083: fixtures sintéticas — duas empresas, Gestão de cada uma, Equipe da A e uma Gestão nas duas (todas com papel global neutro)', async () => {
  const hash = await svc.senha.criarHashSenha('senha-sintetica-083');
  for (const chave of ['gestaoA', 'equipeA', 'gestaoB', 'gestaoAB'])
    ids[chave] = (await client.query<{ id: string }>("INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel) VALUES ($1, $2, $3, 'ADMINISTRATIVO') RETURNING id",
      [`w083-${chave.toLowerCase()}-${sufixo}@exemplo.test`, `Pessoa ${chave}`, hash])).rows[0].id;
  await client.query("UPDATE usuarios_administrativos SET senha_alterada_em = clock_timestamp() - interval '1 hour' WHERE id = ANY($1::uuid[])", [Object.values(ids).filter((v) => v !== ids.legada)]);
  for (const chave of ['A', 'B']) {
    ids[`empresa${chave}`] = (await client.query<{ id: string }>("INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id", [`w083-${chave.toLowerCase()}-${sufixo}`, `Buffet 083 ${chave}`])).rows[0].id;
    await client.query("UPDATE empresas SET status = 'ATIVA' WHERE id = $1", [ids[`empresa${chave}`]]);
  }
  const vinculo = async (usuario: string, empresa: string, papel: string) => {
    const m = (await client.query<{ id: string }>("INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1, $2, 'PENDENTE', clock_timestamp(), $3) RETURNING id", [empresa, usuario, papel])).rows[0].id;
    await client.query("UPDATE memberships SET status = 'ATIVA' WHERE id = $1", [m]);
  };
  await vinculo(ids.gestaoA, ids.empresaA, 'REPRESENTANTE_AUTORIZADO');
  await vinculo(ids.equipeA, ids.empresaA, 'ADMINISTRATIVO');
  await vinculo(ids.gestaoB, ids.empresaB, 'REPRESENTANTE_AUTORIZADO');
  await vinculo(ids.gestaoAB, ids.empresaA, 'REPRESENTANTE_AUTORIZADO');
  await vinculo(ids.gestaoAB, ids.empresaB, 'REPRESENTANTE_AUTORIZADO');
});

test('consultar: a Gestão vê só a própria empresa (a conexão antiga da plataforma não aparece); Equipe é recusada', async () => {
  const a = await consultar(await sessaoDe(ids.gestaoA));
  assert.deepEqual([a.estado, a.empresa, a.conexao], ['NAO_CONFIGURADA', 'Buffet 083 A', null]);
  assert.equal(await codigoErro(consultar(await sessaoDe(ids.equipeA))), 'WHATSAPP_AUTORIZACAO_RECUSADA');
});

test('conectar: Equipe e senha antiga são recusadas antes de qualquer tentativa', async () => {
  const antes = await conta('SELECT count(*)::int AS n FROM whatsapp_onboarding_tentativas');
  assert.equal(await codigoErro(conectar(await sessaoDe(ids.equipeA), '5001')), 'WHATSAPP_AUTORIZACAO_RECUSADA');
  assert.equal(await codigoErro(conectar(await sessaoDe(ids.gestaoA, { reautenticadoHaMin: 10 }), '5001')), 'WHATSAPP_REAUTENTICACAO_NECESSARIA');
  assert.equal(await conta('SELECT count(*)::int AS n FROM whatsapp_onboarding_tentativas'), antes);
});

test('conectar: a Gestão da A conecta o número da A; conexão, tentativa e auditoria presas à empresa; credencial presa à empresa', async () => {
  const r = await conectar(await sessaoDe(ids.gestaoA), '5001');
  ids.conexaoA = r.conexaoId;
  const c = await um<{ empresa_id: string; status: string; phone_number_id: string; credencial_cifrada: Buffer; credencial_iv: Buffer; credencial_tag: Buffer }>(
    'SELECT empresa_id, status, phone_number_id, credencial_cifrada, credencial_iv, credencial_tag FROM whatsapp_conexoes WHERE id = $1', [r.conexaoId]);
  assert.deepEqual([c.empresa_id, c.status, c.phone_number_id], [ids.empresaA, 'CONFIGURADA', '5001']);
  assert.equal(await conta("SELECT count(*)::int AS n FROM whatsapp_onboarding_tentativas WHERE conexao_id = $1 AND empresa_id = $2 AND status = 'CONCLUIDA'", [r.conexaoId, ids.empresaA]), 1);
  const auditoria = await um<{ dados_depois: { empresaId: string } }>("SELECT dados_depois FROM auditoria WHERE acao = 'WHATSAPP_CONEXAO_CONFIGURADA' AND entidade_id = $1", [r.conexaoId]);
  assert.equal(auditoria.dados_depois.empresaId, ids.empresaA);
  assert.doesNotMatch(JSON.stringify(auditoria), /token-sintetico/, 'a auditoria nunca guarda o token');
  const meta = { ambiente: 'STAGING', appId: '123456789', businessId: '1001', wabaId: '2002', phoneNumberId: '5001' };
  const decifrar = svc.credencial.decifrarCredencialWhatsapp as unknown as (i: unknown, m: unknown) => string;
  const cifrado = { ciphertext: c.credencial_cifrada, iv: c.credencial_iv, tag: c.credencial_tag };
  assert.equal(decifrar(cifrado, { ...meta, empresaId: ids.empresaA }), 'token-sintetico-5001');
  assert.throws(() => decifrar(cifrado, { ...meta, empresaId: ids.empresaB }), /integridade/, 'a credencial não abre com outra empresa');
  assert.throws(() => decifrar(cifrado, meta), /integridade/);
  const visao = await consultar(await sessaoDe(ids.gestaoA));
  assert.deepEqual([visao.estado, visao.conexao?.phoneNumberId], ['CONFIGURADA_SEM_WEBHOOK_OTP', '5001']);
});

test('isolamento: a Gestão da B não vê a conexão da A e conecta o próprio número; a A não pode ter uma segunda conexão', async () => {
  const sB = await sessaoDe(ids.gestaoB);
  assert.equal((await consultar(sB)).conexao, null);
  ids.conexaoB = (await conectar(sB, '6001')).conexaoId;
  assert.equal((await um<{ empresa_id: string }>('SELECT empresa_id FROM whatsapp_conexoes WHERE id = $1', [ids.conexaoB])).empresa_id, ids.empresaB);
  assert.equal(await codigoErro(conectar(await sessaoDe(ids.gestaoA), '5002')), 'WHATSAPP_JA_CONFIGURADO');
});

test('o mesmo número não entra em duas empresas: recusado com mensagem neutra, tentativa FALHOU e nada gravado', async () => {
  await client.query("UPDATE whatsapp_conexoes SET status = 'DESCONECTADA', desconectada_em = clock_timestamp(), desconectada_por_usuario_id = $2, motivo_desconexao = 'Preparar o teste de número', revisao = revisao + 1, atualizada_em = clock_timestamp() WHERE id = $1", [ids.conexaoB, ids.gestaoB]);
  const antes = await conta("SELECT count(*)::int AS n FROM whatsapp_conexoes WHERE status = 'CONFIGURADA'");
  const erro = await codigoErro(conectar(await sessaoDe(ids.gestaoB), '5001'));
  assert.equal(erro, 'WHATSAPP_NUMERO_EM_USO');
  assert.equal(await conta("SELECT count(*)::int AS n FROM whatsapp_conexoes WHERE status = 'CONFIGURADA'"), antes);
  assert.equal(await conta("SELECT count(*)::int AS n FROM whatsapp_onboarding_tentativas WHERE empresa_id = $1 AND status = 'FALHOU' AND erro_codigo = 'WHATSAPP_NUMERO_EM_USO'", [ids.empresaB]), 1);
  // Mesmo que o código deixasse passar, o índice da 083 recusa o número repetido no ambiente.
  await assert.rejects(client.query(`INSERT INTO whatsapp_conexoes (ambiente, empresa_id, meta_app_id, business_id, waba_id, phone_number_id, numero_exibicao, nome_verificado, coexistencia_confirmada,
      status, escopos, credencial_cifrada, credencial_iv, credencial_tag, credencial_chave_versao, token_tipo, meta_validada_em, criada_por_usuario_id, sessao_referencia_id, criada_em, atualizada_em)
    VALUES ('STAGING', $1, '123456789', '1', '2', '5001', '+55 11 90000-0002', 'Duplicado', true, 'CONFIGURADA', ARRAY['x'], '\\x01'::bytea,
      decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'), 1, 'bearer', now(), $2, gen_random_uuid(), now(), now())`, [ids.empresaB, ids.gestaoB]),
    (e: { code?: string; constraint?: string }) => e.code === '23505' && e.constraint === 'whatsapp_conexoes_numero_configurado_uk');
});

test('troca de empresa no meio do fluxo: a tentativa iniciada na A não conclui com a sessão na B', async () => {
  const s = await sessaoDe(ids.gestaoAB, { empresaAtiva: ids.empresaB });
  const ini = await (svc.wpp.iniciarOnboardingWhatsapp as unknown as (t: string, c: unknown) => Promise<{ tentativaId: string; state: string }>)(s.token, ctx());
  assert.equal((await um<{ empresa_id: string }>('SELECT empresa_id FROM whatsapp_onboarding_tentativas WHERE id = $1', [ini.tentativaId])).empresa_id, ids.empresaB);
  // A mesma sessão passa a ter a A como empresa ativa (como numa troca): a tentativa da B não vale mais.
  await client.query('UPDATE sessoes_administrativas SET empresa_ativa_id = $2::uuid WHERE id = $1::uuid', [s.id, ids.empresaA]);
  const erro = await codigoErro((svc.wpp.concluirOnboardingWhatsapp as unknown as (r: unknown, t: string, c: unknown, d: unknown) => Promise<unknown>)(
    { tentativaId: ini.tentativaId, state: ini.state, authorizationCode: 'codigo-sintetico-083', businessId: '1001', wabaId: '2002', phoneNumberId: '7001' }, s.token, ctx(), { validarMeta: metaOk }));
  assert.equal(erro, 'WHATSAPP_TENTATIVA_INVALIDA');
  assert.equal(await conta("SELECT count(*)::int AS n FROM whatsapp_conexoes WHERE phone_number_id = '7001'"), 0);
});

test('desconectar: Equipe recusada; a Gestão da B não alcança a conexão da A; a Gestão da A desconecta com motivo e pode conectar de novo', async () => {
  assert.equal(await codigoErro(desconectar(await sessaoDe(ids.equipeA), ids.conexaoA)), 'WHATSAPP_AUTORIZACAO_RECUSADA');
  assert.equal(await codigoErro(desconectar(await sessaoDe(ids.gestaoB), ids.conexaoA)), 'WHATSAPP_CONEXAO_NAO_ENCONTRADA');
  assert.equal(await codigoErro(desconectar(await sessaoDe(ids.gestaoA, { reautenticadoHaMin: 10 }), ids.conexaoA)), 'WHATSAPP_REAUTENTICACAO_NECESSARIA');
  assert.equal((await um<{ status: string }>('SELECT status FROM whatsapp_conexoes WHERE id = $1', [ids.conexaoA])).status, 'CONFIGURADA');
  const sA = await sessaoDe(ids.gestaoA);
  assert.equal((await desconectar(sA, ids.conexaoA)).estado, 'DESCONECTADA');
  const c = await um<{ status: string; motivo_desconexao: string; desconectada_por_usuario_id: string; revisao: number }>('SELECT status, motivo_desconexao, desconectada_por_usuario_id, revisao FROM whatsapp_conexoes WHERE id = $1', [ids.conexaoA]);
  assert.deepEqual([c.status, c.motivo_desconexao, c.desconectada_por_usuario_id, c.revisao], ['DESCONECTADA', 'Troca de número da empresa', ids.gestaoA, 2]);
  assert.equal(await conta("SELECT count(*)::int AS n FROM auditoria WHERE acao = 'WHATSAPP_CONEXAO_DESCONECTADA' AND entidade_id = $1 AND justificativa = 'Troca de número da empresa'", [ids.conexaoA]), 1);
  assert.equal(await codigoErro(desconectar(sA, ids.conexaoA)), 'WHATSAPP_JA_DESCONECTADO');
  // Depois de desconectar, o número volta a ficar livre e a A conecta outro (ou o mesmo).
  const nova = await conectar(await sessaoDe(ids.gestaoA), '5001');
  assert.equal((await consultar(await sessaoDe(ids.gestaoA))).conexao?.id, nova.conexaoId);
  // A conexão antiga da plataforma continua intocada.
  assert.equal((await um<{ status: string }>('SELECT status FROM whatsapp_conexoes WHERE id = $1', [ids.legada])).status, 'CONFIGURADA');
});

test('rollback recusado quando já existe conexão de empresa (histórico preservado)', async () => {
  await assert.rejects(client.query(readFileSync('database/rollback/20261016_083_whatsapp_conexao_empresa_down.sql', 'utf8')), /083 rollback recusado/);
  await client.query('ROLLBACK').catch(() => undefined);
  assert.equal(await conta("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'whatsapp_conexoes' AND column_name = 'empresa_id'"), 1);
});
