import { elementosAcervo } from './acervo/elementos.ts';

export const modelosAcervo = ['acervo_folhas', 'acervo_estrelas', 'acervo_baloes'] as const;
export function sugestaoAcervo(tema: string) {
  const texto = tema.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  if (/jardim|flor|folha|natureza|safari|bosque/.test(texto)) return 'acervo_folhas' as const;
  if (/espac|planeta|estrela|galax|futuro|tempo|astronaut/.test(texto)) return 'acervo_estrelas' as const;
  return 'acervo_baloes' as const;
}

/** Apenas caminhos locais aprovados, sem markup remoto nem URLs externas. */
export function bordaAcervo(tema: string, cor: string) {
  if (!(modelosAcervo as readonly string[]).includes(tema)) return '';
  const elemento = tema === 'acervo_folhas' ? 'leaf' : tema === 'acervo_estrelas' ? 'star' : 'balloon';
  const caminhos = elementosAcervo[elemento].map(d => `<path d="${d}"/>`).join('');
  const pontos = [[46, 60], [958, 60], [46, 1600], [958, 1600], [35, 570], [969, 570], [35, 1080], [969, 1080]];
  return `<rect x="125" y="115" width="830" height="1570" rx="72" fill="none" stroke="${cor}" stroke-width="2" opacity=".5"/>` + pontos.map(([x,y], n) => `<g transform="translate(${x} ${y}) scale(3.2)" fill="none" stroke="${cor}" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" opacity="${n < 4 ? '.85' : '.45'}">${caminhos}</g>`).join('');
}
