/**
 * Regras puras da logo sobre a arte no editor do buffet (plano etapa 3 r15.1, §4, §5 e §6).
 * Sem React e sem navegador: os textos e as decisões ficam aqui para os testes da tela.
 */
import type { ConfirmadosLogo, PosicaoLogoEnvio } from '@/lib/convites/fila-logo';
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

/**
 * r2 (Astra r1, P3): a geometria limita o centro à metade da caixa da logo. Setas, arraste, lugares e anúncio partem do
 * centro exibido, para não haver toques sem movimento depois de escolher um canto. `caixa` = caixa final em % da arte.
 */
export function limitarAoExibido(p: PosicaoLogoEnvio, caixa: { width: number; height: number } | null): PosicaoLogoEnvio {
  if (!caixa) return p;
  const mx = Math.min(50, caixa.width / 2), my = Math.min(50, caixa.height / 2);
  const dentro = (v: number, m: number) => Math.min(100 - m, Math.max(m, v));
  return { ...p, x: Math.round(dentro(p.x, mx) * 100) / 100, y: Math.round(dentro(p.y, my) * 100) / 100 };
}

/**
 * r2 (Astra r1, P2): a base gravada só recebe o que o servidor confirmou depois de `desde` (número da confirmação já
 * incorporada). Intenção descartada pela fila nunca entra na base.
 * r4 (Astra r3; Felipe 16/11: "Cortar releitura"): a logo é lida só na carga do convite, sem releitura automática. A base
 * é a leitura mais as confirmações desta aba posteriores ao início dela (`desde` = número confirmado da fila do convite
 * no início; 0 se a fila ainda não existia). Pendências ficam por cima na tela (`logoEfetiva`); nada espera a fila.
 */
export function incorporarConfirmados<T extends LogoLocal>(base: T, conf: ConfirmadosLogo, desde: number): T {
  if (conf.n <= desde) return base;
  const posicoes = { ...base.posicoes };
  for (const [id, c] of Object.entries(conf.posicoes)) if (c.n > desde) posicoes[id] = { ...c.valor, origem: 'buffet' };
  const mostrar = conf.mostrar && conf.mostrar.n > desde ? conf.mostrar.valor : base.mostrar;
  return { ...base, mostrar, posicoes };
}

/** r4: limite de cada leitura, uma nova tentativa depois da espera; na segunda falha, para e mostra o aviso. */
export const LIMITE_LEITURA_LOGO_MS = 10000;
export const ESPERA_NOVA_LEITURA_LOGO_MS = 1500;
export const TENTATIVAS_LEITURA_LOGO = 2;
export const AVISO_FALHA_LEITURA_LOGO = 'Não foi possível conferir a logo gravada.';
export const FALHA_CARGA_CONVITE = 'Não foi possível abrir o convite agora. Confira a conexão e tente de novo.';

export type RelogioLimite = { set(fn: () => void, ms: number): unknown; clear(t: unknown): void };
// setTimeout chamado como método de outro objeto dá "Illegal invocation" no navegador: sempre por função própria.
const RELOGIO_PADRAO: RelogioLimite = { set: (fn, ms) => setTimeout(fn, ms), clear: t => clearTimeout(t as ReturnType<typeof setTimeout>) };

/** Leitura cancelada (destino mudou, leitura mais nova ou editor fechado): não é falha, não repete e não avisa. */
export class LeituraCancelada extends Error { constructor() { super('Leitura cancelada.'); this.name = 'LeituraCancelada'; } }

/**
 * r4 (Astra r3, P2): uma leitura com limite que de fato para o pedido. `fazer` recebe o sinal e o repassa ao fetch;
 * no limite ou no cancelamento externo, o pedido é abortado, o relógio é limpo e a promessa rejeita na hora.
 */
