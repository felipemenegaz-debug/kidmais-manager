import type { ContextoContrato } from './financeiro-apresentacao';

/**
 * Seleção do contrato pela URL (`/admin/contratos?contratoId=…&versaoId=…`). A URL é a fonte da seleção: link do
 * Dashboard, do Financeiro, da festa ou do assistente, troca pelo seletor e voltar/avançar do navegador passam por ela.
 * O contrato pedido é carregado pelo detalhe do tenant (posse provada no servidor), mesmo quando os filtros da lista o
 * ocultam; a lista só serve para escolher.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type PedidoContrato =
  | { tipo: 'nenhum' }
  | { tipo: 'invalido' }
  | { tipo: 'contrato'; contratoId: string; versaoId: string | null };

/** Lê `contratoId`/`versaoId` da URL. `versaoId` inválida é ignorada (cai na versão padrão do contrato). */
export function pedidoDaUrl(params: Pick<URLSearchParams, 'get'>): PedidoContrato {
  const contratoId = params.get('contratoId')?.trim() ?? '';
  if (!contratoId) return { tipo: 'nenhum' };
  if (!UUID.test(contratoId)) return { tipo: 'invalido' };
  const versaoId = params.get('versaoId')?.trim() ?? '';
  return { tipo: 'contrato', contratoId: contratoId.toLowerCase(), versaoId: UUID.test(versaoId) ? versaoId.toLowerCase() : null };
}

/** URL da seleção feita pelo seletor: preserva os demais parâmetros (ex.: returnTo) e descarta a versão anterior. */
export function urlDaSelecao(pathname: string, atual: Pick<URLSearchParams, 'toString'>, contratoId: string): string {
  const params = new URLSearchParams(atual.toString());
  params.delete('versaoId');
  if (contratoId) params.set('contratoId', contratoId);
  else params.delete('contratoId');
  const busca = params.toString();
  return busca ? `${pathname}?${busca}` : pathname;
}

export const MENSAGEM_LINK_INVALIDO = 'O link do contrato é inválido. Escolha o contrato na lista.';
export const MENSAGEM_SEM_ACESSO = 'Contrato não encontrado nesta empresa ou sem permissão de acesso.';

/** Falha ao abrir o contrato pedido: inexistente/de outra empresa (404) ou sem permissão (403) têm mensagem clara. */
export function mensagemFalhaContrato(status: number, erro?: string | null): string {
  if (status === 404 || status === 403) return MENSAGEM_SEM_ACESSO;
  if (status === 400) return MENSAGEM_LINK_INVALIDO;
  return erro?.trim() || 'Não foi possível carregar o contrato. Tente novamente.';
}

export class FalhaContrato extends Error {
  readonly status: number;
  constructor(status: number, mensagem: string) {
    super(mensagem);
    this.name = 'FalhaContrato';
    this.status = status;
  }
}

/**
 * Só a resposta do ÚLTIMO pedido é aplicada: um contrato clicado antes, cuja resposta chega atrasada, não substitui o
 * contrato atual.
 */
export function criarSequenciador() {
  let ultimo = 0;
  return {
    iniciar: () => ++ultimo,
    vigente: (pedido: number) => pedido === ultimo,
  };
}

type PainelResumo = {
  contrato: { id: string; status: string; versao_atual: number };
  versoes: Array<{ numero_versao: number; snapshot?: { contratante?: { nomeCompleto?: string }; evento?: { data?: string; pacote?: { nome?: string }; convidados?: number | string } } }>;
};

/** Opção do seletor para o contrato aberto pelo link que os filtros da lista ocultam (ex.: cancelado). */
export function opcaoForaDaLista(lista: readonly ContextoContrato[], contratoId: string, painel: PainelResumo | null): ContextoContrato | null {
  if (!contratoId || !painel || painel.contrato.id !== contratoId || lista.some((c) => c.id === contratoId)) return null;
  const atual = painel.versoes.find((v) => v.numero_versao === painel.contrato.versao_atual) ?? painel.versoes[painel.versoes.length - 1];
  const s = atual?.snapshot;
  return {
    id: contratoId,
    nome: s?.contratante?.nomeCompleto ?? null,
    data_evento: s?.evento?.data ?? null,
    pacote: s?.evento?.pacote?.nome ?? null,
    convidados: s?.evento?.convidados ?? null,
    status: painel.contrato.status,
  };
}
