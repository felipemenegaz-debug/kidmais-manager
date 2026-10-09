import type { ConfiguracaoAtendimento } from '../core.ts';
import type { Finalidade } from '../prontas.ts';
import { comPendente, jaEnviado, mesclarContexto, registrarEnviado } from './contexto.ts';
import { clausulasDoTema, modeloVigente } from './contrato-modelo.ts';
import { CONTRATO_PARA_ASSINAR, ENTRADA_CONVIDADOS, cardapioDispensado, cumprimentoDoCliente, dataCitadaInvalida, irritacaoComMensagens, itemExternoDoCliente, pedeIntencao, registroDoBloqueio, semAcento, unidadesDeDestino } from './entendimento.ts';
import { PASSAGEM_AO_CLIENTE, type EscopoAgendaConsultado, type Anexo, type CampoPendente, type Catalogos, type ContextoWallE, type CriterioConsultaComum, type Entendimento, type Fonte, type Intencao, type MotivoPassagem, type Passagem, type ResultadoWallE, type Saida, type TipoIntencao } from './tipos.ts';

/**
 * Resolver: cada intenção é respondida só com FONTES OFICIAIS lidas na hora (porta `FontesWallE`), em texto montado
 * aqui (nenhum fato vem do modelo). Decide, pelo mais restritivo: responder, perguntar só o que falta, ou passar para a
 * equipe — e, antes de passar, responde as partes que dá para responder com dado confirmado.
 */
export type ProntaAutorizada = {
  id: string; versao: number; titulo: string; tipo: 'TEXTO' | 'LINK' | 'IMAGEM' | 'VIDEO' | 'DOCUMENTO'; texto: string; link: string | null;
  midiaUrl: string | null; arquivoId: string | null; arquivoNome: string | null; finalidade: Finalidade; pacoteCodigo: string | null; unidadeId: string | null;
};
export type PacoteResumo = { id: string; codigo: string; nome: string; descricao: string | null; duracaoMinutos: number | null; convidadosMinimos: number | null; convidadosMaximos: number | null };
export type PeriodoAgenda = { codigo: string; nome: string; inicio: string; fim: string; disponivel: boolean };
export type Composicao = { categorias: { nome: string; escolhasMin: number; escolhasMax: number; itens: string[] }[]; inclusos: { nome: string; categoria: string }[]; extras: { nome: string; categoria: string }[] };
export type PrecoCalculado =
  | { valor: number; convidadosFaturados: number; minimoAplicado: boolean; desconto: { percentual: number; titulo: string | null } | null; tabela: { id: string; codigo: string; nome: string } }
  | { erro: 'ACIMA_CAPACIDADE' | 'INDISPONIVEL' | 'SOB_CONSULTA' | 'FALHA'; maximo?: number | null };
export interface FontesWallE {
  prontasAutorizadas(finalidade: Finalidade): Promise<ProntaAutorizada[]>;
  pacotes(): Promise<PacoteResumo[]>;
  composicao(pacoteCodigo: string): Promise<Composicao | null>;
  preco(pacoteCodigo: string, data: string, turno: string, convidados: number): Promise<PrecoCalculado>;
  /** Períodos do dia e o escopo REAL consultado (a unidade pedida pode não ter agenda própria). */
  disponibilidade(data: string, unidade: string | null): Promise<{ periodos: PeriodoAgenda[]; escopo: EscopoAgendaConsultado }>;
  /** Datas próximas com período livre, no MESMO escopo da consulta principal. */
  alternativas(data: string, unidade: string | null, turno: string | null, quantas: number): Promise<{ data: string; periodos: PeriodoAgenda[] }[]>;
  linkContratoProprio(): Promise<string | null>;
  /** Rodada 40: link público de disponibilidade/fechamento da empresa (null/ausente: sem página pública para ela). */
  linkDisponibilidade?(): string | null;
}

// ---------------------------------------------------------------- formatação (pt-BR)
const DIAS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
export const dataBr = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
export const diaSemana = (iso: string) => DIAS[new Date(`${iso}T12:00:00Z`).getUTCDay()];
const hora = (h: string) => { const [hh, mm] = h.split(':'); return mm && mm !== '00' ? `${Number(hh)}h${mm}` : `${Number(hh)}h`; };
export const moeda = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const lista = (itens: string[]) => (itens.length <= 1 ? itens.join('') : `${itens.slice(0, -1).join(', ')} e ${itens.at(-1)}`);
const turnoTexto = (catalogos: Catalogos, codigo: string | null | undefined) => { const t = catalogos.turnos.find((x) => x.codigo === codigo); return t ? `${t.nome} (${hora(t.inicio)} às ${hora(t.fim)})` : null; };
const nomePacote = (catalogos: Catalogos, codigo: string | null | undefined) => catalogos.pacotes.find((p) => p.codigo === codigo)?.nome ?? null;
const nomeUnidade = (catalogos: Catalogos, id: string | null | undefined) => catalogos.unidades.find((u) => u.id === id)?.nome ?? null;
const PERGUNTA: Record<CampoPendente, (c: Catalogos) => string> = {
  data: () => 'a data da festa (dia, mês e ano)',
  turno: (c) => `o período (${lista(c.turnos.map((t) => `${t.nome.toLowerCase()}, ${hora(t.inicio)} às ${hora(t.fim)}`))})`,
  convidados: () => 'quantos convidados',
  pacote: (c) => `qual pacote (${lista(c.pacotes.map((p) => p.nome))})`,
  unidade: (c) => `qual unidade (${lista(c.unidades.map((u) => u.nome))})`,
  tema: () => 'o tema da festa',
};

type Estado = {
  ctx: ContextoWallE; paragrafos: { texto: string; fontes: Fonte[] }[]; anexos: Anexo[]; perguntas: { campo: CampoPendente; para: TipoIntencao; opcional?: boolean }[];
  encaminhar: MotivoPassagem[]; agora: string; texto: string; entendimento: Entendimento; catalogos: Catalogos; config: ConfiguracaoAtendimento; fontes: FontesWallE;
  /** Correções feitas por ESTA mensagem (data, período, convidados, pacote...) e o último assunto antes dela. */
  correcoesNovas: NonNullable<ContextoWallE['correcoes']>; ultimo: TipoIntencao | null;
  /** Rodada 26: data completa proposta para a contratação, à espera da confirmação do cliente. */
  confirmarData?: string;
  /** Posição da contratação entre os motivos (onde ela entraria se seguisse direto), para uma passagem por outro motivo. */
  posContratacao?: number;
};
const dizer = (e: Estado, texto: string, fontes: Fonte[] = []) => { e.paragrafos.push({ texto, fontes }); };
/** `opcional`: convite depois de uma resposta completa ("se quiser, me conte o tema"), não um dado que falta. */
const perguntar = (e: Estado, campo: CampoPendente, para: TipoIntencao, opcional = false) => { if (!e.perguntas.some((p) => p.campo === campo)) e.perguntas.push({ campo, para, ...(opcional ? { opcional } : {}) }); };
const passar = (e: Estado, motivo: MotivoPassagem) => { if (!e.encaminhar.includes(motivo)) e.encaminhar.push(motivo); };

/** Materiais autorizados: filtra por unidade/pacote; ambiguidade de unidade sem unidade escolhida ⇒ pergunta. */
async function materiais(e: Estado, finalidade: Finalidade, para: TipoIntencao) {
  let itens = await e.fontes.prontasAutorizadas(finalidade);
  const unidades = [...new Set(itens.map((p) => p.unidadeId).filter((u): u is string => !!u))];
  if (unidades.length > 1) {
    if (!e.ctx.unidade) { perguntar(e, 'unidade', para); return { itens: [], faltaUnidade: true }; }
    itens = itens.filter((p) => !p.unidadeId || p.unidadeId === e.ctx.unidade);
  } else if (e.ctx.unidade) itens = itens.filter((p) => !p.unidadeId || p.unidadeId === e.ctx.unidade);
  // Material de pacote: só dos pacotes citados agora (ou o escolhido antes); sem pacote, os gerais (ou todos, se só há de pacote).
  const alvo = e.entendimento.entidades.pacotes.length ? e.entendimento.entidades.pacotes : e.ctx.pacote ? [e.ctx.pacote] : [];
  if (itens.some((p) => p.pacoteCodigo)) itens = alvo.length ? itens.filter((p) => !p.pacoteCodigo || alvo.includes(p.pacoteCodigo)) : itens.some((p) => !p.pacoteCodigo) ? itens.filter((p) => !p.pacoteCodigo) : itens;
  return { itens, faltaUnidade: false };
}
/** Envia (ou cita, se já enviado nesta versão) um material autorizado. Texto/link vai no corpo; anexo vai à parte. */
function usarMaterial(e: Estado, p: ProntaAutorizada) {
  const fonte: Fonte = { tipo: 'PRONTA', id: p.id, versao: p.versao, finalidade: p.finalidade };
  // Retomada de uma pendência (o cliente só respondeu o que faltava): material já enviado não é repetido.
  const pedidoAgora = p.finalidade !== 'GERAL' && pedeIntencao(e.texto, p.finalidade);
  if (!pedidoAgora && !e.entendimento.reenviar && jaEnviado(e.ctx, p.id, p.versao)) return false;
  if (p.tipo === 'TEXTO' || p.tipo === 'LINK') { dizer(e, p.link ? `${p.texto}\n${p.link}` : p.texto, [fonte]); e.ctx = registrarEnviado(e.ctx, { prontaId: p.id, versao: p.versao, finalidade: p.finalidade }, e.agora); return true; }
  if (jaEnviado(e.ctx, p.id, p.versao) && !e.entendimento.reenviar) { dizer(e, `O material “${p.titulo}” já está aqui na conversa, logo acima.`, [fonte]); return false; }
  if (e.anexos.some((a) => a.prontaId === p.id)) return false;
  e.anexos.push({ prontaId: p.id, versao: p.versao, finalidade: p.finalidade, tipo: p.tipo, titulo: p.titulo, legenda: p.texto.trim() || null, midiaUrl: p.midiaUrl, arquivoId: p.arquivoId, nome: p.arquivoNome });
  e.ctx = registrarEnviado(e.ctx, { prontaId: p.id, versao: p.versao, finalidade: p.finalidade }, e.agora);
  return true;
}

