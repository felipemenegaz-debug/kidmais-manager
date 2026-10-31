import type { DbExecutor } from "../db/contracts.ts";
import { buscarPacoteVigenteDaEmpresaPorCodigo, listarPacotesContrataveisDaEmpresa } from "./repositories/comercial.repository.ts";
import { PACOTES_CONTRATAVEIS_V1 } from "./pacotes-v1.ts";
import { lerPrecosCorrentes } from "./pacote-precos.ts";
import type { PacoteRecord } from "./repositories/models.ts";

/**
 * Catálogo efetivo do endereço público, comum à etapa de pacotes (`/api/fechamentos/pacotes`) e à faixa do salão
 * combinado na lista de salões (E2b, P2-E2b-2: lista, faixa e pacotes nunca divergem).
 *   * /b/<código>: todos os pacotes contratáveis da empresa (vigentes, ativos, não arquivados), na ordem da tela de Pacotes;
 *   * endereço atual (dona da agenda pública): os sete V1, na ordem do catálogo.
 */
export async function pacotesDaOfertaPublica(db: DbExecutor, empresaId: string, enderecoDaEmpresa: boolean): Promise<PacoteRecord[]> {
  if (enderecoDaEmpresa) return listarPacotesContrataveisDaEmpresa(empresaId, db);
  const lista: PacoteRecord[] = [];
  for (const { codigo } of PACOTES_CONTRATAVEIS_V1) {
    const pacote = await buscarPacoteVigenteDaEmpresaPorCodigo(empresaId, codigo, db);
    if (pacote) lista.push(pacote);
  }
  return lista;
}

export type LinhaPrecoPublico = { pacoteId: string; porConvidado: boolean; min: number; valor: number };

/**
 * "A partir de": menor valor do pacote na tabela publicada HOJE (fixo pela faixa; por convidado × mínimo). Tabela
 * ambígua ou ilegível não derruba a leitura: o preço só some (a cotação da etapa seguinte explica).
 */
export async function precosPublicosDeHoje(db: DbExecutor, empresaId: string): Promise<LinhaPrecoPublico[]> {
  return (await lerPrecosCorrentes(db, empresaId).catch(() => ({ pacotes: [] as LinhaPrecoPublico[] }))).pacotes;
}

/** E2b ("a partir de" do combinado): o MENOR dos preços dos pacotes do universo — nunca a soma dos membros; null sem preço. */
export function menorPreco(valores: string[]) {
  return valores.length ? valores.reduce((a, b) => (Number(b) < Number(a) ? b : a)) : null;
}

/** Menor preço publicado das linhas (texto com 2 casas, como a etapa de pacotes); null sem linha. */
export function precoMinimo(linhas: Array<{ porConvidado: boolean; min: number; valor: number }>) {
  if (!linhas.length) return null;
  return Math.min(...linhas.map((l) => (l.porConvidado ? l.valor * l.min : l.valor))).toFixed(2);
}
