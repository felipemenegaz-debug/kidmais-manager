import type { ResumoIntegracao } from '../../contratos/integracao-importados/modelo.ts';

/** Resumo humano mínimo: dados identificadores completos continuam na importação privada. */
export function linhasDaConclusao(r: ResumoIntegracao) {
  const dinheiro = (v: number) => 'R$ ' + (v / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const linhas = [
    { id: 'horario', rotulo: 'Horário', valor: r.festa.horarioInicio + '–' + r.festa.horarioFim },
    { id: 'unidade', rotulo: 'Unidade', valor: r.contrato.unidade ?? 'Empresa atual' },
    { id: 'referencia', rotulo: 'Referência operacional', valor: r.contrato.pacoteReferencia },
    { id: 'agenda', rotulo: 'Agenda', valor: r.agenda.descricao },
  ];
  const f = r.financeiro;
  if (f.situacao === 'NAO_CONFERIDO') linhas.push({ id: 'financeiro', rotulo: 'Pagamentos', valor: 'Ainda não conferidos. O contrato terá alerta; nenhum recebimento ou dívida será inventado.' });
  else {
    linhas.push({ id: 'recebido', rotulo: 'Recebido', valor: dinheiro(f.recebidoCentavos) }, { id: 'saldo', rotulo: 'A receber', valor: dinheiro(f.saldoCentavos) });
    for (const p of f.parcelas) linhas.push({ id: 'parcela_' + p.numero, rotulo: 'Parcela ' + p.numero,
      valor: dinheiro(p.valorCentavos) + ' · vence ' + p.vencimento + (p.recebidaEm ? ' · recebido em ' + p.recebidaEm + ' por ' + p.forma : ' · a receber') });
  }
  for (const [i, c] of r.campos.filter(c => c.origem !== 'DOCUMENTO').entries()) linhas.push({ id: 'complemento_' + i, rotulo: c.rotulo, valor: c.efetivo + ' · ' + (c.origem === 'COMPLEMENTO' ? 'complemento informado' : 'correção: ' + c.motivo) });
  return linhas;
}
