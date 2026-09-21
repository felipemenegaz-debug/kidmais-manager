import type { DbExecutor } from '../../db/contracts';
import { db } from '../../db/postgres';
import type { ContratoVersaoRecord } from '../repositories';
import type { Edicao, fontesEdicao } from './administrativo.service';
import type { EdicaoFestaInput } from '../../fechamentos/services/edicao-administrativa-schema';
import { calcularEdicaoFechamento } from '../../fechamentos/services/edicao-administrativa.service';
import { persistirEdicaoFechamento } from '../../fechamentos/repositories/edicao.repository';
import { buscarFechamentoPorId, listarAdicionaisDoFechamento, type FechamentoAdicionalRecord } from '../../fechamentos/repositories';
import { buscarResponsavelPorId, registrarAuditoria } from '../../clientes/repositories';
import { validarCadastroBasicoCliente } from '../../clientes/services/validators';
import { adquirirLockConfirmacaoAgenda } from '../../disponibilidade/repositories';
import { consultarDisponibilidadeData } from '../../disponibilidade/services';
import { montarSnapshotContratoV1 } from './contrato.service';
import { hashSnapshotContrato } from './snapshot-core';
import { ContratoServiceError } from './errors';

type Fonte = Awaited<ReturnType<typeof fontesEdicao>>;
export type RevisaoInicial = {
    fechamento: Fonte['fechamento'];
    cliente: NonNullable<Fonte['cliente']>;
    aniversariante: NonNullable<Fonte['aniversariante']>;
    resumo: Awaited<ReturnType<typeof calcularEdicaoFechamento>>['resumo'];
    baseHash: string;
    motivo: string;
};
function recusar(message: string): never {
    throw new ContratoServiceError('DADOS_CONTRATUAIS_INCONSISTENTES', message, 409);
}

export function exigirVersaoEditavel(v: Pick<ContratoVersaoRecord, 'id' | 'contratoId' | 'status'>,
    e: Pick<Edicao, 'contrato_id' | 'contrato_versao_id' | 'estado'> | null, contratoId: string,
    preparacaoId: string | null | undefined, possuiAssinatura: boolean) {
    if (v.contratoId !== contratoId || e?.contrato_id !== contratoId || e.contrato_versao_id !== v.id
        || preparacaoId !== v.id || v.status !== 'ATIVA' || e.estado !== 'EM_ELABORACAO' || possuiAssinatura)
        recusar('Versão assinada, encerrada ou fora da revisão ativa não pode ser editada. Crie uma nova revisão.');
}

/** Estado da proposta pertence à edição; não é ocupação nem revisão operacional 014. */
export async function fonteDaRevisaoInicial(v: ContratoVersaoRecord, fonte: Fonte, tx: DbExecutor = db()): Promise<Fonte> {
    const e = (await tx.query<{ dados_fonte: { revisaoInicial?: RevisaoInicial } }>(
        'SELECT dados_fonte FROM contrato_edicoes WHERE contrato_versao_id=$1', [v.id])).rows[0];
    const proposta = e?.dados_fonte.revisaoInicial;
    if (!proposta) return fonte;
    return { fechamento: proposta.fechamento, cliente: proposta.cliente, aniversariante: proposta.aniversariante,
        adicionais: proposta.resumo.adicionais.itens.map(a => ({ codigo: a.codigo, quantidade: a.quantidade })),
        fonteHash: hashSnapshotContrato({ versao: v.id, snapshot: v.snapshotHash, proposta }) };
}

