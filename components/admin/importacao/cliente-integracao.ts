import type { Sugestao } from './integracao-form.ts';

/**
 * Cliente da integração do contrato importado. Nunca envia empresa, usuário ou valores calculados: só as decisões
 * do operador. O resumo, o hash e a confirmação vêm do servidor.
 */
export const endpointIntegracao = (importacaoId: string) => `/api/admin/contratos/importados/${encodeURIComponent(importacaoId)}/integracao`;

export type ParcelaResumo = { numero: number; valorCentavos: number; vencimento: string; situacao: 'RECEBIDA' | 'A_RECEBER' | 'VENCIDA'; recebidaEm: string | null; forma: string | null };
export type ResumoFinanceiro =
  | { situacao: 'NAO_CONFERIDO'; contratadoCentavos: number; pendencia: string }
  | { situacao: 'NAO_PAGO' | 'PARCIALMENTE_PAGO' | 'PAGO'; contratadoCentavos: number; recebidoCentavos: number; saldoCentavos: number; parcelas: ParcelaResumo[]; recebimentos: Array<{ numero: number; valorCentavos: number; data: string; forma: string }>; aReceber: ParcelaResumo[] };
export type CampoConferido = { campo: string; rotulo: string; documento: string | null; efetivo: string; origem: 'DOCUMENTO' | 'CORRECAO_LEITURA' | 'COMPLEMENTO'; motivo: string | null };
export type ResumoIntegracao = {
  contrato: { cliente: string; pacoteDocumento: string | null; pacoteReferencia: string | null; unidade: string | null; valorContratadoCentavos: number; conferencia: string };
  festa: { data: string; horarioInicio: string; horarioFim: string; convidados: number; aniversariante: string | null; tema: string | null; aniversarianteCadastro: 'NOVO' | 'EXISTENTE' | null };
  agenda: { ocupa: boolean; descricao: string };
  financeiro: ResumoFinanceiro;
  campos: CampoConferido[];
};
export type OpcoesIntegracao = {
  disponivel: boolean;
  hoje: string;
  integracao: { contratoId: string; financeiroPendente: boolean; valorContratadoCentavos: number } | null;
  cliente: { id: string; nome: string; ativo: boolean } | null;
  documento: { pacote: string | null; aniversariante: string | null; tema: string | null };
  sugestao: Sugestao;
  estabelecimentos: Array<{ id: string; nome: string }>;
  pacotes: Array<{ id: string; codigo: string; nome: string; duracaoMinutos: number | null; ativo: boolean }>;
  formas: string[];
  declaracao: string;
};
export type Simulacao =
  | { integrada: true; contratoId: string }
  | { integrada: false; pronto: boolean; bloqueios: string[]; avisos: string[]; resumo: ResumoIntegracao; resumoHash: string; possiveisVinculos: Array<{ fechamentoId: string; contratoId: string | null; status: string; horario: string; comPagamento: boolean }> };
export type ResultadoIntegracao = {
  reutilizado: boolean; contratoId: string; destino?: string; festaId?: string; agendaOcupada?: boolean;
  financeiro?: { situacao: string; pendente: boolean; recebidoCentavos?: number; saldoCentavos?: number };
};
export type SimulacaoFinanceira =
  | { conferido: true; contratoId: string }
  | { conferido: false; pronto: boolean; bloqueios: string[]; avisos: string[]; resumo: ResumoFinanceiro; resumoHash: string };

export type Falha = { ok: false; mensagem: string; codigo: string | null; detalhes: Record<string, unknown> | null };
export type Resposta<T> = { ok: true; dados: T } | Falha;
type Buscador = (url: string, init: RequestInit) => Promise<Response>;

export const MENSAGEM_ERRO_INTEGRACAO = 'Não foi possível concluir agora. Nada foi gravado; tente de novo.';

async function ler<T>(resposta: Promise<Response>): Promise<Resposta<T>> {
  try {
    const r = await resposta;
    const json = await r.json() as { ok?: boolean; data?: T; erro?: unknown; codigo?: unknown; detalhes?: unknown };
    if (json?.ok === true && json.data !== undefined) return { ok: true, dados: json.data };
    return {
      ok: false,
      mensagem: typeof json?.erro === 'string' && json.erro ? json.erro : MENSAGEM_ERRO_INTEGRACAO,
      codigo: typeof json?.codigo === 'string' ? json.codigo : null,
      detalhes: json?.detalhes && typeof json.detalhes === 'object' ? json.detalhes as Record<string, unknown> : null,
    };
  } catch {
    return { ok: false, mensagem: MENSAGEM_ERRO_INTEGRACAO, codigo: null, detalhes: null };
  }
}

const postar = (buscar: Buscador, id: string, corpo: object) =>
  buscar(endpointIntegracao(id), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo) });

export const lerOpcoes = (buscar: Buscador, id: string) => ler<OpcoesIntegracao>(buscar(endpointIntegracao(id), { method: 'GET' }));
export const simular = (buscar: Buscador, id: string, decisoes: object) => ler<Simulacao>(postar(buscar, id, { acao: 'simular', decisoes }));
export const confirmar = (buscar: Buscador, id: string, decisoes: object, resumoHash: string, chave: string) =>
  ler<ResultadoIntegracao>(postar(buscar, id, { acao: 'confirmar', decisoes, resumoHash, chave }));
export const simularFinanceiro = (buscar: Buscador, id: string, financeiro: object) => ler<SimulacaoFinanceira>(postar(buscar, id, { acao: 'simular-financeiro', financeiro }));
export const conferirFinanceiro = (buscar: Buscador, id: string, financeiro: object, resumoHash: string, chave: string) =>
  ler<{ reutilizado: boolean; contratoId: string; pagamentoId?: string; situacao?: string }>(postar(buscar, id, { acao: 'conferir-financeiro', financeiro, resumoHash, chave }));

/** Uma chave por resumo exibido: repetir o clique (ou a rede) não duplica; resumo novo ⇒ chave nova. */
export function novaChave() {
  return globalThis.crypto.randomUUID();
}
