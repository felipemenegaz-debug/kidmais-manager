'use client';
import { buscasDaAbaBloqueadas, contextoDaPagina, PREFIXO_BUSCA_NA_ABA } from './contexto-empresa-cliente';

/**
 * Termo de busca guardado só nesta aba (decisão de Felipe em 08/11/2026: "Guardar na aba"). Ele volta no F5 e quando a
 * pessoa sai da tela e retorna pelo Voltar do navegador. Nunca vai à URL, ao histórico (`history.state`), ao
 * `localStorage` nem a outra aba aberta do zero; fechar a aba apaga.
 *
 * O termo pode ser o nome de uma pessoa ou de uma criança, então o registro:
 *   - fica preso à sessão e à empresa desta página, por um resumo de `sessao:empresa` (nunca o identificador cru). Outra
 *     sessão, outra pessoa ou outra empresa na mesma aba não o leem;
 *   - vence PRAZO_BUSCA_NA_ABA_MS depois da última busca ou filtro (ler não renova). A tela lê de novo a cada retorno à
 *     lista, inclusive na mesma instância, então um termo vencido não volta nem pelo estado React;
 *   - é apagado e BLOQUEADO (nada lido nem gravado) desde o início da saída, em todo descarte de contexto e na confirmação
 *     do fim da sessão; a tela de login apaga de novo (lib/http/contexto-empresa-cliente);
 *   - só vale no formato exato { v, termo, ctx, em }; qualquer outro é apagado.
 * Sem armazenamento disponível, nada volta (nem no retorno à lista): a busca só vale enquanto a lista está aberta.
 */
export const PRAZO_BUSCA_NA_ABA_MS = 30 * 60 * 1000;
const TAMANHO_MAXIMO = 80;

type Registro = { v: 1; termo: string; ctx: string; em: number };

/** Resumo não reversível na prática do contexto (cyrb53): só serve para comparar, não identifica a sessão. */
export function resumoDoContexto(texto: string) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < texto.length; i++) {
        const c = texto.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 2654435761);
        h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const CAMPOS = ['ctx', 'em', 'termo', 'v'];
const chaveDa = (tela: string) => `${PREFIXO_BUSCA_NA_ABA}${tela}`;

function apagar(chave: string) {
    try { sessionStorage.removeItem(chave); } catch { /* sem armazenamento */ }
}

/**
 * Guarda o termo da tela (uso real: busca ou filtro). Termo vazio, página sem contexto confirmado ou buscas bloqueadas
 * apagam o que houver. Falha ao gravar também apaga: a busca anterior não pode continuar restaurável.
 */
export function guardarBuscaNaAba(tela: string, termo: string, agora = Date.now()) {
    const chave = chaveDa(tela), ctx = contextoDaPagina(), t = termo.trim().slice(0, TAMANHO_MAXIMO);
    if (!t || !ctx || buscasDaAbaBloqueadas()) { apagar(chave); return; }
    const registro: Registro = { v: 1, termo: t, ctx: resumoDoContexto(ctx), em: agora };
    try { sessionStorage.setItem(chave, JSON.stringify(registro)); } catch { apagar(chave); }
}

/**
 * Termo guardado para a tela, ou '' quando não há, venceu, é de outro contexto, está fora do formato ou as buscas estão
 * bloqueadas (esses casos apagam). Ler não renova o prazo.
 */
export function lerBuscaDaAba(tela: string, agora = Date.now()): string {
    const chave = chaveDa(tela);
    if (buscasDaAbaBloqueadas()) { apagar(chave); return ''; }
    let bruto: string | null;
    try { bruto = sessionStorage.getItem(chave); } catch { return ''; }
    // Só a ausência sai aqui; texto vazio é registro inválido e é apagado pela validação abaixo.
    if (bruto === null) return '';
    const ctx = contextoDaPagina();
    let r: Partial<Registro> | null = null;
    try { r = JSON.parse(bruto) as Partial<Registro> | null; } catch { r = null; }
    const valido = !!r && typeof r === 'object' && !Array.isArray(r) && Object.keys(r).sort().join(',') === CAMPOS.join(',') && r.v === 1 && typeof r.termo === 'string' && r.termo.trim() !== '' && r.termo.length <= TAMANHO_MAXIMO
        && typeof r.em === 'number' && agora >= r.em && agora - r.em <= PRAZO_BUSCA_NA_ABA_MS
        && !!ctx && r.ctx === resumoDoContexto(ctx)
        // Texto exato do que guardarBuscaNaAba grava: recusa chave repetida (JSON.parse fica com a última) e qualquer variação.
        && bruto === JSON.stringify({ v: r.v, termo: r.termo, ctx: r.ctx, em: r.em });
    if (!valido) { apagar(chave); return ''; }
    return r!.termo!;
}
