import { z } from "zod";
import type { DbExecutor } from "../../db/contracts.ts";
import type { CampoRascunho } from "../contratos.ts";
import { InteligenciaError } from "../politica.ts";
import { mesmoNome, nomeDaResposta, normalizar, reais } from "../texto-pt.ts";
import { ErroCampo } from "./human-gate.ts";
import { NOMES_V1_EXATOS, QUANTIDADE_COM_UNIDADE, lerPacote } from "../pacote-informado.ts";

/** Marca interna da extração: a mensagem não traz escolha segura de pacote (consumida por `combinarContratacao`). */
const PACOTE_INCERTO = "__pacoteIncerto";
import type { DefinicaoCampo, FerramentaAcao } from "./tipos.ts";

/**
 * Preparar contratação (IA operacional, marco C) — "crie uma festa do Felipe, pacote premium, 50 convidados…".
 *
 * Criar festa NÃO grava festa: prepara o Fechamento administrativo (fluxo oficial) e abre a REVISÃO preenchida no
 * formulário oficial. Nada é gravado aqui — nem fechamento, nem festa, nem cliente/aniversariante auxiliar:
 * - cliente, aniversariante e pacote só por referência comprovada no Core (busca no tenant); nome duplicado ⇒ escolha;
 * - ano, horário, valor e pagamento nunca por palpite; data impossível ⇒ correção; turnos/horários conflitantes ⇒
 *   esclarecimento ou pendência;
 * - disponibilidade e valor de tabela dos serviços oficiais (somente leitura);
 * - a aprovação é o envio do formulário oficial, que consome esta preparação (vínculo idempotente): o "Confirmar" do
 *   chat NUNCA executa (`revisao`), para não haver dois caminhos de criação concorrentes.
 */
export const CAPACIDADE_CONTRATACAO = "preparar_contratacao";
const PAPEIS = ["ADMINISTRATIVO", "REPRESENTANTE_AUTORIZADO"] as const;

/**
 * Ids V1 dos sete pacotes do catálogo da Kidmais (dona da agenda pública). Nas demais empresas o pacote é o DELAS: o
 * informado (id V1, código ou nome) é resolvido no Core contra a lista da empresa comprovada (`resolverPacote`).
 */
const CODIGOS = ["pocket", "mini", "compacta", "essencial", "completa", "premium", "pizza_party_scienza"] as const;
export type CodigoPacote = (typeof CODIGOS)[number];
export const CODIGO_BANCO: Readonly<Record<CodigoPacote, string>> = {
  pocket: "POCKET", mini: "MINI_FESTA", compacta: "COMPACTA", essencial: "ESSENCIAL", completa: "COMPLETA", premium: "PREMIUM", pizza_party_scienza: "PIZZA_PARTY",
};

/**
 * Código do pacote no banco para o id informado: id V1 traduzido, ou o próprio código (POCKET, P_…). Mesma regra de
 * `codigoDoPacoteDaTela(id, true)` em lib/comercial/pacotes-v1 (a camada de IA não importa o Core; teste de paridade).
 */
const CODIGO_PACOTE_LIVRE = /^[A-Z][A-Z0-9_]{1,49}$/;
export function codigoBancoDoPacote(id: string): string | null {
  if ((CODIGOS as readonly string[]).includes(id)) return CODIGO_BANCO[id as CodigoPacote];
  return CODIGO_PACOTE_LIVRE.test(id) ? id : null;
}

/** Nomes que o operador usa para os sete pacotes V1 (fora deles, o nome livre é resolvido no Core pela empresa). */
const NOMES_PACOTE: ReadonlyArray<[CodigoPacote, RegExp]> = [
  ["pizza_party_scienza", /\bpizza\s*party\b/],
  ["mini", /\bmini(?:\s*festa)?\b/],
  ["pocket", /\bpocket\b/],
  ["compacta", /\bcompacta\b/],
  ["essencial", /\bessencial\b/],
  ["completa", /\bcompleta\b/],
  ["premium", /\bpremium\b/],
];

// ---------------------------------------------------------------- porta (serviços oficiais, somente leitura)

export type ClienteContratacao = { nome: string; ativo: boolean; camposFaltantes: readonly string[]; aniversariantes: ReadonlyArray<{ id: string; nome: string }> };
export type PortaContratacao = {
  /** Busca do CRM no tenant comprovado (id, nome, ativo). */
  buscarClientes(tx: DbExecutor, empresaId: string, termo: string): Promise<ReadonlyArray<{ id: string; nome: string; ativo: boolean }>>;
  /** Contexto do Fechamento administrativo (mesmas regras do wizard), sem lançar por cadastro incompleto. null ⇒ inexistente nesta empresa. */
  cliente(tx: DbExecutor, empresaId: string, clienteId: string): Promise<ClienteContratacao | null>;
  /** Pacote vigente e ativo DA EMPRESA pelo código. */
  pacote(tx: DbExecutor, empresaId: string, codigoBanco: string): Promise<{ id: string; nome: string; minimo: number | null; maximo: number | null } | null>;
  /** Pacotes contratáveis da empresa (código e nome), na ordem da tela de Pacotes — para resolver o pacote pelo nome. */
  pacotes(tx: DbExecutor, empresaId: string): Promise<ReadonlyArray<{ codigo: string; nome: string }>>;
  /** A empresa é a dona da agenda pública (sete ids V1 e regras da Kidmais)? Mesma decisão do Fechamento administrativo. */
  dona(tx: DbExecutor, empresaId: string): Promise<boolean>;
  /**
   * Regra OFICIAL de convidados do Fechamento: dona = `erroConvidadosFechamento` (regras da Kidmais); demais =
   * `erroConvidadosEmpresa` (só o mínimo e o máximo do pacote). Mensagem humana ou null.
   */
  erroConvidados(codigo: string, pacote: { nome: string; minimo: number | null; maximo: number | null }, convidados: number, dona: boolean): string | null;
  /** Horários DISPONÍVEIS do turno na data (serviço oficial de disponibilidade). null ⇒ turno sem configuração. */
  horarios(tx: DbExecutor, empresaId: string, data: string, turno: "almoco" | "noite"): Promise<{ configuracaoId: string; horarios: ReadonlyArray<{ inicio: string; fim: string }> } | null>;
  /** Valor de tabela do pacote (sem adicionais), em centavos, pelo serviço comercial oficial. null ⇒ sem tabela. */
  precoTabela(tx: DbExecutor, empresaId: string, entrada: { data: string; configuracaoAgendaId: string; pacoteId: string; convidados: number }): Promise<number | null>;
};

