/**
 * Fila do envio em lote (importação de contratos, entrega L1). Puro: sem rede, sem React, sem relógio próprio.
 *
 * Plano aprovado (rev. 5.1): cada arquivo vai à rota atual de documentos, um por vez, e depois é aberto para revisão.
 * O estado do ITEM (o que a tela mostra) é separado do COMANDO do lote (R2-3), e a pausa é um conjunto de motivos que
 * não depende do rótulo do item (R3-2):
 *   1. contexto inválido (sessão/empresa mudou, 401/403, tenant)       ⇒ INVALIDAR: para e descarta o resto;
 *   2. recurso fechado (grupo/flag/tabelas indisponíveis)              ⇒ PARAR;
 *   3. cota de importação esgotada (L2)                                 ⇒ PARAR;
 *   4. aviso MODELO_ORCAMENTO no envio                                  ⇒ PAUSAR até "Continuar";
 *   5. resultado incerto (rede, resposta ilegível, 5xx)                 ⇒ PAUSAR e reconciliar só aquele item;
 *   6. o resto                                                          ⇒ CONTINUAR.
 * O primeiro sinal que aparecer, em qualquer etapa do arquivo, manda.
 */

export const MAXIMO_POR_LOTE = 20;
/** Consultas de um envio que encontrou outra leitura do mesmo arquivo em andamento (R3-2): 2, 5, 10 e 16 min. */
export const CONSULTAS_EM_ANDAMENTO_MS = [2, 5, 10, 16].map((m) => m * 60_000);

export type EstadoItem =
  | 'NA_FILA' | 'ENVIANDO' | 'LIDO' | 'ABRINDO' | 'PRONTO' | 'ENCERRADO'
  | 'LIDO_SEM_REVISAO' | 'FALHOU' | 'INCERTO' | 'DUPLICADO' | 'RETIRADO';
export type Etapa = 'UPLOAD' | 'ABRIR';

export type ItemLote = {
  id: string;
  nome: string;
  tamanho: number;
  estado: EstadoItem;
  /** Identidade estável da abertura deste item (R4-1): gerada antes do primeiro `abrir`, reutilizada na recuperação. */
  aberturaId: string;
  documentoId: string | null;
  importacaoId: string | null;
  versao: number | null;
  /** Leitura por regras porque o limite de leitura por IA foi atingido. */
  parcial: boolean;
  /** A leitura gravada tem algum campo preenchido. */
  temDados: boolean | null;
  etapaIncerta: Etapa | null;
  /** Abrir de novo é recuperação (`retomar`), nunca um `abrir` comum. */
  recuperar: boolean;
  /** Recuperação ambígua (histórico só encerrado, r2 P2-1): nada automático; só "Abrir de novo", decisão da pessoa. */
  exigeAbertura: boolean;
  tentativas: number;
  avisos: string[];
  motivo: string | null;
  podeRepetir: boolean;
  duplicadoDe: string | null;
  encerramento: 'IMPORTADA' | 'DESCARTADA' | null;
  consultas: number;
  emAndamentoDesde: number | null;
  proximaConsultaEm: number | null;
  /** Mensagem de "Retirar do lote" (R5-2). */
  retirada: string | null;
  /** Revisado neste lote (confirmado ou descartado): não volta como "próximo". */
  concluido: boolean;
};

export type Parada = { tipo: 'PARAR' | 'INVALIDAR'; mensagem: string };
export type Lote = { itens: ItemLote[]; pausas: string[]; parada: Parada | null };

/** Resultado bruto de uma chamada, preservando status, código e a causa tipada da exceção (ErroContextoAdmin). */
export type Retorno =
  | { tipo: 'resposta'; status: number; corpo: unknown }
  | { tipo: 'excecao'; erro: { tipo?: string; enviado?: boolean; message: string } };

export type Sinal =
  | { sinal: 'OK'; dados: unknown }
  | { sinal: 'CONTEXTO'; mensagem: string; enviado: boolean }
  | { sinal: 'RECURSO'; mensagem: string; codigo: string | null }
  | { sinal: 'COTA'; mensagem: string }
  | { sinal: 'EM_ANDAMENTO'; mensagem: string }
  | { sinal: 'INCERTO'; mensagem: string }
  | { sinal: 'ITEM'; mensagem: string; codigo: string | null; podeRepetir: boolean };

