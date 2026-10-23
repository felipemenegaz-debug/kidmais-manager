import type { DbExecutor } from "../db/contracts.ts";
import { auditarMutacaoComercial } from "../comercial/auditoria-comercial.ts";
import { AgendaConfiguracaoError } from "./configuracao-unidade.ts";

/**
 * 094 (decisão de Felipe em 22/10/2026): o sistema escolhe o salão da festa (lib/agenda/salao-festa.ts) e a equipe
 * pode trocá-lo depois, na tela da festa, por outro salão ativo do mesmo escopo que o horário e o pacote permitem e
 * que esteja livre no horário da festa (mesma regra de kidmais094_conflito_ocupacao).
 */
export type OpcaoSalao = { id: string; nome: string; livre: boolean; permitido: boolean };
export type SalaoDaFesta = { salaoAtual: { id: string; nome: string } | null; opcoes: OpcaoSalao[]; confirmada: boolean };

const FUNCAO_094 =
  "public.kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)";

function recusar(code: string, message: string, status = 409): never {
  throw new AgendaConfiguracaoError(code, message, status);
}

async function instalada(tx: DbExecutor) {
  const r = await tx.query<{ ok: boolean }>(`SELECT to_regprocedure('${FUNCAO_094}') IS NOT NULL AS ok`);
  return r.rows[0]?.ok === true;
}

type Festa = {
  id: string;
  status: string;
  data_evento: string | null;
  salao_id: string | null;
  salao_nome: string | null;
  por_salao: boolean;
};

async function festaDaEmpresa(tx: DbExecutor, empresaId: string, fechamentoId: string, travar: boolean) {
  const r = await tx.query<Festa>(
    `SELECT f.id::text AS id, f.status, f.data_evento::text AS data_evento, f.salao_id::text AS salao_id,
            (SELECT s.nome FROM agenda_saloes s WHERE s.id = f.salao_id) AS salao_nome,
            EXISTS (SELECT 1 FROM agenda_escopo_config c WHERE c.empresa_id = f.empresa_id
                     AND c.estabelecimento_id IS NOT DISTINCT FROM f.estabelecimento_id
                     AND c.capacidade_tipo = 'POR_SALAO') AS por_salao
       FROM fechamentos f
      WHERE f.id = $1::uuid AND f.empresa_id = $2::uuid${travar ? "\n      FOR UPDATE OF f" : ""}`,
    [fechamentoId, empresaId],
  );
  const festa = r.rows[0];
  if (!festa) recusar("FESTA_NAO_ENCONTRADA", "Festa não encontrada.", 404);
  return festa;
}

/** Salões ativos do escopo da festa: permitido pelo horário e pelo pacote (lista vazia = todos) e livre no horário. */
async function opcoesDaFesta(tx: DbExecutor, fechamentoId: string) {
  const r = await tx.query<OpcaoSalao>(
    `SELECT s.id::text AS id, s.nome,
            ((NOT EXISTS (SELECT 1 FROM configuracao_agenda_saloes h WHERE h.configuracao_agenda_id = f.configuracao_agenda_id)
              OR EXISTS (SELECT 1 FROM configuracao_agenda_saloes h WHERE h.configuracao_agenda_id = f.configuracao_agenda_id AND h.salao_id = s.id))
             AND (NOT EXISTS (SELECT 1 FROM pacote_saloes p WHERE p.pacote_id = f.pacote_id)
              OR EXISTS (SELECT 1 FROM pacote_saloes p WHERE p.pacote_id = f.pacote_id AND p.salao_id = s.id))) AS permitido,
            NOT kidmais094_conflito_ocupacao(f.id, f.data_evento, f.horario_inicio, f.horario_fim, f.empresa_id,
                                             f.estabelecimento_id, f.configuracao_agenda_id, s.id) AS livre
       FROM fechamentos f
       JOIN agenda_saloes s ON s.empresa_id = f.empresa_id AND s.estabelecimento_id IS NOT DISTINCT FROM f.estabelecimento_id AND s.ativo
      WHERE f.id = $1::uuid
      ORDER BY s.ordem, s.nome`,
    [fechamentoId],
  );
  return r.rows.map((o) => ({ id: o.id, nome: o.nome, livre: o.livre === true, permitido: o.permitido === true }));
}