// ---------------------------------------------------------------- extração determinística


const MESES = ["janeiro", "fevereiro", "marco", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const PALAVRAS_NAO_NOME = new Set(["festa", "pacote", "tema", "convidados", "convidado", "cliente", "dia", "de", "do", "da", "com", "para", "e", "a", "o", "aniversario", "aniversariante", "uma", "um", "crie", "criar", "nova", "novo", "premium", "mini", "pocket", "compacta", "essencial", "completa"]);

/**
 * Resposta crua a uma pergunta de nome só vale se PARECER nome: poucas palavras e nenhuma palavra de pedido ("Quero criar
 * uma festa e não um pacote" respondendo "Qual é o cliente?" não vira o cliente). Conectivos de nome ("da Silva") valem.
 */
const PALAVRAS_DE_PEDIDO = new Set([
  ...[...PALAVRAS_NAO_NOME].filter((p) => !["de", "do", "da", "e", "a", "o"].includes(p)),
  "quero", "queria", "gostaria", "preciso", "nao", "sim", "cancele", "cancelar", "cancela", "voltar", "volte", "retomar",
  "quantos", "quantas", "qual", "quais", "como", "quando", "onde", "faca", "estime", "calcule", "mostre", "abra", "rascunho",
  "docinhos", "doces", "refrigerante", "refrigerantes",
]);
function pareceNome(nome: string): boolean {
  const palavras = normalizar(nome).split(/\s+/).filter(Boolean);
  return palavras.length >= 1 && palavras.length <= 6 && !palavras.some((p) => PALAVRAS_DE_PEDIDO.has(p));
}

const iso = (a: number, m: number, d: number) => `${a}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

export function dataReal(data: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(data);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

const dataCurta = (data: string) => `${data.slice(8, 10)}/${data.slice(5, 7)}/${data.slice(0, 4)}`;

/** "15/11/2026", "15/11", "15 de novembro de 2026", "15 de novembro". Sem ano ⇒ só dia/mês (o ano é perguntado). */
function extrairData(n: string): { data?: string; diaMes?: string } {
  const barra = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\b/.exec(n);
  const extenso = new RegExp(`\\b(\\d{1,2}) de (${MESES.join("|")})(?: de (\\d{4}))?\\b`).exec(n);
  const achado = barra ? { d: Number(barra[1]), m: Number(barra[2]), a: barra[3] } : extenso ? { d: Number(extenso[1]), m: MESES.indexOf(extenso[2]) + 1, a: extenso[3] } : null;
  if (!achado || achado.m < 1 || achado.m > 12 || achado.d < 1 || achado.d > 31) return {};
  if (!achado.a) return { diaMes: `${String(achado.d).padStart(2, "0")}/${String(achado.m).padStart(2, "0")}` };
  return { data: iso(Number(achado.a), achado.m, achado.d) };
}

function capitalizar(nome: string) {
  return nome.trim().replace(/\s+/g, " ").split(" ").map((p) => (p.length > 2 || p === p.toUpperCase() ? p.charAt(0).toUpperCase() + p.slice(1) : p)).join(" ");
}

const FIM_NOME = String.raw`(?=\s*(?:[,;.!?]|$|\s(?:pacote|com|no|na|dia|em|para|tema|de \d|\d)\b))`;

export function extrairContratacao(texto: string, perguntado: string | null): Record<string, unknown> {
  const t = texto.replace(/\s+/g, " ").trim();
  const n = normalizar(t);
  const v: Record<string, unknown> = {};

  // Resposta direta à pergunta feita.
  if (perguntado === "cliente") {
    const nome = nomeDaResposta(t.replace(/^(?:[ée] (?:o|a) |o cliente |a cliente |cliente )/i, ""));
    if (nome && /^[\p{L}][\p{L}' .-]{1,79}$/u.test(nome) && pareceNome(nome)) v.cliente = nome;
    return v;
  }
  if (perguntado === "ano") {
    const ano = /\b(20\d{2})\b/.exec(n);
    if (ano) v.ano = Number(ano[1]);
  }

  const cliente = new RegExp(String.raw`\b(?:festa|aniversario|contratacao)\s+(?:do|da|de|para o|para a|pro|pra)\s+(?:(?:o |a )?(?:cliente|contratante)\s+)?([\p{L}][\p{L}' ]{1,58}?)${FIM_NOME}`, "iu").exec(t)
    ?? new RegExp(String.raw`\bclientes?\s*:?\s+([\p{L}][\p{L}' ]{1,58}?)${FIM_NOME}`, "iu").exec(t);
  if (cliente && !PALAVRAS_NAO_NOME.has(normalizar(cliente[1]))) v.cliente = capitalizar(cliente[1]);

  // Nome completo como dito (id V1 só se for exatamente um dos sete) e o trecho bruto que o Core confronta com o catálogo.
  // INCERTO (só menção negada/excluída, ou alternativas diferentes): nenhuma escolha — marca para `combinarContratacao`
  // perguntar, sem os nomes V1 de sempre. NENHUMA menção legível: os nomes V1 de sempre, como antes.
  // pacoteTexto sempre acompanha o pacote (nunca fica de uma mensagem anterior).
  const leitura = lerPacote(t, perguntado === "pacote");
  if (leitura.tipo === "dito") {
    v.pacote = leitura.pacote.nome;
    v.pacoteTexto = leitura.pacote.trecho;
    v.pacoteResto = leitura.pacote.resto ?? null;
    v.pacoteRecusas = leitura.pacote.recusas?.join(" | ").slice(0, 200) ?? null;
  } else if (leitura.tipo === "incerto") {
    v[PACOTE_INCERTO] = true;
  } else {
    const trechoPacote = perguntado === "pacote" ? n : (/\bpacote\s+(.{1,30})/.exec(n)?.[1] ?? "");
    const v1 = NOMES_PACOTE.find(([, r]) => r.test(trechoPacote))?.[0];
    if (v1) {
      v.pacote = v1;
      v.pacoteTexto = null;
      v.pacoteResto = null;
      v.pacoteRecusas = null;
    }
  }

  const convidados = /\b(\d{1,3})\s*(?:convidad\w*|pessoas|criancas|pagantes)\b/.exec(n) ?? (perguntado === "convidados" ? /^(\d{1,3})\b/.exec(n) : null);
  if (convidados) v.convidados = Number(convidados[1]);

  // Aniversariante + idade: "beatriz 1 ano", "Beatriz, 5 anos", "aniversariante Beatriz".
  const comIdade = /([\p{L}]{2,30})\s*,?\s*(?:de |com |faz |fara |completa )?(\d{1,2})\s*anos?\b/iu.exec(t.normalize("NFC"));
  // "o aniversariante é o Theo" / "aniversariante se chama Ana": o verbo e o artigo não fazem parte do nome.
  const marcado = /\baniversariante\s*:?\s*(?:(?:é|e|eh|sera|será|se chama|chama)\s+)?(?:(?:o|a)\s+)?([\p{L}][\p{L}' ]{1,40}?)(?=\s*(?:[,;.!?]|$|\s(?:com|de \d|\d)\b))/iu.exec(t);
  if (perguntado === "aniversariante" && !comIdade && !marcado) {
    const nome = nomeDaResposta(t.replace(/^(?:[ée] (?:o|a) |(?:o|a) )/i, ""));
    if (nome && /^[\p{L}][\p{L}' -]{1,59}$/u.test(nome) && pareceNome(nome)) v.aniversariante = capitalizar(nome);
  } else if (marcado && !PALAVRAS_NAO_NOME.has(normalizar(marcado[1]))) {
    v.aniversariante = capitalizar(marcado[1]);
  } else if (comIdade && !PALAVRAS_NAO_NOME.has(normalizar(comIdade[1]))) {
    v.aniversariante = capitalizar(comIdade[1]);
  }
  if (comIdade) v.idade = Number(comIdade[2]);

  const tema = /\btema\s*(?:de |do |da |:\s*)?([^,;.!?]{2,60})/iu.exec(t);
  if (tema) v.tema = tema[1].trim();

  Object.assign(v, extrairData(n));

  const almoco = /\balmoc[oa]\b/.test(n);
  const noite = /\b(noite|jantar|noturn[oa])\b/.test(n);
  if (almoco !== noite) v.turno = almoco ? "almoco" : "noite";
  else if (almoco && noite) v.turnoConflito = true;
  const horarios = [...new Set([...n.matchAll(/\b(?:as|a partir das|das|para as)\s*(\d{1,2})(?:(?::|h)(\d{2}))?\s*(?:h|horas?)?\b|\b(\d{1,2})h(\d{2})?\b/g)]
    .map((m) => [Number(m[1] ?? m[3]), Number(m[2] ?? m[4] ?? 0)])
    .filter(([h, mi]) => h >= 0 && h <= 23 && mi >= 0 && mi <= 59)
    .map(([h, mi]) => `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`))];
  if (horarios.length === 1) v.horario = horarios[0];
  if (horarios.length > 1) v.horarioConflito = horarios.slice(0, 4);
  return v;
}

/**
 * Conversa adaptativa: campos da contratação que a Luna entendeu (já conferidos contra o texto do usuário). Só nomes,
 * números e códigos fechados — nenhum id; cliente, aniversariante e pacote continuam resolvidos no Core por `verificar`.
 */
export function contratacaoDoModelo(v: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const saida: Record<string, unknown> = {};
  const texto = (x: unknown, max: number) => (typeof x === "string" && x.trim() && x.trim().length <= max ? x.trim() : null);
  const cliente = texto(v.cliente, 80);
  if (cliente && /^[\p{L}][\p{L}' .-]{1,79}$/u.test(cliente)) saida.cliente = capitalizar(cliente);
  const aniversariante = texto(v.aniversariante, 60);
  if (aniversariante && /^[\p{L}][\p{L}' .-]{1,59}$/u.test(aniversariante)) saida.aniversariante = capitalizar(aniversariante);
  // Id V1 ou o nome/código dito pelo usuário (texto curto); o Core resolve contra os pacotes da empresa comprovada.
  const pacote = texto(v.pacote, 60);
  if (pacote && /^[\p{L}\p{N}][\p{L}\p{N} '_-]*$/u.test(pacote)) saida.pacote = pacote;
  if (Number.isInteger(v.convidados) && (v.convidados as number) >= 1 && (v.convidados as number) <= 500) saida.convidados = v.convidados;
  if (Number.isInteger(v.idade) && (v.idade as number) >= 0 && (v.idade as number) <= 120) saida.idade = v.idade;
  const tema = texto(v.tema, 200);
  if (tema) saida.tema = tema;
  if (typeof v.data === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.data)) saida.data = v.data;
  else if (typeof v.diaMes === "string" && /^\d{2}\/\d{2}$/.test(v.diaMes)) saida.diaMes = v.diaMes;
  if (v.turno === "almoco" || v.turno === "noite") saida.turno = v.turno;
  if (typeof v.horario === "string" && HORA.test(v.horario)) saida.horario = v.horario;
  return saida;
}

/**
 * Mensagem atual × Luna: a Luna vence campo a campo, como nas outras ações, salvo no pacote — o pacote que a MENSAGEM
 * ATUAL traz de forma legível (resposta direta, frase composta, a escolha afirmada ao lado de uma recusada) vence sempre o
 * da Luna: ela pode ter encurtado ("Premium Jardim" × premium), trocado por um apelido ("Festa Premium" × premium) ou
 * trazido o recusado/o do histórico. A Luna só decide o pacote quando a mensagem não traz nenhum legível. Assim a
 * resposta seguinte à pergunta sempre conclui a escolha (sem laço de "Qual pacote?"). O trecho bruto só acompanha o
 * pacote que veio da mensagem; histórico e mensagens anteriores não entram aqui.
 */
export function combinarContratacao(extraido: Record<string, unknown>, doModelo: Record<string, unknown>): Record<string, unknown> {
  const { [PACOTE_INCERTO]: incerto, ...semMarca } = extraido;
  const saida: Record<string, unknown> = { ...semMarca, ...doModelo };
  if (incerto === true) {
    // A mensagem atual nega/exclui o pacote ou traz alternativas: nenhuma escolha, nem a da Luna — o pacote fica sem valor
    // (inclusive o de uma mensagem anterior) e a próxima pergunta é "Qual pacote?".
    saida.pacote = undefined;
    saida.pacoteTexto = null;
    saida.pacoteResto = null;
    saida.pacoteRecusas = null;
    return saida;
  }
  if (typeof extraido.pacote === "string") {
    saida.pacote = extraido.pacote;
    saida.pacoteTexto = extraido.pacoteTexto ?? null;
    saida.pacoteResto = extraido.pacoteResto ?? null;
    saida.pacoteRecusas = extraido.pacoteRecusas ?? null;
  } else if (saida.pacote !== undefined) {
    saida.pacoteTexto = null;
    saida.pacoteResto = null;
    saida.pacoteRecusas = null;
  }
  return saida;
}

// ---------------------------------------------------------------- campos, validação e preview

const CAMPOS: readonly DefinicaoCampo[] = [
  { id: "cliente", rotulo: "Cliente", obrigatorio: true, perguntar: true, pergunta: "Qual é o cliente (contratante)? Informe o nome como está no CRM." },
  { id: "pacote", rotulo: "Pacote", obrigatorio: true, perguntar: true, pergunta: "Qual pacote? Informe o nome como está em Configurações → Pacotes." },
  { id: "convidados", rotulo: "Convidados", obrigatorio: true, perguntar: true, pergunta: "Quantos convidados pagantes?" },
  { id: "aniversariante", rotulo: "Aniversariante", obrigatorio: true, perguntar: true, pergunta: "Qual é o nome do aniversariante?" },
  { id: "data", rotulo: "Data", obrigatorio: true, perguntar: true, pergunta: "Qual é a data da festa? Informe dia, mês e ano (ex.: 15/11/2026)." },
  { id: "ano", rotulo: "Ano", obrigatorio: true, perguntar: true, pergunta: "Qual é o ano da festa?" },
  { id: "turno", rotulo: "Turno", obrigatorio: true, perguntar: true, pergunta: "A festa é no almoço ou à noite?" },
];

export function faltandoContratacao(p: Record<string, unknown>): string[] {
  const faltam: string[] = [];
  if (typeof p.cliente !== "string") faltam.push("cliente");
  if (typeof p.pacote !== "string") faltam.push("pacote");
  if (typeof p.convidados !== "number") faltam.push("convidados");
  if (typeof p.aniversariante !== "string") faltam.push("aniversariante");
  if (typeof p.data !== "string") faltam.push(typeof p.diaMes === "string" ? "ano" : "data");
  if (typeof p.turno !== "string") faltam.push("turno");
  return faltam;
}

const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
const uuid = z.string().uuid();
export const payloadContratacaoSchema = z.object({
  cliente: z.string().trim().min(2).max(80),
  clienteId: uuid.nullable().default(null),
  clienteNome: z.string().max(160).nullable().default(null),
  /** Como informado (id V1, código ou nome); depois de `verificar`, o id V1 (dona) ou o código do pacote da empresa. */
  pacote: z.string().trim().min(1).max(60),
  pacoteNome: z.string().max(160).nullable().default(null),
  /** Trecho dito depois de "pacote" até a pontuação, quando maior que o nome ("Festa 15 anos"); o Core confronta com o catálogo. */
  pacoteTexto: z.string().max(80).nullable().default(null),
  /** Restante da linha depois do trecho, numa frase: o Core confere se ela cita OUTRO pacote do catálogo (troca/2ª escolha). */
  pacoteResto: z.string().max(200).nullable().default(null),
  /** Nomes das menções "pacote X" negadas na frase ("A | B"): o Core confronta com o escolhido (afirmado e recusado ⇒ pergunta). */
  pacoteRecusas: z.string().max(200).nullable().default(null),
  convidados: z.number().int().min(1).max(150),
  aniversariante: z.string().trim().min(2).max(60),
  aniversarianteId: uuid.nullable().default(null),
  idade: z.number().int().min(0).max(120).nullable().default(null),
  tema: z.string().trim().min(1).max(200).nullable().default(null),
  data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  turno: z.enum(["almoco", "noite"]),
  horario: z.string().regex(HORA).nullable().default(null),
  horarioConflito: z.array(z.string().regex(HORA)).max(4).nullable().default(null),
  horariosDisponiveis: z.number().int().min(0).max(100).nullable().default(null),
  precoTabelaCentavos: z.number().int().min(0).max(1_000_000_000).nullable().default(null),
  pendencias: z.array(z.string().max(300)).max(10).default([]),
}).strict();
export type PayloadContratacao = z.infer<typeof payloadContratacaoSchema>;

const CHAVES = Object.keys(payloadContratacaoSchema.shape);

/** Só as chaves do contrato (extração deixa marcas como `diaMes`/`ano`); data impossível ⇒ correção, nunca ajuste. */
export function validarContratacao(bruto: Record<string, unknown>): PayloadContratacao {
  const p: Record<string, unknown> = Object.fromEntries(Object.entries(bruto).filter(([k]) => CHAVES.includes(k)));
  if (typeof p.data === "string" && !dataReal(p.data)) {
    throw new ErroCampo(["data", "diaMes", "ano"], `A data ${dataCurta(p.data)} não existe. Qual é a data correta?`);
  }
  if (bruto.turnoConflito === true && typeof p.turno !== "string") throw new ErroCampo(["turno"], "Você citou almoço e noite.");
  const lido = payloadContratacaoSchema.safeParse(p);
  if (!lido.success) {
    const campos = [...new Set(lido.error.issues.map((i) => String(i.path[0] ?? "")).filter(Boolean))];
    throw new ErroCampo(campos, "Confira estes dados da festa.");
  }
  return lido.data;
}

/** Ano perguntado separadamente: junta com o dia/mês já informados (nunca escolhe o ano). */
function completarAno(payload: Record<string, unknown>) {
  if (typeof payload.data !== "string" && typeof payload.diaMes === "string" && typeof payload.ano === "number") {
    const [d, m] = payload.diaMes.split("/").map(Number);
    payload.data = iso(payload.ano, m, d);
  }
  delete payload.ano;
}

const TURNO = { almoco: "Almoço", noite: "Noite" } as const;

export function apresentarContratacao(p: Record<string, unknown>): CampoRascunho[] {
  const linha = (id: string, rotulo: string, valor: string | null, obrigatorio = false): CampoRascunho => ({ id, rotulo, valor, obrigatorio });
  const nomePacote = typeof p.pacoteNome === "string" ? p.pacoteNome : typeof p.pacote === "string" ? capitalizar(String(p.pacote).replace(/_/g, " ")) : null;
  const pendencias = Array.isArray(p.pendencias) ? (p.pendencias as string[]) : [];
  const horario = typeof p.horario === "string" ? `${p.horario} (confirme na revisão)` : Array.isArray(p.horarioConflito) ? `Escolher na revisão (citados: ${(p.horarioConflito as string[]).join(", ")})` : "Escolher na revisão";
  return [
    linha("cliente", "Cliente", typeof p.clienteNome === "string" ? p.clienteNome : typeof p.cliente === "string" ? p.cliente : null, true),
    linha("aniversariante", "Aniversariante", typeof p.aniversariante === "string" ? `${p.aniversariante}${typeof p.idade === "number" ? ` — ${p.idade} ${p.idade === 1 ? "ano" : "anos"}` : ""}${p.aniversarianteId ? "" : p.clienteId ? " (selecionar na revisão)" : ""}` : null, true),
    linha("pacote", "Pacote", nomePacote, true),
    linha("convidados", "Convidados", typeof p.convidados === "number" ? String(p.convidados) : null, true),
    linha("data", "Data", typeof p.data === "string" ? dataCurta(p.data) : typeof p.diaMes === "string" ? `${p.diaMes} (falta o ano)` : null, true),
    linha("turno", "Turno", typeof p.turno === "string" ? TURNO[p.turno as keyof typeof TURNO] ?? null : null, true),
    ...(typeof p.data === "string" && typeof p.turno === "string" ? [linha("horario", "Horário", horario)] : []),
    ...(typeof p.tema === "string" ? [linha("tema", "Tema", p.tema)] : []),
    ...(typeof p.precoTabelaCentavos === "number" ? [linha("valor", "Valor de tabela (sem adicionais)", `${reais(p.precoTabelaCentavos)} — calculado pelo serviço comercial`)] : []),
    ...(pendencias.length ? [linha("pendencias", "Pendências", pendencias.join(" · "))] : []),
    linha("efeito", "O que acontece", "Nada é gravado agora. A revisão abre preenchida; o Fechamento só é criado quando você concluir o formulário."),
  ];
}

// ---------------------------------------------------------------- verificação no Core (somente leitura)

async function resolverCliente(tx: DbExecutor, empresaId: string, nome: string, porta: PortaContratacao) {
  const ativos = (await porta.buscarClientes(tx, empresaId, nome)).filter((c) => c.ativo);
  const exatos = ativos.filter((c) => mesmoNome(c.nome, nome));
  const candidatos = exatos.length ? exatos : ativos;
  if (!candidatos.length) throw new ErroCampo(["cliente"], `Não encontrei cliente ativo chamado "${nome}" nesta empresa (o Kidmais não cadastra clientes por aqui).`);
  if (candidatos.length > 1) {
    const lista = candidatos.slice(0, 5).map((c) => c.nome).join("; ");
    throw new ErroCampo(["cliente"], `Encontrei ${candidatos.length} clientes para "${nome}": ${lista}. Qual deles? Responda com o nome completo.`);
  }
  return candidatos[0];
}

/**
 * Pacote informado → pacote DA EMPRESA comprovada (o Core é a fonte; a IA só repassa o que a pessoa disse).
 * - Dona da agenda pública: só os sete ids V1, como antes (Pizza Party sob consulta).
 * - Demais: id V1 traduzido ou código do pacote (POCKET, P_…); senão, o nome do pacote dela (igual, ou contido sem
 *   ambiguidade). Ambíguo ou inexistente ⇒ pergunta com os nomes reais da empresa; nunca escolhe por palpite.
 * Devolve o id da tela que segue para a revisão: o id V1 (dona) ou o código do pacote (demais).
 */
/**
 * Trecho dito ("Festa 15 anos") contra o catálogo da empresa: o MAIOR começo do trecho que é exatamente o nome de um pacote.
 * Se um nome menor também bate e o resto é quantidade com unidade ("Festa" + "15 anos" = idade ou parte do nome?), a
 * escolha é ambígua: pergunta, nunca escolhe em silêncio. Nenhum começo bate ⇒ null (segue a resolução pelo nome).
 */
/**
 * Cláusulas do resto separadas pelo ALCANCE da negação: numa cláusula que começa negando ("não Premium e sim Completa"),
 * a recusa vai só até a ligação afirmativa (e, mas, sim, quero, prefiro…); o que vem depois volta a ser possível escolha.
 * Tema/decoração é outro dado. `recusas` são os trechos negados — se citam o próprio escolhido, a mensagem o corrigiu.
 */
function evidenciaDoResto(resto: string | null): { escolhas: string[]; recusas: string[] } {
  const escolhas: string[] = [], recusas: string[] = [];
  for (const bruta of (resto ?? "").split(/[,;.!?]/u)) {
    const c = normalizar(bruta).trim();
    if (!c || /^(?:tema|tematica|decoracao|decorada?)\b/u.test(c)) continue;
    if (!/^(?:nao|nunca|sem|nada de|tirando|exceto|menos|fora|salvo)\b/u.test(c)) { escolhas.push(c); continue; }
    // "não quero (o pacote) Premium", "não prefiro Premium": o verbo e o artigo logo depois da negação são dela; a ligação
    // afirmativa só conta depois do objeto recusado.
    const governado = /^(?:nao|nunca|sem|nada de|tirando|exceto|menos|fora|salvo)(?:\s+(?:quero|queria|prefiro|preferia|vou|vai|usar|pegar|fechar|incluir|contratar|levar|o|a|os|as|um|uma|do|da|pacote))*/u.exec(c)![0];
    const objeto = c.slice(governado.length);
    const ligacao = /\s(?:e|mas|porem|sim|quero|prefiro|melhor)\s/u.exec(objeto);
    recusas.push(ligacao ? c.slice(0, governado.length + ligacao.index) : c);
    if (ligacao) escolhas.push(objeto.slice(ligacao.index + ligacao[0].length));
  }
  return { escolhas, recusas };
}
const clausulasDeEscolha = (resto: string | null) => evidenciaDoResto(resto).escolhas;
/**
 * Alguma recusa cita o escolhido — fora de um nome MAIOR do catálogo que o contém ("não quero o pacote Premium Jardim"
 * não recusa o Premium).
 */
function recusaCitaEscolhido(recusas: readonly string[], escolhido: string, lista: ReadonlyArray<{ nome: string }>) {
  const nome = normalizar(escolhido);
  const maiores = lista.map((x) => normalizar(x.nome)).filter((x) => x !== nome && citaNome(x, nome));
  return recusas.some((r) => {
    let texto = ` ${r.replace(/[^\p{L}\p{N}]+/gu, " ")} `;
    for (const maior of maiores) texto = texto.split(` ${maior} `).join(" ");
    return citaNome(texto, nome);
  });
}

/** O nome (normalizado) aparece como palavras inteiras no texto (normalizado). */
const citaNome = (texto: string, nome: string) => ` ${texto.replace(/[^\p{L}\p{N}]+/gu, " ")} `.includes(` ${nome} `);

/** Complemento que pode seguir o nome do pacote sem ser outra escolha: quantidade/idade/data, "com …", "do/da …", turno. */
const COMPLEMENTO_ACESSORIO = /^(?:(?:para|pra|com|de|e)\s+)?\d|^(?:com|no|na|nos|nas|em|dia|do|da|dos|das|ao|aos|a|as)\b/u;

/**
 * Evidência da frase (trecho + resto da linha) contra o catálogo: outro pacote citado pelo nome completo é troca ou 2ª
 * escolha — pergunta (nunca fica com o primeiro em silêncio). Só a ocorrência que forma o nome escolhido sai da evidência:
 * um nome menor citado à parte ("pacote Premium Jardim, depois Premium") conta como outra escolha.
 */
function outraEscolhaCitada(escolhido: string, evidencia: string, lista: ReadonlyArray<{ nome: string }>) {
  const nomeEscolhido = normalizar(escolhido);
  const resto = ` ${normalizar(evidencia).replace(/[^\p{L}\p{N}]+/gu, " ")} `.replace(` ${nomeEscolhido} `, " ");
  return lista.find((x) => {
    const outro = normalizar(x.nome);
    return outro !== nomeEscolhido && resto.includes(` ${outro} `);
  }) ?? null;
}

function pacoteDoTrecho(trecho: string, lista: ReadonlyArray<{ codigo: string; nome: string }>) {
  const palavras = trecho.trim().split(/\s+/);
  const achados: Array<{ k: number; pacote: { codigo: string; nome: string } }> = [];
  for (let k = palavras.length; k >= 1; k--) {
    const nome = normalizar(palavras.slice(0, k).join(" "));
    const exato = lista.filter((x) => normalizar(x.nome) === nome);
    if (exato.length === 1) achados.push({ k, pacote: exato[0] });
  }
  if (!achados.length) return null;
  const [maior, ...menores] = achados;
  // O nome só vale como começo do trecho se o que vem depois é complemento acessório (quantidade, data, "com …"); outra
  // coisa ("Premium troque para Festa Jardim", "Premium para Completa") pode ser troca ou 2ª escolha: pergunta.
  const depoisDoNome = palavras.slice(maior.k).join(" ");
  if (depoisDoNome && !COMPLEMENTO_ACESSORIO.test(normalizar(depoisDoNome))) {
    throw new ErroCampo(["pacote"], `Não entendi qual pacote em "${trecho}". Qual pacote? Responda só com o nome.`);
  }
  const ambiguo = menores.find((m) => QUANTIDADE_COM_UNIDADE.test(palavras.slice(m.k).join(" ")));
  if (ambiguo) {
    throw new ErroCampo(["pacote"], `"${trecho}" pode ser o pacote ${maior.pacote.nome} ou o pacote ${ambiguo.pacote.nome} (com ${palavras.slice(ambiguo.k).join(" ")} como outro dado). Qual pacote? Responda com o nome completo.`);
  }
  return maior.pacote;
}

export async function resolverPacote(tx: DbExecutor, empresaId: string, informado: string, porta: PortaContratacao, dona: boolean, trecho: string | null = null, resto: string | null = null, recusadas: string | null = null) {
  // Recusas: as cláusulas negadas do resto + as menções "pacote X" negadas na frase.
  const recusas = [...evidenciaDoResto(resto).recusas, ...(recusadas ?? "").split("|").map((x) => normalizar(x).trim()).filter(Boolean)];
  const indisponivel = () => new ErroCampo(["pacote"], "Esse pacote não está disponível nesta empresa.");
  const outraEscolha = (nome: string) => new ErroCampo(["pacote"], `A mensagem cita mais de um pacote (${nome} e outro). Qual pacote? Responda só com o nome.`);
  if (dona) {
    // Como antes da fase 1d: o pacote da dona é um dos sete, reconhecido pelos mesmos nomes (lista fechada). A evidência é
    // a frase inteira (informado + trecho + todas as cláusulas do resto que podem ser escolha — fora negação e
    // tema/decoração): dois dos sete ("Premium para Completa", "pacote Premium, 50 convidados, Completa") não é escolha —
    // pergunta. Com trecho, o nome V1 do começo só vale com complemento acessório.
    const evidencia = normalizar([informado.replace(/_/g, " "), trecho ?? "", ...clausulasDeEscolha(resto)].join(" "));
    const citados = new Set(NOMES_PACOTE.filter(([, r]) => r.test(evidencia)).map(([c]) => c));
    if ((CODIGOS as readonly string[]).includes(informado)) citados.add(informado as CodigoPacote);
    if (citados.size > 1) throw outraEscolha(informado);
    if (trecho) {
      const palavras = normalizar(trecho).split(/\s+/);
      const k = palavras.findLastIndex((_, i) => NOMES_V1_EXATOS[palavras.slice(0, i + 1).join(" ")] !== undefined) + 1;
      const depois = k > 0 ? palavras.slice(k).join(" ") : "";
      if (depois && !COMPLEMENTO_ACESSORIO.test(depois)) throw new ErroCampo(["pacote"], `Não entendi qual pacote em "${trecho}". Qual pacote? Responda só com o nome.`);
    }
    const v1 = [...citados][0];
    if (!v1) throw indisponivel();
    // A mensagem recusou o próprio escolhido depois ("…, não Premium e sim Completa"): pergunta.
    const regraV1 = NOMES_PACOTE.find(([c]) => c === v1)?.[1];
    if (regraV1 && recusas.some((r) => regraV1.test(r))) throw outraEscolha(informado);
    if (v1 === "pizza_party_scienza") throw new ErroCampo(["pacote"], "O Pizza Party está sob consulta: confirme com a equipe. Qual outro pacote?");
    const pacote = await porta.pacote(tx, empresaId, CODIGO_BANCO[v1]);
    if (!pacote) throw indisponivel();
    return { idDaTela: v1 as string, pacote };
  }
  // Com trecho (frase com mais texto depois do nome), a ambiguidade com o catálogo é conferida ANTES do atalho por código
  // ou id V1: "pacote Premium 15 anos" com Premium e Premium 15 anos cadastrados pergunta, não resolve PREMIUM.
  // Mesmas cláusulas da dona: só o alcance da negação ("não Completa") e tema/decoração não contam como outra escolha.
  const evidencia = [trecho ?? informado, ...clausulasDeEscolha(resto)].join(" ");
  const conferido = async <T extends { nome: string }>(r: { idDaTela: string; pacote: T }) => {
    if (!resto && !trecho && !recusadas) return r;
    const outro = outraEscolhaCitada(r.pacote.nome, evidencia, await porta.pacotes(tx, empresaId));
    if (outro) throw outraEscolha(r.pacote.nome);
    // A mensagem recusou o próprio escolhido depois ("…, não Premium e sim Completa"): pergunta.
    if (recusas.length && recusaCitaEscolhido(recusas, r.pacote.nome, await porta.pacotes(tx, empresaId))) throw outraEscolha(r.pacote.nome);
    return r;
  };
  if (trecho) {
    const lista = await porta.pacotes(tx, empresaId);
    const porTrecho = pacoteDoTrecho(trecho, lista);
    if (porTrecho) {
      const pacote = await porta.pacote(tx, empresaId, porTrecho.codigo);
      if (!pacote) throw indisponivel();
      return conferido({ idDaTela: porTrecho.codigo, pacote });
    }
  }
  const porCodigo = codigoBancoDoPacote(informado);
  const direto = porCodigo ? await porta.pacote(tx, empresaId, porCodigo) : null;
  if (porCodigo && direto) return conferido({ idDaTela: porCodigo, pacote: direto });
  const lista = await porta.pacotes(tx, empresaId);
  if (!lista.length) throw new ErroCampo(["pacote"], "Esta empresa ainda não tem pacotes cadastrados: crie em Configurações → Pacotes.");
  const alvo = normalizar(informado.replace(/_/g, " "));
  const exatos = lista.filter((x) => normalizar(x.nome) === alvo);
  // Parecido = o informado é PARTE do nome de um pacote ("Jardim" → "Festa Jardim"). O contrário (o informado tem palavras a
  // mais além de um nome: "Premium troque para Jardim") não escolhe — pode ser outra escolha ou troca; vale o trecho acima.
  const parecidos = exatos.length ? exatos : lista.filter((x) => alvo.length >= 3 && normalizar(x.nome).includes(alvo));
  const nomes = (l: ReadonlyArray<{ nome: string }>) => l.slice(0, 8).map((x) => x.nome).join("; ");
  if (parecidos.length > 1) throw new ErroCampo(["pacote"], `Encontrei ${parecidos.length} pacotes para "${informado}": ${nomes(parecidos)}. Qual deles? Responda com o nome completo.`);
  if (!parecidos.length) throw new ErroCampo(["pacote"], `Não encontrei o pacote "${informado}" nesta empresa. Pacotes disponíveis: ${nomes(lista)}.`);
  const pacote = await porta.pacote(tx, empresaId, parecidos[0].codigo);
  if (!pacote) throw indisponivel();
  return conferido({ idDaTela: parecidos[0].codigo, pacote });
}

export async function verificarContratacao(tx: DbExecutor, empresaId: string, p: PayloadContratacao, porta: PortaContratacao, hoje: string): Promise<{ payload: PayloadContratacao; avisos: string[] }> {
  const pendencias: string[] = [];
  const encontrado = await resolverCliente(tx, empresaId, p.cliente, porta);
  const cliente = await porta.cliente(tx, empresaId, encontrado.id);
  if (!cliente || !cliente.ativo) throw new ErroCampo(["cliente"], `O cliente "${p.cliente}" não está disponível para contratação nesta empresa.`);
  if (cliente.camposFaltantes.length) {
    // Igual ao wizard oficial: sem cadastro completo não há revisão possível. Nada é cadastrado por aqui.
    throw new InteligenciaError("CADASTRO_INCOMPLETO", `O cadastro de ${cliente.nome} está incompleto para contrato (falta: ${cliente.camposFaltantes.slice(0, 6).join(", ")}). Complete no CRM e peça de novo: eu preparo a contratação.`, 409);
  }
  const aniversariantes = cliente.aniversariantes.filter((a) => mesmoNome(a.nome, p.aniversariante) || normalizar(a.nome).split(" ")[0] === normalizar(p.aniversariante));
  let aniversarianteId: string | null = null;
  if (aniversariantes.length === 1) aniversarianteId = aniversariantes[0].id;
  else if (aniversariantes.length > 1) pendencias.push(`Há ${aniversariantes.length} aniversariantes chamados ${p.aniversariante}: escolha na revisão.`);
  else pendencias.push(`${p.aniversariante} não está cadastrado(a) como aniversariante de ${cliente.nome}: cadastre no CRM e selecione na revisão.`);

  const dona = await porta.dona(tx, empresaId);
  const { idDaTela, pacote } = await resolverPacote(tx, empresaId, p.pacote, porta, dona, p.pacoteTexto, p.pacoteResto, p.pacoteRecusas);
  const erroConvidados = porta.erroConvidados(idDaTela, pacote, p.convidados, dona);
  if (erroConvidados) throw new ErroCampo(["convidados"], erroConvidados);

  if (p.data < hoje) throw new ErroCampo(["data"], `A data ${dataCurta(p.data)} já passou.`);
  const agenda = await porta.horarios(tx, empresaId, p.data, p.turno);
  if (!agenda || !agenda.horarios.length) throw new ErroCampo(["data", "turno"], `Não há horário disponível em ${dataCurta(p.data)} no turno ${TURNO[p.turno].toLowerCase()}. Informe outra data ou turno.`);
  if (p.horario && !agenda.horarios.some((h) => h.inicio === p.horario)) pendencias.push(`${p.horario} não está entre os horários disponíveis do turno: escolha na revisão.`);
  if (p.horarioConflito) pendencias.push(`Você citou ${p.horarioConflito.length} horários (${p.horarioConflito.join(", ")}): escolha um na revisão.`);
  const preco = await porta.precoTabela(tx, empresaId, { data: p.data, configuracaoAgendaId: agenda.configuracaoId, pacoteId: pacote.id, convidados: p.convidados });
  if (preco === null) pendencias.push("Valor de tabela indisponível para esta data: confira na revisão.");
  pendencias.push("Valor proposto e forma de pagamento: preencher na revisão.");
  return {
    payload: {
      ...p, clienteId: encontrado.id, clienteNome: cliente.nome, pacote: idDaTela, pacoteNome: pacote.nome, pacoteTexto: null, pacoteResto: null, pacoteRecusas: null, aniversarianteId,
      horariosDisponiveis: agenda.horarios.length, precoTabelaCentavos: preco, pendencias: pendencias.slice(0, 10),
    },
    avisos: [`${agenda.horarios.length} ${agenda.horarios.length === 1 ? "horário disponível" : "horários disponíveis"} no turno, conferidos agora; a revisão consulta de novo.`],
  };
}

/** Destino da revisão: só a referência OPACA da preparação (nenhum dado pessoal, payload ou autoridade na URL). */
export function destinoRevisao(p: Record<string, unknown>, operacaoId: string): string | null {
  return typeof p.clienteId === "string" && uuid.safeParse(p.clienteId).success && uuid.safeParse(operacaoId).success
    ? `/admin/clientes/${p.clienteId.toLowerCase()}/fechamento?rascunho=${operacaoId.toLowerCase()}`
    : null;
}

export const TTL_PREPARACAO_SEGUNDOS = 60 * 60;

export function criarAcaoContratacao(porta: PortaContratacao, hoje: () => string): FerramentaAcao<PayloadContratacao> {
  return {
    nome: "comercial.preparar_contratacao",
    capacidade: CAPACIDADE_CONTRATACAO,
    classe: "CONFIRM",
    grupo: "ADMIN_ACTIONS",
    papeis: PAPEIS,
    descricao: "Preparar a contratação de uma festa (Fechamento administrativo) e abrir a revisão preenchida; nada é gravado antes de concluir o formulário oficial.",
    titulo: "Preparar contratação",
    campos: CAMPOS,
    revisao: { rotulo: "Revisão da contratação", destino: destinoRevisao, ttlSegundos: TTL_PREPARACAO_SEGUNDOS },
    extrair: (texto, perguntado) => extrairContratacao(texto, perguntado),
    doModelo: (valores) => contratacaoDoModelo(valores),
    combinar: (extraido, doModelo) => combinarContratacao(extraido, doModelo),
    faltando: (payload) => {
      completarAno(payload);
      return faltandoContratacao(payload);
    },
    validar: (payload) => validarContratacao(payload),
    verificar: (tx, tenant, payload) => verificarContratacao(tx, tenant.empresaComprovada, payload, porta, hoje()),
    apresentar: apresentarContratacao,
    // O "Confirmar" do chat nunca cria: a aprovação é o envio do formulário oficial (um só caminho de escrita).
    async executar() {
      throw new InteligenciaError("CONFIRMAR_NA_REVISAO", "A contratação é concluída na revisão do Fechamento, não pelo chat.", 409);
    },
  };
}
