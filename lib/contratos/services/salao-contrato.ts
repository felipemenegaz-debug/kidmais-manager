import type { DbExecutor } from "../../db/contracts.ts";
import { salaoDoSnapshot, type ContratoSnapshot } from "../repositories/models.ts";
import { salaoDoDestinoRevisao } from "../../agenda/salao-festa.ts";
import { ContratoServiceError } from "./errors.ts";

export type SalaoExigido =
  | { situacao: "SEM_SALAO_FIXADO" }
  | { situacao: "EXIGIDO"; salaoId: string; daBase?: true }
  | { situacao: "VERSAO_DESATUALIZADA" };

/**
 * S-E (plano S-E/S-D rev. 4.1, R3-E2/R3-E3): salão que a FESTA precisa ter ao formalizar, reformalizar ou confirmar o
 * pagamento sob a versão `versaoId`. Referência: a própria versão; numa preparação de revisão operacional, a versão BASE
 * (a festa continua em A até a aplicação; o destino B é conferido pela revisão). Só enquanto a revisão está ABERTA
 * (EM_ELABORACAO/CONGELADA): aplicada, a versão passa a ser a vigente e a referência é ela mesma (P2 do Astra, 27/10;
 * cancelada, a versão também foi cancelada). Só V3 com salão fixa salão; V1/V2 e V3
 * sem salão mantêm o comportamento anterior. A conferência é do estado OPERACIONAL contra o snapshot: data, início, fim
 * e horário configurado da festa iguais aos do documento; se não, a versão está desatualizada (nunca dispensa o salão).
 */
export async function salaoExigidoDaFesta(tx: DbExecutor, versaoId: string): Promise<SalaoExigido> {
  const v = (await tx.query<{ snapshot: ContratoSnapshot; base: ContratoSnapshot | null }>(
    `SELECT v.snapshot, b.snapshot AS base
       FROM contrato_versoes v
       LEFT JOIN fechamento_revisoes r ON r.contrato_versao_id = v.id AND r.estado IN ('EM_ELABORACAO', 'CONGELADA')
       LEFT JOIN contrato_versoes b ON b.id = r.versao_base_id
      WHERE v.id = $1::uuid`,
    [versaoId],
  )).rows[0];
  if (!v) return { situacao: "SEM_SALAO_FIXADO" };
  const referencia = v.base ?? v.snapshot;
  const salao = salaoDoSnapshot(referencia);
  if (!salao || referencia.schemaVersao !== 3) return { situacao: "SEM_SALAO_FIXADO" };
  const f = (await tx.query<{ data: string; inicio: string; fim: string; cfg: string }>(
    `SELECT data_evento::text AS data, horario_inicio::text AS inicio, horario_fim::text AS fim, configuracao_agenda_id::text AS cfg
       FROM fechamentos WHERE id = $1::uuid`,
    [referencia.fechamento.id],
  )).rows[0];
  const e = referencia.evento;
  if (!f || f.data !== e.data || f.inicio.slice(0, 5) !== e.horarioInicio.slice(0, 5) || f.fim.slice(0, 5) !== e.horarioFim.slice(0, 5)
    || f.cfg !== e.configuracaoAgendaId) return { situacao: "VERSAO_DESATUALIZADA" };
  return v.base ? { situacao: "EXIGIDO", salaoId: salao.id, daBase: true } : { situacao: "EXIGIDO", salaoId: salao.id };
}

/**
 * Para a formalização: undefined = sem salão fixado (comportamento anterior); versão desatualizada = recusa.
 * daBase: a versão é a preparação de uma revisão e o salão exigido é o da base (a festa continua nele até a aplicação).
 */
export async function salaoExigidoOuRecusa(tx: DbExecutor, versaoId: string): Promise<{ salaoId: string; daBase: boolean } | undefined> {
  const r = await salaoExigidoDaFesta(tx, versaoId);
  if (r.situacao === "VERSAO_DESATUALIZADA") {
    throw new ContratoServiceError(
      "SALAO_INDISPONIVEL",
      "Esta versão do contrato está desatualizada: a data, o horário ou o salão da festa mudaram. O buffet vai enviar uma nova versão.",
      409,
      { motivo: "VERSAO_DESATUALIZADA" },
    );
  }
  return r.situacao === "EXIGIDO" ? { salaoId: r.salaoId, daBase: r.daBase === true } : undefined;
}

/**
 * S-E (P1 do Astra, 27/10): o salão do DESTINO da revisão difere do salão escrito no documento V3? Independe da versão
 * do hash: com hash v1 (antes da 104 ou revisão antiga preservada) trocar B por C não muda conteudo_hash, então a
 * comparação de hash sozinha não basta. Só V3 fixa salão no documento; V1/V2 nunca escreveram salão (nada a conferir).
 * Fora de POR_SALAO o destino é "sem salão" (null), igual a um V3 sem salão.
 */
export async function destinoDifereDoDocumento(tx: DbExecutor, revisaoId: string, snapshot: ContratoSnapshot): Promise<boolean> {
  if (snapshot.schemaVersao !== 3) return false;
  const destino = (await salaoDoDestinoRevisao(tx, revisaoId)) ?? null;
  return (destino?.id ?? null) !== (salaoDoSnapshot(snapshot)?.id ?? null);
}
