import { prepararTextoParaModelo } from "../../texto-modelo.ts";
import { normalizar } from "../../texto-pt.ts";
import {
  VERSAO_JEV_V1, type ClasseJev, type ClassificadorJev, type EntradaJev, type JulgamentoJev, type MotivoJev, type ResultadoJev, type TelaJev,
} from "./contrato.ts";

/**
 * Motor determinístico do JEV V1: sem rede, sem banco, sem modelo, sem tenant.
 *
 * Regras de honestidade:
 * - confiança fixa por força do sinal (sinal forte e único 0,9; sinais concorrentes 0,6; só pontuação 0,5;
 *   nenhum sinal ≤ 0,2) — nunca 1, porque regra também erra;
 * - sem sinal ⇒ DESCONHECIDA / UNKNOWN / INSUFFICIENT com `insufficientEvidence: true`;
 * - texto do operador é DADO: pedir para "ignorar regras" só AUMENTA a restrição (motivo INSTRUCAO_IGNORADA).
 */
export const LIMITE_TEXTO_JEV = 300;

// ---------------------------------------------------------------- minimização

export type TextoMinimizado = { texto: string; motivos: MotivoJev[] };

/**
 * Minimização antes de qualquer julgamento (e antes de um modelo): remove caracteres ocultos/de controle,
 * corta no limite e troca dados pessoais por marcadores. O que sai daqui é o ÚNICO texto que um provedor vê.
 */
export function minimizarTexto(bruto: string): TextoMinimizado {
  const motivos: MotivoJev[] = [];
  // Mesma preparação canônica de todo texto que vai a modelo (lib/inteligencia/texto-modelo.ts): NFKC, ocultos,
  // redação ANTES do corte (e-mail, id, CNPJ, CPF, telefone, links, números longos) e limite.
  const preparado = prepararTextoParaModelo(bruto, { limite: LIMITE_TEXTO_JEV });
  const texto = preparado.texto;
  if (preparado.ocultosRemovidos) motivos.push("CARACTERE_OCULTO_REMOVIDO");
  if (preparado.truncado) motivos.push("TEXTO_TRUNCADO");
  if (preparado.redacoes > 0) motivos.push("PII_REMOVIDA");
  // Homoglifos: palavra com letras latinas misturadas a cirílicas/gregas ("еxclua" com "е" cirílico) é disfarce.
  // NFKC não os converte; o julgamento trata como instrução suspeita (mais restritivo), nunca como texto limpo.
  if (texto.split(/\s+/).some((palavra) => /\p{Script=Latin}/u.test(palavra) && /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(palavra))) motivos.push("ESCRITA_MISTA");
  return { texto, motivos };
}

// ---------------------------------------------------------------- sinais

const tem = (n: string, ...padroes: RegExp[]) => padroes.some((p) => p.test(n));