// ---------------------------------------------------------------- intenções
/** "Quero o valor fechado, não a tabela": calcula se der; senão pergunta o que falta, sem mandar a tabela. */
const VALOR_EXATO = /\b(valor (fechado|exato|certinho|final)|preco (fechado|exato|final)|exatamente|nao quero (a )?tabela|sem tabela)\b/;
/** Convidados acima do pacote citado: diz o limite do cadastro e quais pacotes comportam (exceção é com a equipe). */
async function capacidade(e: Estado) {
  const daMensagem = e.entendimento.entidades.pacotes.length === 1;
  const codigo = daMensagem ? e.entendimento.entidades.pacotes[0] : e.ctx.pacote;
  const n = e.ctx.convidados;
  if (!n) return;
  const todos = await e.fontes.pacotes();
  const acimaDeTodos = !todos.some((x) => !x.convidadosMaximos || x.convidadosMaximos >= n);
  if (!codigo || (!daMensagem && acimaDeTodos)) {
    // "Quanto fica pra 200 pessoas?": a faixa cadastrada de cada pacote diz quais comportam.
    const cabem = todos.filter((x) => (!x.convidadosMaximos || x.convidadosMaximos >= n) && (!x.convidadosMinimos || x.convidadosMinimos <= n));
    const maior = [...todos].filter((x) => x.convidadosMaximos).sort((a, b) => b.convidadosMaximos! - a.convidadosMaximos!)[0];
    if (!cabem.length && !maior) return;
    dizer(e, cabem.length ? `Para ${n} convidados: ${lista(cabem.map((x) => `o pacote ${x.nome} (${x.convidadosMinimos ? `${x.convidadosMinimos} a ` : 'até '}${x.convidadosMaximos})`))}.`
      : `Para ${n} convidados, nenhum pacote cadastrado comporta: o maior, o pacote ${maior.nome}, vai até ${maior.convidadosMaximos}.`, (cabem.length ? cabem : [maior]).map((x) => ({ tipo: 'PACOTE', codigo: x.codigo, id: x.id } as Fonte)));
    return;
  }
  const p = todos.find((x) => x.codigo === codigo);
  if (!p?.convidadosMaximos || n <= p.convidadosMaximos) return;
  const cabem = todos.filter((x) => (!x.convidadosMaximos || x.convidadosMaximos >= n) && (!x.convidadosMinimos || x.convidadosMinimos <= n));
  dizer(e, `O pacote ${p.nome} atende até ${p.convidadosMaximos} convidados${cabem.length ? `; para ${n}, ${lista(cabem.map((x) => `o pacote ${x.nome}`))} ${cabem.length > 1 ? 'comportam' : 'comporta'}` : `; para ${n}, nenhum pacote cadastrado comporta: a equipe avalia`}.`,
    [p, ...cabem].map((x) => ({ tipo: 'PACOTE', codigo: x.codigo, id: x.id } as Fonte)));
  // Acima de todos os pacotes cadastrados é exceção (a equipe avalia), não uma pergunta que o Wall-e resolve.
  if (!cabem.length) passar(e, 'NEGOCIACAO');
}
/** "Muda se for em outro mês?", "depende da época?": o valor depende da data (rodada 18). */
const OUTRA_EPOCA = /\b(?:(?:em |num |noutro |de )?outr[oa] (?:mes|data|epoca|temporada|dia)|outros meses|outras datas|mes que vem|proximo mes|(?:mes|meses|epoca|data|datas|dias) diferentes?|depende (?:do|da) (?:mes|data|epoca|dia|periodo|horario)|(?:muda|mudam|varia|variam|diferente|diferenca)\b[^.?!]{0,25}\b(?:mes|meses|epoca|data|datas|dia|dias|dia da semana|fim de semana|periodo|horario|temporada|feriados?))\b/;
/** Explica a variação por data quando é perguntada (rodada 20): o mecanismo, sem supor regra por dia ou mês. */
const VARIA_POR_DATA = 'O valor é calculado pela tabela para cada data e período, então pode mudar de uma data para outra.';
/** "Muda conforme a data?", "depende da época?": pergunta geral sobre a regra de preço. */
const EPOCA_GENERICA = /\b(?:conforme|depende|dependendo|de acordo com|varia|variam|sempre o mesmo|sempre igual)\b/;
/** "Se eu fizer em outro mês", "e se for em outra data": mudança da própria festa. */
const EPOCA_DA_FESTA = /\bse (?:eu |a gente |nos |ela |ele )?(?:fizer|fizermos|for|fosse|mudar|mudasse|marcar|deixar|passar|trocar)\b/;
/** "Quero orçamento do Essencial pra 40": além da tabela, pede o que falta para o valor exato. */
const ORCAMENTO = /\b(orcamento|cotacao)\b/;
const TEMA_A_DECIDIR = 'Quando decidir o tema, é só me contar que eu anoto.';
const CONFIRMAR_DATA = 'Para não errar a data: me confirme o dia e o mês da festa.';
const COMPARAR_OUTRA = 'Para comparar com outra data, me diga qual (dia e mês): o valor é calculado pela tabela para cada data e período.';
const COMPARAR_DATA = 'O valor é calculado pela tabela para cada data e período: me diga qual data (dia e mês) você quer comparar.';
async function precos(e: Estado) {
  // "E num dia de semana sai mais barato?" com uma data na conversa: pergunta qual data (recalcular a mesma não responde);
  // a data anterior fica na memória para a comparação quando a nova chegar.
  // Rodada 23: a própria festa em outro mês junto do valor ("…dia 21/11? e se eu fizer em outro mês, muda?"): calcula e
  // pergunta a data para comparar.
  const outroMesJunto = !!e.entendimento.entidades.data && OUTRA_EPOCA.test(semAcento(e.texto)) && EPOCA_DA_FESTA.test(semAcento(e.texto));
  const outraTambem = (!!e.entendimento.outraData && !!e.entendimento.entidades.data) || outroMesJunto;
  // Rodada 24: "se eu fizer em outro mês o valor muda?" depois de um valor: a nova data, sem recalcular a anterior.
  const outroMesDepois = !!e.ctx.data && !e.entendimento.entidades.data && OUTRA_EPOCA.test(semAcento(e.texto)) && !EPOCA_GENERICA.test(semAcento(e.texto));
  if ((e.entendimento.outraData || outroMesDepois) && e.ctx.data && !outraTambem) { dizer(e, COMPARAR_DATA); perguntar(e, 'data', 'PRECOS'); return; }
  // Pergunta geral depois do valor ("o valor depende da data?"): que depende, e o convite para comparar — sem recalcular.
  if (!!e.ctx.data && !e.entendimento.entidades.data && OUTRA_EPOCA.test(semAcento(e.texto)) && EPOCA_GENERICA.test(semAcento(e.texto))) {
    // A frase vem da tabela publicada (já na conversa): ela é a fonte, sem reenviar o PDF.
    const { itens } = await materiais(e, 'PRECOS', 'PRECOS');
    const tabela = itens.find((p) => p.tipo === 'DOCUMENTO' || p.tipo === 'IMAGEM') ?? itens[0];
    dizer(e, VARIA_POR_DATA, tabela ? [{ tipo: 'PRONTA', id: tabela.id, versao: tabela.versao, finalidade: tabela.finalidade }] : []);
    perguntar(e, 'data', 'PRECOS', true); return;
  }
  if (VALOR_EXATO.test(semAcento(e.texto))) { await precoCalculado(e, true, undefined, 'PRECOS'); return; }
  // Rodada 18: "o valor muda se eu fizer em outro mês?" sem data na conversa: o valor é por data e período (nenhuma regra
  // por mês é suposta); a tabela segue e a data (e o período) necessários são pedidos.
  const outraEpoca = !e.ctx.data && !e.entendimento.entidades.data && OUTRA_EPOCA.test(semAcento(e.texto));
  // Pergunta genérica ("o preço muda conforme a data?"): a resposta é que depende, e a data fica como convite; a mudança da
  // própria festa ("se eu fizer em outro mês") pede a data.
  const epocaGenerica = outraEpoca && EPOCA_GENERICA.test(semAcento(e.texto)) && !EPOCA_DA_FESTA.test(semAcento(e.texto));
  // "Não manda o PDF de novo, só me fala quanto fica": o valor calculado (ou o que falta para ele), sem material.
  if (e.entendimento.semMaterial) { await precoCalculado(e, true, undefined, 'PRECOS'); return; }
  const { itens, faltaUnidade } = await materiais(e, 'PRECOS', 'PRECOS');
  if (faltaUnidade) return;
  if (!itens.length) { dizer(e, 'Ainda não tenho a tabela de preços cadastrada para enviar por aqui.'); passar(e, 'INFORMACAO_INDISPONIVEL'); return; }
  const novos = itens.filter((p) => p.tipo === 'DOCUMENTO' || p.tipo === 'IMAGEM').slice(0, 2);
  const candidatos = novos.length ? novos : itens.slice(0, 1);
  // Pergunta de valor com tudo conhecido ("quanto fica o Completa dia 21 à noite?"): responde o cálculo sem repetir a
  // tabela já enviada. Pedido de reenvio: só a tabela, sem refazer o cálculo.
  const podeCalcular = !!(e.ctx.data && (e.ctx.turno || !e.catalogos.turnos.length) && e.ctx.convidados && e.ctx.pacote);
  const jaTem = candidatos.every((p) => jaEnviado(e.ctx, p.id, p.versao));
  if (!(podeCalcular && jaTem && !e.entendimento.reenviar) && candidatos.map((p) => usarMaterial(e, p)).some(Boolean)) dizer(e, 'Segue a nossa tabela de preços.');
  // Rodada 21: a capacidade não se repete a cada dado respondido ("segundo horário" não precisa dela de novo).
  if (!podeCalcular && (e.entendimento.entidades.convidados || pedeIntencao(e.texto, 'PRECOS'))) await capacidade(e);
  // Orçamento, continuação ("pra 80 pessoas" depois da tabela) ou resposta a só parte do que o preço perguntou ("sábado
  // 17 de outubro" quando faltavam a data e o período): pede o que ainda falta para o valor exato.
  const perguntados = e.ctx.pendente?.para === 'PRECOS' && !e.ctx.pendente.opcional ? e.ctx.pendente.campos : [];
  const emParte = !pedeIntencao(e.texto, 'PRECOS') && perguntados.some((c) => e.ctx[c] === null || e.ctx[c] === undefined);
  // Dois pacotes citados ("a diferença de preço entre o Completa e o Premium pra 90, dia 19/12 às 17h"): calcula os dois.
  const dois = e.entendimento.entidades.pacotes.length >= 2 ? e.entendimento.entidades.pacotes.slice(0, 2) : undefined;
  // Rodada 18: retomada de uma qualificação de preço já em andamento (o cliente respondeu o que faltava): pede o que
  // ainda falta para o valor (o pacote, por exemplo), em vez de parar na lista de pacotes que comportam.
  const retomando = perguntados.length > 0;
  // Só falta o período (data, convidados e pacote já ditos): pergunta, em vez de parar na tabela.
  const soFaltaPeriodo = !e.ctx.turno && e.catalogos.turnos.length > 0 && !!e.ctx.data && !!e.ctx.convidados && !!(e.ctx.pacote || dois);
  // Só falta o pacote e um único pacote cadastrado comporta os convidados ("umas 40 crianças e uns 30 adultos"): o valor
  // dele, sem trocar o pacote da conversa.
  let unicoQueCabe: string[] | undefined;
  if (!podeCalcular && !dois && !e.ctx.pacote && e.ctx.data && (e.ctx.turno || !e.catalogos.turnos.length) && e.ctx.convidados) {
    const n = e.ctx.convidados;
    const cabem = (await e.fontes.pacotes()).filter((x) => (!x.convidadosMaximos || x.convidadosMaximos >= n) && (!x.convidadosMinimos || x.convidadosMinimos <= n));
    if (cabem.length === 1) unicoQueCabe = [cabem[0].codigo];
  }
  if (outraEpoca && !e.paragrafos.some((p) => p.texto === VARIA_POR_DATA)) dizer(e, VARIA_POR_DATA);
  // Rodada 26: o mês citado sem dia ("completa, novembro, 70 pessoas, segundo horário. quanto fica?") é uma data em vista:
  // pede o dia. A continuação curta ("e pra 80?") só pede os dados do valor exato quando a conversa já vai para ele (data
  // ou período ditos); depois de uma resposta só com a tabela, segue pela tabela (valor de pacote para N sem data).
  const continuaValor = e.entendimento.intencoes.some((i) => i.continuacao) && !!(e.ctx.data || e.ctx.turno);
  // O mês vale como data em vista só citado NESTA mensagem com pedido de valor ("quanto fica"), nunca no pedido da tabela
  // nem com "não sei o dia" ("minha festa vai ser em dezembro, só não sei o dia; têm tabela?").
  const tx = semAcento(e.texto);
  // Rodada 33 (h33 aa59): também as abreviações "qnto" e "qnt" ("e em janeiro qnt ficaria").
  const mesEmVista = !!e.entendimento.mesCitado && /\b(?:quanto|qto|qnto|qnt|valor|preco|custa\w*|orcamento)\b/.test(tx) && !/\btabela\b/.test(tx) && !/\bnao sei\b[^.?!]{0,25}\b(?:dia|data)\b/.test(tx);
  if (!e.entendimento.reenviar) await precoCalculado(e, !podeCalcular && (ORCAMENTO.test(semAcento(e.texto)) || !!e.entendimento.comparaPreco || continuaValor || mesEmVista || emParte || retomando || outraEpoca || soFaltaPeriodo || !!e.entendimento.periodoAmbiguo || !!e.entendimento.outraData), dois ?? unicoQueCabe, 'PRECOS', epocaGenerica && !retomando);
  if (outraTambem) { dizer(e, COMPARAR_OUTRA); perguntar(e, 'data', 'PRECOS'); }
  // Rodada 38 (h38 aa78): "e no outro horário?" sem período na conversa: pergunta o período (e a data, se faltar), sem
  // mandar material de novo.
  if (/\b(?:o |no |do |pro |pra )?outro (?:horario|turno|periodo)\b/.test(tx) && !e.ctx.turno && !e.entendimento.entidades.turno) { perguntar(e, 'turno', 'PRECOS'); if (!e.ctx.data) perguntar(e, 'data', 'PRECOS'); }
  // Rodada 26: sem valor exato e sem pergunta ("e pra 80?" depois da tabela), a resposta aponta a tabela já enviada.
  if (!podeCalcular && jaTem && !e.entendimento.reenviar && !e.perguntas.length && !e.paragrafos.some((p) => p.fontes.some((x) => x.tipo === 'PRONTA' || x.tipo === 'TABELA_PRECO'))) {
    const tabela = candidatos[0];
    dizer(e, 'Os valores por pacote e número de convidados estão na tabela de preços enviada acima.', [{ tipo: 'PRONTA', id: tabela.id, versao: tabela.versao, finalidade: tabela.finalidade }]);
  }
}
/** Valor calculado pelo sistema (tabela vigente) quando data, período, convidados e pacote já são conhecidos. */
async function precoCalculado(e: Estado, perguntarFaltantes: boolean, pacotes?: string[], para: TipoIntencao = 'PACOTES', opcional = false) {
  const alvo = pacotes?.length ? pacotes : e.ctx.pacote ? [e.ctx.pacote] : [];
  const faltam: CampoPendente[] = [];
  if (!e.ctx.data) faltam.push('data');
  if (!e.ctx.turno && e.catalogos.turnos.length) faltam.push('turno');
  if (!e.ctx.convidados) faltam.push('convidados');
  if (!alvo.length) faltam.push('pacote');
  if (faltam.length) { if (perguntarFaltantes) { dizer(e, VALORES_DEPENDEM); for (const f of faltam) perguntar(e, f, para, opcional); } return; }
  const fila = [...alvo];
  let sugeriu = false;
  for (let k = 0; k < fila.length && k < 4; k++) {
    const codigo = fila[k];
    const r = await e.fontes.preco(codigo, e.ctx.data!, e.ctx.turno!, e.ctx.convidados!);
    const nome = nomePacote(e.catalogos, codigo) ?? codigo;
    if ('erro' in r) {
      if (r.erro === 'ACIMA_CAPACIDADE') {
        // Acima do pacote: o limite do cadastro e, pela mesma tabela, o valor do pacote que comporta (uma sugestão).
        const n = e.ctx.convidados!;
        const todos = await e.fontes.pacotes();
        const cabem = sugeriu ? [] : todos.filter((x) => !fila.includes(x.codigo) && (!x.convidadosMaximos || x.convidadosMaximos >= n) && (!x.convidadosMinimos || x.convidadosMinimos <= n)).slice(0, 1);
        // Nenhum pacote cadastrado comporta: é exceção (a equipe avalia), não "veja os pacotes maiores".
        const nenhum = !todos.some((x) => !x.convidadosMaximos || x.convidadosMaximos >= n);
        dizer(e, `O pacote ${nome} comporta até ${r.maximo} convidados; para ${n}, ${cabem.length ? `o pacote ${cabem[0].nome} comporta` : nenhum ? 'nenhum pacote cadastrado comporta: a equipe avalia' : 'veja os pacotes maiores'}.`, [{ tipo: 'PACOTE', codigo, id: codigo }]);
        if (nenhum) passar(e, 'NEGOCIACAO');
        sugeriu = true;
        fila.push(...cabem.map((x) => x.codigo));
      }
      else if (r.erro === 'INDISPONIVEL') dizer(e, `O pacote ${nome} não é oferecido nesse dia e período.`, [{ tipo: 'PACOTE', codigo, id: codigo }]);
      else { dizer(e, r.erro === 'SOB_CONSULTA' ? `O pacote ${nome} nessa data e período é sob consulta: a equipe confirma o valor.` : `Não consegui calcular o valor do pacote ${nome} para essa data e período pelo sistema.`); passar(e, r.erro === 'SOB_CONSULTA' ? 'NEGOCIACAO' : 'INFORMACAO_INDISPONIVEL'); }
      continue;
    }
    dizer(e, `${nome} em ${dataBr(e.ctx.data!)}${turnoTexto(e.catalogos, e.ctx.turno) ? `, ${turnoTexto(e.catalogos, e.ctx.turno)!.toLowerCase()}` : ""}, ${e.ctx.convidados} convidados: ${moeda(r.valor)}${r.minimoAplicado ? ` (o pacote cobra no mínimo ${r.convidadosFaturados} convidados)` : ''}${r.desconto ? ` com o desconto “${r.desconto.titulo ?? `${r.desconto.percentual}%`}” já aplicado` : ''}, pela tabela “${r.tabela.nome}”. Valor de tabela, calculado agora; condições finais na contratação.`,
      [{ tipo: 'TABELA_PRECO', id: r.tabela.id, codigo: r.tabela.codigo }, { tipo: 'PACOTE', codigo, id: codigo }]);
    // Data ou período trocados NESTA mensagem ("e se mudar pra 06/02, fica mais barato?"): compara com a condição
    // anterior, pela mesma tabela (o valor de antes é recalculado agora, nunca lembrado).
    const deData = e.correcoesNovas.find((x) => x.campo === 'data')?.de, deTurno = e.correcoesNovas.find((x) => x.campo === 'turno')?.de;
    if (k === 0 && (typeof deData === 'string' || typeof deTurno === 'string')) {
      const data0 = typeof deData === 'string' ? deData : e.ctx.data!, turno0 = typeof deTurno === 'string' ? deTurno : e.ctx.turno!;
      const r0 = data0 >= e.catalogos.hoje ? await e.fontes.preco(codigo, data0, turno0, e.ctx.convidados!) : null;
      if (r0 && !('erro' in r0)) {
        const dif = r.valor - r0.valor;
        const quando = `${dataBr(data0)}${turnoTexto(e.catalogos, turno0) ? `, ${turnoTexto(e.catalogos, turno0)!.toLowerCase()}` : ''}`;
        dizer(e, dif === 0 ? `É o mesmo valor de ${quando}.` : `${moeda(Math.abs(dif))} a ${dif < 0 ? 'menos' : 'mais'} que em ${quando} (${moeda(r0.valor)}).`, [{ tipo: 'TABELA_PRECO', id: r0.tabela.id, codigo: r0.tabela.codigo }]);
      }
    }
  }
}
/** "Vcs tem unidade em Águas Claras?", "vocês ficam em Taguatinga?": existência de unidade, pelo cadastro oficial. */
const EXISTE_UNIDADE = /\b(?:(?:tem|tem uma|existe|possuem|possui) (?:alguma )?unidades? (?:em|no|na|nos|nas|perto|proxim\w*|la)|(?:voces|vcs|o buffet) (?:ficam|fica|estao|esta|atendem) (?:em|no|na|nas|nos) [a-z])/;
async function localizacao(e: Estado) {
  const tt = semAcento(e.texto);
  // Existência de unidade: a citada está no cadastro (o endereço dela segue); sem unidade cadastrada no lugar pedido, as
  // unidades cadastradas — nunca "não temos" além do cadastro.
  const unidadeDaMensagem = e.entendimento.entidades.unidade;
  if (EXISTE_UNIDADE.test(tt)) {
    if (unidadeDaMensagem) dizer(e, `Sim: a unidade ${nomeUnidade(e.catalogos, unidadeDaMensagem) ?? unidadeDaMensagem} está no nosso cadastro.`);
    else if (e.catalogos.unidades.length) dizer(e, `As unidades cadastradas são ${lista(e.catalogos.unidades.map((u) => u.nome))}.`);
  }
  // "As duas", "ambas", "cada uma": todas, mesmo com uma unidade já anotada na conversa.
  // Rodada 30: as duas citadas sem troca ("o endereço da Asa Sul e de Águas Claras?") também.
  const todasPedidas = /\b(duas|ambas|todas as|as duas|cada uma das) unidades\b|\bunidades\b[^.?!]{0,15}\b(ambas|as duas|todas)\b|\b(das|de) (duas|ambas)\b|\b(as|das) duas\b/.test(tt)
    || unidadesDeDestino(e.texto, e.catalogos.unidades).length > 1;
  if (todasPedidas || ((/\b(quais|que|quantas) (sao )?(as )?unidades|unidades (voces|vcs|que voces|que vcs) tem\b/.test(tt) || (EXISTE_UNIDADE.test(tt) && !unidadeDaMensagem)) && !e.ctx.unidade)) {
    const todas = await e.fontes.prontasAutorizadas('LOCALIZACAO');
    if (todas.length) { for (const p of todas.slice(0, 3)) usarMaterial(e, p); return; }
  }
  const { itens, faltaUnidade } = await materiais(e, 'LOCALIZACAO', 'LOCALIZACAO');
  if (faltaUnidade) return;
  if (!itens.length) { dizer(e, 'Ainda não tenho o endereço cadastrado para enviar por aqui.'); passar(e, 'INFORMACAO_INDISPONIVEL'); return; }
  for (const p of itens.slice(0, 2)) usarMaterial(e, p);
}
async function disponibilidade(e: Estado, para: TipoIntencao = 'DISPONIBILIDADE') {
  if (!e.ctx.data) { perguntar(e, 'data', para); return null; }
  // Rodada 44 (h43 aa76): "e no outro horário?" sem período na conversa — "outro" de nenhum: pergunta o período (como no
  // preço desde a rodada 38), sem repetir a consulta já feita.
  if (para === 'DISPONIBILIDADE' && /\b(?:o |no |do |pro |pra )?outro (?:horario|turno|periodo)\b/.test(semAcento(e.texto)) && !e.ctx.turno && !e.entendimento.entidades.turno) { perguntar(e, 'turno', para); return null; }
  // "E se fosse num domingo?" depois de consultar uma data: outro dia sem dizer qual. Consultar a mesma data não responde;
  // pergunta qual (a data anterior fica na memória até a nova chegar).
  if (e.entendimento.outraData && para === 'DISPONIBILIDADE' && !e.entendimento.entidades.data) { dizer(e, AGENDA_POR_DATA); perguntar(e, 'data', para); return null; }
  if ((e.catalogos.unidadesAgenda ?? []).length > 1 && !e.ctx.unidade) { perguntar(e, 'unidade', para); return null; }
  let periodos: PeriodoAgenda[], escopo: EscopoAgendaConsultado;
  const consultadoEm = new Date().toISOString();
  try { ({ periodos, escopo } = await e.fontes.disponibilidade(e.ctx.data, e.ctx.unidade ?? null)); }
  catch { dizer(e, 'Não consegui consultar a agenda agora.'); passar(e, 'FALHA'); return null; }
  // A resposta diz o escopo que FOI consultado: "na unidade X" só quando a agenda é da própria unidade. Unidade pedida
  // sem agenda própria: a consulta é da empresa (todas as unidades) e a resposta diz isso, sem atribuir à unidade.
  const unidadeConsultada = escopo.tipo === 'UNIDADE' ? escopo.unidadeId : null;
  const fonte: Fonte = { tipo: 'AGENDA', data: e.ctx.data, escopo: escopo.tipo, unidade: unidadeConsultada, consultadoEm };
  const nomeConsultada = unidadeConsultada ? nomeUnidade(e.catalogos, unidadeConsultada) ?? 'escolhida' : null;
  const dia = `${dataBr(e.ctx.data)} (${diaSemana(e.ctx.data)})${nomeConsultada ? `, na unidade ${nomeConsultada}` : ''}`;
  if (e.ctx.unidade && unidadeConsultada !== e.ctx.unidade) dizer(e, `A agenda ainda não é separada por unidade: a consulta abaixo vale para ${escopo.tipo === 'EMPRESA' ? 'todas as unidades da empresa' : 'a agenda geral'}, não só para a unidade ${nomeUnidade(e.catalogos, e.ctx.unidade) ?? 'escolhida'}.`, [fonte]);
  const doTurno = e.ctx.turno ? periodos.find((p) => p.codigo === e.ctx.turno) : null;
  const livres = periodos.filter((p) => p.disponivel);
  let disponivel: boolean, mesmoDia = false;
  if (doTurno) {
    disponivel = doTurno.disponivel;
    dizer(e, disponivel ? `Consultei a agenda agora: ${dia}, ${doTurno.nome.toLowerCase()} (${hora(doTurno.inicio)} às ${hora(doTurno.fim)}), está disponível.` : `Consultei a agenda agora: ${dia}, ${doTurno.nome.toLowerCase()} (${hora(doTurno.inicio)} às ${hora(doTurno.fim)}), já está ocupado.`, [fonte]);
    // Mesmo dia, outro período livre: a alternativa mais próxima é no próprio dia (sem procurar outras datas).
    const outros = livres.filter((p) => p.codigo !== doTurno.codigo);
    if (!disponivel && outros.length) { mesmoDia = true; dizer(e, `No mesmo dia, ${lista(outros.map((p) => `${p.nome.toLowerCase()} (${hora(p.inicio)} às ${hora(p.fim)})`))} ${outros.length > 1 ? 'estão livres' : 'está livre'}.`, [fonte]); }
  } else if (!periodos.length) {
    disponivel = false; dizer(e, `Consultei a agenda agora: não há horários de festa em ${dia}.`, [fonte]);
  } else {
    disponivel = livres.length > 0;
    // Rodada 43: horários claros e concordância com qualquer nome cadastrado ("estão livres os períodos almoço (11h às 15h) e
    // noite (17h às 21h)", "está livre o período noite (17h às 21h)").
    dizer(e, livres.length ? `Consultei a agenda agora: em ${dia}, ${livres.length > 1 ? 'estão livres os períodos' : 'está livre o período'} ${lista(livres.map((p) => `${p.nome.toLowerCase()} (${hora(p.inicio)} às ${hora(p.fim)})`))}.` : `Consultei a agenda agora: ${dia} está sem horários livres.`, [fonte]);
    if (livres.length > 1 && !e.ctx.turno && para === 'CONTRATAR') perguntar(e, 'turno', para);
  }
  if (!disponivel && !mesmoDia) {
    try {
      const alt = await e.fontes.alternativas(e.ctx.data, e.ctx.unidade ?? null, e.ctx.turno ?? null, 3);
      if (alt.length) dizer(e, `Datas próximas com horário livre: ${lista(alt.map((a) => `${dataBr(a.data)} (${diaSemana(a.data)}, ${lista(a.periodos.map((p) => p.nome.toLowerCase()))})`))}.`, alt.map((a) => ({ tipo: 'AGENDA', data: a.data, escopo: escopo.tipo, unidade: unidadeConsultada, consultadoEm } as Fonte)));
    } catch { /* alternativas são opcionais: a resposta principal já foi dada */ }
  }
  // Rodada 43: o aviso de reserva uma vez por conversa (não a cada consulta da agenda).
  if (!e.ctx.avisoReserva) { dizer(e, RESERVA_SO_COM_CONTRATACAO); e.ctx = { ...e.ctx, avisoReserva: true }; }
  return disponivel;
}
async function pacotes(e: Estado) {
  const todos = await e.fontes.pacotes();
  if (!todos.length) { dizer(e, 'Ainda não tenho os pacotes cadastrados para explicar por aqui.'); passar(e, 'INFORMACAO_INDISPONIVEL'); return; }
  // Comparação com o pacote da conversa ("e a diferença dele pro Completa?"): os dois, na ordem da conversa.
  const doTexto = e.entendimento.entidades.pacotes;
  const n = e.entendimento.entidades.convidados;
  // "E pra 90 serve?" (curta, sem pacote, depois de falar do Premium): é o pacote da conversa; "algum pacote serve pra 90?"
  // continua sendo sobre todos.
  const t = semAcento(e.texto);
  const doContexto = !doTexto.length && !!e.ctx.pacote && !!n && CABE.test(t) && !/\b(pacotes|algum|alguns|qual|quais|nenhum|todos|outro|outros)\b/.test(t) && t.trim().split(/\s+/).length <= 6;
  const citados = doContexto ? [e.ctx.pacote!] : e.entendimento.comparar && doTexto.length === 1 && e.ctx.pacote && !doTexto.includes(e.ctx.pacote) ? [e.ctx.pacote, ...doTexto] : doTexto;
  const escolhidos = (citados.length ? citados.map((c) => todos.find((p) => p.codigo === c)).filter((p): p is PacoteResumo => !!p) : todos).slice(0, 4);
  // "O Premium cabe 150 pessoas?": resposta direta pela faixa cadastrada.
  const unico = escolhidos.length === 1 ? escolhidos[0] : null;
  if (n && unico?.convidadosMaximos && CABE.test(semAcento(e.texto))) {
    const cabe = n <= unico.convidadosMaximos && (!unico.convidadosMinimos || n >= unico.convidadosMinimos);
    // O pacote da conversa não comporta ("e pra 90 serve?" com o Essencial): diz também quais comportam, pelo cadastro.
    const outros = !cabe && doContexto ? todos.filter((p) => p.codigo !== unico.codigo && (!p.convidadosMaximos || n <= p.convidadosMaximos) && (!p.convidadosMinimos || n >= p.convidadosMinimos)) : [];
    dizer(e, `${cabe ? 'Sim' : 'Não'}: o pacote ${unico.nome} é para ${unico.convidadosMinimos ? `${unico.convidadosMinimos} a ${unico.convidadosMaximos}` : `até ${unico.convidadosMaximos}`} convidados${outros.length ? `; para ${n}, ${lista(outros.map((p) => `o pacote ${p.nome}`))} ${outros.length > 1 ? 'comportam' : 'comporta'}` : !cabe && (doContexto || !todos.some((p) => !p.convidadosMaximos || n <= p.convidadosMaximos)) ? `; para ${n}, nenhum pacote cadastrado comporta` : ''}.`,
      [unico, ...outros].map((p) => ({ tipo: 'PACOTE', codigo: p.codigo, id: p.id } as Fonte)));
  } else if (n && !unico && CABE.test(semAcento(e.texto))) {
    // "Cabe 160 em algum pacote?": quais comportam, pela faixa cadastrada (nenhum: diz o maior, sem prometer exceção).
    const cabem = todos.filter((p) => (!p.convidadosMaximos || n <= p.convidadosMaximos) && (!p.convidadosMinimos || n >= p.convidadosMinimos));
    const maior = [...todos].filter((p) => p.convidadosMaximos).sort((a, b) => b.convidadosMaximos! - a.convidadosMaximos!)[0];
    dizer(e, cabem.length ? `Para ${n} convidados: ${lista(cabem.map((p) => `o pacote ${p.nome} (${p.convidadosMinimos ? `${p.convidadosMinimos} a ` : 'até '}${p.convidadosMaximos})`))}.`
      : `Para ${n} convidados, nenhum pacote cadastrado comporta${maior ? `: o maior, o pacote ${maior.nome}, vai até ${maior.convidadosMaximos}` : ''}.`, (cabem.length ? cabem : maior ? [maior] : []).map((p) => ({ tipo: 'PACOTE', codigo: p.codigo, id: p.id } as Fonte)));
  }
  const horasPedidas = /\b(\d+|uma|duas|tres|quatro|cinco|seis) horas\b/.exec(semAcento(e.texto));
  // Rodada 18: "e quanto tempo dura?" (pacote da conversa ou citado): a duração cadastrada, sem repetir a lista inteira.
  if (DURACAO.test(t) && !horasPedidas && !CABE.test(t) && !/\b(diferenc\w*|compar\w*|melhor|pacotes|quais)\b/.test(t)) {
    const alvo = doTexto.length ? todos.filter((p) => doTexto.includes(p.codigo)) : e.ctx.pacote ? todos.filter((p) => p.codigo === e.ctx.pacote) : todos;
    const com = alvo.filter((p) => p.duracaoMinutos);
    const dur = (p: PacoteResumo) => (p.duracaoMinutos! % 60 === 0 ? `${p.duracaoMinutos! / 60} horas` : `${p.duracaoMinutos} minutos`);
    // Rodada 28 (h28 aa51): "até quantas pessoas ele vai e quanto tempo dura": a faixa de convidados cadastrada junto.
    const faixa = (p: PacoteResumo) => (p.convidadosMaximos ? (p.convidadosMinimos ? `${p.convidadosMinimos} a ${p.convidadosMaximos}` : `até ${p.convidadosMaximos}`) : null);
    const pedeCapacidade = /\b(?:quantas pessoas|quantos convidados|ate quant[oa]s|capacidade|maximo de (?:pessoas|convidados))\b/.test(t);
    if (com.length) {
      const capacidade = pedeCapacidade ? com.filter((p) => faixa(p)) : [];
      dizer(e, com.length === 1
        ? `O pacote ${com[0].nome}${capacidade.length ? ` é para ${faixa(com[0])} convidados e` : ''} tem ${dur(com[0])} de festa.`
        : `${capacidade.length ? 'Convidados e duração' : 'Duração'} de cada pacote: ${com.map((p) => `${p.nome}, ${capacidade.includes(p) ? `${faixa(p)} convidados e ` : ''}${dur(p)}`).join('; ')}.`, com.map((p) => ({ tipo: 'PACOTE', codigo: p.codigo, id: p.id } as Fonte)));
      return;
    }
  }
  if (unico?.duracaoMinutos && horasPedidas && !CABE.test(semAcento(e.texto))) {
    const pedidas = Number(horasPedidas[1]) || ({ uma: 1, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6 } as Record<string, number>)[horasPedidas[1]];
    const reais = unico.duracaoMinutos / 60;
    dizer(e, `${pedidas === reais ? 'Sim' : 'Não'}: o pacote ${unico.nome} tem ${reais % 1 === 0 ? reais : unico.duracaoMinutos + ' minutos'}${reais % 1 === 0 ? ' horas' : ''} de festa.`, [{ tipo: 'PACOTE', codigo: unico.codigo, id: unico.id }]);
  }
  const linhas: string[] = [];
  const fontes: Fonte[] = [];
  const composicoes = new Map<string, Composicao | null>();
  for (const p of escolhidos) {
    const comp = await e.fontes.composicao(p.codigo);
    composicoes.set(p.codigo, comp);
    const partes = [
      p.convidadosMaximos ? (p.convidadosMinimos ? `de ${p.convidadosMinimos} a ${p.convidadosMaximos} convidados` : `até ${p.convidadosMaximos} convidados`) : null,
      p.duracaoMinutos ? `${p.duracaoMinutos % 60 === 0 ? `${p.duracaoMinutos / 60} horas` : `${p.duracaoMinutos} minutos`} de festa` : null,
      comp?.categorias.length ? `buffet com ${lista(comp.categorias.map((c) => c.nome.toLowerCase()))}` : null,
      comp?.inclusos.length ? `inclui ${lista(comp.inclusos.slice(0, 5).map((i) => i.nome))}` : null,
    ].filter(Boolean);
    linhas.push(`• ${p.nome}: ${partes.join('; ')}.${p.descricao ? ` ${p.descricao}` : ''}`);
    fontes.push({ tipo: 'PACOTE', codigo: p.codigo, id: p.id });
  }
  dizer(e, `${escolhidos.length > 1 ? 'Nossos pacotes' : 'O pacote'}:\n${linhas.join('\n')}`, fontes);
  if (escolhidos.length === 2) dizer(e, diferencas(escolhidos[0], escolhidos[1], composicoes.get(escolhidos[0].codigo) ?? null, composicoes.get(escolhidos[1].codigo) ?? null), fontes);
  // Rodada 24: comparação de custo sem a palavra preço ("compensa mais o Essencial ou o Completa?") também pede o valor.
  const pedePreco = e.entendimento.intencoes.some((i) => i.tipo === 'PRECOS') || /\b(?:compensa\w*|mais (?:barato|caro|em conta)|vale (?:mais )?a pena|custo|quanto|valor\w*|preco\w*)\b/.test(semAcento(e.texto));
  // Rodada 24: com tudo conhecido, o valor só sai se o preço foi pedido ("cabem 45 no essencial?" não traz o preço).
  const tudoConhecido = !!(e.ctx.data && (e.ctx.turno || !e.catalogos.turnos.length) && e.ctx.convidados);
  // A não ser que a mensagem complete o valor que estava pendente ("seremos 80" quando faltavam os convidados).
  const completaValorPendente = e.ctx.pendente?.para === 'PACOTES' && !e.ctx.pendente.opcional;
  if (tudoConhecido && !pedePreco && !completaValorPendente) return;
  // A comparação já respondeu: o valor exato é convite ("se quiser, me conte a data..."), não uma pergunta que falta.
  await precoCalculado(e, !pedePreco && escolhidos.length <= 2, escolhidos.length <= 2 ? escolhidos.map((p) => p.codigo) : undefined, 'PACOTES', true);
}
/** "Quanto tempo dura?", "qnto tempo dura a festa", "qual a duração" (rodada 18). */
const DURACAO = /\b(?:(?:quanto|qnto|qto|qnt) tempo|duracao|(?:dura|duram|vai durar) quanto|quantas horas)\b/;
/** "Cabe 150 pessoas?", "e pra 90 serve?" */
const CABE = /\b(tem algum|algum (?:pacote|serve|comporta|cabe)|vai ate|vao ate|cabe|cabem|comporta|comportam|suporta|suportam|aguenta|aguentam|atende|atendem|serve (pra|para)|servem (pra|para)|da pra|(fazem|faz|realizam|realiza)( festas?| eventos?| aniversarios?)? (pra|para|com|de) (umas |uns |cerca de |mais ou menos |aproximadamente |quase |ate )?\S+ (pessoas|convidados|criancas)|(pra|para) (ate )?\d+( pessoas| convidados| criancas)?,? (ainda |tambem |tb )?(serve|servem)|(qual|que|quais) (pacote|plano|pacotes|planos) (serve|servem|comporta|comportam|cabe|cabem|atende|atendem)|(pra|para) (umas |uns |cerca de |ate )?\d+ (pessoas|convidados|criancas)\b[^.?!]{0,20}\b(qual|que|quais) (pacote|plano)|(consegue|conseguem|da pra|dá pra|pode|podem) fazer (o |a )?\S+ (pra|para|com) \S+ (pessoas|convidados|criancas)|(qual|que|quais) (seria |e |eh |vcs indicam |voces indicam )?(o |a )?(pacote |plano |opcao )?(indicad\w*|ideal|melhor|recomendad\w*|mais indicad\w*|certo|adequad\w*)|(qual|que|quais) (voces|vcs) (indicam|recomendam|sugerem))\b/;
/** "A gente paga a diferença", "pago o extra", "cobrimos o que passar": pagar para passar do limite. */
/** "Pagando o mesmo valor", "pelo mesmo preço": passar do limite sem mudar o valor (rodada 17). */
const MESMO_VALOR = /\b(?:(?:pagando|pagar|pago|pagaria|pagariamos|cobrando|cobrar|cobrem|cobra|cobraria|mantendo|manter|mantem) (?:o )?mesmo (?:valor|preco)|pelo mesmo (?:valor|preco))\b/;
const PAGA_DIFERENCA = /\b(?:paga|pago|pagamos|pagaria|pagariamos|pagar|cubro|cobrimos|cobre|bancamos|banco)\b[^.?!]{0,20}\b(?:a diferenca|o excedente|o extra|um extra|o a mais|a mais|o adicional|o que passar|mais caro|uma taxa)\b/;
/**
 * Convidados acima da faixa cadastrada (do pacote citado ou da conversa; sem pacote, de todos) com a oferta de pagar a
 * diferença: diz o limite do cadastro e passa para a equipe como exceção. Nunca sugere que pagar libera o limite.
 */
