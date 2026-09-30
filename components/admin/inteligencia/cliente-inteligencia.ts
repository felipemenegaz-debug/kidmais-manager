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

export function pareceAtencaoHoje(dados: unknown): dados is AtencaoHoje {
  if (!dados || typeof dados !== 'object') return false;
  const d = dados as Partial<AtencaoHoje>;
  return d.capacidade === 'atencao_hoje' && typeof d.resumo === 'string' && Array.isArray(d.itens) && typeof d.referencia === 'object';
}

export async function consultarAtencaoHoje(buscar: Buscador, sinal?: AbortSignal): Promise<ResultadoAtencao> {
  try {
    const resposta = await buscar(ENDPOINT_INTELIGENCIA, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capacidade: 'atencao_hoje' }),
      ...(sinal ? { signal: sinal } : {}),
    });
    const corpo = await resposta.json() as { ok?: boolean; data?: unknown; erro?: unknown };
    if (corpo?.ok === true && pareceAtencaoHoje(corpo.data)) return { tipo: 'resposta', dados: corpo.data };
    // As mensagens do gateway já são humanas e sem detalhe interno.
    return { tipo: 'erro', mensagem: typeof corpo?.erro === 'string' && corpo.erro ? corpo.erro : MENSAGEM_ERRO };
  } catch {
    return { tipo: 'erro', mensagem: MENSAGEM_ERRO };
  }
}

/**
 * Contratos da conversa e do Human Gate vistos pela UI (espelho de lib/inteligencia/contratos.ts).
 * A UI só envia texto, contexto de tela e, no clique, operacaoId/versão/hash do preview.
 * Nunca envia empresa, usuário, papel ou payload: o servidor relê tudo do rascunho persistido.
 */
export const ENDPOINT_CONVERSA = '/api/admin/inteligencia/conversa';
export const ENDPOINT_OPERACOES = '/api/admin/inteligencia/operacoes';

export type Fato = { natureza: 'FATO' | 'CALCULO' | 'AUSENCIA'; texto: string; fonte: string };
export type RespostaLeitura = {
  capacidade: string;
  estado: 'atencao' | 'em_dia' | 'sem_dados' | 'informativo';
  resumo: string;
  fatos: Fato[];
  itens: Array<{ id: string; prioridade: 'alta' | 'media' | 'baixa'; titulo: string; detalhe: string; destino?: string }>;
  evidencias: Array<{ fonte: string; rotulo: string; valor: string; destino?: string }>;
  referencia: { hoje: string; geradoEm: string; fontes: string[] };
};
export type RascunhoPublico = {
  operacaoId: string;
  capacidade: string;
  estado: 'COLETANDO' | 'AGUARDANDO_CONFIRMACAO' | 'EXECUTADA' | 'CANCELADA' | 'EXPIRADA' | 'FALHOU';
  versao: number;
  payloadHash: string;
  expiraEm: string;
  titulo: string;
  campos: Array<{ id: string; rotulo: string; valor: string | null; obrigatorio: boolean }>;
  avisos: string[];
};
/** Complemento do Copiloto: SEMPRE secundário aos dados (explicação conferida contra eles; próxima ação é sugestão). */
export type ComplementoCopiloto = {
  explicacao: { frases: string[]; origem: 'MODELO'; aviso: string } | null;
  proximaAcao: { titulo: string; passos: string[]; destino: string | null; fonte: string } | null;
};
export type SecaoAgente = { titulo: string; dados: RespostaLeitura | AtencaoHoje };
/** Rascunho de texto de um agente: sugestão para revisar; o Kidmais não envia nada. */
export type SugestaoAgente = { titulo: string; texto: string; fonte: string; aviso: string; pendentes: string[] };
export type RespostaIA =
  | { tipo: 'resposta'; dados: RespostaLeitura | AtencaoHoje; complemento?: ComplementoCopiloto }
  | { tipo: 'agente'; agente: { id: string; nome: string }; resumo: string; secoes: SecaoAgente[]; sugestao: SugestaoAgente | null }
  | { tipo: 'rascunho'; rascunho: RascunhoPublico; pergunta: string; faltando: string[] }
  | { tipo: 'preview'; rascunho: RascunhoPublico }
  | { tipo: 'resultado_acao'; rascunho: RascunhoPublico; mensagem: string; destino?: string }
  | { tipo: 'nao_suportado'; mensagem: string; sugestoes: string[] }
  | { tipo: 'precisa_contexto'; mensagem: string };

export type ContextoTela = { tela: 'dashboard' | 'festa' | 'cliente' | 'contrato' | 'financeiro' | 'pacotes' | 'agenda' | 'configuracoes' | 'geral'; entidadeId?: string };

export type ResultadoConversa =
  | { tipo: 'ok'; resposta: RespostaIA }
  | { tipo: 'desativada'; mensagem: string }
  | { tipo: 'erro'; mensagem: string; codigo: string | null };

/** Espera cancelada pelo operador (código próprio, nunca vindo do servidor). */
export const CODIGO_CANCELADA = 'CANCELADA_PELO_OPERADOR';
export const MENSAGEM_CANCELADA = 'Pergunta cancelada. Nada foi alterado.';

const TIPOS_RESPOSTA = new Set(['resposta', 'agente', 'rascunho', 'preview', 'resultado_acao', 'nao_suportado', 'precisa_contexto']);

function pareceRascunho(r: unknown): r is RascunhoPublico {
  const x = r as Partial<RascunhoPublico> | null;
  return !!x && typeof x.operacaoId === 'string' && typeof x.versao === 'number' && typeof x.payloadHash === 'string' && Array.isArray(x.campos) && Array.isArray(x.avisos);
}

