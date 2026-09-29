import { z } from "zod";
import type { DbExecutor } from "../../db/contracts.ts";
import { MOTIVOS_PACOTE } from "../../comercial/motivos-pacote.ts";
import type { CampoRascunho } from "../contratos.ts";
import { InteligenciaError } from "../politica.ts";
import { ErroCampo } from "./human-gate.ts";
import { jsonCanonico } from "./hash.ts";
import {
  duracaoTexto, extrairConvidados, extrairDescricao, extrairDuracaoMinutos, extrairNomeAposPalavra, extrairPrecoCentavos,
  mesmoNome, nomeDaResposta, reais,
} from "../texto-pt.ts";
import type { DefinicaoCampo, FerramentaAcao } from "./tipos.ts";

/**
 * Ações de Pacote sob Human Gate (feature ACTIONS).
 *
 * Campos obrigatórios REAIS (schema `salvar` de /api/admin/configuracoes/pacotes e
 * `salvarPacoteComercial`): nome, duração, convidados mínimo e máximo. Preço (faixas) é opcional no
 * domínio: é perguntado, mas "sem preço" é resposta válida.
 *
 * Regra do Human Gate: o preview mostra TODO efeito persistido. Por isso a edição nunca usa
 * `salvarPacoteComercial` (que regrava disponibilidade, buffet e itens a partir de um retrato parcial
 * e desativaria regras futuras). Cada mudança usa só a operação de domínio correspondente:
 * - dados básicos, pacote não usado: `editarPacoteNaoUtilizado` (só nome, descrição, duração, convidados);
 * - dados básicos, pacote já usado: `criarRevisaoPacoteAdmin` (nova revisão que copia TODO o agregado,
 *   inclusive regras de disponibilidade futuras, e o preço);
 * - preço, pacote não usado: `gravarFaixasPacote` (nova versão publicada da tabela de preços).
 * Criar pacote novo usa `salvarPacoteComercial` com disponibilidade/buffet vazios: não há nada a perder.
 *
 * Papel: só REPRESENTANTE_AUTORIZADO, o mesmo que a rota exige para editar pacotes.
 */
const PAPEIS_GESTAO = ["REPRESENTANTE_AUTORIZADO"] as const;
const ORIGEM = "Kidmais Intelligence, confirmado pelo operador";

// ---------------------------------------------------------------- porta (serviços comerciais reais)

export type PacoteDominio = {
  id: string;
  nome: string;
  descricao: string | null;
  duracaoMinutos: number | null;
  convidadosMinimos: number | null;
  convidadosMaximos: number | null;
  ativo: boolean;
  vigente: boolean;
  arquivadoEm: string | null;
  utilizado: boolean;
};
export type FaixaDominio = { convidadosMin: number; convidadosMax: number | null; valor: string };
export type PainelPacoteDominio = {
  pacote: PacoteDominio;
  disponibilidade: Array<{ dia: number; horarioId: string }>;
  categorias: Array<{ categoriaId: string; escolhas: number; ativo: boolean }>;
  faixas: { editavel: boolean; faixas: FaixaDominio[]; aviso: string | null };
  itens: string[];
};
export type DadosBasicos = { nome: string; descricao: string | null; duracaoMinutos: number; convidadosMinimos: number; convidadosMaximos: number };
export type ContextoComercial = { empresaId: string; usuarioId: string; requestId: string; motivo?: string };

/**
 * Serviços comerciais reais, ligados na composição: `listarPacotesAdmin`, `painelPacoteAdmin`,
 * `salvarPacoteComercial` (só criação), `editarPacoteNaoUtilizado`, `criarRevisaoPacoteAdmin`,
 * `gravarFaixasPacote` e `alterarSituacaoPacoteAdmin`. Nenhum SQL na IA.
 */
