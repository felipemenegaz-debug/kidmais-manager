'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import { anexada, anexar, inicial, nova, primeira, type FalhaLeitura, type RespostaLeitura } from './geracao';

export type FalhaSatisfacao = FalhaLeitura;
export { podeRepetir } from './geracao';

async function ler<T>(url: string, signal: AbortSignal): Promise<RespostaLeitura<T>> {
  const resposta = await adminFetch(url, { signal });
  const corpo = await resposta.json().catch(() => null) as ({ ok: true; data: T } | { ok: false; erro?: string; codigo?: string }) | null;
  if (corpo?.ok) return { ok: true, data: corpo.data };
  return { ok: false, falha: { status: resposta.status, codigo: (corpo && !corpo.ok && corpo.codigo) || null, mensagem: (corpo && !corpo.ok && corpo.erro) || 'Não foi possível carregar.' } };
}
const abortada = (e: unknown) => (e as { name?: string })?.name === 'AbortError';
const falhaDeRede = (mensagem: string): RespostaLeitura<never> => ({ ok: false, falha: { status: 0, codigo: null, mensagem } });

/**
 * Leitura viva das telas da Satisfação (PS-4 R3). O que está na tela pertence a UMA geração (ver `geracao.ts`): mudar
 * a URL — inclusive voltar a uma anterior — ou pedir de novo abre uma geração com número novo; respostas de gerações
 * encerradas são descartadas e as requisições delas (página 1 e "Ver mais") são abortadas. "Ver mais" é outra requisição
 * (snapshot novo, autorização refeita). Qualquer recusa SUBSTITUI tudo o que estava na tela (nenhum dado anterior fica).
 * `base` vazio = nada a consultar (PS4-R4-C2: período personalizado incompleto): nenhuma requisição, tela sem dados.
 */
export function useLeituraViva<T>(base: string) {
  const [g, setG] = useState(() => inicial<T>(base));
  // Transição de consulta no render (padrão do React para estado derivado de props): a geração antiga some neste render.
  if (g.base !== base) setG(nova(g, base));
  const pendentes = useRef(new Set<AbortController>());

  const { n, base: url } = g;
  useEffect(() => {
    if (!url) return;
    const abertos = pendentes.current;
    const controle = new AbortController();
    abertos.add(controle);
    ler<T>(url, controle.signal)
      .then((r) => setG((atual) => primeira(atual, n, r)))
      .catch((e: unknown) => { if (!abortada(e)) setG((atual) => primeira(atual, n, falhaDeRede('Não foi possível carregar.'))); })
      .finally(() => abertos.delete(controle));
    // Fim da geração n: aborta a página 1 e todo "Ver mais" ainda pendente dela.
    return () => { for (const c of abertos) c.abort(); abertos.clear(); };
  }, [n, url]);

  const verMais = useCallback(async (cursor: string) => {
    const controle = new AbortController();
    pendentes.current.add(controle);
    setG((atual) => anexar(atual, n));
    try {
      const r = await ler<T>(`${url}${url.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}`, controle.signal);
      setG((atual) => anexada(atual, n, r));
    } catch (e) {
      if (!abortada(e)) setG((atual) => anexada(atual, n, falhaDeRede('Não foi possível carregar mais.')));
    } finally {
      pendentes.current.delete(controle);
    }
  }, [n, url]);

  return {
    paginas: g.base === base ? g.paginas : [],
    falha: g.base === base ? g.falha : null,
    carregando: base !== '' && (g.base !== base || !g.carregada),
    anexando: g.base === base && g.anexando,
    verMais,
    recarregar: useCallback(() => setG((atual) => nova(atual, atual.base)), []),
  };
}

/** Recusa de leitura (403/404): a tela já não mostra nada do que foi recusado. */
export const recusada = (f: FalhaSatisfacao | null) => f !== null && (f.status === 403 || f.status === 404);

/** Mensagem dos estados de recusa/indisponível das telas da Satisfação. */
export function mensagemDaFalha(f: FalhaSatisfacao) {
  if (f.status === 404 || f.status === 403) {
    if (f.codigo === 'RECURSO_FORA_DO_PLANO') return { titulo: 'Satisfação não está no plano desta empresa', texto: f.mensagem };
    return { titulo: 'Sem acesso', texto: 'Você não tem acesso a estes dados. Fale com a gestão da empresa se precisar.' };
  }
  if (f.status === 503) return { titulo: 'A pesquisa está indisponível', texto: f.mensagem };
  if (f.status === 400) return { titulo: 'Filtro inválido', texto: f.mensagem };
  return { titulo: 'Não foi possível carregar', texto: f.mensagem };
}