export async function prepararEdicaoInicial(tx: DbExecutor, v: ContratoVersaoRecord, e: Edicao, fonte: Fonte, input: EdicaoFestaInput) {
    if (fonte.fonteHash !== input.fonteHash) recusar('A revisão mudou. Reabra a edição antes de salvar.');
    if (!fonte.cliente || !fonte.aniversariante) recusar('Vínculos da revisão incompletos.');
    const { fechamento, resumo } = await calcularEdicaoFechamento(fonte.fechamento, input, tx);
    const cliente = { ...fonte.cliente, ...input.cliente };
    const aniversariante = { ...fonte.aniversariante, ...input.aniversariante };
    validarCadastroBasicoCliente(cliente);
    const adicionais = resumo.adicionais.itens.map(a => ({ adicionalId: a.adicionalId, precoAdicionalId: a.precoRegraId,
        nomeAplicado: a.nome, unidadeCobrancaAplicada: a.unidadeCobranca, quantidade: a.quantidade,
        valorUnitarioAplicado: a.valorUnitarioAplicado, valorTotal: a.valorTotal,
        observacoes: v.snapshot.contratacao.adicionais.find(x => x.adicionalId === a.adicionalId)?.observacoes ?? null } as FechamentoAdicionalRecord));
    const pacote = resumo.pacote.pacote, tabela = resumo.pacote.tabelaPreco;
    const snapshot = montarSnapshotContratoV1({ fechamento, cliente, aniversariante, adicionais,
        responsavelAdicional: fechamento.responsavelAdicionalId ? await buscarResponsavelPorId(fechamento.responsavelAdicionalId, tx) : null,
        referencias: { pacoteId: pacote.id, pacoteCodigo: pacote.codigo, pacoteNome: pacote.nome, pacoteDuracaoMinutos: pacote.duracaoMinutos,
            tabelaPrecoId: tabela.id, tabelaPrecoCodigo: tabela.codigo, tabelaPrecoNome: tabela.nome } });
    const baseHash = e.dados_fonte.revisaoInicial?.baseHash ?? hashSnapshotContrato({
        fechamento: await buscarFechamentoPorId(fechamento.id, tx), adicionais: await listarAdicionaisDoFechamento(fechamento.id, tx) });
    const proposta: RevisaoInicial = { fechamento, cliente, aniversariante, resumo, baseHash, motivo: input.motivo };
    return { proposta, snapshot: { ...snapshot, documental: { observacoes: e.dados_fonte.observacoesDocumentais ?? '' } } };
}

/** Executada após a segunda assinatura, dentro da transação que cria a Festa. */
export async function aplicarRevisaoInicial(tx: DbExecutor, v: ContratoVersaoRecord, proposta: RevisaoInicial) {
    const fluxo = (await tx.query<{ versao_vigente_id: string | null; versao_em_preparacao_id: string | null }>(
        'SELECT versao_vigente_id,versao_em_preparacao_id FROM contrato_fluxos WHERE contrato_id=$1 FOR UPDATE', [v.contratoId])).rows[0];
    const provas = (await tx.query('SELECT parte FROM contrato_assinaturas WHERE contrato_versao_id=$1', [v.id])).rows;
    if (fluxo?.versao_vigente_id || fluxo?.versao_em_preparacao_id !== v.id || v.status !== 'ASSINADA'
        || provas.length !== 2 || !provas.some(p => p.parte === 'KIDMAIS') || !provas.some(p => p.parte === 'CLIENTE'))
        recusar('A proposta inicial exige dupla assinatura e nenhuma vigência anterior.');
    const atual = await buscarFechamentoPorId(v.snapshot.fechamento.id, tx);
    if (!atual || proposta.fechamento.id !== atual.id || atual.clienteId !== proposta.fechamento.clienteId
        || atual.aniversarianteId !== proposta.fechamento.aniversarianteId) recusar('Vínculos da proposta divergentes.');
    if (hashSnapshotContrato({ fechamento: atual, adicionais: await listarAdicionaisDoFechamento(atual.id, tx) }) !== proposta.baseHash)
        recusar('O fechamento mudou durante a preparação. Revise a proposta antes de formalizar.');
    for (const dia of [...new Set([atual.dataEvento, proposta.fechamento.dataEvento])].sort()) await adquirirLockConfirmacaoAgenda(dia, tx);
    const f = proposta.fechamento;
    const disponibilidade = await consultarDisponibilidadeData(f.dataEvento, tx);
    if (!disponibilidade.periodos.find(p => p.configuracaoId === f.configuracaoAgendaId)?.horarios.some(h =>
        h.status === 'DISPONIVEL' && h.inicio === f.horarioInicio.slice(0, 5) && h.fim === f.horarioFim.slice(0, 5)))
        recusar('Data/horário da proposta indisponível. Nenhuma alteração foi aplicada.');
    await persistirEdicaoFechamento(tx, f, proposta.resumo);
    await registrarAuditoria({ clienteId: f.clienteId, atorTipo: 'SISTEMA', acao: 'CONTRATO_REVISAO_INICIAL_APLICADA',
        entidadeTipo: 'CONTRATO_VERSAO', entidadeId: v.id, origem: 'CONTRATO_PUBLICO', dadosAntes: atual,
        dadosDepois: { fechamento: f, snapshotHash: v.snapshotHash }, justificativa: proposta.motivo }, tx);
}
