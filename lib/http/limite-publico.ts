import { NextResponse } from "next/server";
import { ipDaRequisicao } from "../acessos/http.ts";
import { idDaEmpresaPublica, type CarregarEmpresasAtivas } from "./empresas-publicas.ts";

/**
 * Limite de requisições das APIs públicas de cotação/fechamento/agenda (sem sessão).
 *
 *   LEITURA → catálogo, pacotes, adicionais, agenda e cotação: 120 por minuto por origem.
 *   PEDIDO  → envio do fechamento: 10 por hora por origem e 60 por hora por endereço de empresa.
 *   IDENTIDADE → consulta de CPF, envio e recuperação de código: 20 por hora por origem (contra enumeração).
 *
 * Janela fixa em memória, por instância (o web roda com 1 instância; com mais, cada uma conta a sua parte).
 * Sem escrita em banco por pedido. Origem = penúltimo X-Forwarded-For no Render, conferido (lib/acessos/http.ts).
 * Sem origem confiável, NUNCA o limite de um IP aplicado a todos: cada grupo conta pela empresa com teto
 * SEM_ORIGEM_FATOR vezes maior, e o PEDIDO mantém o teto por empresa.
 *
 * Empresa = chave CANÔNICA, nunca o texto bruto de `?empresa=` (revisão de 22/10, P2-R3-1: 20.000 códigos inventados
 * enchiam o mapa e todos recebiam 429). Código de empresa ATIVA conta pelo id da empresa: o registro
 * (lib/http/empresas-publicas.ts) é alimentado pelo resolvedor e por uma carga de todos os códigos ativos, feita antes de
 * cobrar um código desconhecido (no máximo uma carga por intervalo; P2-R4-1). Só código inexistente, inválido ou de
 * empresa criada depois da última carga cai no balde comum "empresa-nao-confirmada"; sem código, o endereço padrão.
 * Os baldes por IP e os demais têm capacidades separadas: nenhum dos dois esgota o outro. Nunca registra IP em log nem
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
// Chaves canônicas: 3 grupos × (empresas confirmadas + 2) + teto por empresa + sites; folga para nunca encher.
const MAXIMO_FIXOS = 50_000;

type Balde = { inicio: number; usados: number; janelaMs: number };
export function criarLimitador(agora: () => number = Date.now) {
  // Por IP (cresce com as origens; fail-closed no teto) e por empresa/sem origem (chaves canônicas, conjunto limitado).
  const porIp = new Map<string, Balde>();
  const fixos = new Map<string, Balde>();
  function consumir(chave: string, regra: Regra, baldes = fixos): number | null {
    const t = agora();
    let balde = baldes.get(chave);
    if (!balde || t - balde.inicio >= regra.janelaMs) {
      const maximo = baldes === porIp ? MAXIMO_CHAVES : MAXIMO_FIXOS;
      if (!balde && baldes.size >= maximo) {
        for (const [k, b] of baldes) if (t - b.inicio >= b.janelaMs) baldes.delete(k);
        // Ainda cheio: recusa nova chave em vez de crescer sem limite (fail-closed sob ataque).
        if (baldes.size >= maximo) return Math.ceil(regra.janelaMs / 1000);
      }
      balde = { inicio: t, usados: 0, janelaMs: regra.janelaMs };
      baldes.set(chave, balde);
    }
    if (balde.usados >= regra.limite) return Math.max(1, Math.ceil((balde.inicio + regra.janelaMs - t) / 1000));
    balde.usados += 1;
    return null;
  }
  return {
    /** Segundos até liberar, ou null. `empresa` é chave canônica (chaveDaEmpresaPublica ou `site:<id>`), nunca texto bruto. */
    verificar(origem: string | null, grupo: GrupoLimite, empresa: string | null = null): number | null {
      const regra = REGRAS[grupo];
      const porOrigem = origem
        ? consumir(`${grupo}:${origem}`, regra, porIp)
        : consumir(`${grupo}_SEM_ORIGEM:${empresa ?? "*"}`, { ...regra, limite: regra.limite * SEM_ORIGEM_FATOR });
      if (porOrigem !== null) return porOrigem;
      if (grupo === "PEDIDO" && empresa) return consumir(`PEDIDO_EMPRESA:${empresa}`, PEDIDO_POR_EMPRESA);
      return null;
    },
    tamanho: () => porIp.size + fixos.size,
  };
}

const limitador = criarLimitador();

/** Todos os códigos de empresas ATIVAS (uma consulta; import tardio para o módulo não abrir banco ao carregar). */
const carregarEmpresasAtivas: CarregarEmpresasAtivas = async (limite) => {
  const { db } = await import("../db/postgres.ts");
  return (await db().query<{ codigo: string; id: string }>(
    "SELECT codigo, id::text AS id FROM public.empresas WHERE status = 'ATIVA' AND codigo IS NOT NULL ORDER BY codigo LIMIT $1",
    [limite],
  )).rows;
};

/** Chave canônica da empresa do endereço: null = endereço padrão; empresa ATIVA = id; o resto, um balde comum. */
export async function chaveDaEmpresaPublica(codigo: string | null, carregar: CarregarEmpresasAtivas = carregarEmpresasAtivas) {
  if (!codigo) return null;
  const empresaId = await idDaEmpresaPublica(codigo, carregar);
  return empresaId ? `empresa:${empresaId}` : "empresa-nao-confirmada";
}

/** null = segue; senão a resposta 429 pronta (no-store, Retry-After). */
export async function limitarPublico(
  request: { headers: { get(nome: string): string | null }; nextUrl?: URL; url?: string },
  grupo: GrupoLimite,
  carregar: CarregarEmpresasAtivas = carregarEmpresasAtivas,
) {
  const origem = ipDaRequisicao(request);
  const url = request.nextUrl ?? (request.url ? new URL(request.url) : null);
  const espera = limitador.verificar(origem, grupo, await chaveDaEmpresaPublica(url?.searchParams.get("empresa") || null, carregar));
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