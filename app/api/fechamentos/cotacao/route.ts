import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { codigoEmpresaDoPedido, escopoCotacaoPublica } from "@/lib/comercial/cotacao-publica";
import { buscarPacoteVigenteDaEmpresaPorCodigo } from "@/lib/comercial/repositories";
import { calcularResumoComercial, isPricingServiceError } from "@/lib/comercial/services";
import { db } from "@/lib/db/postgres";
import { escopoDaEmpresa } from "@/lib/disponibilidade/escopo";
import { isAvailabilityServiceError, revalidarHorarioSelecionado } from "@/lib/disponibilidade/services";
import { mensagemPeriodoDoPedido, periodoDoPedido, temPeriodoDoPedido } from "@/lib/fechamentos/comercial-schema";
import { codigoDoPacoteDaTela } from "@/lib/comercial/pacotes-v1";
import { apiErrorResponse } from "@/lib/http/api-response";
import { limitarPublico } from "@/lib/http/limite-publico";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cotação do pacote para o fechamento público: o MESMO cálculo do envio (tabela publicada da empresa, categoria do
 * horário da agenda, faixa de convidados, mínimo faturável e desconto), só leitura. Substitui a tabela fixa da tela.
 */
const entrada = z.object({
  // Id V1 (endereço atual) ou código do pacote da empresa (/b/<código>); traduzido pelo endereço abaixo.
  pacote: z.string().min(1).max(50),
  dataFesta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // Horário configurado (configuracao_agenda.id); horarioBase é o legado TURNO_1/TURNO_2.
  configuracaoId: z.string().uuid().optional(),
  horarioBase: z.enum(["almoco", "noite"]).optional(),
  ajusteHorario: z.string().regex(/^-?\d{1,4}$/),
  horarioInicio: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  horarioFim: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  convidados: z.coerce.number().int().min(1).max(1000),
}).refine(temPeriodoDoPedido, mensagemPeriodoDoPedido);

const semCache = { "Cache-Control": "no-store" };
const CATEGORIA: Record<string, string> = { NOBRE: "Horário nobre", PADRAO: "Horário promocional", GERAL: "Todos os horários" };

export async function POST(request: NextRequest) {
  const limite = limitarPublico(request, "LEITURA");
  if (limite) return limite;
  const dados = entrada.safeParse(await request.json().catch(() => null));
  if (!dados.success) return NextResponse.json({ ok: false, erro: "Dados da cotação inválidos.", codigo: "DADOS_INVALIDOS" }, { status: 400, headers: semCache });
  try {
    // Pacote pelo endereço, sem banco: endereço atual = só os sete ids V1 (como antes); /b/<código> = também o código.
    const codigoPacote = codigoDoPacoteDaTela(dados.data.pacote, codigoEmpresaDoPedido(request.nextUrl) !== null);
    if (!codigoPacote) return NextResponse.json({ ok: false, erro: "Dados da cotação inválidos.", codigo: "DADOS_INVALIDOS" }, { status: 400, headers: semCache });
    const escopo = await escopoCotacaoPublica(db, codigoEmpresaDoPedido(request.nextUrl));
    const unidade = await escopoDaEmpresa(db(), escopo.empresaId, escopo.estabelecimentoId, { exigirUnidade: true });
    const horario = await revalidarHorarioSelecionado({
      data: dados.data.dataFesta,
      ...periodoDoPedido(dados.data),
      pacoteCodigo: codigoPacote,
      inicio: dados.data.horarioInicio,
      fim: dados.data.horarioFim,
      ajusteMinutos: Number(dados.data.ajusteHorario),
    }, undefined, { ...escopo, estabelecimentoId: unidade.estabelecimentoId });
    const pacote = await buscarPacoteVigenteDaEmpresaPorCodigo(escopo.empresaId, codigoPacote, db());
    if (!pacote) return NextResponse.json({ ok: false, erro: "Pacote indisponível.", codigo: "PACOTE_NAO_ENCONTRADO" }, { status: 404, headers: semCache });
    const resumo = await calcularResumoComercial({
      data: dados.data.dataFesta,
      configuracaoAgendaId: horario.periodo.configuracaoId,
      pacoteId: pacote.id,
      convidados: dados.data.convidados,
      adicionais: [],
      empresaEsperada: escopo.empresaId,
    }, db());
    const p = resumo.pacote;
    return NextResponse.json({
      ok: true,
      data: {
        valorTabela: p.valorTabelaBase,
        desconto: { percentual: p.desconto.percentual, valor: p.desconto.valor, titulo: p.desconto.titulo },
        valor: p.valorTabelaAplicado,
        categoria: p.precoRegra.categoriaHorario,
        categoriaNome: CATEGORIA[p.precoRegra.categoriaHorario] ?? p.precoRegra.categoriaHorario,
        convidadosFaturados: p.convidadosFaturados,
        minimoFaturavelAplicado: p.minimoFaturavelAplicado,
        faixa: { min: p.precoRegra.convidadosMin, max: p.precoRegra.convidadosMax },
      },
    }, { headers: semCache });
  } catch (error) {
    if (isPricingServiceError(error) || isAvailabilityServiceError(error)) {
      return NextResponse.json({ ok: false, erro: error.message, codigo: error.code }, { status: 409, headers: semCache });
    }
    return apiErrorResponse(error);
  }
}
