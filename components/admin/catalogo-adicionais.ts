/**
 * Formulário "Vender como adicional" de Configurações › Itens do Buffet — partes puras (testáveis sem React).
 * O pedido só leva o que mudou: preço (undefined = não mexe) e os pacotes alterados.
 */
export type Modalidade = 'INCLUSO' | 'EXTRA' | 'INDISPONIVEL';
export type Unidade = 'UNIDADE' | 'CENTO' | 'CONVIDADO' | 'PACOTE' | 'VALOR_FIXO' | 'HORA' | 'METRO';

export type AdicionalAdmin = {
  id: string;
  codigo: string;
  nome: string;
  categoria: string;
  unidadeCobranca: string;
  ativo: boolean;
  origem: { tipo: 'ITEM' | 'CATEGORIA'; id: string } | null;
  escolhasMax: number | null;
  preco: string | null;
  faixasPreco: number;
  faixas?: Array<{ min: number; max: number | null; valor: number; rotulo: string | null }>;
  pacotes: Record<string, Modalidade>;
};

export type FaixaForm = { min: string; max: string; rotulo: string; valor: string };

export type AdicionaisAdmin = {
  migracaoPendente: boolean;
  tabelaCorrente: boolean;
  aviso: string | null;
  categorias: Array<{ codigo: string; nome: string }>;
  pacotes: Array<{ id: string; codigo: string; nome: string }>;
  adicionais: AdicionalAdmin[];
};

export const UNIDADES: ReadonlyArray<{ valor: Unidade; rotulo: string }> = [
  { valor: 'UNIDADE', rotulo: 'Por unidade' },
  { valor: 'CENTO', rotulo: 'Por cento' },
  { valor: 'CONVIDADO', rotulo: 'Por convidado' },
  { valor: 'PACOTE', rotulo: 'Valor fechado' },
  { valor: 'VALOR_FIXO', rotulo: 'Valor fixo' },
  { valor: 'HORA', rotulo: 'Por hora' },
  { valor: 'METRO', rotulo: 'Por metro' },
];

export type FormularioAdicional = {
  id?: string;
  origem?: { tipo: 'ITEM' | 'CATEGORIA'; id: string; nome: string };
  ativo: boolean;
  nome: string;
  categoria: string;
  unidadeCobranca: Unidade;
  preco: string;
  precoInicial: string;
  modo: 'UNICO' | 'FAIXAS';
  faixas: FaixaForm[];
  faixasIniciais: string;
  escolhasMax: string;
  faixasPreco: number;
  pacotes: Record<string, Modalidade>;
  pacotesIniciais: Record<string, Modalidade>;
};

const moeda = (valor: number) => valor.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "350.00" → "350,00"; null → "". */
export function precoParaCampo(preco: string | null): string {
  return preco === null ? '' : moeda(Number(preco));
}

/** Aceita "1.234,56", "1234,5", "1234.56" e "80". Vazio = sem preço (null). Inválido = undefined. */
export function precoDoCampo(texto: string): string | null | undefined {
  const limpo = texto.trim().replace(/^R\$\s*/i, '').replace(/\s/g, '');
  if (!limpo) return null;
  const decimal = limpo.includes(',') ? limpo.replace(/\./g, '').replace(',', '.') : limpo;
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(decimal)) return undefined;
  return Number(decimal).toFixed(2);
}

export function formularioAdicional(
  adicional: AdicionalAdmin | null,
  origem: { tipo: 'ITEM' | 'CATEGORIA'; id: string; nome: string } | null,
  dados: Pick<AdicionaisAdmin, 'pacotes'>,
): FormularioAdicional {
  const pacotes = Object.fromEntries(dados.pacotes.map((p) => [p.id, adicional?.pacotes[p.id] ?? 'INDISPONIVEL'])) as Record<string, Modalidade>;
  const preco = precoParaCampo(adicional?.preco ?? null);
  const faixas: FaixaForm[] = (adicional?.faixas ?? []).map((f) => ({ min: String(f.min), max: f.max == null ? '' : String(f.max), rotulo: f.rotulo ?? '', valor: precoParaCampo(f.valor.toFixed(2)) }));
  const unidadePadrao: Unidade = origem?.tipo === 'CATEGORIA' ? 'CENTO' : origem?.tipo === 'ITEM' ? 'UNIDADE' : 'PACOTE';
  return {
    ...(adicional && !origem ? { id: adicional.id } : {}),
    ...(origem ? { origem } : {}),
    ativo: adicional?.ativo ?? true,
    nome: adicional?.nome ?? (origem ? `${origem.nome} extra` : ''),
    categoria: origem ? 'BUFFET' : adicional?.categoria ?? 'EXTRA',
    unidadeCobranca: (UNIDADES.some((u) => u.valor === adicional?.unidadeCobranca) ? adicional!.unidadeCobranca : unidadePadrao) as Unidade,
    preco,
    precoInicial: preco,
    modo: faixas.length > 1 ? 'FAIXAS' : 'UNICO',
    faixas: faixas.length > 1 ? faixas : [{ min: '1', max: '', rotulo: '', valor: '' }],
    faixasIniciais: JSON.stringify(faixas.length > 1 ? faixas : [{ min: '1', max: '', rotulo: '', valor: '' }]),
    escolhasMax: adicional?.escolhasMax ? String(adicional.escolhasMax) : '',
    faixasPreco: adicional?.faixasPreco ?? 0,
    pacotes,
    pacotesIniciais: { ...pacotes },
  };
}

