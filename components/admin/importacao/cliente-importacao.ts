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
  resultado?: { clienteId: string; destino: string; importadoEm: string; pendencias: string[] } | null;
  extracao: ExtracaoContrato;
  revisados: string[];
  decisaoCliente: DecisaoCliente;
};
export type PlanoPublico = {
  pronto: boolean;
  bloqueios: string[];
  avisos: string[];
  match: { estado: EstadoMatch; clienteId: string | null; candidatos: Array<{ clienteId: string; nome: string; motivos: string[] }>; motivo: string };
  /** Tipo do contratante resolvido na revisão; null = o operador ainda precisa escolher. */
  tipoPessoa?: 'PF' | 'PJ' | null;
  /** Recusa de cliente pessoa jurídica (PJ_INDISPONIVEL): nada é gravado; leitura e correções seguem salvas. */
  recusa?: { codigo: 'PJ_INDISPONIVEL'; motivo: 'ENTREGA_A' | 'MIGRACAO_PENDENTE'; mensagem: string } | null;
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
  | { acao: 'revisar'; campoId: string; valor?: string; confirmarDivergencia?: true; limparEndereco?: true }
  | { acao: 'cliente'; decisao: DecisaoCliente }
  | { acao: 'preparar' }
  | { acao: 'descartar' };

export function agirNaImportacao(buscar: Buscador, importacao: Pick<ImportacaoPublica, 'id' | 'versao'>, acao: AcaoImportacao) {
  const corpo = acao.acao === 'ler' ? { acao: 'ler', importacaoId: importacao.id } : { ...acao, importacaoId: importacao.id, versao: importacao.versao };
  return ler(postarJson(buscar, corpo), pareceImportacao);
}

/** ID estável do campo na tela de revisão (N1/N2): o erro aponta para ele. */
export const idCampoRevisao = (campoId: string) => `revisao-${campoId.replace(/\./g, '-')}`;
export const ID_CLIENTE_REVISAO = 'revisao-cliente';
export const ID_SECAO_ENDERECO = 'revisao-secao-endereco';

const RECUSADO = new Set(['INVALIDO', 'AMBIGUO', 'NAO_REPRESENTAVEL']);

type CampoRevisao = ExtracaoContrato['secoes'][number]['campos'][number];

/**
 * Tipo de pessoa marcado na tela (revisão do Astra, P3-7): o valor gravado quando a escolha é humana (informada pelo
 * operador ou confirmada), nunca a lista de revisados sozinha. Sugestão do documento não aparece marcada.
 */
export function tipoPessoaMarcado(c: CampoRevisao, revisado: boolean): 'PF' | 'PJ' | null {
  if (!revisado && c.origem !== 'Informado pelo operador') return null;
  const v = (c.valor ?? c.bruto ?? '').trim().toLowerCase();
  return /jur[ií]dica|^pj$/.test(v) ? 'PJ' : /f[ií]sica|^pf$/.test(v) ? 'PF' : null;
}

/**
 * Pendências da revisão ligadas ao campo exato, na ordem da tela (mesmas regras de `montarPlano`, que segue sendo a
 * autoridade). O que não é de um campo (decisão do cliente) aponta para o bloco "Cliente"; endereço incompleto, para a
 * seção de endereço.
 */
export function errosDaRevisao(i: Pick<ImportacaoPublica, 'extracao' | 'revisados'>, plano: PlanoPublico | null): Array<{ campo: string; mensagem: string }> {
  if (!plano || plano.pronto) return [];
  const erros: Array<{ campo: string; mensagem: string }> = [];
  for (const c of i.extracao.secoes.flatMap((s) => s.campos)) {
    const campo = idCampoRevisao(c.id);
    if (c.id === 'contratante.tipoPessoa') {
      if (plano.recusa) erros.push({ campo, mensagem: plano.recusa.mensagem });
      else if (c.validacao && RECUSADO.has(c.validacao)) erros.push({ campo, mensagem: `${c.rotulo}: ${c.motivo ?? 'escolha o tipo certo.'}` });
      else if (!plano.tipoPessoa) erros.push({ campo, mensagem: 'Escolha se o contratante é pessoa física ou jurídica.' });
      else if (c.estado === 'PRECISA_REVISAO' && !i.revisados.includes(c.id)) erros.push({ campo, mensagem: `${c.rotulo}: escolha para confirmar.` });
    } else if (c.validacao && RECUSADO.has(c.validacao)) erros.push({ campo, mensagem: `${c.rotulo}: ${c.motivo ?? 'o valor lido não pode ser usado como está. Corrija ou remova.'}` });
    else if (c.estado === 'PRECISA_REVISAO' && !i.revisados.includes(c.id)) erros.push({ campo, mensagem: `${c.rotulo}: confirme a leitura ou corrija.` });
    else if (c.id === 'evento.data' && !c.valor) erros.push({ campo, mensagem: 'Informe a data da festa.' });
  }
  const cobertos = /^(Revise \d+ campos?|Informe a data da festa\.|Confirme se o contratante|.+: o valor lido não pode ser usado)/;
  // Conflito de identidade já mostrado no próprio campo não se repete; o que sobrar aponta para o tipo de pessoa.
  const motivosNosCampos = new Set(i.extracao.secoes.flatMap((s) => s.campos).filter((c) => c.validacao && RECUSADO.has(c.validacao)).map((c) => `Identidade do contratante: ${c.motivo}`));
  for (const b of plano.bloqueios) {
    if (b === plano.recusa?.mensagem || cobertos.test(b) || motivosNosCampos.has(b)) continue;
    const alvo = /^Endereço incompleto/.test(b) ? ID_SECAO_ENDERECO : /^Identidade do contratante/.test(b) ? idCampoRevisao('contratante.tipoPessoa') : ID_CLIENTE_REVISAO;
    erros.push({ campo: alvo, mensagem: b });
  }
  return erros;
}
