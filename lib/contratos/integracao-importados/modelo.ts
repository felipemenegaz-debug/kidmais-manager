import { cadastroPayloadSchema, contratanteSnapshot, formularioCadastro, type CadastroContratual } from '../../clientes/cadastro-contratual.ts';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { FORMAS, type FormaFinanceira } from '../../financeiro/calculos.ts';
import type { SnapshotHistorico } from '../../importacao-contrato/plano.ts';

/**
 * Integração do contrato histórico importado ao Core — regras puras (sem banco).
 *
 * A IA só extraiu e sugeriu. Aqui o operador CONFIRMA fatos e efeitos operacionais:
 * - situação do contrato (só VIGENTE integra; cancelado ou não comprovado nunca vira festa);
 * - festa e agenda (unidade, pacote de referência do sistema, data, horário, convidados);
 * - pagamentos: cada parcela com valor/vencimento e, se foi RECEBIDA, data efetiva e forma. "À vista", "entrada" ou
 *   "30%" no documento não comprovam recebimento: nada é presumido pago. "Não conferido" não cria recebimento nem dívida.
 *
 * O documento é a referência: valor diferente do lido é CORRECAO_LEITURA (exige motivo); valor ausente no documento
 * é COMPLEMENTO operacional. Nenhum dos dois reescreve o snapshot original, que segue intacto ao lado.
 * Toda conta de dinheiro é em centavos inteiros.
 */
export const SITUACOES_CONTRATO = ['VIGENTE', 'CANCELADO', 'NAO_COMPROVADA'] as const;
export const SITUACOES_FINANCEIRAS = ['NAO_PAGO', 'PARCIALMENTE_PAGO', 'PAGO', 'NAO_CONFERIDO'] as const;
export type SituacaoFinanceira = (typeof SITUACOES_FINANCEIRAS)[number];

const DATA = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.');
const HORA = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Horário inválido.');
const CENTAVOS = z.number().int().min(1).max(99_999_999_99);
const MOTIVO = z.string().trim().max(500);

export const parcelaSchema = z.object({
  valorCentavos: CENTAVOS,
  vencimento: DATA,
  recebimento: z.object({ data: DATA, forma: z.enum(FORMAS) }).strict().nullable(),
  /**
   * Exceção HISTÓRICA: o operador confirma que esta parcela vence depois da festa conforme o contrato original. Só
   * nesse caso o vencimento posterior é aceito (contratos nativos seguem a regra do plano nativo). O vencimento nunca
   * é alterado automaticamente.
   */
  aposFestaConfirmada: z.boolean().optional(),
}).strict();

export const financeiroSchema = z.discriminatedUnion('situacao', [
  z.object({ situacao: z.literal('NAO_CONFERIDO') }).strict(),
  z.object({ situacao: z.enum(['NAO_PAGO', 'PARCIALMENTE_PAGO', 'PAGO']), parcelas: z.array(parcelaSchema).min(1).max(60) }).strict(),
]);

export const decisoesSchema = z.object({
  // Payload sem o telefone fixo (a tela não o envia); a regra de contato é aplicada ao cadastro mesclado com o CRM, em preparar().
  cadastro: cadastroPayloadSchema.optional(),
  formaPagamento: z.enum(["PIX_AVISTA", "PIX_PARCELADO", "CARTAO_CIELO"]).nullable().optional(),
  aniversariante: z.string().trim().min(2).max(200).optional(),
  situacaoContrato: z.enum(SITUACOES_CONTRATO),
  estabelecimentoId: z.string().uuid().nullable(),
  pacoteReferenciaId: z.string().uuid().nullable(),
  evento: z.object({
    data: DATA,
    horarioInicio: HORA,
    horarioFim: HORA,
    convidados: z.number().int().min(1).max(5000),
  }).strict(),
  valorContratadoCentavos: CENTAVOS,
  motivos: z.object({ data: MOTIVO, horarioInicio: MOTIVO, horarioFim: MOTIVO, convidados: MOTIVO, valorContratado: MOTIVO }).partial().strict().default({}),
  financeiro: financeiroSchema,
  /**
   * "É outro contrato" + motivo: decisão auditada exigida quando há contratação parecida na empresa no mesmo dia
   * (mesmo cliente, aniversariante, valor ou documento). Nada é unido nem recusado só por nome e data.
   */
  outroContratoConfirmado: z.boolean().default(false),
  motivoOutroContrato: z.string().trim().max(500).default(''),
  conferenciaDeclarada: z.boolean().default(false),
}).strict();

