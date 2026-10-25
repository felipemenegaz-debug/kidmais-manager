import { versaoDeReferencia, type FluxoBase, type Referencia } from '../../lib/contratos/versao-referencia.ts';

/**
 * Regras de apresentação da tela de contrato simplificada (plano rev. 3/rev. 4, fase 1). Sem I/O e sem efeito: a tela
 * só decide O QUE mostrar; quem grava continua sendo `action()` com as mesmas chamadas de antes. Os predicados de ação
 * são os mesmos da tela anterior, avaliados sobre o alvo de ação (equivalência testada em contrato-tela.test.ts).
 */
export type VersaoTela = {
  id: string; numero_versao: number; status: string; estado_edicao: string | null; revisao: number;
  documento_revisado_id: string | null; origem_versao_id?: string | null; criado_em?: string; motivo_nova_versao?: string | null;
};
export type RevisaoOperacionalTela = {
  contrato_versao_id: string; estado: string; hold_destino_adquirido_em: string | null; ocupa_vigente: boolean; slot_alterado: boolean;
  data_evento: string; data_vigente: string; horario_inicio: string; horario_fim: string;
};
export type PainelTela<V extends VersaoTela = VersaoTela> = {
  contrato: { status: string };
  fluxo: FluxoBase;
  versoes: V[];
  documentos: Array<{ contrato_versao_id: string; categoria: string; revisao: number }>;
  revisoesOperacionais: RevisaoOperacionalTela[];
  festaId?: string | null;
};

const EDICAO_ABERTA = ['EM_ELABORACAO', 'ASSINADA_KIDMAIS', 'AGUARDANDO_CLIENTE'];

/** Preparação apontada pelo fluxo e ainda aberta (mesma regra da tela anterior). */
export function preparacaoDoPainel<V extends VersaoTela>(data: PainelTela<V>) {
  const preparacao = data.versoes.find(x => x.id === data.fluxo?.versao_em_preparacao_id && EDICAO_ABERTA.includes(x.estado_edicao ?? ''));
  const revisaoPreparacao = data.revisoesOperacionais.find(r => r.contrato_versao_id === preparacao?.id);
  const ativa = !!preparacao && (!revisaoPreparacao || ['EM_ELABORACAO', 'CONGELADA'].includes(revisaoPreparacao.estado));
  return { preparacao: preparacao ?? null, ativa };
}

/** Versão vigente pelo fluxo (null sem fluxo ou sem vigente). */
export function vigenteDoFluxo<V extends VersaoTela>(data: PainelTela<V>) {
  return data.versoes.find(x => x.id === data.fluxo?.versao_vigente_id) ?? null;
}

/**
 * Referências da tela (rev. 3, N6; rev. 4, R3-1):
 * - `referencia`: o que o topo e o Resumo mostram (regra única, compartilhada com a lista);
 * - `alvo`: a versão sobre a qual as ações agem — preparação ativa → vigente (contrato não cancelado) → maior ATIVA → null.
 */
export function referenciasDaTela<V extends VersaoTela>(data: PainelTela<V>): { referencia: Referencia<V> | null; alvo: V | null } {
  const referencia = versaoDeReferencia(data.versoes, data.fluxo);
  const { preparacao, ativa } = preparacaoDoPainel(data);
  if (preparacao && ativa) return { referencia, alvo: preparacao };
  const vigente = vigenteDoFluxo(data) ?? (!data.fluxo || !data.fluxo.versao_vigente_id ? [...data.versoes].sort((a, b) => b.numero_versao - a.numero_versao).find(v => v.status === 'ASSINADA') ?? null : null);
  if (vigente && data.contrato.status !== 'CANCELADO') return { referencia, alvo: vigente };
  const ativaMaior = [...data.versoes].sort((a, b) => b.numero_versao - a.numero_versao).find(v => v.status === 'ATIVA') ?? null;
  return { referencia, alvo: ativaMaior };
}

