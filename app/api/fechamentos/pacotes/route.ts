import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/postgres";
import { codigoEmpresaDoPedido, escopoCotacaoPublica } from "@/lib/comercial/cotacao-publica";
import { apiErrorResponse } from "@/lib/http/api-response";
import { limitarPublico } from "@/lib/http/limite-publico";
import { pacotesDaOfertaPublica, precoMinimo, precosPublicosDeHoje } from "@/lib/comercial/oferta-publica";
import { lerRegrasPagamento } from "@/lib/comercial/regras-pagamento";
import { lerRegrasDisponibilidadePacote } from "@/lib/comercial/disponibilidade-pacote-publica";
import { convidadosDaConsulta, pacoteComporta } from "@/lib/fechamentos/convidados-consulta";
import { pacotesElegiveisDoSalao } from "@/lib/agenda/salao-pacotes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    // "A partir de" e catálogo efetivo do endereço (endereço atual: os sete V1; /b/<código>: todos os contratáveis da
    // empresa): os mesmos da faixa do salão combinado (E2b, lib/comercial/oferta-publica).
    const precos = await precosPublicosDeHoje(db(), escopo.empresaId);
    const pacotes = [];
    for (const pacote of await pacotesDaOfertaPublica(db(), escopo.empresaId, enderecoDaEmpresa)) {
      pacotes.push({
        codigo: pacote.codigo, nome: pacote.nome, descricao: pacote.descricao,
        duracaoMinutos: pacote.duracaoMinutos, convidadosMinimos: pacote.convidadosMinimos,
        convidadosMaximos: pacote.convidadosMaximos,
        precoMinimo: precoMinimo(precos.filter((p) => p.pacoteId === pacote.id)),
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
