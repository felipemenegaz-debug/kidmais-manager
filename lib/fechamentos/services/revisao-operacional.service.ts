import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '../../db/contracts';
import { db } from '../../db/postgres';
import { buscarFechamentoPorId, buscarFechamentoPorIdParaAtualizacao } from '../repositories';
import type { FechamentoAdicionalRecord } from '../repositories';
import { buscarRevisaoDaVersao, criarRevisaoOperacionalRegistro, listarItensRevisao, salvarOperacaoPreparada, aplicarOperacaoPreparada, type RevisaoOperacional } from '../repositories/revisao.repository';
import { registrarAuditoria, buscarClientePorId, buscarAniversariantePorId, buscarResponsavelPorId } from '../../clientes/repositories';
import { atualizarClienteInterno } from '../../clientes/services';
import { atualizarAniversarianteInterno } from '../../clientes/services/aniversariante.service';
import { calcularResumoComercial } from '../../comercial/services';
import { validarPretensaoPix, centavosComerciais } from '../../comercial/condicao-pagamento';
import { adicionaisIncluidos } from './edicao-administrativa.service';
import type { EdicaoFestaInput } from './edicao-administrativa-schema';
import { consultarDisponibilidadeData } from '../../disponibilidade/services';
import { FechamentoServiceError } from './errors';
import { carregarSnapshot } from '../../contratos/services/contrato.service';
import { hashSnapshotContrato } from '../../contratos/services/snapshot-core';
import type { ContratoVersaoRecord } from '../../contratos/repositories';
type Contexto = {
    usuarioId: string | null;
    validacaoIdentidadeId?: string;
    requestId?: string | null;
    ip?: string | null;
    userAgent?: string | null;
};
function recusar(message: string): never { throw new FechamentoServiceError('DADOS_INVALIDOS', message, 409); }
async function auditar(tx: DbExecutor, r: RevisaoOperacional, c: Contexto, acao: string, antes: unknown, depois: unknown) { await registrarAuditoria({ atorTipo: c.usuarioId ? 'USUARIO' : c.validacaoIdentidadeId ? 'CLIENTE' : 'SISTEMA', usuarioId: c.usuarioId, clienteId: r.operacao.clienteId, entidadeTipo: 'FECHAMENTO_REVISAO', entidadeId: r.id, origem: 'FECHAMENTO_ADMIN', acao, requestId: c.requestId ?? null, ip: c.ip ?? null, userAgent: c.userAgent ?? null, dadosAntes: antes === null ? null : { estado: antes }, dadosDepois: { resultado: depois, validacaoIdentidadeId: c.validacaoIdentidadeId ?? null } }, tx); }
export async function bloquearDatasRevisao(tx: DbExecutor, r: RevisaoOperacional, destino?: string) { const f = (await buscarFechamentoPorIdParaAtualizacao(r.fechamento_id, tx))!; await tx.query('SELECT kidmais_lock_datas_revisao($1::date[])', [[f.dataEvento, r.operacao.dataEvento, ...(destino ? [destino] : [])]]); return f; }
export async function revalidarAgendaRevisao(tx: DbExecutor, r: RevisaoOperacional, c: Contexto, options: {
    naoFalharPorConflito?: boolean;
    mudouDestino?: boolean;
} = {}) {
    const f = await bloquearDatasRevisao(tx, r), op = r.operacao;
    const disponibilidade = await consultarDisponibilidadeData(op.dataEvento, tx, r.fechamento_id);
    const livre = disponibilidade.periodos.find(p => p.configuracaoId === op.configuracaoAgendaId)?.horarios.some(h => h.status === 'DISPONIVEL' && h.inicio === op.horarioInicio.slice(0, 5) && h.fim === op.horarioFim.slice(0, 5)) === true;
    if (!livre) {
        if (options.naoFalharPorConflito) {
            await auditar(tx, r, c, 'REVISAO_DESTINO_EM_CONFLITO', null, { data: op.dataEvento, horarioInicio: op.horarioInicio, horarioFim: op.horarioFim, reservaVigente: f.status });
            return false;
        }
        recusar('Destino da revisão indisponível. A reserva vigente e os recebimentos permanecem preservados.');
    }
    if (f.status === 'CONFIRMADO' && (!r.hold_destino_adquirido_em || options.mudouDestino)) {
        await tx.query('UPDATE fechamento_revisoes SET hold_destino_adquirido_em=clock_timestamp() WHERE id=$1', [r.id]);
        await auditar(tx, r, c, options.mudouDestino ? 'RESERVA_REVISAO_MOVIDA' : 'RESERVA_REVISAO_ADQUIRIDA', { hold: r.hold_destino_adquirido_em }, { data: op.dataEvento, inicio: op.horarioInicio, fim: op.horarioFim });
    }
    return true;
}
export async function revisaoAbertaDoFechamento(fid: string, tx: DbExecutor, lock = false) { const row = (await tx.query<{
    contrato_versao_id: string;
}>(`SELECT contrato_versao_id FROM fechamento_revisoes WHERE fechamento_id=$1 AND estado IN ('EM_ELABORACAO','CONGELADA') ${lock ? 'FOR UPDATE' : ''}`, [fid])).rows[0]; return row ? buscarRevisaoDaVersao(row.contrato_versao_id, tx) : null; }
export async function iniciarPreparacao(tx: DbExecutor, base: ContratoVersaoRecord, v: ContratoVersaoRecord, motivo: string, chave: string, c: Contexto) {
    if (!c.usuarioId)
        recusar('A preparação exige usuário administrativo real.');
    await criarRevisaoOperacionalRegistro(tx, { id: randomUUID(), fechamentoId: base.snapshot.fechamento.id, contratoId: v.contratoId, versaoId: v.id, baseId: base.id, baseHash: base.snapshotHash, motivo, chave, usuarioId: c.usuarioId });
    const r = (await buscarRevisaoDaVersao(v.id, tx))!;
    // Sem confirmação financeira a abertura não adquire base/destino. Data vigente pode já estar indisponível.
    const f = (await buscarFechamentoPorId(r.fechamento_id, tx))!;
    if (f.status === 'CONFIRMADO')
        await revalidarAgendaRevisao(tx, r, c);
    await auditar(tx, r, c, 'REVISAO_OPERACIONAL_CRIADA', null, { ...r, chaveCriacao: chave });
    return r;
}
export async function fontesPreparacao(vid: string, tx: DbExecutor = db()) {
    const r = await buscarRevisaoDaVersao(vid, tx);
    if (!r)
        return null;
    const cliente = r.operacao.clienteId ? await buscarClientePorId(r.operacao.clienteId, tx) : null;
    const aniversariante = r.operacao.aniversarianteId ? await buscarAniversariantePorId(r.operacao.aniversarianteId, tx) : null;
    const adicionais = (await tx.query<{
        codigo: string;
        quantidade: number;
    }>('SELECT a.codigo,ra.quantidade::float quantidade FROM fechamento_revisao_adicionais ra JOIN adicionais a ON a.id=ra.adicional_id WHERE ra.fechamento_revisao_id=$1 ORDER BY a.codigo', [r.id])).rows;
    return { fechamento: r.operacao, cliente, aniversariante, adicionais, fonteHash: hashSnapshotContrato({ revisao: r.revisao, conteudo: r.conteudo_hash, cliente, aniversariante }), revisaoOperacional: r };
}
export async function snapshotPreparacao(tx: DbExecutor, r: RevisaoOperacional, v: ContratoVersaoRecord) {
    const { snapshot } = await carregarSnapshot(r.operacao, tx, { id: r.id, adicionais: await listarItensRevisao(r.id, tx) });
    // Mudança financeira legítima não altera o conteúdo do documento em elaboração.
    snapshot.fechamento.status = v.snapshot.fechamento.status;
    return { ...snapshot, revisaoOperacional: { id: r.id, revisao: r.revisao, conteudoHash: r.conteudo_hash, versaoBaseId: r.versao_base_id }, documental: (v.snapshot as typeof snapshot & {
            documental?: {
                observacoes: string;
            };
        }).documental ?? { observacoes: '' } };
}
export async function aprovarPreparacao(tx: DbExecutor, r: RevisaoOperacional, c: Contexto, chave: string) {
    if (!c.usuarioId)
        recusar('Aprovação exige usuário administrativo.');
    const anterior = (await tx.query<{
        id: string;
        fechamento_revisao_id: string;
        fechamento_revisao_hash: string;
        fechamento_revisao_numero: number;
        status: string;
        aprovado_por_usuario_id: string;
    }>('SELECT * FROM aprovacoes_negociacao WHERE chave_decisao=$1', [chave])).rows[0];
    if (anterior) {
        if (anterior.fechamento_revisao_id !== r.id || anterior.fechamento_revisao_hash !== r.conteudo_hash || anterior.fechamento_revisao_numero !== r.revisao || anterior.status !== 'APROVADO' || anterior.aprovado_por_usuario_id !== c.usuarioId)
            recusar('Chave de aprovação já usada para outro conteúdo.');
        return anterior.id;
    }
    if (r.revisao_comercial_aprovada === r.revisao)
        return null;
    const f = r.operacao;
    const a = (await tx.query<{
        id: string;
    }>(`INSERT INTO aprovacoes_negociacao(fechamento_id,valor_informado,valor_aprovado,status,motivo,aprovado_por_usuario_id,condicao_pagamento,fechamento_revisao_id,fechamento_revisao_numero,fechamento_revisao_hash,chave_decisao)
 VALUES($1,$2,$3,'APROVADO',$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [r.fechamento_id, f.valorTabela, f.valorAprovado ?? f.valorTabela, r.motivo, c.usuarioId, f.condicaoPagamento, r.id, r.revisao, r.conteudo_hash, chave])).rows[0];
    await tx.query('UPDATE fechamento_revisoes SET revisao_comercial_aprovada=revisao,aprovacao_negociacao_id=$2,aprovado_comercial_por_usuario_id=$3,aprovado_comercial_em=clock_timestamp() WHERE id=$1', [r.id, a.id, c.usuarioId]);
    await auditar(tx, r, c, 'REVISAO_COMERCIAL_APROVADA', null, { aprovacaoId: a.id, revisao: r.revisao, hash: r.conteudo_hash });
    return a.id;
}
export async function editarPreparacao(tx: DbExecutor, r: RevisaoOperacional, input: EdicaoFestaInput, c: Contexto) {
    if (r.estado !== 'EM_ELABORACAO' || !c.usuarioId)
        recusar('Preparação congelada ou usuário inválido.');
    const fonte = (await fontesPreparacao(r.contrato_versao_id, tx))!;
    if (fonte.fonteHash !== input.fonteHash)
        recusar('A preparação ou o cadastro mudou. Reabra a edição.');
    const f = { ...r.operacao };
    if (input.vinculos) {
        const cliente = await buscarClientePorId(input.vinculos.clienteId, tx);
        if (!cliente || cliente.status === 'MESCLADO')
            recusar('Selecione um cliente canônico válido.');
        const child = await buscarAniversariantePorId(input.vinculos.aniversarianteId, tx);
        if (!child || !child.ativo || child.clienteId !== cliente.id)
            recusar('Aniversariante deve pertencer ao contratante proposto.');
        if (input.vinculos.responsavelAdicionalId) {
            const resp = await buscarResponsavelPorId(input.vinculos.responsavelAdicionalId, tx);
            if (!resp || !resp.ativo || resp.clienteId !== cliente.id)
                recusar('Responsável não pertence ao contratante proposto.');
        }
        f.clienteId = cliente.id;
        f.aniversarianteId = child.id;
        f.responsavelAdicionalId = input.vinculos.responsavelAdicionalId;
    }
    await tx.query('SELECT id FROM clientes WHERE id=$1 FOR UPDATE', [f.clienteId]);
    await tx.query('SELECT id FROM aniversariantes WHERE id=$1 FOR UPDATE', [f.aniversarianteId]);
    if (input.cliente)
        await atualizarClienteInterno(f.clienteId!, input.cliente, { ...c, usuarioId: c.usuarioId, origem: 'CRM_INTERNO' }, tx);
    if (input.aniversariante)
        await atualizarAniversarianteInterno(f.aniversarianteId!, f.clienteId!, input.aniversariante, { ...c, usuarioId: c.usuarioId, origem: 'CRM_INTERNO' }, tx);
    const resumo = await calcularResumoComercial({ data: input.dataEvento, configuracaoAgendaId: input.configuracaoAgendaId, pacoteId: input.pacoteId, convidados: input.convidados, adicionais: input.adicionais }, tx);
    if (input.convidados < (resumo.pacote.pacote.convidadosMinimos ?? 1))
        recusar('Quantidade abaixo do mínimo do pacote.');
    if (resumo.adicionais.itens.some(a => adicionaisIncluidos(resumo.pacote.pacote.codigo).includes(a.codigo)))
        recusar('Remova adicionais/combos que já estão incluídos no pacote.');
    const pacoteMudou = f.pacoteId !== input.pacoteId;
    if (pacoteMudou && input.buffetStatus !== 'PENDENTE')
        recusar('Troca de pacote exige revisão do buffet: selecione Pendente.');
    if (input.aniversariante?.dataNascimento && input.aniversariante.dataNascimento > input.dataEvento)
        recusar('Nascimento posterior à data do evento.');
    for (const k of ['dataEvento', 'horarioInicio', 'horarioFim', 'configuracaoAgendaId', 'pacoteId', 'convidados', 'idadeAniversarianteEvento', 'temaFesta', 'buffetStatus', 'buffetSalgados', 'buffetBebidas', 'buffetDoces', 'buffetBolo', 'buffetOutros', 'buffetLembrancinha', 'buffetEmpratado', 'buffetBombom', 'observacoesEquipe'] as const)
        if(input[k] !== undefined) Object.assign(f, { [k]: input[k] });
    Object.assign(f, { tabelaPrecoId: resumo.pacote.tabelaPreco.id, precoPacoteId: resumo.pacote.precoRegra.id, regraDescontoPacoteId: resumo.pacote.desconto.regraId, categoriaHorario: resumo.pacote.categoriaHorario, categoriaPrecoAplicada: resumo.pacote.precoRegra.categoriaHorario, convidadosFaturados: resumo.pacote.convidadosFaturados, valorPacoteBase: resumo.valorTabelaPacoteBase, descontoPercentual: resumo.pacote.desconto.percentual, valorDescontoPacote: resumo.valorDescontoPacote, valorPacoteAplicado: resumo.valorTabelaPacoteAplicado, valorAdicionais: resumo.valorAdicionais, valorTabela: resumo.valorTotalTabela });
    if (pacoteMudou)
        for (const k of ['buffetSalgados', 'buffetBebidas', 'buffetDoces', 'buffetBolo', 'buffetOutros', 'buffetLembrancinha', 'buffetEmpratado', 'buffetBombom'] as const)
            f[k] = null;
    if (input.comercial) {
        const com = input.comercial, base = com.baseNegociada === null ? f.valorTabela : centavosComerciais(com.baseNegociada) / 100;
        const condicao = validarPretensaoPix(com.condicaoPix);
        if ((com.forma === 'PIX_PARCELADO') !== (condicao !== null))
            recusar('Condição PIX incompatível com a forma escolhida.');
        f.valorNegociado = base === f.valorTabela ? null : base;
        f.valorAprovado = f.valorNegociado;
        f.motivoNegociacao = input.motivo;
        f.formaPagamentoPretendida = com.forma;
        f.condicaoPagamento = { schemaVersao: 1, forma: com.forma, pretendida: null, aprovada: condicao, revisaoStatus: 'APROVADA' };
    }
    else if (f.valorTabela !== r.operacao.valorTabela && (r.operacao.valorNegociado !== null || r.operacao.formaPagamentoPretendida === 'PIX_PARCELADO'))
        recusar('O novo preço exige revisão comercial explícita nesta edição.');
    const previousItems = await listarItensRevisao(r.id, tx);
    const itens = resumo.adicionais.itens.map(a => ({ adicionalId: a.adicionalId, precoAdicionalId: a.precoRegraId, nomeAplicado: a.nome, unidadeCobrancaAplicada: a.unidadeCobranca, quantidade: a.quantidade, valorUnitarioAplicado: a.valorUnitarioAplicado, valorTotal: a.valorTotal, observacoes: previousItems.find(x => x.adicionalId === a.adicionalId)?.observacoes ?? null } as FechamentoAdicionalRecord));
    const mudouDestino = f.dataEvento !== r.operacao.dataEvento || f.horarioInicio.slice(0, 5) !== r.operacao.horarioInicio.slice(0, 5) || f.horarioFim.slice(0, 5) !== r.operacao.horarioFim.slice(0, 5);
    await bloquearDatasRevisao(tx, r, f.dataEvento);
    const novo = (await salvarOperacaoPreparada(tx, r, f, itens, c.usuarioId, input.motivo))!;
    await revalidarAgendaRevisao(tx, novo, c, { mudouDestino });
    if (input.comercial)
        await aprovarPreparacao(tx, novo, c, c.requestId ?? randomUUID());
    await auditar(tx, novo, c, 'REVISAO_OPERACIONAL_ALTERADA', { operacao: r.operacao, itens: previousItems, revisao: r.revisao }, { operacao: f, itens, revisao: novo.revisao, motivo: input.motivo });
    return (await buscarRevisaoDaVersao(r.contrato_versao_id, tx))!;
}
export async function congelarPreparacao(tx: DbExecutor, r: RevisaoOperacional, v: ContratoVersaoRecord, documentoId: string, c: Contexto) { await tx.query("UPDATE fechamento_revisoes SET estado='CONGELADA',congelado_snapshot_hash=$2,congelado_documento_id=$3,congelado_em=clock_timestamp(),congelado_por_usuario_id=$4 WHERE id=$1", [r.id, v.snapshotHash, documentoId, c.usuarioId]); await auditar(tx, r, c, 'REVISAO_OPERACIONAL_CONGELADA', r.estado, { documentoId, snapshotHash: v.snapshotHash }); }
export async function concluirPreparacao(tx: DbExecutor, r: RevisaoOperacional, c: Contexto) { await revalidarAgendaRevisao(tx, r, c); const antes = await buscarFechamentoPorId(r.fechamento_id, tx); await aplicarOperacaoPreparada(tx, r); await auditar(tx, r, c, 'REVISAO_OPERACIONAL_APLICADA', antes, { operacao: r.operacao, versao: r.contrato_versao_id }); }
export async function cancelarPreparacao(tx: DbExecutor, r: RevisaoOperacional, c: Contexto, motivo: string) {
    if (r.estado === 'CANCELADA') {
        const terminal = (await tx.query<{
            motivo_cancelamento: string;
            cancelado_por_usuario_id: string;
        }>('SELECT motivo_cancelamento,cancelado_por_usuario_id FROM fechamento_revisoes WHERE id=$1', [r.id])).rows[0];
        if (terminal.motivo_cancelamento !== motivo || terminal.cancelado_por_usuario_id !== c.usuarioId)
            recusar('Cancelamento anterior corresponde a outra intenção ou autor.');
        return { reutilizado: true };
    }
    if (r.estado === 'APLICADA')
        recusar('Revisão já aplicada não pode ser cancelada.');
    await bloquearDatasRevisao(tx, r);
    await tx.query("UPDATE contrato_edicoes SET estado='CANCELADA',atualizado_por_usuario_id=$2 WHERE contrato_versao_id=$1", [r.contrato_versao_id, c.usuarioId]);
    await tx.query("UPDATE contrato_versoes SET status='CANCELADA' WHERE id=$1", [r.contrato_versao_id]);
    await tx.query('UPDATE contrato_fluxos SET versao_em_preparacao_id=NULL WHERE contrato_id=$1 AND versao_em_preparacao_id=$2', [r.contrato_id, r.contrato_versao_id]);
    await tx.query("UPDATE fechamento_revisoes SET estado='CANCELADA',cancelado_em=clock_timestamp(),cancelado_por_usuario_id=$2,motivo_cancelamento=$3 WHERE id=$1", [r.id, c.usuarioId, motivo]);
    await auditar(tx, r, c, 'REVISAO_OPERACIONAL_CANCELADA', { estado: r.estado, hold: r.hold_destino_adquirido_em }, { motivo });
    return { cancelada: true };
}
export async function recusarComercialPreparacao(tx: DbExecutor, r: RevisaoOperacional, c: Contexto, chave: string, motivo: string) {
    if (!c.usuarioId || r.estado !== 'EM_ELABORACAO')
        recusar('Recusa exige preparação editável e usuário real.');
    const anterior = (await tx.query<{
        id: string;
        status: string;
        aprovado_por_usuario_id: string;
        fechamento_revisao_id: string;
        fechamento_revisao_numero: number;
        fechamento_revisao_hash: string;
        motivo: string;
    }>('SELECT * FROM aprovacoes_negociacao WHERE chave_decisao=$1', [chave])).rows[0];
    if (anterior) {
        if (anterior.status !== 'RECUSADO' || anterior.aprovado_por_usuario_id !== c.usuarioId || anterior.fechamento_revisao_id !== r.id || anterior.fechamento_revisao_numero !== r.revisao || anterior.fechamento_revisao_hash !== r.conteudo_hash || anterior.motivo !== motivo)
            recusar('Chave de decisão já usada para outra intenção.');
        return { decisaoId: anterior.id, reutilizado: true };
    }
    const a = (await tx.query<{
        id: string;
    }>(`INSERT INTO aprovacoes_negociacao(fechamento_id,valor_informado,valor_aprovado,status,motivo,aprovado_por_usuario_id,condicao_pagamento,fechamento_revisao_id,fechamento_revisao_numero,fechamento_revisao_hash,chave_decisao) VALUES($1,$2,NULL,'RECUSADO',$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [r.fechamento_id, r.operacao.valorTabela, motivo, c.usuarioId, r.operacao.condicaoPagamento, r.id, r.revisao, r.conteudo_hash, chave])).rows[0];
    await tx.query('UPDATE fechamento_revisoes SET revisao_comercial_aprovada=NULL,aprovacao_negociacao_id=NULL,aprovado_comercial_por_usuario_id=NULL,aprovado_comercial_em=NULL WHERE id=$1', [r.id]);
    await tx.query('UPDATE contrato_edicoes SET documento_revisado_id=NULL,revisado_por_usuario_id=NULL,revisado_em=NULL,revisao_comercial_aprovada=NULL,aprovado_comercial_por_usuario_id=NULL,aprovado_comercial_em=NULL WHERE contrato_versao_id=$1', [r.contrato_versao_id]);
    await auditar(tx, r, c, 'REVISAO_COMERCIAL_RECUSADA', null, { decisaoId: a.id, motivo });
    return { decisaoId: a.id };
}
