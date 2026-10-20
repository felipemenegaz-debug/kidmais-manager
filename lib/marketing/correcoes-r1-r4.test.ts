import assert from 'node:assert/strict';
import test from 'node:test';
import { carregarModulo } from '../acessos/teste-carregador.ts';

/**
 * Módulos carregados DENTRO de cada teste: rodado contra o código antigo (bc379ad), cada cenário falha sozinho
 * (prova "falha antes, passa depois"), em vez de o arquivo inteiro falhar na importação.
 */
const carregar = <T>(arquivo: string, dubles: Record<string, unknown> = {}) => carregarModulo(arquivo, dubles) as unknown as T;
type ModMetricas = typeof import('./metricas.ts');
type ModApresentacao = typeof import('./apresentacao.ts');
type ModAlvos = typeof import('./automacoes/alvos.ts');
type ModPrefPuro = typeof import('./automacoes/preferencias.ts');

/**
 * Regressões dos achados R1–R4 da revisão de bc379ad (15/10/2026). Sem banco: lógica com dependências em memória.
 * A prova SQL (concorrência, 501 alvos, gatilhos) fica nas suítes *.postgres.test.ts do Marketing.
 */
const EMPRESA = '11111111-1111-4111-8111-111111111111';
const CLIENTE = '22222222-2222-4222-8222-222222222222';
const CONTATO = '33333333-3333-4333-8333-333333333333';

// ---------------------------------------------------------------------------------------------------------------
// R1 — consentimento por destino
// ---------------------------------------------------------------------------------------------------------------
type Aut = { id: string; destino: string; estado: 'PENDENTE' | 'CONFIRMADA' | 'REVOGADA' };
function bancoR1(cadastro: { whatsapp: string | null; telefone: string | null }, opcoes: { descadastrado?: boolean } = {}) {
  const autorizacoes: Aut[] = [];
  const tx = { async query(sql: string, p: unknown[] = []) {
    if (sql.includes("to_regclass('public.marketing_contato_autorizacoes')")) return { rows: [{ ok: true }], rowCount: 1 };
    if (sql.includes("to_regclass('public.whatsapp_atendimento_controles_contato')")) return { rows: [{ existe: null }], rowCount: 1 };
    if (sql.includes('FROM marketing_contato_preferencias')) return { rows: opcoes.descadastrado ? [{ descadastrado_em: '2026-10-01', descadastro_origem: 'EQUIPE' }] : [], rowCount: 0 };
    if (sql.includes('SELECT whatsapp, telefone FROM clientes')) return { rows: p[1] === EMPRESA ? [cadastro] : [], rowCount: 1 };
    if (sql.includes('SELECT status, whatsapp, telefone FROM clientes')) return { rows: p[1] === EMPRESA ? [{ status: 'ATIVO', ...cadastro }] : [], rowCount: 1 };
    if (sql.includes('INSERT INTO marketing_contato_autorizacoes')) {
      if (autorizacoes.some((a) => a.destino === p[2] && a.estado !== 'REVOGADA')) return { rows: [], rowCount: 0 };
      const a = { id: `a${autorizacoes.length + 1}`, destino: String(p[2]), estado: p[3] as Aut['estado'] };
      autorizacoes.push(a); return { rows: [{ id: a.id }], rowCount: 1 };
    }
    if (sql.includes("estado = 'CONFIRMADA'") && sql.includes('FROM marketing_contato_autorizacoes')) {
      return { rows: p[0] === EMPRESA ? autorizacoes.filter((a) => a.estado === 'CONFIRMADA').map(({ id, destino }) => ({ id, destino })) : [], rowCount: 0 };
    }
    throw new Error(`SQL inesperado: ${sql.slice(0, 80)}`);
  } };
  return { tx, autorizacoes };
}
type ModPref = {
  registrarAutorizacaoDoFormulario(tx: unknown, e: string, c: string, k: string, tel: string): Promise<string>;
  elegivelParaMensagem(tx: unknown, e: string, c: string): Promise<{ ok: boolean; telefone?: string; motivo?: string }>;
};
const pref = new Proxy({} as ModPref, { get: (_a, k) => (carregar<ModPref>('lib/marketing/automacoes/preferencias.ts') as Record<string | symbol, unknown>)[k] });

