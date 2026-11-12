import { normalizar } from "./texto-pt.ts";

/*
 * Pacote informado pelo operador (CORE, sem dependência de feature), lido do texto pela ação de contratação. O texto
 * NÃO decide entre alternativas: devolve o que foi dito sem ambiguidade, ou diz que não há escolha segura. O Core da
 * empresa decide depois qual pacote é (`resolverPacote`, contra o catálogo da empresa comprovada).
 */

/** Nomes INTEIROS que são um dos sete pacotes V1 (ids, nomes do catálogo da Kidmais e apelidos de sempre). */
export const NOMES_V1_EXATOS: Readonly<Record<string, string>> = {
  pocket: "pocket", "kidmais pocket": "pocket",
  mini: "mini", "mini festa": "mini", "mini festa kidmais": "mini",
  compacta: "compacta", "festa compacta": "compacta",
  essencial: "essencial", "festa essencial": "essencial",
  completa: "completa", "festa completa": "completa",
  premium: "premium", "festa premium": "premium",
  "pizza party": "pizza_party_scienza", "pizza party scienza": "pizza_party_scienza", "pizza_party_scienza": "pizza_party_scienza",
};

/** Quantidade com unidade no começo de um texto ("15 anos", "40 convidados"): dado da festa que pode seguir o nome. */
export const QUANTIDADE_COM_UNIDADE = /^\d{1,3}\s*(?:anos?|convidad\p{L}*|pessoas|crian\p{L}*|pagantes)\b/iu;

/** Palavras que negam ou excluem a menção seguinte ("não o pacote X", "tirando o pacote X", "exceto o pacote X"). */
const EXCLUSAO = String.raw`n[aã]o|nunca|sem|nada\s+de|tirando|exceto|menos|fora|salvo|al[eé]m\s+d[oa]s?`;
/** Negação/exclusão logo antes da menção, na mesma cláusula (com verbos e artigos opcionais no meio). */
const NEGADA = new RegExp(String.raw`(?:^|\s)(?:${EXCLUSAO})\s+(?:(?:quero|queria|vai|vou|ser[aá]|e|é|eh|usar|ser|pegar|fechar|incluir|contar)\s+)*(?:(?:o|a|os|as|um|uma|do|da|no|na)\s+)?$`, "iu");
/** Ligação que abre OUTRA escolha, só quando vem logo antes de uma nova menção "pacote" ("Premium e não o pacote …"). */
const LIGACAO_FINAL = new RegExp(String.raw`\s+(?:e\s+)?(?:${EXCLUSAO}|ou|mas|e)(?:\s+(?:quero|queria|o|a|um|uma|do|da))*\s*$`, "iu");
/** Cortesia que não é nome ("Festa Jardim, por favor", "obrigado"). */
const CORTESIA = /\b(?:por\s+favor|pfv|obrigad[oa]s?|valeu)\b/giu;
/** Marcas de correção ("Premium, quer dizer, Festa Jardim", "ou melhor", "na verdade"): a escolha mudou no meio. */
const CORRECAO = String.raw`quer\s+dizer|ou\s+melhor|na\s+verdade|digo|corrigindo|errei|tro[cq]\p{L}*|mud\p{L}*|alter\p{L}*|substitu\p{L}*`;
/**
 * Resposta direta sem escolha segura: começa negando/excluindo, liga alternativas ("ou", "e não", "mas não"), corrige
 * ("quer dizer", "ou melhor") ou nega em qualquer ponto ("Premium, não; Festa Jardim"). "sem" no meio não conta
 * ("Festa sem Glúten" é um nome).
 */