/** Corpo do PATCH, ou a mensagem do primeiro problema do formulário. */
export function pedidoAdicional(form: FormularioAdicional): Record<string, unknown> | string {
  const nome = form.nome.trim();
  if (!nome) return 'Informe o nome do adicional.';
  const preco = precoDoCampo(form.preco);
  if (preco === undefined) return 'Informe um preço válido (ex.: 80,00) ou deixe em branco.';
  let escolhasMax: number | null = null;
  if (form.origem?.tipo === 'CATEGORIA' && form.escolhasMax.trim()) {
    escolhasMax = Number(form.escolhasMax);
    if (!Number.isInteger(escolhasMax) || escolhasMax < 1 || escolhasMax > 30) return 'O máximo de opções vai de 1 a 30.';
  }
  let faixas: Array<{ min: number; max: number | null; valor: number; rotulo: string | null }> | undefined;
  if (form.modo === 'FAIXAS' && JSON.stringify(form.faixas) !== form.faixasIniciais) {
    faixas = [];
    for (const f of form.faixas) {
      const min = Number(f.min);
      const max = f.max.trim() ? Number(f.max) : null;
      const valor = precoDoCampo(f.valor);
      if (!Number.isInteger(min) || min < 1 || (max !== null && (!Number.isInteger(max) || max < min))) return 'Confira o "De" e o "Até" de cada faixa.';
      if (valor === undefined || valor === null) return 'Informe o preço de cada faixa.';
      faixas.push({ min, max, valor: Number(valor), rotulo: f.rotulo.trim() || null });
    }
    faixas.sort((a, b) => a.min - b.min);
    for (let i = 1; i < faixas.length; i++) {
      const anterior = faixas[i - 1].max;
      if (anterior === null || faixas[i].min !== anterior + 1) return 'As faixas precisam ser contínuas (o "De" de uma é o "Até" da anterior + 1).';
    }
  }
  const mudouPreco = form.modo === 'UNICO' && preco !== precoDoCampo(form.precoInicial);
  const pacotes = Object.fromEntries(Object.entries(form.pacotes).filter(([id, m]) => form.pacotesIniciais[id] !== m));
  return {
    ...(form.id ? { id: form.id } : {}),
    ...(form.origem ? { origem: { tipo: form.origem.tipo, id: form.origem.id } } : {}),
    nome,
    categoria: form.categoria,
    unidadeCobranca: form.unidadeCobranca,
    ativo: form.ativo,
    ...(form.origem?.tipo === 'CATEGORIA' ? { escolhasMax } : {}),
    ...(mudouPreco ? { preco } : {}),
    ...(faixas ? { faixas } : {}),
    ...(Object.keys(pacotes).length ? { pacotes } : {}),
  };
}

/** Resumo da coluna "Adicional": preço e unidade, faixas ou sem preço. */
export function precoNaLista(adicional: Pick<AdicionalAdmin, 'preco' | 'faixasPreco' | 'unidadeCobranca' | 'faixas'>): string {
  if (adicional.faixas && adicional.faixas.length > 1) {
    const valores = adicional.faixas.map((f) => f.valor);
    return `R$ ${moeda(Math.min(...valores))} a R$ ${moeda(Math.max(...valores))} (${adicional.faixas.length} faixas)`;
  }
  if (adicional.preco !== null) {
    const unidade = UNIDADES.find((u) => u.valor === adicional.unidadeCobranca);
    const sufixo = unidade && !['PACOTE', 'VALOR_FIXO'].includes(unidade.valor) ? ` ${unidade.rotulo.toLocaleLowerCase('pt-BR')}` : '';
    return `R$ ${moeda(Number(adicional.preco))}${sufixo}`;
  }
  return adicional.faixasPreco > 1 ? 'Preço por faixa' : 'Sem preço';
}
