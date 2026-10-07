import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { z } from "zod";
import type { DbExecutor } from "@/lib/db/contracts";
import {
  criarBloqueioAgenda,
  desativarBloqueioAgendaPorId,
  desativarBloqueiosExatos,
  existeBloqueioAgendaAtivoExato,
  listarBloqueiosAtivosPorPeriodo,
  listarConfiguracoesAgendaAtivas,
  listarTodosBloqueiosAtivos,
} from "@/lib/disponibilidade/repositories";
import {
  agendaPorEscopoInstalada,
  escopoDaEmpresa,
  unidadesDaEmpresa,
  type EscopoAgenda,
} from "@/lib/disponibilidade/escopo";
import {
  AvailabilityServiceError,
  consultarDisponibilidadeData,
  consultarDisponibilidadePeriodo,
} from "@/lib/disponibilidade/services";
import { withTenantTransaction } from "@/lib/saas/provar-tenant";
import {
  bloqueioLegadoSemDono,
  liberarBloqueioLegadoPelaEmpresa,
  podeResolverBloqueioLegado,
  resolverEDesativarBloqueioLegado,
} from "@/lib/disponibilidade/bloqueios-legados";
import { apiErrorResponse } from "@/lib/http/api-response";
import { ehDonaDaConfigLegada, exigirDonaDaConfigLegada } from "@/lib/disponibilidade/config-legada";
import {
  contextoCrmDaRequest,
  exigirApiAdminCrmDisponivel,
} from "@/lib/http/admin-crm-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const arquivo = path.join(process.cwd(), "data", "disponibilidade.json");

const pacoteSchema = z.enum([
  "pocket",
  "mini",
  "compacta",
  "essencial",
  "completa",
  "premium",
  "pizza_party_scienza",
]);

const horarioSchema = z.enum(["almoco", "noite"]);
const dataSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const unidadeSchema = z.string().uuid().nullable().optional();
const horaSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const operacaoSchema = z.discriminatedUnion("tipo", [
  z.object({ tipo: z.literal("resolver_bloqueio_legado"), bloqueioId: z.string().uuid(), motivo: z.string().trim().min(5).max(1000) }),
  z.object({
    tipo: z.literal("agenda"),
    data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    horario: horarioSchema,
    status: z.enum(["bloqueado", "livre"]),
    motivo: z.string().trim().min(1).max(200).optional(),
  }),
  z.object({
    tipo: z.literal("criar_bloqueio"),
    data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    escopo: z.enum(["dia_inteiro", "turno_1", "turno_2", "personalizado"]),
    horarioInicio: horaSchema.optional(),
    horarioFim: horaSchema.optional(),
    motivo: z.string().trim().min(1).max(200),
    observacoes: z.string().trim().max(500).optional(),
  }),
  z.object({
    tipo: z.literal("desativar_bloqueio"),
    bloqueioId: z.string().uuid(),
    // Só usado quando o bloqueio é anterior à separação por empresa (fica registrado na resolução).
    motivo: z.string().trim().min(5).max(1000).optional(),
  }),
  z.object({
    tipo: z.literal("pacote"),
    data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    horario: horarioSchema,
    pacote: pacoteSchema,
    status: z.enum([
      "liberado",
      "consulta",
      "excecao",
      "bloqueado",
      "padrao",
    ]),
    motivo: z.string().max(200).optional(),
  }),
  z.object({
    tipo: z.literal("desconto"),
    data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    horario: horarioSchema,
    pacote: pacoteSchema,
    percentual: z.number().min(0).max(100),
    titulo: z.string().max(80).optional(),
  }),
  z.object({
    tipo: z.literal("remover_desconto"),
    data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    horario: horarioSchema,
    pacote: pacoteSchema,
  }),
]);

type ConfigLegada = {
  pacoteOverrides: Array<Record<string, unknown>>;
  descontos: Array<Record<string, unknown>>;
};

