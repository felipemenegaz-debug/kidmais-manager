/**
 * D3/D4 do plano de descontos (18/11/2026): desconto por dia da semana do buffet.
 *
 * Módulo PURO (sem banco): usado pela tela de Configurações, pela API pública e pelo calendário do cliente.
 *
 *   - Dia da semana no padrão ISO do PostgreSQL (`EXTRACT(ISODOW)`): 1 = segunda … 7 = domingo.
 *   - A regra do buffet vira linhas em `regras_desconto_pacote` com o código `CODIGO_DESCONTO_DIA` e sem horário
 *     (`configuracao_agenda_id` nulo = vale para todos os horários). É a tabela que a cotação do servidor já aplica.
 *   - A escolha de qual regra vale numa data repete a do servidor (`listarDescontosPacoteAplicaveis` + `selecionarDesconto`):
 *     regra do horário antes da genérica, depois a menor prioridade, depois o início de vigência mais recente.
 */
export const CODIGO_DESCONTO_DIA = "DIA_SEMANA_BUFFET";
export const TETO_DESCONTO_DIA = 50;
/** Regra de segunda a quinta da Kidmais (migration 006). */
export const CODIGO_DESCONTO_DIA_UTIL_KIDMAIS = "DIA_UTIL_15";

export type OrigemDesconto = "empresa" | "personalizado" | "dia_util" | "nenhum";

/**
 * Origem do desconto que a COTAÇÃO do servidor aplicou, pelo código da regra (Astra r2, P2): o pedido de fechamento
 * deriva `origemDesconto` e `descontoDiaUtilAtivo` daqui, e não do calendário lido antes.
 */
/** Percentual para a tela, com até 2 casas (16,15 em vez de 16). Recebe pontos percentuais (16.15 = 16,15%). */
export function textoPercentual(pontos: number): string {
  return (Math.round(pontos * 100) / 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 });
}

export function origemDoDescontoCotado(codigo: string | null | undefined, valor: number): OrigemDesconto {
  if (!(valor > 0)) return "nenhum";
  if (codigo === CODIGO_DESCONTO_DIA) return "empresa";
  if (codigo === CODIGO_DESCONTO_DIA_UTIL_KIDMAIS) return "dia_util";
  return "personalizado";
}

const NOMES = ["", "segunda", "terça", "quarta", "quinta", "sexta", "sábado", "domingo"] as const;
export const DIAS_SEMANA_ISO = [1, 2, 3, 4, 5, 6, 7] as const;
export const NOME_CURTO_DIA = ["", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"] as const;

/** Regra de desconto de um pacote como a API pública devolve (uma linha de `regras_desconto_pacote`). */
export type RegraDescontoDiaPublica = {
  dia: number;
  /** Em pontos percentuais (10 = 10%). */
  percentual: number;
  titulo: string | null;
  vigenciaInicio: string;
  vigenciaFim: string | null;
  /** null = vale para todos os horários. */
  configuracaoId: string | null;
  prioridade: number;
};

/** Descontos por dia da empresa, por código do pacote (o id que a tela pública usa em /b/<código>). */
export type DescontosEmpresaPublicos = Record<string, RegraDescontoDiaPublica[]>;

/**
 * Desconto sobre o valor do pacote, em centavos inteiros (meio centavo arredonda para cima no desconto).
 * Mesma rotina na cotação do servidor e na revisão de festa fechada: 50% de R$ 20,15 = R$ 10,08 de desconto e
 * R$ 10,07 de pacote (em ponto flutuante dava R$ 10,07 de desconto).
 * O percentual pode ter 2 casas: vira pontos-base inteiros antes da conta (16,15% de R$ 10,00 = R$ 1,62; com
 * 16.15 em ponto flutuante o produto dava 161,4999… e arredondava para R$ 1,61). Um único arredondamento no fim.
 */
export function descontoSobreBase(base: number, percentual: number): { valor: number; aplicado: number } {
  const baseCentavos = Math.round(base * 100);
  const pontosBase = Math.round(percentual * 100);
  const valorCentavos = Math.round((baseCentavos * pontosBase) / 10000);
  return { valor: valorCentavos / 100, aplicado: (baseCentavos - valorCentavos) / 100 };
}

/** Dia ISO (1 = segunda … 7 = domingo) de uma data AAAA-MM-DD, sem fuso. */
export function diaSemanaIso(dataIso: string): number {
  const [ano, mes, dia] = dataIso.split("-").map(Number);
  const d = new Date(Date.UTC(ano!, mes! - 1, dia!)).getUTCDay();
  return d === 0 ? 7 : d;
}

/** "de segunda a quinta", "segunda, quarta e sexta", "todos os dias", "sábado". */
export function rotuloDias(dias: readonly number[]): string {
  const lista = [...new Set(dias)].filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b);
  if (lista.length === 0) return "";
  if (lista.length === 7) return "todos os dias";
  const consecutivos = lista.every((d, i) => i === 0 || d === lista[i - 1]! + 1);
  if (consecutivos && lista.length >= 3) return `de ${NOMES[lista[0]!]} a ${NOMES[lista[lista.length - 1]!]}`;
  const nomes = lista.map((d) => NOMES[d]!);
  return nomes.length === 1 ? nomes[0]! : `${nomes.slice(0, -1).join(", ")} e ${nomes[nomes.length - 1]}`;
}

