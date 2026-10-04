/**
 * Formulário do assistente "Integrar ao sistema" — regras puras do lado da tela (sem rede, sem React).
 *
 * O servidor é a autoridade (revalida tudo e devolve o resumo); aqui só se evita enviar o óbvio incompleto e se
 * converte o que o operador digitou. Nada é presumido: situação do contrato e dos pagamentos começam em branco e
 * nenhuma parcela vem marcada como recebida, mesmo quando o documento fala em "à vista", "entrada" ou "30%".
 */
export const FORMAS_ROTULO = {
  PIX: 'Pix', CARTAO_CREDITO: 'Cartão de crédito', CARTAO_DEBITO: 'Cartão de débito', BOLETO: 'Boleto',
  DINHEIRO: 'Dinheiro', TRANSFERENCIA: 'Transferência', OUTRO: 'Outro',
} as const;
export type Forma = keyof typeof FORMAS_ROTULO;

export const SITUACAO_CONTRATO_ROTULO = {
  VIGENTE: 'Vigente — assinado e em vigor',
  CANCELADO: 'Cancelado',
  NAO_COMPROVADA: 'Não consigo confirmar',
} as const;
export const SITUACAO_FINANCEIRA_ROTULO = {
  NAO_PAGO: 'Nada foi pago ainda',
  PARCIALMENTE_PAGO: 'Parte foi paga',
  PAGO: 'Foi pago integralmente',
  NAO_CONFERIDO: 'Ainda não conferi os pagamentos',
} as const;

export type CampoDoc = 'data' | 'horarioInicio' | 'horarioFim' | 'convidados' | 'valorContratado';
/** `aposFestaConfirmada`: exceção histórica — o operador confirma que a parcela vence depois da festa conforme o contrato. */
export type ParcelaForm = { chave: string; valor: string; vencimento: string; recebida: boolean; recebidaEm: string; forma: Forma | ''; aposFestaConfirmada: boolean };
export type FormIntegracao = {
  situacaoContrato: keyof typeof SITUACAO_CONTRATO_ROTULO | '';
  estabelecimentoId: string;
  pacoteReferenciaId: string;
  data: string; horarioInicio: string; horarioFim: string; convidados: string;
  valorContratado: string;
  motivos: Partial<Record<CampoDoc, string>>;
  situacaoFinanceira: keyof typeof SITUACAO_FINANCEIRA_ROTULO | '';
  parcelas: ParcelaForm[];
  outroContratoConfirmado: boolean;
  /** Motivo da decisão "É outro contrato" (auditado; exigido quando há contratação parecida). */
  motivoOutroContrato: string;
  conferenciaDeclarada: boolean;
};

export type Sugestao = {
  evento: { data: string | null; horarioInicio: string | null; horarioFim: string | null; convidados: number | null };
  valorContratadoCentavos: number | null;
  condicaoDocumento: string | null;
  parcelasPrevistas: Array<{ valorCentavos: number; vencimento: string | null }>;
};

/** "8.500,00", "R$ 8.500", "8500,5" → centavos. Ponto como decimal ("8500.00") é ambíguo e é recusado. */
export function centavosDeTexto(texto: string): number | null {
  const t = texto.replace(/^\s*r\$\s*/i, '').replace(/\s/g, '');
  if (!t) return null;
  if (!/^\d{1,3}(\.\d{3})*(,\d{1,2})?$/.test(t) && !/^\d+(,\d{1,2})?$/.test(t)) return null;
  const [inteiro, frac = ''] = t.split(',');
  const c = Number(inteiro.replace(/\./g, '')) * 100 + Number(frac.padEnd(2, '0'));
  return Number.isSafeInteger(c) && c > 0 ? c : null;
}

export const textoDeCentavos = (c: number) => `${Math.floor(c / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${String(c % 100).padStart(2, '0')}`;
export const reais = (c: number) => `R$ ${textoDeCentavos(c)}`;
export const dataBr = (iso: string) => /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : iso;