function montar(festa: Festa, opcoes: OpcaoSalao[]): SalaoDaFesta {
  return {
    salaoAtual: festa.salao_id ? { id: festa.salao_id, nome: festa.salao_nome ?? "Salão" } : null,
    opcoes,
    confirmada: festa.status === "CONFIRMADO",
  };
}

/** Null sem a 094 ou quando a capacidade do escopo da festa não é por salão. */
export async function lerSalaoDaFesta(tx: DbExecutor, empresaId: string, fechamentoId: string): Promise<SalaoDaFesta | null> {
  if (!(await instalada(tx))) return null;
  const festa = await festaDaEmpresa(tx, empresaId, fechamentoId, false);
  if (!festa.por_salao) return null;
  return montar(festa, await opcoesDaFesta(tx, fechamentoId));
}

export async function trocarSalaoDaFesta(
  tx: DbExecutor,
  ctx: { empresaId: string; usuarioId: string | null; requestId: string | null },
  fechamentoId: string,
  salaoId: string,
): Promise<SalaoDaFesta | null> {
  if (!(await instalada(tx))) recusar("SALOES_INDISPONIVEIS", "A escolha de salão ainda não está disponível.");
  // Ordem de locks igual à do pagamento e da revisão (parecer do Astra, P2): primeiro o fechamento, depois as datas
  // (a da festa e a do destino de remarcação aberta), em ordem, pela mesma função da 014.
  const festa = await festaDaEmpresa(tx, ctx.empresaId, fechamentoId, true);
  if (!festa.data_evento) recusar("FESTA_SEM_DATA", "A festa ainda não tem data.");
  await tx.query(
    `SELECT public.kidmais_lock_datas_revisao(ARRAY[$2::date] || coalesce((SELECT array_agg(r.data_evento) FROM fechamento_revisoes r
       WHERE r.fechamento_id = $1::uuid AND r.estado IN ('EM_ELABORACAO', 'CONGELADA')), ARRAY[]::date[]))`,
    [fechamentoId, festa.data_evento],
  );
  if (festa.status === "CANCELADO") recusar("FESTA_CANCELADA", "A festa está cancelada.");
  if (!festa.por_salao) recusar("SEM_CAPACIDADE_POR_SALAO", "A agenda desta unidade não usa salões.");
  const opcoes = await opcoesDaFesta(tx, fechamentoId);
  const escolhido = opcoes.find((o) => o.id === salaoId);
  if (!escolhido) recusar("SALAO_NAO_ENCONTRADO", "Salão não encontrado nesta unidade.", 404);
  if (festa.salao_id === escolhido.id) return montar(festa, opcoes);
  if (!escolhido.permitido) recusar("SALAO_NAO_PERMITIDO", `O salão ${escolhido.nome} não é permitido para este horário ou pacote.`);
  if (!escolhido.livre) recusar("SALAO_OCUPADO", `${escolhido.nome} não está livre nesse horário.`);
  await tx.query(`UPDATE fechamentos SET salao_id = $2::uuid WHERE id = $1::uuid AND empresa_id = $3::uuid`, [
    fechamentoId,
    escolhido.id,
    ctx.empresaId,
  ]);
  await auditarMutacaoComercial(tx, {
    usuarioId: ctx.usuarioId,
    requestId: ctx.requestId,
    acao: "FESTA_SALAO_TROCADO",
    entidadeTipo: "FECHAMENTO",
    entidadeId: fechamentoId,
    empresaId: ctx.empresaId,
    antes: { salaoId: festa.salao_id, salaoNome: festa.salao_nome },
    depois: { salaoId: escolhido.id, salaoNome: escolhido.nome },
    motivo: null,
  });
  return lerSalaoDaFesta(tx, ctx.empresaId, fechamentoId);
}
