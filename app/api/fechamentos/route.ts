import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { camposComerciaisFechamento } from "@/lib/fechamentos/comercial-schema";
import { PACOTE_CODIGO_BANCO, FORMA_PAGAMENTO_BANCO, moedaParaNumeroServidor, traduzirAdicionais } from "@/lib/fechamentos/comercial-input";
import { CondicaoPagamentoError } from "@/lib/comercial/condicao-pagamento";
import {
  isAvailabilityServiceError,
  revalidarHorarioSelecionado,
} from "@/lib/disponibilidade/services";
import { buscarPacoteAtivoPorCodigo } from "@/lib/comercial/repositories";
import { isPricingServiceError } from "@/lib/comercial/services";
import {
  criarFechamentoPublicoComIdentidade,
  isFechamentoServiceError,
} from "@/lib/fechamentos/services";
import { isIdentityServiceError } from "@/lib/identidade/services";
import { isClienteServiceError } from "@/lib/clientes/services";
import { pacoteIdContratavelV1 } from "@/lib/comercial/pacotes-v1";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const fechamentoSchema = z.object({
  identidadeTipo: z.enum(["NOVO_CLIENTE", "CLIENTE_EXISTENTE"]),
  provaIdentidade: z.string().trim().min(32).max(512).nullable().optional(),
  solicitarAtualizacaoCadastro: z.boolean().default(false),
  aniversarianteIdExistente: z.string().uuid().nullable().optional(),

  ...camposComerciaisFechamento,

  nomeCliente: z.string().trim().min(3),
  cpf: z.string().min(11),
  rg: z.string().trim().max(30).optional(),
  email: z.string().trim().email(),
  telefone: z.string().optional(),
  whatsapp: z.string().optional(),

  cep: z.string().min(8),
  logradouro: z.string().trim().min(2),
  numero: z.string().trim().min(1),
  complemento: z.string().optional(),
  bairro: z.string().trim().min(2),
  cidade: z.string().trim().min(2),
  uf: z.string().trim().length(2),

  outroResponsavel: z.string().trim().max(180).optional(),
  nomeAniversariante: z.string().trim().min(1),
  idadeAniversariante: z.union([z.number().int().min(0).max(120), z.literal("")]),
  temaFesta: z.string().trim().max(200).optional(),


});

