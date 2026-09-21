import type { ContratoSnapshotV1 } from '../../lib/contratos/repositories/models';
import { formatarMoeda, formatarFormaPagamento, formatarCondicaoPix, formatarDataContrato, formatarHorarioContrato } from '../../lib/contratos/documento/formatters.ts';

export type VersaoResumo = {
  id: string; numero_versao: number; status: string; estado_edicao: string | null;
  snapshot: ContratoSnapshotV1 & { documental?: { observacoes?: string } };
};
export type PainelResumo = {
  contrato: { id: string; fechamento_id: string; status: string };
  fluxo: { versao_vigente_id: string | null; versao_em_preparacao_id: string | null } | null;
  versoes: VersaoResumo[];
  assinaturas: Array<{ contrato_versao_id: string; parte: string; assinado_em: string; identidade_snapshot: { nome: string } }>;
  financeiro: Array<{ id: string }>;
};
export type FinanceiroResumo = {
  contrato: { id: string };
  vigente: { id: string }; reconhecida: { id: string };
  posicao: { obrigacao: string; liquido: string; saldo: string };
  cobranca: { encerrada: boolean };
  planos: Array<{ id: string; status: string; numero_versao: number }>;
  parcelas: Array<{ id: string; plano_id: string; numero: number; valor_previsto: string; vencimento: string; status: string }>;
  cronograma: { versao_referencia_id: string; estado: string } | null;
  itens: Array<{ parcela_id: string; saldo_inicial_centavos: string; vencimento_referencia: string }>;
};
export type SecaoResumo = { titulo: string; linhas: Array<[string, string]> };

export function selecionarVersaoResumo(painel: PainelResumo, id?: string | null) {
  const versao = painel.versoes.find(v => v.id === (id || painel.fluxo?.versao_vigente_id));
  if (!versao) throw Error('Versão contratual não encontrada. Selecione uma versão no módulo Contratos.');
  if (versao.snapshot.fechamento.id !== painel.contrato.fechamento_id) throw Error('Vínculo da versão contratual inconsistente.');
  return versao;
}