const texto = (v: unknown) => typeof v === 'string';
function pareceLeitura(d: unknown): boolean {
  const x = d as Partial<RespostaLeitura> | null;
  return pareceAtencaoHoje(d) || (!!x && texto(x.resumo) && Array.isArray(x.fatos) && Array.isArray(x.itens));
}
function pareceComplemento(c: unknown): boolean {
  if (c === undefined) return true;
  const x = c as Partial<ComplementoCopiloto> | null;
  if (!x || typeof x !== 'object') return false;
  const e = x.explicacao;
  const p = x.proximaAcao;
  return (e === null || (!!e && Array.isArray(e.frases) && e.frases.every(texto) && texto(e.aviso)))
    && (p === null || (!!p && texto(p.titulo) && Array.isArray(p.passos) && p.passos.every(texto) && texto(p.fonte)));
}
function pareceSugestao(s: unknown): boolean {
  if (s === null) return true;
  const x = s as Partial<SugestaoAgente> | null;
  return !!x && texto(x.titulo) && texto(x.texto) && texto(x.fonte) && texto(x.aviso) && Array.isArray(x.pendentes) && x.pendentes.every(texto);
}

function pareceResposta(dados: unknown): dados is RespostaIA {
  const d = dados as { tipo?: unknown; dados?: Partial<RespostaLeitura>; rascunho?: unknown; mensagem?: unknown; pergunta?: unknown } | null;
  if (!d || typeof d.tipo !== 'string' || !TIPOS_RESPOSTA.has(d.tipo)) return false;
  // `atencao_hoje` pedido em texto livre volta pelo /conversa no formato V1 próprio.
  if (d.tipo === 'resposta') return pareceLeitura(d.dados) && pareceComplemento((d as { complemento?: unknown }).complemento);
  if (d.tipo === 'agente') {
    const a = d as unknown as { agente?: { id?: unknown; nome?: unknown }; resumo?: unknown; secoes?: unknown; sugestao?: unknown };
    return texto(a.agente?.id) && texto(a.agente?.nome) && texto(a.resumo) && Array.isArray(a.secoes)
      && a.secoes.every((s: { titulo?: unknown; dados?: unknown }) => texto(s?.titulo) && pareceLeitura(s?.dados)) && pareceSugestao(a.sugestao ?? null);
  }
  if (d.tipo === 'rascunho') return pareceRascunho(d.rascunho) && typeof d.pergunta === 'string';
  if (d.tipo === 'preview') return pareceRascunho(d.rascunho);
  if (d.tipo === 'resultado_acao') return pareceRascunho(d.rascunho) && typeof d.mensagem === 'string';
  return typeof d.mensagem === 'string';
}

async function postar(buscar: Buscador, url: string, corpo: object, sinal?: AbortSignal): Promise<ResultadoConversa> {
  try {
    const resposta = await buscar(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo), ...(sinal ? { signal: sinal } : {}) });
    const json = await resposta.json() as { ok?: boolean; data?: unknown; erro?: unknown; codigo?: unknown };
    if (json?.ok === true && pareceResposta(json.data)) return { tipo: 'ok', resposta: json.data };
    const mensagem = typeof json?.erro === 'string' && json.erro ? json.erro : MENSAGEM_ERRO;
    if (json?.codigo === 'INTELIGENCIA_DESATIVADA') return { tipo: 'desativada', mensagem };
    return { tipo: 'erro', mensagem, codigo: typeof json?.codigo === 'string' ? json.codigo : null };
  } catch {
    if (sinal?.aborted) return { tipo: 'erro', mensagem: MENSAGEM_CANCELADA, codigo: CODIGO_CANCELADA };
    return { tipo: 'erro', mensagem: MENSAGEM_ERRO, codigo: null };
  }
}

/** Pergunta livre ou resposta a um rascunho. `sinal` permite ao operador cancelar a espera (leitura não tem efeito). */
export function conversar(buscar: Buscador, pedido: { texto: string; contexto?: ContextoTela | null; operacaoId?: string }, sinal?: AbortSignal) {
  return postar(buscar, ENDPOINT_CONVERSA, {
    texto: pedido.texto,
    ...(pedido.contexto ? { contexto: pedido.contexto } : {}),
    ...(pedido.operacaoId ? { operacaoId: pedido.operacaoId } : {}),
  }, sinal);
}

/** Clique humano no preview. Só o que o preview devolveu: o servidor revalida todo o resto. */
export function decidirOperacao(buscar: Buscador, rascunho: RascunhoPublico, decisao: 'confirmar' | 'cancelar') {
  return postar(buscar, ENDPOINT_OPERACOES, { operacaoId: rascunho.operacaoId, versao: rascunho.versao, payloadHash: rascunho.payloadHash, decisao });
}

const ROTULOS_FATO: Readonly<Record<Fato['natureza'], string>> = { FATO: 'Dado', CALCULO: 'Cálculo', AUSENCIA: 'Sem dados' };
export function rotuloFato(natureza: Fato['natureza']) {
  return ROTULOS_FATO[natureza];
}

const FONTES: Readonly<Record<string, string>> = {
  'financeiro.recebiveis': 'Financeiro · Contas a receber',
  'financeiro.recebimentos': 'Financeiro · Recebimentos',
  'contratos.aguardando_assinatura': 'Contratos',
  'contratos.versao_vigente': 'Contratos · Versão vigente',
  'festas.agenda': 'Festas · Agenda',
  'festas.detalhe': 'Festas',
  'crm.clientes': 'Clientes',
};

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