export type DecisoesIntegracao = z.infer<typeof decisoesSchema>;
export type DecisoesFinanceiras = z.infer<typeof financeiroSchema>;
export type ParcelaDecidida = z.infer<typeof parcelaSchema>;

export const DECLARACAO_CONFERENCIA =
  'Conferi o documento original assinado em papel. Os dados confirmados correspondem a ele, exceto as correções e complementos indicados. Nenhuma assinatura digital é registrada.';

export type OrigemValor = 'DOCUMENTO' | 'CORRECAO_LEITURA' | 'COMPLEMENTO';
export type CampoConferido = { campo: 'data' | 'horarioInicio' | 'horarioFim' | 'convidados' | 'valorContratado'; rotulo: string; documento: string | null; efetivo: string; origem: OrigemValor; motivo: string | null };

export type Referencias = {
  cliente: { id: string; nome: string; status: string };
  estabelecimentos: Array<{ id: string; nome: string }>;
  pacote: { id: string; codigo: string; nome: string; duracaoMinutos: number | null } | null;
  /** Linha de preço só como âncora do fechamento (o Core exige); o valor contratado é o do documento. */
  precoReferencia: { tabelaPrecoId: string; precoPacoteId: string; categoria: 'PADRAO' | 'NOBRE' } | null;
  configuracaoAgendaId: string | null;
};

export type ParcelaResumo = { numero: number; valorCentavos: number; vencimento: string; situacao: 'RECEBIDA' | 'A_RECEBER' | 'VENCIDA'; recebidaEm: string | null; forma: FormaFinanceira | null };

export type ResumoFinanceiro =
  | { situacao: 'NAO_CONFERIDO'; contratadoCentavos: number; pendencia: string }
  | { situacao: 'NAO_PAGO' | 'PARCIALMENTE_PAGO' | 'PAGO'; contratadoCentavos: number; recebidoCentavos: number; saldoCentavos: number; parcelas: ParcelaResumo[]; recebimentos: Array<{ numero: number; valorCentavos: number; data: string; forma: FormaFinanceira }>; aReceber: ParcelaResumo[] };

export type ResumoIntegracao = {
  cadastro?: CadastroContratual;
  cadastroFonteHash?: string;
  contrato: { cliente: string; pacoteDocumento: string | null; pacoteReferencia: string | null; unidade: string | null; valorContratadoCentavos: number; conferencia: string };
  /** `aniversarianteCadastro`: o aniversariante do documento será vinculado ao cadastro existente do cliente ou criado nele. */
  festa: { data: string; horarioInicio: string; horarioFim: string; convidados: number; aniversariante: string | null; tema: string | null; aniversarianteCadastro: 'NOVO' | 'EXISTENTE' | null };
  agenda: { ocupa: boolean; descricao: string };
  financeiro: ResumoFinanceiro;
  campos: CampoConferido[];
};

export type AvaliacaoIntegracao = { bloqueios: string[]; avisos: string[]; resumo: ResumoIntegracao };

const CAMPOS: Array<{ campo: CampoConferido['campo']; rotulo: string }> = [
  { campo: 'data', rotulo: 'Data da festa' },
  { campo: 'horarioInicio', rotulo: 'Início' },
  { campo: 'horarioFim', rotulo: 'Término' },
  { campo: 'convidados', rotulo: 'Convidados' },
  { campo: 'valorContratado', rotulo: 'Valor contratado' },
];