function horaParaMinutos(hora: string) {
  const [h, m] = hora.split(":").map(Number);
  return h * 60 + m;
}

async function lerComercial(): Promise<ConfigLegada> {
  try {
    const conteudo = await fs.readFile(arquivo, "utf8");
    const config = JSON.parse(conteudo) as Partial<ConfigLegada>;
    return {
      pacoteOverrides: config.pacoteOverrides ?? [],
      descontos: config.descontos ?? [],
    };
  } catch {
    const inicial: ConfigLegada = { pacoteOverrides: [], descontos: [] };
    await fs.mkdir(path.dirname(arquivo), { recursive: true });
    await fs.writeFile(arquivo, JSON.stringify(inicial, null, 2), "utf8");
    return inicial;
  }
}

async function salvarComercial(config: ConfigLegada) {
  await fs.writeFile(arquivo, JSON.stringify(config, null, 2), "utf8");
}

/**
 * Agenda da empresa COMPROVADA (Tenant Context) e da unidade escolhida (062). Sem a 062 instalada tudo continua
 * global, como antes; com ela, bloqueios e ocupações são os do recurso (os bloqueios sem dono continuam valendo
 * para todas as empresas e aparecem como GLOBAL, sem desativação pelo painel).
 */
async function escopoDoPedido(tx: DbExecutor, empresaId: string, unidadeId: string | null | undefined) {
  return escopoDaEmpresa(tx, empresaId, unidadeSchema.parse(unidadeId || null));
}

async function montarConfigAdmin(tx: DbExecutor, escopo: EscopoAgenda, empresaComprovada: string) {
  // E2: o arquivo é da instalação (agenda pública); só a empresa dona o vê. As demais recebem listas vazias.
  const configuracaoComercial = await ehDonaDaConfigLegada(tx, empresaComprovada);
  const comercial: ConfigLegada = configuracaoComercial ? await lerComercial() : { pacoteOverrides: [], descontos: [] };
  const bloqueios = await listarTodosBloqueiosAtivos(tx, escopo);
  const porEscopo = await agendaPorEscopoInstalada(tx);
  const unidades = porEscopo && escopo.empresaId ? await unidadesDaEmpresa(tx, escopo.empresaId) : [];

  return {
    agendaPorEscopo: porEscopo,
    unidades,
    unidadeId: escopo.estabelecimentoId,
    // Compatibilidade com DisponibilidadeConfig: a ocupação física não é mais
    // achatada para um turno inteiro. O painel usa os horários calculados pela
    // API pública e os bloqueios brutos abaixo.
    agenda: [],
    pacoteOverrides: comercial.pacoteOverrides,
    descontos: comercial.descontos,
    configuracaoComercial,
    bloqueios,
  };
}