export type PortaPacotes = {
  listar(tx: DbExecutor, empresaId: string): Promise<PacoteDominio[]>;
  painel(tx: DbExecutor, empresaId: string, id: string): Promise<PainelPacoteDominio | null>;
  criar(tx: DbExecutor, dados: DadosBasicos & { faixas: FaixaDominio[] | null }, ctx: ContextoComercial): Promise<{ pacote: PacoteDominio; avisoPrecos: string | null }>;
  editarNaoUtilizado(tx: DbExecutor, id: string, dados: DadosBasicos, ctx: ContextoComercial): Promise<PacoteDominio>;
  revisar(tx: DbExecutor, id: string, dados: DadosBasicos, ctx: ContextoComercial): Promise<PacoteDominio>;
  gravarFaixas(tx: DbExecutor, empresaId: string, id: string, faixas: FaixaDominio[], limites: { minimo: number; maximo: number }, ctx: ContextoComercial): Promise<{ aviso: string | null }>;
  alterarSituacao(tx: DbExecutor, id: string, situacao: "ativar" | "desativar", ctx: ContextoComercial): Promise<PacoteDominio>;
};

const nome = z.string().trim().min(1).max(160);
const duracao = z.number().int().min(1).max(1440);
const convidados = z.number().int().min(1).max(10000);
const preco = z.number().int().min(1).max(1_000_000_000);

function faixaUnica(minimo: number, maximo: number, centavos: number): FaixaDominio[] {
  return [{ convidadosMin: minimo, convidadosMax: maximo, valor: (centavos / 100).toFixed(2) }];
}

function convidadosTexto(minimo: unknown, maximo: unknown) {
  if (typeof minimo !== "number" && typeof maximo !== "number") return null;
  if (typeof minimo === "number" && typeof maximo === "number") return `${minimo} a ${maximo}`;
  return typeof minimo === "number" ? `mínimo ${minimo}` : `máximo ${maximo}`;
}

function linha(id: string, rotulo: string, valor: string | null, obrigatorio = false): CampoRascunho {
  return { id, rotulo, valor, obrigatorio };
}

/** Pacote vigente, não arquivado, com o mesmo nome (sem acento/caixa) na empresa comprovada. */
async function resolverPacote(tx: DbExecutor, empresaId: string, pacotes: PortaPacotes, nomeInformado: string): Promise<PacoteDominio> {
  const candidatos = (await pacotes.listar(tx, empresaId)).filter((p) => p.vigente && !p.arquivadoEm && mesmoNome(p.nome, nomeInformado));
  if (candidatos.length === 0) throw new ErroCampo(["pacote"], `Não encontrei o pacote "${nomeInformado}" nesta empresa.`);
  if (candidatos.length > 1) throw new ErroCampo(["pacote"], `Há mais de um pacote chamado "${nomeInformado}". Ajuste na tela Pacotes.`);
  return candidatos[0];
}

function validarFaixaConvidados(minimo: number, maximo: number) {
  if (maximo < minimo) throw new ErroCampo(["convidadosMinimos", "convidadosMaximos"], "O máximo de convidados não pode ser menor que o mínimo.");
}

// ---------------------------------------------------------------- criar_pacote

const CAMPOS_CRIAR: readonly DefinicaoCampo[] = [
  { id: "nome", rotulo: "Nome", obrigatorio: true, perguntar: true, pergunta: "Qual é o nome do pacote?" },
  { id: "precoCentavos", rotulo: "Preço", obrigatorio: false, perguntar: true, pergunta: "Qual é o preço do pacote? Se preferir definir depois, responda \"sem preço\"." },
  { id: "duracaoMinutos", rotulo: "Duração", obrigatorio: true, perguntar: true, pergunta: "Qual é a duração da festa? Ex.: 4 horas ou 3h30." },
  { id: "convidadosMinimos", rotulo: "Convidados", obrigatorio: true, perguntar: true, pergunta: "Para quantos convidados? Informe o mínimo e o máximo, ex.: de 30 a 80." },
  { id: "convidadosMaximos", rotulo: "Convidados (máximo)", obrigatorio: true, perguntar: true, pergunta: "Qual é o máximo de convidados?" },
];

const criarSchema = z.object({
  nome,
  precoCentavos: preco.nullable(),
  duracaoMinutos: duracao,
  convidadosMinimos: convidados,
  convidadosMaximos: convidados,
  descricao: z.string().trim().max(2000).nullable().default(null),
}).strict();

type PayloadCriar = z.infer<typeof criarSchema>;