function requestMetadata(request: NextRequest) {
  const forwarded = request.headers.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() || null;
  return {
    requestId: request.headers.get("x-request-id"),
    ip,
    userAgent: request.headers.get("user-agent"),
  };
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, erro: "Corpo JSON inválido.", codigo: "JSON_INVALIDO" },
      { status: 400 },
    );
  }

  const dados = fechamentoSchema.safeParse(body);
  if (!dados.success) {
    return NextResponse.json(
      { ok: false, erro: "Dados inválidos.", detalhes: dados.error.flatten() },
      { status: 400 },
    );
  }

  if (!pacoteIdContratavelV1(dados.data.pacote)) {
    return NextResponse.json(
      {
        ok: false,
        erro: "O pacote selecionado ainda não está disponível para fechamento online.",
        codigo: "PACOTE_FORA_ESCOPO_V1",
      },
      { status: 409 },
    );
  }

  if (
    dados.data.identidadeTipo === "CLIENTE_EXISTENTE" &&
    !dados.data.provaIdentidade
  ) {
    return NextResponse.json(
      {
        ok: false,
        erro: "Confirme sua identidade antes de concluir o Fechamento.",
        codigo: "IDENTIDADE_OBRIGATORIA",
      },
      { status: 401 },
    );
  }

  let horarioRevalidado: Awaited<ReturnType<typeof revalidarHorarioSelecionado>>;
  try {
    horarioRevalidado = await revalidarHorarioSelecionado({
      data: dados.data.dataFesta,
      codigoPeriodo: dados.data.horarioBase === "almoco" ? "TURNO_1" : "TURNO_2",
      inicio: dados.data.horarioInicio,
      fim: dados.data.horarioFim,
      ajusteMinutos: Number(dados.data.ajusteHorario),
    });
  } catch (error) {
    if (isAvailabilityServiceError(error)) {
      return NextResponse.json(
        { ok: false, erro: error.message, codigo: error.code },
        { status: error.httpStatus },
      );
    }
    throw error;
  }

  const valorProposto = moedaParaNumeroServidor(dados.data.valorCombinado);
  if (valorProposto === null) {
    return NextResponse.json(
      { ok: false, erro: "Informe um valor combinado válido.", codigo: "VALOR_PROPOSTO_INVALIDO" },
      { status: 400 },
    );
  }

  const adicionais = traduzirAdicionais(dados.data.adicionaisSelecionados);
  if (!adicionais.ok) {
    return NextResponse.json(
      { ok: false, erro: adicionais.erro, codigo: adicionais.codigo },
      { status: 409 },
    );
  }

  const codigoPacote = PACOTE_CODIGO_BANCO[dados.data.pacote];
  const pacote = await buscarPacoteAtivoPorCodigo(codigoPacote);
  if (!pacote) {
    return NextResponse.json(
      {
        ok: false,
        erro: "O pacote selecionado não está disponível para contratação.",
        codigo: "PACOTE_NAO_ENCONTRADO",
      },
      { status: 404 },
    );
  }

  try {
    const identidade =
      dados.data.identidadeTipo === "CLIENTE_EXISTENTE"
        ? ({
            tipo: "CLIENTE_EXISTENTE" as const,
            provaToken: dados.data.provaIdentidade!,
            atualizarCadastro: dados.data.solicitarAtualizacaoCadastro,
          })
        : ({ tipo: "NOVO_CLIENTE" as const });

    const resultado = await criarFechamentoPublicoComIdentidade({
      dataEvento: dados.data.dataFesta,
      horarioInicio: horarioRevalidado.candidato.inicio,
      horarioFim: horarioRevalidado.candidato.fim,
      configuracaoAgendaId: horarioRevalidado.periodo.configuracaoId,
      pacoteId: pacote.id,
      convidados: dados.data.convidadosPagantes,
      adicionais: adicionais.codigos.map((codigo) => ({ codigo, quantidade: 1 })),
      valorProposto,
      buffetStatus: dados.data.buffetDefinicao === "agora" ? "DEFINIDO" : "PENDENTE",
      buffetSalgados: dados.data.buffetSalgados,
      buffetBebidas: dados.data.buffetBebidas,
      buffetDoces: dados.data.buffetDoces,
      buffetBolo: dados.data.buffetBolo,
      buffetOutros: dados.data.buffetOutros,
      buffetLembrancinha: dados.data.buffetLembrancinha,
      buffetEmpratado: dados.data.buffetEmpratado,
      buffetBombom: dados.data.buffetBombom,
      alteracoesPacote: dados.data.alteracoesPacote,
      observacoesCliente: dados.data.observacoesCliente,
      idadeAniversarianteEvento:
        dados.data.idadeAniversariante === "" ? null : dados.data.idadeAniversariante,
      temaFesta: dados.data.temaFesta,
      formaPagamentoPretendida: FORMA_PAGAMENTO_BANCO[dados.data.formaPagamento],
      condicaoPixPretendida: dados.data.condicaoPixPretendida,
      responsavelAdicionalNome: dados.data.outroResponsavel,
      identidade,
      cliente: {
        nomeCompleto: dados.data.nomeCliente,
        cpf: dados.data.cpf,
        rg: dados.data.rg,
        telefone: dados.data.telefone,
        whatsapp: dados.data.whatsapp,
        email: dados.data.email,
        cep: dados.data.cep,
        logradouro: dados.data.logradouro,
        numero: dados.data.numero,
        complemento: dados.data.complemento,
        bairro: dados.data.bairro,
        cidade: dados.data.cidade,
        uf: dados.data.uf,
      },
      aniversariante: {
        aniversarianteIdExistente: dados.data.aniversarianteIdExistente,
        nome: dados.data.nomeAniversariante,
        temaPadrao: dados.data.temaFesta,
      },
      ...requestMetadata(request),
    });

    const fechamento = resultado.fechamento;
    const resumo = resultado.resumoComercial;

    return NextResponse.json(
      {
        ok: true,
        fechamentoId: fechamento.id,
        protocolo: `KM-${fechamento.id.slice(0, 8).toUpperCase()}`,
        status: fechamento.status,
        negociacaoNecessaria: resultado.negociacaoNecessaria,
        persistido: true,
        crm: {
          clienteNovo: resultado.cliente.novo,
          cadastroAtualizado: resultado.cliente.cadastroAtualizado,
          cadastroCompletoParaContrato: resultado.cliente.cadastroCompletoParaContrato,
          camposFaltantesParaContrato: resultado.cliente.camposFaltantesParaContrato,
          aniversarianteNovo: resultado.aniversariante.novo,
        },
        comercial: {
          pacote: {
            id: resumo.pacote.pacote.id,
            codigo: resumo.pacote.pacote.codigo,
            nome: resumo.pacote.pacote.nome,
          },
          tabelaPreco: {
            id: resumo.pacote.tabelaPreco.id,
            codigo: resumo.pacote.tabelaPreco.codigo,
            nome: resumo.pacote.tabelaPreco.nome,
          },
          categoriaHorario: resumo.pacote.categoriaHorario,
          categoriaPrecoAplicada: fechamento.categoriaPrecoAplicada,
          configuracaoAgendaId: fechamento.configuracaoAgendaId,
          convidadosInformados: resumo.pacote.convidadosInformados,
          convidadosFaturados: resumo.pacote.convidadosFaturados,
          minimoFaturavelAplicado: resumo.pacote.minimoFaturavelAplicado,
          valorTabelaPacoteBase: resumo.valorTabelaPacoteBase,
          descontoPacote: resumo.pacote.desconto,
          valorTabelaPacoteAplicado: resumo.valorTabelaPacoteAplicado,
          adicionais: resumo.adicionais.itens,
          valorAdicionais: resumo.valorAdicionais,
          valorTotalTabela: fechamento.valorTabela,
          valorProposto,
          valorNegociado: fechamento.valorNegociado,
          condicaoPagamento: fechamento.condicaoPagamento,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof CondicaoPagamentoError) {
      return NextResponse.json({ ok: false, erro: error.message, codigo: "DADOS_INVALIDOS" }, { status: 400 });
    }
    if (
      isPricingServiceError(error) ||
      isFechamentoServiceError(error) ||
      isIdentityServiceError(error) ||
      isClienteServiceError(error)
    ) {
      return NextResponse.json(
        {
          ok: false,
          erro: error.message,
          codigo: error.code,
          detalhes: error.details,
        },
        { status: error.httpStatus },
      );
    }

    console.error("[Kidmais Fechamentos API] erro não tratado", error);
    return NextResponse.json(
      { ok: false, erro: "Não foi possível concluir o Fechamento agora.", codigo: "ERRO_FECHAMENTO" },
      { status: 500 },
    );
  }
}
