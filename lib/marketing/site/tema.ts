import { estiloDoConteudo, type EstiloSite } from "./conteudo.ts";

/**
 * Tema do site público (UX de 15/10/2026): estilo da unidade + cores da marca → variáveis CSS do renderizador único.
 * Legibilidade garantida pelo cálculo (WCAG 2.x), não pela escolha do usuário:
 *   - texto SOBRE a cor principal (botões) usa branco ou quase-preto, o de maior contraste;
 *   - a cor principal usada como TEXTO sobre o fundo (títulos de destaque, links) é escurecida/clareada até 4,5:1;
 *   - o editor mostra avisos quando a combinação escolhida exige esses ajustes ou não tem saída boa.
 */

export type Paleta = { id: string; nome: string; primaria: string; secundaria: string };

/** Paletas prontas (cores fortes o bastante para botões; o renderizador ajusta o texto). */
export const PALETAS: readonly Paleta[] = [
  { id: "VIOLETA_TURQUESA", nome: "Violeta e turquesa", primaria: "#6d4aff", secundaria: "#14b8a6" },
  { id: "CORAL_MENTA", nome: "Coral e menta", primaria: "#e8590c", secundaria: "#2f9e77" },
  { id: "AZUL_SOL", nome: "Azul e amarelo-sol", primaria: "#1c64f2", secundaria: "#f59f00" },
  { id: "ROSA_LAVANDA", nome: "Rosa e lavanda", primaria: "#d6336c", secundaria: "#845ef7" },
  { id: "GRAFITE_CORAL", nome: "Grafite e coral", primaria: "#343a40", secundaria: "#ff6b6b" },
  { id: "SALVIA_AREIA", nome: "Sálvia e areia", primaria: "#3f6b4f", secundaria: "#c9a227" },
  { id: "BORDO_DOURADO", nome: "Bordô e dourado", primaria: "#7b1e3a", secundaria: "#b8860b" },
  { id: "MARINHO_DOURADO", nome: "Azul-marinho e dourado", primaria: "#1b2a4a", secundaria: "#c8a24a" },
];

type Neutros = { fundo: string; fundoAlternado: string; cartao: string; texto: string; textoSuave: string; borda: string };

/** Os três estilos: um só renderizador; mudam neutros, tipografia, raios e composição (via data-estilo no CSS). */
export const ESTILOS: Record<EstiloSite, { nome: string; descricao: string; neutros: Neutros }> = {
  INFANTIL_ACOLHEDOR: {
    nome: "Infantil acolhedor",
    descricao: "Cantos arredondados, cores vivas e clima de festa. Bom para buffets infantis.",
    neutros: { fundo: "#fffaf3", fundoAlternado: "#fff1e0", cartao: "#ffffff", texto: "#2b2135", textoSuave: "#5c5068", borda: "#f0e2d0" },
  },
  SOCIAL_CONTEMPORANEO: {
    nome: "Social contemporâneo",
    descricao: "Linhas retas, foto em destaque e visual limpo. Bom para festas de 15 anos e eventos sociais.",
    neutros: { fundo: "#ffffff", fundoAlternado: "#f3f4f6", cartao: "#ffffff", texto: "#111827", textoSuave: "#4b5563", borda: "#e5e7eb" },
  },
  CELEBRACOES_ELEGANTE: {
    nome: "Celebrações elegante",
    descricao: "Títulos com serifa, tons claros e muito respiro. Bom para casamentos e celebrações formais.",
    neutros: { fundo: "#fbf8f3", fundoAlternado: "#f3ede3", cartao: "#fffdf9", texto: "#24201c", textoSuave: "#5f574e", borda: "#e7dfd2" },
  },
};

const BRANCO = "#ffffff";
const ESCURO = "#14121a";