const PROIBIDOS: ReadonlyArray<[MotivoJev, RegExp[]]> = [
  ["SINAL_SQL", [/\bsql\b/, /\b(select|insert|update|delete|drop|truncate|alter)\b.*\b(from|into|table|set|where)\b/, /\bbanco de dados\b/, /\bdatabase\b/]],
  ["SINAL_SEGREDO", [/\b(senha|password|token|api[\s_-]?key|chave (de|da) api|secret\w*|credencia\w*|database_url|connection string|otp)\b/, /\.env\b/]],
  ["SINAL_PERMISSAO", [/\b(d[ae]r?|conced\w*|liber\w*|mud\w*|alter\w*|troc\w*|remov\w*|tir\w*)\b.*\b(permiss\w*|acesso\w*|papel|papeis|rbac|role|administrador|admin)\b/, /\b(me |o |a )?(torn\w*|vir\w*|promov\w*)\b.*\b(admin\w*|gestao|representante|dono)\b/]],
  ["SINAL_OUTRO_TENANT", [/\b(outr[ao]s?|tod[ao]s? as|demais|qualquer) (empresas?|buffets?|tenants?|contas?)\b/, /\bempresa (de outr\w*|vizinh\w*|concorrent\w*)\b/, /\b(dados|clientes|festas|contratos) (de|da|do) outr[ao]\b/, /\btroc\w* (de|a) empresa\b/,
    // Tenant apontado por identificador no texto ("empresa 2222…", "tenant_id"): o tenant só vem da sessão.
    /\b(empresas?|buffets?|tenants?|contas?)\s*(id\s*)?:?\s*\[(id|cnpj)\]/, /\b(empresa|tenant)[\s_]?id\b/]],
  ["SINAL_OUTRO_ESTABELECIMENTO", [/\b(outr[ao]s?|tod[ao]s? as|demais) (unidades?|estabelecimentos?|filia\w*)\b/, /\b(unidades?|estabelecimentos?|filia\w*)\s*(id\s*)?:?\s*\[(id|numero)\]/, /\bestabelecimento[\s_]?id\b/]],
  ["SINAL_EXCLUSAO", [/\b(exclu\w*|apag\w*|delet\w*|elimin\w*)\b/, /\bremov\w* (o|a|os|as|este|esta|esse|essa) (cliente|festa|contrato|pagamento|registro|usuario)\b/]],
  ["SINAL_DESCONTO", [/\b(d[ae]r?|aplic\w*|conced\w*)\b.*\bdesconto\b/, /\bdesconto de\b/]],
  ["SINAL_CONTRATO_ASSINADO", [/\b(alter\w*|mud\w*|edit\w*|troc\w*)\b.*\bcontrato (ja )?assinado\b/]],
  ["SINAL_AUTONOMIA", [/\b(confirm\w*|aprov\w*|autoriz\w*|execut\w*|fa[cz]\w*)\b.*\b(sozinh\w*|automatic\w*|por mim|sem (me )?perguntar|sem confirma\w*|direto)\b/]],
];

const INJECAO = [
  /\b(ignore|ignora|ignorar|desconsidere|esqueca|esquece)\b.*\b(regras?|instruc\w*|anterior\w*|politica\w*|restric\w*)\b/,
  /\bvoce (agora )?(e|sera|vai ser)\b/, /\b(system|sistema) ?prompt\b/, /\bprompt\b/, /\bmodo (desenvolvedor|admin|root|deus)\b/,
  /\bjailbreak\b/, /\bfinja (que|ser)\b/, /\bnova instrucao\b/, /<\/?(script|system|instrucao)[^>]*>/,
];

// PR 6.4.3: "quitar" só como VERBO de ação (quite, quitar, quitou…); "está quitada?" é consulta, não mutação.
const MUTACAO_FINANCEIRA = [/\b(registr\w*|confirm\w*|marc\w*|lanc\w*|baix\w*)\b.*\b(pagamento|recebimento|pago|quitad\w*|parcela)\b/, /\b(estorn\w*|quit(e|ar|a|em|ou)\b|reembols\w*|devolv\w*)\b/, /\bcobr(e|ar|a|em)\b/];
const ENVIO_EXTERNO = [/\b(envi(e|ar|a|em)|mand(e|ar|a|em)|dispar(e|ar|a))\b/, /\bwhats\s?app\b.*\b(para|pro|pra)\b/];
const CANCELAMENTO = [/\bcancel(ar|e|a|em)\b/];
const ALTERACAO = [
  // "cadastro" (substantivo: "o cadastro deste cliente está completo?") é consulta, não alteração.
  /\b(crie|criar|cria|cadastr(e|ar|a|em|ando)|adicion\w*|inclu\w*|registr(e|ar|a|em)|nov[oa] (pacote|cliente|festa|item|categoria))\b/,
  /\b(edit\w*|alter\w*|mud[ae]\w*|renome\w*|troc\w*|atualiz\w*|ajust\w*)\b/,
  /\b(ativ(e|ar|a)|desativ\w*|reativ\w*|paus\w*|suspend\w*)\b/,
];
const SUGESTAO = [/\b(redij\w*|redigir|escrev\w*|sugir\w*|suger\w*|prepar\w*|rascunh\w*|elabor\w*|monte|montar)\b.*\b(mensagem|texto|resposta|e-?mail|follow[\s-]?up|checklist|roteiro|proposta|lembrete)\b/, /\b(o que|qual) (devo|deveria) (fazer|responder|dizer)\b/, /\bme (sugira|ajude a (escrever|responder))\b/];
const CONSULTA = [
  /\b(quais|qual|quanto|quantos|quantas|quando|onde|quem|como (esta|anda|funciona))\b/, /\b(mostre|mostra|liste|lista|resum\w*|expli\w*|compar\w*|ver|veja|consult\w*)\b/,
  /\b(tem|temos|existe|ha) (alguma?|algum|pendenc\w*|festas?|contratos?)\b/, /\bprecis\w* (da minha )?atencao\b/, /\bpendent\w*\b/, /\bpendenc\w*\b/, /\bo que (preciso|falta|esta)\b/,
];
const SAUDACAO = [/^(oi|ola|bom dia|boa tarde|boa noite|obrigad\w*|valeu|tudo bem)\b[\s!.?]*$/];

