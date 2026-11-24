/** Início e fim do mês corrente e do anterior no fuso de São Paulo (relatório Resultado e teto mensal da Meta, 3b). */
const FUSO = 'America/Sao_Paulo';
const mesEmSaoPaulo = new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit' });
const offsetEmSaoPaulo = new Intl.DateTimeFormat('en', { timeZone: FUSO, timeZoneName: 'longOffset' });

export function limitesMesesSaoPaulo(agora: Date) {
  const partes = mesEmSaoPaulo.formatToParts(agora);
  const ano = Number(partes.find(p => p.type === 'year')?.value);
  const mes = Number(partes.find(p => p.type === 'month')?.value);
  const inicio = (deslocamento: number) => {
    const primeiroDia = new Date(Date.UTC(ano, mes - 1 + deslocamento, 1));
    const offset = offsetEmSaoPaulo.formatToParts(primeiroDia).find(p => p.type === 'timeZoneName')!.value.slice(3);
    return new Date(`${primeiroDia.toISOString().slice(0, 19)}${offset}`).toISOString();
  };
  const anterior = inicio(-1), atual = inicio(0), proximo = inicio(1);
  return [
    { mes: atual.slice(0, 7), inicio: atual, fim: proximo },
    { mes: anterior.slice(0, 7), inicio: anterior, fim: atual },
  ];
}
