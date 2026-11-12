import type { DbExecutor } from '../db/contracts.ts';
import { nomePublicoDaEmpresa } from '../perfil/nome-publico.ts';

/**
 * Quem aparece como buffet nas telas de contrato. A logo e o nome da Kidmais só valem com a prova positiva
 * (`empresas.codigo = 'kidmais'`); qualquer dúvida cai em texto neutro, nunca na marca de outra empresa.
 */
export type MarcaContrato = { kidmais: boolean; nome: string | null };

export const MARCA_CONTRATO_NEUTRA: MarcaContrato = Object.freeze({ kidmais: false, nome: null });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Serve dentro de transação: falha de SQL sobe com a causa original, para o rollback; não cai em neutro. */
export async function marcaDaEmpresa(tx: DbExecutor, empresaId: string): Promise<MarcaContrato> {
  const codigo = (await tx.query<{ codigo: string }>('SELECT codigo FROM public.empresas WHERE id = $1::uuid', [empresaId])).rows[0]?.codigo;
  if (!codigo) return MARCA_CONTRATO_NEUTRA;
  return { kidmais: codigo === 'kidmais', nome: await nomePublicoDaEmpresa(tx, empresaId, { propagarErroDeBanco: true }) };
}

/**
 * Marca de um contrato dentro da transação que o usa: mesma regra de neutro para contrato ou empresa ausentes, mas falha de
 * SQL sobe. Engolir a falha deixaria a transação abortada e o INSERT seguinte falharia com 25P02, escondendo a causa.
 */
export async function marcaDoContratoNaTransacao(tx: DbExecutor, contratoId: string): Promise<MarcaContrato> {
  if (!UUID.test(contratoId)) return MARCA_CONTRATO_NEUTRA;
  const empresaId = (await tx.query<{ e: string | null }>(
    'SELECT f.empresa_id::text AS e FROM public.contratos c JOIN public.fechamentos f ON f.id = c.fechamento_id WHERE c.id = $1::uuid',
    [contratoId],
  )).rows[0]?.e;
  return empresaId ? marcaDaEmpresa(tx, empresaId) : MARCA_CONTRATO_NEUTRA;
}

/**
 * Marca de um contrato cujo acesso JÁ foi provado (identidade do cliente ou tenant): nunca chamar antes da prova, porque
 * a resposta revela que o contrato existe e de qual buffet é. O status da empresa não entra: suspensa ou não, é com ela
 * que o cliente contratou, e quem decide o acesso ao contrato é o fluxo que chama.
 * Id inválido, contrato inexistente, legado sem empresa ou falha de leitura respondem igual: neutro.
 * Só para leitura fora de transação (pool); dentro de transação, `marcaDoContratoNaTransacao`.
 */
export async function marcaDoContratoPublico(tx: DbExecutor, contratoId: string): Promise<MarcaContrato> {
  try {
    return await marcaDoContratoNaTransacao(tx, contratoId);
  } catch {
    return MARCA_CONTRATO_NEUTRA;
  }
}