/** Predicados de ação — copiados da tela anterior, sobre `v` (= alvo de ação). */
export function predicados<V extends VersaoTela>(data: PainelTela<V>, v: V | null) {
  const status = data.contrato.status, fluxo = data.fluxo;
  const { preparacao, ativa: preparacaoAtiva } = preparacaoDoPainel(data);
  const docs = v ? data.documentos.filter(d => d.contrato_versao_id === v.id) : [];
  const revisaoOperacional = v ? data.revisoesOperacionais.find(r => r.contrato_versao_id === v.id) ?? null : null;
  const podeSubstituir = !!v && v.status === 'ATIVA' && status !== 'CANCELADO' && fluxo?.versao_em_preparacao_id === v.id && ['ASSINADA_KIDMAIS', 'AGUARDANDO_CLIENTE'].includes(v.estado_edicao ?? '');
  const podeRevisar = !!v && status === 'ASSINADO' && v.status === 'ASSINADA' && (!fluxo || fluxo.versao_vigente_id === v.id);
  const podeCancelarRevisao = !!v && v.status === 'ATIVA' && status !== 'CANCELADO' && fluxo?.versao_em_preparacao_id === v.id && EDICAO_ABERTA.includes(v.estado_edicao ?? '');
  const emElaboracao = v?.estado_edicao === 'EM_ELABORACAO';
  const pdfDaRevisao = !!v && docs.some(d => d.categoria === 'CONTRATO' && d.revisao === v.revisao);
  return {
    preparacao, preparacaoAtiva: !!preparacaoAtiva, revisaoOperacional, podeSubstituir, podeRevisar, podeCancelarRevisao,
    podeEditar: emElaboracao, podeGerarPdf: emElaboracao, podeRevisarPdf: emElaboracao && pdfDaRevisao,
    podeAssinar: emElaboracao && !!v?.documento_revisado_id, podeLiberar: v?.estado_edicao === 'ASSINADA_KIDMAIS',
    podeAbrirPublico: v?.estado_edicao === 'AGUARDANDO_CLIENTE' && status !== 'CANCELADO',
    podeRecusarComercial: revisaoOperacional?.estado === 'EM_ELABORACAO',
    podeRevalidar: !!revisaoOperacional && ['EM_ELABORACAO', 'CONGELADA'].includes(revisaoOperacional.estado),
    // festaId tem precedência: com festa, o cancelamento é sempre o da festa (componente e API próprios).
    cancelamento: status === 'CANCELADO' ? null : data.festaId ? 'FESTA' as const
      : status === 'AGUARDANDO_ASSINATURA' && !fluxo?.versao_vigente_id ? 'CONTRATACAO_INICIAL' as const : null,
  };
}

/** Próximo passo (mesmo texto da tela anterior). */
export function proximoPasso(v: VersaoTela | null, docs: Array<{ categoria: string; revisao: number }>) {
  if (v?.estado_edicao === 'EM_ELABORACAO') return v.documento_revisado_id ? 'Assinar pela Kidmais' : docs.some(d => d.categoria === 'CONTRATO' && d.revisao === v.revisao) ? 'Revisar o PDF' : 'Preparar o documento';
  if (v?.estado_edicao === 'ASSINADA_KIDMAIS') return 'Liberar para o cliente';
  if (v?.estado_edicao === 'AGUARDANDO_CLIENTE') return 'Acompanhar assinatura do cliente';
  return 'Conferir documentos e assinaturas';
}

const humano = (s: string) => { const t = s.replaceAll('_', ' ').toLowerCase(); return t.charAt(0).toUpperCase() + t.slice(1); };
const ROTULO_CONTRATO: Record<string, string> = { ASSINADO: 'Assinado', AGUARDANDO_ASSINATURA: 'Aguardando assinatura', CANCELADO: 'Cancelado' };
const ROTULO_EDICAO: Record<string, string> = { EM_ELABORACAO: 'Em preparação', ASSINADA_KIDMAIS: 'Assinada pelo buffet', AGUARDANDO_CLIENTE: 'Aguardando o cliente', CONCLUIDA: 'Concluída', CANCELADA: 'Descartada' };
const ROTULO_VERSAO: Record<string, string> = { ASSINADA: 'Assinada', ATIVA: 'Em preparação', SUBSTITUIDA: 'Substituída', CANCELADA: 'Cancelada' };
export const rotuloContrato = (status: string) => ROTULO_CONTRATO[status] ?? humano(status);
/** Situação de uma versão em linguagem simples: assinada vale mais que o estado da edição. */
export const rotuloVersao = (v: Pick<VersaoTela, 'status' | 'estado_edicao'>) =>
  v.status === 'ASSINADA' ? 'Assinada' : v.estado_edicao ? ROTULO_EDICAO[v.estado_edicao] ?? humano(v.estado_edicao) : ROTULO_VERSAO[v.status] ?? humano(v.status);

const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'], MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
/** '2027-04-20' → 'ter, 20 abr 2027'. Data inválida volta como veio. */
export function dataPorExtenso(iso: string | null | undefined) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  if (!m) return iso ?? '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCMonth() !== +m[2] - 1) return iso ?? '';
  return `${DIAS[d.getUTCDay()]}, ${+m[3]} ${MESES[+m[2] - 1]} ${m[1]}`;
}
const hora = (h: string) => { const m = /^(\d{2}):(\d{2})/.exec(h ?? ''); return m ? `${+m[1]}h${m[2] === '00' ? '' : m[2]}` : h; };
/** '10:00:00','14:30:00' → '10h às 14h30'. */
export const faixaHorario = (inicio: string, fim: string) => `${hora(inicio)} às ${hora(fim)}`;

/** Título da festa (D6): aniversariante quando houver; senão o contratante. Idade 0 é válida; ausentes são omitidos. */
export function tituloFesta(s: { contratante: { nomeCompleto: string }; aniversariante?: { nome?: string | null; idadeNoEvento?: number | null; temaFesta?: string | null } | null }) {
  const nome = s.aniversariante?.nome?.trim(), idade = s.aniversariante?.idadeNoEvento, tema = s.aniversariante?.temaFesta?.trim();
  return {
    titulo: nome ? `Aniversário de ${nome}` : s.contratante.nomeCompleto,
    idade: typeof idade === 'number' && Number.isInteger(idade) && idade >= 0 ? `${idade} ${idade === 1 ? 'ano' : 'anos'}` : null,
    tema: tema || null,
    aniversariante: nome || null,
  };
}

