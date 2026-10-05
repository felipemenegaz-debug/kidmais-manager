import type { CadastroContratual } from '../../../lib/clientes/cadastro-contratual.ts';
import { decidirOperacao, type RascunhoPublico } from '../inteligencia/cliente-inteligencia.ts';
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
  cadastro?: CadastroContratual;
  contrato: { cliente: string; pacoteDocumento: string | null; pacoteReferencia: string | null; unidade: string | null; valorContratadoCentavos: number; conferencia: string };
  festa: { data: string; horarioInicio: string; horarioFim: string; convidados: number; aniversariante: string | null; tema: string | null; aniversarianteCadastro: 'NOVO' | 'EXISTENTE' | null };
  agenda: { ocupa: boolean; descricao: string };
  financeiro: ResumoFinanceiro;
  campos: CampoConferido[];
};
export type OpcoesIntegracao = {
  disponivel: boolean;
  hoje: string;
  integracao: { contratoId: string; financeiroPendente: boolean; caminhoFinanceiro?: 'CONFERIR_HISTORICO' | 'PLANO_NA_VERSAO_VIGENTE' | 'AGUARDAR_REVISAO' | 'CONCLUIDO'; valorContratadoCentavos: number } | null;
  cliente: { id: string | null; nome: string; ativo: boolean; cadastro?: CadastroContratual } | null;
  documento: { pacote: string | null; aniversariante: string | null; tema: string | null };
  sugestao: Sugestao;
  estabelecimentos: Array<{ id: string; nome: string }>;
  pacotes: Array<{ id: string; codigo: string; nome: string; duracaoMinutos: number | null; ativo: boolean }>;
  formas: string[];
  declaracao: string;
};
export type Simulacao =
  | { integrada: true; contratoId: string }
  | { integrada: false; pronto: boolean; bloqueios: string[]; avisos: string[]; resumo: ResumoIntegracao; resumoHash: string; planoHash?: string; possiveisVinculos: PossivelVinculo[] };
export type SinalDuplicidade = 'MESMO_CLIENTE' | 'MESMO_CONTATO' | 'MESMO_ANIVERSARIANTE' | 'MESMO_VALOR' | 'MESMO_DOCUMENTO'
  | 'DATA_DO_DOCUMENTO' | 'DATA_INVERTIDA' | 'DATA_PROXIMA';
export type PossivelVinculo = { fechamentoId: string; contratoId: string | null; status: string; data: string; alcance: 'MESMO_DIA' | 'OUTRA_DATA'; horario: string;
  comPagamento: boolean; importado: boolean; sinais: SinalDuplicidade[] };
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

const postarRascunho = (buscar: Buscador, id: string, versao: number, acao: string, campos: object = {}) =>
  buscar('/api/admin/inteligencia/importacoes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ acao, importacaoId: id, versao, ...campos }) });

export async function lerOpcoesRascunho(buscar: Buscador, id: string, versao: number): Promise<Resposta<OpcoesIntegracao>> {
  const r = await ler<{ opcoes?: OpcoesIntegracao }>(postarRascunho(buscar, id, versao, 'opcoes-completas'));
  return r.ok && r.dados.opcoes ? { ok: true, dados: r.dados.opcoes } : r.ok ? { ok: false, mensagem: 'Confira os dados do cliente e do contrato antes de continuar.', codigo: 'IMPORTACAO_BLOQUEADA', detalhes: null } : r;
}
export async function simularRascunho(buscar: Buscador, id: string, versao: number, decisoes: object): Promise<Resposta<Simulacao>> {
  const r = await ler<{ simulacao?: Simulacao }>(postarRascunho(buscar, id, versao, 'simular-completa', { integracao: decisoes }));
  return r.ok && r.dados.simulacao ? { ok: true, dados: r.dados.simulacao } : r.ok ? { ok: false, mensagem: 'Confira os dados do contrato antes de continuar.', codigo: 'IMPORTACAO_BLOQUEADA', detalhes: null } : r;
}
/** Um clique humano, preview já visto e hashes iguais: prepara o Gate e conclui pela rota nativa de confirmação. */
export async function confirmarRascunho(buscar: Buscador, id: string, versao: number, decisoes: object, resumoHash: string, planoHash: string): Promise<Resposta<ResultadoIntegracao>> {
  const r = await ler<{ gate?: { tipo: string; rascunho?: RascunhoPublico } }>(postarRascunho(buscar, id, versao, 'preparar', { integracao: decisoes, integracaoHash: resumoHash, planoHash }));
  if (!r.ok) return r;
  if (r.dados.gate?.tipo !== 'preview' || !r.dados.gate.rascunho) return { ok: false, mensagem: 'A revisão mudou. Confira os dados novamente.', codigo: 'RESUMO_DESATUALIZADO', detalhes: null };
  const resultado = await decidirOperacao(buscar, r.dados.gate.rascunho, 'confirmar');
  if (resultado.tipo !== 'ok') return { ok: false, mensagem: resultado.mensagem + ' Confira o contrato na lista antes de repetir a confirmação.', codigo: 'CONFIRMACAO_RECUSADA', detalhes: null };
  const resposta = resultado.resposta;
  const contratoId = resposta.tipo === 'resultado_acao' && resposta.destino ? /^\/admin\/contratos\?contratoId=([0-9a-f-]{36})$/.exec(resposta.destino)?.[1] : null;
  if (!contratoId) return { ok: false, mensagem: 'Confira o contrato pela lista de Contratos antes de repetir.', codigo: 'RESULTADO_INESPERADO', detalhes: null };
  return { ok: true, dados: { contratoId, destino: '/admin/contratos?contratoId=' + contratoId, reutilizado: false } };
}

export const lerOpcoes = (buscar: Buscador, id: string) => ler<OpcoesIntegracao>(buscar(endpointIntegracao(id), { method: 'GET' }));
export const simular = (buscar: Buscador, id: string, decisoes: object) => ler<Simulacao>(postar(buscar, id, { acao: 'simular', decisoes }));
export const confirmar = (buscar: Buscador, id: string, decisoes: object, resumoHash: string, chave: string) =>
  ler<ResultadoIntegracao>(postar(buscar, id, { acao: 'confirmar', decisoes, resumoHash, chave }));
export const simularFinanceiro = (buscar: Buscador, id: string, financeiro: object) => ler<SimulacaoFinanceira>(postar(buscar, id, { acao: 'simular-financeiro', financeiro }));
export const conferirFinanceiro = (buscar: Buscador, id: string, financeiro: object, resumoHash: string, chave: string) =>
  ler<{ reutilizado: boolean; contratoId: string; pagamentoId?: string; situacao?: string }>(postar(buscar, id, { acao: 'conferir-financeiro', financeiro, resumoHash, chave }));

/**
 * Autenticação recente exigida para confirmar (mesmo mecanismo nativo da assinatura Kidmais): a senha vai só para a
 * rota de autenticação, nunca para a integração.
 */
export const reautenticar = (buscar: Buscador, senha: string) =>
  ler<unknown>(buscar('/api/admin/autenticacao', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ acao: 'reautenticar', senha }) }));

/** Uma chave por resumo exibido: repetir o clique (ou a rede) não duplica; resumo novo ⇒ chave nova. */
export function novaChave() {
  return globalThis.crypto.randomUUID();
}
