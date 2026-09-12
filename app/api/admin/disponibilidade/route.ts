import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { z } from "zod";
import { withTransaction } from "@/lib/db/postgres";
import {
  criarBloqueioAgenda,
  desativarBloqueioAgendaPorId,
  desativarBloqueiosExatos,
  existeBloqueioAgendaAtivoExato,
  listarConfiguracoesAgendaAtivas,
  listarTodosBloqueiosAtivos,
} from "@/lib/disponibilidade/repositories";
import { apiErrorResponse } from "@/lib/http/api-response";
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
const horaSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const operacaoSchema = z.discriminatedUnion("tipo", [
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

async function montarConfigAdmin() {
  const [comercial, bloqueios] = await Promise.all([
    lerComercial(),
    listarTodosBloqueiosAtivos(),
  ]);

  return {
    // Compatibilidade com DisponibilidadeConfig: a ocupação física não é mais
    // achatada para um turno inteiro. O painel usa os horários calculados pela
    // API pública e os bloqueios brutos abaixo.
    agenda: [],
    pacoteOverrides: comercial.pacoteOverrides,
    descontos: comercial.descontos,
    bloqueios,
  };
}

export async function GET(request: NextRequest) {
  try {
    await exigirApiAdminCrmDisponivel(request);
    return NextResponse.json(await montarConfigAdmin(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    await exigirApiAdminCrmDisponivel(request);
    const body = await request.json();
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

    if (op.tipo === "agenda") {
      const configs = await listarConfiguracoesAgendaAtivas();
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

      const contexto = contextoCrmDaRequest(request);
      await withTransaction(async (tx) => {
        await desativarBloqueiosExatos(
          {
            data: op.data,
            horarioInicio: config.horarioInicioPadrao,
            horarioFim: config.horarioFimPadrao,
          },
          tx,
        );

        if (op.status === "bloqueado") {
          await criarBloqueioAgenda(
            {
              data: op.data,
              horarioInicio: config.horarioInicioPadrao,
              horarioFim: config.horarioFimPadrao,
              motivo: op.motivo || "Bloqueio administrativo.",
              observacoes: "Criado pelo painel de Disponibilidade.",
              usuarioId: contexto.usuarioId,
            },
            tx,
          );
        }
      });
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
        const configs = await listarConfiguracoesAgendaAtivas();
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
      });

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

      const contexto = contextoCrmDaRequest(request);
      await withTransaction((tx) =>
        criarBloqueioAgenda(
          {
            data: op.data,
            diaInteiro,
            horarioInicio,
            horarioFim,
            motivo: op.motivo,
            observacoes: op.observacoes || null,
            usuarioId: contexto.usuarioId,
          },
          tx,
        ),
      );
    } else if (op.tipo === "desativar_bloqueio") {
      const desativado = await withTransaction((tx) =>
        desativarBloqueioAgendaPorId(op.bloqueioId, tx),
      );

      if (!desativado) {
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

    return NextResponse.json({ ok: true, config: await montarConfigAdmin() });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