function extrairCriacao(texto: string, perguntado: string | null) {
  const valores: Record<string, unknown> = {};
  const nomeLido = perguntado === "nome" ? nomeDaResposta(texto) : extrairNomeAposPalavra(texto, "pacote");
  if (nomeLido) valores.nome = nomeLido;
  const precoLido = extrairPrecoCentavos(texto, perguntado === "precoCentavos");
  if (precoLido !== undefined) valores.precoCentavos = precoLido;
  const duracaoLida = extrairDuracaoMinutos(texto, perguntado === "duracaoMinutos");
  if (duracaoLida !== undefined) valores.duracaoMinutos = duracaoLida;
  Object.assign(valores, extrairConvidados(texto, perguntado === "convidadosMinimos" || perguntado === "convidadosMaximos" ? perguntado : null));
  const descricao = extrairDescricao(texto);
  if (descricao) valores.descricao = descricao;
  // A resposta à pergunta de nome não é relida como preço/duração por acaso ("Festa 4h" continua nome).
  if (perguntado === "nome") return { nome: valores.nome } as Record<string, unknown>;
  return valores;
}

function criarPacote(porta: PortaPacotes): FerramentaAcao<PayloadCriar> {
  return {
    nome: "pacotes.criar",
    capacidade: "criar_pacote",
    classe: "CONFIRM",
    grupo: "ADMIN_ACTIONS",
    papeis: PAPEIS_GESTAO,
    descricao: "Cria um pacote novo depois da sua confirmação.",
    titulo: "Novo pacote",
    campos: CAMPOS_CRIAR,
    extrair: extrairCriacao,
    faltando(payload) {
      return CAMPOS_CRIAR.filter((c) => (c.id === "precoCentavos" ? payload.precoCentavos === undefined : payload[c.id] === undefined || payload[c.id] === "")).map((c) => c.id);
    },
    validar(payload) {
      const lido = criarSchema.safeParse({ descricao: null, ...payload });
      if (!lido.success) {
        const campos = [...new Set(lido.error.issues.map((i) => String(i.path[0])))].filter((c) => CAMPOS_CRIAR.some((d) => d.id === c));
        throw new ErroCampo(campos, "Algum valor ficou fora do permitido.");
      }
      validarFaixaConvidados(lido.data.convidadosMinimos, lido.data.convidadosMaximos);
      return lido.data;
    },
    async verificar(tx, tenant, payload) {
      const existentes = await porta.listar(tx, tenant.empresaComprovada);
      if (existentes.some((p) => p.vigente && !p.arquivadoEm && mesmoNome(p.nome, payload.nome))) {
        throw new ErroCampo(["nome"], `Já existe um pacote chamado "${payload.nome}". Escolha outro nome.`);
      }
      const avisos = ["Dias e horários, buffet e adicionais não são definidos por aqui: complete em Pacotes depois da criação."];
      if (payload.precoCentavos === null) avisos.push("Sem preço: o pacote fica sem valor até você definir em Pacotes.");
      else avisos.push("O preço entra numa nova versão publicada da tabela de preços da empresa; os demais pacotes mantêm os preços.");
      return { payload, avisos };
    },
    apresentar(p) {
      return [
        linha("nome", "Nome", typeof p.nome === "string" ? p.nome : null, true),
        linha("precoCentavos", "Preço", typeof p.precoCentavos === "number" ? `${reais(p.precoCentavos)} (de ${p.convidadosMinimos ?? "?"} a ${p.convidadosMaximos ?? "?"} convidados)` : p.precoCentavos === null ? "Sem preço por enquanto" : null),
        linha("duracaoMinutos", "Duração", typeof p.duracaoMinutos === "number" ? duracaoTexto(p.duracaoMinutos) : null, true),
        linha("convidados", "Convidados", convidadosTexto(p.convidadosMinimos, p.convidadosMaximos), true),
        linha("descricao", "Descrição", typeof p.descricao === "string" && p.descricao ? p.descricao : "Sem descrição"),
        linha("disponibilidade", "Dias e horários", "Nenhum por enquanto (configure em Pacotes)"),
        linha("adicionais", "Adicionais", "Nenhum por enquanto (configure em Pacotes)"),
        linha("itens", "Itens do buffet", "Nenhum por enquanto (configure em Pacotes)"),
        linha("status", "Status", "Ativo ao criar"),
        linha("unidade", "Unidade", "Empresa atual, conferida na hora de gravar"),
      ];
    },
    async executar(tx, tenant, payload, contexto) {
      const salvo = await porta.criar(tx, {
        nome: payload.nome,
        descricao: payload.descricao,
        duracaoMinutos: payload.duracaoMinutos,
        convidadosMinimos: payload.convidadosMinimos,
        convidadosMaximos: payload.convidadosMaximos,
        faixas: payload.precoCentavos === null ? null : faixaUnica(payload.convidadosMinimos, payload.convidadosMaximos, payload.precoCentavos),
      }, { empresaId: tenant.empresaComprovada, usuarioId: contexto.usuarioId, requestId: contexto.operacaoId, motivo: `Criação administrativa (${ORIGEM})` });
      return { entidadeId: salvo.pacote.id, mensagem: `Pacote "${salvo.pacote.nome}" criado.${salvo.avisoPrecos ? ` ${salvo.avisoPrecos}` : ""}`, destino: "/admin/configuracoes/pacotes" };
    },
  };
}