test('R1: destino normalizado — com e sem 55 são o mesmo número; cadastro em ordem WhatsApp → telefone', () => {
  const { normalizarDestino, destinosDoCadastro } = carregar<ModPrefPuro>('lib/marketing/automacoes/preferencias.ts');
  assert.equal(normalizarDestino('(11) 98888-7777'), '5511988887777');
  assert.equal(normalizarDestino('5511988887777'), '5511988887777');
  assert.equal(normalizarDestino('123'), null);
  assert.deepEqual(destinosDoCadastro({ whatsapp: '11977776666', telefone: '5511977776666' }), ['5511977776666'], 'mesmo número não repete');
  assert.deepEqual(destinosDoCadastro({ whatsapp: '11977776666', telefone: '1133334444' }), ['5511977776666', '551133334444']);
});

test('R1 (cenário do parecer): e-mail reaproveita o cadastro com WhatsApp A; formulário com B → B pendente, A NÃO fica elegível', async () => {
  const b = bancoR1({ whatsapp: '11977776666', telefone: '11977776666' });
  assert.equal(await pref.registrarAutorizacaoDoFormulario(b.tx, EMPRESA, CLIENTE, CONTATO, '11988887777'), 'PENDENTE');
  assert.deepEqual(b.autorizacoes.map((a) => [a.destino, a.estado]), [['5511988887777', 'PENDENTE']], 'número do pedido guardado, sem tocar no CRM');
  assert.deepEqual(await pref.elegivelParaMensagem(b.tx, EMPRESA, CLIENTE), { ok: false, motivo: 'SEM_AUTORIZACAO' });
});

test('R1: telefone e WhatsApp diferentes no cadastro — autoriza só o número informado e o motor usa exatamente ele', async () => {
  const b = bancoR1({ whatsapp: '11977776666', telefone: '1133334444' });
  assert.equal(await pref.registrarAutorizacaoDoFormulario(b.tx, EMPRESA, CLIENTE, CONTATO, '551133334444'), 'CONFIRMADA', 'número do cadastro (com 55 no formulário)');
  const e = await pref.elegivelParaMensagem(b.tx, EMPRESA, CLIENTE);
  assert.equal(e.ok, true);
  assert.equal(e.telefone, '551133334444', 'nunca o WhatsApp não autorizado do mesmo cliente');
});

test('R1: cliente novo com caixa marcada → confirmada e elegível; repetição não duplica', async () => {
  const b = bancoR1({ whatsapp: '11988887777', telefone: '11988887777' });
  assert.equal(await pref.registrarAutorizacaoDoFormulario(b.tx, EMPRESA, CLIENTE, CONTATO, '11988887777'), 'CONFIRMADA');
  assert.equal(await pref.registrarAutorizacaoDoFormulario(b.tx, EMPRESA, CLIENTE, CONTATO, '5511988887777'), 'JA_EXISTENTE');
  assert.deepEqual(await pref.elegivelParaMensagem(b.tx, EMPRESA, CLIENTE), { ok: true, telefone: '5511988887777', autorizacaoId: 'a1' });
});

