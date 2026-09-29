import type { DbExecutor } from '../../db/contracts';
import { withTransaction } from '../../db/postgres';

/**
 * C2 — atomicidade entre autorização e escrita financeira.
 *
 * As rotas administrativas abrem a transação do tenant (provarTenant: usuário ativo, empresa ativa,
 * membership e papel atual, com as travas mantidas até o commit), provam a posse do recurso e passam o
 * `executor`: o serviço roda NESSA transação, então a autoridade usada para escrever não pode ser revogada
 * entre a prova e a escrita. Sem executor (chamadores internos), o serviço abre a própria transação.
 */
/**
 * F3 — operação de domínio que SÓ existe dentro da transação do tenant (posse do pagamento já provada pelo
 * chamador). Sem executor não há variante insegura: recusa, sem abrir transação própria por UUID.
 */
export function exigirExecutorDoTenant(context: { executor?: DbExecutor; tenant?: { empresaComprovada?: string } } | null | undefined): { tx: DbExecutor; empresaId: string } {
  const empresaId = context?.tenant?.empresaComprovada;
  if (!context?.executor || typeof empresaId !== 'string' || empresaId === '') {
    throw new Error('Operação financeira exige a transação e o tenant comprovado do chamador.');
  }
  return { tx: context.executor, empresaId };
}

export function naTransacao<T>(executor: DbExecutor | undefined, trabalho: (tx: DbExecutor) => Promise<T>): Promise<T> {
  return executor ? trabalho(executor) : withTransaction(trabalho);
}