const RESPOSTA_INCERTA = new RegExp(String.raw`^(?:${EXCLUSAO}|nenhum)(?:\s|[,.!?]|$)|\s(?:ou|(?:e|mas)\s+n[aã]o)\s|(?:^|[^\p{L}])(?:${CORRECAO}|n[aã]o)(?![\p{L}])`, "iu");
/** Correção depois de uma menção numa frase ("pacote Premium, quer dizer, Festa Jardim", "pacote Premium, não; …"). */
/** Começo de cláusula que é outro dado da festa (rótulo de campo, ligação, cortesia), não outra escolha de pacote. */
const CLAUSULA_DE_DADO = /^(?:tema|tem[aá]tica|decora\p{L}*|aniversari\p{L}*|cliente|contratante|festa\s+(?:do|da|de)|dia|data|turno|hor[aá]rio|convidad\p{L}*|para|pra|pro|com|no|na|nos|nas|em|à|a|ao|de|do|da|e|sim|ok|isso|certo|pode|obrigad\p{L}*|por\s+favor|valeu)(?![\p{L}])/iu;
/** Marca de correção/troca em qualquer ponto de uma cláusula ("Premium troque para Festa Jardim"). */
const CORRECAO_NO_MEIO = new RegExp(String.raw`(?:^|[^\p{L}])(?:${CORRECAO})(?![\p{L}])`, "iu");
const CORRECAO_DEPOIS = new RegExp(String.raw`^\s*[,;]?\s*n[aã]o\s*(?:[,;.!?]|$)|(?:^|[^\p{L}])(?:${CORRECAO})(?![\p{L}])`, "iu");
/**
 * Complemento acessório de uma resposta direta, que não é outra escolha: quantidade com unidade, data, turno ou
 * confirmação ("Festa Jardim, 50 convidados", "Festa Jardim, dia 15/11"). Qualquer outra parte faz perguntar.
 */
const ACESSORIO = /^(?:(?:para|pra|com|são|sao|serão|serao)\s+)?\d{1,3}\s*(?:convidad\p{L}*|pessoas|crian\p{L}*|pagantes|anos?)$|^(?:(?:no\s+)?dia\s+)?\d{1,2}\/\d{1,2}(?:\/\d{2,4})?$|^(?:(?:no|na|à|a|de)\s+)?(?:almo[cç]o|noite|tarde)$|^(?:sim|ok|isso|certo|pode\s+ser)$/iu;

/**
 * - `nome`: o nome provável, como dito (números do próprio nome incluídos, ex.: "Festa 2026"), até o próximo dado —
 *   pontuação, quantidade com unidade, data ou palavra de outro dado. Id V1 só quando o nome INTEIRO é um dos sete.
 * - `trecho`: o texto até a pontuação (até 80 caracteres, cortado na palavra), quando é maior que o nome
 *   ("Festa 15 anos com bolo"): o Core confronta com o catálogo. null quando igual ao nome.
 * - `resto`: numa frase, o restante da linha depois do trecho (até 200 caracteres) — evidência para o Core conferir se
 *   a frase cita OUTRO pacote do catálogo ("pacote Premium, troque para Festa Jardim"). null quando não há.
 * - `recusas`: numa frase, os nomes das menções "pacote X" negadas na mesma linha ("não quero o pacote Premium") — o
 *   Core confronta com o escolhido (afirmação e recusa do mesmo pacote perguntam). Ausente quando não há.
 */
export type PacoteDito = { nome: string; trecho: string | null; resto?: string | null; recusas?: string[] };

/**
 * Resultado da leitura:
 * - `dito`: uma só menção afirmativa (ou várias iguais) — é o pacote informado;
 * - `incerto`: só menções negadas/excluídas, ou alternativas diferentes — NÃO há escolha segura: a ação pergunta
 *   (sem recorrer aos nomes V1 nem ao valor da Luna);
 * - `nenhum`: nenhuma menção legível de pacote.
 */
export type LeituraPacote = { tipo: "dito"; pacote: PacoteDito } | { tipo: "incerto" } | { tipo: "nenhum" };

/**
 * Na resposta direta à pergunta do pacote, a resposta inteira. Numa frase, as menções "pacote X" da mesma linha (o
 * histórico vem em linhas separadas e não entra); a posição nunca decide.
 */
