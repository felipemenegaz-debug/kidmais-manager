import type { DbExecutor } from "../db/contracts.ts";
import type { TenantComprovado } from "../saas/provar-tenant.ts";
import { SatisfacaoError } from "./erros.ts";
import { exigirInstalacao111 } from "./instalacao.ts";

/**
 * Retornos das notas baixas (PS-3, plano rev. 2 A + rev. 2.1 A' + PS3-R21-P3-1). Identidade SÓ do tenant comprovado
 * (empresa, membership, usuário); nada do corpo decide empresa, unidade ou autor.
 *
 *   Gestão (memberships.papel = REPRESENTANTE_AUTORIZADO): todas as unidades da empresa e as tarefas sem unidade.
 *   Equipe: concessão SATISFACAO_TRATAR (não VER) não revogada da própria membership, com o vínculo da unidade ATIVO,
 *   não revogado, vigente no instante decisório e com a foto (atualizado_em) igual à da concessão. A 110 aceita a
 *   concessão sem conferir que o vínculo está ativo; por isso a vigência é conferida aqui, no consumo.
 *
 * Vigência nunca usa now() (início da transação): o instante é UM clock_timestamp() materializado na instrução que decide.
 * Leitura: escopo + dados + contagens + instante numa instrução só (um snapshot). Conclusão: ver concluirTarefa.
 */
const GESTAO = "REPRESENTANTE_AUTORIZADO";

export type TarefaRetorno = {
  id: string; estabelecimentoId: string | null; unidade: string | null; estado: "ABERTA" | "CONCLUIDA"; criadaEm: string;
  notaIndicacao: number; comentario: string | null; clienteId: string; cliente: string; dataFesta: string;
  observacao: string | null; concluidaEm: string | null;
};
export type UnidadeRetorno = { id: string; nome: string; abertas: number; semResponsavel: boolean | null };
export type PainelRetornos = { gestao: boolean; tarefas: TarefaRetorno[]; unidades: UnidadeRetorno[]; abertasSemUnidade: number | null };

/** Concessão TRATAR vigente no instante `agora.i` (texto usado na leitura e na decisão). */
const TRATAR_VIGENTE = `c.capacidade = 'SATISFACAO_TRATAR' AND c.revogada_em IS NULL
     AND v.membership_id = c.membership_id AND v.empresa_id = c.empresa_id AND v.estabelecimento_id = c.estabelecimento_id
     AND v.status = 'ATIVA' AND v.revogado_em IS NULL AND v.vigente_desde <= agora.i AND (v.vigente_ate IS NULL OR v.vigente_ate > agora.i)
     AND v.atualizado_em = c.vinculo_atualizado_em`;
const MEMBRO_VIGENTE = `m.status = 'ATIVA' AND m.vigente_desde <= agora.i AND (m.vigente_ate IS NULL OR m.vigente_ate > agora.i)`;

