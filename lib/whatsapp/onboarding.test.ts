import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { carregarModulo, executorFalso } from '../acessos/teste-carregador.ts';
import { concluirOnboardingSchema, concluirRenovacaoSchema, desconectarSchema, divergenciaRenovacao, exigirEsquemaPorEmpresa, exigirGestaoDaEmpresa, exigirReautenticacaoRecente, stateCorresponde } from './onboarding-core.ts';

type SessaoTeste = { id: string; usuario_id: string; nome: string; cargo: null; papel: string; autenticado_em: string; expira_em: string; csrf_hash: string };
function sessao(overrides: Partial<SessaoTeste> = {}): SessaoTeste {
  return { id: randomUUID(), usuario_id: randomUUID(), nome: 'Usuário Sintético', cargo: null,
    papel: 'REPRESENTANTE_AUTORIZADO', autenticado_em: new Date(1_000_000).toISOString(),
    expira_em: new Date(2_000_000).toISOString(), csrf_hash: 'hash', ...overrides };
}

test('Gestão DA EMPRESA com reautenticação recente é aceita; Equipe e senha vencida são recusadas', () => {
  assert.doesNotThrow(() => exigirReautenticacaoRecente(sessao(), 1_000_000 + 299_999));
  assert.throws(() => exigirReautenticacaoRecente(sessao(), 1_000_000 + 300_001), /Confirme sua senha/);
  assert.doesNotThrow(() => exigirGestaoDaEmpresa('REPRESENTANTE_AUTORIZADO', 'conectar'));
  assert.throws(() => exigirGestaoDaEmpresa('ADMINISTRATIVO', 'conectar'), /Somente a Gestão da empresa pode conectar o WhatsApp/);
});

test('desconectar exige conexão, motivo de 3 a 500 caracteres e nada além disso', () => {
  assert.equal(desconectarSchema.safeParse({ conexaoId: randomUUID(), motivo: 'Troca de número' }).success, true);
  assert.equal(desconectarSchema.safeParse({ conexaoId: randomUUID(), motivo: '  a ' }).success, false);
  assert.equal(desconectarSchema.safeParse({ conexaoId: 'x', motivo: 'Troca de número' }).success, false);
  assert.equal(desconectarSchema.safeParse({ conexaoId: randomUUID(), motivo: 'Troca', empresaId: randomUUID() }).success, false, 'a empresa vem da sessão, nunca do corpo');
});

test('state é comparado pelo hash e payload rejeita campos inesperados', () => {
  const state = Buffer.alloc(32, 3).toString('base64url');
  assert.equal(stateCorresponde(state, createHash('sha256').update(state).digest()), true);
  assert.equal(stateCorresponde(Buffer.alloc(32, 4).toString('base64url'), createHash('sha256').update(state).digest()), false);
  assert.equal(concluirOnboardingSchema.safeParse({ tentativaId: randomUUID(), state, authorizationCode: 'codigo-123',
    businessId: '1', wabaId: '2', phoneNumberId: '3', accessToken: 'proibido' }).success, false);
});

test('D2: conclusão aceita só waba_id (negócio e número resolvidos no servidor); ids presentes continuam numéricos', () => {
  const state = 'a'.repeat(43);
  const base = { tentativaId: randomUUID(), state, authorizationCode: 'codigo-123' };
  assert.equal(concluirOnboardingSchema.safeParse({ ...base, wabaId: '2' }).success, true);
  assert.equal(concluirOnboardingSchema.safeParse({ ...base, wabaId: '2', businessId: '1', phoneNumberId: '3' }).success, true);
  assert.equal(concluirOnboardingSchema.safeParse({ ...base, businessId: '1', phoneNumberId: '3' }).success, false, 'waba_id obrigatório');
  assert.equal(concluirOnboardingSchema.safeParse({ ...base, wabaId: '2', businessId: 'x1' }).success, false);
  assert.equal(concluirOnboardingSchema.safeParse({ ...base, wabaId: '2', phoneNumberId: '' }).success, false);
});

test('antes da 083 aplicada, o WhatsApp por empresa responde 503 com mensagem clara (nunca erro de SQL)', async () => {
  const tx = (ok: boolean) => ({ query: async () => ({ rows: [{ ok }] }) }) as never;
  await assert.rejects(exigirEsquemaPorEmpresa(tx(false)), (e: { code?: string; httpStatus?: number }) => e.code === 'WHATSAPP_ATUALIZACAO_PENDENTE' && e.httpStatus === 503);
  await assert.doesNotReject(exigirEsquemaPorEmpresa(tx(true)));
});

