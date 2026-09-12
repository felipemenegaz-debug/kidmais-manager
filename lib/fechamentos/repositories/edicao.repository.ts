import {escolhasDisponiveis} from './escolhas-buffet';
import type { DbExecutor } from '../../db/contracts';
import type { FechamentoRecord } from './models';
import type { ResumoComercial } from '../../comercial/services';
import { criarFechamentoAdicional, listarAdicionaisDoFechamento } from './fechamento.repository';
/** Persistência interna do resultado validado pelo serviço de Fechamento. */
export async function persistirEdicaoFechamento(tx: DbExecutor, f: FechamentoRecord, resumo: ResumoComercial) {
    const campos = ['dataEvento', 'horarioInicio', 'horarioFim', 'configuracaoAgendaId', 'pacoteId', 'tabelaPrecoId', 'precoPacoteId', 'regraDescontoPacoteId', 'categoriaHorario', 'categoriaPrecoAplicada', 'convidados', 'convidadosFaturados', 'valorPacoteBase', 'descontoPercentual', 'valorDescontoPacote', 'valorPacoteAplicado', 'valorAdicionais', 'valorTabela', 'valorNegociado', 'valorAprovado', 'status', 'formaPagamentoPretendida', 'condicaoPagamento', 'idadeAniversarianteEvento', 'temaFesta', 'buffetStatus', 'buffetSalgados', 'buffetBebidas', 'buffetDoces', 'buffetBolo', 'buffetOutros', 'buffetLembrancinha', 'buffetEmpratado', 'buffetBombom', 'observacoesEquipe'] as const;
    const disponiveis=await escolhasDisponiveis(tx);
    const camposAtivos=campos.filter(k=>disponiveis||!['buffetLembrancinha','buffetEmpratado','buffetBombom'].includes(k));
    const setters = camposAtivos.map((key, i) => `${key.replace(/[A-Z]/g, c => '_' + c.toLowerCase())}=$${i + 2}`);
    await tx.query(`UPDATE fechamentos SET ${setters.join(',')} WHERE id=$1`, [f.id, ...camposAtivos.map(key => f[key] ?? null)]);
    const anteriores = await listarAdicionaisDoFechamento(f.id, tx);
    await tx.query('DELETE FROM fechamento_adicionais WHERE fechamento_id=$1', [f.id]);
    for (const a of resumo.adicionais.itens)
        await criarFechamentoAdicional({ fechamentoId: f.id, adicionalId: a.adicionalId, precoAdicionalId: a.precoRegraId, nomeAplicado: a.nome, unidadeCobrancaAplicada: a.unidadeCobranca, quantidade: a.quantidade, valorUnitarioAplicado: a.valorUnitarioAplicado, valorTotal: a.valorTotal, observacoes: anteriores.find(x => x.adicionalId === a.adicionalId)?.observacoes ?? null }, tx);
}
