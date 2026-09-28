import { reaisDe } from '../../../lib/financeiro/calculos.ts';

/**
 * Contrato da resposta de `atencao_hoje` visto pela UI (docs/INTELIGENCIA_V1.md, “Contrato para a futura UI”).
 * Declarado aqui porque o Admin não importa `lib/inteligencia` (arquitetura.test.ts, teste 10).
 */
export type ItemAtencao = {
  tipo: string;
  prioridade: 'alta' | 'media' | 'baixa';
  titulo: string;
  detalhe: string;
  destino: string;
  evidencia: { fonte: string; quantidade: number; valorCentavos: number; maiorAtrasoDias?: number };
};

export type AtencaoHoje = {
  capacidade: 'atencao_hoje';
  estado: 'atencao' | 'em_dia' | 'sem_dados';
  resumo: string;
  referencia: { hoje: string; geradoEm: string; fonte: string };
  itens: ItemAtencao[];
};

/**
 * Cliente da capacidade real `atencao_hoje` (POST /api/admin/inteligencia).
 * Envia só `{ capacidade }`: sem empresa, usuário ou texto livre — o servidor decide o tenant.
 * Números e textos vêm prontos do gateway; aqui só se formata a evidência, sem somar itens.
 */
export const ENDPOINT_INTELIGENCIA = '/api/admin/inteligencia';
export const MENSAGEM_ERRO = 'Não foi possível preparar esta análise agora. O restante do sistema continua disponível.';

export type ResultadoAtencao = { tipo: 'resposta'; dados: AtencaoHoje } | { tipo: 'erro'; mensagem: string };
export type Buscador = (url: string, init: RequestInit) => Promise<Response>;

function pareceAtencaoHoje(dados: unknown): dados is AtencaoHoje {
  if (!dados || typeof dados !== 'object') return false;
  const d = dados as Partial<AtencaoHoje>;
  return d.capacidade === 'atencao_hoje' && typeof d.resumo === 'string' && Array.isArray(d.itens) && typeof d.referencia === 'object';
}

export async function consultarAtencaoHoje(buscar: Buscador): Promise<ResultadoAtencao> {
  try {
    const resposta = await buscar(ENDPOINT_INTELIGENCIA, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capacidade: 'atencao_hoje' }),
    });
    const corpo = await resposta.json() as { ok?: boolean; data?: unknown; erro?: unknown };
    if (corpo?.ok === true && pareceAtencaoHoje(corpo.data)) return { tipo: 'resposta', dados: corpo.data };
    // As mensagens do gateway já são humanas e sem detalhe interno.
    return { tipo: 'erro', mensagem: typeof corpo?.erro === 'string' && corpo.erro ? corpo.erro : MENSAGEM_ERRO };
  } catch {
    return { tipo: 'erro', mensagem: MENSAGEM_ERRO };
  }
}

const FONTES: Readonly<Record<string, string>> = { 'financeiro.recebiveis': 'Financeiro · Contas a receber' };

export function rotuloFonte(fonte: string) {
  return FONTES[fonte] ?? 'Dados do sistema';
}

/** Evidência agregada de um indicador, tal como veio do serviço de domínio. */
export function evidenciaTexto(item: ItemAtencao) {
  const { quantidade, valorCentavos, maiorAtrasoDias } = item.evidencia;
  const partes = [`${quantidade} ${quantidade === 1 ? 'registro' : 'registros'}`, reaisDe(valorCentavos)];
  if (maiorAtrasoDias != null) partes.push(`maior atraso ${maiorAtrasoDias} ${maiorAtrasoDias === 1 ? 'dia' : 'dias'}`);
  return partes.join(' · ');
}

export function horaReferencia(geradoEm: string) {
  const data = new Date(geradoEm);
  if (Number.isNaN(data.getTime())) return '';
  return data.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
}
