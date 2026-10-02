import type { ExtracaoContrato } from '../../../lib/importacao-contrato/modelo.ts';
import type { RascunhoPublico } from '../inteligencia/cliente-inteligencia.ts';

/**
 * Cliente da importação real. Envia o arquivo (multipart) e ações de revisão; nunca envia empresa,
 * usuário, payload do plano ou decisão de gravação: a gravação é o clique no Human Gate (/operacoes).
 */
export const ENDPOINT_DOCUMENTOS = '/api/admin/inteligencia/documentos';
export const ENDPOINT_IMPORTACOES = '/api/admin/inteligencia/importacoes';

export type EstadoMatch = 'CLIENTE_EXISTENTE' | 'POSSIVEL_MATCH' | 'NOVO_CLIENTE' | 'PRECISA_REVISAO';
export type DecisaoCliente = { tipo: 'VINCULAR'; clienteId: string } | { tipo: 'CRIAR' } | null;
export type ImportacaoPublica = {
  id: string;
  documentoId?: string;
  versao: number;
  status: 'EM_REVISAO' | 'IMPORTADA' | 'DESCARTADA';
  extracao: ExtracaoContrato;
  revisados: string[];
  decisaoCliente: DecisaoCliente;
};
export type PlanoPublico = {
  pronto: boolean;
  bloqueios: string[];
  avisos: string[];
  match: { estado: EstadoMatch; clienteId: string | null; candidatos: Array<{ clienteId: string; nome: string; motivos: string[] }>; motivo: string };
};
export type RespostaImportacao = { importacao: ImportacaoPublica; plano?: PlanoPublico | null; gate?: { tipo: string; rascunho?: RascunhoPublico } | null; metodo?: string | null; avisos?: string[] };

export type Resultado<T> = { ok: true; dados: T } | { ok: false; mensagem: string; codigo: string | null };
type Buscador = (url: string, init: RequestInit) => Promise<Response>;

export const MENSAGEM_ERRO = 'Não foi possível concluir agora. Nenhum cadastro foi alterado; tente de novo.';

function pareceImportacao(d: unknown): d is RespostaImportacao {
  const x = d as { importacao?: Partial<ImportacaoPublica> } | null;
  return !!x?.importacao && typeof x.importacao.id === 'string' && typeof x.importacao.versao === 'number' && Array.isArray(x.importacao.extracao?.secoes) && Array.isArray(x.importacao.revisados);
}

async function ler<T>(resposta: Promise<Response>, valido: (d: unknown) => d is T): Promise<Resultado<T>> {
  try {
    const r = await resposta;
    const json = await r.json() as { ok?: boolean; data?: unknown; erro?: unknown; codigo?: unknown };
    if (json?.ok === true && valido(json.data)) return { ok: true, dados: json.data };
    return { ok: false, mensagem: typeof json?.erro === 'string' && json.erro ? json.erro : MENSAGEM_ERRO, codigo: typeof json?.codigo === 'string' ? json.codigo : null };
  } catch {
    return { ok: false, mensagem: MENSAGEM_ERRO, codigo: null };
  }
}

const postarJson = (buscar: Buscador, corpo: object) => buscar(ENDPOINT_IMPORTACOES, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo) });

/** Disponibilidade real: preserva o erro; falha nunca vira demonstração. */
export async function verificarImportacao(buscar: Buscador): Promise<Resultado<{ habilitado: boolean }>> {
  const r = await ler(postarJson(buscar, { acao: 'estado' }), (d): d is { habilitado: boolean } => typeof (d as { habilitado?: unknown })?.habilitado === 'boolean');
  return r;
}

export async function importacaoHabilitada(buscar: Buscador) {
  const r = await verificarImportacao(buscar);
  if (!r.ok) throw new Error(r.mensagem);
  return r.dados.habilitado;
}

type DocumentoEnviado = { documentoId: string; avisos: string[] };

function pareceDocumento(d: unknown): d is DocumentoEnviado {
  const x = d as Partial<DocumentoEnviado> | null;
  return typeof x?.documentoId === 'string' && Array.isArray(x.avisos);
}

/**
 * Envio em dois passos: o documento é guardado e lido (/documentos); a importação é aberta a partir da
 * leitura registrada (/importacoes, acao "abrir"). Os avisos da leitura seguem para a tela.
 */
export async function enviarContrato(buscar: Buscador, arquivo: File): Promise<Resultado<RespostaImportacao>> {
  const form = new FormData();
  form.append('arquivo', arquivo);
  const documento = await ler(buscar(ENDPOINT_DOCUMENTOS, { method: 'POST', body: form }), pareceDocumento);
  if (!documento.ok) return documento;
  const aberta = await ler(postarJson(buscar, { acao: 'abrir', documentoId: documento.dados.documentoId }), pareceImportacao);
  return aberta.ok ? { ok: true, dados: { ...aberta.dados, avisos: documento.dados.avisos } } : aberta;
}

export type AcaoImportacao =
  | { acao: 'ler' }
  | { acao: 'revisar'; campoId: string; valor?: string; confirmarDivergencia?: true }
  | { acao: 'cliente'; decisao: DecisaoCliente }
  | { acao: 'preparar' }
  | { acao: 'descartar' };

export function agirNaImportacao(buscar: Buscador, importacao: Pick<ImportacaoPublica, 'id' | 'versao'>, acao: AcaoImportacao) {
  const corpo = acao.acao === 'ler' ? { acao: 'ler', importacaoId: importacao.id } : { ...acao, importacaoId: importacao.id, versao: importacao.versao };
  return ler(postarJson(buscar, corpo), pareceImportacao);
}
