/**
 * Regras puras da logo sobre a arte no editor do buffet (plano etapa 3 r15.1, §4, §5 e §6).
 * Sem React e sem navegador: os textos e as decisões ficam aqui para os testes da tela.
 */
import type { PosicaoLogoEnvio } from '@/lib/convites/fila-logo';
import type { OrigemLogo } from '@/lib/convites/posicao-logo';

export type EntradaLogo = PosicaoLogoEnvio & { origem?: OrigemLogo };
export type LogoLocal = { mostrar: boolean; posicoes: Record<string, EntradaLogo> };

/** §6: tamanhos P/M/G em % da largura da arte; M = LARGURA_SUGERIDA de posicao-logo (conferido no teste). */
export const TAMANHOS_LOGO = [['P', 'Pequena', 12], ['M', 'Média', 18], ['G', 'Grande', 26]] as const;
/** §6: setas 1%, Shift + seta 5%. */
export const PASSO_SETA = 1, PASSO_SETA_SHIFT = 5;

/** §6: grade de 9 lugares (cantos, meios das bordas e centro); a geometria limita o centro às bordas. */
export const LUGARES_LOGO: readonly { nome: string; x: number; y: number }[] = [
  { nome: 'Em cima, à esquerda', x: 0, y: 0 }, { nome: 'Em cima, no centro', x: 50, y: 0 }, { nome: 'Em cima, à direita', x: 100, y: 0 },
  { nome: 'No meio, à esquerda', x: 0, y: 50 }, { nome: 'No centro', x: 50, y: 50 }, { nome: 'No meio, à direita', x: 100, y: 50 },
  { nome: 'Embaixo, à esquerda', x: 0, y: 100 }, { nome: 'Embaixo, no centro', x: 50, y: 100 }, { nome: 'Embaixo, à direita', x: 100, y: 100 },
];

const limitarPct = (v: number) => Math.min(100, Math.max(0, Math.round(v * 100) / 100));

/** Move o centro por (dx, dy) pontos percentuais, dentro de 0–100. */
export function moverLogo(p: PosicaoLogoEnvio, dx: number, dy: number): PosicaoLogoEnvio {
  return { ...p, x: limitarPct(p.x + dx), y: limitarPct(p.y + dy) };
}

/** Passo das setas do teclado; null para teclas que não movem. */
export function passoDaTecla(tecla: string, shift: boolean): { dx: number; dy: number } | null {
  const n = shift ? PASSO_SETA_SHIFT : PASSO_SETA;
  switch (tecla) {
    case 'ArrowLeft': return { dx: -n, dy: 0 };
    case 'ArrowRight': return { dx: n, dy: 0 };
    case 'ArrowUp': return { dx: 0, dy: -n };
    case 'ArrowDown': return { dx: 0, dy: n };
    default: return null;
  }
}

/** Arraste: deslocamento do ponteiro em px da caixa da arte na tela, convertido em pontos percentuais. */
export function arrastarLogo(inicio: PosicaoLogoEnvio, dxPx: number, dyPx: number, larguraPx: number, alturaPx: number): PosicaoLogoEnvio {
  if (!(larguraPx > 0) || !(alturaPx > 0)) return inicio;
  return moverLogo(inicio, dxPx / larguraPx * 100, dyPx / alturaPx * 100);
}

export const anuncioPosicao = (p: { x: number; y: number }) => `Logo a ${Math.round(p.x)}% da esquerda e ${Math.round(p.y)}% do topo.`;

/** §5: a tela mostra a última intenção (pendente ou em voo) por cima do que veio gravado. */
export function logoEfetiva(gravada: LogoLocal, fila: { mostrar?: boolean; posicoes: Record<string, PosicaoLogoEnvio> } | null): LogoLocal {
  if (!fila) return gravada;
  const posicoes = { ...gravada.posicoes };
  for (const [id, p] of Object.entries(fila.posicoes)) posicoes[id] = { ...p, origem: 'buffet' };
  return { mostrar: fila.mostrar ?? gravada.mostrar, posicoes };
}