export const reais = (centavos: number) => `R$ ${Math.floor(centavos / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${String(centavos % 100).padStart(2, '0')}`;
export const centavosParaReais = (centavos: number) => Math.round(centavos) / 100;
const dataBr = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

function dataReal(iso: string) {
  const d = new Date(`${iso}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

/** Valores lidos do documento, para comparar com o efetivo (o snapshot não é alterado). */
export function valoresDoDocumento(s: SnapshotHistorico): Record<CampoConferido['campo'], string | null> {
  // Só o que foi lido. Término calculado pela duração é sugestão (sugestaoInicial) e conta como complemento.
  const total = s.valores?.total ?? (s.valores?.preco != null ? s.valores.preco + (s.valores.adicionais ?? 0) : null);
  return {
    data: s.evento?.data ?? null,
    horarioInicio: s.evento?.horario?.inicio ?? null,
    horarioFim: s.evento?.horario?.fim ?? null,
    convidados: s.evento?.convidados != null ? String(s.evento.convidados) : (s.pacote?.quantidade != null ? String(s.pacote.quantidade) : null),
    valorContratado: total != null ? String(total) : null,
  };
}

/** Sugestão inicial para o formulário: o que o documento diz, sem inferir recebimento. */
export function sugestaoInicial(s: SnapshotHistorico) {
  const doc = valoresDoDocumento(s);
  const inicio = doc.horarioInicio;
  const duracao = s.evento?.duracaoMinutos ?? s.pacote?.duracaoMinutos ?? null;
  let fim = doc.horarioFim;
  if (!fim && inicio && duracao) {
    const [h, m] = inicio.split(':').map(Number);
    const total = h * 60 + m + duracao;
    if (total < 24 * 60) fim = `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  }
  const previstas: Array<{ valorCentavos: number; vencimento: string | null }> = [];
  const p = s.pagamentosPrevistos;
  if (p?.entrada) previstas.push({ valorCentavos: p.entrada.valor, vencimento: p.entrada.vencimento });
  for (const parcela of p?.parcelas ?? []) previstas.push({ valorCentavos: parcela.valor, vencimento: parcela.vencimento });
  return {
    evento: { data: doc.data, horarioInicio: inicio, horarioFim: fim, convidados: doc.convidados ? Number(doc.convidados) : null },
    valorContratadoCentavos: doc.valorContratado ? Number(doc.valorContratado) : null,
    condicaoDocumento: p?.condicao ?? null,
    /** Parcelas previstas no documento: ponto de partida. Nenhuma vem marcada como recebida. */
    parcelasPrevistas: previstas,
  };
}

function compararCampo(campo: CampoConferido['campo'], rotulo: string, documento: string | null, efetivo: string, motivo: string | undefined, bloqueios: string[]): CampoConferido {
  const formatar = (v: string) => campo === 'valorContratado' ? reais(Number(v)) : campo === 'data' ? dataBr(v) : v;
  if (documento === null) return { campo, rotulo, documento: null, efetivo: formatar(efetivo), origem: 'COMPLEMENTO', motivo: motivo?.trim() || null };
  if (documento === efetivo) return { campo, rotulo, documento: formatar(documento), efetivo: formatar(efetivo), origem: 'DOCUMENTO', motivo: null };
  const m = motivo?.trim() ?? '';
  if (m.length < 5) bloqueios.push(`${rotulo}: difere do documento (${formatar(documento)}). Explique a correção de leitura.`);
  return { campo, rotulo, documento: formatar(documento), efetivo: formatar(efetivo), origem: 'CORRECAO_LEITURA', motivo: m || null };
}

function minutos(h: string) { const [a, b] = h.split(':').map(Number); return a * 60 + b; }

