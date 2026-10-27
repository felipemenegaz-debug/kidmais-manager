import type { DbExecutor } from "../db/contracts.ts";
import { auditarMutacaoComercial } from "../comercial/auditoria-comercial.ts";
import { AgendaConfiguracaoError } from "./configuracao-unidade.ts";
import { combinadosInstalados, definirSalaoDestinoRevisao } from "./salao-festa.ts";

/**
 * 094 (decisão de Felipe em 22/10/2026): o sistema escolhe o salão da festa (lib/agenda/salao-festa.ts) e a equipe
 * pode trocá-lo depois, na tela da festa, por outro salão ativo do mesmo escopo que o horário e o pacote permitem e
 * que esteja livre no horário da festa (mesma regra de kidmais094_conflito_ocupacao).
 */
export type OpcaoSalao = { id: string; nome: string; livre: boolean; permitido: boolean; combinado?: boolean; membros?: string[] };
/**
 * S-E (R-E3/R3-E1): contratoFixa = salão do contrato ASSINADO vigente (V3), que só muda por uma nova versão assinada;
 * trocaEmAndamento = destino escolhido na revisão aberta (o salão atual continua valendo até a aplicação).
 */
export type SalaoDaFesta = {
  salaoAtual: { id: string; nome: string } | null; opcoes: OpcaoSalao[]; confirmada: boolean;
  contratoFixa?: { id: string; nome: string } | null;
  trocaEmAndamento?: { revisaoId: string; estado: string; salao: { id: string; nome: string } | null } | null;
};

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

/**
 * Salões ativos do escopo da festa: permitido pelo horário e pelo pacote (lista vazia = todos) e livre no horário.
 * 098: só elegíveis (combinado com membro inativo sai da lista), com o tipo e os nomes dos membros.
 * S-E (P2 do Astra, 27/10): com revisaoId, as opções são as do DESTINO da revisão (data, horário, configuração, pacote e
 * convidados da revisão), não as da festa atual; "permitido" inclui comportar os convidados (mesma regra estrita de
 * serveNoDestino). Numa remarcação D1 → D2, um salão ocupado em D1 e livre em D2 aparece livre.
 */
async function opcoesDaFesta(tx: DbExecutor, fechamentoId: string, revisaoId: string | null = null) {
  const v098 = await combinadosInstalados(tx);
  const d = revisaoId ? "r" : "f";
  const minimo = revisaoId ? await minimoInstalado(tx) : false;
  const comporta = revisaoId
    ? `
             AND (r.convidados IS NULL OR ((s.capacidade_convidados IS NULL OR r.convidados <= s.capacidade_convidados)${minimo ? " AND (s.convidados_minimo IS NULL OR r.convidados >= s.convidados_minimo)" : ""}))`
    : "";
  const r = await tx.query<OpcaoSalao>(
    `SELECT s.id::text AS id, s.nome,
            ${v098 ? "s.combinado, ARRAY(SELECT m.nome FROM agenda_saloes m WHERE m.id = ANY (s.membros) ORDER BY m.ordem, m.nome) AS membros," : ""}
            ((NOT EXISTS (SELECT 1 FROM configuracao_agenda_saloes h WHERE h.configuracao_agenda_id = ${d}.configuracao_agenda_id)
              OR EXISTS (SELECT 1 FROM configuracao_agenda_saloes h WHERE h.configuracao_agenda_id = ${d}.configuracao_agenda_id AND h.salao_id = s.id))
             AND (NOT EXISTS (SELECT 1 FROM pacote_saloes p WHERE p.pacote_id = ${d}.pacote_id)
              OR EXISTS (SELECT 1 FROM pacote_saloes p WHERE p.pacote_id = ${d}.pacote_id AND p.salao_id = s.id))${comporta}) AS permitido,
            NOT kidmais094_conflito_ocupacao(f.id, ${d}.data_evento, ${d}.horario_inicio, ${d}.horario_fim, f.empresa_id,
                                             f.estabelecimento_id, ${d}.configuracao_agenda_id, s.id) AS livre
       FROM fechamentos f${revisaoId ? "\n       JOIN fechamento_revisoes r ON r.fechamento_id = f.id AND r.id = $2::uuid" : ""}
       JOIN agenda_saloes s ON s.empresa_id = f.empresa_id AND s.estabelecimento_id IS NOT DISTINCT FROM f.estabelecimento_id AND s.ativo
      WHERE f.id = $1::uuid${v098 ? " AND kidmais098_salao_elegivel(s.id)" : ""}
      ORDER BY s.ordem, s.nome`,
    revisaoId ? [fechamentoId, revisaoId] : [fechamentoId],
  );
  return r.rows.map((o) => ({
    id: o.id, nome: o.nome, livre: o.livre === true, permitido: o.permitido === true,
    ...(o.combinado ? { combinado: true, membros: o.membros ?? [] } : {}),
  }));
}