const CONTEXTO_EXCECAO = new Set(['SESSAO_NAO_CONFIRMADA', 'CONTEXTO_MUDOU', 'SESSAO_ENCERRADA', 'RECUSADA_PELO_CONTEXTO']);
const CONTEXTO_CODIGO = new Set(['TENANT_NAO_COMPROVADO', 'AUTENTICACAO_ADMINISTRATIVA']);
const RECURSO_FECHADO = new Set(['INTELIGENCIA_DESATIVADA', 'DOCUMENTOS_INDISPONIVEIS', 'IMPORTACAO_INDISPONIVEL', 'COTA_INDISPONIVEL']);
/** Falhas só do arquivo que podem ser repetidas sem mudar nada. */
const ITEM_REPETIVEL = new Set(['LEITURA_PDF_INDISPONIVEL', 'LEITURA_EXPIRADA', 'IMPORTACAO_DESATUALIZADA']);

export const MENSAGEM_INCERTA = 'Não foi possível confirmar o resultado deste arquivo.';
export const MENSAGEM_ORCAMENTO = 'O limite de leitura por IA foi atingido. Este arquivo foi lido por regras (confira com atenção); os demais não foram enviados.';
export const MENSAGEM_CONSULTAS_ESGOTADAS = 'Não foi possível confirmar o resultado deste arquivo depois das consultas automáticas. Confira Contratos aguardando revisão e tente de novo ou retire do lote; o envio continua pausado.';
export const MENSAGEM_LIMITE_ABERTURAS = 'Abra este contrato por Contratos aguardando revisão.';
export const MENSAGEM_LOTE_OCUPADO = 'Aguarde: o lote ainda tem envios em andamento ou consultas marcadas. Para enviar outro arquivo agora, retire do lote os pendentes.';
/** Contrato importado (registro de ia_importacoes) na tela de Contratos. */
export const contratoImportadoUrl = (importacaoId: string) => `/admin/contratos?importacaoId=${encodeURIComponent(importacaoId)}`;

const corpoDe = (c: unknown) => (c && typeof c === 'object' ? c as { ok?: unknown; data?: unknown; erro?: unknown; codigo?: unknown } : null);

/** Classificação de uma resposta ou exceção (R1-2, R2-3). */
export function classificar(r: Retorno): Sinal {
  if (r.tipo === 'excecao') {
    if (r.erro.tipo && CONTEXTO_EXCECAO.has(r.erro.tipo)) return { sinal: 'CONTEXTO', mensagem: r.erro.message, enviado: r.erro.enviado === true };
    return { sinal: 'INCERTO', mensagem: MENSAGEM_INCERTA };
  }
  const corpo = corpoDe(r.corpo);
  const codigo = typeof corpo?.codigo === 'string' ? corpo.codigo : null;
  const mensagem = typeof corpo?.erro === 'string' && corpo.erro ? corpo.erro : MENSAGEM_INCERTA;
  if (r.status === 401 || r.status === 403 || (codigo && CONTEXTO_CODIGO.has(codigo))) return { sinal: 'CONTEXTO', mensagem, enviado: true };
  if (codigo && RECURSO_FECHADO.has(codigo)) return { sinal: 'RECURSO', mensagem, codigo };
  if (codigo === 'COTA_IMPORTACAO_ESGOTADA') return { sinal: 'COTA', mensagem };
  if (codigo === 'LEITURA_EM_ANDAMENTO') return { sinal: 'EM_ANDAMENTO', mensagem };
  if (r.status >= 200 && r.status < 300 && corpo?.ok === true) return { sinal: 'OK', dados: corpo.data };
  if (codigo && ITEM_REPETIVEL.has(codigo)) return { sinal: 'ITEM', mensagem, codigo, podeRepetir: true };
  // 5xx (com ou sem JSON, inclusive a mensagem genérica) e resposta ilegível: o servidor pode ter gravado.
  if (r.status >= 500 || !corpo || r.status < 400) return { sinal: 'INCERTO', mensagem: MENSAGEM_INCERTA };
  return { sinal: 'ITEM', mensagem, codigo, podeRepetir: false };
}

export type ArquivoEscolhido = { name: string; size: number; type: string };
export type Preparacao<T extends ArquivoEscolhido> = { ok: true; arquivos: T[]; ignorados: string[] } | { ok: false; mensagem: string };