export async function GET(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const q = request.nextUrl.searchParams;
    const data = q.get("data");
    const inicio = q.get("inicio");
    const fim = q.get("fim");
    const resposta = await withTenantTransaction(sessao, q.get("empresaId"), async (tx, tenant) => {
      const escopo = await escopoDoPedido(tx, tenant.empresaComprovada, q.get("unidadeId"));
      // Horários calculados do recurso (substitui, no painel, a API pública sem tenant).
      const dias = data
        ? [await consultarDisponibilidadeData(dataSchema.parse(data), tx, undefined, escopo)]
        : inicio && fim
          ? await consultarDisponibilidadePeriodo(dataSchema.parse(inicio), dataSchema.parse(fim), tx, undefined, escopo)
          : null;
      return { ...(await montarConfigAdmin(tx, escopo, tenant.empresaComprovada)), dias, podeResolverLegado: await agendaPorEscopoInstalada(tx) && await podeResolverBloqueioLegado(tx, sessao.usuario_id) };
    });
    return NextResponse.json(resposta, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const body = await request.json();
    const alvo = z.object({ empresaId: z.string().optional(), unidadeId: unidadeSchema }).passthrough().safeParse(body);
    const parsed = operacaoSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        {
          ok: false,
          erro: "Operação inválida.",
          codigo: "DADOS_INVALIDOS",
          detalhes: parsed.error.flatten(),
        },
        { status: 400 },
      );
    }

    const op = parsed.data;
    const contexto = contextoCrmDaRequest(request);
    return await withTenantTransaction(sessao, alvo.success ? alvo.data.empresaId : null, async (tx, tenant) => {
      const escopo = await escopoDoPedido(tx, tenant.empresaComprovada, alvo.success ? alvo.data.unidadeId : null);
      const comEscopo = { empresaId: escopo.empresaId, estabelecimentoId: escopo.estabelecimentoId };

      if (op.tipo === "agenda") {
        const configs = await listarConfiguracoesAgendaAtivas(tx, escopo);
        const config = configs.find((item) =>
          op.horario === "almoco"
            ? item.codigo === "TURNO_1" || item.ordemExibicao === 1
            : item.codigo === "TURNO_2" || item.ordemExibicao === 2,
        );

        if (!config) {
          return NextResponse.json(
            {
              ok: false,
              erro: "O período selecionado não possui configuração ativa.",
              codigo: "TURNO_NAO_CONFIGURADO",
            },
            { status: 409 },
          );
        }

        await desativarBloqueiosExatos(
          {
            data: op.data,
            horarioInicio: config.horarioInicioPadrao,
            horarioFim: config.horarioFimPadrao,
          },
          tx,
          escopo,
        );
        // Com a 062, "livre" não desfaz bloqueio sem dono (vale para todas as empresas): recusa e nada muda.
        if (op.status === "livre" && (await agendaPorEscopoInstalada(tx))) {
          const restantes = await listarBloqueiosAtivosPorPeriodo(op.data, op.data, tx, escopo);
          if (restantes.some((b) => b.alcance === "GLOBAL" && !b.diaInteiro
            && b.horarioInicio === config.horarioInicioPadrao && b.horarioFim === config.horarioFimPadrao)) {
            throw new AvailabilityServiceError(
              "BLOQUEIO_SEM_DONO",
              "Este horário tem um bloqueio anterior à separação da agenda por empresa. Ele só pode ser liberado depois da atribuição do dono.",
              409,
            );
          }
        }

        if (op.status === "bloqueado") {
          await criarBloqueioAgenda(
            {
              data: op.data,
              horarioInicio: config.horarioInicioPadrao,
              horarioFim: config.horarioFimPadrao,
              motivo: op.motivo || "Bloqueio administrativo.",
              observacoes: "Criado pelo painel de Disponibilidade.",
              usuarioId: contexto.usuarioId,
              ...comEscopo,
            },
            tx,
          );
        }
      } else if (op.tipo === "criar_bloqueio") {
        let diaInteiro = false;
        let horarioInicio: string | null = null;
        let horarioFim: string | null = null;

        if (op.escopo === "dia_inteiro") {
          diaInteiro = true;
        } else if (op.escopo === "personalizado") {
          if (!op.horarioInicio || !op.horarioFim) {
            return NextResponse.json(
              {
                ok: false,
                erro: "Informe o horário inicial e final do bloqueio personalizado.",
                codigo: "INTERVALO_OBRIGATORIO",
              },
              { status: 400 },
            );
          }

          if (horaParaMinutos(op.horarioFim) <= horaParaMinutos(op.horarioInicio)) {
            return NextResponse.json(
              {
                ok: false,
                erro: "O horário final deve ser posterior ao horário inicial.",
                codigo: "INTERVALO_INVALIDO",
              },
              { status: 400 },
            );
          }

          horarioInicio = op.horarioInicio;
          horarioFim = op.horarioFim;
        } else {
          const configs = await listarConfiguracoesAgendaAtivas(tx, escopo);
          const codigo = op.escopo === "turno_1" ? "TURNO_1" : "TURNO_2";
          const ordem = op.escopo === "turno_1" ? 1 : 2;
          const config = configs.find(
            (item) => item.codigo === codigo || item.ordemExibicao === ordem,
          );

          if (!config) {
            return NextResponse.json(
              {
                ok: false,
                erro: "O período selecionado não possui configuração ativa.",
                codigo: "TURNO_NAO_CONFIGURADO",
              },
              { status: 409 },
            );
          }

          horarioInicio = config.horarioInicioPadrao.slice(0, 5);
          horarioFim = config.horarioFimPadrao.slice(0, 5);
        }

        const duplicado = await existeBloqueioAgendaAtivoExato({
          data: op.data,
          diaInteiro,
          horarioInicio,
          horarioFim,
        }, tx, escopo);

        if (duplicado) {
          return NextResponse.json(
            {
              ok: false,
              erro: "Já existe um bloqueio ativo idêntico para esta data.",
              codigo: "BLOQUEIO_DUPLICADO",
            },
            { status: 409 },
          );
        }

        await criarBloqueioAgenda(
          {
            data: op.data,
            diaInteiro,
            horarioInicio,
            horarioFim,
            motivo: op.motivo,
            observacoes: op.observacoes || null,
            usuarioId: contexto.usuarioId,
            ...comEscopo,
          },
          tx,
        );
      } else if (op.tipo === "resolver_bloqueio_legado") {
        if (!await agendaPorEscopoInstalada(tx)) throw new AvailabilityServiceError("AGENDA_SEM_ESCOPO", "Use a desativação normal nesta agenda.", 409);
        await resolverEDesativarBloqueioLegado(tx, escopo, sessao, op.bloqueioId, op.motivo);
      } else if (op.tipo === "desativar_bloqueio") {
        // Bloqueio anterior à separação por empresa (sem dono): a própria empresa libera, com a decisão registrada;
        // bloqueio de agenda nunca pertence a contrato, então nenhuma reserva é afetada por esta liberação.
        const legado = (await agendaPorEscopoInstalada(tx)) && (await bloqueioLegadoSemDono(tx, op.bloqueioId));
        if (legado) {
          await liberarBloqueioLegadoPelaEmpresa(tx, escopo, sessao.usuario_id, op.bloqueioId, op.motivo);
        } else if (!(await desativarBloqueioAgendaPorId(op.bloqueioId, tx, escopo))) {
          return NextResponse.json(
            {
              ok: false,
              erro: "O bloqueio já não está ativo ou não foi encontrado.",
              codigo: "BLOQUEIO_NAO_ENCONTRADO",
            },
            { status: 404 },
          );
        }
      } else {
        await exigirDonaDaConfigLegada(tx, tenant.empresaComprovada);
        const config = await lerComercial();

        if (op.tipo === "pacote") {
          config.pacoteOverrides = config.pacoteOverrides.filter(
            (item) =>
              !(
                item.data === op.data &&
                item.horario === op.horario &&
                item.pacote === op.pacote
              ),
          );

          if (op.status !== "padrao") {
            config.pacoteOverrides.push({
              data: op.data,
              horario: op.horario,
              pacote: op.pacote,
              status: op.status,
              motivo: op.motivo || undefined,
            });
          }
        }

        if (op.tipo === "desconto") {
          config.descontos = config.descontos.filter(
            (item) =>
              !(
                item.data === op.data &&
                item.horario === op.horario &&
                item.pacote === op.pacote
              ),
          );
          config.descontos.push({
            data: op.data,
            horario: op.horario,
            pacote: op.pacote,
            percentual: op.percentual,
            titulo: op.titulo || undefined,
          });
        }

        if (op.tipo === "remover_desconto") {
          config.descontos = config.descontos.filter(
            (item) =>
              !(
                item.data === op.data &&
                item.horario === op.horario &&
                item.pacote === op.pacote
              ),
          );
        }

        await salvarComercial(config);
      }

      return NextResponse.json({ ok: true, config: await montarConfigAdmin(tx, escopo, tenant.empresaComprovada) });
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