let seq = 0;
export const novaParcela = (p: Partial<ParcelaForm> = {}): ParcelaForm => ({ chave: `p${++seq}`, valor: '', vencimento: '', recebida: false, recebidaEm: '', forma: '', aposFestaConfirmada: false, ...p });

export function formInicial(o: { sugestao: Sugestao; estabelecimentos: Array<{ id: string }> }): FormIntegracao {
  const s = o.sugestao;
  return {
    situacaoContrato: '',
    estabelecimentoId: o.estabelecimentos.length === 1 ? o.estabelecimentos[0].id : '',
    pacoteReferenciaId: '',
    data: s.evento.data ?? '', horarioInicio: s.evento.horarioInicio ?? '', horarioFim: s.evento.horarioFim ?? '',
    convidados: s.evento.convidados != null ? String(s.evento.convidados) : '',
    valorContratado: s.valorContratadoCentavos != null ? textoDeCentavos(s.valorContratadoCentavos) : '',
    motivos: {},
    situacaoFinanceira: '',
    // Parcelas previstas no documento: ponto de partida, nunca marcadas como recebidas.
    parcelas: s.parcelasPrevistas.map((p) => novaParcela({ valor: textoDeCentavos(p.valorCentavos), vencimento: p.vencimento ?? '' })),
    outroContratoConfirmado: false,
    motivoOutroContrato: '',
    conferenciaDeclarada: false,
  };
}

/** Campos que diferem do que foi lido no documento: exigem motivo (correção de leitura). Ausente no documento = complemento. */
export function camposCorrigidos(f: FormIntegracao, s: Sugestao): CampoDoc[] {
  const doc: Record<CampoDoc, string | null> = {
    data: s.evento.data, horarioInicio: s.evento.horarioInicio, horarioFim: s.evento.horarioFim,
    convidados: s.evento.convidados != null ? String(s.evento.convidados) : null,
    valorContratado: s.valorContratadoCentavos != null ? String(s.valorContratadoCentavos) : null,
  };
  const atual: Record<CampoDoc, string | null> = {
    data: f.data, horarioInicio: f.horarioInicio, horarioFim: f.horarioFim, convidados: f.convidados.trim() || null,
    valorContratado: centavosDeTexto(f.valorContratado)?.toString() ?? null,
  };
  return (Object.keys(doc) as CampoDoc[]).filter((k) => doc[k] !== null && atual[k] !== null && doc[k] !== atual[k]);
}

export function errosFesta(f: FormIntegracao, s: Sugestao, unidades: number): string[] {
  const e: string[] = [];
  if (!f.situacaoContrato) e.push('Informe a situação do contrato.');
  if (unidades > 0 && !f.estabelecimentoId) e.push('Escolha a unidade.');
  if (!f.pacoteReferenciaId) e.push('Escolha o pacote do sistema usado como referência.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.data)) e.push('Informe a data da festa.');
  if (!/^\d{2}:\d{2}$/.test(f.horarioInicio) || !/^\d{2}:\d{2}$/.test(f.horarioFim)) e.push('Informe início e término.');
  else if (f.horarioFim <= f.horarioInicio) e.push('O término deve ser depois do início.');
  if (!/^\d{1,4}$/.test(f.convidados.trim()) || Number(f.convidados) < 1) e.push('Informe o número de convidados.');
  for (const c of camposCorrigidos(f, s).filter((c) => c !== 'valorContratado')) {
    if ((f.motivos[c]?.trim().length ?? 0) < 5) e.push('Explique cada valor diferente do documento (correção de leitura).');
  }
  return [...new Set(e)];
}

export function errosPagamentos(f: FormIntegracao, s: Sugestao, hoje: string): string[] {
  const e: string[] = [];
  const total = centavosDeTexto(f.valorContratado);
  if (!total) e.push('Informe o valor contratado (ex.: 8.500,00).');
  if (camposCorrigidos(f, s).includes('valorContratado') && (f.motivos.valorContratado?.trim().length ?? 0) < 5) e.push('Explique a diferença do valor contratado em relação ao documento.');
  if (!f.situacaoFinanceira) e.push('Informe a situação dos pagamentos.');
  if (f.situacaoFinanceira && f.situacaoFinanceira !== 'NAO_CONFERIDO') {
    if (!f.parcelas.length) e.push('Inclua ao menos uma parcela.');
    let soma = 0;
    f.parcelas.forEach((p, i) => {
      const v = centavosDeTexto(p.valor);
      if (!v) e.push(`Parcela ${i + 1}: valor inválido.`); else soma += v;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(p.vencimento)) e.push(`Parcela ${i + 1}: informe o vencimento.`);
      if (p.recebida) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(p.recebidaEm)) e.push(`Parcela ${i + 1}: informe a data em que foi recebida.`);
        else if (p.recebidaEm > hoje) e.push(`Parcela ${i + 1}: a data de recebimento não pode ser futura.`);
        if (!p.forma) e.push(`Parcela ${i + 1}: informe a forma de pagamento.`);
      }
    });
    if (total && soma && soma !== total) e.push(`As parcelas somam ${reais(soma)}; o contratado é ${reais(total)}.`);
  }
  return e;
}

