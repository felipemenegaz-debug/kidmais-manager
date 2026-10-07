/**
 * Importação da tabela de preços — partes puras da tela (testáveis sem React).
 */
export type Faixa = { min: number; max: number | null; valor: number; rotulo: string | null };
export type Grade = { categoria: 'PADRAO' | 'NOBRE' | 'GERAL'; faixas: Faixa[] };
export type RevPacote = {
  chave: string; nomePdf: string; pagina: number | null; pacoteId: string | null; convidadosMin: number | null; convidadosMax: number | null;
  cobranca: 'FAIXAS' | 'POR_CONVIDADO' | 'SOB_CONSULTA'; grades: Grade[]; porConvidado: number | null; aPartirDe: number | null;
  descricao: string | null; selo: string | null; duracao: string | null; aplicarDescricao: boolean;
  inclusos: Array<{ texto: string; adicionalId: string | null }>; aplicarInclusos: boolean;
  atual: { descricao: string | null; grades: Grade[] } | null; pendencias: string[]; confirmado: boolean;
};
export type RevAdicional = {
  chave: string; nomePdf: string; pagina: number | null;
  destino: { tipo: 'EXISTENTE'; adicionalId: string } | { tipo: 'NOVO'; nome: string } | { tipo: 'IGNORAR' };
  categoria: string; unidade: 'PACOTE' | 'UNIDADE' | 'CENTO' | 'CONVIDADO' | 'HORA'; faixas: Faixa[]; atual: Faixa[] | null; pendencias: string[]; confirmado: boolean;
};
export type Revisao = {
  esquema: 1; pacotes: RevPacote[]; adicionais: RevAdicional[]; comuns: string[];
  horarios: Array<{ horario: 'PROMOCIONAL' | 'NOBRE'; descricao: string }>; informacoes: string[];
  naoImportavel: Array<{ texto: string; pagina: number | null; motivo: string }>; conferencias: Array<{ ok: boolean; texto: string }>;
};
export type Importacao = {
  id: string; situacao: string; arquivoNome: string; versao: number; modelo: string | null; avisos: string[];
  revisao: Revisao | null; resultado: { passos?: Array<{ passo: string; ok: boolean; erro?: string }> } | null; criadoEm: string;
};

export const moeda = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 2 });

export const NOME_CATEGORIA: Record<Grade['categoria'], string> = { PADRAO: 'Promocional', NOBRE: 'Nobre', GERAL: 'Todos os horários' };
export const NOME_UNIDADE: Record<RevAdicional['unidade'], string> = { PACOTE: 'Valor fechado', UNIDADE: 'Por unidade', CENTO: 'Por cento', CONVIDADO: 'Por convidado', HORA: 'Por hora' };

export function faixaTexto(f: Pick<Faixa, 'min' | 'max'>) {
  if (f.max == null) return f.min <= 1 ? 'qualquer quantidade' : `a partir de ${f.min}`;
  if (f.min === f.max) return `${f.min}`;
  return f.min <= 1 ? `até ${f.max}` : `${f.min} a ${f.max}`;
}

/** "1.234,56" | "1234.56" | "80" → número; inválido → null. */
export function lerValor(texto: string): number | null {
  const limpo = texto.trim().replace(/^R\$\s*/i, '').replace(/\s/g, '');
  if (!limpo) return null;
  const decimal = limpo.includes(',') ? limpo.replace(/\./g, '').replace(',', '.') : limpo;
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(decimal)) return null;
  return Number(decimal);
}

const AVISOS: Record<string, string> = {
  ENVIO_EXTERNO_NAO_AUTORIZADO: 'A leitura por IA está desligada neste ambiente (AI_DOCUMENT_EXTERNAL_PROVIDER_ALLOWED). Peça para ligar e tente ler de novo.',
  SEM_MODELO_COM_VISAO: 'Nenhum modelo de IA com leitura de PDF está configurado (OpenAI). Peça a configuração e tente ler de novo.',
  MODELO_SEM_CHAVE: 'A chave do provedor de IA não está configurada.',
  MODELO_SEM_MODELO: 'Nenhum modelo de IA configurado para leitura de documentos.',
  MODELO_TIMEOUT: 'A leitura demorou demais. Tente ler de novo.',
  MODELO_ORCAMENTO: 'O limite de uso de IA da empresa foi atingido.',
  MODELO_RESPOSTA_INVALIDA: 'A IA devolveu uma leitura fora do formato. Tente ler de novo.',
};

export function mensagemAviso(codigo: string) {
  return AVISOS[codigo] ?? (codigo.startsWith('MODELO_') ? `A leitura por IA falhou (${codigo.slice(7)}). Tente ler de novo.` : codigo);
}

export function contarPendencias(r: Revisao) {
  const pacotes = r.pacotes.filter((p) => p.pacoteId && !p.confirmado).length;
  const adicionais = r.adicionais.filter((a) => a.destino.tipo !== 'IGNORAR' && !a.confirmado).length;
  return { pacotes, adicionais, total: pacotes + adicionais };
}

export function resumoPublicacao(r: Revisao) {
  const pacotes = r.pacotes.filter((p) => p.pacoteId && p.confirmado);
  const adicionais = r.adicionais.filter((a) => a.destino.tipo !== 'IGNORAR' && a.confirmado);
  return {
    pacotes: pacotes.length,
    precosPacote: pacotes.reduce((t, p) => t + (p.cobranca === 'POR_CONVIDADO' ? 1 : p.grades.reduce((g, x) => g + x.faixas.length, 0)), 0),
    adicionais: adicionais.length,
    adicionaisNovos: adicionais.filter((a) => a.destino.tipo === 'NOVO').length,
    descricoes: pacotes.filter((p) => p.aplicarDescricao).length,
    inclusos: pacotes.filter((p) => p.aplicarInclusos).reduce((t, p) => t + p.inclusos.filter((i) => i.adicionalId).length, 0),
  };
}
