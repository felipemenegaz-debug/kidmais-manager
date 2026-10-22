import { NextResponse } from "next/server";
import { ipDaRequisicao } from "../acessos/http.ts";

/**
 * Limite de requisições das APIs públicas de cotação/fechamento/agenda (sem sessão).
 *
 *   LEITURA → catálogo, pacotes, adicionais, agenda e cotação: 120 por minuto por origem.
 *   PEDIDO  → envio do fechamento: 10 por hora por origem e 60 por hora por endereço de empresa.
 *   IDENTIDADE → consulta de CPF, envio e recuperação de código: 20 por hora por origem (contra enumeração).
 *
 * Janela fixa em memória, por instância (o web roda com 1 instância; com mais, cada uma conta a sua parte).
 * Sem escrita em banco por pedido. Origem = penúltimo X-Forwarded-For no Render, conferido (lib/acessos/http.ts).
 * Sem origem confiável, NUNCA o limite de um IP aplicado a todos: cada grupo conta por endereço de empresa (ou numa
 * chave comum, quando não há empresa) com teto SEM_ORIGEM_FATOR vezes maior, e o PEDIDO mantém o teto por empresa.
 * Assim, quem abusa sem origem esgota no máximo o balde daquela empresa, não o de todos. Nunca registra IP em log nem
 * devolve detalhe além do prazo.
 */
export type GrupoLimite = "LEITURA" | "PEDIDO" | "IDENTIDADE";
type Regra = { limite: number; janelaMs: number };
const REGRAS: Record<GrupoLimite, Regra> = {
  LEITURA: { limite: 120, janelaMs: 60_000 },
  PEDIDO: { limite: 10, janelaMs: 3_600_000 },
  IDENTIDADE: { limite: 20, janelaMs: 3_600_000 },
};
const PEDIDO_POR_EMPRESA: Regra = { limite: 60, janelaMs: 3_600_000 };
export const SEM_ORIGEM_FATOR = 10;
const MAXIMO_CHAVES = 20_000;

type Balde = { inicio: number; usados: number; janelaMs: number };
export function criarLimitador(agora: () => number = Date.now) {
  const baldes = new Map<string, Balde>();
  function consumir(chave: string, regra: Regra): number | null {
    const t = agora();
    let balde = baldes.get(chave);
    if (!balde || t - balde.inicio >= regra.janelaMs) {
      if (!balde && baldes.size >= MAXIMO_CHAVES) {
        for (const [k, b] of baldes) if (t - b.inicio >= b.janelaMs) baldes.delete(k);
        // Ainda cheio: recusa nova origem em vez de crescer sem limite (fail-closed sob ataque).
        if (baldes.size >= MAXIMO_CHAVES) return Math.ceil(regra.janelaMs / 1000);
      }
      balde = { inicio: t, usados: 0, janelaMs: regra.janelaMs };
      baldes.set(chave, balde);
    }
    if (balde.usados >= regra.limite) return Math.max(1, Math.ceil((balde.inicio + regra.janelaMs - t) / 1000));
    balde.usados += 1;
    return null;
  }
  return {
    /** Segundos até liberar, ou null quando o pedido pode seguir. */
    verificar(origem: string | null, grupo: GrupoLimite, empresa: string | null = null): number | null {
      const regra = REGRAS[grupo];
      const porOrigem = origem
        ? consumir(`${grupo}:${origem}`, regra)
        : consumir(`${grupo}_SEM_ORIGEM:${empresa ?? "*"}`, { ...regra, limite: regra.limite * SEM_ORIGEM_FATOR });
      if (porOrigem !== null) return porOrigem;
      if (grupo === "PEDIDO" && empresa) return consumir(`PEDIDO_EMPRESA:${empresa}`, PEDIDO_POR_EMPRESA);
      return null;
    },
    tamanho: () => baldes.size,
  };
}

const limitador = criarLimitador();

/** null = segue; senão a resposta 429 pronta (no-store, Retry-After). */
export function limitarPublico(
  request: { headers: { get(nome: string): string | null }; nextUrl?: URL; url?: string },
  grupo: GrupoLimite,
) {
  const origem = ipDaRequisicao(request);
  const url = request.nextUrl ?? (request.url ? new URL(request.url) : null);
  const empresa = url?.searchParams.get("empresa") || null;
  const espera = limitador.verificar(origem, grupo, empresa);
  if (espera === null) return null;
  return NextResponse.json(
    { ok: false, erro: "Muitas tentativas em pouco tempo. Aguarde um pouco e tente novamente.", codigo: "LIMITE_REQUISICOES" },
    { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(espera) } },
  );
}

/** Recusa do escopo público (endereço indisponível, catálogo sem empresa): mesmo status e código do resolvedor. */
export function respostaRecusaPublica(error: unknown) {
  const e = error as { httpStatus?: unknown; code?: unknown; message?: unknown };
  const status = typeof e?.httpStatus === "number" && e.httpStatus >= 400 && e.httpStatus < 600 ? e.httpStatus : 503;
  return NextResponse.json(
    { ok: false, erro: status < 500 && typeof e?.message === "string" ? e.message : "Indisponível no momento.", codigo: typeof e?.code === "string" ? e.code : "INDISPONIVEL" },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}