async function excecaoDeCapacidadePaga(e: Estado) {
  const n = e.entendimento.entidades.convidados ?? e.ctx.convidados;
  const paga = PAGA_DIFERENCA.test(semAcento(e.texto));
  if (!n || !(paga || MESMO_VALOR.test(semAcento(e.texto)))) return false;
  let todos: PacoteResumo[] = [];
  try { todos = await e.fontes.pacotes(); } catch { return false; }
  const codigo = e.entendimento.entidades.pacotes.length === 1 ? e.entendimento.entidades.pacotes[0] : e.ctx.pacote;
  const p = codigo ? todos.find((x) => x.codigo === codigo) : undefined;
  const maior = [...todos].filter((x) => x.convidadosMaximos).sort((a, b) => b.convidadosMaximos! - a.convidadosMaximos!)[0];
  const limite = p?.convidadosMaximos ? p : maior;
  if (!limite?.convidadosMaximos || n <= limite.convidadosMaximos) return false;
  const cabem = todos.filter((x) => x !== limite && (!x.convidadosMaximos || x.convidadosMaximos >= n) && (!x.convidadosMinimos || x.convidadosMinimos <= n));
  dizer(e, `O pacote ${limite.nome} é para até ${limite.convidadosMaximos} convidados (cadastro)${cabem.length ? `; para ${n}, ${lista(cabem.map((x) => `o pacote ${x.nome}`))} ${cabem.length > 1 ? 'comportam' : 'comporta'}` : ''}. Passar do limite é exceção que só a equipe pode avaliar${paga ? ', mesmo pagando a diferença' : ''}.`,
    [limite, ...cabem].map((x) => ({ tipo: 'PACOTE', codigo: x.codigo, id: x.id } as Fonte)));
  passar(e, 'NEGOCIACAO');
  return true;
}
/** Diferenças entre dois pacotes pelo cadastro (faixa de convidados, duração, buffet e inclusos): só o que difere. */
function diferencas(a: PacoteResumo, b: PacoteResumo, ca: Composicao | null, cb: Composicao | null) {
  const faixa = (p: PacoteResumo) => (p.convidadosMaximos ? (p.convidadosMinimos ? `${p.convidadosMinimos} a ${p.convidadosMaximos}` : `até ${p.convidadosMaximos}`) : 'sem faixa cadastrada');
  const horas = (p: PacoteResumo) => (p.duracaoMinutos ? (p.duracaoMinutos % 60 === 0 ? `${p.duracaoMinutos / 60} horas` : `${p.duracaoMinutos} minutos`) : 'sem duração cadastrada');
  const partes: string[] = [];
  if (faixa(a) !== faixa(b)) partes.push(`convidados (${a.nome}: ${faixa(a)}; ${b.nome}: ${faixa(b)})`);
  if (horas(a) !== horas(b)) partes.push(`duração (${a.nome}: ${horas(a)}; ${b.nome}: ${horas(b)})`);
  const cats = (c: Composicao | null) => new Map((c?.categorias ?? []).map((x) => [x.nome, x] as const));
  const [ma, mb] = [cats(ca), cats(cb)];
  const soA = [...ma.keys()].filter((k) => !mb.has(k)), soB = [...mb.keys()].filter((k) => !ma.has(k));
  if (soA.length) partes.push(`só o pacote ${a.nome} tem ${lista(soA.map((x) => x.toLowerCase()))} no buffet`);
  if (soB.length) partes.push(`só o pacote ${b.nome} tem ${lista(soB.map((x) => x.toLowerCase()))} no buffet`);
  let buffetIgual = !!ma.size && !soA.length && !soB.length;
  for (const [nome, x] of ma) {
    const y = mb.get(nome);
    if (y && (x.escolhasMax !== y.escolhasMax || x.itens.length !== y.itens.length)) { buffetIgual = false; partes.push(`${nome.toLowerCase()} (${a.nome}: até ${x.escolhasMax} entre ${x.itens.length}; ${b.nome}: até ${y.escolhasMax} entre ${y.itens.length})`); }
  }
  const inc = (c: Composicao | null) => (c?.inclusos ?? []).map((i) => i.nome);
  const iA = inc(ca).filter((x) => !inc(cb).includes(x)), iB = inc(cb).filter((x) => !inc(ca).includes(x));
  if (iA.length) partes.push(`só o pacote ${a.nome} inclui ${lista(iA)}`);
  if (iB.length) partes.push(`só o pacote ${b.nome} inclui ${lista(iB)}`);
  if (!partes.length) return `Pelo cadastro, o pacote ${a.nome} e o pacote ${b.nome} têm a mesma faixa de convidados, a mesma duração e o mesmo buffet.`;
  return `Diferenças entre o pacote ${a.nome} e o pacote ${b.nome}: ${partes.join('; ')}.${buffetIgual ? ' O buffet cadastrado é o mesmo nos dois.' : ''}`;
}
/** "Tem coxinha?": pelo buffet cadastrado do pacote da conversa (ou de todos), sem mandar o cardápio inteiro de novo. */
async function itensDoBuffet(e: Estado, itens: string[]) {
  const alvo = e.entendimento.entidades.pacotes.length ? e.entendimento.entidades.pacotes : e.ctx.pacote ? [e.ctx.pacote] : e.catalogos.pacotes.map((p) => p.codigo);
  const mesmo = (a: string, b: string) => semAcento(a).trim() === semAcento(b).trim();
  const nomes = (cods: string[]) => lista(cods.map((c) => `do pacote ${nomePacote(e.catalogos, c) ?? c}`));
  const comps = new Map<string, Composicao | null>();
  for (const pacote of alvo) comps.set(pacote, await e.fontes.composicao(pacote));
  const linhas: string[] = [];
  const fontes: Fonte[] = [];
  for (const item of itens) {
    const achados = alvo.map((pacote) => ({ pacote, categoria: comps.get(pacote)?.categorias.find((c) => c.itens.some((i) => mesmo(i, item))) }))
      .filter((x): x is { pacote: string; categoria: Composicao['categorias'][number] } => !!x.categoria);
    if (achados.length) linhas.push(`${item}: sim, faz parte do buffet ${achados.length === alvo.length && alvo.length > 2 ? 'de todos os pacotes' : nomes(achados.map((x) => x.pacote))} (${achados[0].categoria.nome.toLowerCase()}, escolha até ${achados[0].categoria.escolhasMax}).`);
    else linhas.push(`${item} não está no buffet cadastrado ${nomes(alvo)}.`);
    fontes.push(...(achados.length ? achados.map((x) => x.pacote) : alvo).map((p) => ({ tipo: 'CATALOGO_BUFFET', pacote: p } as Fonte)));
  }
  dizer(e, linhas.join('\n'), [...new Map(fontes.map((f) => [JSON.stringify(f), f])).values()]);
}
async function cardapio(e: Estado) {
  if (e.entendimento.alergia) return; // tratado à parte: a equipe confirma
  const pratos = e.entendimento.itens ?? [];
  const alvo = e.entendimento.entidades.pacotes.length ? e.entendimento.entidades.pacotes.slice(0, 2) : e.ctx.pacote ? [e.ctx.pacote] : e.catalogos.pacotes.length === 1 ? [e.catalogos.pacotes[0].codigo] : [];
  // Buffet cadastrado dos pacotes em questão (sem pacote, de todos): categorias e itens, para saber o que tem fonte.
  const comps = new Map<string, Composicao | null>();
  for (const pacote of alvo.length ? alvo : e.catalogos.pacotes.map((p) => p.codigo)) comps.set(pacote, await e.fontes.composicao(pacote));
  const doBuffet = [...comps.values()].flatMap((c) => (c?.categorias ?? []).flatMap((x) => [x.nome, ...x.itens])).map((n) => semAcento(n));
  // Bolo, doces e bebidas: sem categoria nem item no buffet cadastrado, o cadastro não diz se vem nem se não vem ("como
  // é o bolo do Premium?", "quais doces vêm?"). O que está no trecho do item de fora ("levar o bolo da tia") fica com ele;
  // "tirar o bolo do pacote" é negociação (a equipe já recebe).
  const familias = [/\bbolos?\b/, /\b(?:mesas? de doces|algodao doce|doces?|docinhos?|brigadeiros?|beijinhos?|sobremesas?|cupcakes?|bem casados?)\b/, /\b(?:bebidas?(?! alcool)|refri\w*|sucos?|agua de coco)\b/];
  const cadastrado = (nome: string) => { const n = semAcento(nome); return doBuffet.some((x) => x.startsWith(n.slice(0, 4))) || familias.some((re) => re.test(n) && doBuffet.some((x) => re.test(x))); };
  let t = semAcento(e.texto).replace(/\bmesas? d[eo]s? (bolo|bolos|doces?|docinhos|parabens)\b/g, 'mesa tematica');
  for (const i of e.entendimento.intencoes) if (i.tipo === 'EXTERNO') t = t.replace(semAcento(i.trecho), ' ');
  // Prato pedido que não está no catálogo ("tem cachorro-quente no cardápio?", "coxinha, kibe e empadinha"): não é
  // suposto; a equipe confirma. Os pratos cadastrados citados junto são respondidos antes.
  const fora = (e.entendimento.pratoSemCadastro ?? '').split(/\s*,\s*|\s+e\s+/).filter((x) => x && !cadastrado(x));
  const negociacao = e.entendimento.intencoes.some((i) => i.tipo === 'NEGOCIACAO');
  const grupos = negociacao ? [] : familias.map((re) => re.exec(t)?.[0]).filter((x): x is string => !!x && !cadastrado(x) && !fora.some((f) => f.includes(x)));
  if (fora.length || grupos.length) {
    if (pratos.length) await itensDoBuffet(e, pratos);
    const maiuscula = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
    if (fora.length) dizer(e, `${maiuscula(lista(fora))}: não está no buffet cadastrado; a equipe confirma se dá para incluir.`);
    if (grupos.length) dizer(e, `${maiuscula(lista(grupos))}: ${grupos.length > 1 ? 'não estão' : 'não está'} no buffet cadastrado; a equipe confirma essa parte.`);
    passar(e, 'INFORMACAO_INDISPONIVEL');
    return;
  }
  const troca = /\b(troc\w*|substitu\w*|no lugar d[oa]s?)\b/.test(t);
  if (troca) dizer(e, 'No buffet cadastrado, cada categoria é de escolha entre as opções do pacote; item fora dessas opções a equipe confirma.');
  // Troca entre dois itens cadastrados ("troca o kibe pela coxinha?"): os dois pelo cadastro; troca por "outro salgado",
  // as opções da categoria (abaixo).
  // "Vcs tem coxinha no buffet? e kibe tb?" (rodada 14): pergunta do item, respondida pelo cadastro — não pede o pacote
  // para mandar o cardápio inteiro.
  const soItem = /\b(tem|teria|vem|vai ter|servem|serve|inclui|incluem)\s+(?:o |a |um |uma |os |as )?[a-z]+(?: [a-z]+)?\s+(no|na) (buffet|cardapio|pacote|festa|menu)\b/.test(t) && !/\b(cardapio (completo|inteiro|todo)|manda\w* o cardapio|quais (sao )?(os |as )?(itens|opcoes))\b/.test(t);
  // Rodada 37 (h14 g26): "não precisa mandar o pdf do cardápio de novo, só me fala se tem coxinha": responde o item, sem o
  // cardápio inteiro nem o PDF dispensado.
  if (pratos.length && (!troca || pratos.length >= 2)) { await itensDoBuffet(e, pratos); if (troca || soItem || !pedeIntencao(e.texto, 'CARDAPIO') || cardapioDispensado(semAcento(e.texto))) return; }
  const { itens } = await materiais(e, 'CARDAPIO', 'CARDAPIO');
  const escolha = (c: Composicao['categorias'][number]) => (c.escolhasMin && c.escolhasMin !== c.escolhasMax ? ` (escolha de ${c.escolhasMin} a ${c.escolhasMax})` : ` (escolha até ${c.escolhasMax})`);
  const opcoes = (c: Composicao['categorias'][number]) => (!c.itens.length ? '' : `: ${c.itens.length > 8 ? `${c.itens.slice(0, 8).join(', ')} e mais ${c.itens.length - 8}` : c.itens.join(', ')}`);
  if (!alvo.length) {
    // "Quantos tipos de salgado posso escolher? quais as opções?" sem pacote: a categoria citada, igual em todos os
    // pacotes, não depende do pacote; o cardápio inteiro ("me manda o cardápio") depende, e o pacote é perguntado. Só
    // quando pergunta o que tem ("vocês fritam os salgados?" não se responde com a lista).
    const todas = [...comps.values()];
    const igual = (a: Composicao['categorias'][number], b: Composicao['categorias'][number]) => a.nome === b.nome && a.escolhasMin === b.escolhasMin && a.escolhasMax === b.escolhasMax && a.itens.join('|') === b.itens.join('|');
    const citadas = (todas[0]?.categorias ?? []).filter((c) => { const raiz = semAcento(c.nome).replace(/[^a-z0-9]/g, '').slice(0, Math.max(4, c.nome.length - 2)); return raiz.length >= 4 && new RegExp(`\\b${raiz}`).test(t) && todas.every((x) => x?.categorias.some((y) => igual(c, y))); });
    const pedeLista = /\b(quais|quantos|quantas|qual|opcoes|opcao|tipos|sabores|escolher|escolho|escolha|lista|listar|vem|vao|tem|inclui|incluem|servem|oferecem|troc\w*|substitu\w*)\b/.test(t);
    if (todas.length > 1 && citadas.length && pedeLista) {
      dizer(e, `Em todos os pacotes:\n${citadas.map((c) => `• ${c.nome}${escolha(c)}${opcoes(c)}`).join('\n')}`, [...comps.keys()].map((pacote) => ({ tipo: 'CATALOGO_BUFFET', pacote } as Fonte)));
      itens.filter((p) => !p.pacoteCodigo).slice(0, 2).forEach((p) => usarMaterial(e, p));
      return;
    }
    itens.filter((p) => !p.pacoteCodigo).slice(0, 2).forEach((p) => usarMaterial(e, p));
    perguntar(e, 'pacote', 'CARDAPIO');
    return;
  }
  for (const pacote of alvo) {
    const comp = comps.get(pacote) ?? null;
    const nome = nomePacote(e.catalogos, pacote) ?? pacote;
    if (!comp || !comp.categorias.length) { dizer(e, `Ainda não tenho o buffet do pacote ${nome} cadastrado para detalhar por aqui.`); continue; }
    dizer(e, `Buffet do pacote ${nome}:\n${comp.categorias.map((c) => `• ${c.nome}${escolha(c)}${opcoes(c)}`).join('\n')}`, [{ tipo: 'CATALOGO_BUFFET', pacote }]);
  }
  itens.filter((p) => !p.pacoteCodigo || alvo.includes(p.pacoteCodigo)).slice(0, 2).forEach((p) => usarMaterial(e, p));
}
async function decoracao(e: Estado) {
  const { itens } = await materiais(e, 'DECORACAO', 'DECORACAO');
  const textos = itens.filter((p) => p.tipo === 'TEXTO' || p.tipo === 'LINK');
  // Rodada 21: o texto já enviado na conversa não volta a cada pergunta do assunto ("e quantos balões vêm?") quando
  // outra parte responde (pacote, itens); sem outra resposta, ele volta (a pergunta não fica sem fonte).
  const perguntaSeFazem = /\b(?:fazem|faz|faria|fariam|tem como|da pra|voces fazem|vcs fazem)\b[^.?!]{0,30}\b(?:decora|tema)|\bdecorac\w*\b[^.?!]{0,15}\?/.test(semAcento(e.texto));
  const textoRepetido = textos.length && !perguntaSeFazem && jaEnviado(e.ctx, textos[0].id, textos[0].versao) ? textos[0] : null;
  if (textos.length && !textoRepetido) usarMaterial(e, textos[0]);
  const respostasAntes = e.paragrafos.length + e.anexos.length;
  const pacote = e.entendimento.entidades.pacotes[0] ?? e.ctx.pacote ?? null;
  if (pacote) {
    const comp = await e.fontes.composicao(pacote);
    const inclusos = comp?.inclusos.filter((i) => semAcento(i.categoria).includes('decor')) ?? [];
    const extras = comp?.extras.filter((i) => semAcento(i.categoria).includes('decor')) ?? [];
    const nome = nomePacote(e.catalogos, pacote) ?? pacote;
    if (inclusos.length) dizer(e, `No pacote ${nome}, a decoração inclui ${lista(inclusos.map((i) => i.nome))}.`, [{ tipo: 'PACOTE', codigo: pacote, id: pacote }]);
    if (extras.length) dizer(e, `${lista(extras.slice(0, 5).map((i) => i.nome))} ${extras.length === 1 ? 'é adicional' : 'são adicionais'}, com custo à parte.`, [{ tipo: 'PACOTE', codigo: pacote, id: pacote }]);
  }
  itens.filter((p) => p.tipo === 'IMAGEM' || p.tipo === 'VIDEO' || p.tipo === 'DOCUMENTO').slice(0, 1).forEach((p) => usarMaterial(e, p));
  // "Painel e arco de balão são cobrados à parte?": responde o que o pacote tem cadastrado; balões têm cláusula no
  // contrato (tema BALOES); item sem cadastro vai para a equipe (nada é suposto).
  const t = semAcento(e.texto);
  if (CUSTO_DECORACAO.test(t)) {
    const comp = pacote ? await e.fontes.composicao(pacote) : null;
    const registrados = [...(comp?.inclusos ?? []), ...(comp?.extras ?? [])].map((i) => semAcento(i.nome));
    const citados = [...new Set([...t.matchAll(ITENS_DECORACAO)].map((m) => m[1]))].filter((x) => !/\b(balao|baloes|bexigas?)$/.test(x)); // balões: cláusula do contrato (tema BALOES)
    const semCadastro = citados.filter((x) => !registrados.some((r) => r.includes(x.slice(0, 5))));
    if (semCadastro.length) { dizer(e, `Não tenho cadastrado se ${lista(semCadastro)} ${semCadastro.length > 1 ? 'são cobrados' : 'é cobrado'} à parte${pacote ? ` no pacote ${nomePacote(e.catalogos, pacote) ?? pacote}` : ''}: a equipe confirma essa parte.`); passar(e, 'INFORMACAO_INDISPONIVEL'); }
  }
  // Cláusula do assunto na mesma mensagem ("quantos balões vêm?" → cláusula dos balões) também é resposta.
  const clausula = e.entendimento.intencoes.some((i) => i.tipo === 'CONTRATO' && !!i.tema && i.tema !== 'GERAL');
  if (textoRepetido && !clausula && e.paragrafos.length + e.anexos.length === respostasAntes) usarMaterial(e, textoRepetido);
  // O tema anotado numa mensagem anterior não é repetido ("quantos balões vêm?" depois de dizer o tema).
  // Rodada 21: tema ambíguo ("princesa ou sereia") não é anotado; o tema é confirmado.
  // Rodada 22: com indecisão, o convite é para quando decidir (a pendência do tema fica).
  if (e.entendimento.temaAmbiguo && !e.entendimento.entidades.tema) { dizer(e, TEMA_A_DECIDIR); perguntar(e, 'tema', 'DECORACAO'); return; }
  if (e.ctx.tema && e.entendimento.entidades.tema) dizer(e, `Anotei o tema “${e.ctx.tema}”. Se tiver fotos de referência, pode mandar por aqui que a equipe recebe.`);
  else if (!e.ctx.tema) perguntar(e, 'tema', 'DECORACAO', true);
}
const CUSTO_DECORACAO = /\b(cobrad\w*|cobra|cobram|a parte|separad\w*|inclus\w*|inclui|incluid\w*|vem no pacote|vem junto|custa|custo|pago|paga|extra|extras|adicional|adicionais)\b/;
const ITENS_DECORACAO = /\b(arcos? de (?:balao|baloes|bexigas?)|paineis|painel|arcos?|toalhas?|cenarios?|totens|totem|letreiros?|flores|arranjos?|centros? de mesa|bonecos?|tapetes?|backdrop|cortinas?|neon|bolo fake|mesa tematica|mesas? de doces|baloes|balao|bexigas?)\b/g;
/**
 * Item ou fornecedor de fora ("levar o bolo da tia", "o fotógrafo pode ser o nosso?"): só com REGRA PUBLICADA — pergunta
 * frequente cadastrada sobre o item (já respondida como DUVIDA) ou cláusula do modelo de contrato vigente que trate de
 * trazer o item. Sem regra, diz que não está cadastrada e passa ESSA parte para a equipe (o resto é respondido).
 */