/** Título gravado na regra e mostrado ao cliente: "10% de desconto de segunda a quinta". */
export function tituloDescontoDia(percentual: number, dias: readonly number[]): string {
  return `${percentual}% de desconto ${rotuloDias(dias)}`.replace(/\s+$/, "");
}

/** Mesma escolha do servidor para a data e o horário (configuração da agenda). Nenhuma = null. */
export function regraDoDia(regras: readonly RegraDescontoDiaPublica[], dataIso: string, configuracaoId: string | null | undefined): RegraDescontoDiaPublica | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dataIso)) return null;
  const dia = diaSemanaIso(dataIso);
  const candidatas = regras.filter((r) =>
    r.dia === dia
    && (r.configuracaoId === null || (!!configuracaoId && r.configuracaoId === configuracaoId))
    && r.vigenciaInicio <= dataIso
    && (r.vigenciaFim === null || r.vigenciaFim >= dataIso));
  candidatas.sort((a, b) => {
    const especifica = (r: RegraDescontoDiaPublica) => (configuracaoId && r.configuracaoId === configuracaoId ? 0 : 1);
    return especifica(a) - especifica(b) || a.prioridade - b.prioridade || (a.vigenciaInicio < b.vigenciaInicio ? 1 : a.vigenciaInicio > b.vigenciaInicio ? -1 : 0);
  });
  return candidatas[0] ?? null;
}

/**
 * Frase do aviso "Economize": parte das regras que ainda podem valer para alguma festa de hoje em diante (existe uma
 * data com aquele dia da semana dentro da vigência; uma regra de segunda que acaba numa quinta-feira, sem segunda
 * pela frente, não anuncia nada). Mesmo percentual em todos os dias →
 * "Economize 10% escolhendo de segunda a quinta."; percentuais diferentes → "Economize até 15% em alguns dias da semana.".
 */
/** Existe data >= hoje, dentro da vigência, que cai no dia da semana da regra. */
export function aindaPodeValer(r: Pick<RegraDescontoDiaPublica, "dia" | "vigenciaInicio" | "vigenciaFim">, hojeIso: string): boolean {
  const desde = r.vigenciaInicio > hojeIso ? r.vigenciaInicio : hojeIso;
  if (r.vigenciaFim === null) return true;
  if (r.vigenciaFim < desde) return false;
  const espera = (r.dia - diaSemanaIso(desde) + 7) % 7;
  const primeira = new Date(Date.parse(`${desde}T00:00:00Z`) + espera * 86_400_000).toISOString().slice(0, 10);
  return primeira <= r.vigenciaFim;
}

export function avisoEconomize(regras: readonly RegraDescontoDiaPublica[], hojeIso: string): string | null {
  const validas = regras.filter((r) => r.percentual > 0 && aindaPodeValer(r, hojeIso));
  if (validas.length === 0) return null;
  const percentuais = [...new Set(validas.map((r) => r.percentual))];
  if (percentuais.length === 1) return `Economize ${percentuais[0]}% escolhendo ${rotuloDias(validas.map((r) => r.dia))}.`;
  return `Economize até ${Math.max(...percentuais)}% em alguns dias da semana.`;
}

/** Converte a linha do banco (numeric/date em texto) para o formato público. */
export function regraPublicaDaLinha(l: { dia_semana: number | string; percentual: number | string; titulo: string | null; vigencia_inicio: string; vigencia_fim: string | null; configuracao_agenda_id: string | null; prioridade: number | string }): RegraDescontoDiaPublica {
  return {
    dia: Number(l.dia_semana),
    percentual: Number(l.percentual),
    titulo: l.titulo,
    vigenciaInicio: l.vigencia_inicio,
    vigenciaFim: l.vigencia_fim,
    configuracaoId: l.configuracao_agenda_id,
    prioridade: Number(l.prioridade),
  };
}
