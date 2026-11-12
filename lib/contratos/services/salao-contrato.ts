import type { DbExecutor } from "../../db/contracts.ts";
import { salaoDoSnapshot, type ContratoSnapshot } from "../repositories/models.ts";
import { escopoPorSalao, salaoDoDestinoRevisao } from "../../agenda/salao-festa.ts";
import { estadoDocumental, estadoNaoServe, recusarEstadoDocumental, salaoDaReferencia, type EstadoDocumental } from "../../agenda/estado-documental.ts";
import type { CaminhoSalao } from "../../agenda/escrever-salao.ts";
import { ContratoServiceError } from "./errors.ts";

export type SalaoExigido =
  | { situacao: "SEM_SALAO_FIXADO" }
  | { situacao: "EXIGIDO"; salaoId: string; daBase?: true }
  | { situacao: "VERSAO_DESATUALIZADA" };

/**
 * S-E (plano S-E/S-D rev. 4.1, R3-E2/R3-E3): salão que a FESTA precisa ter sob a versão `versaoId`. Referência: a própria
 * versão; numa preparação de revisão operacional aberta, a versão BASE (a festa continua em A até a aplicação). Só V3
 * com salão fixa salão. A conferência é do estado OPERACIONAL contra o snapshot de referência (data, início, fim e
 * horário configurado); se não bate, a versão está desatualizada (nunca dispensa o salão).
 * Plano "liberar mais de um salão" (D-LIB-4): DERIVADO do leitor estadoDocumental; quem decide usa referenciaParaCaminho.
 */
export async function salaoExigidoDaFesta(tx: DbExecutor, versaoId: string): Promise<SalaoExigido> {
  const fechamentoId = await fechamentoDaVersao(tx, versaoId);
  if (!fechamentoId) return { situacao: "SEM_SALAO_FIXADO" };
  return exigidoDoEstado(await estadoDocumental(tx, { fechamentoId, versaoId }));
}

function exigidoDoEstado(e: EstadoDocumental): SalaoExigido {
  const salaoId = salaoDaReferencia(e);
  if (!salaoId || e.contrato === "SEM_CONTRATO") return { situacao: "SEM_SALAO_FIXADO" };
  if (e.conferencia === "DESATUALIZADA") return { situacao: "VERSAO_DESATUALIZADA" };
  return e.referencia?.tipo === "BASE_REVISAO_OPERACIONAL" ? { situacao: "EXIGIDO", salaoId, daBase: true } : { situacao: "EXIGIDO", salaoId };
}

async function fechamentoDaVersao(tx: DbExecutor, versaoId: string) {
  return (await tx.query<{ f: string }>(
    `SELECT c.fechamento_id::text AS f FROM contrato_versoes v JOIN contratos c ON c.id = v.contrato_id WHERE v.id = $1::uuid`, [versaoId],
  )).rows[0]?.f ?? null;
}

/** Resultado do leitor para um caminho do mapa fechado (D-LIB-4). */
export type ReferenciaDoCaminho = {
  porSalao: boolean;
  estado: EstadoDocumental | null;
  /** Salão fixado pelo documento de referência (V3), ou null (curinga: a festa não ganha salão por este caminho). */
  salaoId: string | null;
  daBase: boolean;
  desatualizada: boolean;
  /** Motivo pelo qual o estado não serve ao caminho (só em POR_SALAO); null = serve. */
  recusa: string | null;
};

/**
 * Plano "liberar mais de um salão" (D-LIB-4): lê o estado documental da festa sob a versão de referência e confere o
 * estado exigido pelo caminho. Fora de POR_SALAO (ou sem a 094) não lê nem confere nada: sem salão de referência, e o
 * seletor (escolherSalao) sai antes de qualquer escolha, como antes.
 */
export async function referenciaParaCaminho(
  tx: DbExecutor, alvo: { fechamentoId?: string | null; versaoId?: string | null }, caminho: CaminhoSalao,
): Promise<ReferenciaDoCaminho> {
  const fechamentoId = alvo.fechamentoId ?? (alvo.versaoId ? await fechamentoDaVersao(tx, alvo.versaoId) : null);
  if (!fechamentoId) return { porSalao: false, estado: null, salaoId: null, daBase: false, desatualizada: false, recusa: null };
  const escopo = (await tx.query<{ empresa: string; unidade: string | null }>(
    `SELECT empresa_id::text AS empresa, estabelecimento_id::text AS unidade FROM fechamentos WHERE id = $1::uuid`, [fechamentoId],
  )).rows[0];
  const porSalao = escopo ? await escopoPorSalao(tx, escopo.empresa, escopo.unidade) : false;
  if (!porSalao) return { porSalao: false, estado: null, salaoId: null, daBase: false, desatualizada: false, recusa: null };
  const estado = await estadoDocumental(tx, { fechamentoId, versaoId: alvo.versaoId ?? null });
  const exigido = exigidoDoEstado(estado);
  return {
    porSalao, estado,
    salaoId: exigido.situacao === "EXIGIDO" ? exigido.salaoId : null,
    daBase: exigido.situacao === "EXIGIDO" && exigido.daBase === true,
    desatualizada: exigido.situacao === "VERSAO_DESATUALIZADA",
    recusa: estadoNaoServe(estado, caminho),
  };
}

/**
 * Para a formalização: undefined = o documento não fixa salão (curinga, sem escolha automática em POR_SALAO);
 * versão desatualizada = recusa; estado documental que não serve ao caminho = recusa antes de qualquer escrita.
 * daBase: a versão é a preparação de uma revisão e o salão exigido é o da base (a festa continua nele até a aplicação).
 */
export async function salaoExigidoOuRecusa(
  tx: DbExecutor, versaoId: string, caminho: CaminhoSalao,
): Promise<{ salaoId: string; daBase: boolean } | undefined> {
  const r = await referenciaParaCaminho(tx, { versaoId }, caminho);
  if (r.recusa) recusarEstadoDocumental(r.recusa, caminho);
  if (r.desatualizada) {
    throw new ContratoServiceError(
      "SALAO_INDISPONIVEL",
      "Esta versão do contrato está desatualizada: a data, o horário ou o salão da festa mudaram. O buffet vai enviar uma nova versão.",
      409,
      { motivo: "VERSAO_DESATUALIZADA" },
    );
  }
  return r.salaoId ? { salaoId: r.salaoId, daBase: r.daBase } : undefined;
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