const ehPdf = (a: ArquivoEscolhido) => a.type === 'application/pdf' || /\.pdf$/i.test(a.name);

/** Limite de 20 e filtro de PDF ANTES do primeiro envio (D-LOTE-1, R1-7). Pastas não são percorridas. */
export function prepararArquivos<T extends ArquivoEscolhido>(escolhidos: readonly T[]): Preparacao<T> {
  const arquivos = escolhidos.filter(ehPdf);
  const ignorados = escolhidos.filter((a) => !ehPdf(a)).map((a) => a.name);
  if (!arquivos.length) return { ok: false, mensagem: 'Nenhum PDF entre os arquivos escolhidos. O envio em lote aceita só PDF.' };
  if (arquivos.length > MAXIMO_POR_LOTE) return { ok: false, mensagem: `Escolha até ${MAXIMO_POR_LOTE} PDFs por lote (foram ${arquivos.length}). Nada foi enviado.` };
  return { ok: true, arquivos, ignorados };
}

export function novoLote(arquivos: ReadonlyArray<{ id: string; aberturaId: string; nome: string; tamanho: number }>): Lote {
  return {
    pausas: [],
    parada: null,
    itens: arquivos.map((a) => ({
      id: a.id, nome: a.nome, tamanho: a.tamanho, estado: 'NA_FILA', aberturaId: a.aberturaId, documentoId: null, importacaoId: null, versao: null,
      parcial: false, temDados: null, etapaIncerta: null, recuperar: false, exigeAbertura: false, tentativas: 0, avisos: [], motivo: null, podeRepetir: false,
      duplicadoDe: null, encerramento: null, consultas: 0, emAndamentoDesde: null, proximaConsultaEm: null, retirada: null, concluido: false,
    })),
  };
}

const PAUSA_ORCAMENTO = 'ORCAMENTO';
export const pausaIncerta = (id: string) => `INCERTO:${id}`;
export const pausaEmAndamento = (id: string) => `EM_ANDAMENTO:${id}`;

function comPausa(lote: Lote, motivo: string): Lote {
  return lote.pausas.includes(motivo) ? lote : { ...lote, pausas: [...lote.pausas, motivo] };
}
/** Tira só os motivos daquele item; ORCAMENTO e os motivos dos outros ficam. */
function semPausasDoItem(lote: Lote, id: string): Lote {
  return { ...lote, pausas: lote.pausas.filter((p) => p !== pausaIncerta(id) && p !== pausaEmAndamento(id)) };
}
function comParada(lote: Lote, parada: Parada): Lote {
  // INVALIDAR domina PARAR; a primeira parada do mesmo nível fica.
  if (lote.parada?.tipo === 'INVALIDAR' || (lote.parada && parada.tipo === 'PARAR')) return lote;
  return { ...lote, parada };
}
function mudarItem(lote: Lote, id: string, mudar: (i: ItemLote) => ItemLote): Lote {
  return { ...lote, itens: lote.itens.map((i) => (i.id === id ? mudar(i) : i)) };
}
const item = (lote: Lote, id: string) => {
  const i = lote.itens.find((x) => x.id === id);
  if (!i) throw new Error(`item ${id} fora do lote`);
  return i;
};

type DocumentoEnviado = { documentoId: string; avisos: string[]; extracao?: { secoes?: Array<{ campos?: Array<{ valor?: unknown }> }> } };
const pareceDocumento = (d: unknown): d is DocumentoEnviado => typeof (d as DocumentoEnviado | null)?.documentoId === 'string' && Array.isArray((d as DocumentoEnviado).avisos);
const temDadosNa = (d: DocumentoEnviado) => Array.isArray(d.extracao?.secoes)
  ? d.extracao!.secoes!.some((s) => (s.campos ?? []).some((c) => typeof c.valor === 'string' && c.valor.trim().length > 0))
  : null;

