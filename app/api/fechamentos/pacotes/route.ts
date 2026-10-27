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
import { convidadosDaConsulta, pacoteComporta } from "@/lib/fechamentos/convidados-consulta";
import { pacotesElegiveisDoSalao } from "@/lib/agenda/salao-pacotes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function precoMinimo(linhas: Array<{ porConvidado: boolean; min: number; valor: number }>) {
  if (!linhas.length) return null;
  return Math.min(...linhas.map((l) => (l.porConvidado ? l.valor * l.min : l.valor))).toFixed(2);
}

export async function GET(request: NextRequest) {
  const limite = await limitarPublico(request, "LEITURA");
  if (limite) return limite;
  // S-C: com convidados, cada pacote diz se comporta; a lista não é filtrada (o cliente precisa do "ver mesmo assim").
  const convidados = convidadosDaConsulta(request.nextUrl.searchParams.get("convidados"));
  if (convidados === null) {
    return NextResponse.json(
      { ok: false, erro: "Informe a quantidade de convidados com um número inteiro de 1 a 1000.", codigo: "PARAMETROS_INVALIDOS" },
      { status: 400 },
    );
  }
  // S-D (D5.3/R-D2): com o salão de preferência, cada pacote diz se é do salão (mesmo universo da contratação), sem filtrar.
  const salao = request.nextUrl.searchParams.get("salao");
  if (salao !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(salao)) {
    return NextResponse.json({ ok: false, erro: "Salão inválido.", codigo: "PARAMETROS_INVALIDOS" }, { status: 400 });
  }
  try {
    const escopo = await escopoCotacaoPublica(db, codigoEmpresaDoPedido(request.nextUrl));
    const doSalao = salao ? new Set(await pacotesElegiveisDoSalao(db(), escopo.empresaId, salao.toLowerCase())) : null;
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
        ...(convidados ? { comporta: pacoteComporta(pacote, convidados) } : {}),
        ...(doSalao ? { noSalao: doSalao.has(pacote.id) } : {}),
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