// ---------------------------------------------------------------- ativar / desativar

const situacaoSchema = z.object({
  pacote: nome,
  pacoteId: z.string().uuid().optional(),
  situacaoAtual: z.enum(["ATIVO", "INATIVO"]).optional(),
}).strict();
type PayloadSituacao = z.infer<typeof situacaoSchema>;

function acaoSituacao(porta: PortaPacotes, situacao: "ativar" | "desativar"): FerramentaAcao<PayloadSituacao> {
  const alvo = situacao === "ativar" ? "ATIVO" : "INATIVO";
  const campos: readonly DefinicaoCampo[] = [{ id: "pacote", rotulo: "Pacote", obrigatorio: true, perguntar: true, pergunta: `Qual pacote você quer ${situacao}? Informe o nome.` }];
  return {
    nome: `pacotes.${situacao}`,
    capacidade: `${situacao}_pacote`,
    classe: "CONFIRM",
    grupo: "ADMIN_ACTIONS",
    papeis: PAPEIS_GESTAO,
    descricao: situacao === "ativar" ? "Reativa um pacote desativado depois da sua confirmação." : "Desativa um pacote (sem apagar) depois da sua confirmação.",
    titulo: situacao === "ativar" ? "Ativar pacote" : "Desativar pacote",
    campos,
    extrair(texto, perguntado) {
      const lido = perguntado === "pacote" ? nomeDaResposta(texto) : extrairNomeAposPalavra(texto, "pacote");
      return lido ? { pacote: lido } : {};
    },
    faltando: (p) => (typeof p.pacote === "string" && p.pacote ? [] : ["pacote"]),
    validar(payload) {
      const lido = situacaoSchema.safeParse(payload);
      if (!lido.success) throw new ErroCampo(["pacote"], "Informe o nome do pacote.");
      return lido.data;
    },
    async verificar(tx, tenant, payload) {
      const pacote = await resolverPacote(tx, tenant.empresaComprovada, porta, payload.pacote);
      const atual = pacote.ativo ? "ATIVO" : "INATIVO";
      if (atual === alvo) throw new InteligenciaError("SEM_ALTERACAO", `O pacote "${pacote.nome}" já está ${pacote.ativo ? "ativo" : "desativado"}.`, 409);
      const avisos = situacao === "desativar" ? ["Desativar não apaga o pacote nem muda festas e contratos já feitos."] : [];
      return { payload: { pacote: pacote.nome, pacoteId: pacote.id, situacaoAtual: atual }, avisos };
    },
    apresentar(p) {
      return [
        linha("pacote", "Pacote", typeof p.pacote === "string" ? p.pacote : null, true),
        linha("situacao", "Situação", p.situacaoAtual ? `${p.situacaoAtual === "ATIVO" ? "Ativo" : "Desativado"} → ${alvo === "ATIVO" ? "Ativo" : "Desativado"}` : null),
        linha("mantido", "Não muda", "Nome, preço, dias e horários, buffet, itens e adicionais"),
      ];
    },
    async executar(tx, tenant, payload, contexto) {
      if (!payload.pacoteId) throw new InteligenciaError("CONFIRMACAO_INVALIDA", "Pacote não identificado.", 409);
      const motivo = `${situacao === "ativar" ? MOTIVOS_PACOTE.ativado : MOTIVOS_PACOTE.desativado} (${ORIGEM})`;
      const pacote = await porta.alterarSituacao(tx, payload.pacoteId, situacao, { empresaId: tenant.empresaComprovada, usuarioId: contexto.usuarioId, requestId: contexto.operacaoId, motivo });
      return { entidadeId: pacote.id, mensagem: `Pacote "${pacote.nome}" ${situacao === "ativar" ? "ativado" : "desativado"}.`, destino: "/admin/configuracoes/pacotes" };
    },
  };
}