/** Matriz da agenda (rev. 2 §1.2): descreve só a RESERVA; nunca afirma disponibilidade. */
export function situacaoReserva(r: RevisaoOperacionalTela | null) {
  if (!r || !['EM_ELABORACAO', 'CONGELADA'].includes(r.estado)) return null;
  if (!r.ocupa_vigente) return { tipo: 'PROPOSTA' as const, alerta: false, texto: 'Data proposta — ainda não reservada' };
  if (!r.slot_alterado) return { tipo: 'MANTIDA' as const, alerta: false, texto: 'Data e horário mantidos · reserva confirmada' };
  if (r.hold_destino_adquirido_em) return { tipo: 'PROTEGIDA' as const, alerta: false, texto: 'Nova data protegida durante a troca' };
  return { tipo: 'SEM_PROTECAO' as const, alerta: true, texto: 'Nova data sem proteção — revalide' };
}

/** Etapas do contrato (D4, só com o que existe na fase 1). `atual` é o índice da etapa em andamento; -1 = nenhuma. */
export const ETAPAS = ['Preparar', 'Você assina', 'Liberar', 'Aguardando o cliente', 'Assinado', 'Festa realizada'] as const;
export function etapaAtual(alvo: VersaoTela | null, temVigente: boolean, estadoFesta: string | null): { atual: number; concluidas: number; mostrarFesta: boolean } {
  const mostrarFesta = estadoFesta !== null && estadoFesta !== 'CANCELADA' && estadoFesta !== 'REMOVIDA';
  const e = alvo?.estado_edicao;
  if (e === 'EM_ELABORACAO') return { atual: alvo?.documento_revisado_id ? 1 : 0, concluidas: alvo?.documento_revisado_id ? 1 : 0, mostrarFesta };
  if (e === 'ASSINADA_KIDMAIS') return { atual: 2, concluidas: 2, mostrarFesta };
  if (e === 'AGUARDANDO_CLIENTE') return { atual: 3, concluidas: 3, mostrarFesta };
  if (!temVigente) return { atual: -1, concluidas: 0, mostrarFesta };
  return estadoFesta === 'REALIZADA' ? { atual: -1, concluidas: 6, mostrarFesta } : { atual: -1, concluidas: 5, mostrarFesta };
}

/** Saída da aba Pagamentos antes de consultar a posição (rev. 4, R3-2): decide pelo detalhe, que já foi carregado. */
export function saidaPagamentos(quantidadePagamentos: number, caminhoFinanceiro: string | null | undefined) {
  if (quantidadePagamentos > 1) return 'MULTIPLOS' as const;
  if (quantidadePagamentos === 1) return 'CARREGAR' as const;
  if (caminhoFinanceiro === 'AGUARDAR_REVISAO') return 'AGUARDAR_REVISAO' as const;
  if (caminhoFinanceiro === 'CONFERIR_HISTORICO') return 'CONFERIR_HISTORICO' as const;
  return 'CRIAR_PLANO' as const;
}

const CONFERENCIA = new Set(['SNAPSHOT_DIVERGENTE', 'DADOS_INVALIDOS', 'POSICAO_INCONSISTENTE', 'CREDITO_RESERVADO_INCOMPATIVEL', 'OBRIGACAO_NAO_DISPONIVEL']);
/** Mensagem para uma recusa da posição financeira. Nenhum número é mostrado e nada sugere criar nova obrigação. */
export function erroPagamentos(status: number, codigo: string | null | undefined, temVigente: boolean) {
  if (status === 401) return { tipo: 'SESSAO' as const, texto: 'Sua sessão expirou. Entre novamente para ver os pagamentos.' };
  if (status === 403) return { tipo: 'PERMISSAO' as const, texto: 'Você não tem permissão para ver os pagamentos deste contrato.' };
  if (status === 404) return { tipo: 'NAO_ENCONTRADO' as const, texto: 'Contrato não encontrado.' };
  if (codigo === 'VERSAO_NAO_VIGENTE') return temVigente
    ? { tipo: 'CONFERENCIA' as const, texto: 'Pagamentos precisam de conferência (VERSAO_NAO_VIGENTE).' }
    : { tipo: 'SEM_ASSINATURA' as const, texto: 'Pagamentos ficam disponíveis depois da assinatura.' };
  if (codigo && CONFERENCIA.has(codigo)) return { tipo: 'CONFERENCIA' as const, texto: `Pagamentos precisam de conferência (${codigo}).` };
  return { tipo: 'TENTAR' as const, texto: 'Não foi possível carregar os pagamentos.' };
}

/** Confirmação positiva de agenda (rev. 4, P3-2): presa a contrato + versão + revisão consultados. */
export const chaveConferencia = (contratoId: string, versaoId: string, revisao: number) => `${contratoId}:${versaoId}:${revisao}`;