async function externo(e: Estado, i: Intencao, intencoes: Intencao[]) {
  const item = itemExternoDoCliente(e.texto, i.trecho);
  const raiz = item ? semAcento(item).slice(0, 5) : null;
  const faq = raiz && intencoes.some((x) => x.tipo === 'DUVIDA' && e.config.perguntas.some((p) => p.id === x.perguntaId && semAcento(`${p.pergunta} ${p.resposta}`).includes(raiz)));
  if (faq) return;
  const modelo = modeloVigente(null);
  const clausula = raiz ? modelo?.clausulas.find((c) => { const tx = semAcento(c.texto); return tx.includes(raiz) && /\b(trouxer|trazer|levar|por conta propria|de fora|terceir)/.test(tx); }) : null;
  if (modelo && clausula) { dizer(e, `Pelo modelo de contrato vigente (versão ${modelo.templateVersao}):\nCláusula ${clausula.numero}: “${clausula.texto}”`, [{ tipo: 'CONTRATO_MODELO', modelo: modelo.modeloCodigo, versao: modelo.templateVersao, clausula: clausula.numero, sha256: clausula.sha256 }]); return; }
  dizer(e, `Sobre ${item ? `${item} de fora` : 'item ou fornecedor de fora'}: ainda não tenho essa regra cadastrada para responder por aqui. A equipe confirma essa parte.`);
  passar(e, 'INFORMACAO_INDISPONIVEL');
}
async function contrato(e: Estado, intencao: Intencao) {
  const tema = intencao.tema ?? 'GERAL';
  // Rodada 19: "tem multa se eu trocar de pacote?" — "multa" com outra mudança e sem desistir/cancelar/remarcar não é a
  // cláusula de desistência. Sem cláusula do assunto no modelo, nenhuma de outro assunto é citada: a equipe responde.
  if (tema === 'CANCELAMENTO' && MULTA_SEM_CLAUSULA(e.texto)) { dizer(e, 'Não encontrei essa condição no modelo de contrato cadastrado.'); passar(e, 'INFORMACAO_INDISPONIVEL'); return; }
  if (tema === 'SINAL') { dizer(e, 'O modelo de contrato vigente não tem uma cláusula de sinal. As condições de pagamento de cada festa ficam no Resumo da Contratação, preparado com a equipe.'); contratoPorAssunto(e); return; }
  if (tema === 'PAGAMENTO') { dizer(e, 'As condições de pagamento são definidas na contratação de cada festa (Resumo da Contratação). Para combinar a forma de pagamento, a equipe ajuda.'); contratoPorAssunto(e); return; }
  if (tema === 'GERAL') { if (!contratoPorAssunto(e)) dizer(e, 'Posso explicar as condições gerais do contrato: cancelamento, remarcação, aumento de convidados, cortesia de crianças, horários, bebidas, danos e limpeza. Qual ponto você quer saber?'); return; }
  // Rodada 16: aumento de convidados e excedente SEM pacote ("pago o excedente?", "cada convidado a mais sai quanto?",
  // "dá pra aumentar o número de convidados depois?"). A cláusula 3 é a fonte e só o valor por pessoa excedente muda por
  // pacote: cita a parte comum palavra por palavra e o valor de cada pacote, extraído da cláusula 3 dele (cada uma é uma
  // fonte com hash). Antes, sem pacote, só a cláusula 4 (cortesia de crianças) era citada — não respondia.
  if (tema === 'CONVIDADOS' && !e.ctx.pacote) {
    const porPacote = e.catalogos.pacotes.map((p) => ({ p, c: clausulasDoTema('CONVIDADOS', p.codigo).find((x) => x.clausula.numero === 3) })).filter((x): x is { p: typeof x.p; c: NonNullable<typeof x.c> } => !!x.c);
    if (porPacote.length) {
      const frases = porPacote.map(({ c }) => c.clausula.texto.split(/(?<=\.)\s+/));
      const comuns = frases[0].filter((f) => frases.every((fs) => fs.includes(f)));
      const valores = porPacote.map(({ p, c }) => ({ p, valor: /R\$\s?[\d.]+,\d{2}/u.exec(c.clausula.texto.split(/(?<=\.)\s+/).filter((f) => !comuns.includes(f)).join(' '))?.[0] ?? null }));
      const todosComValor = valores.every((x) => x.valor);
      const versao = porPacote[0].c.modelo.templateVersao;
      dizer(e, `Pelo modelo de contrato vigente (versão ${versao}):\nCláusula 3: “${comuns.join(' ')}”\n${todosComValor && comuns.length < frases[0].length ? `Convidado pagante que exceder o contratado no dia, por pessoa (cláusula 3 de cada pacote): ${valores.map((x) => `${x.p.nome}: ${x.valor}`).join('; ')}.\n` : ''}São as condições gerais do modelo atual; um contrato já assinado pode ter outra versão.`,
        porPacote.map(({ c }) => ({ tipo: 'CONTRATO_MODELO', modelo: c.modelo.modeloCodigo, versao: c.modelo.templateVersao, clausula: c.clausula.numero, sha256: c.clausula.sha256 } as Fonte)));
      contratoPorAssunto(e);
      return;
    }
  }
  const clausulas = clausulasDoTema(tema, e.ctx.pacote ?? null);
  if (!clausulas.length) { dizer(e, 'Não encontrei essa condição no modelo de contrato cadastrado.'); passar(e, 'INFORMACAO_INDISPONIVEL'); return; }
  const versao = clausulas[0].modelo.templateVersao;
  dizer(e, `Pelo modelo de contrato vigente (versão ${versao}):\n${clausulas.map(({ clausula }) => `Cláusula ${clausula.numero}: “${clausula.texto}”`).join('\n')}\nSão as condições gerais do modelo atual; um contrato já assinado pode ter outra versão.`,
    clausulas.map(({ modelo, clausula }) => ({ tipo: 'CONTRATO_MODELO', modelo: modelo.modeloCodigo, versao: modelo.templateVersao, clausula: clausula.numero, sha256: clausula.sha256 } as Fonte)));
  contratoPorAssunto(e);
}
/**
 * Assuntos do modelo vigente sem tema próprio: [como o cliente pergunta (os mesmos padrões do entendimento), como a
 * cláusula trata]. A cláusula é achada pelo texto do próprio modelo (como no item de fora) e citada palavra por palavra;
 * sem ela no modelo, nada é dito.
 */