// ---------------------------------------------------------------- editar_pacote

const MUDANCAS = ["novoNome", "precoCentavos", "duracaoMinutos", "convidadosMinimos", "convidadosMaximos", "descricao"] as const;

const planoSchema = z.object({
  modo: z.enum(["EDITAR", "REVISAR"]),
  dados: z.object({ nome, descricao: z.string().max(2000).nullable(), duracaoMinutos: duracao, convidadosMinimos: convidados, convidadosMaximos: convidados }).strict().nullable(),
  faixas: z.array(z.object({ convidadosMin: convidados, convidadosMax: convidados.nullable(), valor: z.string() }).strict()).nullable(),
  mudancas: z.array(z.object({ campo: z.string(), rotulo: z.string(), antes: z.string(), depois: z.string() }).strict()),
  /** Situação atual; a edição nunca a muda (a revisão preserva a situação da origem). */
  situacao: z.enum(["ATIVO", "INATIVO"]),
}).strict();
type PlanoEdicao = z.infer<typeof planoSchema>;

const editarSchema = z.object({
  pacote: nome,
  novoNome: nome.optional(),
  precoCentavos: preco.optional(),
  duracaoMinutos: duracao.optional(),
  convidadosMinimos: convidados.optional(),
  convidadosMaximos: convidados.optional(),
  descricao: z.string().trim().max(2000).optional(),
  // Preenchidos por `verificar` a partir do domínio; entram no hash da confirmação.
  pacoteId: z.string().uuid().optional(),
  plano: planoSchema.optional(),
  base: z.string().optional(),
}).strict();
type PayloadEditar = z.infer<typeof editarSchema>;