function montar(festa: Festa, opcoes: OpcaoSalao[], contrato: ContratoDaFesta = { fixa: null, revisao: null }): SalaoDaFesta {
  return {
    salaoAtual: festa.salao_id ? { id: festa.salao_id, nome: festa.salao_nome ?? "Salão" } : null,
    opcoes,
    confirmada: festa.status === "CONFIRMADO",
    ...(contrato.fixa ? { contratoFixa: contrato.fixa } : {}),
    ...(contrato.revisao ? { trocaEmAndamento: contrato.revisao } : {}),
  };
}

type ContratoDaFesta = {
  fixa: { id: string; nome: string } | null;
  revisao: { revisaoId: string; estado: string; salao: { id: string; nome: string } | null } | null;
};

/** S-E: salão fixado pelo contrato assinado vigente (snapshot V3) e a revisão aberta, se houver. */
async function contratoDaFesta(tx: DbExecutor, fechamentoId: string): Promise<ContratoDaFesta> {
  const r = (await tx.query<{ fixa: { id: string; nome: string } | null; rid: string | null; estado: string | null; sid: string | null; snome: string | null }>(
    `SELECT CASE WHEN (v.snapshot->>'schemaVersao') = '3' THEN v.snapshot->'evento'->'salao' END AS fixa,
            r.id::text AS rid, r.estado, r.salao_id::text AS sid, s.nome AS snome
       FROM contratos c
       LEFT JOIN contrato_fluxos cf ON cf.contrato_id = c.id
       LEFT JOIN contrato_versoes v ON v.id = cf.versao_vigente_id
       LEFT JOIN fechamento_revisoes r ON r.fechamento_id = c.fechamento_id AND r.estado IN ('EM_ELABORACAO', 'CONGELADA')
       LEFT JOIN agenda_saloes s ON s.id = r.salao_id
      WHERE c.fechamento_id = $1::uuid`,
    [fechamentoId],
  )).rows[0];
  if (!r) return { fixa: null, revisao: null };
  const fixa = r.fixa && typeof r.fixa === "object" && r.fixa.id ? { id: String(r.fixa.id), nome: String(r.fixa.nome) } : null;
  return { fixa, revisao: r.rid ? { revisaoId: r.rid, estado: r.estado!, salao: r.sid ? { id: r.sid, nome: r.snome ?? "Salão" } : null } : null };
}

async function minimoInstalado(tx: DbExecutor) {
  return (await tx.query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.agenda_saloes') AND attname = 'convidados_minimo' AND NOT attisdropped) AS ok`,
  )).rows[0]?.ok === true;
}