export function lerPacote(texto: string, respostaDireta: boolean): LeituraPacote {
  if (respostaDireta) {
    // Resposta que nega/exclui ("não, o Premium Jardim não", "tirando o Premium") ou traz alternativas ("Premium ou
    // Premium Jardim", "Premium e não o Jardim"): não há escolha segura — pergunta de novo.
    if (RESPOSTA_INCERTA.test(texto.trim())) return { tipo: "incerto" };
    const inteira = nomeLimpo(texto.replace(/^\s*(?:(?:o|a)\s+)?pacote\s+/iu, "").replace(/[.!?]+\s*$/u, ""));
    if (inteira) return { tipo: "dito", pacote: { nome: NOMES_V1_EXATOS[normalizar(inteira)] ?? inteira, trecho: null } };
    // Resposta composta ("Festa Jardim, por favor", "o pacote Festa Jardim, 50 convidados"): a primeira parte com
    // conteúdo (a palavra "pacote" é só rótulo), e só se TODO o resto for cortesia ou complemento acessório — outra
    // escolha, troca ou segundo nome ("pacote Premium, Festa Jardim", "…, troque para Festa Jardim") pergunta.
    const partes = texto.replace(/["“”«»]/gu, "").replace(CORTESIA, " ").replace(/\b(?:(?:o|a)\s+)?pacote\b/giu, " ")
      .split(/[,;.!?\n]/u).map((p) => p.trim()).filter(Boolean);
    const nome = partes.length > 0 ? nomeLimpo(partes[0]) : null;
    if (nome && partes.slice(1).every((p) => ACESSORIO.test(p))) {
      return { tipo: "dito", pacote: { nome: NOMES_V1_EXATOS[normalizar(nome)] ?? nome, trecho: null } };
    }
    // Respondeu à pergunta do pacote, mas não dá para ler a escolha: pergunta de novo — nunca deixa a Luna completar com
    // um pacote de outra mensagem (o histórico vai a ela como contexto).
    return /\S/u.test(texto) ? { tipo: "incerto" } : { tipo: "nenhum" };
  }
  const afirmadas: PacoteDito[] = [];
  let excluidas = 0, corrigidas = 0;
  // Cada ocorrência vai só até o próximo "pacote" da linha.
  const mencoes = [...texto.matchAll(/\bpacote[ \t]+((?:(?!\bpacote\b)[^\n]){1,80})/giu)].map((m) => {
    const ini = Math.max(0, m.index! - 50);
    const clausula = texto.slice(ini, m.index!).split(/[,;.!?\n]/u).at(-1) ?? "";
    return { m, negada: NEGADA.test(clausula), inicio: m.index! - clausula.length, fim: m.index! + m[0].length - m[1].length + m[1].split(/[,;.!?]/u)[0].length };
  });
  // O resto da linha (evidência para o Core) sem as menções negadas: "pacote Premium, não quero o pacote Premium Jardim"
  // não cita o Premium Jardim como outra escolha.
  let semNegadas = texto;
  for (const x of mencoes) if (x.negada) semNegadas = semNegadas.slice(0, x.inicio) + " ".repeat(x.fim - x.inicio) + semNegadas.slice(x.fim);
  // Menções negadas guardadas à parte (o Core confronta com o escolhido), nunca apagadas da evidência.
  // A recusa leva a menção COMPLETA (como a afirmada leva o trecho): "não quero o pacote Festa com Bolo" recusa "Festa com
  // Bolo", não só "Festa" — o Core confronta com o catálogo.
  const recusas = mencoes.filter((x) => x.negada).map((x) => {
    let corte = x.m[1].split(/[,;.!?]/u)[0];
    if (/^\s*pacote\b/iu.test(texto.slice(x.m.index! + x.m[0].length))) corte = corte.replace(LIGACAO_FINAL, "");
    return trechoLimpo(corte) ?? nomeLimpo(nomeDaMencao(corte));
  }).filter((x): x is string => !!x);
  for (const { m, negada } of mencoes) {
    if (negada) { excluidas++; continue; }
    let corte = m[1].split(/[,;.!?]/u)[0];
    // Corrigida logo depois ("pacote Premium, quer dizer, Festa Jardim", "pacote Premium, não; …").
    const depois = semNegadas.slice(m.index! + m[0].length - m[1].length + corte.length).split("\n")[0];
    const clausulaSeguinte = depois.replace(/^\s*[,;.!?]\s*/u, "").split(/[,;.!?]/u)[0];
    if (CORRECAO_DEPOIS.test(depois) || CORRECAO_NO_MEIO.test(corte) || CORRECAO_NO_MEIO.test(clausulaSeguinte) || clausulaSolta(clausulaSeguinte)) { corrigidas++; continue; }
    // A ligação ("e não o", "ou o", "sem o") só separa escolhas quando vem logo antes de outra menção "pacote".
    if (/^\s*pacote\b/iu.test(texto.slice(m.index! + m[0].length))) corte = corte.replace(LIGACAO_FINAL, "");
    const nome = nomeLimpo(nomeDaMencao(corte));
    if (!nome) continue;
    const bruto = trechoLimpo(corte);
    const resto = depois.replace(/^\s*[,;.!?]\s*/u, "").replace(/\s+/g, " ").trim().slice(0, 200).replace(/\s+\S*$/u, (x) => (depois.length > 200 ? "" : x));
    afirmadas.push({ nome: NOMES_V1_EXATOS[normalizar(nome)] ?? nome, trecho: bruto && normalizar(bruto) !== normalizar(nome) ? bruto : null, ...(resto ? { resto } : {}), ...(recusas.length ? { recusas } : {}) });
  }
  // Menções comparadas pelo que foi dito por inteiro (trecho, quando maior que o nome): "pacote Festa com Bolo ou pacote
  // Festa com Doces" são alternativas diferentes, mesmo com o mesmo nome provável — o texto não escolhe.
  const distintas = new Set(afirmadas.map((a) => normalizar((a.trecho ?? a.nome).replace(/_/g, " "))));
  // Correção explícita na frase: a escolha mudou no meio — pergunta, em vez de adivinhar qual vale.
  if (corrigidas > 0) return { tipo: "incerto" };
  if (distintas.size === 1) return { tipo: "dito", pacote: afirmadas[0] };
  return distintas.size > 1 || excluidas > 0 ? { tipo: "incerto" } : { tipo: "nenhum" };
}

/** Nome provável de uma menção: até o próximo dado (quantidade com unidade, data ou palavra de outro dado). */
function nomeDaMencao(corte: string): string {
  return corte.split(/\s+\d{1,3}\s*(?:convidad\p{L}*|pessoas|crian\p{L}*|pagantes|anos?)\b|\s+\d{1,2}\/\d{1,2}|\s(?:com|para|pra|pro|no|na|em|dia|do cliente|da cliente|aniversari\p{L}*|convidad\p{L}*)\b/iu)[0];
}

/**
 * Cláusula logo depois do pacote que não é reconhecida como dado ("pacote Premium, Festa Jardim"): só palavras, sem
 * número, sem rótulo de outro campo e fora do complemento acessório. Pode ser 2ª escolha (mesmo de nome inexistente) —
 * a leitura pergunta, em vez de presumir que vale a primeira.
 */
function clausulaSolta(clausula: string): boolean {
  const c = clausula.replace(CORTESIA, " ").replace(/\s+/g, " ").trim();
  if (!c || ACESSORIO.test(c) || /\d/u.test(c)) return false;
  if (CLAUSULA_DE_DADO.test(c)) return false;
  // Um nome solto de uma palavra ("Beatriz") é outro dado comum; duas ou mais palavras, ou palavra de pacote (festa, kit,
  // combo, plano), parecem outra escolha.
  const palavras = c.split(" ");
  return palavras.length <= 4 && /^[\p{L}][\p{L} '-]*$/u.test(c) && (palavras.length >= 2 || /^(?:festa|kit|combo|plano)$/iu.test(c));
}

/** O pacote dito, ou null (incerto ou nenhum). */
export function pacoteInformado(texto: string, respostaDireta: boolean): PacoteDito | null {
  const leitura = lerPacote(texto, respostaDireta);
  return leitura.tipo === "dito" ? { nome: leitura.pacote.nome, trecho: leitura.pacote.trecho } : null;
}

/** Só o nome provável (ver `lerPacote`). */
export function pacoteDoTexto(texto: string, respostaDireta: boolean): string | null {
  return pacoteInformado(texto, respostaDireta)?.nome ?? null;
}

function nomeLimpo(trecho: string): string | null {
  const nome = trecho
    .replace(/^(?:(?:o|a)\s+)?(?:certo|correto|escolhido)\s+(?:é|e|eh)\s+/iu, "")
    .replace(/^(?:o|a|é|e)\s+/iu, "")
    .replace(/\s+/g, " ")
    .trim();
  return nome.length >= 2 && nome.length <= 60 && /^[\p{L}\p{N}][\p{L}\p{N} '_/-]*$/u.test(nome) ? nome : null;
}

/**
 * Trecho bruto preservado como evidência (não é nome): até o primeiro caractere fora do formato e até 80 caracteres,
 * cortado na palavra — contexto longo ou um parêntese nunca apagam a evidência de ambiguidade.
 */
function trechoLimpo(trecho: string): string | null {
  let bruto = trecho.replace(/^(?:o|a|é|e)\s+/iu, "").replace(/\s+/g, " ").trim();
  bruto = (/^[\p{L}\p{N}][\p{L}\p{N} '_/-]*/u.exec(bruto)?.[0] ?? "").trim();
  if (bruto.length > 80) bruto = bruto.slice(0, 80).replace(/\s+\S*$/u, "");
  return bruto.length >= 2 ? bruto : null;
}