function extrairEdicao(texto: string, perguntado: string | null) {
  const valores: Record<string, unknown> = {};
  const nomeAtual = perguntado === "pacote" ? nomeDaResposta(texto) : extrairNomeAposPalavra(texto, "pacote");
  if (nomeAtual) valores.pacote = nomeAtual;
  if (perguntado === "pacote") return valores;
  const renomear = texto.match(/(?:renome\w*|mud\w* o nome|troc\w* o nome|novo nome)\b.*?\bpara\s+["“'‘]?([^"”'’.,;!?]{1,160})/i) ?? texto.match(/novo nome\s*[:=]\s*["“'‘]?([^"”'’.,;!?]{1,160})/i);
  if (renomear) valores.novoNome = renomear[1].trim();
  const precoLido = extrairPrecoCentavos(texto, perguntado === "alteracao" && /^\s*r?\$?\s*[\d.,]+\s*$/i.test(texto));
  if (typeof precoLido === "number") valores.precoCentavos = precoLido;
  const duracaoLida = extrairDuracaoMinutos(texto, false);
  if (duracaoLida !== undefined) valores.duracaoMinutos = duracaoLida;
  Object.assign(valores, extrairConvidados(texto, null));
  const descricao = extrairDescricao(texto);
  if (descricao) valores.descricao = descricao;
  return valores;
}

function temMudanca(payload: Record<string, unknown>) {
  return MUDANCAS.some((c) => payload[c] !== undefined);
}

/** Estado do pacote que a confirmação precisa encontrar igual. */
function baseDoPainel(painel: PainelPacoteDominio) {
  const p = painel.pacote;
  return jsonCanonico({
    id: p.id, nome: p.nome, descricao: p.descricao, duracao: p.duracaoMinutos, min: p.convidadosMinimos, max: p.convidadosMaximos,
    ativo: p.ativo, utilizado: p.utilizado, disponibilidade: painel.disponibilidade, categorias: painel.categorias, itens: painel.itens, faixas: painel.faixas.faixas,
  });
}

const precoTexto = (faixas: readonly FaixaDominio[]) =>
  faixas.length === 1 ? `${reais(Math.round(Number(faixas[0].valor) * 100))} (de ${faixas[0].convidadosMin} a ${faixas[0].convidadosMax ?? "sem limite"} convidados)` : faixas.length ? `${faixas.length} faixas` : "Sem preço";

/** Monta o plano com a operação de domínio exata e a lista completa do que muda. */
export function planejarEdicao(painel: PainelPacoteDominio, pedido: PayloadEditar): PlanoEdicao {
  const atual = painel.pacote;
  const duracaoFinal = pedido.duracaoMinutos ?? atual.duracaoMinutos;
  const minimo = pedido.convidadosMinimos ?? atual.convidadosMinimos;
  const maximo = pedido.convidadosMaximos ?? atual.convidadosMaximos;
  if (duracaoFinal == null) throw new ErroCampo(["duracaoMinutos"], "Este pacote ainda não tem duração registrada. Informe a duração.");
  if (minimo == null || maximo == null) throw new ErroCampo(["convidadosMinimos", "convidadosMaximos"], "Este pacote ainda não tem convidados registrados. Informe o mínimo e o máximo.");
  validarFaixaConvidados(minimo, maximo);
  const dados: DadosBasicos = {
    nome: pedido.novoNome ?? atual.nome,
    descricao: pedido.descricao !== undefined ? pedido.descricao : atual.descricao,
    duracaoMinutos: duracaoFinal,
    convidadosMinimos: minimo,
    convidadosMaximos: maximo,
  };
  const mudancas: PlanoEdicao["mudancas"] = [];
  const comparar = (campo: string, rotulo: string, antes: string, depois: string) => { if (antes !== depois) mudancas.push({ campo, rotulo, antes, depois }); };
  comparar("nome", "Nome", atual.nome, dados.nome);
  comparar("descricao", "Descrição", atual.descricao ?? "Sem descrição", dados.descricao ?? "Sem descrição");
  comparar("duracao", "Duração", atual.duracaoMinutos == null ? "—" : duracaoTexto(atual.duracaoMinutos), duracaoTexto(dados.duracaoMinutos));
  comparar("convidados", "Convidados", convidadosTexto(atual.convidadosMinimos, atual.convidadosMaximos) ?? "—", `${minimo} a ${maximo}`);
  const basicosMudaram = mudancas.length > 0;
  const limitesMudaram = minimo !== atual.convidadosMinimos || maximo !== atual.convidadosMaximos;
  const precoPedido = pedido.precoCentavos !== undefined;

  if (atual.utilizado) {
    // Pacote já usado: só dados básicos, por revisão que copia todo o agregado e o preço sem mudança.
    if (precoPedido || limitesMudaram) {
      throw new InteligenciaError("EDICAO_NA_TELA", "Este pacote já foi usado em festas. Preço e convidados mudam pela tela Pacotes, que cria a revisão com o preço próprio.", 409);
    }
    if (!basicosMudaram) throw new ErroCampo([...MUDANCAS], "Nada mudaria com esses valores. O que você quer alterar?");
    return { modo: "REVISAR", dados, faixas: null, mudancas, situacao: atual.ativo ? "ATIVO" : "INATIVO" };
  }

  let faixas: FaixaDominio[] | null = null;
  if (precoPedido || (limitesMudaram && painel.faixas.faixas.length > 0)) {
    if (!painel.faixas.editavel) throw new InteligenciaError("PRECO_NAO_EDITAVEL", painel.faixas.aviso ?? "O preço deste pacote não pode ser alterado agora.", 409);
    if (painel.faixas.faixas.length > 1) throw new InteligenciaError("PRECO_COM_FAIXAS", "Este pacote tem mais de uma faixa de preço. Altere preço e convidados na tela Pacotes.", 409);
    const centavosAtuais = painel.faixas.faixas[0] ? Math.round(Number(painel.faixas.faixas[0].valor) * 100) : null;
    const centavos = pedido.precoCentavos ?? centavosAtuais;
    if (centavos == null) throw new InteligenciaError("PRECO_INDEFINIDO", "Este pacote ainda não tem preço. Informe o preço junto.", 409);
    faixas = faixaUnica(minimo, maximo, centavos);
    comparar("preco", "Preço", precoTexto(painel.faixas.faixas), precoTexto(faixas));
  }
  if (mudancas.length === 0) throw new ErroCampo([...MUDANCAS], "Nada mudaria com esses valores. O que você quer alterar?");
  return { modo: "EDITAR", dados: basicosMudaram ? dados : null, faixas, mudancas, situacao: atual.ativo ? "ATIVO" : "INATIVO" };
}

function editarPacote(porta: PortaPacotes): FerramentaAcao<PayloadEditar> {
  return {
    nome: "pacotes.editar",
    capacidade: "editar_pacote",
    classe: "CONFIRM",
    grupo: "ADMIN_ACTIONS",
    papeis: PAPEIS_GESTAO,
    descricao: "Altera nome, descrição, preço, duração ou convidados de um pacote depois da sua confirmação.",
    titulo: "Editar pacote",
    campos: [
      { id: "pacote", rotulo: "Pacote", obrigatorio: true, perguntar: true, pergunta: "Qual pacote você quer editar? Informe o nome atual." },
      { id: "alteracao", rotulo: "Alteração", obrigatorio: true, perguntar: true, pergunta: "O que você quer mudar? Ex.: preço R$ 5.000, duração 4 horas, convidados de 40 a 90, novo nome para \"Festa Max\" ou descrição: texto." },
    ],
    extrair: extrairEdicao,
    faltando(payload) {
      const faltam: string[] = [];
      if (!(typeof payload.pacote === "string" && payload.pacote)) faltam.push("pacote");
      if (!temMudanca(payload)) faltam.push("alteracao");
      return faltam;
    },
    validar(payload) {
      const lido = editarSchema.safeParse(payload);
      if (!lido.success) {
        const campos = [...new Set(lido.error.issues.map((i) => String(i.path[0])))];
        throw new ErroCampo(campos, "Algum valor ficou fora do permitido.");
      }
      return lido.data;
    },
    async verificar(tx, tenant, payload) {
      const alvo = await resolverPacote(tx, tenant.empresaComprovada, porta, payload.pacote);
      const painel = await porta.painel(tx, tenant.empresaComprovada, alvo.id);
      if (!painel) throw new ErroCampo(["pacote"], `Não encontrei o pacote "${payload.pacote}" nesta empresa.`);
      if (payload.novoNome && !mesmoNome(payload.novoNome, alvo.nome)) {
        const listados = await porta.listar(tx, tenant.empresaComprovada);
        if (listados.some((p) => p.id !== alvo.id && p.vigente && !p.arquivadoEm && mesmoNome(p.nome, payload.novoNome!))) {
          throw new ErroCampo(["novoNome"], `Já existe um pacote chamado "${payload.novoNome}".`);
        }
      }
      const plano = planejarEdicao(painel, payload);
      const pedidoOriginal = Object.fromEntries(Object.entries(payload).filter(([k]) => !["pacoteId", "plano", "base"].includes(k)));
      const avisos = plano.modo === "REVISAR"
        ? ["Este pacote já foi usado: a mudança cria uma nova revisão e uma nova versão da tabela de preços, com os mesmos preços. Festas e contratos existentes continuam na revisão anterior."]
        : [];
      if (plano.faixas) avisos.push("O preço entra numa nova versão publicada da tabela de preços da empresa; os demais pacotes e adicionais mantêm os preços.");
      return { payload: { ...pedidoOriginal, pacote: alvo.nome, pacoteId: alvo.id, plano, base: baseDoPainel(painel) } as PayloadEditar, avisos };
    },
    apresentar(p) {
      const campos: CampoRascunho[] = [linha("pacote", "Pacote", typeof p.pacote === "string" ? p.pacote : null, true)];
      const plano = p.plano as PlanoEdicao | undefined;
      if (!plano) {
        const pedido = [p.novoNome ? `nome → ${p.novoNome}` : null, typeof p.precoCentavos === "number" ? `preço → ${reais(p.precoCentavos)}` : null, typeof p.duracaoMinutos === "number" ? `duração → ${duracaoTexto(p.duracaoMinutos)}` : null, convidadosTexto(p.convidadosMinimos, p.convidadosMaximos) ? `convidados → ${convidadosTexto(p.convidadosMinimos, p.convidadosMaximos)}` : null, typeof p.descricao === "string" ? "descrição" : null].filter(Boolean);
        return [...campos, linha("alteracao", "Alteração", pedido.length ? pedido.join("; ") : null, true)];
      }
      // Tudo o que será persistido, e tudo o que fica igual.
      for (const m of plano.mudancas) campos.push(linha(m.campo, m.rotulo, `${m.antes} → ${m.depois}`));
      const mudou = new Set(plano.mudancas.map((m) => m.campo));
      const iguais = [["nome", "Nome"], ["descricao", "Descrição"], ["duracao", "Duração"], ["convidados", "Convidados"], ["preco", "Preço"]].filter(([c]) => !mudou.has(c)).map(([, r]) => r);
      if (iguais.length) campos.push(linha("iguais", "Sem mudança", iguais.join(", ")));
      campos.push(linha("disponibilidade", "Dias e horários", plano.modo === "REVISAR" ? "Copiados sem mudança para a nova revisão (inclusive regras futuras)" : "Não são alterados"));
      campos.push(linha("situacao", "Situação", `${plano.situacao === "ATIVO" ? "Ativo" : "Desativado"} (não muda)`));
      campos.push(linha("agregado", "Buffet, itens e adicionais", plano.modo === "REVISAR" ? "Copiados sem mudança para a nova revisão" : "Não são alterados"));
      if (plano.modo === "REVISAR") {
        campos.push(linha("revisao", "Revisão", "Nova revisão vigente; festas e contratos existentes continuam na anterior"));
        campos.push(linha("tabela", "Tabela de preços", "Nova versão publicada que copia os preços atuais; o preço deste pacote não muda"));
      }
      if (plano.faixas) campos.push(linha("tabela", "Tabela de preços", "Nova versão publicada; os demais pacotes mantêm os preços"));
      return campos;
    },
    async executar(tx, tenant, payload, contexto) {
      const plano = payload.plano;
      if (!plano || !payload.pacoteId) throw new InteligenciaError("CONFIRMACAO_INVALIDA", "Pacote não identificado.", 409);
      const ctx = { empresaId: tenant.empresaComprovada, usuarioId: contexto.usuarioId, requestId: contexto.operacaoId, motivo: `${MOTIVOS_PACOTE.editado} (${ORIGEM})` };
      let resultado: PacoteDominio | null = null;
      let avisoPreco: string | null = null;
      if (plano.modo === "REVISAR") {
        resultado = await porta.revisar(tx, payload.pacoteId, plano.dados!, ctx);
      } else {
        if (plano.dados) resultado = await porta.editarNaoUtilizado(tx, payload.pacoteId, plano.dados, ctx);
        if (plano.faixas) {
          const limites = { minimo: plano.faixas[0].convidadosMin, maximo: plano.faixas[0].convidadosMax ?? plano.faixas[0].convidadosMin };
          avisoPreco = (await porta.gravarFaixas(tx, tenant.empresaComprovada, payload.pacoteId, plano.faixas, limites, ctx)).aviso;
        }
      }
      // Nenhum efeito fora do preview: a situação persistida tem de ser a mesma mostrada.
      if (resultado && (resultado.ativo ? "ATIVO" : "INATIVO") !== plano.situacao) {
        throw new InteligenciaError("EFEITO_NAO_PREVISTO", "A gravação mudaria a situação do pacote, o que não estava no preview. Nada foi alterado.", 409);
      }
      const nomeFinal = resultado?.nome ?? payload.pacote;
      return { entidadeId: resultado?.id ?? payload.pacoteId, mensagem: `Pacote "${nomeFinal}" atualizado.${avisoPreco ? ` ${avisoPreco}` : ""}`, destino: "/admin/configuracoes/pacotes" };
    },
  };
}

/** Fábrica da feature: as ações de pacote com a porta comercial ligada. */
export function criarAcoesPacote(porta: PortaPacotes): FerramentaAcao[] {
  return [criarPacote(porta), editarPacote(porta), acaoSituacao(porta, "ativar"), acaoSituacao(porta, "desativar")] as unknown as FerramentaAcao[];
}