/** §4: aviso conforme a origem da entrada da arte da prévia; `buffet` não tem aviso de origem. */
export function avisoOrigem(origem: OrigemLogo | undefined): string | null {
  switch (origem) {
    case 'reservada': return 'A logo foi colocada no lugar do nome do salão. Arraste para mudar ou volte para a faixa.';
    case 'sugerida': return 'A IA não deixou o espaço pedido. Colocamos a logo no melhor lugar livre. Confira se ela não cobre texto.';
    case 'faixa': return 'Não achamos um lugar livre na arte. A logo ficou na faixa abaixo do convite.';
    default: return null;
  }
}

export const AVISO_PERMANENTE_SOBRE = 'Confira se a logo não cobre texto da arte.';
export const AVISO_SEM_LUGAR = 'Não achamos um lugar livre na arte. Confira a posição ou volte para a faixa.';
export const AVISO_COBRINDO = 'A logo pode estar cobrindo texto da arte.';
export const AVISO_PREVIA_NAO_PUBLICADA = 'No convite publicado, vale a arte publicada até você publicar esta.';

/**
 * §4 (r15): ao desligar a logo, confere a arte da prévia e a publicada. `publicadoArteId` nulo = sem publicado ou
 * publicado sem arte; nesse caso só a prévia conta.
 */
export function avisoSemNome(previaArteId: string | null | undefined, publicadoArteId: string | null | undefined, semNome: readonly string[] | null | undefined): string | null {
  const lista = semNome ?? [];
  const previa = !!previaArteId && lista.includes(previaArteId);
  const publicado = !!publicadoArteId && lista.includes(publicadoArteId);
  const fim = ' Se quiser o nome escrito, gere de novo com a logo desligada.';
  if (previa && publicado) return `Esta arte e o convite publicado foram gerados sem o nome do salão. Sem a logo, os dois ficam sem o nome.${fim}`;
  if (previa) return `Esta arte foi gerada sem o nome do salão, porque a logo ocupa esse lugar. Sem a logo, ela fica sem o nome.${fim}`;
  if (publicado) return `O convite publicado foi gerado sem o nome do salão. Desligando a logo, quem abrir o convite agora não verá nem a logo nem o nome.${fim}`;
  return null;
}

export const TEXTO_SITUACAO_FILA: Record<'salvando' | 'salvo' | 'erro' | 'superada', string> = {
  salvando: 'Salvando…', salvo: 'Salvo', erro: 'Não foi salvo.', superada: 'Esta tela ficou desatualizada.',
};

export const ESPERA_MOSTRAR_MS = 5000;
export const TEXTO_ESPERANDO_LOGO = 'Salvando a escolha da logo…';
export const TEXTO_LOGO_NAO_SALVA = 'A escolha da logo não foi salva. Use “Tentar de novo” e gere outra vez.';

/**
 * §4: antes de `gerar`, espera o `mostrar` pendente ou em voo (até 5 s). Só uma pendência de posição não bloqueia.
 * Devolve o valor a enviar em `logoLigada`, ou null quando a geração não deve sair.
 */
export async function logoLigadaParaGerar(
  fila: { aguardarMostrar(ms: number): Promise<'ok' | 'tempo' | 'erro'> } | null,
  valorNaTela: () => boolean,
  esperando?: () => void,
): Promise<boolean | null> {
  if (!fila) return valorNaTela();
  const espera = fila.aguardarMostrar(ESPERA_MOSTRAR_MS);
  // aguardarMostrar já sai resolvida quando nada do `mostrar` está pendente; só avisa se de fato esperar.
  const r = await Promise.race([espera, Promise.resolve('agora' as const)]);
  if (r === 'agora') esperando?.();
  const final = r === 'agora' ? await espera : r;
  return final === 'ok' ? valorNaTela() : null;
}
