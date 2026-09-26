import type { DbExecutor } from '../../db/contracts';
import type { FechamentoRecord } from '../repositories';
import { calcularResumoComercial } from '../../comercial/services';
import { calcularCondicaoComercial, centavosComerciais, validarPretensaoPix } from '../../comercial/condicao-pagamento';
import { consultarDisponibilidadeData } from '../../disponibilidade/services';
import { adquirirLockConfirmacaoAgenda } from '../../disponibilidade/repositories';
import { buscarFechamentoPorIdParaAtualizacao, criarAprovacaoNegociacao, listarAdicionaisDoFechamento } from '../repositories';
import { persistirEdicaoFechamento } from '../repositories/edicao.repository';
import { registrarAuditoria } from '../../clientes/repositories';
import { FechamentoServiceError } from './errors';
import { edicaoFestaSchema, type EdicaoFestaInput } from './edicao-administrativa-schema';
import { gravarCorrecaoFotografiaPacote } from './pacote-snapshot';
function recusar(mensagem: string): never { throw new FechamentoServiceError('DADOS_INVALIDOS', mensagem, 409); }
// Itens já incluídos conforme a composição publicada dos pacotes; preferências não são cobrança.
export function adicionaisIncluidos(codigo: string): string[] {
    // Combos oficiais 006 contêm penne / crepe + sorvete. Para não repetir
    // cobrança, selecione os itens avulsos que ainda não pertencem ao pacote.
    const completa = ['PENNE', 'CREPE_1_SABOR', 'SORVETE', 'COMBO_ADULTOS', 'COMBO_LANCHINHOS'];
    // BOMBOM identifica somente unidades extras; os 4 incluídos não entram nesta seleção.
    return codigo === 'PREMIUM' ? [...completa, 'CREPE_2_SABORES', 'PASTELZINHO', 'EMPRATADO_PREMIUM', 'SALADA_PREMIUM'] : codigo === 'COMPLETA' ? completa : [];
}
export async function editarFechamentoAdministrativo(id: string, raw: EdicaoFestaInput, usuarioId: string, requestId: string, tx: DbExecutor) {
    const input = edicaoFestaSchema.parse(raw);
    if(input.vinculos) recusar('Troca de vínculos exige preparação operacional pós-assinatura.');
    const f = await buscarFechamentoPorIdParaAtualizacao(id, tx);
    if (!f)
        recusar('Fechamento não encontrado.');
    if (!['AGUARDANDO_CONTRATO', 'APROVADO'].includes(f.status))
        recusar('A edição exige Fechamento aprovado ainda não assinado.');
    if ((await tx.query(`SELECT 1 FROM contratos c JOIN contrato_versoes v ON v.contrato_id=c.id WHERE c.fechamento_id=$1 AND (v.status='ASSINADA' OR EXISTS(SELECT 1 FROM contrato_assinaturas a WHERE a.contrato_versao_id=v.id)) UNION ALL SELECT 1 FROM pagamentos p JOIN contrato_versoes pv ON pv.id=p.contrato_versao_id JOIN contratos pc ON pc.id=pv.contrato_id WHERE pc.fechamento_id=$1`, [id])).rows.length)
        recusar('Após assinatura, prepare a alteração em uma nova versão pelo painel de Contratos.');
    const anteriorAdicionais = await listarAdicionaisDoFechamento(id, tx);
    const { fechamento: novo, resumo } = await calcularEdicaoFechamento(f, input, tx);
    if (input.comercial) await criarAprovacaoNegociacao({ fechamentoId: id, status: 'APROVADO', valorInformado: resumo.valorTotalTabela, valorAprovado: novo.valorAprovado ?? resumo.valorTotalTabela, motivo: input.motivo, aprovadoPorUsuarioId: usuarioId, condicaoPagamento: { ...novo.condicaoPagamento!, valores: calcularCondicaoComercial(novo.valorAprovado ?? resumo.valorTotalTabela, input.comercial.forma) } }, tx);
    await persistirEdicaoFechamento(tx, novo, resumo);
    if (f.pacoteId !== input.pacoteId) {
        await gravarCorrecaoFotografiaPacote(tx, novo, resumo, { motivo: input.motivo, atorUsuarioId: usuarioId });
    }
    await registrarAuditoria({ atorTipo: 'USUARIO', usuarioId, clienteId: f.clienteId, acao: 'ALTERACAO_ADMINISTRATIVA', entidadeTipo: 'FECHAMENTO', entidadeId: id, origem: 'CONTRATO_ADMIN', requestId, dadosAntes: { fechamento: f, adicionais: anteriorAdicionais }, dadosDepois: { fechamento: novo, adicionais: resumo.adicionais.itens, motivo: input.motivo } }, tx);
    return (await buscarFechamentoPorIdParaAtualizacao(id, tx))!;
}