/** Resultado do envio do arquivo (upload, inclusive o reenvio de reconciliação e as consultas). */
export function aplicarEnvio(lote: Lote, id: string, r: Retorno, agora: number): Lote {
  const s = classificar(r);
  const atual = item(lote, id);
  if (s.sinal === 'CONTEXTO') {
    const l = mudarItem(lote, id, (i) => (s.enviado
      ? { ...i, estado: 'INCERTO', etapaIncerta: 'UPLOAD', motivo: MENSAGEM_INCERTA }
      : { ...i, estado: 'NA_FILA', motivo: null }));
    return comParada(l, { tipo: 'INVALIDAR', mensagem: s.mensagem });
  }
  if (s.sinal === 'RECURSO' || s.sinal === 'COTA') {
    const l = semPausasDoItem(mudarItem(lote, id, (i) => ({ ...i, estado: 'FALHOU', etapaIncerta: null, motivo: s.mensagem, podeRepetir: true })), id);
    return comParada(l, { tipo: 'PARAR', mensagem: s.mensagem });
  }
  if (s.sinal === 'EM_ANDAMENTO') {
    const consultas = atual.consultas;
    if (consultas >= CONSULTAS_EM_ANDAMENTO_MS.length) {
      return semPausasDoItem(mudarItem(lote, id, (i) => ({ ...i, estado: 'FALHOU', etapaIncerta: null, motivo: s.mensagem, podeRepetir: true, proximaConsultaEm: null, emAndamentoDesde: null })), id);
    }
    // Os marcos contam da primeira vez que o envio encontrou a outra leitura (2, 5, 10 e 16 min).
    const desde = atual.emAndamentoDesde ?? agora;
    const l = mudarItem(lote, id, (i) => ({ ...i, estado: 'INCERTO', etapaIncerta: 'UPLOAD', motivo: 'Outra leitura deste arquivo está em andamento. Vamos conferir de novo em alguns minutos.', consultas: consultas + 1, emAndamentoDesde: desde, proximaConsultaEm: desde + CONSULTAS_EM_ANDAMENTO_MS[consultas] }));
    return comPausa({ ...l, pausas: l.pausas.filter((p) => p !== pausaIncerta(id)) }, pausaEmAndamento(id));
  }
  if (s.sinal === 'INCERTO') return envioIncerto(lote, id);
  if (s.sinal === 'ITEM') {
    return semPausasDoItem(mudarItem(lote, id, (i) => ({ ...i, estado: 'FALHOU', etapaIncerta: null, motivo: s.mensagem, podeRepetir: s.podeRepetir || i.podeRepetir, proximaConsultaEm: null })), id);
  }
  if (!pareceDocumento(s.dados)) return envioIncerto(lote, id);
  const doc = s.dados;
  const orcamento = doc.avisos.includes('MODELO_ORCAMENTO');
  // Identidade dada pelo servidor (R1-5): o mesmo arquivo com outro nome vira "mesmo arquivo de X".
  const igual = lote.itens.find((x) => x.id !== id && x.documentoId === doc.documentoId);
  let l = semPausasDoItem(mudarItem(lote, id, (i) => ({
    ...i,
    documentoId: doc.documentoId,
    estado: igual ? 'DUPLICADO' : 'LIDO',
    duplicadoDe: igual?.id ?? null,
    etapaIncerta: null,
    recuperar: false,
    tentativas: 0,
    parcial: i.parcial || orcamento,
    temDados: temDadosNa(doc),
    avisos: [...new Set([...i.avisos, ...doc.avisos])],
    motivo: igual ? `Mesmo arquivo de "${igual.nome}".` : null,
    proximaConsultaEm: null,
    emAndamentoDesde: null,
    consultas: 0,
  })), id);
  // A pausa de orçamento vale mesmo com leitura vazia ou abertura que falhar depois (R2-3, prioridade 4).
  if (orcamento) l = comPausa(l, PAUSA_ORCAMENTO);
  return l;
}

/**
 * Envio sem resultado confirmado (5xx, rede, resposta ilegível). Fora das consultas: uma reconciliação automática
 * (tentativas < 2), depois só pela pessoa. Numa consulta agendada (r2 P2-2): o marco foi consumido ao iniciar; o
 * resultado incerto conta como uma consulta e reagenda para o marco seguinte (2/5/10/16 min); depois do último, FALHOU
 * com "Tentar de novo"/"Retirar". Nunca reenvia na hora.
 */