/** S-E: o salão escolhido serve no DESTINO da revisão (horário, pacote, elegível, livre e comporta). */
async function serveNoDestino(tx: DbExecutor, revisaoId: string, salaoId: string) {
  const minimo = await minimoInstalado(tx);
  const v098 = await combinadosInstalados(tx);
  const r = await tx.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM fechamento_revisoes r JOIN fechamentos f ON f.id = r.fechamento_id
         JOIN agenda_saloes s ON s.id = $2::uuid AND s.ativo AND s.empresa_id = f.empresa_id AND s.estabelecimento_id IS NOT DISTINCT FROM f.estabelecimento_id
        WHERE r.id = $1::uuid ${v098 ? "AND kidmais098_salao_elegivel(s.id)" : ""}
          AND (NOT EXISTS (SELECT 1 FROM configuracao_agenda_saloes h WHERE h.configuracao_agenda_id = r.configuracao_agenda_id)
               OR EXISTS (SELECT 1 FROM configuracao_agenda_saloes h WHERE h.configuracao_agenda_id = r.configuracao_agenda_id AND h.salao_id = s.id))
          AND (NOT EXISTS (SELECT 1 FROM pacote_saloes p WHERE p.pacote_id = r.pacote_id)
               OR EXISTS (SELECT 1 FROM pacote_saloes p WHERE p.pacote_id = r.pacote_id AND p.salao_id = s.id))
          AND (r.convidados IS NULL OR ((s.capacidade_convidados IS NULL OR r.convidados <= s.capacidade_convidados)
               ${minimo ? "AND (s.convidados_minimo IS NULL OR r.convidados >= s.convidados_minimo)" : ""}))
          AND NOT kidmais094_conflito_ocupacao(f.id, r.data_evento, r.horario_inicio, r.horario_fim, f.empresa_id, f.estabelecimento_id, r.configuracao_agenda_id, s.id)
     ) AS ok`,
    [revisaoId, salaoId],
  );
  return r.rows[0]?.ok === true;
}

/** Null sem a 094 ou quando a capacidade do escopo da festa não é por salão. */
export async function lerSalaoDaFesta(tx: DbExecutor, empresaId: string, fechamentoId: string): Promise<SalaoDaFesta | null> {
  if (!(await instalada(tx))) return null;
  const festa = await festaDaEmpresa(tx, empresaId, fechamentoId, false);
  if (!festa.por_salao) return null;
  const contrato = await contratoDaFesta(tx, fechamentoId);
  return montar(festa, await opcoesDaFesta(tx, fechamentoId, destinoDaTroca(contrato)), contrato);
}

/** S-E: com contrato que fixa o salão e revisão aberta, a escolha é para o destino da revisão (opções do destino). */
function destinoDaTroca(contrato: ContratoDaFesta) {
  return contrato.fixa && contrato.revisao ? contrato.revisao.revisaoId : null;
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
  // S-E (R-E3/R3-E1, P1 do Astra): com contrato ASSINADO que fixa o salão (V3), a festa não muda de salão aqui. A troca é o
  // destino de uma revisão aberta (o salão atual continua valendo até a aplicação atômica da nova versão assinada);
  // revisão congelada não é editada (cancele e crie outra); sem revisão, é preciso abrir uma nova versão do contrato.
  const contrato = await contratoDaFesta(tx, fechamentoId);
  const opcoes = await opcoesDaFesta(tx, fechamentoId, destinoDaTroca(contrato));
  if (contrato.fixa) {
    const rev = contrato.revisao;
    if (!rev) recusar("TROCA_EXIGE_NOVA_VERSAO", `O contrato assinado fixa o salão ${contrato.fixa.nome}. Para trocar, abra uma nova versão do contrato e escolha o salão nela.`);
    if (rev.estado !== "EM_ELABORACAO") recusar("REVISAO_CONGELADA", "A nova versão do contrato já foi assinada pelo buffet. Cancele a troca e crie outra versão para mudar o salão.");
    const nomeEscolhido = opcoes.find((o) => o.id === salaoId)?.nome;
    if (!nomeEscolhido) recusar("SALAO_NAO_ENCONTRADO", "Salão não encontrado nesta unidade.", 404);
    if (rev.salao?.id === salaoId) return lerSalaoDaFesta(tx, ctx.empresaId, fechamentoId);
    // Escolha explícita: se não serve no destino da revisão, recusa (nunca vira outro salão).
    if (!(await serveNoDestino(tx, rev.revisaoId, salaoId))) recusar("SALAO_OCUPADO", `${nomeEscolhido} não serve no destino da revisão (horário, pacote, convidados ou ocupação).`);
    await definirSalaoDestinoRevisao(tx, rev.revisaoId, salaoId);
    await auditarMutacaoComercial(tx, {
      usuarioId: ctx.usuarioId, requestId: ctx.requestId, acao: "FESTA_SALAO_TROCA_NA_REVISAO", entidadeTipo: "FECHAMENTO", entidadeId: fechamentoId,
      empresaId: ctx.empresaId, antes: { salaoContrato: contrato.fixa, destino: rev.salao }, depois: { destino: { id: salaoId, nome: nomeEscolhido } }, motivo: null,
    });
    return lerSalaoDaFesta(tx, ctx.empresaId, fechamentoId);
  }
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
