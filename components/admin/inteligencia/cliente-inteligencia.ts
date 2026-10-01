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
  | { tipo: 'precisa_contexto'; mensagem: string }
  /** Navegação interna (AI V1.1): só rota da lista fechada; a UI revalida antes de navegar. */
  | { tipo: 'navegacao'; tela: string; recurso: string; destino: string; rotulo: string };

export type ContextoTela = { tela: 'dashboard' | 'festa' | 'cliente' | 'contrato' | 'financeiro' | 'pacotes' | 'agenda' | 'configuracoes' | 'geral'; entidadeId?: string };

export type ResultadoConversa =
  | { tipo: 'ok'; resposta: RespostaIA }
  | { tipo: 'desativada'; mensagem: string }
  | { tipo: 'erro'; mensagem: string; codigo: string | null };

/** Espera cancelada pelo operador (código próprio, nunca vindo do servidor). */
export const CODIGO_CANCELADA = 'CANCELADA_PELO_OPERADOR';
export const MENSAGEM_CANCELADA = 'Pergunta cancelada. Nada foi alterado.';

const TIPOS_RESPOSTA = new Set(['resposta', 'agente', 'rascunho', 'preview', 'resultado_acao', 'nao_suportado', 'precisa_contexto', 'navegacao']);

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/**
 * Mesma lista fechada do servidor (lib/inteligencia/rotas-navegacao.ts), repetida aqui como defesa em profundidade
 * (o Admin não importa lib/inteligencia): a UI só navega para rota interna conhecida — nunca esquema (javascript:,
 * data:, file:, http:), host (//), "..", barra invertida ou query fora do padrão.
 */
const ROTA_INTERNA = new RegExp(
  `^/(?:admin/(?:dashboard|contratos(?:\\?contratoId=${UUID})?|festas(?:/${UUID})?|clientes/${UUID}/fechamento(?:\\?rascunho=${UUID})?|financeiro(?:/contas-(?:receber|pagar))?|disponibilidade|configuracoes(?:/(?:catalogo|pacotes))?)|clientes(?:/${UUID})?)$`,
);

export function rotaInternaSegura(destino: unknown): destino is string {
  return typeof destino === 'string' && destino.length <= 200 && ROTA_INTERNA.test(destino);
}

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
  if (d.tipo === 'navegacao') {
    const n = d as { destino?: unknown; rotulo?: unknown; tela?: unknown; recurso?: unknown };
    return rotaInternaSegura(n.destino) && texto(n.rotulo) && texto(n.tela) && texto(n.recurso);
  }
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
export function conversar(buscar: Buscador, pedido: { texto: string; contexto?: ContextoTela | null; operacaoId?: string; foco?: FocoUI | null; continuacao?: ContinuacaoUI | null }, sinal?: AbortSignal) {
  const foco = pedido.foco?.entidades.length ? focoParaEnvio(pedido.foco) : null;
  return postar(buscar, ENDPOINT_CONVERSA, {
    texto: pedido.texto,
    ...(pedido.contexto ? { contexto: pedido.contexto } : {}),
    ...(pedido.operacaoId ? { operacaoId: pedido.operacaoId } : {}),
    ...(foco ? { foco } : {}),
    ...(pedido.continuacao ? { continuacao: pedido.continuacao } : {}),
  }, sinal);
}

/**
 * IA operacional: pergunta de parâmetro pendente ("Quantos docinhos por convidado…?"). A UI guarda e reenvia SÓ na
 * próxima mensagem, como dica (categoria fechada + números já informados); o servidor relê a festa e recalcula.
 */
type CategoriaUI = 'DOCES' | 'REFRIGERANTES';
type ParametrosUI = Partial<Record<'porConvidado' | 'mlPorConvidado' | 'embalagemMl' | 'margemPercentual', number>> & {
  distribuicao?: Array<{ tipo: string; percentual?: number; quantidade?: number }>;
};
export type ContinuacaoUI = {
  tipo: 'PARAMETRO_CONSUMO';
  categoria: CategoriaUI;
  perguntado: 'POR_CONVIDADO' | 'ML_POR_CONVIDADO' | 'EMBALAGEM';
  parametros?: ParametrosUI;
  /** Pergunta com várias categorias: todas elas seguem juntas até os resultados finais. */
  categorias?: CategoriaUI[];
  /** Números já escritos para as outras categorias da mesma pergunta. */
  informados?: Partial<Record<CategoriaUI, ParametrosUI>>;
  /** Festa da pergunta (dica; o servidor revalida). */
  festaId?: string;
};

const CATEGORIAS_UI: readonly CategoriaUI[] = ['DOCES', 'REFRIGERANTES'];
const UUID_CONTINUACAO = new RegExp(`^${UUID}$`);

