import test from 'node:test';
import assert from 'node:assert/strict';
import { chaveConferencia, dataPorExtenso, erroPagamentos, etapaAtual, faixaHorario, predicados, referenciasDaTela, rotuloVersao, saidaPagamentos, situacaoReserva, tituloFesta, type PainelTela, type RevisaoOperacionalTela, type VersaoTela } from './contrato-tela.ts';

type Dados = PainelTela<VersaoTela>;
const STATUS_V = ['ATIVA', 'SUBSTITUIDA', 'ASSINADA', 'CANCELADA'];
const EDICAO = [null, 'EM_ELABORACAO', 'ASSINADA_KIDMAIS', 'AGUARDANDO_CLIENTE', 'CONCLUIDA', 'CANCELADA'];
const STATUS_C = ['ASSINADO', 'AGUARDANDO_ASSINATURA', 'CANCELADO'];
const REVISAO = ['EM_ELABORACAO', 'CONGELADA', 'APLICADA', 'CANCELADA'];

/** Predicados copiados literalmente da tela anterior (components/admin/ContratoAdmin.tsx em staging 22d4ac30). */
function antigo(data: Dados, v: VersaoTela) {
  const vid = v.id, docs = data.documentos.filter(d => d.contrato_versao_id === vid);
  const revisaoOperacional = data.revisoesOperacionais.find(r => r.contrato_versao_id === vid);
  return {
    podeSubstituir: v?.status === 'ATIVA' && data?.contrato.status !== 'CANCELADO' && data?.fluxo?.versao_em_preparacao_id === v.id && ['ASSINADA_KIDMAIS', 'AGUARDANDO_CLIENTE'].includes(v.estado_edicao ?? ''),
    podeRevisar: data?.contrato.status === 'ASSINADO' && v?.status === 'ASSINADA' && (!data.fluxo || data.fluxo.versao_vigente_id === v.id),
    podeCancelarRevisao: v?.status === 'ATIVA' && data?.contrato.status !== 'CANCELADO' && data?.fluxo?.versao_em_preparacao_id === v.id && ['EM_ELABORACAO', 'ASSINADA_KIDMAIS', 'AGUARDANDO_CLIENTE'].includes(v.estado_edicao ?? ''),
    podeEditar: v.estado_edicao === 'EM_ELABORACAO',
    podeRevisarPdf: docs.some(d => d.categoria === 'CONTRATO' && d.revisao === v.revisao) && v.estado_edicao === 'EM_ELABORACAO',
    podeAssinar: v.estado_edicao === 'EM_ELABORACAO' && !!v.documento_revisado_id,
    podeLiberar: v.estado_edicao === 'ASSINADA_KIDMAIS',
    podeAbrirPublico: v?.estado_edicao === 'AGUARDANDO_CLIENTE' && data.contrato.status !== 'CANCELADO',
    podeRecusarComercial: revisaoOperacional?.estado === 'EM_ELABORACAO',
    podeRevalidar: !!revisaoOperacional && ['EM_ELABORACAO', 'CONGELADA'].includes(revisaoOperacional.estado),
    cancelamento: data.contrato.status !== 'CANCELADO' && (data.festaId ? 'FESTA' : data.contrato.status === 'AGUARDANDO_ASSINATURA' && !data.fluxo?.versao_vigente_id ? 'CONTRATACAO_INICIAL' : null) || null,
  };
}

function aleatorio(semente: number) { let s = semente; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; }
function painel(r: () => number): Dados {
  const um = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const n = 1 + Math.floor(r() * 3);
  const versoes: VersaoTela[] = Array.from({ length: n }, (_, i) => ({ id: `v${i + 1}`, numero_versao: i + 1, status: um(STATUS_V), estado_edicao: um(EDICAO), revisao: 1 + Math.floor(r() * 2), documento_revisado_id: r() < 0.4 ? `d${i}` : null }));
  const ponteiro = () => r() < 0.3 ? null : um(versoes).id;
  return {
    contrato: { status: um(STATUS_C) },
    fluxo: r() < 0.2 ? null : { versao_vigente_id: ponteiro(), versao_em_preparacao_id: ponteiro() },
    versoes,
    documentos: versoes.filter(() => r() < 0.5).map(v => ({ contrato_versao_id: v.id, categoria: r() < 0.7 ? 'CONTRATO' : 'COMPROVANTE_ASSINATURA', revisao: 1 + Math.floor(r() * 2) })),
    revisoesOperacionais: versoes.filter(() => r() < 0.5).map(v => ({ contrato_versao_id: v.id, estado: um(REVISAO), hold_destino_adquirido_em: null, ocupa_vigente: true, slot_alterado: false, data_evento: '2027-04-20', data_vigente: '2027-04-20', horario_inicio: '10:00:00', horario_fim: '14:00:00' })),
    festaId: r() < 0.5 ? 'festa' : null,
  };
}