/** Saldo e situação que as parcelas marcadas indicam (o servidor confere de novo, em centavos). */
export function conferenciaParcelas(f: FormIntegracao) {
  const total = centavosDeTexto(f.valorContratado) ?? 0;
  let recebido = 0, soma = 0;
  for (const p of f.parcelas) { const v = centavosDeTexto(p.valor) ?? 0; soma += v; if (p.recebida) recebido += v; }
  const indicada = recebido === 0 ? 'NAO_PAGO' : recebido >= total ? 'PAGO' : 'PARCIALMENTE_PAGO';
  return { total, soma, recebido, saldo: Math.max(total - recebido, 0), indicada: indicada as 'NAO_PAGO' | 'PARCIALMENTE_PAGO' | 'PAGO' };
}

function financeiroDoForm(f: FormIntegracao) {
  if (f.situacaoFinanceira === 'NAO_CONFERIDO') return { situacao: 'NAO_CONFERIDO' as const };
  return {
    situacao: f.situacaoFinanceira as 'NAO_PAGO' | 'PARCIALMENTE_PAGO' | 'PAGO',
    parcelas: f.parcelas.map((p) => ({
      valorCentavos: centavosDeTexto(p.valor) ?? 0,
      vencimento: p.vencimento,
      recebimento: p.recebida ? { data: p.recebidaEm, forma: p.forma as Forma } : null,
      // Só vale para parcela que vence depois da festa; nunca muda o vencimento.
      ...(p.aposFestaConfirmada && !!f.data && p.vencimento > f.data ? { aposFestaConfirmada: true } : {}),
    })),
  };
}

/** Payload exato de `decisoes` (o servidor recusa campo extra). Empresa e usuário nunca vão no corpo. */
export function decisoesDoForm(f: FormIntegracao, s: Sugestao) {
  const corrigidos = new Set(camposCorrigidos(f, s));
  const motivos = Object.fromEntries(Object.entries(f.motivos).filter(([k, v]) => corrigidos.has(k as CampoDoc) && v?.trim()).map(([k, v]) => [k, v!.trim()]));
  return {
    situacaoContrato: f.situacaoContrato,
    estabelecimentoId: f.estabelecimentoId || null,
    pacoteReferenciaId: f.pacoteReferenciaId || null,
    evento: { data: f.data, horarioInicio: f.horarioInicio, horarioFim: f.horarioFim, convidados: Number(f.convidados) },
    valorContratadoCentavos: centavosDeTexto(f.valorContratado) ?? 0,
    motivos,
    financeiro: financeiroDoForm(f),
    outroContratoConfirmado: f.outroContratoConfirmado,
    motivoOutroContrato: f.outroContratoConfirmado ? f.motivoOutroContrato.trim() : '',
    conferenciaDeclarada: f.conferenciaDeclarada,
  };
}

export const financeiroDoFormulario = financeiroDoForm;
