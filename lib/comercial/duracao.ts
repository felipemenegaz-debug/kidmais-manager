export function separarDuracao(valor: number | null) {
  if (valor == null) return { horas: '', minutos: '' };
  if (!Number.isInteger(valor) || valor < 1 || valor > 1440) throw new Error('Duração inválida.');
  return { horas: String(Math.floor(valor / 60)), minutos: String(valor % 60).padStart(2, '0') };
}

export function juntarDuracao(horas: string, minutos: string): number | null {
  if (!horas.trim() && !minutos.trim()) return null;
  if (!/^\d*$/.test(horas.trim()) || !/^\d*$/.test(minutos.trim())) throw new Error('Informe horas e minutos inteiros.');
  const h = Number(horas), m = Number(minutos), total = h * 60 + m;
  if (h > 24 || m > 59 || total < 1 || total > 1440) throw new Error('Informe uma duração entre 1min e 24h.');
  return total;
}

export function formatarDuracao(valor: number | null) {
  if (valor == null) return 'Não definida';
  const { horas, minutos } = separarDuracao(valor);
  return `${Number(horas) ? `${Number(horas)}h` : ''}${Number(minutos) ? `${Number(minutos)}min` : ''}`;
}