/** Apresentação apenas: valores comerciais vêm integralmente do snapshot selecionado. */
export function montarResumo(p: PainelResumo, id?: string | null, financeiro?: FinanceiroResumo | null) {
  const v = selecionarVersaoResumo(p, id), s = v.snapshot;
  const vigente = p.fluxo?.versao_vigente_id === v.id;
  const classificacao = vigente ? 'Versão vigente' : p.fluxo?.versao_em_preparacao_id === v.id ? 'Versão em preparação — não vigente' : 'Versão histórica';
  const secoes: SecaoResumo[] = [];
  const texto = (value: string | number | null | undefined) => value == null || value === '' ? 'Não informado' : String(value);
  const secao = (titulo: string, linhas: SecaoResumo['linhas']) => secoes.push({ titulo, linhas });
  secao('Contratação', [['Fechamento', p.contrato.fechamento_id], ['Contrato', p.contrato.id], ['Versão', `V${v.numero_versao} · ${classificacao}`], ['Status atual do contrato', p.contrato.status], ['Estado desta versão', v.estado_edicao ?? v.status]]);
  secao('Contratante e aniversariante', [['Contratante', s.contratante.nomeCompleto], ['Aniversariante', s.aniversariante.nome], ['Idade no evento', texto(s.aniversariante.idadeNoEvento)], ['Tema', texto(s.aniversariante.temaFesta)], ...(s.responsavelAdicional ? [['Responsável adicional', s.responsavelAdicional.nome] as [string, string]] : [])]);
  secao('Festa', [['Data', formatarDataContrato(s.evento.data)], ['Horário', `${formatarHorarioContrato(s.evento.horarioInicio)}–${formatarHorarioContrato(s.evento.horarioFim)}`], ['Pacote', s.evento.pacote.nome], ['Convidados', texto(s.evento.convidados)], ['Convidados faturados', texto(s.evento.convidadosFaturados)]]);
  const buffet = s.contratacao.buffet;
  secao('Buffet', [['Situação', buffet.status === 'DEFINIDO' ? 'Definido' : 'Pendente'], ...([
    ['Salgados', buffet.salgados], ['Bebidas', buffet.bebidas], ['Doces', buffet.doces], ['Bolo', buffet.bolo], ['Outros', buffet.outros], ['Lembrancinha', buffet.lembrancinha], ['Empratado', buffet.empratado], ['Bombom', buffet.bombom],
  ] as Array<[string, string | null | undefined]>).filter(([, value]) => !!value).map(([label, value]): [string, string] => [label, value!])]);
  secao('Adicionais e alterações', [
    ...s.contratacao.adicionais.map((a): [string, string] => [a.nome, `${a.quantidade} ${a.unidadeCobranca} · unitário ${formatarMoeda(a.valorUnitario)} · total ${formatarMoeda(a.valorTotal)}${a.observacoes ? ` · ${a.observacoes}` : ''}`]),
    ...(!s.contratacao.adicionais.length ? [['Adicionais', 'Nenhum registrado nesta versão'] as [string, string]] : []),
    ['Alterações do pacote', texto(s.contratacao.alteracoesPacote)],
  ]);
  const condicao = s.comercial.condicaoPagamento;
  secao('Condição comercial contratada', [['Valor contratual', formatarMoeda(s.comercial.valorFinalContrato)], ['Forma de pagamento', formatarFormaPagamento(condicao?.forma ?? s.comercial.formaPagamentoPretendida)], ...(condicao ? [
    ['Condição pretendida', formatarCondicaoPix(condicao.pretendida)], ['Condição aprovada', formatarCondicaoPix(condicao.aprovada)], ['Situação da condição', condicao.revisaoStatus],
  ] as Array<[string, string]> : [])]);
  let avisoFinanceiro = !vigente ? 'Posição financeira histórica não congelada no snapshot. O financeiro atual não é atribuído a esta versão.' : !p.financeiro.length ? 'Plano financeiro ainda não criado.' : 'Posição financeira indisponível para esta versão; consulte o módulo Financeiro.';
  const parcelas: Array<{ rotulo: string; valor: string; vencimento: string; estado: string }> = [];
  if (vigente && financeiro && financeiro.contrato.id === p.contrato.id && financeiro.vigente.id === v.id && financeiro.reconhecida.id === v.id) {
    const f = financeiro;
    avisoFinanceiro = 'Posição financeira atual consultada, vinculada a esta versão. Não representa um retrato histórico na data da assinatura.';
    secao('Financeiro', [['Obrigação reconhecida', formatarMoeda(Number(f.posicao.obrigacao) / 100)], ['Recebido líquido', formatarMoeda(Number(f.posicao.liquido) / 100)], ['Saldo a receber', formatarMoeda(Number(f.posicao.saldo) / 100)], ['Cobrança', f.cobranca.encerrada ? 'Encerrada' : 'Não encerrada']]);
    if (f.cronograma?.versao_referencia_id === v.id) {
      for (const item of f.itens) {
        const parcela = f.parcelas.find(x => x.id === item.parcela_id);
        if (!parcela) throw Error('Cronograma financeiro inconsistente. Consulte o módulo Financeiro.');
        parcelas.push({ rotulo: `Parcela ${parcela.numero} · valor inicial do cronograma`, valor: formatarMoeda(Number(item.saldo_inicial_centavos) / 100), vencimento: formatarDataContrato(item.vencimento_referencia), estado: parcela.status });
      }
    } else if (!f.cronograma) {
      const ativos = new Set(f.planos.filter(x => x.status === 'ATIVO').map(x => x.id));
      for (const parcela of [...f.parcelas].filter(x => ativos.has(x.plano_id)).sort((a, b) => a.numero - b.numero)) {
        parcelas.push({ rotulo: `Parcela ${parcela.numero}`, valor: formatarMoeda(Number(parcela.valor_previsto)), vencimento: formatarDataContrato(parcela.vencimento), estado: parcela.status });
      }
    }
  }
  const observacoes = ([['Cliente', s.contratacao.observacoesCliente], ['Equipe', s.contratacao.observacoesEquipe], ['Documentais desta versão', s.documental?.observacoes]] as Array<[string, string | null | undefined]>).filter(([, value]) => !!value).map(([label, value]): [string, string] => [label, value!]);
  if (observacoes.length) secao('Observações', observacoes);
  const assinaturas = p.assinaturas.filter(a => a.contrato_versao_id === v.id);
  secao('Assinaturas desta versão', ['KIDMAIS', 'CLIENTE'].map(parte => {
    const assinatura = assinaturas.find(a => a.parte === parte);
    return [parte, assinatura ? `${assinatura.identidade_snapshot.nome} · ${new Date(assinatura.assinado_em).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })} (Brasília)` : 'Não registrada'];
  }));
  return { numeroVersao: v.numero_versao, classificacao, secoes, parcelas, avisoFinanceiro };
}