test('R1: descadastro anterior prevalece (formulário não registra nada); número trocado no cadastro não herda autorização', async () => {
  const d = bancoR1({ whatsapp: '11988887777', telefone: null }, { descadastrado: true });
  assert.equal(await pref.registrarAutorizacaoDoFormulario(d.tx, EMPRESA, CLIENTE, CONTATO, '11988887777'), 'IGNORADA_DESCADASTRO');
  assert.equal(d.autorizacoes.length, 0);
  assert.deepEqual(await pref.elegivelParaMensagem(d.tx, EMPRESA, CLIENTE), { ok: false, motivo: 'DESCADASTRADO' });
  const cadastro = { whatsapp: '11988887777', telefone: null as string | null };
  const m = bancoR1(cadastro);
  await pref.registrarAutorizacaoDoFormulario(m.tx, EMPRESA, CLIENTE, CONTATO, '11988887777');
  cadastro.whatsapp = '11955554444';
  assert.deepEqual(await pref.elegivelParaMensagem(m.tx, EMPRESA, CLIENTE), { ok: false, motivo: 'SEM_AUTORIZACAO_DESTINO' });
});

test('R1: isolamento — cliente lido por outra empresa não é elegível', async () => {
  const b = bancoR1({ whatsapp: '11988887777', telefone: null });
  await pref.registrarAutorizacaoDoFormulario(b.tx, EMPRESA, CLIENTE, CONTATO, '11988887777');
  assert.deepEqual(await pref.elegivelParaMensagem(b.tx, '99999999-9999-4999-8999-999999999999', CLIENTE), { ok: false, motivo: 'CLIENTE_INATIVO' });
});

test('R1: captura do site — caixa desmarcada não registra autorização; marcada passa o número DO PEDIDO adiante', async () => {
  const chamadas: unknown[][] = [];
  const contatos = carregarModulo('lib/marketing/contatos.ts', {
    'clientes/repositories/cliente.repository': {
      buscarClientesPorContatoExato: async () => [],
      buscarClientesPorEmailExato: async () => [{ id: CLIENTE, status: 'ATIVO' }],
      criarCliente: async () => { throw new Error('não cria: reaproveita pelo e-mail'); },
    },
    'clientes/repositories/duplicidade.repository': {}, 'clientes/repositories/auditoria.repository': {},
    'clientes/repositories/historico.repository': { registrarEventoHistorico: async (i: unknown) => { chamadas.push(['historico', i]); } },
    'marketing/atribuicao': { registrarSeAusente: async () => null, atribuicaoDesconhecida: (alvoTipo: string, alvoId: string) => ({ alvoTipo, alvoId, origemCodigo: 'DESCONHECIDA', metodo: 'DESCONHECIDO' }) },
    'marketing/automacoes/preferencias': { registrarAutorizacaoDoFormulario: async (...a: unknown[]) => { chamadas.push(['autorizacao', ...a.slice(1)]); return 'PENDENTE'; } },
  }) as unknown as { capturarContatoPublico(tx: unknown, s: unknown, e: unknown, c: unknown): Promise<unknown> };
  const tx = { async query(sql: string) { return sql.includes('INSERT INTO marketing_contatos') ? { rows: [{ id: CONTATO }], rowCount: 1 } : { rows: [], rowCount: 0 }; } };
  const site = { siteId: CONTATO, empresaId: EMPRESA, estabelecimentoId: null };
  const entrada = { nome: 'Pessoa sintética', telefone: '11988887777', email: 'p@example.invalid', dataDesejada: null, convidados: 20, mensagem: null, chave: 'r1-captura-000001' };
  await contatos.capturarContatoPublico(tx, site, entrada, { codigoCampanha: null, utm: {} });
  assert.equal(chamadas.some((c) => c[0] === 'autorizacao'), false, 'caixa desmarcada');
  await contatos.capturarContatoPublico(tx, site, { ...entrada, chave: 'r1-captura-000002', autorizaWhatsapp: true }, { codigoCampanha: null, utm: {} });
  assert.deepEqual(chamadas.find((c) => c[0] === 'autorizacao'), ['autorizacao', EMPRESA, CLIENTE, CONTATO, '11988887777']);
  const historico = chamadas.filter((c) => c[0] === 'historico').at(-1)?.[1] as { metadata: { autorizacaoWhatsapp: string } };
  assert.equal(historico.metadata.autorizacaoWhatsapp, 'PENDENTE', 'resultado rastreável no histórico do cliente');
});