function envioIncerto(lote: Lote, id: string): Lote {
  const atual = item(lote, id);
  if (atual.emAndamentoDesde === null) {
    const l = mudarItem(lote, id, (i) => ({ ...i, estado: 'INCERTO', etapaIncerta: 'UPLOAD', motivo: MENSAGEM_INCERTA, tentativas: i.tentativas + 1, proximaConsultaEm: null }));
    return comPausa(l, pausaIncerta(id));
  }
  const desde = atual.emAndamentoDesde;
  if (atual.consultas >= CONSULTAS_EM_ANDAMENTO_MS.length) {
    // r3 P2-2: o último resultado continua desconhecido (a chamada pode ter iniciado leitura). Acabam as consultas
    // automáticas, mas a pausa fica até resposta definitiva ou decisão da pessoa ("Tentar de novo" ou "Retirar").
    return comPausa(mudarItem(lote, id, (i) => ({ ...i, estado: 'INCERTO', etapaIncerta: 'UPLOAD', motivo: MENSAGEM_CONSULTAS_ESGOTADAS, tentativas: 2, proximaConsultaEm: null })), pausaEmAndamento(id));
  }
  const l = mudarItem(lote, id, (i) => ({ ...i, estado: 'INCERTO', etapaIncerta: 'UPLOAD', motivo: MENSAGEM_INCERTA, consultas: i.consultas + 1, proximaConsultaEm: desde + CONSULTAS_EM_ANDAMENTO_MS[i.consultas] }));
  return comPausa(l, pausaEmAndamento(id));
}

type Aberta = { importacao: { id: string; versao: number; status: 'EM_REVISAO' | 'IMPORTADA' | 'DESCARTADA' } };
const pareceAberta = (d: unknown): d is Aberta => {
  const i = (d as Aberta | null)?.importacao;
  return !!i && typeof i.id === 'string' && typeof i.versao === 'number' && ['EM_REVISAO', 'IMPORTADA', 'DESCARTADA'].includes(i.status);
};

/** Resultado de `abrir` ou `retomar`. Só EM_REVISAO fica PRONTO (R2-4); o upload confirmado nunca volta ao envio. */
export function aplicarAbertura(lote: Lote, id: string, r: Retorno): Lote {
  const s = classificar(r);
  const marcarIncerto = (l: Lote) => comPausa(mudarItem(l, id, (i) => ({ ...i, estado: 'LIDO_SEM_REVISAO', etapaIncerta: 'ABRIR', recuperar: true, motivo: MENSAGEM_INCERTA, tentativas: i.tentativas + 1 })), pausaIncerta(id));
  if (s.sinal === 'CONTEXTO') {
    const l = mudarItem(lote, id, (i) => ({ ...i, estado: 'LIDO_SEM_REVISAO', recuperar: true, etapaIncerta: s.enviado ? 'ABRIR' : null, motivo: s.enviado ? MENSAGEM_INCERTA : null }));
    return comParada(l, { tipo: 'INVALIDAR', mensagem: s.mensagem });
  }
  if (s.sinal === 'RECURSO' || s.sinal === 'COTA') {
    const l = semPausasDoItem(mudarItem(lote, id, (i) => ({ ...i, estado: 'LIDO_SEM_REVISAO', recuperar: true, etapaIncerta: null, motivo: s.mensagem })), id);
    return comParada(l, { tipo: 'PARAR', mensagem: s.mensagem });
  }
  if (s.sinal === 'INCERTO' || s.sinal === 'EM_ANDAMENTO') return marcarIncerto(lote);
  if (s.sinal === 'ITEM' && s.codigo === 'RECUPERACAO_AMBIGUA') {
    return semPausasDoItem(mudarItem(lote, id, (i) => ({ ...i, estado: 'LIDO_SEM_REVISAO', recuperar: false, exigeAbertura: true, etapaIncerta: null, motivo: s.mensagem, podeRepetir: false })), id);
  }
  if (s.sinal === 'ITEM') {
    const limite = s.codigo === 'LIMITE_ABERTURAS';
    return semPausasDoItem(mudarItem(lote, id, (i) => ({
      ...i, estado: limite ? 'FALHOU' : 'LIDO_SEM_REVISAO', recuperar: !limite, etapaIncerta: null,
      motivo: limite ? MENSAGEM_LIMITE_ABERTURAS : s.mensagem, podeRepetir: !limite,
    })), id);
  }
  if (!pareceAberta(s.dados)) return marcarIncerto(lote);
  const imp = s.dados.importacao;
  return semPausasDoItem(mudarItem(lote, id, (i) => ({
    ...i,
    importacaoId: imp.id,
    versao: imp.versao,
    estado: imp.status === 'EM_REVISAO' ? 'PRONTO' : 'ENCERRADO',
    encerramento: imp.status === 'EM_REVISAO' ? null : imp.status,
    etapaIncerta: null,
    recuperar: false,
    exigeAbertura: false,
    tentativas: 0,
    motivo: imp.status === 'IMPORTADA' ? 'Este contrato já foi importado.' : imp.status === 'DESCARTADA' ? 'Esta revisão foi descartada em outra aba.' : null,
  })), id);
}