const SQL_PAINEL = `/* satisfacao:listar-tarefas */
WITH agora AS MATERIALIZED (SELECT COALESCE($4::timestamptz, clock_timestamp()) AS i),
membro AS (
  SELECT m.papel = '${GESTAO}' AS gestao FROM memberships m, agora
   WHERE m.id = $2::uuid AND m.empresa_id = $1::uuid AND ${MEMBRO_VIGENTE}
),
escopo AS (
  SELECT DISTINCT c.estabelecimento_id AS unidade
    FROM membro, agora, satisfacao_capacidades c JOIN membership_estabelecimentos v ON v.id = c.vinculo_id
   WHERE NOT membro.gestao AND c.empresa_id = $1::uuid AND c.membership_id = $2::uuid AND ${TRATAR_VIGENTE}
),
gestao AS (SELECT coalesce(bool_or(gestao), false) AS sim FROM membro),
visiveis AS (
  SELECT t.* FROM satisfacao_tarefas t, gestao
   WHERE t.empresa_id = $1::uuid
     AND (gestao.sim OR t.estabelecimento_id IN (SELECT unidade FROM escopo))
     AND ($3::uuid IS NULL OR t.estabelecimento_id = $3::uuid)
),
unidades AS (
  SELECT u.id, u.nome FROM estabelecimentos u, gestao
   WHERE u.empresa_id = $1::uuid AND ((gestao.sim AND u.status <> 'DESATIVADO') OR u.id IN (SELECT unidade FROM escopo))
)
SELECT
  gestao.sim AS gestao,
  ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM unidades WHERE id = $3::uuid)) AS filtro_valido,
  coalesce((SELECT json_agg(x ORDER BY x.estado, x."criadaEm" DESC) FROM (
    SELECT t.id::text AS id, t.estabelecimento_id::text AS "estabelecimentoId", u.nome AS unidade, t.estado, t.criado_em::text AS "criadaEm",
           r.nota_indicacao AS "notaIndicacao", r.comentario, cl.id::text AS "clienteId", cl.nome_completo AS cliente,
           to_char(f.data_evento, 'YYYY-MM-DD') AS "dataFesta", t.observacao, t.concluida_em::text AS "concluidaEm"
      FROM visiveis t
      JOIN satisfacao_respostas r ON r.id = t.resposta_id AND r.empresa_id = t.empresa_id
      JOIN satisfacao_envios e ON e.id = t.envio_id AND e.empresa_id = t.empresa_id
      JOIN clientes cl ON cl.id = e.cliente_id
      JOIN fechamentos f ON f.id = e.fechamento_id
      LEFT JOIN estabelecimentos u ON u.id = t.estabelecimento_id AND u.empresa_id = t.empresa_id
     ORDER BY t.estado, t.criado_em DESC LIMIT 200) x), '[]'::json) AS tarefas,
  coalesce((SELECT json_agg(json_build_object('id', un.id::text, 'nome', un.nome,
      'abertas', (SELECT count(*) FROM satisfacao_tarefas t WHERE t.empresa_id = $1::uuid AND t.estabelecimento_id = un.id AND t.estado = 'ABERTA'),
      -- "sem responsável" só para a Gestão e só para unidades do escopo (as dela): nenhuma concessão TRATAR vigente.
      'semResponsavel', CASE WHEN gestao.sim THEN NOT EXISTS (
          SELECT 1 FROM satisfacao_capacidades c JOIN membership_estabelecimentos v ON v.id = c.vinculo_id
           WHERE c.empresa_id = $1::uuid AND c.estabelecimento_id = un.id AND ${TRATAR_VIGENTE}) END)
    ORDER BY un.nome, un.id) FROM unidades un), '[]'::json) AS unidades,
  CASE WHEN gestao.sim THEN (SELECT count(*) FROM satisfacao_tarefas t WHERE t.empresa_id = $1::uuid AND t.estabelecimento_id IS NULL AND t.estado = 'ABERTA') END AS abertas_sem_unidade
FROM gestao, agora`;

/** Leitura no escopo do tenant. Filtro de unidade fora do escopo → 404 genérico (sem consultar existência fora do tenant). */
export async function listarTarefas(tx: DbExecutor, tenant: TenantComprovado, filtro: { estabelecimentoId?: string | null } = {}, opcoes: { instanteDecisao?: string } = {}): Promise<PainelRetornos> {
  const r = (await tx.query<{ gestao: boolean; filtro_valido: boolean; tarefas: TarefaRetorno[]; unidades: UnidadeRetorno[]; abertas_sem_unidade: string | number | null }>(
    SQL_PAINEL, [tenant.empresaComprovada, tenant.membershipId, filtro.estabelecimentoId ?? null, opcoes.instanteDecisao ?? null])).rows[0];
  if (!r.filtro_valido) throw new SatisfacaoError("NAO_ENCONTRADO", "Unidade não encontrada.", 404);
  return {
    gestao: r.gestao,
    tarefas: r.tarefas,
    unidades: r.unidades.map((u) => ({ ...u, abertas: Number(u.abertas) })),
    abertasSemUnidade: r.abertas_sem_unidade === null ? null : Number(r.abertas_sem_unidade),
  };
}

const naoEncontrada = () => new SatisfacaoError("NAO_ENCONTRADO", "Tarefa não encontrada.", 404);

/**
 * Conclusão (A', ordem fixa, instruções separadas):
 *   0. 111 íntegra (catálogo), ANTES de ler ou travar a tarefa — sem ela, 503 e nada muda (nunca conclusão sem auditoria);
 *   1. (guarda do tenant, já feita pela rota);
 *   2. leitura SEM trava da tarefa (id + empresa) só para saber a unidade; o estado lido aqui não decide nada;
 *   3. Equipe: concessões TRATAR não revogadas da membership para a unidade, FOR SHARE ORDER BY id — candidatas SEM filtro
 *      temporal (o início de vigência pode ser atravessado na espera); depois os vínculos delas FOR SHARE ORDER BY id;
 *   4. tarefa FOR UPDATE;
 *   5. decisão: UMA instrução sem trava, com o instante único `agora`, relendo membership, concessões (SÓ os ids travados
 *      no passo 3), vínculos, vigência, foto e a unidade da tarefa; sem autorização → 404, sem efeito;
 *   6. UPDATE … WHERE estado = 'ABERTA' RETURNING; nenhuma linha → 409;
 *   7. auditoria com criado_em = o mesmo instante (que também é concluida_em).
 * Linearização: autorizada no instante do passo 5; depois dele nenhum escritor muda o que está travado. O relógio
 * continua andando até o COMMIT — não se promete vigência até lá. `instanteDecisao` existe só para provar bordas exatas
 * nos testes; a rota nunca o passa.
 */