function parametrosValidos(p: unknown): ParametrosUI | null {
  const x = p as Record<string, unknown> | null | undefined;
  const parametros: ParametrosUI = {};
  for (const chave of ['porConvidado', 'mlPorConvidado', 'embalagemMl', 'margemPercentual'] as const) {
    const v = x?.[chave];
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 20000) parametros[chave] = v;
  }
  const d = x?.distribuicao;
  if (Array.isArray(d) && d.length >= 2 && d.length <= 10) {
    const itens = d.map((i: { tipo?: unknown; percentual?: unknown; quantidade?: unknown } | null) => {
      if (!i || typeof i.tipo !== 'string' || !/^[p{L} ]{1,40}$/u.test(i.tipo)) return null;
      const n = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 100_000 ? v : undefined);
      const percentual = n(i.percentual), quantidade = n(i.quantidade);
      return { tipo: i.tipo, ...(percentual !== undefined ? { percentual } : {}), ...(quantidade !== undefined ? { quantidade } : {}) };
    });
    if (itens.every(Boolean)) parametros.distribuicao = itens as NonNullable<ParametrosUI['distribuicao']>;
  }
  return Object.keys(parametros).length ? parametros : null;
}

/** Aceita só o formato fechado; qualquer desvio ⇒ sem continuação (a próxima mensagem segue como pergunta nova). */
export function continuacaoValida(c: unknown): ContinuacaoUI | null {
  const x = c as Partial<ContinuacaoUI> | null;
  if (!x || x.tipo !== 'PARAMETRO_CONSUMO' || !CATEGORIAS_UI.includes(x.categoria as CategoriaUI)) return null;
  if (x.perguntado !== 'POR_CONVIDADO' && x.perguntado !== 'ML_POR_CONVIDADO' && x.perguntado !== 'EMBALAGEM') return null;
  const categoria = x.categoria as CategoriaUI;
  const parametros = parametrosValidos(x.parametros);
  let categorias: CategoriaUI[] | null = null;
  if (x.categorias !== undefined) {
    const lista = Array.isArray(x.categorias) ? x.categorias : [];
    const validas = lista.length >= 2 && lista.every((k) => CATEGORIAS_UI.includes(k)) && new Set(lista).size === lista.length && lista.includes(categoria);
    if (!validas) return null;
    categorias = [...lista];
  }
  const informados: Partial<Record<CategoriaUI, ParametrosUI>> = {};
  for (const k of categorias ?? []) {
    const p = k === categoria ? null : parametrosValidos(x.informados?.[k]);
    if (p) informados[k] = p;
  }
  const festaId = typeof x.festaId === 'string' && UUID_CONTINUACAO.test(x.festaId) ? x.festaId : null;
  return {
    tipo: 'PARAMETRO_CONSUMO', categoria, perguntado: x.perguntado,
    ...(parametros ? { parametros } : {}),
    ...(categorias ? { categorias } : {}),
    ...(Object.keys(informados).length ? { informados } : {}),
    ...(festaId ? { festaId } : {}),
  };
}

/**
 * Foco da conversa (AI V1.1, PR 5): entidades recentes devolvidas pelo servidor. A UI guarda o rótulo só para
 * exibir e reenvia SÓ tipo + id (dica), como o contexto de tela; o servidor revalida tudo a cada uso.
 */
export type FocoUI = { entidades: Array<{ tipo: string; id: string; rotulo: string }>; principal: number | null };
const TIPOS_FOCO = new Set(['FESTA', 'CLIENTE', 'CONTRATO', 'ITEM', 'CATEGORIA']);
const UUID_FOCO = new RegExp(`^${UUID}$`);

/** Aceita só o formato fechado; qualquer desvio ⇒ sem foco (a conversa segue sem dica). */
export function focoValido(foco: unknown, anterior: FocoUI | null = null): FocoUI | null {
  const f = foco as { entidades?: unknown; principal?: unknown } | null;
  if (!f || !Array.isArray(f.entidades) || f.entidades.length > 5) return null;
  const entidades: FocoUI['entidades'] = [];
  for (const e of f.entidades as Array<{ tipo?: unknown; id?: unknown; rotulo?: unknown }>) {
    if (!e || typeof e.tipo !== 'string' || !TIPOS_FOCO.has(e.tipo) || typeof e.id !== 'string' || !UUID_FOCO.test(e.id) || typeof e.rotulo !== 'string') return null;
    // O servidor não conhece o rótulo das entidades antigas: a UI mantém o que já exibia.
    const rotulo = e.rotulo || anterior?.entidades.find((a) => a.id === e.id)?.rotulo || '';
    entidades.push({ tipo: e.tipo, id: e.id, rotulo: rotulo.slice(0, 120) });
  }
  const principal = typeof f.principal === 'number' && Number.isInteger(f.principal) && f.principal >= 0 && f.principal < entidades.length ? f.principal : null;
  return { entidades, principal };
}

function focoParaEnvio(foco: FocoUI) {
  return { entidades: foco.entidades.map(({ tipo, id }) => ({ tipo, id })), ...(foco.principal != null ? { principal: foco.principal } : {}) };
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
  'festas.contrato_vigente': 'Festas · Contrato vigente',
  'festas.buffet_efetivo': 'Festas · Buffet',
  'empresa.parametros_consumo': 'Regra da empresa',
  'operador.informado': 'Informado por você',
  'operacional.calculo': 'Cálculo do Kidmais',
  'operacional.parametro_ausente': 'Regra da empresa',
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
