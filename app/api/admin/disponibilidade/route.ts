import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { DbExecutor } from "@/lib/db/contracts";
import {
  criarBloqueioAgenda,
  desativarBloqueioAgendaPorId,
  desativarBloqueiosExatos,
  existeBloqueioAgendaAtivoExato,
  fonteOcupacoesDoRecurso,
  listarBloqueiosAtivosPorPeriodo,
  ocupacoesPorEmpresaInstaladas,
  listarConfiguracoesAgendaAtivas,
  listarTodosBloqueiosAtivos,
} from "@/lib/disponibilidade/repositories";
import {
  agendaPorEscopoInstalada,
  escopoDaEmpresa,
  escopoEUnidadesDaEmpresa,
  unidadesDaEmpresa,
  type EscopoAgenda,
  type UnidadeAgenda,
} from "@/lib/disponibilidade/escopo";
import { comSondagensDeCatalogoReutilizadas } from "@/lib/db/sondagens-catalogo";
import {
  AvailabilityServiceError,
  consultarDisponibilidadeData,
  consultarDisponibilidadePeriodo,
  duracaoAceita,
  duracaoDoPacoteDaEmpresa,
} from "@/lib/disponibilidade/services";
import { codigoDoPacoteDaTela } from "@/lib/comercial/pacotes-v1";
import { withTenantTransaction } from "@/lib/saas/provar-tenant";
import { travarConfiguracaoAgenda } from "@/lib/agenda/trava-configuracao";
import { listarPacotesContrataveisDaEmpresa } from "@/lib/comercial/repositories";
import { paginaPublica } from "@/lib/fechamentos/rota-publica";
import { escopoCotacaoPublica } from "@/lib/comercial/cotacao-publica";
import { pacotesDaAgendaDaEmpresa } from "@/lib/comercial/disponibilidade-pacote-publica";
import { descontosPublicosDaEmpresa } from "@/lib/comercial/descontos-dia-publico";
import { descontosPorIdV1 } from "@/lib/comercial/descontos-dia";
import {
  bloqueioLegadoSemDono,
  liberarBloqueioLegadoPelaEmpresa,
  podeResolverBloqueioLegado,
  resolverEDesativarBloqueioLegado,
} from "@/lib/disponibilidade/bloqueios-legados";
import { apiErrorResponse } from "@/lib/http/api-response";
import type { OcupacaoPreReserva } from "@/lib/pre-reserva/apresentacao-admin";
import { telaDoClienteGlobal } from "@/lib/enderecos/roteamento";
import { ehDonaDaConfigLegada, exigirDonaDaConfigLegada } from "@/lib/disponibilidade/config-legada";
import { lerConfigLegada, salvarConfigLegada, type ConfigLegada } from "@/lib/disponibilidade/config-legada-armazem";
import {
  contextoCrmDaRequest,
  exigirApiAdminCrmDisponivel,
} from "@/lib/http/admin-crm-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    // Horário configurado (configuracao_agenda.id); `horario` é o legado almoco/noite (TURNO_1/TURNO_2).
    configuracaoId: z.string().uuid().optional(),
    horario: horarioSchema.optional(),
    status: z.enum(["bloqueado", "livre"]),
    motivo: z.string().trim().min(1).max(200).optional(),
  }),
  z.object({
    tipo: z.literal("criar_bloqueio"),
    data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    // "horario": um horário configurado qualquer, pelo configuracaoId; turno_1/turno_2 seguem aceitos (legado).
    escopo: z.enum(["dia_inteiro", "turno_1", "turno_2", "horario", "personalizado"]),
    configuracaoId: z.string().uuid().optional(),
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

function horaParaMinutos(hora: string) {
  const [h, m] = hora.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Agenda da empresa COMPROVADA (Tenant Context) e da unidade escolhida (062). Sem a 062 instalada tudo continua
 * global, como antes; com ela, bloqueios e ocupações são os do recurso (os bloqueios sem dono continuam valendo
 * para todas as empresas e aparecem como GLOBAL, sem desativação pelo painel).
 */
async function escopoDoPedido(tx: DbExecutor, empresaId: string, unidadeId: string | null | undefined) {
  return escopoDaEmpresa(tx, empresaId, unidadeSchema.parse(unidadeId || null));
}

async function preReservasDaAgenda(
  tx: DbExecutor, escopo: EscopoAgenda, inicio: string, fim: string,
) {
  const { rows: [schema] } = await tx.query<{ instalada: boolean }>(
    "SELECT to_regprocedure('public.pre_reserva_exigir_configuracao()') IS NOT NULL AS instalada",
  );
  if (!schema?.instalada) return [];
  // A revisão comercial usa a mesma autorização da agenda: sessão administrativa
  // com acesso comercial e pedido da empresa comprovada, inclusive para a Equipe.
  // Com a 133, a segunda leitura das ocupações fica restrita à empresa (F3/F6 da Agenda lenta, 23/11/2026).
  const fonte = fonteOcupacoesDoRecurso(await ocupacoesPorEmpresaInstaladas(tx));
  const { rows } = await tx.query<OcupacaoPreReserva>(`
    SELECT o.data::text, left(o.horario_inicio::text, 5) AS inicio,
           left(o.horario_fim::text, 5) AS fim, s.nome AS salao,
           p.garantia_ate AS "garantiaAte", o.fechamento_id AS "fechamentoId"
    FROM ${fonte}
    JOIN pre_reserva_recebimentos p ON (p.empresa_id,p.fechamento_id)=(o.empresa_id,o.fechamento_id)
    LEFT JOIN agenda_saloes s ON (s.empresa_id,s.id)=(o.empresa_id,o.salao_id)
    WHERE o.origem='PRE_RESERVA' AND o.empresa_id=$3 AND p.garantia_ate > statement_timestamp()
      AND kidmais062_mesmo_recurso($3::uuid,$4::uuid,o.empresa_id,o.estabelecimento_id)
    ORDER BY o.data,o.horario_inicio,o.fechamento_id
  `, [inicio, fim, escopo.empresaId, escopo.estabelecimentoId]);
  return rows;
}

/** O que o GET já leu na mesma transação (Agenda lenta F2, 23/11/2026); o POST lê de novo depois de gravar. */
type JaLidoNoPedido = { dona: boolean; porEscopo: boolean; unidades: UnidadeAgenda[] };

async function montarConfigAdmin(tx: DbExecutor, escopo: EscopoAgenda, empresaComprovada: string, jaLido?: JaLidoNoPedido) {
  // E2: o arquivo é da instalação (agenda pública); só a empresa dona o vê. As demais recebem listas vazias.
  const configuracaoComercial = jaLido ? jaLido.dona : await ehDonaDaConfigLegada(tx, empresaComprovada);
  const comercial: ConfigLegada = configuracaoComercial ? await lerConfigLegada(tx) : { pacoteOverrides: [], descontos: [] };
  const bloqueios = await listarTodosBloqueiosAtivos(tx, escopo);
  const porEscopo = jaLido ? jaLido.porEscopo : await agendaPorEscopoInstalada(tx);
  const unidades = jaLido ? jaLido.unidades : porEscopo && escopo.empresaId ? await unidadesDaEmpresa(tx, escopo.empresaId) : [];
  // Status comercial dos pacotes: a dona da agenda pública mantém a regra legada (null, como em /fechamento); as demais
  // empresas, as regras configuradas por ELAS — a mesma leitura da cotação pública em /b/<código> e do servidor.
  // O seletor de pacote dessas empresas lista só os pacotes que elas têm (empresa nova = nenhum, sem catálogo Kidmais),
  // inclusive os criados por "Novo pacote"; o id de cada um é o código do pacote no banco (POCKET, P_…).
  const daEmpresa = configuracaoComercial
    ? null
    : await pacotesDaAgendaDaEmpresa(tx, empresaComprovada, listarPacotesContrataveisDaEmpresa);
  const regrasPacotes = daEmpresa ? daEmpresa.regras : null;
  const pacotes = daEmpresa ? daEmpresa.pacotes : null;
  // Astra r1, P2: a agenda do painel mostra o desconto por dia que a cotação do servidor cobra (regras da empresa,
  // as mesmas de /api/disponibilidade), e não os 15% fixos nem os descontos por data do arquivo. A dona da agenda
  // pública usa os ids V1 dos pacotes (como no endereço legado); as demais, o código do pacote.
  // Código da empresa lido uma vez: serve aos descontos e ao endereço público (antes, duas idas iguais).
  const codigo = (await tx.query<{ codigo: string }>("SELECT codigo FROM public.empresas WHERE id = $1::uuid", [empresaComprovada])).rows[0]?.codigo ?? null;
  const regrasDia = await descontosPublicosDaEmpresa(tx, empresaComprovada, codigo);
  const descontosEmpresa = regrasDia ? (configuracaoComercial ? descontosPorIdV1(regrasDia) : regrasDia) : null;

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
    ...(descontosEmpresa ? { descontosEmpresa } : {}),
    configuracaoComercial,
    regrasPacotes,
    pacotes,
    // "Ver tela do cliente": a dona continua no endereço atual; as demais, no endereço público delas (/b/<código>).
    telaDoCliente: configuracaoComercial ? telaDoClienteGlobal(process.env) : await telaDoClienteDaEmpresa(tx, empresaComprovada, codigo),
    bloqueios,
  };
}

/**
 * Só oferece o endereço que abriria: a mesma decisão da página pública /b/<código> (escopoCotacaoPublica — chave
 * COTACAO_PUBLICA_POR_EMPRESA, empresa ATIVA, Orçamento online no plano, situação comercial, unidade). Recusada,
 * null (a tela explica em vez de levar a um 404). A consulta roda num savepoint para não abortar a transação.
 */
async function telaDoClienteDaEmpresa(tx: DbExecutor, empresaId: string, codigo: string | null) {
  if (!codigo) return null;
  await tx.query("SAVEPOINT kidmais_tela_do_cliente");
  try {
    const escopo = await escopoCotacaoPublica(() => tx, codigo);
    await tx.query("RELEASE SAVEPOINT kidmais_tela_do_cliente");
    return escopo.empresaId === empresaId ? paginaPublica("/disponibilidade", codigo) : null;
  } catch {
    await tx.query("ROLLBACK TO SAVEPOINT kidmais_tela_do_cliente");
    return null;
  }
}

export async function GET(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const q = request.nextUrl.searchParams;
    const data = q.get("data");
    const inicio = q.get("inicio");
    const fim = q.get("fim");
    // 2c-2: duração da festa (minutos) para os inícios do horário livre; sem ela, 4 horas. Parecer do Astra (P2): com
    // `?pacote=` (id da tela), a do pacote vigente da empresa comprovada, lida no servidor.
    const resposta = await withTenantTransaction(sessao, q.get("empresaId"), async (transacao, tenant) => {
      // Agenda lenta F1 (23/11/2026): leitura só; a mesma sondagem de catálogo vai ao banco uma vez por requisição.
      const tx = comSondagensDeCatalogoReutilizadas(transacao);
      // F2: escopo, unidades e dona lidos uma vez e reaproveitados abaixo (antes, de novo em montarConfigAdmin).
      const lido = await escopoEUnidadesDaEmpresa(tx, tenant.empresaComprovada, unidadeSchema.parse(q.get("unidadeId") || null));
      const escopo = lido.escopo;
      const dona = await ehDonaDaConfigLegada(tx, tenant.empresaComprovada);
      // Id da tela → código, como no fechamento administrativo: dona da agenda pública = ids V1; demais = código próprio.
      const pacoteDaTela = q.get("pacote");
      const pacoteCodigo = pacoteDaTela ? codigoDoPacoteDaTela(pacoteDaTela, !dona) ?? undefined : undefined;
      const opcoes = { duracaoMinutos: duracaoAceita(q.get("duracao")) ?? await duracaoDoPacoteDaEmpresa(tx, tenant.empresaComprovada, pacoteCodigo), incluirCombinados: true };
      // Horários calculados do recurso (substitui, no painel, a API pública sem tenant).
      const dias = data
        ? [await consultarDisponibilidadeData(dataSchema.parse(data), tx, undefined, escopo, opcoes)]
        : inicio && fim
          ? await consultarDisponibilidadePeriodo(dataSchema.parse(inicio), dataSchema.parse(fim), tx, undefined, escopo, opcoes)
          : null;
      const primeiroDia = data || inicio;
      const ultimoDia = data || fim;
      const preReservas = primeiroDia && ultimoDia && q.get("preReservas") === "1"
        ? await preReservasDaAgenda(tx, escopo, primeiroDia, ultimoDia)
        : undefined;
      return { ...(await montarConfigAdmin(tx, escopo, tenant.empresaComprovada, { dona, porEscopo: lido.porEscopo, unidades: lido.unidades })), dias,
        ...(preReservas && { preReservas }), podeResolverLegado: lido.porEscopo && await podeResolverBloqueioLegado(tx, sessao.usuario_id) };
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
      // Liberar agenda com mais de um salão (rev. 3): empresa (FOR UPDATE do tenant) → configuração → resto como hoje.
      await travarConfiguracaoAgenda(tx, tenant.empresaComprovada, { modo: "COMPARTILHADA", linha: "JA_TRAVADA" });
      const comEscopo = { empresaId: escopo.empresaId, estabelecimentoId: escopo.estabelecimentoId };

      if (op.tipo === "agenda") {
        const configs = await listarConfiguracoesAgendaAtivas(tx, escopo);
        const config = op.configuracaoId
          ? configs.find((item) => item.id === op.configuracaoId)
          : op.horario
            ? configs.find((item) =>
                op.horario === "almoco"
                  ? item.codigo === "TURNO_1" || item.ordemExibicao === 1
                  : item.codigo === "TURNO_2" || item.ordemExibicao === 2,
              )
            : undefined;

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
          const config = op.escopo === "horario"
            ? (op.configuracaoId ? configs.find((item) => item.id === op.configuracaoId) : undefined)
            : configs.find(
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
        // 128: trava a linha até o COMMIT; duas gravações seguidas não se perdem.
        const config = await lerConfigLegada(tx, { travar: true });

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

        await salvarConfigLegada(tx, config);
      }

      return NextResponse.json({ ok: true, config: await montarConfigAdmin(tx, escopo, tenant.empresaComprovada) });
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
