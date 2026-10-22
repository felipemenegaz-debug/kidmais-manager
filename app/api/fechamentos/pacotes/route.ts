import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/postgres";
import { codigoEmpresaDoPedido, escopoCotacaoPublica } from "@/lib/comercial/cotacao-publica";
import { buscarPacoteVigenteDaEmpresaPorCodigo, listarPacotesContrataveisDaEmpresa } from "@/lib/comercial/repositories";
import { PACOTES_CONTRATAVEIS_V1 } from "@/lib/comercial/pacotes-v1";
import { apiErrorResponse } from "@/lib/http/api-response";
import { limitarPublico } from "@/lib/http/limite-publico";
import { lerPrecosCorrentes } from "@/lib/comercial/pacote-precos";
import { lerRegrasPagamento } from "@/lib/comercial/regras-pagamento";
import { lerRegrasDisponibilidadePacote } from "@/lib/comercial/disponibilidade-pacote-publica";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function precoMinimo(linhas: Array<{ porConvidado: boolean; min: number; valor: number }>) {
  if (!linhas.length) return null;
  return Math.min(...linhas.map((l) => (l.porConvidado ? l.valor * l.min : l.valor))).toFixed(2);
}

export async function GET(request: NextRequest) {
  const limite = limitarPublico(request, "LEITURA");
  if (limite) return limite;
  try {
    const escopo = await escopoCotacaoPublica(db, codigoEmpresaDoPedido(request.nextUrl));
    const enderecoDaEmpresa = codigoEmpresaDoPedido(request.nextUrl) !== null;
    // "A partir de": menor valor do pacote na tabela publicada HOJE (fixo pela faixa; por convidado × mínimo).
    // Tabela ambígua ou ilegível não derruba a lista: o preço só some (a cotação da etapa seguinte explica).
    const precos = await lerPrecosCorrentes(db(), escopo.empresaId).catch(() => ({ pacotes: [] as Array<{ pacoteId: string; porConvidado: boolean; min: number; valor: number }> }));
    const pacotes = [];
    // Endereço atual (dona): os sete, na ordem do catálogo. /b/<código>: todos os pacotes ativos da empresa, na ordem da
    // tela de Pacotes — inclusive os criados por "Novo pacote" (P_…).
    const daEmpresa = [];
    if (enderecoDaEmpresa) daEmpresa.push(...await listarPacotesContrataveisDaEmpresa(escopo.empresaId, db()));
    else for (const { codigo } of PACOTES_CONTRATAVEIS_V1) daEmpresa.push(await buscarPacoteVigenteDaEmpresaPorCodigo(escopo.empresaId, codigo, db()));
    for (const pacote of daEmpresa) {
      if (pacote) pacotes.push({
        codigo: pacote.codigo, nome: pacote.nome, descricao: pacote.descricao,
        duracaoMinutos: pacote.duracaoMinutos, convidadosMinimos: pacote.convidadosMinimos,
        convidadosMaximos: pacote.convidadosMaximos,
        precoMinimo: precoMinimo(precos.pacotes.filter((p) => p.pacoteId === pacote.id)),
        // Endereço da empresa (/b/<código>): dias e períodos configurados por ela para o pacote, para a tela não
        // aplicar regra fixa da Kidmais pelo código. Endereço atual da Kidmais: resposta inalterada (sem o campo).
        ...(enderecoDaEmpresa ? { disponibilidade: await lerRegrasDisponibilidadePacote(db(), pacote.id) } : {}),
      });
    }
    // Regras de pagamento da empresa do endereço (077); null = antes da 077 (a tela usa o legado, como o servidor).
    const pagamento = await lerRegrasPagamento(db(), escopo.empresaId).catch(() => null);
    return NextResponse.json({ pacotes, pagamento }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiErrorResponse(error); }
}