/** Calcula uma proposta sem persistir fechamento, itens ou aprovação comercial. */
export async function calcularEdicaoFechamento(f: FechamentoRecord, raw: EdicaoFestaInput, tx: DbExecutor) {
    const input = edicaoFestaSchema.parse(raw);
    if (input.vinculos) recusar('Troca de vínculos exige preparação operacional pós-assinatura.');
    const resumo = await calcularResumoComercial({ data: input.dataEvento, configuracaoAgendaId: input.configuracaoAgendaId, pacoteId: input.pacoteId, convidados: input.convidados, adicionais: input.adicionais }, tx);
    if (input.convidados < (resumo.pacote.pacote.convidadosMinimos ?? 1))
        recusar('Quantidade abaixo do mínimo do pacote.');
    if (resumo.adicionais.itens.some(a => adicionaisIncluidos(resumo.pacote.pacote.codigo).includes(a.codigo)))
        recusar('Há adicional ou combo com item já incluído no pacote. Remova a cobrança duplicada e selecione os itens avulsos necessários.');
    const mudouAgenda = f.dataEvento !== input.dataEvento || f.horarioInicio.slice(0, 5) !== input.horarioInicio.slice(0, 5) || f.horarioFim.slice(0, 5) !== input.horarioFim.slice(0, 5) || f.configuracaoAgendaId !== input.configuracaoAgendaId;
    if (mudouAgenda) {
        for (const dia of [...new Set([f.dataEvento, input.dataEvento])].sort())
            await adquirirLockConfirmacaoAgenda(dia, tx);
        const disponivel = await consultarDisponibilidadeData(input.dataEvento, tx);
        const periodo = disponivel.periodos.find(p => p.configuracaoId === input.configuracaoAgendaId);
        if (!periodo?.horarios.some(h => h.status === 'DISPONIVEL' && h.inicio === input.horarioInicio.slice(0, 5) && h.fim === input.horarioFim.slice(0, 5)))
            recusar('Data/horário indisponível ou fora das opções oficiais.');
    }
    const pacoteMudou = f.pacoteId !== input.pacoteId;
    if (input.aniversariante?.dataNascimento && input.aniversariante.dataNascimento > input.dataEvento)
        recusar('Data de nascimento não pode ser posterior à festa.');
    if (pacoteMudou && input.buffetStatus !== 'PENDENTE')
        recusar('Ao trocar pacote, deixe o buffet pendente e reveja as escolhas do novo pacote.');
    const novo = { ...f, ...Object.fromEntries(['dataEvento', 'horarioInicio', 'horarioFim', 'configuracaoAgendaId', 'pacoteId', 'convidados', 'idadeAniversarianteEvento', 'temaFesta', 'buffetStatus', 'buffetSalgados', 'buffetBebidas', 'buffetDoces', 'buffetBolo', 'buffetOutros', 'buffetLembrancinha', 'buffetEmpratado', 'buffetBombom', 'observacoesEquipe'].map(k => [k, input[k as keyof EdicaoFestaInput] === undefined ? f[k as keyof typeof f] : input[k as keyof EdicaoFestaInput]])),
        tabelaPrecoId: resumo.pacote.tabelaPreco.id, precoPacoteId: resumo.pacote.precoRegra.id, regraDescontoPacoteId: resumo.pacote.desconto.regraId, categoriaHorario: resumo.pacote.categoriaHorario, categoriaPrecoAplicada: resumo.pacote.precoRegra.categoriaHorario,
        convidadosFaturados: resumo.pacote.convidadosFaturados, valorPacoteBase: resumo.valorTabelaPacoteBase, descontoPercentual: resumo.pacote.desconto.percentual, valorDescontoPacote: resumo.valorDescontoPacote, valorPacoteAplicado: resumo.valorTabelaPacoteAplicado, valorAdicionais: resumo.valorAdicionais, valorTabela: resumo.valorTotalTabela };
    if (input.comercial) {
        const com = input.comercial, base = com.baseNegociada === null ? resumo.valorTotalTabela : centavosComerciais(com.baseNegociada) / 100;
        const condicao = validarPretensaoPix(com.condicaoPix);
        if ((com.forma === 'PIX_PARCELADO') !== (condicao !== null))
            recusar('PIX parcelado exige condição aprovada; outras formas não aceitam parcelas PIX.');
        novo.formaPagamentoPretendida = com.forma;
        novo.valorNegociado = base === resumo.valorTotalTabela ? null : base;
        novo.valorAprovado = novo.valorNegociado;
        novo.status = 'AGUARDANDO_CONTRATO';
        novo.condicaoPagamento = { schemaVersao: 1, forma: com.forma, pretendida: f.condicaoPagamento?.forma === com.forma ? f.condicaoPagamento.pretendida : null, aprovada: condicao, revisaoStatus: 'APROVADA' };
    }
    else if (resumo.valorTotalTabela !== f.valorTabela && (f.valorNegociado !== null || f.formaPagamentoPretendida === 'PIX_PARCELADO'))
        recusar('O novo preço exige confirmação explícita da negociação/condição comercial nesta edição.');
    if (pacoteMudou) {
        novo.buffetSalgados = null;
        novo.buffetBebidas = null;
        novo.buffetDoces = null;
        novo.buffetBolo = null;
        novo.buffetOutros = null;
novo.buffetLembrancinha = null;
novo.buffetEmpratado = null;
novo.buffetBombom = null;
    }
    return { fechamento: novo, resumo };
}