test('renovação: app, WABA, negócio e número têm de ser os da conexão; ids ausentes do evento não divergem', () => {
  const conexao = { meta_app_id: '1', business_id: '10', waba_id: '20', phone_number_id: '30' };
  assert.equal(divergenciaRenovacao(conexao, '1', { wabaId: '20', businessId: '10', phoneNumberId: '30' }), null);
  assert.equal(divergenciaRenovacao(conexao, '1', { wabaId: '20' }), null, 'evento só com waba_id: o resto é comprovado depois');
  assert.equal(divergenciaRenovacao(conexao, '2', { wabaId: '20' }), 'app');
  assert.equal(divergenciaRenovacao(conexao, '1', { wabaId: '21' }), 'waba');
  assert.equal(divergenciaRenovacao(conexao, '1', { wabaId: '20', businessId: '11' }), 'negocio');
  assert.equal(divergenciaRenovacao(conexao, '1', { wabaId: '20', phoneNumberId: '31' }), 'numero');
  const state = 'a'.repeat(43);
  assert.equal(concluirRenovacaoSchema.safeParse({ tentativaId: randomUUID(), state, authorizationCode: 'codigo-123', wabaId: '20', conexaoId: randomUUID() }).success, false, 'a conexão vem do banco, nunca do corpo');
});

test('conferência: entrada inválida (sem id, id fora do formato, campo extra) é recusada com 400 antes de abrir transação', async () => {
  const servico = carregarModulo('lib/whatsapp/onboarding.service.ts', {
    'db/postgres': { withTransaction: () => { throw new Error('não deveria abrir transação'); } },
    'autenticacao/service': { consultarSessao: async () => { throw new Error('não deveria consultar sessão'); } },
  }) as { conferirTentativaWhatsapp: (raw: unknown, token: string, contexto: unknown, deps: unknown) => Promise<unknown> };
  const transacao = async () => { throw new Error('não deveria abrir transação'); };
  for (const raw of [null, {}, { tentativaId: 'abc' }, { tentativaId: '00000000-0000-4000-8000-000000000000', extra: 1 }])
    await assert.rejects(servico.conferirTentativaWhatsapp(raw, 't'.repeat(43), { requestId: 'r', ip: null, userAgent: null }, { transacao }), { code: 'WHATSAPP_DADOS_INVALIDOS', httpStatus: 400 }, JSON.stringify(raw));
});

test('conclusões travam a tentativa pelo id, ambiente e empresa comprovada, inclusive ao finalizar ou marcar falha', async () => {
  const sessaoAtual = sessao({ autenticado_em: new Date().toISOString() });
  const empresaId = randomUUID(), tentativaId = randomUUID(), conexaoId = randomUUID();
  const state = 'a'.repeat(43);
  const config = { ambiente: 'STAGING', appId: '1' };
  const servico = carregarModulo('lib/whatsapp/onboarding.service.ts', {
    'db/postgres': { withTransaction: () => { throw new Error('o teste usa só a transação dublada'); } },
    'autenticacao/service': { consultarSessao: async () => sessaoAtual },
    'saas/provar-tenant': {
      provarTenant: async () => ({ papelAtual: 'REPRESENTANTE_AUTORIZADO', empresaComprovada: empresaId }),
      revalidarTenant: async () => undefined,
    },
    'clientes/repositories/auditoria.repository': { registrarAuditoria: async () => undefined },
    'whatsapp/configuracao': { exigirConfiguracaoWhatsappPrivada: () => config },
    'whatsapp/credencial': { cifrarCredencialWhatsapp: () => ({}) },
  }) as Record<string, (raw: unknown, token: string, contexto: unknown, deps: unknown) => Promise<unknown>>;
  const conexao = { id: conexaoId, revisao: 1, meta_app_id: '1', business_id: '10', waba_id: '20', phone_number_id: '30' };
  for (const [acao, renovando] of [['concluirOnboardingWhatsapp', false], ['concluirRenovacaoWhatsapp', true]] as const) {
    for (const falha of [false, true]) {
      let status = 'INICIADA';
      const tx = executorFalso([
        [/information_schema/, () => [{ ok: true }]],
        [/SELECT \* FROM whatsapp_onboarding_tentativas/, () => [{
          id: tentativaId, ambiente: config.ambiente, empresa_id: empresaId, status,
          usuario_id: sessaoAtual.usuario_id, sessao_referencia_id: sessaoAtual.id,
          expira_em: new Date(Date.now() + 60_000).toISOString(), state_hash: createHash('sha256').update(state).digest(),
        }]],
        [/SET status='VALIDANDO'/, () => { status = 'VALIDANDO'; return []; }],
        [/FROM auditoria/, () => renovando ? [{ conexao_id: conexaoId, revisao: 1 }] : []],
        [/FROM whatsapp_conexoes WHERE ambiente=.*FOR UPDATE/, () => renovando ? [conexao] : []],
        [/(INSERT INTO|UPDATE) whatsapp_conexoes/, () => [conexao]],
      ]);
      const validarMeta = async () => {
        if (falha) throw new Error('Meta dublada recusou');
        return { businessId: '10', phoneNumberId: '30' };
      };
      const resultado = servico[acao]({ tentativaId, state, authorizationCode: 'codigo-sintetico', wabaId: '20' },
        't'.repeat(43), { requestId: 'r', ip: null, userAgent: null }, {
          transacao: async (fn: (executor: typeof tx) => Promise<unknown>) => fn(tx),
          validarMeta,
        });
      if (falha) await assert.rejects(resultado, { code: 'META_VALIDACAO_FALHOU' });
      else await assert.doesNotReject(resultado);
      const locks = tx.executados.filter(({ sql }) => /FROM whatsapp_onboarding_tentativas.*FOR UPDATE/.test(sql));
      assert.equal(locks.length, 2, acao);
      for (const { sql, params } of locks) {
        assert.match(sql, /WHERE id=\$1::uuid AND ambiente=\$2 AND empresa_id=\$3::uuid FOR UPDATE/);
        assert.deepEqual(params, [tentativaId, config.ambiente, empresaId]);
      }
    }
  }
});