const ASSUNTOS_CONTRATO: Array<[RegExp, RegExp]> = [
  // "E se for vocês que não puderem fazer a festa, devolvem o dinheiro?": a impossibilidade da contratada.
  [/\b(?:(?:voces|vcs|o buffet|a casa|o salao|a empresa)(?: \w+)? nao (?:puderem|puder|conseguirem|conseguir|tiverem como) (?:fazer|realizar) a (?:festa|data|reserva)|(?:voces|vcs) (?:\w+ )?(?:cancelarem|desmarcarem)|(?:o buffet|a casa|o salao|a empresa) (?:\w+ )?(?:cancelar|desmarcar) a festa)\b/, /\bimpossibilidade da contratada\b/],
  // "Quantas atrações vocês têm?": as atrações em funcionamento ("tem pula-pula?" não é contagem: fica com a equipe).
  [/\b(?:(?:quantas|qntas) atrac(?:ao|oes)(?! (?:tinha|tinham|estava|estavam|funcionaram|funcionou|teve|tiveram|faltou|faltaram)\b)|(?:tem|sao|oferecem|possuem) quantas atrac(?:ao|oes)|(?:quantidade|numero|qtd) de atrac(?:ao|oes))\b/, /\batracoes\b/],
];
function contratoPorAssunto(e: Estado) {
  const modelo = modeloVigente(null);
  if (!modelo) return false;
  const t = semAcento(e.texto);
  const citadas = new Set(e.paragrafos.flatMap((p) => p.fontes.flatMap((f) => (f.tipo === 'CONTRATO_MODELO' ? [f.clausula] : []))));
  const novas = ASSUNTOS_CONTRATO.filter(([pergunta]) => pergunta.test(t))
    .map(([, trata]) => modelo.clausulas.find((c) => trata.test(semAcento(c.texto))))
    .filter((c): c is NonNullable<typeof c> => !!c && !citadas.has(c.numero));
  if (!novas.length) return false;
  dizer(e, `Pelo modelo de contrato vigente (versão ${modelo.templateVersao}):\n${novas.map((c) => `Cláusula ${c.numero}: “${c.texto}”`).join('\n')}`,
    novas.map((c) => ({ tipo: 'CONTRATO_MODELO', modelo: modelo.modeloCodigo, versao: modelo.templateVersao, clausula: c.numero, sha256: c.sha256 } as Fonte)));
  return true;
}
async function contratoProprio(e: Estado, i: Intencao) {
  // Rodada 32 (IA r31 × h32 aa41, aa40): contrato próprio visto SÓ pelo modelo numa mensagem que já vai à equipe por um
  // motivo sensível com o próprio aviso (pagamento, reclamação, alergia): o motivo fica registrado para a equipe, sem o
  // aviso de "dados de contratos" nem o link — a mensagem de segurança segue o motivo real da passagem.
  if (i.soModelo && e.encaminhar.some((m) => m === 'PAGAMENTO' || m === 'RECLAMACAO' || m === 'RESTRICAO_ALIMENTAR')) { passar(e, 'CONTRATO_PROPRIO'); return; }
  dizer(e, 'Por segurança, não consulto nem informo dados de contratos por aqui: só o número do WhatsApp não confirma quem está falando.');
  let link: string | null = null;
  try { link = await e.fontes.linkContratoProprio(); } catch { link = null; }
  if (link) dizer(e, `Se o contrato for seu, você pode abrir pelo link seguro, que pede o seu CPF e um código enviado ao WhatsApp do cadastro:\n${link}`, [{ tipo: 'LINK_CONTRATO' }]);
  else passar(e, 'CONTRATO_PROPRIO');
}
/**
 * Contratação (fluxo de coleta, mantido até a decisão sobre passar direto): pede só o que falta (data, convidados,
 * pacote) e, com tudo, passa para a equipe confirmar. Nunca confirma reserva: a agenda é consultada só para informar.
 */
async function contratar(e: Estado) {
  // Convidados acima do pacote escolhido ou de todos os cadastrados ("fechar o Essencial com 70", "reservar pra 160"): é
  // troca de pacote ou exceção, decidida com a equipe — não adianta seguir pedindo dados. Diz o limite do cadastro.
  const n = e.ctx.convidados;
  if (n) {
    let todos: PacoteResumo[] = [];
    try { todos = await e.fontes.pacotes(); } catch { todos = []; }
    const escolhido = e.ctx.pacote ? todos.find((p) => p.codigo === e.ctx.pacote) : undefined;
    const cabem = todos.filter((p) => (!p.convidadosMaximos || p.convidadosMaximos >= n) && (!p.convidadosMinimos || p.convidadosMinimos <= n));
    const maior = [...todos].filter((p) => p.convidadosMaximos).sort((a, b) => b.convidadosMaximos! - a.convidadosMaximos!)[0];
    const nenhum = todos.length > 0 && !todos.some((p) => !p.convidadosMaximos || p.convidadosMaximos >= n);
    if (nenhum || (escolhido?.convidadosMaximos && n > escolhido.convidadosMaximos)) {
      const limite = escolhido?.convidadosMaximos && n > escolhido.convidadosMaximos ? `O pacote ${escolhido.nome} atende até ${escolhido.convidadosMaximos} convidados` : null;
      const resto = cabem.length ? `para ${n} convidados, ${lista(cabem.map((p) => `o pacote ${p.nome}`))} ${cabem.length > 1 ? 'comportam' : 'comporta'}` : `para ${n} convidados, nenhum pacote cadastrado comporta${maior && maior !== escolhido ? ` (o maior, o pacote ${maior.nome}, vai até ${maior.convidadosMaximos})` : ''}`;
      dizer(e, `${limite ? `${limite}; ${resto}` : `${resto.charAt(0).toUpperCase()}${resto.slice(1)}`}. A equipe vê com você.`, [...new Set([escolhido, ...cabem, ...(cabem.length ? [] : [maior])].filter((p): p is PacoteResumo => !!p))].map((p) => ({ tipo: 'PACOTE', codigo: p.codigo, id: p.id } as Fonte)));
      passar(e, 'CONTRATACAO');
      if (nenhum) passar(e, 'NEGOCIACAO');
      return;
    }
  }
  // Item fora do cadastro já com a equipe (cardápio respondido antes): a contratação segue com ela, sem coleta.
  if (e.entendimento.pratoSemCadastro && e.encaminhar.length) { dizer(e, 'A equipe confirma esse item e segue com a contratação com você.'); passar(e, 'CONTRATACAO'); return; }
  const faltam: CampoPendente[] = [];
  if (!e.ctx.data) faltam.push('data');
  if (!e.ctx.convidados) faltam.push('convidados');
  if (!e.ctx.pacote && e.catalogos.pacotes.length > 1) faltam.push('pacote');
  // Rodada 21: o contrato para assinar é preparado e enviado pela equipe (com a verificação de sempre), depois dos dados.
  if (CONTRATO_PARA_ASSINAR.test(semAcento(e.texto))) dizer(e, CONTRATO_PELA_EQUIPE);
  // Rodada 42: com a coleta já em andamento (a mensagem anterior era a contratação) e a data igual, só o que falta:
  // sem repetir "Que bom!…" nem a consulta da agenda já feita ("sim" ou um dado só).
  const jaColetando = e.ultimo === 'CONTRATAR' && !e.correcoesNovas.some((c) => c.campo === 'data');
  // Rodada 44 (h43 aa78): a agenda desta data acabou de ser mostrada (mensagem anterior) — não se repete na coleta.
  const agendaRecente = e.ultimo === 'DISPONIBILIDADE' && !e.correcoesNovas.some((c) => c.campo === 'data' || c.campo === 'turno');
  if (faltam.length) { if (!jaColetando) dizer(e, COLETA); faltam.forEach((f) => perguntar(e, f, 'CONTRATAR')); if (e.ctx.data && !jaColetando && !agendaRecente) await disponibilidade(e, 'CONTRATAR'); else if ((jaColetando || agendaRecente) && !e.ctx.turno && e.catalogos.turnos.length > 1) perguntar(e, 'turno', 'CONTRATAR'); return; }
  // Rodada 26: data sem ano é PROPOSTA (próxima ocorrência). Antes de seguir com a contratação, a data completa é
  // mostrada e o cliente confirma (o ano escrito já confirma); nada segue para a contratação com uma data suposta.
  if (e.ctx.dataConfirmada !== e.ctx.data) {
    dizer(e, `${CONFIRMA_CONTRATACAO} ${diaSemana(e.ctx.data!)}, ${dataBr(e.ctx.data!)}. Está certa? Se for outra, me diga o dia, o mês e o ano.`);
    perguntar(e, 'data', 'CONTRATAR'); e.confirmarData = e.ctx.data!; e.posContratacao = e.encaminhar.length; return;
  }
  const livre = await disponibilidade(e, 'CONTRATAR');
  const turno = turnoTexto(e.catalogos, e.ctx.turno);
  dizer(e, `Anotei: ${lista([`${dataBr(e.ctx.data!)}${turno ? `, ${turno.toLowerCase()}` : ''}`, `${e.ctx.convidados} convidados`, nomePacote(e.catalogos, e.ctx.pacote ?? e.catalogos.pacotes[0]?.codigo) ? `pacote ${nomePacote(e.catalogos, e.ctx.pacote ?? e.catalogos.pacotes[0]?.codigo)}` : null, e.ctx.tema ? `tema ${e.ctx.tema}` : null].filter((x): x is string => !!x))}.`);
  if (livre === false) dizer(e, 'Como essa data está ocupada, a equipe vai te ajudar a escolher outra.');
  passar(e, 'CONTRATACAO');
}

/** Rodada 27: o contexto com os dados comerciais de antes da mensagem (a mensagem protegida não os altera). */
function semDadosDaMensagem(ctx: ContextoWallE, antes: ContextoWallE): ContextoWallE {
  return { ...ctx, data: antes.data ?? null, turno: antes.turno ?? null, convidados: antes.convidados ?? null, pacote: antes.pacote ?? null, unidade: antes.unidade ?? null, tema: antes.tema ?? null, mes: antes.mes ?? null, dataConfirmada: antes.dataConfirmada ?? null, correcoes: antes.correcoes ?? [] };
}

const PRIORIDADE_PERGUNTA: CampoPendente[] = ['unidade', 'data', 'turno', 'convidados', 'pacote', 'tema'];
/** "Multa" por uma mudança sem cláusula própria (trocar/mudar/diminuir pacote, cardápio, tema, unidade, convidados). */
const MULTA_SEM_CLAUSULA = (texto: string) => { const t = semAcento(texto); return !/\b(?:cancel\w*|desist\w*|desisto|devol\w*|reembols\w*|estorn\w*|remarc\w*|adiar|(?:mudar|trocar|alterar) (?:a |de )?(?:data|dia|horario))\b/.test(t) && /\b(?:troc\w*|mud\w*|alter\w*|diminu\w*|reduz\w*)\b[^.?!]{0,25}\b(?:pacote|cardapio|tema|unidade|convidados|decoracao|buffet)\b/.test(t); };
/** Pedido explícito de tabela ou orçamento da festa (rodada 19). */
const PEDE_TABELA = /\b(?:tabela|orcamento|pacotes?|valor(?:es)? da festa|preco da festa|quanto (?:custa|fica|sai) a festa)\b/;
/** Pergunta sobre os pacotes em si (rodada 19): diferença, capacidade, duração, qual escolher. */
// Rodada 23: também horas/tempo de festa ("a premium é 5 horas mesmo?", "quanto tempo de festa?") e o que inclui.
const ATRIBUTO_DE_PACOTE = /\b(?:diferen\w*|compar\w*|cabe\w*|comporta\w*|dura\w*|duracao|quantas pessoas|quantos convidados|capacidade|qual pacote|quais pacotes|quais os pacotes|que pacotes|melhor pacote|pacote (?:ideal|indicado)|(?:tem|tenho|ter) quantos pacotes|quantas horas|\d+\s*horas|horas de festa|tempo de festa|quanto tempo|o que (?:vem|inclui|tem) n[oa])\b/;
/** Pedido explícito de tabela ou orçamento (rodada 19). */
const TABELA_EXPLICITA = /\b(?:tabela|orcamento)\b/;
/** Rodada 40: fechamento cordial, só com a dúvida resolvida. */
const FECHAMENTO = 'Posso ajudar com mais alguma coisa?';
/** Rodada 41: o cliente sabe que pode falar com uma pessoa (na apresentação e no fechamento; "quero falar com uma pessoa" passa à equipe). */
const OFERTA_PESSOA = 'Se preferir falar com uma pessoa da equipe, é só pedir.';
/** Menu do último recurso (nada a dizer). */
const MENU = 'Posso ajudar com preços, datas disponíveis, pacotes, buffet, decoração, endereço e condições do contrato. Para falar com uma pessoa, escreva “atendente”.';
/** Rodada 43: resposta a "já ficou reservado?" sem festa contratada nem pagamento na mensagem. */
const RESERVA_STATUS = 'Consultar a disponibilidade ou conversar por aqui não reserva a data: ela só fica reservada quando a contratação é concluída. Se você já concluiu a contratação, me diga que eu passo para a equipe confirmar.';
/** Aviso fixo da agenda: consultar (ou receber o link público) não reserva a data. */
const RESERVA_SO_COM_CONTRATACAO = 'A data só fica reservada com a contratação.';
/** Abre a coleta para a contratação; sai só junto das perguntas (com a passagem para a equipe, não há o que pedir). */
const COLETA = 'Que bom! Para adiantar a contratação com a equipe, preciso de poucos dados.';
/** Rodada 27: a agenda é por data (a pergunta da data já vai nesta frase). */
const AGENDA_POR_DATA = 'A agenda é consultada por data: me diga qual data (dia e mês) você quer ver.';
/** Rodada 26: confirmação da data completa antes de seguir com a contratação. */
const CONFIRMA_CONTRATACAO = 'Antes de seguir com a contratação, confirme a data:';
/** Contrato para assinar (rodada 21): pelo fluxo de contratação; o Wall-e não envia contrato. */
const CONTRATO_PELA_EQUIPE = 'O contrato para assinar é preparado e enviado pela equipe, com a confirmação dos seus dados.';
/** Abre as perguntas do valor exato; como a COLETA, sai só junto das perguntas. */
const VALORES_DEPENDEM = 'Os valores dependem do pacote, da data, do período e do número de convidados.';

