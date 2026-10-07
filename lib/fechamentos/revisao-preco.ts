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