test('predicados de cada ação são iguais aos da tela anterior com o seletor na mesma versão (5000 painéis)', () => {
  const r = aleatorio(20261023);
  for (let i = 0; i < 5000; i++) {
    const data = painel(r);
    for (const v of data.versoes) {
      const novo = predicados(data, v), velho = antigo(data, v);
      for (const k of Object.keys(velho) as Array<keyof typeof velho>) assert.equal(novo[k], velho[k], `${k} em ${JSON.stringify(data)} / ${v.id}`);
    }
  }
});

const base = (versoes: VersaoTela[], fluxo: Dados['fluxo'], status = 'ASSINADO', revisoes: RevisaoOperacionalTela[] = []): Dados => ({ contrato: { status }, fluxo, versoes, documentos: [], revisoesOperacionais: revisoes, festaId: null });
const ver = (n: number, status: string, estado: string | null): VersaoTela => ({ id: `v${n}`, numero_versao: n, status, estado_edicao: estado, revisao: 1, documento_revisado_id: null });

test('alvo de ação: preparação ativa → vigente → maior ATIVA → nenhum; mudanças intencionais documentadas', () => {
  // Alteração aberta: topo na vigente, ações na preparação.
  let t = referenciasDaTela(base([ver(2, 'ATIVA', 'EM_ELABORACAO'), ver(1, 'ASSINADA', 'CONCLUIDA')], { versao_vigente_id: 'v1', versao_em_preparacao_id: 'v2' }));
  assert.equal(t.referencia!.versao.id, 'v1'); assert.equal(t.alvo!.id, 'v2');
  // Revisão descartada: hoje a tela abria na V2 cancelada; agora topo e alvo são a V1 vigente (pode "Alterar contrato").
  t = referenciasDaTela(base([ver(2, 'CANCELADA', 'CANCELADA'), ver(1, 'ASSINADA', 'CONCLUIDA')], { versao_vigente_id: 'v1', versao_em_preparacao_id: null }));
  assert.equal(t.alvo!.id, 'v1'); assert.equal(predicados(base([ver(2, 'CANCELADA', 'CANCELADA'), ver(1, 'ASSINADA', 'CONCLUIDA')], { versao_vigente_id: 'v1', versao_em_preparacao_id: null }), t.alvo).podeRevisar, true);
  // Legado sem fluxo: maior ASSINADA.
  t = referenciasDaTela(base([ver(3, 'ATIVA', null), ver(2, 'ASSINADA', null), ver(1, 'SUBSTITUIDA', null)], null));
  assert.equal(t.referencia!.versao.id, 'v2'); assert.equal(t.alvo!.id, 'v2');
  // Contratação inicial: referência e alvo são a preparação.
  t = referenciasDaTela(base([ver(1, 'ATIVA', 'EM_ELABORACAO')], { versao_vigente_id: null, versao_em_preparacao_id: 'v1' }, 'AGUARDANDO_ASSINATURA'));
  assert.equal(t.referencia!.origem, 'PREPARACAO_INICIAL'); assert.equal(t.alvo!.id, 'v1');
  // Contrato cancelado com vigente: sem alvo (nenhuma ação de versão).
  t = referenciasDaTela(base([ver(1, 'ASSINADA', 'CONCLUIDA')], { versao_vigente_id: 'v1', versao_em_preparacao_id: null }, 'CANCELADO'));
  assert.equal(t.alvo, null); assert.equal(predicados(base([ver(1, 'ASSINADA', 'CONCLUIDA')], null, 'CANCELADO'), null).cancelamento, null);
  // Só versões inválidas: diagnóstico e nenhum alvo.
  t = referenciasDaTela(base([ver(2, 'CANCELADA', null), ver(1, 'SUBSTITUIDA', null)], null));
  assert.equal(t.referencia!.diagnostico, 'SEM_VERSAO_VALIDA'); assert.equal(t.alvo, null);
  // Preparação congelada mas revisão operacional já aplicada: não é mais ativa → alvo volta à vigente.
  t = referenciasDaTela(base([ver(2, 'ATIVA', 'AGUARDANDO_CLIENTE'), ver(1, 'ASSINADA', 'CONCLUIDA')], { versao_vigente_id: 'v1', versao_em_preparacao_id: 'v2' }, 'ASSINADO', [{ contrato_versao_id: 'v2', estado: 'APLICADA', hold_destino_adquirido_em: null, ocupa_vigente: true, slot_alterado: false, data_evento: '', data_vigente: '', horario_inicio: '', horario_fim: '' }]));
  assert.equal(t.alvo!.id, 'v1');
});

