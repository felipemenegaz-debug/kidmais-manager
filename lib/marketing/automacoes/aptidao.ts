import type { DbExecutor } from "../../db/contracts.ts";
import { lerEstadoComercial } from "../../assinatura/estado.ts";
import { recursoIncluido } from "../../assinatura/recursos-plano.ts";

/**
 * Aptidão da EMPRESA para o motor de automações (correção R2, 15/10/2026). Usa as regras atuais do produto, sem política
 * própria de assinatura:
 *   - empresa ATIVA (empresas.status);
 *   - recurso MARKETING no plano (lib/assinatura/recursos-plano.ts; teste/legado/isenta = incluído, como nas APIs);
 *   - situação comercial COMPLETO (lib/assinatura/estado.ts): automação é ESCRITA em nome da empresa, então segue a mesma
 *     regra das escritas da tela — SOMENTE_LEITURA e BLOQUEADO não executam.
 * Vale no planejamento e imediatamente antes de gerar tarefa ou enviar, inclusive para execução já agendada, reservada,
 * recuperada de posse ou em nova tentativa.
 * Inaptidão confirmada é definitiva para a execução (CANCELADA, motivo auditável). Falha de LEITURA nunca libera: a
 * execução volta para a fila e tenta de novo depois, sem agir.
 */
export type Aptidao = { apta: true } | { apta: false; motivo: string; definitivo: boolean };
export type DependenciasAptidao = { recursoIncluido: typeof recursoIncluido; lerEstadoComercial: typeof lerEstadoComercial };
const PADRAO: DependenciasAptidao = { recursoIncluido, lerEstadoComercial };

export async function empresaApta(tx: DbExecutor, empresaId: string, deps: DependenciasAptidao = PADRAO): Promise<Aptidao> {
  // SAVEPOINT: erro de SQL na leitura do direito não pode abortar a transação do motor (que ainda registra o resultado).
  await tx.query("SAVEPOINT marketing_aptidao");
  try {
    const empresa = await tx.query<{ status: string }>(`SELECT status FROM empresas WHERE id = $1::uuid`, [empresaId]);
    let resultado: Aptidao;
    if (empresa.rows[0]?.status !== "ATIVA") resultado = { apta: false, motivo: "EMPRESA_NAO_ATIVA", definitivo: true };
    else if (!(await deps.recursoIncluido(tx, empresaId, "MARKETING"))) resultado = { apta: false, motivo: "SEM_RECURSO_MARKETING", definitivo: true };
    else {
      const { acesso } = await deps.lerEstadoComercial(tx, empresaId);
      resultado = acesso.nivel === "COMPLETO" ? { apta: true } : { apta: false, motivo: `ACESSO_COMERCIAL_${acesso.nivel}`, definitivo: true };
    }
    await tx.query("RELEASE SAVEPOINT marketing_aptidao");
    return resultado;
  } catch {
    await tx.query("ROLLBACK TO SAVEPOINT marketing_aptidao").catch(() => undefined);
    return { apta: false, motivo: "LEITURA_DO_DIREITO_FALHOU", definitivo: false };
  }
}
