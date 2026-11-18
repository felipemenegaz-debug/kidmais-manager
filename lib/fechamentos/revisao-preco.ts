import type { ResumoComercial } from "../comercial/services/models";
import { descontoSobreBase } from "../comercial/descontos-dia.ts";
type Destino = { pacoteId: string; convidados: number; dataEvento: string; horarioInicio: string; horarioFim: string; configuracaoAgendaId: string };
type Adicional = { codigo: string; quantidade: number };
/** Correções cadastrais e de buffet não renegociam os preços de um documento histórico. */
export function preservarPrecoHistorico(vigente: Destino & { origemFechamento: string }, destino: Destino,
  anteriores: Adicional[], propostos: Adicional[], revisaComercial: boolean) {
  const itens = (a: Adicional[]) => JSON.stringify(a.map(x => [x.codigo, x.quantidade]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  return vigente.origemFechamento === 'IMPORTACAO_HISTORICA' && !revisaComercial
    && vigente.pacoteId === destino.pacoteId && vigente.convidados === destino.convidados
    && vigente.dataEvento === destino.dataEvento && vigente.configuracaoAgendaId === destino.configuracaoAgendaId
    && vigente.horarioInicio.slice(0, 5) === destino.horarioInicio.slice(0, 5)
    && vigente.horarioFim.slice(0, 5) === destino.horarioFim.slice(0, 5)
    && itens(anteriores) === itens(propostos);
}

type DescontoGravado = { pacoteId: string; dataEvento: string; configuracaoAgendaId: string; horarioInicio: string; horarioFim: string; regraDescontoPacoteId: string | null; descontoPercentual: number };
type DestinoDesconto = { pacoteId: string; dataEvento: string; configuracaoAgendaId: string; horarioInicio: string; horarioFim: string };
const dinheiro = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
const hhmm = (h: string) => String(h).slice(0, 5);
/**
 * D3 (18/11/2026): o desconto do dia da semana é condição da festa fechada. Uma revisão que mantém pacote, data,
 * configuração da agenda E o intervalo (início e fim, HH:MM — no horário livre a configuração é a mesma para 14h–18h
 * e 15h–19h) mantém a regra e o percentual gravados, mesmo que o buffet tenha mudado a regra
 * depois; só os valores são refeitos sobre a nova base (convidados). Trocar pacote, data, configuração ou intervalo recalcula pelo
 * catálogo atual, como antes. Mesma ideia do D1 (regraNaRevisao) para a forma de pagamento.
 */
export function manterDescontoDoDia<R extends ResumoComercial>(resumo: R, gravado: DescontoGravado, destino: DestinoDesconto): R {
  const mesmaFesta = gravado.pacoteId === destino.pacoteId && gravado.dataEvento === destino.dataEvento
    && gravado.configuracaoAgendaId === destino.configuracaoAgendaId
    && hhmm(gravado.horarioInicio) === hhmm(destino.horarioInicio) && hhmm(gravado.horarioFim) === hhmm(destino.horarioFim);
  const percentual = Number(gravado.descontoPercentual);
  if (!mesmaFesta || !Number.isFinite(percentual)) return resumo;
  const atual = resumo.pacote?.desconto;
  if (!atual) return resumo;
  if (atual.regraId === gravado.regraDescontoPacoteId && atual.percentual === percentual) return resumo;
  const base = resumo.valorTabelaPacoteBase;
  const { valor, aplicado } = descontoSobreBase(base, percentual);
  const mesmaRegra = atual.regraId !== null && atual.regraId === gravado.regraDescontoPacoteId;
  return {
    ...resumo,
    pacote: { ...resumo.pacote, valorTabelaAplicado: aplicado, desconto: {
      aplicado: percentual > 0, regraId: gravado.regraDescontoPacoteId,
      codigo: mesmaRegra ? atual.codigo : null, titulo: mesmaRegra ? atual.titulo : null, percentual, valor } },
    valorDescontoPacote: valor,
    valorTabelaPacoteAplicado: aplicado,
    valorTotalTabela: dinheiro(aplicado + resumo.valorAdicionais),
  };
}
