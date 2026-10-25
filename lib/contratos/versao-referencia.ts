/**
 * Versão de referência do contrato (plano da tela simplificada, rev. 4, R3-1): a versão que o topo, o Resumo e a
 * lista de contratos mostram. Uma única regra, sem I/O, usada pela tela e pelo servidor; a lista (fase 2) reproduz a
 * mesma ordem em SQL, com teste de paridade. Não decide ações: o alvo das ações é outra referência.
 *
 * Ordem: 1) vigente apontada pelo fluxo; 2) maior ASSINADA (fluxo ausente ou ponteiro vazio); 3) preparação apontada
 * pelo fluxo (contratação inicial); 4) maior ATIVA; 5) maior de todas, com diagnóstico SEM_VERSAO_VALIDA.
 * Independe da ordem de entrada; ponteiro do fluxo que não pertence às versões informadas é ignorado.
 */
export type VersaoBase = { id: string; numero_versao: number; status: string };
export type FluxoBase = { versao_vigente_id: string | null; versao_em_preparacao_id: string | null } | null | undefined;
export type OrigemReferencia = 'VIGENTE_FLUXO' | 'VIGENTE_LEGADA' | 'PREPARACAO_INICIAL' | 'ATIVA_SEM_FLUXO' | 'SEM_VERSAO_VALIDA';
export type Referencia<V extends VersaoBase> = { versao: V; origem: OrigemReferencia; diagnostico: 'SEM_VERSAO_VALIDA' | null };

export function versaoDeReferencia<V extends VersaoBase>(versoes: readonly V[], fluxo: FluxoBase): Referencia<V> | null {
  if (!versoes.length) return null;
  const ordenadas = [...versoes].sort((a, b) => b.numero_versao - a.numero_versao);
  const porId = (id: string | null | undefined) => (id ? ordenadas.find((v) => v.id === id) : undefined);
  const vigente = porId(fluxo?.versao_vigente_id);
  if (vigente) return { versao: vigente, origem: 'VIGENTE_FLUXO', diagnostico: null };
  const assinada = ordenadas.find((v) => v.status === 'ASSINADA');
  if (assinada) return { versao: assinada, origem: 'VIGENTE_LEGADA', diagnostico: null };
  const preparacao = porId(fluxo?.versao_em_preparacao_id);
  if (preparacao) return { versao: preparacao, origem: 'PREPARACAO_INICIAL', diagnostico: null };
  const ativa = ordenadas.find((v) => v.status === 'ATIVA');
  if (ativa) return { versao: ativa, origem: 'ATIVA_SEM_FLUXO', diagnostico: null };
  return { versao: ordenadas[0], origem: 'SEM_VERSAO_VALIDA', diagnostico: 'SEM_VERSAO_VALIDA' };
}

/** A referência é a versão que vale hoje (assinada), e não uma proposta ainda não assinada. */
export function referenciaVigente(origem: OrigemReferencia) {
  return origem === 'VIGENTE_FLUXO' || origem === 'VIGENTE_LEGADA';
}
