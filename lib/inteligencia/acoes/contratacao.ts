import { z } from "zod";
import type { DbExecutor } from "../../db/contracts.ts";
import type { CampoRascunho } from "../contratos.ts";
import { InteligenciaError } from "../politica.ts";
import { mesmoNome, nomeDaResposta, normalizar, reais } from "../texto-pt.ts";
import { ErroCampo } from "./human-gate.ts";
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

/** Pacotes contratáveis da V1 (mesma lista de `comercial-schema`/`pacotes-v1`); o Core confirma cada um na empresa. */
const CODIGOS = ["pocket", "mini", "compacta", "essencial", "completa", "premium", "pizza_party_scienza"] as const;
export type CodigoPacote = (typeof CODIGOS)[number];
export const CODIGO_BANCO: Readonly<Record<CodigoPacote, string>> = {
  pocket: "POCKET", mini: "MINI_FESTA", compacta: "COMPACTA", essencial: "ESSENCIAL", completa: "COMPLETA", premium: "PREMIUM", pizza_party_scienza: "PIZZA_PARTY",
};

/** Nomes que o operador usa para cada pacote contratável (lista fechada; o Core confirma a existência na empresa). */
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
  /** Regra OFICIAL de convidados do Fechamento (`erroConvidadosFechamento`): mensagem humana ou null. */
  erroConvidados(codigo: CodigoPacote, pacote: { nome: string; minimo: number | null; maximo: number | null }, convidados: number): string | null;
  /** Horários DISPONÍVEIS do turno na data (serviço oficial de disponibilidade). null ⇒ turno sem configuração. */
  horarios(tx: DbExecutor, data: string, turno: "almoco" | "noite"): Promise<{ configuracaoId: string; horarios: ReadonlyArray<{ inicio: string; fim: string }> } | null>;
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

  const trechoPacote = perguntado === "pacote" ? n : (/\bpacote\s+(.{1,30})/.exec(n)?.[1] ?? "");
  const pacote = NOMES_PACOTE.find(([, r]) => r.test(trechoPacote));
  if (pacote) v.pacote = pacote[0];

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
  if (typeof v.pacote === "string" && (CODIGOS as readonly string[]).includes(v.pacote)) saida.pacote = v.pacote;
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

// ---------------------------------------------------------------- campos, validação e preview

const CAMPOS: readonly DefinicaoCampo[] = [
  { id: "cliente", rotulo: "Cliente", obrigatorio: true, perguntar: true, pergunta: "Qual é o cliente (contratante)? Informe o nome como está no CRM." },
  { id: "pacote", rotulo: "Pacote", obrigatorio: true, perguntar: true, pergunta: "Qual pacote? (Pocket, Mini Festa, Compacta, Essencial, Completa ou Premium)" },
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
  pacote: z.enum(CODIGOS),
  pacoteNome: z.string().max(160).nullable().default(null),
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

  if (p.pacote === "pizza_party_scienza") throw new ErroCampo(["pacote"], "O Pizza Party está sob consulta: confirme com a equipe. Qual outro pacote?");
  const pacote = await porta.pacote(tx, empresaId, CODIGO_BANCO[p.pacote]);
  if (!pacote) throw new ErroCampo(["pacote"], "Esse pacote não está disponível nesta empresa.");
  const erroConvidados = porta.erroConvidados(p.pacote, pacote, p.convidados);
  if (erroConvidados) throw new ErroCampo(["convidados"], erroConvidados);

  if (p.data < hoje) throw new ErroCampo(["data"], `A data ${dataCurta(p.data)} já passou.`);
  const agenda = await porta.horarios(tx, p.data, p.turno);
  if (!agenda || !agenda.horarios.length) throw new ErroCampo(["data", "turno"], `Não há horário disponível em ${dataCurta(p.data)} no turno ${TURNO[p.turno].toLowerCase()}. Informe outra data ou turno.`);
  if (p.horario && !agenda.horarios.some((h) => h.inicio === p.horario)) pendencias.push(`${p.horario} não está entre os horários disponíveis do turno: escolha na revisão.`);
  if (p.horarioConflito) pendencias.push(`Você citou ${p.horarioConflito.length} horários (${p.horarioConflito.join(", ")}): escolha um na revisão.`);
  const preco = await porta.precoTabela(tx, empresaId, { data: p.data, configuracaoAgendaId: agenda.configuracaoId, pacoteId: pacote.id, convidados: p.convidados });
  if (preco === null) pendencias.push("Valor de tabela indisponível para esta data: confira na revisão.");
  pendencias.push("Valor proposto e forma de pagamento: preencher na revisão.");
  return {
    payload: {
      ...p, clienteId: encontrado.id, clienteNome: cliente.nome, pacoteNome: pacote.nome, aniversarianteId,
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
