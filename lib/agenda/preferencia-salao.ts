import type { DbExecutor } from "../db/contracts.ts";
import { adquirirLockConfirmacaoAgenda } from "../disponibilidade/repositories/disponibilidade.repository.ts";
import { combinadosPublicos } from "./combinados-publicos.ts";
import { diagnosticarSalaoNoDestino, salaoServeNoDestino } from "./salao-festa.ts";
import { pronto, salaoDoEscopoParaPublicacao, saloesProntosPublicos, SalaoPublicoIndisponivel } from "./salao-publico.ts";
import { MOTIVOS_PREFERENCIA, TEXTO_MOTIVO_PREFERENCIA, type MotivoPreferencia } from "./preferencia-salao-textos.ts";

/**
 * E2b — decisão da preferência de salão do cliente (plano técnico E2b rev. 2.1, R2-P2-1/R2-P2-2; D-R4). Só existe com
 * combinadosPublicos (as três condições); desligado, o fluxo é o da E2a, sem esta função nem a trava compartilhada.
 *
 * Travas (P2-E2b-3): configuração da empresa COMPARTILHADA → data. Quem altera a configuração da agenda (salvar escopo,
 * desativar salão, conteúdo do salão) toma a mesma chave EXCLUSIVA e espera o COMMIT desta transação. Garantia só para
 * os escritores cooperantes da aplicação (READ COMMITTED, trava até o COMMIT); SQL direto não é coberto.
 *
 * Ordem, igual nos dois modos:
 *   1. identidade: o salão existe nesta empresa/unidade (senão, recusa genérica);
 *   2. conteúdo próprio publicável (pendenciasPublicacao), ignorando só a elegibilidade dos membros (senão, genérica);
 *   3. regra estrita (salaoServeNoDestino); se não serve, o motivo de diagnosticarSalaoNoDestino — SALAO_INATIVO_OU_OUTRO_ESCOPO
 *      e null viram genérica;
 *   4. portões públicos da aceitação: POR_SALAO e 2 ou mais SIMPLES prontos (saloesProntosPublicos); senão, genérica.
 *      Vem depois do 3 de propósito: membro inativo ainda é INELEGIVEL, mas nada é ACEITO sem os portões públicos;
 *   5. ACEITA.
 * Esta função nunca grava: quem grava a preferência é o chamador no modo de aceitação, com ACEITA, na mesma transação.
 */
// Os motivos são os de diagnosticarSalaoNoDestino menos o de escopo (que vira recusa genérica); o compilador confere
// na atribuição abaixo (um motivo novo lá sem texto aqui não compila).
export type { MotivoPreferencia };
export { MOTIVOS_PREFERENCIA, TEXTO_MOTIVO_PREFERENCIA };

export type DecisaoPreferencia =
  | { resultado: "ACEITA" }
  | { resultado: "RECUSA_GENERICA" }
  | { resultado: "RECUSA_COM_MOTIVO"; motivo: MotivoPreferencia };

export type DestinoPreferencia = {
  data: string; inicio: string; fim: string; configuracaoId: string; pacoteId: string;
  empresaId: string; estabelecimentoId: string | null; convidados: number | null;
};

const GENERICA: DecisaoPreferencia = { resultado: "RECUSA_GENERICA" };

/** Configuração da empresa (compartilhada) → data: a ordem fixa da conferência pública da preferência. */
export async function travarConferenciaPreferencia(tx: DbExecutor, empresaId: string, data: string) {
  await tx.query(`SELECT pg_advisory_xact_lock_shared(hashtextextended('kidmais:agenda-config:' || $1::text, 0))`, [empresaId]);
  await adquirirLockConfirmacaoAgenda(data, tx);
}

export async function decidirPreferencia(
  tx: DbExecutor, destino: DestinoPreferencia, salaoId: string, env?: { SALOES_PUBLICOS?: string; SALOES_COMBINADOS_PUBLICOS?: string },
): Promise<DecisaoPreferencia> {
  if (!(await combinadosPublicos(tx, env))) return GENERICA;
  await travarConferenciaPreferencia(tx, destino.empresaId, destino.data);
  const escopo = { empresaId: destino.empresaId, estabelecimentoId: destino.estabelecimentoId };
  const linha = await salaoDoEscopoParaPublicacao(tx, escopo, salaoId);
  if (!linha || !pronto(linha)) return GENERICA;
  if (!(await salaoServeNoDestino(tx, destino, salaoId))) {
    const motivo = await diagnosticarSalaoNoDestino(tx, destino, salaoId);
    return motivo && motivo !== "SALAO_INATIVO_OU_OUTRO_ESCOPO" ? { resultado: "RECUSA_COM_MOTIVO", motivo } : GENERICA;
  }
  try {
    await saloesProntosPublicos(tx, escopo, env);
  } catch (erro) {
    if (erro instanceof SalaoPublicoIndisponivel) return GENERICA;
    throw erro;
  }
  return { resultado: "ACEITA" };
}