export function avaliarFinanceiro(f: DecisoesFinanceiras, contratadoCentavos: number, hoje: string, bloqueios: string[], avisos: string[]): ResumoFinanceiro {
  if (f.situacao === 'NAO_CONFERIDO') {
    avisos.push('Pagamentos não conferidos: nada entra em Contas a receber nem no Fluxo de caixa. O contrato fica com a pendência "Conferir pagamentos".');
    return { situacao: 'NAO_CONFERIDO', contratadoCentavos, pendencia: 'Conferir pagamentos do contrato importado.' };
  }
  const parcelas: ParcelaResumo[] = [];
  const recebimentos: Array<{ numero: number; valorCentavos: number; data: string; forma: FormaFinanceira }> = [];
  let soma = 0, recebido = 0;
  f.parcelas.forEach((p, i) => {
    const numero = i + 1;
    if (!dataReal(p.vencimento)) bloqueios.push(`Parcela ${numero}: vencimento inexistente.`);
    soma += p.valorCentavos;
    if (p.recebimento) {
      if (!dataReal(p.recebimento.data)) bloqueios.push(`Parcela ${numero}: data de recebimento inexistente.`);
      else if (p.recebimento.data > hoje) bloqueios.push(`Parcela ${numero}: recebimento com data futura. Registre só o que já foi recebido.`);
      recebido += p.valorCentavos;
      recebimentos.push({ numero, valorCentavos: p.valorCentavos, data: p.recebimento.data, forma: p.recebimento.forma });
      parcelas.push({ numero, valorCentavos: p.valorCentavos, vencimento: p.vencimento, situacao: 'RECEBIDA', recebidaEm: p.recebimento.data, forma: p.recebimento.forma });
    } else {
      parcelas.push({ numero, valorCentavos: p.valorCentavos, vencimento: p.vencimento, situacao: p.vencimento < hoje ? 'VENCIDA' : 'A_RECEBER', recebidaEm: null, forma: null });
    }
  });
  if (soma !== contratadoCentavos) {
    bloqueios.push(`As parcelas somam ${reais(soma)}, mas o valor contratado é ${reais(contratadoCentavos)}. Ajuste as parcelas ou o valor antes de confirmar.`);
  }
  const saldo = contratadoCentavos - recebido;
  const derivada = recebido === 0 ? 'NAO_PAGO' : saldo === 0 ? 'PAGO' : 'PARCIALMENTE_PAGO';
  const rotulos = { NAO_PAGO: 'não pago', PARCIALMENTE_PAGO: 'parcialmente pago', PAGO: 'totalmente pago' } as const;
  if (soma === contratadoCentavos && derivada !== f.situacao) {
    bloqueios.push(`A situação informada é "${rotulos[f.situacao]}", mas as parcelas marcadas como recebidas indicam "${rotulos[derivada]}". Confira.`);
  }
  const aReceber = parcelas.filter((p) => p.situacao !== 'RECEBIDA');
  if (aReceber.some((p) => p.situacao === 'VENCIDA')) avisos.push('Há parcelas vencidas a receber: entram em Contas a receber como vencidas.');
  return { situacao: f.situacao, contratadoCentavos, recebidoCentavos: recebido, saldoCentavos: Math.max(saldo, 0), parcelas, recebimentos, aReceber };
}

/**
 * Avaliação completa e determinística. A mesma função roda na simulação (o que o operador vê) e na confirmação
 * (dentro da transação, com referências revalidadas): o hash do resumo amarra uma à outra.
 */
