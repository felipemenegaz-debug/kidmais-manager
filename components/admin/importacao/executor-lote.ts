import { ENDPOINT_DOCUMENTOS, ENDPOINT_IMPORTACOES } from './cliente-importacao.ts';
import { aplicarAbertura, aplicarEnvio, iniciarPasso, loteOcupado, proximoPasso, type Lote, type Passo, type Retorno } from './fila-lote.ts';

/**
 * Execução da fila do lote (L1): um passo por vez, sempre pela rota atual de documentos e pela de importações.
 * Nunca envia empresa, usuário ou decisão: o servidor resolve tudo pela sessão. O arquivo fica só no navegador.
 */
type Buscador = (url: string, init: RequestInit) => Promise<Response>;

/** Preserva status, corpo e a causa tipada da exceção (ErroContextoAdmin: `tipo`, `enviado`). */
export async function chamar(buscar: Buscador, url: string, init: RequestInit): Promise<Retorno> {
  try {
    const r = await buscar(url, init);
    const corpo = await r.json().catch(() => undefined);
    return { tipo: 'resposta', status: r.status, corpo };
  } catch (erro) {
    const e = erro as { tipo?: unknown; enviado?: unknown; message?: unknown } | null;
    return { tipo: 'excecao', erro: { tipo: typeof e?.tipo === 'string' ? e.tipo : undefined, enviado: e?.enviado === true, message: typeof e?.message === 'string' ? e.message : 'Falha de conexão.' } };
  }
}

const postarJson = (corpo: object): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo) });

export type DependenciasLote = {
  buscar: Buscador;
  arquivo(itemId: string): File | undefined;
  agora(): number;
  /** Envolve a chamada INTEIRA (resposta + leitura do corpo, inclusive falha nessa leitura). Usado para contar o voo. */
  vigiar?<T>(chamada: () => Promise<T>): Promise<T>;
};

/** Resultado aplicado ao estado MAIS RECENTE do lote: item retirado ou lote parado no meio da chamada não volta. */
export type Aplicar = (lote: Lote) => Lote;

export async function executarPasso(lote: Lote, passo: Passo, deps: DependenciasLote): Promise<Aplicar> {
  const item = lote.itens.find((i) => i.id === passo.itemId)!;
  const vigiar = deps.vigiar ?? (<T,>(c: () => Promise<T>) => c());
  let retorno: Retorno;
  if (passo.tipo === 'ENVIAR') {
    const arquivo = deps.arquivo(item.id);
    if (!arquivo) return (l) => l;
    const form = new FormData();
    form.append('arquivo', arquivo);
    retorno = await vigiar(() => chamar(deps.buscar, ENDPOINT_DOCUMENTOS, { method: 'POST', body: form }));
  } else {
    // Primeira abertura: `abrir` com a identidade do item. Qualquer repetição: `retomar`, que nunca cria sucessora.
    const acao = passo.tipo === 'ABRIR' && !item.recuperar ? 'abrir' : 'retomar';
    retorno = await vigiar(() => chamar(deps.buscar, ENDPOINT_IMPORTACOES, postarJson({ acao, documentoId: item.documentoId, aberturaId: item.aberturaId })));
  }
  const agora = deps.agora();
  return (atual) => {
    // Contexto já invalidado: respostas tardias são descartadas (R1-2). Item retirado: fica retirado.
    if (atual.parada?.tipo === 'INVALIDAR') return atual;
    const alvo = atual.itens.find((i) => i.id === passo.itemId);
    if (!alvo || alvo.estado === 'RETIRADO') return atual;
    return passo.tipo === 'ENVIAR' ? aplicarEnvio(atual, passo.itemId, retorno, agora) : aplicarAbertura(atual, passo.itemId, retorno);
  };
}

/**
 * Laço do lote: pede o próximo passo ao estado atual, executa e aplica. Para quando não há passo (fim, pausa ou parada)
 * ou quando `ativo()` fica falso (componente desmontado ou lote trocado). Devolve o estado final conhecido.
 */
export async function rodarLote(ler: () => Lote, gravar: (aplicar: Aplicar) => void, deps: DependenciasLote, ativo: () => boolean): Promise<void> {
  for (;;) {
    if (!ativo()) return;
    const atual = ler();
    const passo = proximoPasso(atual, deps.agora());
    if (!passo) return;
    gravar((l) => iniciarPasso(l, passo));
    const aplicar = await executarPasso(ler(), passo, deps);
    if (!ativo()) return;
    gravar(aplicar);
  }
}

/**
 * Estado do lote fora do React (lido com useSyncExternalStore): a fila, os arquivos escolhidos (só no navegador) e a
 * geração. Trocar de lote ou desmontar a tela muda a geração e o laço anterior para sem aplicar mais nada.
 */
export function criarArmazemLote(deps: { buscar: Buscador; agora(): number; aoParar?(): void }) {
  let atual: Lote | null = null;
  let arquivos = new Map<string, File>();
  let geracao = 0;
  let rodando = false;
  let montado = true;
  // r3/r4 P2-3: chamadas em voo contadas no armazém, independentes do estado visual do item. A contagem cobre a
  // chamada inteira (resposta, leitura do corpo e falha nessa leitura): retirar um item não libera a tela antes disso.
  let voo = 0;
  const ouvintes = new Set<() => void>();
  const avisar = () => { for (const o of ouvintes) o(); };
  const vigiar = async <T,>(chamada: () => Promise<T>): Promise<T> => {
    voo += 1; avisar();
    try { return await chamada(); } finally { voo -= 1; avisar(); }
  };
  const armazem = {
    ler: (): Lote | null => atual,
    emVoo: (): number => voo,
    ocupado: (): boolean => voo > 0 || loteOcupado(atual),
    assinar(ouvinte: () => void) { ouvintes.add(ouvinte); return () => { ouvintes.delete(ouvinte); }; },
    aplicar(aplicar: Aplicar) { if (!atual) return; atual = aplicar(atual); avisar(); },
    iniciar(lote: Lote, escolhidos: Map<string, File>) { geracao += 1; arquivos = escolhidos; atual = lote; avisar(); armazem.rodar(); },
    encerrar() { geracao += 1; atual = null; arquivos = new Map(); avisar(); },
    montar() { montado = true; armazem.rodar(); },
    desmontar() { montado = false; geracao += 1; },
    rodar() {
      if (rodando || !atual) return;
      rodando = true;
      const minha = geracao;
      void rodarLote(() => atual!, armazem.aplicar, { buscar: deps.buscar, vigiar, agora: deps.agora, arquivo: (id) => arquivos.get(id) }, () => montado && minha === geracao)
        .finally(() => {
          rodando = false;
          // Um lote novo começou enquanto o anterior esperava a resposta: segue com o novo.
          if (montado && minha !== geracao && atual) armazem.rodar();
          if (montado) deps.aoParar?.();
        });
    },
  };
  return armazem;
}
