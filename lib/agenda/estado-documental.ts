import type { DbExecutor } from "../db/contracts.ts";
import { salaoDoSnapshot, type ContratoSnapshot } from "../contratos/repositories/models.ts";
import { ContratoServiceError } from "../contratos/services/errors.ts";
import type { CaminhoSalao } from "./escrever-salao.ts";

/**
 * Plano "liberar agenda com mais de um salão" (rev. 4–7, aprovado pelo Astra; D-LIB-4): estado documental da festa
 * sob uma versão de referência explícita. Quem decide o salão da festa lê daqui (salaoExigidoDaFesta é derivado).
 *
 * Ordem de classificação (rev. 5): consistência primeiro — ASSINADA sem prova válida, ou prova CLIENTE sem ASSINADA,
 * é INCONSISTENTE qualquer que seja o ponteiro; só depois o papel. O leitor não trava: as travas são as do chamador.
 */
export type PapelVersao = "VIGENTE" | "ASSINADA_EM_APLICACAO" | "EM_PREPARACAO" | "EMITIDA_AGUARDANDO" | "INCONSISTENTE";
export type ProvaAssinatura = "NATIVA_DUPLA" | "CONFERENCIA_PAPEL" | "INCOMPLETA";

export type VersaoDocumental = {
  id: string;
  numero: number;
  schema: number;
  salaoId: string | null;
  status: string;
  papel: PapelVersao;
  assinatura: ProvaAssinatura;
  provaCliente: boolean;
  edicaoAguardandoCliente: boolean;
};

export type ReferenciaDocumental =
  | { tipo: "PROPRIA"; salaoId: string | null }
  | { tipo: "BASE_REVISAO_OPERACIONAL"; baseId: string; salaoBase: string | null };

export type EstadoDocumental =
  | { contrato: "SEM_CONTRATO"; fechamentoId: string }
  | {
    contrato: "COM_CONTRATO";
    fechamentoId: string;
    contratoId: string;
    contratoStatus: string;
    vigenteId: string | null;
    versao: VersaoDocumental | null;
    referencia: ReferenciaDocumental | null;
    destinoRevisao: string | null;
    conferencia: "CONFERE" | "DESATUALIZADA";
  };

type Fluxo = { contrato_id: string; status: string; vigente: string | null; preparacao: string | null; empresa: string };

const salaoV3 = (s: ContratoSnapshot | null | undefined) => (s && s.schemaVersao === 3 ? salaoDoSnapshot(s)?.id ?? null : null);