// ---------------------------------------------------------------------------------------------------------------
// R2 — aptidão da empresa no planejamento e antes de agir
// ---------------------------------------------------------------------------------------------------------------
type ModApt = { empresaApta(tx: unknown, e: string, deps: unknown): Promise<{ apta: boolean; motivo?: string; definitivo?: boolean }> };
const apt = { empresaApta: (...a: Parameters<ModApt['empresaApta']>) => carregar<ModApt>('lib/marketing/automacoes/aptidao.ts').empresaApta(...a) };
function txEmpresa(status: string) {
  const sqls: string[] = [];
  return { sqls, async query(sql: string) { sqls.push(sql); return sql.includes('FROM empresas') ? { rows: [{ status }], rowCount: 1 } : { rows: [], rowCount: 0 }; } };
}
const deps = (recurso: boolean | Error, nivel: string | Error) => ({
  recursoIncluido: async () => { if (recurso instanceof Error) throw recurso; return recurso; },
  lerEstadoComercial: async () => { if (nivel instanceof Error) throw nivel; return { acesso: { nivel } }; },
});

test('R2: aptidão segue as regras do produto — status, recurso MARKETING e situação comercial; falha de leitura nunca libera', async () => {
  assert.deepEqual(await apt.empresaApta(txEmpresa('ATIVA'), EMPRESA, deps(true, 'COMPLETO')), { apta: true });
  assert.deepEqual(await apt.empresaApta(txEmpresa('SUSPENSA'), EMPRESA, deps(true, 'COMPLETO')), { apta: false, motivo: 'EMPRESA_NAO_ATIVA', definitivo: true });
  assert.deepEqual(await apt.empresaApta(txEmpresa('ATIVA'), EMPRESA, deps(false, 'COMPLETO')), { apta: false, motivo: 'SEM_RECURSO_MARKETING', definitivo: true });
  assert.deepEqual(await apt.empresaApta(txEmpresa('ATIVA'), EMPRESA, deps(true, 'BLOQUEADO')), { apta: false, motivo: 'ACESSO_COMERCIAL_BLOQUEADO', definitivo: true });
  assert.deepEqual(await apt.empresaApta(txEmpresa('ATIVA'), EMPRESA, deps(true, 'SOMENTE_LEITURA')), { apta: false, motivo: 'ACESSO_COMERCIAL_SOMENTE_LEITURA', definitivo: true });
  const falha = txEmpresa('ATIVA');
  assert.deepEqual(await apt.empresaApta(falha, EMPRESA, deps(new Error('plano ilegível'), 'COMPLETO')), { apta: false, motivo: 'LEITURA_DO_DIREITO_FALHOU', definitivo: false });
  assert.ok(falha.sqls.includes('ROLLBACK TO SAVEPOINT marketing_aptidao'), 'erro de leitura não aborta a transação do motor');
});