test('rotina do sistema: banco anterior à 083 dá WHATSAPP_ATUALIZACAO_PENDENTE (503) antes de qualquer leitura de tentativas', async (t) => {
  const envAntes = { ...process.env };
  t.after(() => { for (const chave of Object.keys(process.env)) if (!(chave in envAntes)) delete process.env[chave]; Object.assign(process.env, envAntes); });
  Object.assign(process.env, {
    KIDMAIS_DEPLOY_ENV: 'staging', META_APP_ID: '1', META_APP_SECRET: 'segredo-sintetico-valido',
    META_GRAPH_API_VERSION: 'v24.0', META_EMBEDDED_SIGNUP_CONFIG_ID: '2',
    META_OAUTH_REDIRECT_URI: 'https://staging.example.invalid/callback',
    META_EMBEDDED_SIGNUP_OPTIONS_JSON: '{"response_type":"code","override_default_response_type":true}',
    META_EMBEDDED_SIGNUP_EVENT_NAME: 'FINISH', META_EMBEDDED_SIGNUP_MESSAGE_ORIGINS: 'https://www.facebook.com',
  });
  const servico = carregarModulo('lib/whatsapp/onboarding.service.ts', {
    'db/postgres': { withTransaction: () => { throw new Error('o teste usa só a transação dublada'); } },
    'autenticacao/service': { consultarSessao: async () => sessao() },
  }) as { iniciarRenovacaoWhatsapp: (token: string, contexto: unknown, deps: unknown) => Promise<unknown>; iniciarOnboardingWhatsapp: (token: string, contexto: unknown, deps: unknown) => Promise<unknown> };
  for (const inicio of ['iniciarRenovacaoWhatsapp', 'iniciarOnboardingWhatsapp'] as const) {
    const sqls: string[] = [];
    const tx = { query: async (sql: string) => { sqls.push(sql); return { rows: /information_schema/.test(sql) ? [{ ok: false }] : [], rowCount: 0 }; } };
    const transacao = async (fn: (executor: typeof tx) => Promise<unknown>) => fn(tx);
    await assert.rejects(servico[inicio]('t'.repeat(43), { requestId: 'r', ip: null, userAgent: null }, { transacao }), { code: 'WHATSAPP_ATUALIZACAO_PENDENTE', httpStatus: 503 }, inicio);
    assert.equal(sqls.length, 1, inicio + ': só a conferência do esquema rodou');
    assert.match(sqls[0], /information_schema/);
    assert.equal(sqls.some((sql) => /whatsapp_onboarding_tentativas\s+WHERE/.test(sql)), false, inicio);
  }
});
