import {escolhasDisponiveis} from './escolhas-buffet';
import type { DbExecutor } from '../../db/contracts';
import type { FechamentoRecord } from './models';
import type { ResumoComercial } from '../../comercial/services';
import { criarFechamentoAdicional, listarAdicionaisDoFechamento } from './fechamento.repository';
/** 094 instalada: o fechamento guarda o salão da festa. */
export async function salaoDaFestaInstalado(tx: DbExecutor) {
    const r = await tx.query<{ ok: boolean }>("SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='fechamentos' AND column_name='salao_id') ok");
    return r.rows[0]?.ok === true;
}
/** Persistência interna do resultado validado pelo serviço de Fechamento. */
export async function persistirEdicaoFechamento(tx: DbExecutor, f: FechamentoRecord, resumo: ResumoComercial) {
    const campos = ['dataEvento', 'horarioInicio', 'horarioFim', 'configuracaoAgendaId', 'pacoteId', 'tabelaPrecoId', 'precoPacoteId', 'regraDescontoPacoteId', 'categoriaHorario', 'categoriaPrecoAplicada', 'convidados', 'convidadosFaturados', 'valorPacoteBase', 'descontoPercentual', 'valorDescontoPacote', 'valorPacoteAplicado', 'valorAdicionais', 'valorTabela', 'valorNegociado', 'valorAprovado', 'status', 'formaPagamentoPretendida', 'condicaoPagamento', 'idadeAniversarianteEvento', 'temaFesta', 'buffetStatus', 'buffetSalgados', 'buffetBebidas', 'buffetDoces', 'buffetBolo', 'buffetOutros', 'buffetLembrancinha', 'buffetEmpratado', 'buffetBombom', 'observacoesEquipe'] as const;
    const disponiveis=await escolhasDisponiveis(tx);
    const camposAtivos=campos.filter(k=>disponiveis||!['buffetLembrancinha','buffetEmpratado','buffetBombom'].includes(k));
    const setters = camposAtivos.map((key, i) => `${key.replace(/[A-Z]/g, c => '_' + c.toLowerCase())}=$${i + 2}`);
    // 094: mudar data, horário ou configuração da agenda solta o salão da festa (comparado com a linha antiga no próprio
    // UPDATE); o sistema escolhe de novo na confirmação/formalização. Sem a coluna (antes da 094), nada muda.
    if (await salaoDaFestaInstalado(tx)) {
        const p = (k: (typeof camposAtivos)[number]) => '$' + (camposAtivos.indexOf(k) + 2);
        setters.push(`salao_id=CASE WHEN (data_evento,horario_inicio,horario_fim,configuracao_agenda_id) IS DISTINCT FROM (${p('dataEvento')}::date,${p('horarioInicio')}::time,${p('horarioFim')}::time,${p('configuracaoAgendaId')}::uuid) THEN NULL ELSE salao_id END`);
    }
    await tx.query(`UPDATE fechamentos SET ${setters.join(',')} WHERE id=$1`, [f.id, ...camposAtivos.map(key => f[key] ?? null)]);
    const anteriores = await listarAdicionaisDoFechamento(f.id, tx);
    await tx.query('DELETE FROM fechamento_adicionais WHERE fechamento_id=$1', [f.id]);
    for (const a of resumo.adicionais.itens)
        await criarFechamentoAdicional({ fechamentoId: f.id, adicionalId: a.adicionalId, precoAdicionalId: a.precoRegraId, nomeAplicado: a.nome, unidadeCobrancaAplicada: a.unidadeCobranca, quantidade: a.quantidade, valorUnitarioAplicado: a.valorUnitarioAplicado, valorTotal: a.valorTotal, observacoes: anteriores.find(x => x.adicionalId === a.adicionalId)?.observacoes ?? null }, tx);
}