/**
 * Rodada 32 — política de combinação regras × modelo (docs §4.37): cuidado visto SÓ pelo modelo e explicado por uma
 * consulta comum (marcada no entendimento por critério positivo e restrito) é afastado, com TODOS os sinais finais
 * conferidos aqui (os da triagem do JEV chegam depois do entendimento): sem alergia, reclamação, pagamento, instrução e
 * parar, e com todo cuidado da mensagem só do modelo e explicado. Qualquer outra situação mantém todos os cuidados.
 */
function cuidadosAfastaveis(ent: Entendimento): Intencao[] {
  const cuidados = ent.intencoes.filter((i) => ['CONTRATO_PROPRIO', 'CONTRATAR', 'NEGOCIACAO', 'HUMANO'].includes(i.tipo));
  if (!cuidados.length || !cuidados.every((i) => i.soModelo && i.consultaComum)) return [];
  const s = ent.sinais;
  if (ent.alergia || ent.parar || s?.reclamacao || s?.pagamento || s?.pagamentoAcao || s?.instrucao) return [];
  return cuidados;
}
/** Rodada 34: forma de dúvida GERAL sobre atraso: hipótese ou consequência ("se vencer…", "o que acontece"). "Boleto atrasado tem juros?" (estado, que pode ser o do próprio cliente) continua com a equipe. */
const DUVIDA_GERAL_ATRASO = /\b(?:se|caso|e se|quando|o que acontece|acontece o que)\b/;
/** Rodada 34: pedido ou aviso sobre o PRÓPRIO pagamento (vai à equipe). */
const PAGAMENTO_PESSOAL = /\b(?:me (?:manda|mande|envia|envie|passa|passe|gera|gere)|segunda via|boleto novo|outro boleto|novo boleto|(?:ja )?paguei|pagamos|pix|chave|comprovante|como (?:eu )?(?:pago|faco pra pagar)|onde (?:eu )?pago|(?:meu|minha|o meu|a minha) (?:boleto|parcela|pagamento|mensalidade)\b[^.?!]{0,25}\b(?:venceu|vencid\w*|atrasad\w*|vence (?:hoje|amanha))|(?:venceu|vencid\w*) (?:ontem|hoje|semana passada|mes passado|faz)|nao consegui pagar|nao paguei|vou atrasar|ja atrasei|(?:estou|to|tou) atrasad\w*|atrasei)\b/;
/** Frase de proteção de cada consulta comum (sai junto da resposta pelas fontes; nada é prometido nem confirmado). */
const PROTECAO_CONSULTA_COMUM: Record<CriterioConsultaComum, string> = {
  ORCAMENTO_INFORMADO: 'Os valores aqui são os de tabela; descontos e condições especiais são decididos pela equipe.',
  VISITA_MARCADA: 'Agendamentos de visita eu não consulto nem altero por aqui.',
  DISPONIBILIDADE_ATRIBUIDA: 'O que vale é a agenda consultada agora; o que foi conversado antes com a equipe eu não confirmo por aqui.',
  RESERVA_FINANCEIRA: 'Considerei o valor que você citou como o seu orçamento: nenhuma data fica reservada por aqui; a reserva só acontece com a contratação.',
};

/** Tamanho máximo de uma mensagem de texto do Wall-e (o WhatsApp aceita 4.096 caracteres). */
export const LIMITE_MENSAGEM = 4000;
/**
 * Rodada 36: parágrafos → mensagens de até `limite` caracteres. Junta parágrafos enquanto cabem; um parágrafo maior que o
 * limite é partido no fim de uma frase (ou, sem frase que caiba, no último espaço). Nenhum texto é descartado.
 */