const DOMINIOS: ReadonlyArray<[ClasseJev<"INTENT">, MotivoJev, RegExp[]]> = [
  ["FINANCEIRO", "SINAL_FINANCEIRO", [/\b(pagament\w*|recebi\w*|receb\w*|parcela\w*|boleto\w*|pix|financeir\w*|vencid\w*|vencimento\w*|inadimpl\w*|atrasad\w*|faturament\w*|saldo|cobranc\w*|caixa|contas? a (pagar|receber))\b/]],
  ["CONTRATO", "SINAL_CONTRATO", [/\bcontrat\w*\b/, /\bassinatur\w*\b/, /\bassinad\w*\b/]],
  ["FESTA", "SINAL_FESTA", [/\bfestas?\b/, /\b(agenda|convidad\w*|aniversari\w*|evento\w*|checklist)\b/]],
  ["CLIENTE", "SINAL_CLIENTE", [/\bclientes?\b/, /\b(contratante|responsave\w*|lead\w*)\b/]],
  ["CONFIGURACAO", "SINAL_CONFIGURACAO", [/\b(pacotes?|buffet|cardapio|configurac\w*|usuarios?|perfil da empresa|whatsapp|tabela de preco\w*|preco\w* do pacote)\b/]],
];

/**
 * Pedidos que dependem de uma entidade específica (festa/cliente/contrato) aberta na tela. O demonstrativo precisa
 * vir com o substantivo: "está" (verbo) normaliza para "esta" e não pode, sozinho, exigir entidade.
 */
const ENTIDADE = "(festa|cliente|contrato|evento|aniversari\\w*|contratante|responsavel|pagamento|parcela)";
const DEITICO = new RegExp(`\\b(dest[ae]|dess[ae]|nest[ae]|ness[ae]|este|esta|esse|essa|aquel[ae]|dessa|desse)\\s+${ENTIDADE}\\b|\\b${ENTIDADE}\\s+(atual|aberta|aberto|selecionad[ao])\\b|\\b(dele|dela|dessa pessoa)\\b`);
const ENTIDADE_DA_TELA: Readonly<Partial<Record<TelaJev, ClasseJev<"INTENT">>>> = { festa: "FESTA", cliente: "CLIENTE", contrato: "CONTRATO" };

// ---------------------------------------------------------------- resultados

function resultado<K extends ClassificadorJev>(classification: ClasseJev<K>, confidence: number, reasonCodes: readonly MotivoJev[], insufficientEvidence = false): ResultadoJev<K> {
  const motivos = [...new Set(reasonCodes)].slice(0, 16);
  return { classification, confidence: Math.round(confidence * 100) / 100, reasonCodes: motivos, insufficientEvidence, version: VERSAO_JEV_V1, source: "JEV" };
}

