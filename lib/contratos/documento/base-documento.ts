import type { DbExecutor } from '../../db/contracts.ts';
import { migration072Aplicada, modeloContratoAtivo } from '../modelo-empresa/servico.ts';
import type { BaseDocumentoContrato } from './fonte.ts';

/**
 * Lê, no `tx` e na empresa comprovada de quem chama, o que decide a fonte do PDF (`fonteDoDocumentoContrato`): a 072, o
 * modelo próprio ativo e se a empresa é a Kidmais. Só leituras. Devolve também o modelo, que o `gerar_pdf` usa para
 * renderizar; a projeção da tela usa só `base` (três booleanos, sem conteúdo nem versão do modelo).
 */
export async function lerBaseDocumentoContrato(tx: DbExecutor, empresaId: string) {
  const modeloEmpresa = await modeloContratoAtivo(tx, empresaId);
  const migration072 = await migration072Aplicada(tx);
  const codigo = (await tx.query<{ codigo: string }>('SELECT codigo FROM empresas WHERE id=$1::uuid', [empresaId])).rows[0]?.codigo;
  const base: BaseDocumentoContrato = { migration072, modeloEmpresaAtivo: Boolean(modeloEmpresa), empresaKidmais: codigo === 'kidmais' };
  return { modeloEmpresa, base };
}