export async function concluirTarefa(tx: DbExecutor, tenant: TenantComprovado, entrada: { tarefaId: string; observacao?: string | null },
  opcoes: { instanteDecisao?: string } = {}) {
  await exigirInstalacao111(tx);
  const empresaId = tenant.empresaComprovada;
  const observacao = entrada.observacao == null || entrada.observacao.trim() === "" ? null : entrada.observacao.trim();
  if (observacao !== null && observacao.length > 1000) throw new SatisfacaoError("DADOS_INVALIDOS", "A observação aceita até 1000 caracteres.", 400);

  const tarefa = (await tx.query<{ unidade: string | null }>(
    `SELECT estabelecimento_id::text AS unidade FROM satisfacao_tarefas WHERE id = $1::uuid AND empresa_id = $2::uuid`, [entrada.tarefaId, empresaId])).rows[0];
  if (!tarefa) throw naoEncontrada();

  const gestao = tenant.papelAtual === GESTAO;
  let concessoes: string[] = [];
  if (!gestao) {
    if (tarefa.unidade === null) throw naoEncontrada();
    concessoes = (await tx.query<{ id: string; vinculo: string }>(
      `/* satisfacao:travar-concessao */ SELECT id::text, vinculo_id::text AS vinculo FROM satisfacao_capacidades
        WHERE empresa_id = $1::uuid AND membership_id = $2::uuid AND estabelecimento_id = $3::uuid AND capacidade = 'SATISFACAO_TRATAR' AND revogada_em IS NULL
        ORDER BY id FOR SHARE`, [empresaId, tenant.membershipId, tarefa.unidade])).rows.map((r) => r.id);
    if (concessoes.length === 0) throw naoEncontrada();
    await tx.query(
      `/* satisfacao:travar-vinculo */ SELECT v.id FROM membership_estabelecimentos v
        WHERE v.id IN (SELECT c.vinculo_id FROM satisfacao_capacidades c WHERE c.id = ANY($1::uuid[])) ORDER BY v.id FOR SHARE`, [concessoes]);
  }

  await tx.query(`/* satisfacao:travar-tarefa */ SELECT id FROM satisfacao_tarefas WHERE id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE`, [entrada.tarefaId, empresaId]);

  const decisao = (await tx.query<{ instante: string; autorizado: boolean }>(
    `/* satisfacao:decidir */
     WITH agora AS MATERIALIZED (SELECT COALESCE($5::timestamptz, clock_timestamp()) AS i)
     SELECT agora.i::text AS instante,
            EXISTS (SELECT 1 FROM memberships m WHERE m.id = $2::uuid AND m.empresa_id = $3::uuid AND ${MEMBRO_VIGENTE}
                      AND ((m.papel = '${GESTAO}' AND $6::boolean)
                        OR (NOT $6::boolean AND EXISTS (
                              SELECT 1 FROM satisfacao_tarefas t, satisfacao_capacidades c JOIN membership_estabelecimentos v ON v.id = c.vinculo_id
                               WHERE t.id = $1::uuid AND t.empresa_id = $3::uuid AND c.id = ANY($4::uuid[])
                                 AND c.empresa_id = $3::uuid AND c.membership_id = $2::uuid AND c.estabelecimento_id = t.estabelecimento_id
                                 AND ${TRATAR_VIGENTE})))) AS autorizado
       FROM agora`,
    [entrada.tarefaId, tenant.membershipId, empresaId, concessoes, opcoes.instanteDecisao ?? null, gestao])).rows[0];
  if (!decisao.autorizado) throw naoEncontrada();

  const feita = (await tx.query<{ id: string; unidade: string | null; concluida_em: string }>(
    `UPDATE satisfacao_tarefas SET estado = 'CONCLUIDA', concluida_em = $3::timestamptz, concluida_por = $4::uuid, observacao = $5
      WHERE id = $1::uuid AND empresa_id = $2::uuid AND estado = 'ABERTA'
      RETURNING id::text, estabelecimento_id::text AS unidade, concluida_em::text`,
    [entrada.tarefaId, empresaId, decisao.instante, tenant.usuarioId, observacao])).rows[0];
  if (!feita) throw new SatisfacaoError("JA_CONCLUIDA", "Esta tarefa já foi concluída.", 409);

  await tx.query(`INSERT INTO satisfacao_auditoria (empresa_id, estabelecimento_id, ator_usuario_id, acao, tarefa_id, criado_em)
    VALUES ($1::uuid, $2::uuid, $3::uuid, 'TAREFA_CONCLUIDA', $4::uuid, $5::timestamptz)`, [empresaId, feita.unidade, tenant.usuarioId, feita.id, decisao.instante]);
  return { id: feita.id, estado: "CONCLUIDA" as const, concluidaEm: feita.concluida_em };
}