export type SinaisJev = {
  vazio: boolean;
  proibidos: MotivoJev[];
  injecao: boolean;
  mutacaoFinanceira: boolean;
  envioExterno: boolean;
  cancelamento: boolean;
  alteracao: boolean;
  sugestao: boolean;
  consulta: boolean;
  pergunta: boolean;
  saudacao: boolean;
  dominios: Array<ClasseJev<"INTENT">>;
  motivosDominio: MotivoJev[];
  deitico: boolean;
};

export function lerSinais(texto: string): SinaisJev {
  const n = normalizar(texto);
  const dominios = DOMINIOS.filter(([, , padroes]) => tem(n, ...padroes));
  // Pergunta de ONDE/COMO FAZER ("onde eu cadastro um pacote?", "como cancelo uma festa?") é pedido de
  // orientação, não comando: o verbo não conta como ação. Proibidos e injeção continuam valendo.
  const comoFazer = /^(onde|como)\b/.test(n) && !/^como (esta|estao|anda|andam|foi|ficou|vai)\b/.test(n);
  return {
    vazio: n.length === 0,
    proibidos: PROIBIDOS.filter(([, padroes]) => tem(n, ...padroes)).map(([motivo]) => motivo),
    injecao: tem(n, ...INJECAO),
    mutacaoFinanceira: !comoFazer && tem(n, ...MUTACAO_FINANCEIRA),
    envioExterno: !comoFazer && tem(n, ...ENVIO_EXTERNO),
    cancelamento: !comoFazer && tem(n, ...CANCELAMENTO),
    alteracao: !comoFazer && tem(n, ...ALTERACAO),
    sugestao: tem(n, ...SUGESTAO),
    consulta: comoFazer || tem(n, ...CONSULTA),
    pergunta: /\?\s*$/.test(texto.trim()),
    saudacao: tem(n, ...SAUDACAO),
    dominios: dominios.map(([classe]) => classe),
    motivosDominio: dominios.map(([, motivo]) => motivo),
    deitico: DEITICO.test(n),
  };
}