test('cancelamento: festaId tem precedência; contratação inicial sem festa usa cancelar_contratacao', () => {
  const inicial = base([ver(1, 'ATIVA', 'EM_ELABORACAO')], { versao_vigente_id: null, versao_em_preparacao_id: 'v1' }, 'AGUARDANDO_ASSINATURA');
  assert.equal(predicados(inicial, inicial.versoes[0]).cancelamento, 'CONTRATACAO_INICIAL');
  assert.equal(predicados({ ...inicial, festaId: 'f' }, inicial.versoes[0]).cancelamento, 'FESTA');
});

test('matriz da agenda descreve só a reserva e nunca afirma disponibilidade', () => {
  const r = (x: Partial<RevisaoOperacionalTela>): RevisaoOperacionalTela => ({ contrato_versao_id: 'v', estado: 'EM_ELABORACAO', hold_destino_adquirido_em: null, ocupa_vigente: true, slot_alterado: false, data_evento: '', data_vigente: '', horario_inicio: '', horario_fim: '', ...x });
  assert.equal(situacaoReserva(null), null);
  assert.equal(situacaoReserva(r({ estado: 'APLICADA' })), null);
  assert.equal(situacaoReserva(r({ ocupa_vigente: false }))!.tipo, 'PROPOSTA');
  // Horário histórico preservado, nativo não oferecido, salão inelegível com mesmo horário: slot inalterado = só "mantidos".
  assert.equal(situacaoReserva(r({}))!.tipo, 'MANTIDA');
  assert.equal(situacaoReserva(r({ estado: 'CONGELADA', hold_destino_adquirido_em: 'x' }))!.tipo, 'MANTIDA');
  assert.equal(situacaoReserva(r({ slot_alterado: true, hold_destino_adquirido_em: 'x' }))!.tipo, 'PROTEGIDA');
  const sem = situacaoReserva(r({ slot_alterado: true }))!;
  assert.equal(sem.tipo, 'SEM_PROTECAO'); assert.equal(sem.alerta, true);
  for (const x of [r({}), r({ slot_alterado: true, hold_destino_adquirido_em: 'x' }), r({ ocupa_vigente: false })]) assert.doesNotMatch(situacaoReserva(x)!.texto, /dispon[ií]vel/i);
});