export function avaliarIntegracao(e: { snapshot: SnapshotHistorico; decisoes: DecisoesIntegracao; referencias: Referencias; hoje: string }): AvaliacaoIntegracao {
  const { snapshot: s, decisoes: d, referencias: r, hoje } = e;
  const bloqueios: string[] = [];
  const avisos: string[] = [];

  if (d.situacaoContrato === 'CANCELADO') bloqueios.push('Contrato cancelado não vira festa nem ocupa agenda. Ele continua consultável como contrato importado.');
  if (d.situacaoContrato === 'NAO_COMPROVADA') bloqueios.push('Confirme se o contrato está vigente. Sem essa confirmação ele não é integrado.');
  if (r.cliente.status !== 'ATIVO') bloqueios.push('O cliente desta importação não está ativo (arquivado ou mesclado). Regularize o cadastro antes de integrar.');

  if (!dataReal(d.evento.data)) bloqueios.push('Data da festa inexistente.');
  if (minutos(d.evento.horarioFim) <= minutos(d.evento.horarioInicio)) bloqueios.push('O término deve ser depois do início, no mesmo dia.');

  if (r.estabelecimentos.length > 0 && !d.estabelecimentoId) bloqueios.push('Escolha a unidade da festa.');
  const unidade = d.estabelecimentoId ? r.estabelecimentos.find((x) => x.id === d.estabelecimentoId) ?? null : null;
  if (d.estabelecimentoId && !unidade) bloqueios.push('Unidade não encontrada nesta empresa.');
  if (!d.pacoteReferenciaId || !r.pacote) bloqueios.push('Escolha o pacote do sistema usado como referência operacional.');
  else if (!r.precoReferencia) bloqueios.push('O pacote de referência não tem linha de preço em nenhuma tabela desta empresa.');
  if (!r.configuracaoAgendaId) bloqueios.push('Agenda sem turno configurado.');

  const doc = valoresDoDocumento(s);
  const campos: CampoConferido[] = [
    compararCampo('data', CAMPOS[0].rotulo, doc.data, d.evento.data, d.motivos.data, bloqueios),
    compararCampo('horarioInicio', CAMPOS[1].rotulo, doc.horarioInicio, d.evento.horarioInicio, d.motivos.horarioInicio, bloqueios),
    compararCampo('horarioFim', CAMPOS[2].rotulo, doc.horarioFim, d.evento.horarioFim, d.motivos.horarioFim, bloqueios),
    compararCampo('convidados', CAMPOS[3].rotulo, doc.convidados, String(d.evento.convidados), d.motivos.convidados, bloqueios),
    compararCampo('valorContratado', CAMPOS[4].rotulo, doc.valorContratado, String(d.valorContratadoCentavos), d.motivos.valorContratado, bloqueios),
  ];

  const financeiro = avaliarFinanceiro(d.financeiro, d.valorContratadoCentavos, hoje, bloqueios, avisos);
  const ocupa = d.evento.data >= hoje;
  if (!ocupa) avisos.push('Evento passado: entra no Histórico de Festas e não ocupa a agenda.');

  return {
    bloqueios,
    avisos,
    resumo: {
      contrato: {
        cliente: r.cliente.nome,
        pacoteDocumento: s.pacote?.nome ?? null,
        pacoteReferencia: r.pacote ? `${r.pacote.nome} (${r.pacote.codigo})` : null,
        unidade: unidade?.nome ?? null,
        valorContratadoCentavos: d.valorContratadoCentavos,
        conferencia: 'Contrato assinado em papel, conferido por operador autorizado. Sem assinatura digital.',
      },
      festa: { data: d.evento.data, horarioInicio: d.evento.horarioInicio, horarioFim: d.evento.horarioFim, convidados: d.evento.convidados, aniversariante: s.evento?.aniversariante ?? null, tema: s.evento?.tema ?? null, aniversarianteCadastro: null },
      agenda: ocupa
        ? { ocupa: true, descricao: `Ocupa a agenda em ${dataBr(d.evento.data)}, das ${d.evento.horarioInicio} às ${d.evento.horarioFim}${unidade ? ` (${unidade.nome})` : ''}.` }
        : { ocupa: false, descricao: `Festa realizada em ${dataBr(d.evento.data)}: vai ao Histórico, sem ocupar agenda.` },
      financeiro,
      campos,
    },
  };
}

function canonico(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonico);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonico(x)]));
  return v;
}
export const hashCanonico = (v: unknown) => createHash('sha256').update(JSON.stringify(canonico(v)), 'utf8').digest('hex');

/** O que o operador confirma: decisões + resumo calculado pelo servidor. Mudou qualquer um ⇒ outra confirmação. */
export const hashResumo = (importacaoId: string, d: DecisoesIntegracao, resumo: ResumoIntegracao) => hashCanonico({ importacaoId, decisoes: d, resumo });