export async function estadoDocumental(tx: DbExecutor, alvo: { fechamentoId: string; versaoId?: string | null }): Promise<EstadoDocumental> {
  const c = (await tx.query<Fluxo>(
    `SELECT c.id::text AS contrato_id, c.status, cf.versao_vigente_id::text AS vigente, cf.versao_em_preparacao_id::text AS preparacao,
            f.empresa_id::text AS empresa
       FROM contratos c JOIN fechamentos f ON f.id = c.fechamento_id LEFT JOIN contrato_fluxos cf ON cf.contrato_id = c.id
      WHERE c.fechamento_id = $1::uuid`,
    [alvo.fechamentoId],
  )).rows[0];
  if (!c) return { contrato: "SEM_CONTRATO", fechamentoId: alvo.fechamentoId };
  // Referência: a versão pedida; sem ela, a vigente; sem vigente, a em preparação; sem as duas, a última emitida (ATIVA).
  const versaoId = alvo.versaoId ?? c.vigente ?? c.preparacao ?? (await tx.query<{ id: string }>(
    `SELECT id::text AS id FROM contrato_versoes WHERE contrato_id = $1::uuid AND status = 'ATIVA' ORDER BY numero_versao DESC LIMIT 1`,
    [c.contrato_id],
  )).rows[0]?.id ?? null;
  const revisao = (await tx.query<{ salao_id: string | null; versao: string | null; base_id: string | null; base: ContratoSnapshot | null }>(
    `SELECT r.salao_id::text AS salao_id, r.contrato_versao_id::text AS versao, r.versao_base_id::text AS base_id, b.snapshot AS base
       FROM fechamento_revisoes r LEFT JOIN contrato_versoes b ON b.id = r.versao_base_id
      WHERE r.fechamento_id = $1::uuid AND r.estado IN ('EM_ELABORACAO', 'CONGELADA')`,
    [alvo.fechamentoId],
  )).rows[0];
  const base = {
    contrato: "COM_CONTRATO" as const, fechamentoId: alvo.fechamentoId, contratoId: c.contrato_id, contratoStatus: c.status,
    vigenteId: c.vigente, destinoRevisao: revisao?.salao_id ?? null,
  };
  if (!versaoId) return { ...base, versao: null, referencia: null, conferencia: "CONFERE" };
  const v = (await tx.query<{ id: string; numero: number; status: string; schema: number; snapshot: ContratoSnapshot; aceite: string | null; contrato: string }>(
    `SELECT id::text AS id, numero_versao AS numero, status, snapshot_schema_versao AS schema, snapshot, aceite_metodo AS aceite,
            contrato_id::text AS contrato
       FROM contrato_versoes WHERE id = $1::uuid`,
    [versaoId],
  )).rows[0];
  if (!v || v.contrato !== c.contrato_id) {
    return { ...base, versao: v ? { id: v.id, numero: Number(v.numero), schema: Number(v.schema), salaoId: salaoV3(v.snapshot), status: v.status,
      papel: "INCONSISTENTE", assinatura: "INCOMPLETA", provaCliente: false, edicaoAguardandoCliente: false } : null, referencia: null, conferencia: "CONFERE" };
  }
  const partes = new Set((await tx.query<{ parte: string }>(
    `SELECT parte FROM contrato_assinaturas WHERE contrato_versao_id = $1::uuid`, [v.id],
  )).rows.map((p) => p.parte));
  const provaCliente = partes.has("CLIENTE");
  let assinatura: ProvaAssinatura = "INCOMPLETA";
  if (partes.has("KIDMAIS") && provaCliente) assinatura = "NATIVA_DUPLA";
  else if (partes.size === 0 && v.status === "ASSINADA" && v.aceite === "CONFERENCIA_PAPEL" && Number(v.numero) === 1) {
    const vinculo = (await tx.query<{ ok: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM contrato_importacoes i WHERE i.contrato_id = $1::uuid AND i.contrato_versao_id = $2::uuid
                         AND i.empresa_id = $3::uuid AND i.fechamento_id = $4::uuid) AS ok`,
      [c.contrato_id, v.id, c.empresa, alvo.fechamentoId],
    )).rows[0]?.ok === true;
    if (vinculo) assinatura = "CONFERENCIA_PAPEL";
  }
  const edicaoAguardandoCliente = (await tx.query<{ estado: string }>(
    `SELECT estado FROM contrato_edicoes WHERE contrato_versao_id = $1::uuid`, [v.id],
  )).rows[0]?.estado === "AGUARDANDO_CLIENTE";
  const assinada = v.status === "ASSINADA";
  let papel: PapelVersao;
  // Rodada 2 (P3 do Astra): versão terminal (CANCELADA/SUBSTITUIDA) é INCONSISTENTE como referência, mesmo que um ponteiro
  // do fluxo ainda aponte para ela, e antes de olhar os ponteiros.
  if (v.status === "CANCELADA" || v.status === "SUBSTITUIDA") papel = "INCONSISTENTE";
  else if ((assinada && assinatura === "INCOMPLETA") || (provaCliente && !assinada)) papel = "INCONSISTENTE";
  else if (c.vigente === v.id) papel = "VIGENTE";
  else if (assinada && c.preparacao === v.id) papel = "ASSINADA_EM_APLICACAO";
  else if (!assinada && c.preparacao === v.id) papel = "EM_PREPARACAO";
  else if (v.status === "ATIVA" && !c.preparacao) papel = "EMITIDA_AGUARDANDO";
  else papel = "INCONSISTENTE";
  const versao: VersaoDocumental = { id: v.id, numero: Number(v.numero), schema: Number(v.schema), salaoId: salaoV3(v.snapshot), status: v.status,
    papel, assinatura, provaCliente, edicaoAguardandoCliente };
  // Base da revisão operacional aberta: a festa continua no salão da base até a aplicação (o que daBase fazia).
  const daBase = revisao && revisao.versao === v.id && revisao.base_id;
  const referencia: ReferenciaDocumental = daBase
    ? { tipo: "BASE_REVISAO_OPERACIONAL", baseId: revisao.base_id!, salaoBase: salaoV3(revisao.base) }
    : { tipo: "PROPRIA", salaoId: versao.salaoId };
  const snapshotReferencia = daBase ? revisao.base : v.snapshot;
  const salaoReferencia = referencia.tipo === "PROPRIA" ? referencia.salaoId : referencia.salaoBase;
  // Conferência (regra de hoje): só um documento que fixa salão pode ficar desatualizado em relação à festa.
  let conferencia: "CONFERE" | "DESATUALIZADA" = "CONFERE";
  if (salaoReferencia && snapshotReferencia) {
    const f = (await tx.query<{ data: string; inicio: string; fim: string; cfg: string }>(
      `SELECT data_evento::text AS data, horario_inicio::text AS inicio, horario_fim::text AS fim, configuracao_agenda_id::text AS cfg
         FROM fechamentos WHERE id = $1::uuid`,
      [alvo.fechamentoId],
    )).rows[0];
    const e = snapshotReferencia.evento as typeof snapshotReferencia.evento & { configuracaoAgendaId?: string };
    if (!f || f.data !== e.data || f.inicio.slice(0, 5) !== e.horarioInicio.slice(0, 5) || f.fim.slice(0, 5) !== e.horarioFim.slice(0, 5)
      || f.cfg !== e.configuracaoAgendaId) conferencia = "DESATUALIZADA";
  }
  return { ...base, versao, referencia, conferencia };
}

/** Salão de referência do documento (V3 da própria versão ou da base), ou null quando o documento não fixa salão. */
export function salaoDaReferencia(e: EstadoDocumental) {
  if (e.contrato === "SEM_CONTRATO" || !e.referencia) return null;
  return e.referencia.tipo === "PROPRIA" ? e.referencia.salaoId : e.referencia.salaoBase;
}

/**
 * Estado exigido por caminho (mapa fechado, rev. 5/6). Devolve o motivo da recusa, ou null quando o estado serve.
 * Só vale para escopo POR_SALAO; fora dele, quem chama não consulta (o comportamento por horário não muda).
 */
export function estadoNaoServe(e: EstadoDocumental, caminho: CaminhoSalao): string | null {
  if (e.contrato === "SEM_CONTRATO") {
    return caminho === "CONFIRMACAO_PAGAMENTO" || caminho === "EMISSAO" || caminho === "PREPARACAO_REVISAO" || caminho === "ATRIBUICAO_AVULSA"
      || caminho === "EDICAO_LIMPA_SALAO" ? null : "SEM_CONTRATO";
  }
  const v = e.versao;
  if (v?.papel === "INCONSISTENTE") return "INCONSISTENTE";
  switch (caminho) {
    case "EMISSAO": case "PREPARACAO_REVISAO": case "ATRIBUICAO_AVULSA": case "EDICAO_LIMPA_SALAO":
      return null;
    case "APLICACAO_REVISAO_INICIAL":
      return v?.papel === "ASSINADA_EM_APLICACAO" && v.assinatura === "NATIVA_DUPLA" && !e.vigenteId && e.referencia?.tipo === "PROPRIA" ? null : "ESTADO_DIFERENTE";
    case "FORMALIZACAO_PRE_ASSINATURA":
      return v?.papel === "EM_PREPARACAO" && v.edicaoAguardandoCliente && !v.provaCliente ? null : "ESTADO_DIFERENTE";
    case "APLICACAO_REVISAO_OPERACIONAL":
      return v?.papel === "ASSINADA_EM_APLICACAO" && v.assinatura === "NATIVA_DUPLA" ? null : "ESTADO_DIFERENTE";
    case "FORMALIZACAO_POS_ASSINATURA":
      return v?.papel === "VIGENTE" && v.assinatura === "NATIVA_DUPLA" ? null : "ESTADO_DIFERENTE";
    case "CONFIRMACAO_PAGAMENTO":
      // Vigente com qualquer prova válida; contrato ainda sem vigente não decide salão (curinga, declarado no pacote).
      return !v || v.papel === "VIGENTE" || !e.vigenteId ? null : "ESTADO_DIFERENTE";
    case "INTEGRACAO_IMPORTADO":
      return v?.papel === "VIGENTE" && v.assinatura === "CONFERENCIA_PAPEL" ? null : "ESTADO_DIFERENTE";
  }
}

/** Recusa padrão dos caminhos de contrato quando o estado documental não serve (sem nenhuma escrita antes). */
export function recusarEstadoDocumental(motivo: string, caminho: CaminhoSalao): never {
  throw new ContratoServiceError(
    "DADOS_CONTRATUAIS_INCONSISTENTES",
    "O estado do contrato não permite definir o salão da festa agora. Recarregue a página; se continuar, fale com o suporte.",
    409,
    { motivo, caminho },
  );
}