export function lerComLimite<T>(fazer: (sinal: AbortSignal) => Promise<T>, ms: number, externo?: AbortSignal, relogio: RelogioLimite = RELOGIO_PADRAO): Promise<T> {
  return new Promise<T>((ok, falha) => {
    if (externo?.aborted) { falha(new LeituraCancelada()); return; }
    const ctrl = new AbortController();
    let fim = false;
    const sair = (f: () => void) => { if (fim) return; fim = true; relogio.clear(t); externo?.removeEventListener('abort', cancelar); f(); };
    const cancelar = () => sair(() => { ctrl.abort(); falha(new LeituraCancelada()); });
    const t = relogio.set(() => sair(() => { ctrl.abort(); falha(new Error('Tempo esgotado.')); }), ms);
    externo?.addEventListener('abort', cancelar, { once: true });
    let p: Promise<T>;
    try { p = fazer(ctrl.signal); } catch (e) { sair(() => falha(e)); return; }
    p.then(v => sair(() => ok(v)), e => sair(() => falha(e)));
  });
}

/** r4: até `tentativas` leituras com limite, esperando `esperaMs` entre elas; cancelamento não repete. */
export async function lerComRecuperacao<T>(fazer: (sinal: AbortSignal) => Promise<T>, o: { externo?: AbortSignal; relogio?: RelogioLimite; limiteMs?: number; esperaMs?: number; tentativas?: number; repetir?: (e: unknown) => boolean } = {}): Promise<T> {
  const relogio = o.relogio ?? RELOGIO_PADRAO, tentativas = o.tentativas ?? TENTATIVAS_LEITURA_LOGO;
  for (let i = 1; ; i++) {
    try { return await lerComLimite(fazer, o.limiteMs ?? LIMITE_LEITURA_LOGO_MS, o.externo, relogio); }
    catch (e) {
      if (e instanceof LeituraCancelada || i >= tentativas || (o.repetir && !o.repetir(e))) throw e;
      await new Promise<void>((ok, falha) => {
        if (o.externo?.aborted) { falha(new LeituraCancelada()); return; }
        const cancelar = () => { relogio.clear(t); falha(new LeituraCancelada()); };
        const t = relogio.set(() => { o.externo?.removeEventListener('abort', cancelar); ok(); }, o.esperaMs ?? ESPERA_NOVA_LEITURA_LOGO_MS);
        o.externo?.addEventListener('abort', cancelar, { once: true });
      });
    }
  }
}

/**
 * r5 (Astra r4, P2): cargas do editor em série. Cada uma começa depois de a anterior terminar e aplica na ordem em que
 * foi pedida, então nenhuma carga cancela outra (a carga depois de salvar sempre sincroniza o rascunho). `encerrar`
 * (saída do editor; trocar de convite remonta o editor pela `key`) cancela a carga em voo e as que estão na fila, que
 * resolvem `undefined` sem rodar. `abrir` reabre depois de encerrar (efeito montado de novo).
 */
export function controleDeCarga() {
  let fila: Promise<unknown> = Promise.resolve(), ctrl = new AbortController();
  return {
    abrir() { if (ctrl.signal.aborted) ctrl = new AbortController(); },
    encerrar() { ctrl.abort(); },
    executar<T>(fazer: (sinal: AbortSignal) => Promise<T>): Promise<T | undefined> {
      const sinal = ctrl.signal;
      const p = fila.then(() => (sinal.aborted ? undefined : fazer(sinal)));
      fila = p.catch(() => undefined);
      return p;
    },
  };
}

/**
 * r3 (Astra r2, P3): chave da caixa exibida; ações de posição só valem com a caixa desta arte, largura e fundo.
 * r4 (Astra r3, P3): um arraste só termina se a chave do início continua a da entrada atual.
 */
export const chaveDaCaixa = (p: { arteId: string; largura: number; fundo: boolean }) => `${p.arteId}|${p.largura}|${p.fundo ? 1 : 0}`;

export const anuncioPosicao =(p: { x: number; y: number }) => `Logo a ${Math.round(p.x)}% da esquerda e ${Math.round(p.y)}% do topo.`;

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