/** Julgamento determinístico completo (os cinco classificadores), a partir do texto JÁ minimizado. */
export function julgarPorRegras(entrada: EntradaJev, minimizacao: MotivoJev[] = []): JulgamentoJev {
  const s = lerSinais(entrada.texto);
  // Escrita mista (homoglifos) é disfarce: recebe o mesmo tratamento de instrução embutida.
  if (minimizacao.includes("ESCRITA_MISTA")) s.injecao = true;
  const base: MotivoJev[] = ["REGRA_DETERMINISTICA", ...minimizacao];

  if (s.vazio) {
    const vazio: MotivoJev[] = [...base, "TEXTO_VAZIO"];
    return {
      intent: resultado<"INTENT">("DESCONHECIDA", 0, vazio, true),
      actionSensitivity: resultado<"ACTION_SENSITIVITY">("UNKNOWN", 0, vazio, true),
      humanNeed: resultado<"HUMAN_NEED">("RECOMENDADO", 0.5, vazio, true),
      risk: resultado<"RISK">("UNKNOWN", 0, vazio, true),
      contextSufficiency: resultado<"CONTEXT_SUFFICIENCY">("INSUFFICIENT", 0.9, vazio, true),
      origem: "REGRAS",
    };
  }

  // ---- ACTION_SENSITIVITY: o mais restritivo dos sinais presentes.
  const motivosAcao: MotivoJev[] = [...base];
  let sensibilidade: ClasseJev<"ACTION_SENSITIVITY">;
  let confAcao: number;
  if (s.proibidos.length) {
    sensibilidade = "FORBIDDEN";
    confAcao = 0.9;
    motivosAcao.push(...s.proibidos);
  } else if (s.mutacaoFinanceira || s.alteracao || s.envioExterno || s.cancelamento) {
    sensibilidade = "CONFIRM";
    confAcao = 0.85;
    if (s.mutacaoFinanceira) motivosAcao.push("SINAL_MUTACAO_FINANCEIRA");
    if (s.alteracao) motivosAcao.push("SINAL_ALTERACAO");
    if (s.envioExterno) motivosAcao.push("SINAL_ENVIO_EXTERNO");
    if (s.cancelamento) motivosAcao.push("SINAL_CANCELAMENTO");
  } else if (s.sugestao) {
    sensibilidade = "SUGGEST";
    confAcao = 0.85;
    motivosAcao.push("SINAL_SUGESTAO");
  } else if (s.consulta || (s.pergunta && s.dominios.length)) {
    sensibilidade = "READ";
    confAcao = s.consulta ? 0.9 : 0.6;
    motivosAcao.push(s.consulta ? "SINAL_CONSULTA" : "SINAL_PERGUNTA");
  } else {
    sensibilidade = "UNKNOWN";
    confAcao = 0.2;
    motivosAcao.push("SEM_SINAL");
  }
  if (s.injecao) {
    motivosAcao.push("INSTRUCAO_IGNORADA");
    // Instrução embutida nunca afrouxa: pedido de leitura/sugestão com injeção sobe para confirmação humana.
    if (sensibilidade === "READ" || sensibilidade === "SUGGEST" || sensibilidade === "UNKNOWN") sensibilidade = "CONFIRM";
  }

  // ---- INTENT: tipo de pedido primeiro (ação/alteração), depois domínio da consulta.
  const motivosIntent: MotivoJev[] = [...base, ...s.motivosDominio];
  let intent: ClasseJev<"INTENT">;
  let confIntent: number;
  const dominiosUnicos = [...new Set(s.dominios)];
  if (s.alteracao && !s.proibidos.length) {
    intent = "ALTERAR_DADO";
    confIntent = 0.85;
    motivosIntent.push("SINAL_ALTERACAO");
  } else if (s.proibidos.length || s.mutacaoFinanceira || s.envioExterno || s.cancelamento || s.sugestao) {
    intent = "SOLICITAR_ACAO";
    confIntent = 0.8;
    motivosIntent.push("SINAL_ACAO");
  } else if (dominiosUnicos.length === 1) {
    intent = dominiosUnicos[0];
    confIntent = s.consulta || s.pergunta ? 0.9 : 0.7;
  } else if (dominiosUnicos.length > 1) {
    // Domínios concorrentes: a tela desempata; sem tela compatível, é consulta genérica ambígua.
    const daTela = entrada.tela ? ENTIDADE_DA_TELA[entrada.tela] ?? (entrada.tela === "financeiro" ? "FINANCEIRO" : entrada.tela === "configuracoes" || entrada.tela === "pacotes" ? "CONFIGURACAO" : undefined) : undefined;
    intent = daTela && dominiosUnicos.includes(daTela) ? daTela : "CONSULTA";
    confIntent = 0.6;
    motivosIntent.push("AMBIGUO");
  } else if (s.consulta || s.pergunta) {
    intent = "CONSULTA";
    confIntent = s.consulta ? 0.7 : 0.5;
    motivosIntent.push(s.consulta ? "SINAL_CONSULTA" : "SINAL_PERGUNTA");
  } else if (s.saudacao) {
    intent = "OUTRO";
    confIntent = 0.8;
    motivosIntent.push("SINAL_SAUDACAO");
  } else {
    intent = "DESCONHECIDA";
    confIntent = 0.2;
    motivosIntent.push("SEM_SINAL");
  }
  if (s.injecao) motivosIntent.push("INSTRUCAO_IGNORADA");

  // ---- RISK
  const motivosRisco: MotivoJev[] = [...base];
  let risco: ClasseJev<"RISK">;
  const altoRisco = s.proibidos.length > 0 || s.injecao || s.mutacaoFinanceira;
  if (altoRisco) {
    risco = "HIGH";
    motivosRisco.push(...s.proibidos, ...(s.injecao ? ["INSTRUCAO_IGNORADA" as const] : []), ...(s.mutacaoFinanceira ? ["SINAL_MUTACAO_FINANCEIRA" as const] : []));
  } else if (sensibilidade === "CONFIRM") {
    risco = "MEDIUM";
    motivosRisco.push(...motivosAcao.filter((m) => m.startsWith("SINAL_")));
  } else if (sensibilidade === "READ" || sensibilidade === "SUGGEST") {
    risco = "LOW";
    motivosRisco.push(sensibilidade === "READ" ? "SINAL_CONSULTA" : "SINAL_SUGESTAO");
  } else {
    risco = "UNKNOWN";
    motivosRisco.push("SEM_SINAL");
  }

  // ---- CONTEXT_SUFFICIENCY: pedido sobre UMA festa/cliente/contrato exige a entidade aberta na tela certa.
  const motivosContexto: MotivoJev[] = [...base];
  let contexto: ClasseJev<"CONTEXT_SUFFICIENCY">;
  let confContexto = 0.85;
  const entidadeAlvo = dominiosUnicos.find((d) => d === "FESTA" || d === "CLIENTE" || d === "CONTRATO");
  const telaEntidade = entrada.tela ? ENTIDADE_DA_TELA[entrada.tela] : undefined;
  const falaDeUmaEntidade = s.deitico && (entidadeAlvo !== undefined || telaEntidade !== undefined);
  if (intent === "DESCONHECIDA") {
    contexto = "INSUFFICIENT";
    confContexto = 0.8;
    motivosContexto.push("SEM_SINAL");
  } else if (falaDeUmaEntidade) {
    motivosContexto.push("ENTIDADE_NECESSARIA");
    const alvo = entidadeAlvo ?? telaEntidade;
    if (!entrada.temEntidade) {
      contexto = "INSUFFICIENT";
      motivosContexto.push("ENTIDADE_AUSENTE");
    } else if (telaEntidade && alvo === telaEntidade) {
      contexto = "SUFFICIENT";
      motivosContexto.push("ENTIDADE_PRESENTE", "TELA_COMPATIVEL");
    } else {
      contexto = "INSUFFICIENT";
      motivosContexto.push("TELA_INCOMPATIVEL");
    }
  } else {
    contexto = "SUFFICIENT";
    motivosContexto.push("CONTEXTO_GERAL");
  }

  // ---- HUMAN_NEED: obrigatório para toda ação com efeito, proibida, com injeção ou de alto risco.
  const motivosHumano: MotivoJev[] = [...base];
  let humano: ClasseJev<"HUMAN_NEED">;
  if (sensibilidade === "CONFIRM" || sensibilidade === "FORBIDDEN" || risco === "HIGH") {
    humano = "OBRIGATORIO";
    motivosHumano.push(...motivosAcao.filter((m) => m !== "REGRA_DETERMINISTICA"));
  } else if (sensibilidade === "SUGGEST" || sensibilidade === "UNKNOWN" || contexto === "INSUFFICIENT") {
    humano = "RECOMENDADO";
    motivosHumano.push(sensibilidade === "SUGGEST" ? "SINAL_SUGESTAO" : contexto === "INSUFFICIENT" ? "ENTIDADE_AUSENTE" : "SEM_SINAL");
  } else {
    humano = "NAO";
    motivosHumano.push("SINAL_CONSULTA");
  }

  const semEvidencia = sensibilidade === "UNKNOWN";
  return {
    intent: resultado<"INTENT">(intent, confIntent, motivosIntent, intent === "DESCONHECIDA"),
    actionSensitivity: resultado<"ACTION_SENSITIVITY">(sensibilidade, confAcao, motivosAcao, semEvidencia),
    humanNeed: resultado<"HUMAN_NEED">(humano, semEvidencia ? 0.5 : 0.85, motivosHumano, semEvidencia),
    risk: resultado<"RISK">(risco, risco === "UNKNOWN" ? 0.2 : altoRisco ? 0.9 : 0.8, motivosRisco, risco === "UNKNOWN"),
    contextSufficiency: resultado<"CONTEXT_SUFFICIENCY">(contexto, confContexto, motivosContexto, intent === "DESCONHECIDA"),
    origem: "REGRAS",
  };
}