function motorComAptidao(aptidao: { apta: boolean; motivo?: string; definitivo?: boolean }, acao: 'TAREFA_INTERNA' | 'MENSAGEM_WHATSAPP') {
  const efeitos = { tarefas: 0, envios: 0, regrasLidas: 0, updates: [] as unknown[][] };
  let token = '';
  const regra = { id: CONTATO, tipo: 'PROPOSTA_PARADA', estabelecimento_id: null, status: 'ATIVA', acao, espera_dias: 3, janela_inicio: '00:00', janela_fim: '23:59',
    fuso: 'America/Sao_Paulo', fim_de_semana: true, limite_frequencia_dias: 30, max_tentativas: 3, template_texto: 'Olá {{nome}}. PARAR', template_provedor: 'modelo_v1',
    template_revisado_em: '2026-10-01', versao: 1 };
  const tx = { async query(sql: string, p: unknown[] = []) {
    if (sql.includes('SELECT DISTINCT r.empresa_id')) return { rows: [{ empresa_id: EMPRESA }], rowCount: 1 };
    if (sql.includes('FROM marketing_automacao_regras WHERE empresa_id')) { efeitos.regrasLidas++; return { rows: [], rowCount: 0 }; }
    if (sql.includes('WITH alvo AS')) { token = String(p[2]); return { rows: [{ id: CONTATO, empresa_id: EMPRESA }], rowCount: 1 }; }
    if (sql.includes('SELECT id::text, empresa_id::text, regra_id::text')) return { rows: [{ id: CONTATO, empresa_id: EMPRESA, regra_id: CONTATO, acao, alvo_tipo: 'FECHAMENTO',
      alvo_id: CONTATO, cliente_id: CLIENTE, fechamento_id: CONTATO, chave_idempotencia: 'r:a:x:c', estado: 'PROCESSANDO', tentativas: 0, max_tentativas: 3, posse_token: token }], rowCount: 1 };
    if (sql.includes('SELECT estado, posse_token::text, tentativas, max_tentativas')) return { rows: [{ estado: 'ENVIANDO', posse_token: token, tentativas: 0, max_tentativas: 3 }], rowCount: 1 };
    if (sql.includes('FROM marketing_automacao_regras WHERE id')) return { rows: [regra], rowCount: 1 };
    if (sql.includes('INSERT INTO marketing_tarefas')) { efeitos.tarefas++; return { rows: [], rowCount: 1 }; }
    if (sql.includes('UPDATE marketing_automacao_execucoes')) { efeitos.updates.push(p); return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  } };
  const motor = carregarModulo('lib/marketing/automacoes/motor.ts', {
    'marketing/automacoes/aptidao': { empresaApta: async () => aptidao },
    'marketing/automacoes/alvos': { alvoContinuaElegivel: async () => ({ clienteNome: 'Pessoa', dataFesta: '2026-11-10' }), alvosParaPlanejar: async () => [],
      alvosParaSimular: async () => [], totalDeAlvos: async () => 0, chaveExecucao: () => 'x', cicloDaChave: () => 'c', LIMITE_PLANEJAMENTO: 500 },
    'marketing/automacoes/preferencias': { elegivelParaMensagem: async () => ({ ok: true, telefone: '5511988887777', autorizacaoId: 'a1' }), lerPreferencia: async () => null },
    'perfil/nome-publico': { nomePublicoDaEmpresa: async () => 'Buffet' },
  }) as unknown as { executarCiclo(b: unknown, t: unknown, agora: Date): Promise<{ planejamento: { bloqueadas: unknown[] }; resultados: Record<string, number> }> };
  const transporte = { nome: 'SIMULADO', simulado: true, enviar: async () => { efeitos.envios++; return { provedorMensagemId: 'sim_x' }; } };
  return { efeitos, rodar: () => motor.executarCiclo({ transacao: async (w: (t: unknown) => unknown) => w(tx) }, transporte, new Date('2026-10-15T15:00:00Z')) };
}

test('R2 (cenário do parecer): pendente de empresa que perdeu a aptidão não gera tarefa nem mensagem; fica CANCELADA com motivo', async () => {
  for (const acao of ['TAREFA_INTERNA', 'MENSAGEM_WHATSAPP'] as const) {
    const m = motorComAptidao({ apta: false, motivo: 'EMPRESA_NAO_ATIVA', definitivo: true }, acao);
    const r = await m.rodar();
    assert.equal(m.efeitos.regrasLidas, 0, `${acao}: planejamento não lê regras de empresa inapta`);
    assert.deepEqual(r.planejamento.bloqueadas, [{ empresaId: EMPRESA, motivo: 'EMPRESA_NAO_ATIVA' }]);
    assert.equal(m.efeitos.tarefas, 0, `${acao}: nenhuma tarefa`);
    assert.equal(m.efeitos.envios, 0, `${acao}: nada no transporte`);
    assert.deepEqual(r.resultados, { CANCELADA: 1 });
    assert.ok(m.efeitos.updates.some((p) => p.includes('CANCELADA') && p.includes('EMPRESA_INAPTA: EMPRESA_NAO_ATIVA')), 'motivo auditável');
  }
});

test('R2: falha ao ler o direito não age e volta para a fila; empresa apta segue normal', async () => {
  const falha = motorComAptidao({ apta: false, motivo: 'LEITURA_DO_DIREITO_FALHOU', definitivo: false }, 'MENSAGEM_WHATSAPP');
  const r = await falha.rodar();
  assert.deepEqual(r.resultados, { AGUARDANDO_DIREITO: 1 });
  assert.equal(falha.efeitos.envios, 0);
  const ok = motorComAptidao({ apta: true }, 'TAREFA_INTERNA');
  assert.deepEqual((await ok.rodar()).resultados, { TAREFA_CRIADA: 1 });
  assert.equal(ok.efeitos.tarefas, 1);
  const msg = motorComAptidao({ apta: true }, 'MENSAGEM_WHATSAPP');
  assert.deepEqual((await msg.rodar()).resultados, { ACEITA: 1 });
  assert.equal(msg.efeitos.envios, 1);
});

// ---------------------------------------------------------------------------------------------------------------
// R3 — receita desconhecida não é zero
// ---------------------------------------------------------------------------------------------------------------
const periodo = { de: '2026-10-01', ate: '2026-10-31', unidadeId: null };
const vazio = { cliques: [], contatos: [], negociacoes: [], cancelados: [], recebido: [], campanhas: [], negociacoesSemOrigem: 0 };
const C1 = 'c1111111-1111-4111-8111-111111111111', C2 = 'c2222222-2222-4222-8222-222222222222';

test('R3: nenhum contrato, zero legítimo, só desconhecido, misto e campanhas diferentes', () => {
  const { montarPainel, situacaoReceita } = carregar<ModMetricas>('lib/marketing/metricas.ts');
  const { receitaContratadaTexto } = carregar<ModApresentacao>('lib/marketing/apresentacao.ts');
  assert.deepEqual([situacaoReceita(0, 0), situacaoReceita(2, 0), situacaoReceita(2, 1), situacaoReceita(2, 2)], ['COMPLETA', 'COMPLETA', 'PARCIAL', 'INDISPONIVEL']);
  const nenhum = montarPainel(periodo, { ...vazio, contratos: [] });
  assert.deepEqual([nenhum.total.receitaContratadaCentavos, nenhum.total.receitaContratadaSituacao], [0, 'COMPLETA']);
  const zero = montarPainel(periodo, { ...vazio, contratos: [{ campanha_id: C1, origem_codigo: 'INSTAGRAM', n: '1', valor: '0', extra: '0' }] });
  assert.deepEqual([zero.total.receitaContratadaCentavos, zero.total.receitaContratadaSituacao], [0, 'COMPLETA'], 'zero real continua zero');
  const desconhecido = montarPainel(periodo, { ...vazio, contratos: [{ campanha_id: null, origem_codigo: null, n: '1', valor: '0', extra: '1' }] });
  assert.equal(desconhecido.total.receitaContratadaCentavos, null, 'cenário do parecer: não vira R$ 0,00');
  assert.deepEqual([desconhecido.total.contratos, desconhecido.total.contratosSemValor, desconhecido.total.receitaContratadaSituacao], [1, 1, 'INDISPONIVEL']);
  assert.equal(receitaContratadaTexto(desconhecido.total), 'indisponível (1 sem valor)');
  const misto = montarPainel(periodo, { ...vazio, contratos: [
    { campanha_id: C1, origem_codigo: 'INSTAGRAM', n: '3', valor: '900000', extra: '1' },
    { campanha_id: C2, origem_codigo: 'GOOGLE', n: '2', valor: '500000', extra: '0' },
  ] });
  const l1 = misto.linhas.find((l) => l.campanhaId === C1)!, l2 = misto.linhas.find((l) => l.campanhaId === C2)!;
  assert.deepEqual([l1.receitaContratadaCentavos, l1.contratosSemValor, l1.receitaContratadaSituacao], [900000, 1, 'PARCIAL']);
  assert.deepEqual([l2.receitaContratadaCentavos, l2.receitaContratadaSituacao], [500000, 'COMPLETA']);
  assert.deepEqual([misto.total.receitaContratadaCentavos, misto.total.contratosSemValor, misto.total.receitaContratadaSituacao], [1400000, 1, 'PARCIAL'], 'incompletude chega ao total');
  assert.match(receitaContratadaTexto(l1), /^R\$\s?9\.000,00 \(subtotal; 1 sem valor\)$/);
  assert.equal(misto.total.contratos, 5, 'toque único preservado: cada contrato em uma linha');
});

// ---------------------------------------------------------------------------------------------------------------
// R4 — forma das consultas (a prova de avanço real é a suíte PostgreSQL com 501 alvos)
// ---------------------------------------------------------------------------------------------------------------
test('R4: planejar exclui pela chave completa ANTES do limite, com desempate; revalidar e simular não usam a exclusão', () => {
  const { consultaDe } = carregar<ModAlvos>('lib/marketing/automacoes/alvos.ts');
  for (const tipo of ['PROPOSTA_PARADA', 'POS_FESTA', 'RECOMPRA'] as const) {
    const p = consultaDe(tipo, { tipo: 'PLANEJAR', regraId: 'r', acao: 'TAREFA_INTERNA', limite: 500 })!;
    assert.match(p.sql, /NOT EXISTS \(SELECT 1 FROM marketing_automacao_execucoes e[\s\S]*chave_idempotencia = \$5::text \|\| ':' \|\| \$6::text \|\| ':' \|\| x\.alvo_id \|\| ':' \|\| x\.ciclo\)[\s\S]*ORDER BY x\.ordem, x\.alvo_id LIMIT \$7::int/, tipo);
    assert.deepEqual(p.extra, ['r', 'TAREFA_INTERNA', 500]);
    const rv = consultaDe(tipo, { tipo: 'REVALIDAR', alvoId: 'x' })!;
    assert.ok(!rv.sql.includes('marketing_automacao_execucoes'), `${tipo}: revalidação confirma alvo já agendado`);
    const s = consultaDe(tipo, { tipo: 'SIMULAR', limite: 50 })!;
    assert.ok(!s.sql.includes('marketing_automacao_execucoes') && s.extra[0] === 50, `${tipo}: simulação com limite próprio`);
  }
  assert.equal(consultaDe('DATAS_VAGAS', { tipo: 'SIMULAR', limite: 50 }), null);
});

// ---------------------------------------------------------------------------------------------------------------
// Achado na validação de UI (15/10/2026): seletor de cliente do Marketing não lia o formato da busca do CRM
// ---------------------------------------------------------------------------------------------------------------
test('UI: busca de cliente com termo ({ cliente }) e sem termo (direto) aparecem nos seletores de Preferências e Origens', () => {
  const { clientesDaBusca } = carregar<ModApresentacao>('lib/marketing/apresentacao.ts');
  assert.deepEqual(clientesDaBusca({ ok: true, data: [{ cliente: { id: CLIENTE, nomeCompleto: 'Xênia' }, cadastroCompleto: false, camposFaltantes: [] }] }), [{ id: CLIENTE, nome: 'Xênia' }]);
  assert.deepEqual(clientesDaBusca({ ok: true, data: [{ id: CLIENTE, nomeCompleto: 'Rita' }] }), [{ id: CLIENTE, nome: 'Rita' }]);
  assert.deepEqual(clientesDaBusca({ ok: true, data: { itens: [{ id: CLIENTE, nome_completo: 'Legado' }] } }), [{ id: CLIENTE, nome: 'Legado' }]);
  assert.deepEqual([clientesDaBusca(null), clientesDaBusca({ ok: false }), clientesDaBusca({ data: [{ cliente: {} }] })], [[], [], []], 'sem id não vira botão');
});
