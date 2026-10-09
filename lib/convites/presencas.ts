export type RespostaPresenca = { nome: string; presenca: boolean; adultos: number; criancas: number };
export function resumoPresencas(respostas: RespostaPresenca[], contratados: number | null) {
  const sim = respostas.filter(r => r.presenca);
  const adultos = sim.reduce((n, r) => n + r.adultos, 0), criancas = sim.reduce((n, r) => n + r.criancas, 0);
  return { adultos, criancas, total: adultos + criancas, familias: sim.length, recusas: respostas.length - sim.length,
    diferenca: contratados == null ? null : adultos + criancas - contratados };
}
/** Protege células de fórmulas ao abrir no Excel, inclusive depois de espaços/controles. */
export function csvPresencas(respostas: RespostaPresenca[]) {
  const celula = (valor: string | number) => {
    let texto = String(valor);
    if (/^[\s\u0000-\u001f]*[=+@-]/.test(texto) || /^[\t\r\n]/.test(texto)) texto = "'" + texto;
    return '"' + texto.replaceAll('"', '""') + '"';
  };
  return '\ufeff' + [['Família', 'Resposta', 'Adultos', 'Crianças', 'Total'], ...respostas.map(r => [r.nome, r.presenca ? 'Confirmada' : 'Não vai', r.presenca ? r.adultos : 0, r.presenca ? r.criancas : 0, r.presenca ? r.adultos + r.criancas : 0])].map(l => l.map(celula).join(';')).join('\r\n');
}