/** Snapshot da versão 1 (conferência em papel): forma do snapshot nativo + o contrato histórico intacto ao lado. */
export function montarSnapshotVersao(e: {
  nativo?: Record<string, unknown>;
  importacaoId: string; documento: { id: string; sha256: string };
  fechamentoId: string; snapshot: SnapshotHistorico; decisoes: DecisoesIntegracao; resumo: ResumoIntegracao;
  cliente: { id: string; nomeCompleto: string; cpf: string | null; telefone: string | null; whatsapp: string | null; email: string | null } & Partial<Record<keyof CadastroContratual, string | null>>;
  aniversarianteId: string | null;
  pacote: { id: string; codigo: string; nome: string; duracaoMinutos: number | null };
  unidade: { id: string; nome: string } | null;
  conferente: { usuarioId: string; papel: string };
}) {
  const { snapshot: s, decisoes: d } = e;
  const valor = centavosParaReais(d.valorContratadoCentavos);
  const adicionais = s.valores?.adicionais != null && s.valores.adicionais < d.valorContratadoCentavos ? s.valores.adicionais : 0;
  return {
    ...e.nativo,
    schemaVersao: 1,
    origem: { tipo: 'IMPORTACAO_HISTORICA', importacaoId: e.importacaoId, documentoOriginalId: e.documento.id, documentoSha256: e.documento.sha256, aceite: 'CONTRATO_ASSINADO_EM_PAPEL' },
    fechamento: { id: e.fechamentoId, status: 'CONFIRMADO', origem: 'IMPORTACAO_HISTORICA' },
    contratante: contratanteSnapshot({ ...formularioCadastro(e.cliente), id: e.cliente.id }),
    responsavelAdicional: null,
    aniversariante: { id: e.aniversarianteId, nome: d.aniversariante ?? s.evento?.aniversariante ?? null, dataNascimento: null, idadeNoEvento: s.evento?.idade ?? null, temaFesta: s.evento?.tema ?? null },
    evento: {
      data: d.evento.data, horarioInicio: d.evento.horarioInicio, horarioFim: d.evento.horarioFim,
      pacote: { id: e.pacote.id, codigo: e.pacote.codigo, nome: s.pacote?.nome ?? e.pacote.nome, duracaoMinutos: s.pacote?.duracaoMinutos ?? e.pacote.duracaoMinutos, referenciaSistema: { id: e.pacote.id, codigo: e.pacote.codigo, nome: e.pacote.nome } },
      convidados: d.evento.convidados, convidadosFaturados: d.evento.convidados,
      unidade: e.unidade,
    },
    contratacao: {
      ...(e.nativo?.contratacao as object ?? {}),
      adicionais: [], alteracoesPacote: s.pacote?.itens ?? null, observacoesCliente: s.observacoes ?? null, observacoesEquipe: (e.nativo?.contratacao as { observacoesEquipe?: string } | undefined)?.observacoesEquipe ?? null,
      itensPacote: s.pacote?.itens ?? null,
      buffet: { ...((e.nativo?.contratacao as { buffet?: object } | undefined)?.buffet ?? {}), status: s.buffet?.itens ? 'DEFINIDO' : 'PENDENTE', itens: s.buffet?.itens ?? null, observacoes: s.buffet?.observacoes ?? null, restricoes: s.buffet?.restricoes ?? null },
      observacoes: s.observacoes ?? null,
    },
    comercial: {
      ...(e.nativo?.comercial as object ?? {}),
      valorFinalContrato: valor,
      valorTabela: valor,
      valorPacoteAplicado: centavosParaReais(d.valorContratadoCentavos - adicionais),
      valorAdicionais: centavosParaReais(adicionais),
      formaPagamentoPretendida: d.formaPagamento ?? null,
      condicaoDocumento: s.pagamentosPrevistos?.condicao ?? null,
    },
    historico: {
      contratoHistorico: s,
      campos: e.resumo.campos,
      situacaoContrato: d.situacaoContrato,
      conferencia: { usuarioId: e.conferente.usuarioId, papel: e.conferente.papel, declaracao: DECLARACAO_CONFERENCIA },
    },
  };
}
