import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/postgres";
import { codigoEmpresaDoPedido, escopoCotacaoPublica } from "@/lib/comercial/cotacao-publica";
import { buscarPacoteVigenteDaEmpresaPorCodigo } from "@/lib/comercial/repositories";
import { PACOTES_CONTRATAVEIS_V1 } from "@/lib/comercial/pacotes-v1";
import { apiErrorResponse } from "@/lib/http/api-response";
import { lerPrecosCorrentes } from "@/lib/comercial/pacote-precos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function precoMinimo(linhas: Array<{ porConvidado: boolean; min: number; valor: number }>) {
  if (!linhas.length) return null;
  return Math.min(...linhas.map((l) => (l.porConvidado ? l.valor * l.min : l.valor))).toFixed(2);
}

export async function GET(request: NextRequest) {
  try {
    const escopo = await escopoCotacaoPublica(db, codigoEmpresaDoPedido(request.nextUrl));
    // "A partir de": menor valor do pacote na tabela publicada HOJE (fixo pela faixa; por convidado × mínimo).
    // Tabela ambígua ou ilegível não derruba a lista: o preço só some (a cotação da etapa seguinte explica).
    const precos = await lerPrecosCorrentes(db(), escopo.empresaId).catch(() => ({ pacotes: [] as Array<{ pacoteId: string; porConvidado: boolean; min: number; valor: number }> }));
    const pacotes = [];
    for (const { codigo } of PACOTES_CONTRATAVEIS_V1) {
      const pacote = await buscarPacoteVigenteDaEmpresaPorCodigo(escopo.empresaId, codigo, db());
      if (pacote) pacotes.push({
        codigo: pacote.codigo, nome: pacote.nome, descricao: pacote.descricao,
        duracaoMinutos: pacote.duracaoMinutos, convidadosMinimos: pacote.convidadosMinimos,
        convidadosMaximos: pacote.convidadosMaximos,
        precoMinimo: precoMinimo(precos.pacotes.filter((p) => p.pacoteId === pacote.id)),
      });
    }
    return NextResponse.json({ pacotes }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiErrorResponse(error); }
}