export function partirMensagem(paragrafos: { texto: string; fontes: Fonte[] }[], limite = LIMITE_MENSAGEM): { texto: string; fontes: Fonte[] }[] {
  const pedacos = (texto: string) => {
    const r: string[] = [];
    let resto = texto;
    while (resto.length > limite) {
      const janela = resto.slice(0, limite + 1);
      const frases = [...janela.matchAll(/[.!?…:]["”’)]*(?=\s)|\n/g)].map((m) => (m.index ?? 0) + m[0].length).filter((i) => i <= limite);
      const espaco = janela.lastIndexOf(' ', limite);
      const corte = frases.length ? frases[frases.length - 1] : espaco > 0 ? espaco : limite;
      r.push(resto.slice(0, corte).trimEnd());
      resto = resto.slice(corte).trimStart();
    }
    if (resto) r.push(resto);
    return r;
  };
  const saidas: { texto: string; fontes: Fonte[] }[] = [];
  for (const p of paragrafos) {
    for (const t of pedacos(p.texto)) {
      const atual = saidas[saidas.length - 1];
      if (atual && atual.texto.length + 2 + t.length <= limite) { atual.texto += `\n\n${t}`; atual.fontes.push(...p.fontes); }
      else saidas.push({ texto: t, fontes: [...p.fontes] });
    }
  }
  return saidas;
}

/**
 * Uma rodada do Wall-e para a mensagem do cliente. `contexto` é a memória anterior; o resultado traz as mensagens a
 * enviar (texto + anexos autorizados, cada uma com as fontes), a memória nova e, se for o caso, o resumo da passagem.
 */
export async function resolverWallE(entrada: { texto: string; entendimento: Entendimento; contexto: ContextoWallE; config: ConfiguracaoAtendimento; catalogos: Catalogos; agora: string }, fontes: FontesWallE, opcoes: { sugestao?: boolean } = {}): Promise<ResultadoWallE> {
  const { catalogos } = entrada;
  const afastados = cuidadosAfastaveis(entrada.entendimento);
  const entendimento: Entendimento = afastados.length ? { ...entrada.entendimento, intencoes: entrada.entendimento.intencoes.filter((i) => !afastados.includes(i)) } : entrada.entendimento;
  const cuidadosAfastados = afastados.map((i) => ({ tipo: i.tipo, criterio: i.consultaComum! }));
  const ctx = mesclarContexto(entrada.contexto, entendimento, entrada.agora);
  const e: Estado = { ctx, paragrafos: [], anexos: [], perguntas: [], encaminhar: [], agora: entrada.agora, texto: entrada.texto, entendimento, catalogos, config: entrada.config, fontes,
    correcoesNovas: (ctx.correcoes ?? []).slice((entrada.contexto.correcoes ?? []).length), ultimo: (entrada.contexto.assuntos ?? []).at(-1) ?? null };
  // Rodada 26: "e se for à tarde?" depois de um valor ou de uma consulta num período: a tarde não define o período e o
  // anterior não vale para a pergunta nova — o período é perguntado (nunca o valor do período antigo de novo).
  if (entendimento.periodoAmbiguo && !entendimento.entidades.turno && e.ctx.turno) e.ctx = { ...e.ctx, turno: null };
  // Rodada 27: mês novo explícito ("e em janeiro quanto ficaria?") depois de uma data de outro mês: a data anterior não vale
  // para a pergunta nova; o dia é pedido antes de consultar a agenda ou calcular o preço.
  if (entendimento.mesCitado && !entendimento.entidades.data && e.ctx.data && Number(e.ctx.data.slice(5, 7)) !== entendimento.mesCitado
    && !entendimento.intencoes.some((i) => i.tipo === 'CONTRATO_PROPRIO')) e.ctx = { ...e.ctx, data: null };
  // Pedido de parar vem antes de tudo e nada é respondido: INEQUÍVOCO ⇒ o worker bloqueia a conversa (definitivo) e
  // cancela o que estiver na fila; AMBÍGUO ⇒ a equipe recebe a conversa sem nenhuma mensagem automática.
  // Rodada 18: com reclamação junto, o bloqueio é o mesmo e a reclamação fica registrada para a equipe (sem contato).
  if (entendimento.parar?.tipo === 'INEQUIVOCO') return { saidas: [], contexto: comPendente(e.ctx, [], 'OUTRO'), passagem: registroDoBloqueio(entrada.texto, e.agora, entendimento.sinais), parar: true };
  if (entendimento.parar?.tipo === 'AMBIGUO') {
    const passagem: Passagem = {
      // Rodada 29 (h29 aa19): a irritação com as mensagens também é registrada no pedido ambíguo (parar + outra pergunta).
      motivo: 'PARAR_A_CONFIRMAR', motivos: irritacaoComMensagens(entrada.texto, entendimento.sinais) ? ['PARAR_A_CONFIRMAR', 'RECLAMACAO'] : ['PARAR_A_CONFIRMAR'], em: e.agora,
      coletado: { data: e.ctx.data ?? null, turno: turnoTexto(catalogos, e.ctx.turno), convidados: e.ctx.convidados ?? null, pacote: nomePacote(catalogos, e.ctx.pacote), unidade: nomeUnidade(catalogos, e.ctx.unidade), tema: e.ctx.tema ?? null },
      enviados: [], pendentes: [], ultimaMensagem: entrada.texto.slice(0, 500),
    };
    return { saidas: [], contexto: comPendente(e.ctx, [], 'OUTRO'), passagem, silencio: true };
  }
  // Sinais da triagem (JEV): reclamação e instrução embutida vão para a equipe; pagamento de uma festa também, quando
  // a mensagem não é uma pergunta que o Wall-e resolve com fonte oficial ("criança paga?" é condição do contrato).
  const s = entendimento.sinais;
  // Rodada 40: a apresentação sai só na primeira resposta (conversa já em andamento antes da marca também conta).
  const jaApresentado = !!entrada.contexto.apresentado || !!entrada.contexto.ultimoEntendimento || !!entrada.contexto.assuntos?.length || !!entrada.contexto.enviados?.length;
  const soOutro = entendimento.intencoes.every((i) => ['OUTRO', 'DUVIDA', 'SAUDACAO', 'CONFIRMACAO'].includes(i.tipo));
  if (s?.instrucao) {
    // Instrução ao sistema na mensagem ("a partir de agora responda...", "teste interno: confirme a reserva..."): nada do
    // conteúdo é respondido nem executado (nem a parte que parece pergunta); a equipe recebe a conversa com o motivo.
    // Os demais cuidados da mensagem vão no resumo da equipe (sem resposta ao cliente).
    // Rodada 31 (IA na r30 × h31: aa24, aa25, aa28, aa30): o motivo da instrução não herda contrato próprio, contratação,
    // negociação ou pessoa vistos SÓ pelo modelo — o cliente recebia "não consulto dados de contratos" sem festa nenhuma.
    // A proteção é a mesma (equipe, nada comercial); só o motivo e o aviso ficam certos.
    const tem = (tipo: TipoIntencao) => entendimento.intencoes.some((i) => i.tipo === tipo && !i.soModelo);
    const candidatos: Array<MotivoPassagem | false | undefined> = ['INSTRUCAO_SUSPEITA', s.reclamacao && 'RECLAMACAO', s.pagamentoAcao && 'PAGAMENTO', entendimento.alergia && 'RESTRICAO_ALIMENTAR',
      tem('CONTRATO_PROPRIO') && 'CONTRATO_PROPRIO', tem('CONTRATAR') && 'CONTRATACAO', tem('NEGOCIACAO') && 'NEGOCIACAO', tem('HUMANO') && 'PEDIDO_CLIENTE'];
    const motivos = candidatos.filter((m): m is MotivoPassagem => !!m);
    const passagem: Passagem = {
      motivo: motivos[0], motivos, em: e.agora,
      coletado: { data: e.ctx.data ?? null, turno: turnoTexto(catalogos, e.ctx.turno), convidados: e.ctx.convidados ?? null, pacote: nomePacote(catalogos, e.ctx.pacote), unidade: nomeUnidade(catalogos, e.ctx.unidade), tema: e.ctx.tema ?? null },
      enviados: [...new Map((e.ctx.enviados ?? []).map((x) => [x.prontaId, x])).values()].map((x) => ({ titulo: x.finalidade, finalidade: x.finalidade })),
      pendentes: [], ultimaMensagem: entrada.texto.slice(0, 500),
    };
    // Rodada 18: sem motivo técnico ao cliente. Pedido sobre contrato ou pagamento (de outra pessoa, por exemplo): o aviso
    // de segurança, sem nenhum dado.
    const seguranca = motivos.includes('CONTRATO_PROPRIO') || motivos.includes('PAGAMENTO') ? 'Por segurança, não consulto nem informo dados de contratos ou pagamentos por aqui.\n\n' : '';
    const aviso = `${seguranca}${PASSAGEM_AO_CLIENTE.INSTRUCAO_SUSPEITA} Em breve alguém responde por aqui.`;
    return { saidas: opcoes.sugestao ? [] : [{ texto: aviso, anexo: null, fontes: [] }], contexto: comPendente(semDadosDaMensagem(e.ctx, entrada.contexto), [], 'OUTRO'), passagem };
  }
  if (s?.reclamacao) passar(e, 'RECLAMACAO');
  // Rodada 15: passar da capacidade cadastrada pagando a diferença ("a premium pra 170? a gente paga a diferença") é
  // exceção da equipe; o pagamento não muda o limite (e não é pedido de pagamento de uma festa).
  // Rodada 23: com alergia, reclamação ou festa já contratada, nenhuma consulta comercial acontece (nem a de capacidade).
  // Rodada 24: pedido ou aviso de pagamento (pix, comprovante) também: o fluxo aprovado de pagamento é a equipe.
  // Rodada 34 (h34 aa37; h32 aa64; h33 aa46): DÚVIDA GERAL sobre atraso ou vencimento ("se a parcela vencer, o que
  // acontece?", "e se o boleto já tiver vencido quando eu for pagar, tem juros?") é a condição do contrato (cláusula 7),
  // não atendimento de pagamento pessoal: o sinal de pagamento não manda a mensagem à equipe. Pedido ou aviso sobre o
  // PRÓPRIO pagamento (segunda via, boleto novo, "o meu venceu ontem", "já paguei atrasado", pix) continua com a equipe.
  const tPag = semAcento(entrada.texto);
  const duvidaDeAtraso = entendimento.intencoes.some((i) => i.tipo === 'CONTRATO' && i.tema === 'INADIMPLENCIA') && DUVIDA_GERAL_ATRASO.test(tPag) && !PAGAMENTO_PESSOAL.test(tPag);
  const pedidoDePagamento = !duvidaDeAtraso && !!s?.pagamentoAcao && /\b(?:pix|chave|comprovante|transferi\w*|deposit\w*|paguei|pagamos|vou pagar|quero pagar|como (?:eu )?pago|dados bancarios|conta (?:pra|para) (?:deposito|transferencia)|agencia|qr ?code)\b/.test(semAcento(entrada.texto));
  const protecao = !!entendimento.alergia || !!s?.reclamacao || pedidoDePagamento || entendimento.intencoes.some((i) => i.tipo === 'CONTRATO_PROPRIO');
  const excecaoPaga = !protecao && await excecaoDeCapacidadePaga(e);
  // Pedido ou aviso de pagamento ("chave pix", "segue o comprovante", "paguei") vai sempre: o Wall-e nunca passa dado de
  // pagamento nem confirma recebimento.
  if (!excecaoPaga && !duvidaDeAtraso && (s?.pagamentoAcao || (s?.pagamento && soOutro && !entendimento.intencoes.some((i) => i.tipo === 'DUVIDA' && i.perguntaId)))) { dizer(e, 'Pagamentos e cobranças de uma festa são conferidos pela equipe.'); passar(e, 'PAGAMENTO'); }
  if (entendimento.alergia) { dizer(e, 'Sobre alergias e restrições alimentares, quem confirma é a equipe: não consigo garantir ingredientes ou substituições por aqui.'); passar(e, 'RESTRICAO_ALIMENTAR'); }
  // Rodada 25: o dia citado não define a data (dois meses na mensagem): confirma a data, sem calcular com outra.
  if (entendimento.dataAmbigua && !entendimento.entidades.data) { dizer(e, CONFIRMAR_DATA); perguntar(e, 'data', entendimento.intencoes.find((i) => ['PRECOS', 'DISPONIBILIDADE', 'CONTRATAR'].includes(i.tipo))?.tipo ?? 'DISPONIBILIDADE'); }
  if (dataCitadaInvalida(entrada.texto, catalogos.hoje)) { dizer(e, 'Essa data não existe no calendário.'); perguntar(e, 'data', entendimento.intencoes[0]?.tipo ?? 'DISPONIBILIDADE'); }
  if (e.ctx.data && e.ctx.data < catalogos.hoje) { dizer(e, `A data ${dataBr(e.ctx.data)} já passou.`); e.ctx = { ...e.ctx, data: null }; perguntar(e, 'data', entendimento.intencoes[0]?.tipo ?? 'DISPONIBILIDADE'); }

  // Confirmação curta: continua o que estava pendente (a pergunta anterior). Sem pendência, só reconhece.
  let intencoes = entendimento.intencoes;
  // Agradecimento ("aah entendi, brigada") encerra o assunto: não retoma nem repete a pergunta pendente.
  const agradecimento = intencoes.length === 1 && intencoes[0].tipo === 'CONFIRMACAO' && /\b(obrigad|brigad|valeu|vlw|entendi|obg|agradec|gratid|grat[ao]\b)/.test(semAcento(entrada.texto));
  if (intencoes.length === 1 && intencoes[0].tipo === 'CONFIRMACAO') intencoes = entrada.contexto.pendente && !entrada.contexto.pendente.opcional && !agradecimento ? [{ tipo: entrada.contexto.pendente.para, trecho: intencoes[0].trecho }] : intencoes;
  // Rodada 26: "sim, pode seguir" à data completa proposta para a contratação: a contratação continua (já confirmada).
  if (entrada.contexto.pendente?.confirmarData && entendimento.concorda && !entendimento.entidades.data && intencoes.every((i) => ['OUTRO', 'CONFIRMACAO', 'SAUDACAO'].includes(i.tipo))) intencoes = [{ tipo: 'CONTRATAR', trecho: entrada.texto.slice(0, 300) }];
  // Resposta a pendência ("80", "Asa Sul"): continua a intenção que pediu o dado, só se a mensagem traz um dos que faltavam.
  // Continuação ("e no segundo?", "pera, são 55"): só dado, seguindo o último assunto (preço, agenda, pacotes, cardápio).
  const continuacao = intencoes.find((i) => i.continuacao)?.tipo ?? null;
  const soDado = intencoes.every((i) => i.tipo === 'OUTRO' || i.tipo === 'CONFIRMACAO' || i.continuacao);
  const pendente = entrada.contexto.pendente ?? null;
  const ent = entendimento.entidades;
  const preenche = (campos: CampoPendente[]) => campos.some((c) => (c === 'pacote' ? ent.pacotes.length > 0 : ent[c] !== null && ent[c] !== undefined));
  if (soDado && !continuacao && pendente && preenche(pendente.campos)) intencoes = [{ tipo: pendente.para, trecho: entrada.texto.slice(0, 300) }];
  // Dados novos ou corrigidos nesta mensagem são confirmados em uma linha ("na verdade serão 80" → "Anotei: 80 convidados").
  // Pergunta de continuação ("e no segundo?", "e pra 80?") é consulta nova: não vira "correção" anotada.
  const novasCorrecoes = e.correcoesNovas;
  const perguntaNova = !!continuacao && (/\?/.test(entrada.texto) || /^\s*e\s/.test(semAcento(entrada.texto)));
  const valor = (campo: string, v: unknown) => campo === 'data' ? dataBr(String(v)) : campo === 'convidados' ? `${v} convidados` : campo === 'turno' ? turnoTexto(catalogos, String(v))?.toLowerCase() ?? String(v) : campo === 'pacote' ? `pacote ${nomePacote(catalogos, String(v)) ?? v}` : campo === 'unidade' ? `unidade ${nomeUnidade(catalogos, String(v)) ?? v}` : `tema ${v}`;
  if (novasCorrecoes.length && soDado && !perguntaNova && !protecao) {
    dizer(e, `Anotei a correção: ${lista(novasCorrecoes.map((c) => `${valor(c.campo, c.para)} (antes ${valor(c.campo, c.de)})`))}.`);
    // A correção muda um valor já calculado ("são 110, na verdade"): refaz o cálculo pela tabela, sem perguntar nada
    // (com continuação, o próprio assunto refaz).
    // Rodada 34 (h34 aa54): "e no outro horário?" depois de um orçamento, mesmo com outra pergunta respondida no meio
    // (estacionamento), retoma o orçamento: refaz o cálculo com o período novo (o valor mostra o período usado) e, faltando
    // dado, pede o que falta.
    const emOrcamento = (entrada.contexto.assuntos ?? []).includes('PRECOS');
    if (!continuacao && (e.ultimo === 'PRECOS' || e.ultimo === 'PACOTES' || emOrcamento) && novasCorrecoes.some((c) => ['data', 'turno', 'convidados', 'pacote'].includes(c.campo))) await precoCalculado(e, emOrcamento, undefined, emOrcamento ? 'PRECOS' : 'PACOTES');
  }
  else if (soDado && !perguntaNova && !(pendente && preenche(pendente.campos))) {
    // O pacote citado numa comparação não vira o pacote da conversa: sem valor anotado, não há o que dizer ("pacote null").
    const novos = (['data', 'turno', 'convidados', 'pacote', 'unidade'] as const).filter((c) => (c === 'pacote' ? ent.pacotes.length === 1 : ent[c] !== null && ent[c] !== undefined) && (entrada.contexto[c] ?? null) === null && e.ctx[c] !== null && e.ctx[c] !== undefined);
    // Rodada 27: mensagem protegida (festa contratada, alergia, reclamação, pagamento) não anota dado comercial.
    if (novos.length && !protecao) dizer(e, `Anotei: ${lista(novos.map((c) => valor(c, e.ctx[c])))}.`);
    // Rodada 18: "premium" depois de data, período e convidados num assunto de preço: o cálculo segue com o contexto já
    // coletado (sem pedir de novo o que o cliente já disse).
    const deValor = novos.some((c) => c === 'pacote' || c === 'convidados' || c === 'data' || c === 'turno');
    // Num assunto de preço, o que ainda falta para o valor é pedido (o cliente está respondendo à qualificação).
    const emPreco = (entrada.contexto.assuntos ?? []).includes('PRECOS');
    // Se a própria mensagem já segue o assunto de preço (continuação), o assunto calcula: aqui não repete.
    if (deValor && !intencoes.some((i) => i.tipo === 'PRECOS' || i.tipo === 'PACOTES') && (emPreco || (entrada.contexto.assuntos ?? []).includes('PACOTES'))) await precoCalculado(e, emPreco, undefined, emPreco ? 'PRECOS' : 'PACOTES');
  }
  // Pergunta no meio da qualificação ("onde fica? seremos 80"): responde a pergunta e, se o dado que faltava veio junto,
  // retoma também o que estava pendente; se ainda falta, volta a pedir depois de responder.
  const faltando = (campos: CampoPendente[]) => campos.filter((c) => e.ctx[c] === null || e.ctx[c] === undefined);
  // Convite opcional ("se quiser, me conte a data...") só é retomado com a resposta a ele: com um assunto novo ("quanto
  // sai o Premium pra 90 dia 9/1?"), o assunto novo responde, sem repetir o pacote e o mesmo valor.
  // Rodada 21: pedido de pessoa não retoma a pendência ("queria falar com o gerente" repetia o valor calculado antes).
  const pediuPessoa = intencoes.some((i) => i.tipo === 'HUMANO');
  // Rodada 24: com outro assunto na mensagem, a pendência antiga só volta se a mensagem trouxe o dado dela e ela é de
  // agenda, preço ou contratação ("tem data livre em dezembro?" → "19/12. e cabem 45?"); cardápio, pacotes, decoração e
  // endereço pendentes não se juntam a uma pergunta de outro assunto.
  // Qualificação em andamento: dados da festa (data, período, convidados, pacote) para preço, agenda, contratação ou
  // pacotes. Tema, pacote do cardápio e unidade do endereço são pendências de outro assunto.
  const qualificacao = !!pendente && ['PRECOS', 'DISPONIBILIDADE', 'CONTRATAR', 'PACOTES'].includes(pendente.para) && pendente.campos.every((c) => ['data', 'turno', 'convidados', 'pacote'].includes(c));
  const retomaAssunto = soDado || (preenche(pendente?.campos ?? []) && qualificacao);
  if (pendente && retomaAssunto && !pediuPessoa && !(pendente.opcional && !soDado) && !intencoes.some((i) => i.tipo === pendente.para) && !faltando(pendente.campos).length && !['HUMANO', 'OUTRO', 'SAUDACAO'].includes(pendente.para)) intencoes = [...intencoes, { tipo: pendente.para, trecho: '' }];
  // Pedido explícito de pessoa: a equipe responde tudo; nenhum conteúdo comercial é acrescentado.
  if (pediuPessoa) intencoes = intencoes.filter((i) => !['PRECOS', 'PACOTES', 'CARDAPIO', 'DECORACAO', 'DISPONIBILIDADE', 'LOCALIZACAO', 'CONTRATAR', 'DUVIDA', 'CONTRATO', 'EXTERNO'].includes(i.tipo));
  // Festa já contratada (dele ou de outra pessoa): nunca consulta agenda nem trata como contratação nova — "disponível"
  // não pode soar como confirmação de uma reserva.
  // Rodada 19: nem tabela, valor ou lista de pacotes para a festa já contratada ("aumentar pra 75 na minha festa, vai ficar
  // quanto?"): o valor é do contrato, a equipe responde.
  if (intencoes.some((i) => i.tipo === 'CONTRATO_PROPRIO')) intencoes = intencoes.filter((i) => !['DISPONIBILIDADE', 'CONTRATAR', 'PRECOS', 'PACOTES', 'DECORACAO'].includes(i.tipo));
  // Rodada 22: levar os próprios balões não é a cláusula dos balões (que fala dos balões fornecidos pelo buffet): sem a
  // pergunta da quantidade incluída, a cláusula 17 não é citada e o item de fora vai à equipe.
  // Rodada 32: o item é o do texto do cliente (não só o do trecho do modelo).
  if (intencoes.some((i) => i.tipo === 'EXTERNO' && itemExternoDoCliente(entrada.texto, i.trecho) === 'balões') && !/\bquant\w*\b[^.?!]{0,25}\b(balao|baloes|bexigas?)\b|\b(vem|vêm|incluso|inclusos|inclui)\b/.test(semAcento(entrada.texto)))
    intencoes = intencoes.filter((i) => !(i.tipo === 'CONTRATO' && i.tema === 'BALOES'));
  // Rodada 19: "qto é a taxa da chuva de prata?", "se passar do horário quanto é?": o valor está na cláusula do assunto —
  // não é pedido de tabela nem de orçamento (sem pacote, data ou convidados citados).
  if (intencoes.some((i) => i.tipo === 'CONTRATO' && i.tema && !['GERAL', 'PAGAMENTO'].includes(i.tema)) && intencoes.some((i) => i.tipo === 'PRECOS') && !ent.pacotes.length && !ent.data && !ent.convidados && !PEDE_TABELA.test(semAcento(entrada.texto)))
    intencoes = intencoes.filter((i) => i.tipo !== 'PRECOS');
  // Sinal ("quanto é o sinal pra segurar o dia 23/01?"): o valor do sinal não está na tabela, mesmo com data citada.
  if (intencoes.some((i) => i.tipo === 'CONTRATO' && i.tema === 'SINAL') && !TABELA_EXPLICITA.test(semAcento(entrada.texto))) intencoes = intencoes.filter((i) => i.tipo !== 'PRECOS');
  // Rodada 19: negociação ("se eu tirar o kibe abaixa o preço?", "faz um descontinho?") vai para a equipe sem a tabela nem
  // a lista de pacotes, salvo pedido explícito de tabela ou orçamento.
  if (intencoes.some((i) => i.tipo === 'NEGOCIACAO') && !TABELA_EXPLICITA.test(semAcento(entrada.texto))) intencoes = intencoes.filter((i) => i.tipo !== 'PRECOS' && i.tipo !== 'PACOTES');
  // Retirar item para pagar menos ("se eu tirar o kibe fica mais barato?"): o item citado não é pergunta do cardápio.
  if (intencoes.some((i) => i.tipo === 'NEGOCIACAO') && /\b(?:tir\w*|remov\w*|retir\w*|sem (?:o|a|os|as)|deix\w* (?:so|apenas))\b/.test(semAcento(entrada.texto))) intencoes = intencoes.filter((i) => i.tipo !== 'CARDAPIO');
  // Rodada 19: "a coxinha vem em todos os pacotes?", "a decoração já vem no pacote?": o assunto é o cardápio/decoração/item
  // de fora; a lista de pacotes só entra quando a pergunta é sobre os pacotes (capacidade, duração, diferença).
  if (intencoes.some((i) => ['CARDAPIO', 'DECORACAO', 'EXTERNO'].includes(i.tipo)) && intencoes.some((i) => i.tipo === 'PACOTES') && !ATRIBUTO_DE_PACOTE.test(semAcento(entrada.texto))) intencoes = intencoes.filter((i) => i.tipo !== 'PACOTES');
  // Rodada 19: na contratação, o pacote citado ("quero fechar o completa pro dia 30") é dado, não pergunta sobre pacotes.
  if (intencoes.some((i) => i.tipo === 'CONTRATAR') && intencoes.some((i) => i.tipo === 'PACOTES') && !ATRIBUTO_DE_PACOTE.test(semAcento(entrada.texto)))
    intencoes = intencoes.filter((i) => i.tipo !== 'PACOTES');
  // Rodada 23: "o valor do pacote Essencial para 45 no sábado 7/11": o pacote é dado do valor, não pedido da ficha.
  if (intencoes.some((i) => i.tipo === 'PRECOS') && intencoes.some((i) => i.tipo === 'PACOTES') && !ATRIBUTO_DE_PACOTE.test(semAcento(entrada.texto)))
    intencoes = intencoes.filter((i) => i.tipo !== 'PACOTES');
  // Multa por troca de pacote (sem cláusula): a equipe responde; a lista de pacotes não é o que foi perguntado.
  if (intencoes.some((i) => i.tipo === 'CONTRATO' && i.tema === 'CANCELAMENTO') && MULTA_SEM_CLAUSULA(entrada.texto)) intencoes = intencoes.filter((i) => i.tipo !== 'PACOTES');
  // Exceção paga (acima): só ela responde; dentro da faixa, "pago o excedente" segue a cláusula do contrato.
  if (excecaoPaga) intencoes = intencoes.filter((i) => i.tipo === 'SAUDACAO' || i.tipo === 'CONTRATO_PROPRIO');
  // Rodada 17 — prioridade das proteções sobre o comercial:
  //  - reclamação (problema numa festa realizada): a equipe atende; nada de cardápio, tabela ou qualificação comercial
  //    ("o bolo da festa chegou murcho" não é pergunta do cardápio);
  //  - mesmo valor com mais convidados ou outro pacote ("115 pagando o mesmo valor"): negociação; a tabela não responde.
  // Rodada 18: nem pergunta frequente colada à reclamação ("ninguém me responde" não pede o horário de atendimento).
  if (s?.reclamacao) intencoes = intencoes.filter((i) => !['PRECOS', 'PACOTES', 'CARDAPIO', 'DISPONIBILIDADE', 'DECORACAO', 'LOCALIZACAO', 'CONTRATAR', 'DUVIDA'].includes(i.tipo));
  if (MESMO_VALOR.test(semAcento(entrada.texto)) && intencoes.some((i) => i.tipo === 'NEGOCIACAO')) intencoes = intencoes.filter((i) => i.tipo !== 'PRECOS');

  // Rodada 21: "condições gerais do contrato" sem tema só quando o contrato é o assunto da mensagem.
  if (intencoes.some((i) => i.tipo === 'CONTRATO' && (i.tema ?? 'GERAL') === 'GERAL') && (s?.reclamacao || intencoes.some((i) => !['CONTRATO', 'SAUDACAO', 'CONFIRMACAO', 'OUTRO'].includes(i.tipo))))
    intencoes = intencoes.filter((i) => !(i.tipo === 'CONTRATO' && (i.tema ?? 'GERAL') === 'GERAL'));
  // Rodada 23 — prioridade das proteções sobre o comercial, antes de acessar as fontes: com alergia, reclamação ou festa
  // já contratada, nada comercial é consultado nem respondido (agenda de festa nova, tabela, pacotes, cardápio, endereço,
  // perguntas frequentes, cláusulas, decoração, item de fora). A mensagem vai à equipe com todos os motivos: o pedido de
  // contratação nova junto vira o motivo CONTRATACAO (sem consultar a agenda); pessoa e negociação continuam.
  if (protecao) {
    if (intencoes.some((i) => i.tipo === 'CONTRATAR') && !intencoes.some((i) => i.tipo === 'CONTRATO_PROPRIO')) passar(e, 'CONTRATACAO');
    intencoes = intencoes.filter((i) => ['CONTRATO_PROPRIO', 'HUMANO', 'NEGOCIACAO'].includes(i.tipo));
  }
  if (intencoes.some((i) => i.tipo === 'CARDAPIO') && intencoes.some((i) => i.tipo === 'CONTRATAR')) intencoes = [...intencoes.filter((i) => i.tipo !== 'CONTRATAR'), ...intencoes.filter((i) => i.tipo === 'CONTRATAR')];
  const tipos = new Set(intencoes.map((i) => i.tipo));
  for (const i of intencoes) {
    switch (i.tipo) {
      case 'PRECOS': await precos(e); break;
      case 'LOCALIZACAO': await localizacao(e); break;
      case 'DISPONIBILIDADE': if (!tipos.has('CONTRATAR')) await disponibilidade(e); break;
      case 'PACOTES': await pacotes(e); break;
      case 'CARDAPIO': await cardapio(e); break;
      case 'DECORACAO': await decoracao(e); break;
      case 'CONTRATO': await contrato(e, i); break;
      case 'CONTRATO_PROPRIO': await contratoProprio(e, i); break;
      case 'CONTRATAR': await contratar(e); break;
      case 'DUVIDA': {
        const faq = e.config.perguntas.find((p) => p.id === i.perguntaId);
        if (faq) dizer(e, faq.resposta, [{ tipo: 'CONFIGURACAO', perguntaId: faq.id }]);
        else { dizer(e, 'Essa informação eu não tenho cadastrada.'); passar(e, 'INFORMACAO_INDISPONIVEL'); }
        break;
      }
      case 'NEGOCIACAO': dizer(e, 'Descontos e condições especiais são decididos pela equipe.'); passar(e, 'NEGOCIACAO'); break;
      case 'EXTERNO': await externo(e, i, intencoes); break;
      case 'HUMANO': passar(e, 'PEDIDO_CLIENTE'); break;
      case 'CONFIRMACAO': if (intencoes.length === 1) dizer(e, `${/\b(obrigad|brigad|valeu|vlw|agradec|obg|gratid|grat[ao]\b)/.test(semAcento(entrada.texto)) ? 'Por nada!' : 'Combinado!'} Se precisar de mais alguma informação, é só falar.`); break;
      case 'SAUDACAO': if (intencoes.length === 1) { const s = cumprimentoDoCliente(entrada.texto); dizer(e, `${s.periodo ?? 'Olá'}!${s.comoVai ? ' Tudo bem, e você?' : ''} ${jaApresentado ? 'Em que posso ajudar?' : `Sou o Wall-e, agente inteligente da ${e.config.nome}. Posso enviar a tabela de preços, consultar datas, explicar pacotes, buffet, decoração, endereço e as condições do contrato. ${OFERTA_PESSOA} Como posso ajudar?`}`); } break;
      // Rodada 21: o menu genérico não entra aqui ("à tarde" no meio do orçamento recebia o menu antes da pergunta): sem
      // nada a dizer, o fim da rodada pergunta o que falta ou, como último recurso, mostra o menu.
      case 'OUTRO': break;
    }
  }

  // Rodada 42: escolha de pacote sem pedido de contratação ("vamos de Completa", "decidi pelo Premium"): o pacote fica
  // anotado e o resto vira convite (nada de coleta de contratação nem de reserva); fechar continua sendo pedido do cliente.
  if (entendimento.escolhaPacote && !tipos.has('CONTRATAR') && !protecao && !pediuPessoa && !s?.reclamacao && !e.encaminhar.length) {
    const codigo = entendimento.escolhaPacote;
    dizer(e, `Anotei: pacote ${nomePacote(catalogos, codigo) ?? codigo}.`, [{ tipo: 'PACOTE', codigo, id: codigo }]);
    const faltam = (['data', 'turno', 'convidados'] as const).filter((c) => !e.ctx[c]);
    if (faltam.length) for (const c of faltam) perguntar(e, c, 'PRECOS', true);
    else dizer(e, 'Quando quiser seguir com a contratação, é só me dizer.');
  }
  // Rodada 34: horário de entrada dos convidados pelos períodos cadastrados (o período da conversa, se houver).
  if (ENTRADA_CONVIDADOS.test(semAcento(entrada.texto)) && !protecao && !pediuPessoa && !s?.reclamacao && catalogos.turnos.length) {
    const t = catalogos.turnos.find((x) => x.codigo === e.ctx.turno);
    dizer(e, t ? `No ${t.nome.toLowerCase()} (${hora(t.inicio)} às ${hora(t.fim)}), a entrada dos convidados é a partir das ${hora(t.inicio)}, no início do período contratado.`
      : `A entrada dos convidados é no início do período contratado: ${lista(catalogos.turnos.map((x) => `${x.nome.toLowerCase()} a partir das ${hora(x.inicio)}`))}.`, [{ tipo: 'PERIODOS_AGENDA' }]);
  }
  // Rodada 32: a frase de proteção de cada consulta comum que afastou um cuidado só do modelo.
  for (const c of new Set(cuidadosAfastados.map((x) => x.criterio))) dizer(e, PROTECAO_CONSULTA_COMUM[c]);
  // Pergunta que nenhuma fonte responde ("tem wi-fi?"): respondido o resto, a equipe responde essa parte.
  // Rodada 19: com a festa já contratada, a equipe responde a mensagem inteira (sem a frase de "parte não cadastrada").
  // Rodada 19: idem quando a mensagem já vai para a equipe por alergia, reclamação, pedido de pessoa, pagamento ou
  // negociação — a frase de "parte não cadastrada" só serve quando o resto foi respondido pelo Wall-e.
  if (entendimento.semFonte?.length && !intencoes.some((i) => i.tipo === 'CONTRATO_PROPRIO') && !e.encaminhar.some((m) => ['RESTRICAO_ALIMENTAR', 'RECLAMACAO', 'PEDIDO_CLIENTE', 'PAGAMENTO', 'NEGOCIACAO'].includes(m))) { dizer(e, entendimento.semFonte.length > 1 ? 'Algumas perguntas da sua mensagem eu não tenho cadastradas para responder por aqui.' : 'Uma parte da sua mensagem eu não tenho cadastrada para responder por aqui.'); passar(e, 'INFORMACAO_INDISPONIVEL'); }

  // Rodada 40: "tem essa data?", "quero reservar", "quero fechar": o link PÚBLICO de disponibilidade/fechamento da empresa
  // (o mesmo para todos; diferente do link individual de contrato). Não sai com proteção, pedido de pessoa, reclamação ou
  // passagem para a equipe. Rodada 42: uma vez por conversa (já enviado, não volta a cada consulta nem a cada passo da
  // contratação). O link não reserva nada.
  // Rodada 43: "já ficou reservado?" — consultar ou conversar não reserva (quem já tem festa contratada ou paga segue o
  // tratamento protegido); "manda o link de novo" — o link pedido sai, mesmo já enviado antes.
  const semCuidado = !protecao && !pediuPessoa && !s?.reclamacao && !e.encaminhar.length;
  if (entendimento.perguntaReserva && semCuidado) {
    e.paragrafos = e.paragrafos.filter((p) => p.texto !== RESERVA_SO_COM_CONTRATACAO);
    dizer(e, RESERVA_STATUS); e.ctx = { ...e.ctx, avisoReserva: true };
  }
  const linkPedido = entendimento.pedeLink && semCuidado ? e.fontes.linkDisponibilidade?.() ?? null : null;
  if (entendimento.pedeLink && semCuidado && !linkPedido) dizer(e, 'Não tenho um link de disponibilidade para enviar por aqui, mas consulto a data para você: é só me dizer o dia.');
  if (linkPedido) { dizer(e, `${entrada.contexto.linkDisponibilidade ? 'Aqui está o link de novo' : 'Aqui está o link'} para consultar os horários e continuar a contratação:\n${linkPedido}`, [{ tipo: 'LINK_DISPONIBILIDADE' }]); e.ctx = { ...e.ctx, linkDisponibilidade: true }; }
  const linkPublico = !linkPedido && (tipos.has('DISPONIBILIDADE') || tipos.has('CONTRATAR')) && !protecao && !pediuPessoa && !s?.reclamacao && !e.encaminhar.length
    && !entrada.contexto.linkDisponibilidade ? e.fontes.linkDisponibilidade?.() ?? null : null;
  if (linkPublico) {
    const avisoReserva = e.paragrafos.some((p) => p.texto === RESERVA_SO_COM_CONTRATACAO) ? '' : ' Enviar este link não reserva a data: ela só fica garantida quando a contratação é concluída.';
    e.paragrafos = e.paragrafos.filter((p) => p.texto !== RESERVA_SO_COM_CONTRATACAO);
    dizer(e, `${tipos.has('CONTRATAR') ? 'Se preferir, você pode consultar os horários disponíveis e continuar a contratação por aqui' : 'Você também pode consultar os horários disponíveis e escolher a sua festa por aqui'}:\n${linkPublico}\n${avisoReserva ? avisoReserva.trim() : RESERVA_SO_COM_CONTRATACAO} Se precisar de ajuda durante o preenchimento, estou por aqui.`, [{ tipo: 'LINK_DISPONIBILIDADE' }]);
    e.ctx = { ...e.ctx, linkDisponibilidade: true };
  }

  // A pergunta pendente volta UMA vez depois de outro assunto; ignorada de novo, sai (sem insistir a cada mensagem).
  // Convite opcional ("se quiser, me conte o tema") não volta.
  const reperguntas = pendente?.reperguntas ?? 0;
  const retomadas: CampoPendente[] = [];
  // Rodada 24: com outro assunto na mensagem, pendência de cardápio, decoração (tema), pacotes ou endereço não é
  // acrescentada ("qual o endereço?" não pede o tema que ficou pendente); a qualificação de preço, agenda ou contratação
  // em andamento continua pedindo o dado que falta ("tem estacionamento?" no meio do orçamento).
  if (pendente && !pendente.opcional && !agradecimento && !tipos.has(pendente.para) && !e.encaminhar.length && reperguntas < 1 && (soDado || qualificacao)) for (const campo of faltando(pendente.campos)) { if (!e.perguntas.some((p) => p.campo === campo)) retomadas.push(campo); perguntar(e, campo, pendente.para); }

  // Pergunta só o que falta (até duas coisas), em uma frase. Passagem para a equipe dispensa as perguntas.
  let passagem: Passagem | null = null;
  if (e.encaminhar.length) {
    // Rodada 26: contratação à espera da confirmação da data, com outra parte da mensagem indo para a equipe: a equipe
    // recebe também a contratação (a data a confirmar fica nas pendências).
    if (e.confirmarData && !e.encaminhar.includes('CONTRATACAO')) e.encaminhar.splice(Math.min(e.posContratacao ?? 0, e.encaminhar.length), 0, 'CONTRATACAO');
    const motivo = e.encaminhar[0];
    // Sugestão para o atendente (conversa já com a equipe): sem a frase de passagem; os motivos vão no resultado.
    // Rodada 18: com a passagem não há o que pedir — a abertura da coleta ("preciso de poucos dados") sai junto.
    // Rodada 26: a confirmação da data da contratação também não sai: a equipe confirma (fica nas pendências da passagem).
    e.paragrafos = e.paragrafos.filter((p) => p.texto !== COLETA && p.texto !== VALORES_DEPENDEM && !p.texto.startsWith(CONFIRMA_CONTRATACAO));
    if (!opcoes.sugestao) dizer(e, motivo === 'CONTRATACAO' ? PASSAGEM_AO_CLIENTE.CONTRATACAO : `${PASSAGEM_AO_CLIENTE[motivo]} Em breve alguém responde por aqui.`);
    passagem = {
      motivo, motivos: [...e.encaminhar], em: e.agora,
      coletado: { data: e.ctx.data ?? null, turno: turnoTexto(catalogos, e.ctx.turno), convidados: e.ctx.convidados ?? null, pacote: nomePacote(catalogos, e.ctx.pacote), unidade: nomeUnidade(catalogos, e.ctx.unidade), tema: e.ctx.tema ?? null },
      enviados: [...new Map((e.ctx.enviados ?? []).map((x) => [x.prontaId, x])).values()].map((x) => ({ titulo: e.anexos.find((a) => a.prontaId === x.prontaId)?.titulo ?? x.finalidade, finalidade: x.finalidade })),
      pendentes: e.perguntas.map((p) => PERGUNTA[p.campo](catalogos)),
      ultimaMensagem: entrada.texto.slice(0, 500),
    };
    e.ctx = comPendente(e.ctx, [], 'OUTRO');
  } else if (e.perguntas.length) {
    // Rodada 26: com pergunta obrigatória, o convite opcional ("se quiser, me conte o tema") fica de fora — junto dela ele
    // virava obrigatório ("me diga o período e o tema da festa").
    const ordenadas = [...e.perguntas].sort((a, b) => Number(!!a.opcional) - Number(!!b.opcional) || PRIORIDADE_PERGUNTA.indexOf(a.campo) - PRIORIDADE_PERGUNTA.indexOf(b.campo));
    const escolhidas = (ordenadas.some((p) => !p.opcional) ? ordenadas.filter((p) => !p.opcional) : ordenadas).slice(0, 2);
    const opcional = escolhidas.every((p) => p.opcional);
    // "À tarde" (rodada 18): os dois períodos, sem escolher um.
    const tarde = !opcional && !!entendimento.periodoAmbiguo && escolhidas.some((p) => p.campo === 'turno');
    // Rodada 21: a data já pedida na mesma resposta ("me diga qual data você quer comparar") não é pedida de novo.
    const demais = escolhidas.filter((p) => !(tarde && p.campo === 'turno') && !(p.campo === 'data' && e.paragrafos.some((x) => x.texto === COMPARAR_DATA || x.texto === COMPARAR_OUTRA || x.texto === CONFIRMAR_DATA || x.texto === AGENDA_POR_DATA || x.texto.startsWith(CONFIRMA_CONTRATACAO))) && !(p.campo === 'tema' && e.paragrafos.some((x) => x.texto === TEMA_A_DECIDIR)));
    // O período ("à tarde") vem antes do resto, na ordem das perguntas.
    // Rodada 26: no meio de um orçamento ("e se for à tarde?"), a pergunta do período vem sozinha, sem reabrir a explicação.
    if (tarde && (entrada.contexto.assuntos ?? []).includes('PRECOS')) e.paragrafos = e.paragrafos.filter((p) => p.texto !== VALORES_DEPENDEM);
    if (tarde) dizer(e, `Sobre “à tarde”: os períodos são ${lista(catalogos.turnos.map((x) => `${x.nome.toLowerCase()} (${hora(x.inicio)} às ${hora(x.fim)})`))}. Qual você prefere?`);
    // Rodada 21: o mesmo convite opcional da resposta anterior não se repete.
    const conviteRepetido = opcional && !!pendente?.opcional && demais.every((p) => pendente.campos.includes(p.campo));
    if (demais.length && !conviteRepetido) dizer(e, opcional ? `Se quiser, me conte ${lista(demais.map((p) => PERGUNTA[p.campo](catalogos)))} que eu anoto.` : `${e.paragrafos.length ? 'Para continuar' : 'Para eu ajudar'}, me diga ${lista(demais.map((p) => PERGUNTA[p.campo](catalogos)))}.`);
    e.ctx = comPendente(e.ctx, escolhidas.map((p) => p.campo), escolhidas[0].para, opcional);
    if (e.ctx.pendente && e.confirmarData && escolhidas.some((p) => p.campo === 'data')) e.ctx.pendente.confirmarData = e.confirmarData;
    if (e.ctx.pendente && escolhidas.every((p) => retomadas.includes(p.campo))) e.ctx.pendente.reperguntas = reperguntas + 1;
  } else e.ctx = comPendente(e.ctx, [], 'OUTRO');

  // Nunca uma resposta vazia (o worker a trataria como falha e passaria para a equipe): sem nada a dizer, o menu.
  if (!e.paragrafos.length && !e.anexos.length) dizer(e, MENU);
  // Rodada 20: com a explicação da variação por data, "Os valores dependem…" não repete a mesma ideia.
  if (e.paragrafos.some((p) => p.texto === VARIA_POR_DATA)) e.paragrafos = e.paragrafos.filter((p) => p.texto !== VALORES_DEPENDEM);
  // O mesmo parágrafo duas vezes (o assunto retomado refaz o que a mensagem já respondeu) sai uma vez só (rodada 18).
  e.paragrafos = e.paragrafos.filter((p, i) => e.paragrafos.findIndex((q) => q.texto === p.texto) === i);
  // Rodada 40 (humanização): responde ao cumprimento no mesmo tom ("Boa tarde! Tudo bem, e você?") e se apresenta só na
  // primeira resposta. Com reclamação, nada de cordialidade automática; a sugestão para o atendente sai sem apresentação.
  // Rodada 41: a apresentação oferece falar com uma pessoa, exceto quando a mensagem já vai para a equipe.
  const soSaudacao = intencoes.length === 1 && intencoes[0].tipo === 'SAUDACAO';
  // Agradecimento ou "combinado" sozinhos não abrem com apresentação ("Por nada!" basta).
  const apresentar = !jaApresentado && !intencoes.every((i) => ['CONFIRMACAO', 'SAUDACAO'].includes(i.tipo));
  if (!opcoes.sugestao && !s?.reclamacao && !soSaudacao && e.paragrafos.length) {
    const c = cumprimentoDoCliente(entrada.texto);
    const abertura = [c.periodo || c.comoVai ? `${c.periodo ?? 'Olá'}!${c.comoVai ? ' Tudo bem, e você?' : ''}` : apresentar ? 'Olá!' : '', apresentar ? `Sou o Wall-e, agente inteligente da ${e.config.nome}.${e.encaminhar.length ? '' : ` ${OFERTA_PESSOA}`}` : ''].filter(Boolean).join(' ');
    // O menu (nada a dizer) fica na mesma frase da abertura: um parágrafo só, como a resposta à saudação.
    // (o menu já diz como falar com uma pessoa: a oferta da apresentação não se repete)
    if (abertura && e.paragrafos[0].texto === MENU) e.paragrafos[0] = { ...e.paragrafos[0], texto: `${abertura.replace(` ${OFERTA_PESSOA}`, '')} ${MENU}` };
    else if (abertura) e.paragrafos.unshift({ texto: abertura, fontes: [] });
  }
  // Fechamento só com a dúvida resolvida: sem passagem, sem dado pendente, sem pergunta no fim, fora do menu, da
  // confirmação e do link público (que já se coloca à disposição). Uma vez a cada 30 minutos: quem continua perguntando
  // logo depois do fechamento não recebe a mesma pergunta a cada resposta.
  const ultimoParagrafo = e.paragrafos.at(-1)?.texto ?? '';
  const resolvido = !passagem && !opcoes.sugestao && !s?.reclamacao && !e.ctx.pendente?.campos.length && !linkPublico && e.paragrafos.length
    && intencoes.some((i) => !['SAUDACAO', 'CONFIRMACAO', 'OUTRO'].includes(i.tipo)) && !/\?\s*$/.test(ultimoParagrafo) && !ultimoParagrafo.endsWith(MENU);
  const fechouHaPouco = !!entrada.contexto.fechamentoEm && Date.parse(e.agora) - Date.parse(entrada.contexto.fechamentoEm) < 30 * 60_000;
  // Rodada 41: o fechamento lembra que dá para falar com uma pessoa (sem repetir a oferta da apresentação na mesma resposta).
  if (resolvido && !fechouHaPouco) { dizer(e, e.paragrafos.some((p) => p.texto.includes(OFERTA_PESSOA)) ? FECHAMENTO : `${FECHAMENTO} ${OFERTA_PESSOA}`); e.ctx = { ...e.ctx, fechamentoEm: e.agora }; }
  // Rodada 36: acima do limite de uma mensagem, a resposta vai em mais de uma, partida entre parágrafos (ou frases) —
  // nunca cortada no meio de uma frase ou informação.
  const saidas: Saida[] = partirMensagem(e.paragrafos).map((p) => ({ texto: p.texto, anexo: null, fontes: p.fontes }));
  for (const a of e.anexos.slice(0, 3)) saidas.push({ texto: null, anexo: a, fontes: [{ tipo: 'PRONTA', id: a.prontaId, versao: a.versao, finalidade: a.finalidade }] });
  // Rodada 27: mensagem protegida (festa contratada, alergia, reclamação, pedido de pagamento) não altera o contexto
  // comercial da conversa: o que ela cita (a data da festa já marcada, os convidados dela) vai à equipe no resumo da
  // passagem, não vira dado da conversa comercial.
  // Rodada 40: a apresentação enviada fica marcada (não se repete nas próximas respostas).
  if (!opcoes.sugestao && e.paragrafos.some((p) => p.texto.includes('Sou o Wall-e, agente inteligente'))) e.ctx = { ...e.ctx, apresentado: true };
  return { saidas, contexto: protecao ? semDadosDaMensagem(e.ctx, entrada.contexto) : e.ctx, passagem, ...(cuidadosAfastados.length ? { cuidadosAfastados } : {}) };
}