export type Passo =
  | { tipo: 'ENVIAR'; itemId: string }
  | { tipo: 'ABRIR'; itemId: string }
  | { tipo: 'RETOMAR'; itemId: string };

/**
 * Próximo passo automático. Parado/invalidado: nada. Abrir o arquivo já lido e reconciliar um item incerto (uma
 * tentativa automática) acontecem mesmo com o lote pausado; arquivo NOVO só sai com o conjunto de pausas vazio.
 */
export function proximoPasso(lote: Lote, agora: number): Passo | null {
  if (lote.parada) return null;
  const lido = lote.itens.find((i) => i.estado === 'LIDO');
  if (lido) return { tipo: 'ABRIR', itemId: lido.id };
  const abrir = lote.itens.find((i) => i.estado === 'LIDO_SEM_REVISAO' && i.etapaIncerta === 'ABRIR' && i.tentativas < 2);
  if (abrir) return { tipo: abrir.recuperar ? 'RETOMAR' : 'ABRIR', itemId: abrir.id };
  const envio = lote.itens.find((i) => i.estado === 'INCERTO' && i.etapaIncerta === 'UPLOAD' && i.proximaConsultaEm === null && i.tentativas < 2);
  if (envio) return { tipo: 'ENVIAR', itemId: envio.id };
  const consulta = lote.itens.find((i) => i.estado === 'INCERTO' && i.proximaConsultaEm !== null && i.proximaConsultaEm <= agora);
  if (consulta) return { tipo: 'ENVIAR', itemId: consulta.id };
  if (lote.pausas.length) return null;
  const novo = lote.itens.find((i) => i.estado === 'NA_FILA');
  return novo ? { tipo: 'ENVIAR', itemId: novo.id } : null;
}

/** Marca o item em andamento antes da chamada. */
export function iniciarPasso(lote: Lote, passo: Passo): Lote {
  return mudarItem(lote, passo.itemId, (i) => (passo.tipo === 'ENVIAR'
    ? { ...i, estado: i.estado === 'INCERTO' ? 'INCERTO' : 'ENVIANDO', proximaConsultaEm: null }
    : { ...i, estado: 'ABRINDO' }));
}

/** "Continuar" depois do aviso de orçamento: só esse motivo sai. */
export function continuarLote(lote: Lote): Lote {
  return { ...lote, pausas: lote.pausas.filter((p) => p !== PAUSA_ORCAMENTO) };
}

/** "Tentar de novo" de um item: com documento confirmado repete só a abertura (recuperação); sem ele, o envio. */
export function tentarDeNovo(lote: Lote, id: string): Lote {
  const i = item(lote, id);
  if (i.estado === 'LIDO_SEM_REVISAO' && i.exigeAbertura) return lote;
  if (i.estado === 'LIDO_SEM_REVISAO') return comPausa(mudarItem(lote, id, (x) => ({ ...x, etapaIncerta: 'ABRIR', recuperar: true, tentativas: 0, motivo: null })), pausaIncerta(id));
  // Reinicia só este item (r3 P2-2): consultas zeradas, uma reconciliação; a pausa dele continua até a resposta.
  if (i.estado === 'INCERTO') return mudarItem(lote, id, (x) => ({ ...x, tentativas: 0, consultas: 0, emAndamentoDesde: null, proximaConsultaEm: null, motivo: MENSAGEM_INCERTA }));
  if (i.estado === 'FALHOU' && i.podeRepetir && !i.documentoId) return mudarItem(lote, id, (x) => ({ ...x, estado: 'NA_FILA', motivo: null, consultas: 0, emAndamentoDesde: null, proximaConsultaEm: null }));
  return lote;
}

/** "Abrir de novo" (r2 P2-1): decisão explícita da pessoa depois de uma recuperação ambígua; vai como `abrir` comum. */
export function abrirDeNovo(lote: Lote, id: string): Lote {
  const i = item(lote, id);
  if (i.estado !== 'LIDO_SEM_REVISAO' || !i.exigeAbertura) return lote;
  return mudarItem(lote, id, (x) => ({ ...x, exigeAbertura: false, recuperar: false, etapaIncerta: 'ABRIR', tentativas: 0, motivo: null }));
}