test('pagamentos: 0 / 1 / 2+ pelo detalhe e saída para cada código de recusa', () => {
  assert.equal(saidaPagamentos(2, null), 'MULTIPLOS'); assert.equal(saidaPagamentos(1, 'AGUARDAR_REVISAO'), 'CARREGAR');
  assert.equal(saidaPagamentos(0, 'AGUARDAR_REVISAO'), 'AGUARDAR_REVISAO'); assert.equal(saidaPagamentos(0, 'CONFERIR_HISTORICO'), 'CONFERIR_HISTORICO');
  assert.equal(saidaPagamentos(0, 'PLANO_NA_VERSAO_VIGENTE'), 'CRIAR_PLANO'); assert.equal(saidaPagamentos(0, null), 'CRIAR_PLANO');
  for (const c of ['SNAPSHOT_DIVERGENTE', 'DADOS_INVALIDOS', 'POSICAO_INCONSISTENTE', 'CREDITO_RESERVADO_INCOMPATIVEL', 'OBRIGACAO_NAO_DISPONIVEL']) assert.equal(erroPagamentos(409, c, true).tipo, 'CONFERENCIA');
  assert.equal(erroPagamentos(409, 'VERSAO_NAO_VIGENTE', false).tipo, 'SEM_ASSINATURA'); assert.equal(erroPagamentos(409, 'VERSAO_NAO_VIGENTE', true).tipo, 'CONFERENCIA');
  assert.equal(erroPagamentos(401, null, true).tipo, 'SESSAO'); assert.equal(erroPagamentos(403, null, true).tipo, 'PERMISSAO');
  assert.equal(erroPagamentos(404, 'RECURSO_NAO_ENCONTRADO', true).tipo, 'NAO_ENCONTRADO'); assert.equal(erroPagamentos(500, 'ERRO_PAGAMENTO', true).tipo, 'TENTAR'); assert.equal(erroPagamentos(0, null, true).tipo, 'TENTAR');
  for (const c of ['SNAPSHOT_DIVERGENTE', 'VERSAO_NAO_VIGENTE']) assert.doesNotMatch(erroPagamentos(409, c, true).texto, /criar|plano/i);
});

test('título (D6), datas e horários em pt-BR, etapas e chave da confirmação', () => {
  const c = { nomeCompleto: 'Felipe Marra Menegaz' };
  assert.deepEqual(tituloFesta({ contratante: c, aniversariante: { nome: 'Helena', idadeNoEvento: 6, temaFesta: 'Frozen' } }), { titulo: 'Aniversário de Helena', idade: '6 anos', tema: 'Frozen', aniversariante: 'Helena' });
  assert.equal(tituloFesta({ contratante: c, aniversariante: { nome: 'Bia', idadeNoEvento: 0, temaFesta: null } }).idade, '0 anos');
  assert.equal(tituloFesta({ contratante: c, aniversariante: { nome: 'Bia', idadeNoEvento: 1, temaFesta: ' ' } }).idade, '1 ano');
  assert.deepEqual(tituloFesta({ contratante: c, aniversariante: { nome: ' ', idadeNoEvento: null, temaFesta: null } }), { titulo: 'Felipe Marra Menegaz', idade: null, tema: null, aniversariante: null });
  assert.equal(dataPorExtenso('2027-04-20'), 'ter, 20 abr 2027'); assert.equal(dataPorExtenso('2027-02-30'), '2027-02-30');
  assert.equal(faixaHorario('10:00:00', '14:30:00'), '10h às 14h30');
  assert.equal(rotuloVersao({ status: 'ATIVA', estado_edicao: 'EM_ELABORACAO' }), 'Em preparação'); assert.equal(rotuloVersao({ status: 'ASSINADA', estado_edicao: 'CONCLUIDA' }), 'Assinada');
  const prep = (estado: string, revisado = false): VersaoTela => ({ ...ver(2, 'ATIVA', estado), documento_revisado_id: revisado ? 'd' : null });
  assert.equal(etapaAtual(prep('EM_ELABORACAO'), true, null).atual, 0); assert.equal(etapaAtual(prep('EM_ELABORACAO', true), true, null).atual, 1);
  assert.equal(etapaAtual(prep('ASSINADA_KIDMAIS'), true, null).atual, 2); assert.equal(etapaAtual(prep('AGUARDANDO_CLIENTE'), true, null).atual, 3);
  assert.deepEqual(etapaAtual(ver(1, 'ASSINADA', 'CONCLUIDA'), true, 'REALIZADA'), { atual: -1, concluidas: 6, mostrarFesta: true });
  for (const e of ['CANCELADA', 'REMOVIDA', null]) assert.equal(etapaAtual(ver(1, 'ASSINADA', 'CONCLUIDA'), true, e).mostrarFesta, false);
  assert.notEqual(chaveConferencia('c', 'v', 1), chaveConferencia('c', 'v', 2)); assert.notEqual(chaveConferencia('c', 'v', 1), chaveConferencia('c2', 'v', 1));
});