function rgb(hex: string): [number, number, number] {
  const h = /^#[0-9a-fA-F]{6}$/.test(hex) ? hex.slice(1) : "000000";
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}
function hex([r, g, b]: [number, number, number]) {
  return `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;
}
/** Luminância relativa (WCAG 2.x). */
export function luminancia(cor: string) {
  const [r, g, b] = rgb(cor).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** Razão de contraste (1 a 21). */
export function contraste(a: string, b: string) {
  const [x, y] = [luminancia(a), luminancia(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
function misturar(a: string, b: string, peso: number) {
  const [ra, ga, ba] = rgb(a), [rb, gb, bb] = rgb(b);
  return hex([ra + (rb - ra) * peso, ga + (gb - ga) * peso, ba + (bb - ba) * peso]);
}
/** Texto sobre a cor: branco ou quase-preto, o que der mais contraste. */
export function textoSobre(cor: string) {
  return contraste(cor, BRANCO) >= contraste(cor, ESCURO) ? BRANCO : ESCURO;
}
/** A cor, ajustada (rumo ao texto do estilo) até atingir `alvo` de contraste sobre o fundo; devolve a original se já atinge. */
export function corLegivelSobre(cor: string, fundo: string, texto: string, alvo = 4.5) {
  if (contraste(cor, fundo) >= alvo) return cor;
  for (let i = 1; i <= 20; i++) {
    const c = misturar(cor, texto, i / 20);
    if (contraste(c, fundo) >= alvo) return c;
  }
  return texto;
}

/** Distância entre duas cores no RGB (0 a ~441): perto de 0 = praticamente a mesma cor, independente da luminância. */
export function distanciaDeCor(a: string, b: string) {
  const [x, y] = [rgb(a), rgb(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

export function paletaDasCores(primaria: string, secundaria: string): Paleta | null {
  return PALETAS.find((p) => p.primaria === primaria.toLowerCase() && p.secundaria === secundaria.toLowerCase()) ?? null;
}

type ConteudoComCores = { aparencia?: { estilo?: unknown } | null; identidade: { corPrimaria: string; corSecundaria: string } };

/** Variáveis CSS do tema (valores já validados como #rrggbb pelo esquema; aqui só derivados). */
export function temaDoSite(c: ConteudoComCores) {
  const estilo = estiloDoConteudo(c);
  const n = ESTILOS[estilo].neutros;
  const primaria = c.identidade.corPrimaria, secundaria = c.identidade.corSecundaria;
  const variaveis: Record<string, string> = {
    "--cor-primaria": primaria,
    "--cor-secundaria": secundaria,
    "--sobre-primaria": textoSobre(primaria),
    "--sobre-secundaria": textoSobre(secundaria),
    "--primaria-texto": corLegivelSobre(primaria, n.fundo, n.texto),
    "--secundaria-texto": corLegivelSobre(secundaria, n.fundo, n.texto),
    // Contorno de foco: a cor que mais se destaca do fundo entre principal e texto (sempre >= 3:1).
    "--foco": contraste(primaria, n.fundo) >= 3 ? primaria : n.texto,
    "--fundo": n.fundo, "--fundo-alternado": n.fundoAlternado, "--cartao": n.cartao, "--texto": n.texto, "--texto-suave": n.textoSuave, "--borda": n.borda,
  };
  return { estilo, variaveis };
}

/** Orientação para o editor (texto humano). Não bloqueia salvar: o renderizador corrige o que dá para corrigir. */
export function avisosDeCores(primaria: string, secundaria: string, estilo: EstiloSite): string[] {
  const n = ESTILOS[estilo].neutros;
  const avisos: string[] = [];
  const sobre = Math.max(contraste(primaria, BRANCO), contraste(primaria, ESCURO));
  if (sobre < 4.5) avisos.push("O texto dos botões fica difícil de ler com esta cor principal. Escolha uma cor mais escura ou mais clara.");
  if (contraste(primaria, n.fundo) < 3) avisos.push("A cor principal é clara demais para o fundo deste estilo: títulos e links usarão uma versão mais escura dela.");
  if (distanciaDeCor(primaria, secundaria) < 60) avisos.push("As duas cores são quase iguais: a de apoio quase não aparece. Experimente uma paleta pronta.");
  return avisos;
}