/**
 * Lote ocupado (r2 P2-3): passo automático possível agora OU marcado para depois (consulta agendada), ou chamada em
 * voo. Enquanto ocupado, nenhum arquivo novo entra por seletor nem por arrastar.
 */
export function loteOcupado(lote: Lote | null): boolean {
  return !!lote && (proximoPasso(lote, Infinity) !== null || lote.itens.some((i) => i.estado === 'ENVIANDO' || i.estado === 'ABRINDO'));
}

export type SituacaoNaLista = 'NA_LISTA' | 'FORA_DA_LISTA' | 'DESCONHECIDO';

/**
 * Situação do item na lista "aguardando revisão" (R5-2): presença comprovada pela própria lista quando há documento;
 * envio sem resposta e sem documento confirmado é desconhecido; envio recusado pelo servidor ou nunca feito, fora.
 */
export function situacaoNaLista(i: ItemLote, documentosNaLista: ReadonlySet<string> | null): SituacaoNaLista {
  if (i.documentoId) {
    if (!documentosNaLista) return 'DESCONHECIDO';
    return documentosNaLista.has(i.documentoId) ? 'NA_LISTA' : 'FORA_DA_LISTA';
  }
  return i.etapaIncerta === 'UPLOAD' || i.estado === 'ENVIANDO' ? 'DESCONHECIDO' : 'FORA_DA_LISTA';
}

export const MENSAGENS_RETIRADA: Readonly<Record<SituacaoNaLista, string>> = {
  NA_LISTA: 'Retirado do lote. O contrato continua em Contratos aguardando revisão.',
  FORA_DA_LISTA: 'Retirado do lote. Este arquivo não aparece na lista; para importá-lo, envie de novo.',
  DESCONHECIDO: 'Retirado do lote. Não foi possível confirmar o resultado do envio. Confira Contratos aguardando revisão antes de enviar de novo.',
};

/** "Retirar do lote": nada salvo é apagado; só saem os motivos de pausa do próprio item (R4-2, R5-2). */
export function retirar(lote: Lote, id: string, situacao: SituacaoNaLista): Lote {
  return semPausasDoItem(mudarItem(lote, id, (i) => ({ ...i, estado: 'RETIRADO', etapaIncerta: null, proximaConsultaEm: null, retirada: MENSAGENS_RETIRADA[situacao] })), id);
}

/** Depois de confirmar ou descartar a revisão do item no próprio lote. */
export function concluirItem(lote: Lote, id: string, encerramento: 'IMPORTADA' | 'DESCARTADA'): Lote {
  return mudarItem(lote, id, (i) => ({ ...i, estado: 'ENCERRADO', encerramento, concluido: true, motivo: encerramento === 'IMPORTADA' ? 'Importado.' : 'Revisão descartada.' }));
}

/** Próximo da fila para revisar: o primeiro PRONTO ainda não revisado neste lote. */
export function proximoParaRevisar(lote: Lote, depoisDe?: string): ItemLote | null {
  const prontos = lote.itens.filter((i) => i.estado === 'PRONTO' && !i.concluido);
  if (!depoisDe) return prontos[0] ?? null;
  const ordem = lote.itens.findIndex((i) => i.id === depoisDe);
  return prontos.find((i) => lote.itens.indexOf(i) > ordem) ?? prontos[0] ?? null;
}

export const ROTULO_ESTADO: Readonly<Record<EstadoItem, string>> = {
  NA_FILA: 'Na fila', ENVIANDO: 'Lendo', LIDO: 'Lido', ABRINDO: 'Preparando a revisão', PRONTO: 'Pronto para revisar',
  ENCERRADO: 'Encerrado', LIDO_SEM_REVISAO: 'Lido, revisão não aberta', FALHOU: 'Falhou', INCERTO: 'Resultado não confirmado',
  DUPLICADO: 'Arquivo repetido', RETIRADO: 'Retirado do lote',
};

/** O lote terminou quando nenhum passo automático resta e nenhum item está em andamento. */
export function loteOcioso(lote: Lote, agora: number) {
  return !proximoPasso(lote, agora) && !lote.itens.some((i) => i.estado === 'ENVIANDO' || i.estado === 'ABRINDO');
}
