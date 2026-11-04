/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Plano "liberar agenda com mais de um salão" (rev. 6–7, aprovado pelo Astra): guarda ESTÁTICA dos escritores de
 * fechamentos.salao_id e fechamento_revisoes.salao_id, pela API do compilador TypeScript (allowJs), sobre .ts, .tsx,
 * .js, .cjs e .mjs de lib/, app/ e scripts/, e sobre os .sql de database/.
 *
 *  1. Sinks por ponto fixo: toda chamada `*.query(...)`/`*.execute(...)` é sink do 1º argumento; toda função que repassa
 *     um parâmetro seu a um sink (direta ou transitivamente, entre módulos pelo checker) vira sink desse parâmetro.
 *  2. Resolução no ponto de chamada, por conjuntos de valores: literais, templates, concatenação, condicionais, tipos
 *     literais do checker (uniões de strings; números viram "0"), constantes (inclusive importadas), objetos e arrays
 *     locais (push, map, filter, join), e funções do repositório avaliadas com os argumentos (retorno resolvido).
 *  3. Argumento de sink não resolvido = SQL_NAO_RESOLVIDO, sem olhar a tabela. Exceção só pela lista explícita
 *     (função + parâmetro), e os chamadores dessa função continuam sendo resolvidos.
 *  4. SQL resolvido que escreve salao_id nessas tabelas: em produção, só por `escreverSalao` com escritor literal (B);
 *     em arquivo de teste/apoio, fixture C. Nos .sql, qualquer escrita dessas colunas (inclusive `NEW.salao_id :=`).
 *
 * Saída: um relatório (pontos de escrita, não resolvidos, sinks derivados); a comparação com a tabela B, C e as exceções
 * fica no teste (lib/agenda/guarda-salao-estatica.test.ts).
 */
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const PASTAS = ["lib", "app", "scripts"];
const EXTENSOES = /\.(ts|tsx|js|cjs|mjs)$/;
const TABELAS = ["fechamentos", "fechamento_revisoes"];
/** Arquivo de teste ou de apoio de teste (camada C). */
const ARQUIVO_DE_TESTE = /(\.test\.(ts|tsx|cjs|mjs|js)|test-support\.ts|test-apoio\.(ts|cjs)|-ui\.cjs)$/;
const LIMITE_VALORES = 64;
const PROF_MAX = 160;

// ---------------------------------------------------------------------------------------------------- SQL

/** Remove comentários e literais de texto do SQL (os literais viram ''), para não casar palavras dentro deles. */
function limparSql(sql) {
  let s = "", i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") { const f = sql.indexOf("\n", i); i = f < 0 ? sql.length : f; continue; }
    if (c === "/" && sql[i + 1] === "*") { const f = sql.indexOf("*/", i + 2); i = f < 0 ? sql.length : f + 2; s += " "; continue; }
    if (c === "'") { i++; while (i < sql.length) { if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; } if (sql[i] === "'") break; i++; } i++; s += "''"; continue; }
    // Rodada 2 (P2 do Astra): identificador delimitado ("salao_id", "public"."fechamentos", com "" de escape). Vira o nome
    // sem aspas quando é um identificador simples; senão um marcador neutro. Falha fechada: "SALAO_ID" também conta como
    // salao_id (o texto é passado para minúsculas), o que só pode gerar falso positivo, nunca negativo.
    if (c === '"') {
      let nome = ""; i++;
      while (i < sql.length) { if (sql[i] === '"' && sql[i + 1] === '"') { nome += '"'; i += 2; continue; } if (sql[i] === '"') break; nome += sql[i]; i++; }
      i++;
      s += /^[A-Za-z_][A-Za-z0-9_$]*$/.test(nome) ? nome : "identificador_delimitado";
      continue;
    }
    s += c; i++;
  }
  return s.toLowerCase();
}

/** Lista de atribuições de nível 0 a partir de `inicio` (logo depois de SET), até FROM/WHERE/RETURNING/ON/; ou ")" que fecha. */
function trechoSet(s, inicio) {
  let nivel = 0, i = inicio;
  const partes = [];
  let atual = "";
  while (i < s.length) {
    const c = s[i];
    if (c === "(") nivel++;
    else if (c === ")") { if (nivel === 0) break; nivel--; }
    else if (c === ";" && nivel === 0) break;
    else if (nivel === 0 && /[a-z]/.test(c) && !/[a-z0-9_.]/.test(s[i - 1] ?? "")) {
      const m = /^(from|where|returning)\b/.exec(s.slice(i, i + 10));
      if (m) break;
    }
    if (c === "," && nivel === 0) { partes.push(atual); atual = ""; } else atual += c;
    i++;
  }
  partes.push(atual);
  return partes;
}

const alvoEscreveSalao = (atribuicao) => {
  const m = /^\s*(\([^)]*\)|[a-z_][a-z0-9_."]*)\s*=/.exec(atribuicao);
  return !!m && /(^|[^a-z0-9_])salao_id([^a-z0-9_]|$)/.test(m[1]);
};

/** Escritas de salao_id em fechamentos/fechamento_revisoes contidas no texto SQL. */
function escritasDeSalao(sql) {
  const s = limparSql(sql);
  const achadas = [];
  const tabela = `(?:only\\s+)?(?:"?public"?\\.)?"?(${TABELAS.join("|")})"?`;
  for (const m of s.matchAll(new RegExp(`\\bupdate\\s+${tabela}(?![a-z0-9_])`, "g"))) {
    const set = /\bset\b/.exec(s.slice(m.index));
    if (!set) continue;
    if (trechoSet(s, m.index + set.index + 3).some(alvoEscreveSalao)) achadas.push({ tabela: m[1], operacao: "UPDATE" });
  }
  for (const m of s.matchAll(new RegExp(`\\binsert\\s+into\\s+${tabela}(?![a-z0-9_])(\\s+as\\s+[a-z_]+)?\\s*(\\(([^)]*)\\))?`, "g"))) {
    const colunas = m[4];
    const resto = s.slice(m.index);
    const conflito = /\bdo\s+update\s+set\b/.exec(resto);
    const noConflito = conflito && trechoSet(resto, conflito.index + conflito[0].length).some(alvoEscreveSalao);
    if (colunas === undefined || /(^|[^a-z0-9_])salao_id([^a-z0-9_]|$)/.test(colunas) || noConflito) achadas.push({ tabela: m[1], operacao: "INSERT" });
  }
  for (const m of s.matchAll(new RegExp(`\\bmerge\\s+into\\s+${tabela}(?![a-z0-9_])`, "g")))
    if (/\bsalao_id\b/.test(s.slice(m.index))) achadas.push({ tabela: m[1], operacao: "MERGE" });
  return achadas;
}

/** .sql de database/: escrita das colunas (DML acima) ou atribuição a NEW.salao_id em função de gatilho. */
function escritasEmSql(texto) {
  const s = limparSql(texto);
  const achadas = escritasDeSalao(texto).map((e) => ({ ...e }));
  if (/(^|;|\bbegin\b|\bthen\b|\belse\b|\bloop\b|\$\$)\s*new\s*\.\s*"?salao_id"?\s*:?=(?!=)/m.test(s)) achadas.push({ tabela: "(gatilho)", operacao: "NEW.salao_id" });
  return achadas;
}

// ---------------------------------------------------------------------------------------------------- arquivos

function caminhar(dir, saida) {
  if (!fs.existsSync(dir)) return;
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (item.name === "node_modules" || item.name.startsWith(".")) continue;
    const p = path.join(dir, item.name);
    if (item.isDirectory()) caminhar(p, saida);
    else if (EXTENSOES.test(item.name) && !item.name.endsWith(".d.ts")) saida.push(p);
  }
}

function arquivosDoRepositorio(raiz, pastas = PASTAS) {
  const saida = [];
  for (const p of pastas) caminhar(path.join(raiz, p), saida);
  return saida.sort();
}

function arquivosSql(raiz) {
  const saida = [];
  (function andar(dir) {
    if (!fs.existsSync(dir)) return;
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, item.name);
      if (item.isDirectory()) andar(p); else if (item.name.endsWith(".sql")) saida.push(p);
    }
  })(path.join(raiz, "database"));
  return saida.sort();
}

// ---------------------------------------------------------------------------------------------------- análise

/**
 * Valores: { v: string[] } (conjunto resolvido; `aproximado` quando o produto passou do limite e as alternativas foram
 * concatenadas) | { param: { funcao, indice } } | { nao: motivo }.
 */
const NAO = (motivo) => ({ nao: motivo });
const VAL = (v, aproximado = false) => ({ v: [...new Set(v)], aproximado });
const ok = (r) => r && Array.isArray(r.v);

function produto(a, b) {
  if (a.nao) return a; if (b.nao) return b;
  if (a.param) return a; if (b.param) return b;
  const ap = a.aproximado || b.aproximado;
  if (a.v.length * b.v.length > LIMITE_VALORES) return VAL([a.v.join(" ") + b.v.join(" ")], true);
  const r = [];
  for (const x of a.v) for (const y of b.v) r.push(x + y);
  return VAL(r, ap);
}
function uniao(lista) {
  const nao = lista.find((r) => r.nao); if (nao) return nao;
  const param = lista.find((r) => r.param); if (param) return param;
  const v = lista.flatMap((r) => r.v);
  const ap = lista.some((r) => r.aproximado);
  return v.length > LIMITE_VALORES ? VAL([v.join(" ")], true) : VAL(v, ap);
}

function analisar({ raiz, arquivos, excecoes = [] } = {}) {
  raiz = path.resolve(raiz);
  arquivos = arquivos ?? arquivosDoRepositorio(raiz);
  const programa = ts.createProgram(arquivos, {
    allowJs: true, checkJs: false, noEmit: true, skipLibCheck: true, strict: false, target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, allowImportingTsExtensions: true,
    jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true, resolveJsonModule: true, baseUrl: raiz, paths: { "@/*": ["./*"] },
    types: [], noLib: false,
  });
  const checker = programa.getTypeChecker();
  const relativo = (sf) => path.relative(raiz, sf.fileName).replace(/\\/g, "/");
  const nossos = programa.getSourceFiles().filter((sf) => !sf.isDeclarationFile && !/node_modules/.test(sf.fileName)
    && PASTAS.some((p) => relativo(sf).startsWith(`${p}/`)));

  const ehFuncao = (n) => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);
  const funcaoQueContem = (n) => { let p = n.parent; while (p && !ehFuncao(p)) p = p.parent; return p ?? null; };
  function nomeDaFuncao(f) {
    if (!f) return "(módulo)";
    if (f.name && ts.isIdentifier(f.name)) return f.name.text;
    if (f.name && ts.isStringLiteral(f.name)) return f.name.text;
    const p = f.parent;
    if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
    if (p && ts.isPropertyAssignment(p)) return p.name.getText();
    if (p && ts.isCallExpression(p)) return `${nomeDaFuncao(funcaoQueContem(p))}→callback`;
    return "(anônima)";
  }
  const local = (n) => { const sf = n.getSourceFile(); return { arquivo: relativo(sf), linha: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1 }; };

  function simbolo(n) {
    let s = checker.getSymbolAtLocation(n);
    if (s && s.flags & ts.SymbolFlags.Alias) { try { s = checker.getAliasedSymbol(s); } catch { /* sem alvo */ } }
    if (!s && n.parent && ts.isShorthandPropertyAssignment(n.parent)) s = checker.getShorthandAssignmentValueSymbol(n.parent);
    return s;
  }
  const simboloDe = (nome) => checker.getSymbolAtLocation(nome);

  /**
   * Vínculos provados (P2-1 do Astra no delta do merge 03/11; P2-R2-1/P2-R2-2 na r2 de 04/11). A resolução pelo
   * inicializador só vale para um vínculo que nada no repositório pode trocar. Pré-passada única e conservadora por
   * todos os arquivos analisados (inclusive testes):
   * - identificador: nenhuma escrita (=, compostas, ++/--, delete, for-in/of, qualquer alvo de desestruturação — o
   *   abreviado `({h} = …)` resolve o símbolo do VALOR, não o da propriedade);
   * - cadeia `raiz.p1…pn` (objeto): a raiz tem de ser um objeto literal novo (`const|let|var o = { … }`) ou um namespace
   *   de import, que NUNCA vaza como valor — toda referência é `o.x` ou `o[…]` (sem alias, argumento, retorno, spread,
   *   abreviado, export default); nenhum nome da cadeia é escrito por nome em lugar nenhum (`X.p =`, `X["p"] =`, delete,
   *   desestruturação), sob qualquer alias ou tipo; elos intermediários não vazam por nome (`X.p` usado como valor,
   *   `const {p} = X`); escrita por índice dinâmico na raiz/num elo, ou em base que não é identificador nem `X.p`
   *   (`this[k] =`, `f()[k] =`), invalida; o `this` que vaza (valor ou índice dinâmico) exige raiz "pura" (só funções
   *   sem `this` e literais); eval/with derrubam tudo.
   * Fora disso o callee não resolve e o SQL fica não resolvido.
   */
  let mutacoes = null;
  function simboloValor(n) {
    let s = n.parent && ts.isShorthandPropertyAssignment(n.parent) && n.parent.name === n
      ? checker.getShorthandAssignmentValueSymbol(n.parent) : checker.getSymbolAtLocation(n);
    if (s && s.flags & ts.SymbolFlags.Alias) { try { s = checker.getAliasedSymbol(s); } catch { /* sem alvo */ } }
    return s;
  }
  const literalDeChave = (a) => a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a) || ts.isNumericLiteral(a)) ? a.text : null;
  const ehBaseDeAcesso = (n) => n.parent && (ts.isPropertyAccessExpression(n.parent) || ts.isElementAccessExpression(n.parent)) && n.parent.expression === n;
  const SUPER = Symbol("super"); // membro lido por `super`: nunca é próprio
  const ehDeclaracaoDeAlias = (p) => ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isExportSpecifier(p) || ts.isImportEqualsDeclaration(p);
  function coletarMutacoes() {
    const atribuidos = new Map(), dinamicos = new Set(), nomesEscritos = new Set(), nomesDinamicos = new Set(), nomesEscapados = new Set();
    const candidatos = new Map(); // texto do identificador → nós usados como valor (não base de acesso)
    const membrosPorBase = new Map(), membrosPorElo = new Map(); // `id.membro` por texto de id; `X.elo.membro` por elo
    const membrosDeThis = new Set(); // `this.membro`/`super.membro` em qualquer lugar (P2-R4-1); super = sempre herdado
    let dinamicoGeral = false, thisVaza = false, total = false;
    const aliases = []; // nomes locais de import/export (a raiz pode ser usada por outro nome)
    const marcar = (s) => { if (s) atribuidos.set(s, (atribuidos.get(s) ?? 0) + 1); };
    const dinamicoEm = (base) => {
      base = semEmbrulho(base);
      if (base && ts.isIdentifier(base)) { const s = simboloValor(base); if (s) dinamicos.add(s); }
      else if (base && ts.isPropertyAccessExpression(base)) nomesDinamicos.add(base.name.text);
      else if (base && ts.isElementAccessExpression(base) && literalDeChave(base.argumentExpression) !== null) nomesDinamicos.add(literalDeChave(base.argumentExpression));
      // Outras bases (chamada, new, condicional…) só alcançam um objeto que já vazou como valor — a raiz e os elos são
      // conferidos por isso. `this` pode ser a raiz (método chamado como `o.m()`): exige raiz pura.
      else if (base && (base.kind === ts.SyntaxKind.ThisKeyword || base.kind === ts.SyntaxKind.SuperKeyword)) thisVaza = true;
    };
    const alvo = (e) => {
      e = semEmbrulho(e);
      if (!e) return;
      if (ts.isIdentifier(e)) return marcar(simboloValor(e));
      if (ts.isPropertyAccessExpression(e)) { nomesEscritos.add(e.name.text); return marcar(simbolo(e.name)); }
      if (ts.isElementAccessExpression(e)) {
        const chave = literalDeChave(e.argumentExpression);
        if (chave !== null) { nomesEscritos.add(chave); const s = checker.getSymbolAtLocation(e); if (s) marcar(s); return; }
        return dinamicoEm(e.expression);
      }
      if (ts.isArrayLiteralExpression(e)) { for (const x of e.elements) alvo(ts.isSpreadElement(x) ? x.expression : x); return; }
      if (ts.isObjectLiteralExpression(e)) {
        for (const p of e.properties) {
          if (ts.isPropertyAssignment(p)) alvo(p.initializer);
          else if (ts.isShorthandPropertyAssignment(p)) marcar(simboloValor(p.name)); // P2-R2-1: símbolo do valor
          else if (ts.isSpreadAssignment(p)) alvo(p.expression);
        }
        return;
      }
      if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken) return alvo(e.left); // padrão
      dinamicoGeral = true; // alvo de forma desconhecida: conservador
    };
    const ATRIB = new Set([ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken,
      ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.PercentEqualsToken,
      ts.SyntaxKind.AsteriskAsteriskEqualsToken, ts.SyntaxKind.LessThanLessThanEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
      ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken, ts.SyntaxKind.AmpersandEqualsToken, ts.SyntaxKind.BarEqualsToken,
      ts.SyntaxKind.CaretEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken,
      ts.SyntaxKind.QuestionQuestionEqualsToken]);
    const visitar = (n) => {
      if (ts.isBinaryExpression(n) && ATRIB.has(n.operatorToken.kind)) alvo(n.left);
      else if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
        (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)) alvo(n.operand);
      else if (ts.isDeleteExpression(n)) alvo(n.expression);
      else if ((ts.isForInStatement(n) || ts.isForOfStatement(n)) && !ts.isVariableDeclarationList(n.initializer)) alvo(n.initializer);
      else if (ts.isWithStatement(n)) total = true;
      // P2-R3-2: qualquer referência ao identificador eval (direta, `(eval)(…)`, alias, argumento) derruba tudo.
      // Só não conta o nome numa declaração/literal (`{ eval: true }`, `function eval`); o abreviado `{eval}` e
      // `globalThis.eval` contam (conservador: eval indireto também).
      if (ts.isIdentifier(n) && n.text === "eval" && !(n.parent && !ts.isShorthandPropertyAssignment(n.parent)
        && !ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) total = true;
      // P2-R3-1: membro lido de uma base. Raiz e elos só podem ter membros PRÓPRIOS declarados no literal — um membro
      // herdado (`__defineGetter__`, `__defineSetter__`, …) chamado na raiz recebe a raiz como `this` e pode trocá-la.
      if (ts.isPropertyAccessExpression(n) || (ts.isElementAccessExpression(n) && literalDeChave(n.argumentExpression) !== null)) {
        const membro = ts.isPropertyAccessExpression(n) ? n.name.text : literalDeChave(n.argumentExpression);
        const b = n.expression;
        if (ts.isIdentifier(b)) { const l = membrosPorBase.get(b.text); if (l) l.push(n); else membrosPorBase.set(b.text, [n]); }
        // P2-R4-1: dentro de um método, `this` é o próprio objeto (raiz ou elo); `super.x(…)` lê do protótipo e passa
        // o objeto como `this`. O membro lido conta contra os próprios de todo literal com método que usa this/super.
        else if (b.kind === ts.SyntaxKind.ThisKeyword) membrosDeThis.add(membro);
        else if (b.kind === ts.SyntaxKind.SuperKeyword) membrosDeThis.add(SUPER);
        else if (ts.isPropertyAccessExpression(b) || (ts.isElementAccessExpression(b) && literalDeChave(b.argumentExpression) !== null)) {
          const elo = ts.isPropertyAccessExpression(b) ? b.name.text : literalDeChave(b.argumentExpression);
          const s = membrosPorElo.get(elo); if (s) s.add(membro); else membrosPorElo.set(elo, new Set([membro]));
        }
      }
      if (ts.isIdentifier(n) && !ehBaseDeAcesso(n) && !(n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)
        && !(n.parent && ts.isQualifiedName(n.parent)) && !(n.parent && ts.isTypeQueryNode(n.parent))) {
        const lista = candidatos.get(n.text); if (lista) lista.push(n); else candidatos.set(n.text, [n]);
      }
      if (n.kind === ts.SyntaxKind.ThisKeyword && !ehBaseDeAcesso(n)) thisVaza = true;
      // Elo usado como valor (não base de outro acesso, não callee): o objeto em `X.p` ganha alias.
      if ((ts.isPropertyAccessExpression(n) || (ts.isElementAccessExpression(n) && literalDeChave(n.argumentExpression) !== null))
        && !ehBaseDeAcesso(n) && !(n.parent && ts.isCallExpression(n.parent) && n.parent.expression === n)) {
        nomesEscapados.add(ts.isPropertyAccessExpression(n) ? n.name.text : literalDeChave(n.argumentExpression));
      }
      if (ts.isElementAccessExpression(n) && literalDeChave(n.argumentExpression) === null) {
        // `X[k]` em qualquer posição (valor, base de outro acesso, callee `X[k](…)` com X como `this`) alcança qualquer
        // membro de X, próprio ou herdado: X (ou o nome do elo) deixa de ser provado.
        dinamicoEm(n.expression);
      }
      if (ts.isIdentifier(n) && n.parent && ehDeclaracaoDeAlias(n.parent) && n.parent.name === n) aliases.push(n);
      ts.forEachChild(n, visitar);
    };
    for (const sf of nossos) visitar(sf);
    return { atribuidos, dinamicos, nomesEscritos, nomesDinamicos, nomesEscapados, candidatos, aliases, membrosPorBase, membrosPorElo, membrosDeThis, dinamicoGeral, thisVaza, total, escapaCache: new Map(), nomesPorAlvo: null };
  }
  function mutavel(s) {
    if (!s) return false;
    mutacoes ??= coletarMutacoes();
    if (mutacoes.total || mutacoes.dinamicos.has(s)) return true;
    const n = mutacoes.atribuidos.get(s) ?? 0;
    if (n === 0) return false;
    if (n >= 2) return true;
    // Uma atribuição: só é a própria declaração quando todas as declarações nascem de atribuição (expando de JS).
    return !(s.declarations ?? []).every((d) => d.parent && ts.isBinaryExpression(d.parent) ||
      (ts.isBinaryExpression(d) && d.operatorToken.kind === ts.SyntaxKind.EqualsToken));
  }
  /** Algum uso do símbolo como valor (fora de `s.x`/`s[…]`), por qualquer nome local que o importe? */
  function vazaComoValor(s) {
    const m = mutacoes;
    if (m.escapaCache.has(s)) return m.escapaCache.get(s);
    if (!m.nomesPorAlvo) {
      m.nomesPorAlvo = new Map();
      for (const n of m.aliases) { const a = simboloValor(n); if (!a) continue; const c = m.nomesPorAlvo.get(a); if (c) c.add(n.text); else m.nomesPorAlvo.set(a, new Set([n.text])); }
    }
    const nomes = new Set([s.name, ...(m.nomesPorAlvo.get(s) ?? [])]);
    let vaza = false;
    for (const nome of nomes) {
      for (const n of m.candidatos.get(nome) ?? []) {
        if (n.parent && ehDeclaracaoDeAlias(n.parent)) continue; // a própria importação/reexportação (os usos são conferidos)
        if ((s.declarations ?? []).some((d) => d.name === n)) continue; // o nome na declaração
        if (simboloValor(n) === s) { vaza = true; break; }
      }
      if (vaza) break;
    }
    m.escapaCache.set(s, vaza);
    return vaza;
  }
  /** Objeto literal "puro": só funções sem `this` próprio, literais e objetos puros — nenhum método herda o objeto. */
  function objetoPuro(o) {
    // Uma função/método/acessor/classe interna tem receptor próprio no corpo, mas partes dela são avaliadas no contexto
    // externo e enxergam o this/super do método (P2-R5-1): decoradores, nome computado e, na classe, a herança
    // (`extends`) e o nome computado e os decoradores de cada membro. Só essas partes são visitadas; o corpo não.
    const receptorProprio = (n) => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n)
      || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isClassLike(n);
    const usaThis = (f) => {
      let achou = false;
      const externas = (n) => {
        for (const d of (ts.canHaveDecorators(n) ? ts.getDecorators(n) : undefined) ?? []) v(d);
        if (n.name && ts.isComputedPropertyName(n.name)) v(n.name);
        // Decoradores de parâmetro (legados) também são avaliados fora (P2-R6-1); o default do parâmetro não: usa o
        // receptor da invocação interna.
        for (const p of n.parameters ?? []) for (const d of (ts.canHaveDecorators(p) ? ts.getDecorators(p) : undefined) ?? []) v(d);
        if (ts.isClassLike(n)) {
          for (const h of n.heritageClauses ?? []) v(h);
          for (const membro of n.members) externas(membro);
        }
      };
      const v = (n) => {
        if (achou) return;
        if (n.kind === ts.SyntaxKind.ThisKeyword || n.kind === ts.SyntaxKind.SuperKeyword) { achou = true; return; }
        if (n !== f && receptorProprio(n)) { externas(n); return; }
        ts.forEachChild(n, v);
      };
      v(f);
      return achou;
    };
    for (const p of o.properties) {
      if (ts.isMethodDeclaration(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) { if (usaThis(p)) return false; continue; }
      if (!ts.isPropertyAssignment(p)) return false;
      const v = semEmbrulho(p.initializer);
      if (ts.isArrowFunction(v)) continue;
      if (ts.isFunctionExpression(v)) { if (usaThis(v)) return false; continue; }
      if (ts.isObjectLiteralExpression(v)) { if (!objetoPuro(v)) return false; continue; }
      if (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v) || ts.isNumericLiteral(v) || v.kind === ts.SyntaxKind.TrueKeyword || v.kind === ts.SyntaxKind.FalseKeyword || v.kind === ts.SyntaxKind.NullKeyword) continue;
      return false;
    }
    return true;
  }
  /** Motivo pelo qual o vínculo do callee não está provado; null quando está. */
  function vinculoNaoProvado(expr) {
    mutacoes ??= coletarMutacoes();
    const m = mutacoes;
    if (m.total) return "eval/with no repositório";
    const elos = [];
    let e = semEmbrulho(expr);
    while (e && ts.isPropertyAccessExpression(e)) { elos.unshift(e); e = semEmbrulho(e.expression); }
    if (!e || !ts.isIdentifier(e)) return "raiz não é identificador";
    const sRaiz = simboloValor(e);
    if (!elos.length) return mutavel(sRaiz) ? "identificador reatribuído" : null;
    if (m.dinamicoGeral) return "objeto mutável por índice/forma dinâmica no repositório";
    if (!sRaiz || mutavel(sRaiz)) return "raiz reatribuída ou mutada por índice";
    const d = sRaiz.declarations?.[0];
    const ehNamespace = (sRaiz.flags & ts.SymbolFlags.ValueModule) !== 0 && d && ts.isSourceFile(d);
    const literal = d && sRaiz.declarations.length === 1 && ts.isVariableDeclaration(d) && ts.isIdentifier(d.name) && d.initializer
      && ts.isObjectLiteralExpression(semEmbrulho(d.initializer)) ? semEmbrulho(d.initializer) : null;
    if (!ehNamespace && !literal) return "raiz não é objeto literal novo nem namespace";
    if (vazaComoValor(sRaiz)) return "raiz vaza como valor (alias, argumento, retorno ou spread)";
    if (literal && m.thisVaza && !objetoPuro(literal)) return "this vaza no repositório e a raiz tem método com this";
    if (literal && !membrosProprios(sRaiz, literal)) return "raiz com membro herdado ou não declarado (receptor implícito)";
    if (literal && !thisSoProprios(literal)) return "raiz com método que lê membro herdado por this/super";
    for (let i = 0; i < elos.length; i++) {
      const nome = elos[i].name.text;
      if (m.nomesEscritos.has(nome) || mutavel(simbolo(elos[i].name))) return `elo ${nome} escrito`;
      if (i === elos.length - 1) break;
      if (m.nomesEscapados.has(nome) || m.nomesDinamicos.has(nome)) return `elo ${nome} vaza ou é mutado por índice`;
      // Elo intermediário: objeto literal declarado (propriedade de literal ou const exportada), só com membros próprios.
      const sElo = simbolo(elos[i].name);
      const de = sElo?.declarations ?? [];
      const dl = de.length === 1 && (ts.isPropertyAssignment(de[0]) || ts.isVariableDeclaration(de[0])) && de[0].initializer
        && ts.isObjectLiteralExpression(semEmbrulho(de[0].initializer)) ? semEmbrulho(de[0].initializer) : null;
      if (!dl) return `elo ${nome} não é objeto literal declarado`;
      const proprios = propriosDe(dl);
      if (!proprios || [...(m.membrosPorElo.get(nome) ?? [])].some((x) => !proprios.has(x))) return `elo ${nome} com membro herdado ou não declarado`;
      if (ts.isVariableDeclaration(de[0])) { // objeto de módulo alcançado pelo namespace: as mesmas regras da raiz
        if (mutavel(sElo) || vazaComoValor(sElo) || !membrosProprios(sElo, dl)) return `elo ${nome} mutado, com alias ou membro herdado no módulo`;
      }
      if (m.thisVaza && !objetoPuro(dl)) return `this vaza no repositório e o elo ${nome} tem método com this`;
      if (!thisSoProprios(dl)) return `elo ${nome} com método que lê membro herdado por this/super`;
    }
    return null;
  }
  /** Nomes próprios declarados num literal; null se há spread ou chave computada (conjunto desconhecido). */
  function propriosDe(literal) {
    const s = new Set();
    for (const p of literal.properties) {
      if (ts.isSpreadAssignment(p)) return null;
      const nome = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) || ts.isNumericLiteral(p.name)) ? p.name.text : null;
      if (nome === null) return null;
      s.add(nome);
    }
    return s;
  }
  /**
   * P2-R4-1: um literal com método que usa this/super (não puro) recebe a si mesmo como `this`. Todo `this.x`/`this["x"]`
   * do repositório tem de ser membro próprio dele, e `super.x` nunca é. Conservador: os acessos por this não são
   * atribuídos a um objeto específico.
   */
  function thisSoProprios(literal) {
    if (objetoPuro(literal)) return true;
    const proprios = propriosDe(literal);
    if (!proprios) return false;
    for (const x of mutacoes.membrosDeThis) if (!proprios.has(x)) return false;
    return true;
  }
  /** Todo `s.membro` (por qualquer nome local de s) lê um membro próprio do literal — nenhum herdado (P2-R3-1). */
  function membrosProprios(s, literal) {
    const m = mutacoes;
    const proprios = propriosDe(literal);
    if (!proprios) return false;
    vazaComoValor(s); // garante m.nomesPorAlvo
    for (const nome of new Set([s.name, ...(m.nomesPorAlvo?.get(s) ?? [])])) {
      for (const n of m.membrosPorBase.get(nome) ?? []) {
        const membro = ts.isPropertyAccessExpression(n) ? n.name.text : literalDeChave(n.argumentExpression);
        if (!proprios.has(membro) && simboloValor(n.expression) === s) return false;
      }
    }
    return true;
  }

  /** Declaração de função alcançada pelo callee (identificador, propriedade, require ou desestruturação de require). */
  function funcaoDoCallee(expr, prof = 0, permissivo = false) {
    if (prof > 4) return null;
    if (!permissivo && vinculoNaoProvado(expr)) return null; // vínculo não provado imutável: não resolve pelo inicializador (P2-1, P2-R2)
    const s = simbolo(ts.isPropertyAccessExpression(expr) ? expr.name : expr);
    const decls = [...(s?.declarations ?? [])].sort((a, b) => Number(!!b.body) - Number(!!a.body));
    for (const d of decls) {
      if (ehFuncao(d)) return d;
      if ((ts.isVariableDeclaration(d) || ts.isPropertyAssignment(d)) && d.initializer && ehFuncao(semEmbrulho(d.initializer))) return semEmbrulho(d.initializer);
      if ((ts.isVariableDeclaration(d) || ts.isPropertyAssignment(d)) && d.initializer && (ts.isIdentifier(d.initializer) || ts.isPropertyAccessExpression(d.initializer))) {
        const f = funcaoDoCallee(d.initializer, prof + 1, permissivo); if (f) return f;
      }
      if (ts.isShorthandPropertyAssignment(d)) { const f = funcaoDoCallee(d.name, prof + 1, permissivo); if (f) return f; }
      if (d.parent && ts.isBinaryExpression(d.parent) && ehFuncao(semEmbrulho(d.parent.right))) return semEmbrulho(d.parent.right);
    }
    return null;
  }
  /**
   * Callback de map/flatMap por identificador (P2-1 do Astra, delta do merge 03/11): só resolve quando o vínculo é
   * imutável — uma única declaração, `const` com identificador simples e inicializador que é a própria função literal.
   * Não seguir alias (`const a = b`), nem let/var (reatribuíveis), nem parâmetro, nem declaração de função (em JS
   * `function f` também é reatribuível). Fora disso devolve null e o SQL fica não resolvido (conservador).
   */
  function callbackImutavel(identificador) {
    const s = simbolo(identificador);
    const decls = s?.declarations ?? [];
    if (decls.length !== 1 || mutavel(s)) return null;
    const d = decls[0];
    if (!ts.isVariableDeclaration(d) || !ts.isIdentifier(d.name) || !d.initializer) return null;
    if (!ts.isVariableDeclarationList(d.parent) || (d.parent.flags & ts.NodeFlags.Const) === 0) return null;
    const f = semEmbrulho(d.initializer);
    return f && (ts.isArrowFunction(f) || ts.isFunctionExpression(f)) ? f : null;
  }
  function semEmbrulho(e) {
    while (e && (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(e)) || ts.isTypeAssertionExpression(e) || ts.isNonNullExpression(e) || ts.isAwaitExpression(e))) e = e.expression;
    if (e && ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.expression.getText() === "Object" && e.expression.name.text === "freeze") return semEmbrulho(e.arguments[0]);
    return e;
  }

  /**
   * Sinks derivados: Map<função, Map<chave, entrada>>. Entrada = { expr, pilha }: a expressão SQL original (argumento de
   * um sink base) e a pilha de chamadas [função, chamada] (de fora para dentro) que leva a ela. Num chamador da função,
   * a expressão é reavaliada com os parâmetros ligados aos argumentos daquela chamada (transitivo, entre módulos).
   */
  const sinks = new Map();
  const ehSinkBase = (call) => ts.isPropertyAccessExpression(call.expression) && ["query", "execute"].includes(call.expression.name.text);
  const ids = new WeakMap(); let proximoId = 0;
  const id = (n) => { if (!ids.has(n)) ids.set(n, ++proximoId); return ids.get(n); };
  function entradasDoSink(call) {
    const saida = [];
    if (ehSinkBase(call) && call.arguments[0]) saida.push({ funcao: null, entrada: { expr: call.arguments[0], pilha: [] } });
    const f = funcaoDoCallee(call.expression);
    if (f && sinks.has(f)) for (const entrada of sinks.get(f).values()) saida.push({ funcao: f, entrada });
    else if (!f) {
      // Vínculo não provado (P2-R2): se o alvo pelo inicializador é sink derivado, a chamada não some — vira não resolvida.
      const fp = funcaoDoCallee(call.expression, 0, true);
      // A origem é a própria chamada: a exceção de outra função (ex.: do aplicador) não absorve um vínculo não provado aqui.
      if (fp && sinks.has(fp)) saida.push({ funcao: null, entrada: { expr: call, pilha: [], naoProvado: vinculoNaoProvado(call.expression) } });
    }
    return saida;
  }
  function avaliarEntrada(call, funcao, entrada) {
    if (entrada.naoProvado) return NAO(`vínculo não provado: ${entrada.naoProvado}`);
    let amb = funcao ? ligar(funcao, call, null) : null;
    for (const [fk, ck] of entrada.pilha) amb = ligar(fk, ck, amb);
    return valorDe(alvo(REF(entrada.expr, amb)));
  }

  // ---- resolvedor: referências (nó + ambiente) e conjuntos de valores ----
  // Ref = { no, amb } | { val } (conjunto já resolvido) | { param: {funcao, indice, caminho} } | { nao } | { tupla: [Ref] }
  const REF = (no, amb) => ({ no, amb });

  /** Segue identificadores e embrulhos até o nó que define o valor (objeto, array, chamada, literal…). */
  function alvo(ref, prof = 0) {
    if (prof > PROF_MAX) return { nao: "profundidade" };
    if (!ref.no) return ref;
    const no = semEmbrulho(ref.no), amb = ref.amb;
    if (ts.isIdentifier(no)) {
      const s = simbolo(no);
      if (s && amb?.has(s)) return alvo(amb.get(s), prof + 1);
      const d = (s?.declarations ?? []).find((x) => ts.isVariableDeclaration(x) || ts.isParameter(x) || ts.isBindingElement(x) || ts.isPropertyAssignment(x) || ts.isShorthandPropertyAssignment(x) || ts.isEnumMember(x));
      if (!d) return { no, amb };
      if (ts.isParameter(d) && ehFuncao(d.parent)) {
        // Parâmetro sem ligação: vira parâmetro da função (sink derivado se chegar a um sink).
        if (ts.isIdentifier(d.name)) return { param: { funcao: d.parent, indice: d.parent.parameters.indexOf(d), caminho: [] } };
      }
      if (ts.isBindingElement(d)) return alvoDaDesestruturacao(d, amb, prof);
      if (ts.isVariableDeclaration(d)) {
        const lista = d.parent;
        if (lista && ts.isVariableDeclarationList(lista) && lista.parent && ts.isForOfStatement(lista.parent)) {
          const els = elementosDe(REF(lista.parent.expression, amb), prof + 1);
          return Array.isArray(els) ? { uniaoRefs: els } : els;
        }
        const constante = lista && ts.isVariableDeclarationList(lista) && (lista.flags & ts.NodeFlags.Const);
        if (!constante) {
          const atrib = atribuicoesDe(s, d.getSourceFile());
          if (atrib === null) return { nao: `variável ${no.text} reatribuída de forma não resolvível` };
          if (atrib.length) return { uniaoRefs: [...(d.initializer ? [REF(d.initializer, amb)] : []), ...atrib.map((a) => REF(a, amb))] };
        }
        if (!d.initializer) return { no, amb };
        return alvo(REF(d.initializer, amb), prof + 1);
      }
      if (ts.isPropertyAssignment(d)) return alvo(REF(d.initializer, amb), prof + 1);
      if (ts.isShorthandPropertyAssignment(d)) return alvo(REF(d.name, amb), prof + 1);
      if (ts.isEnumMember(d) && d.initializer) return alvo(REF(d.initializer, amb), prof + 1);
      return { no, amb };
    }
    if (ts.isPropertyAccessExpression(no)) {
      const base = alvo(REF(no.expression, amb), prof + 1);
      const p = propriedade(base, no.name.text, prof + 1);
      if (p) return p.no ? alvo(p, prof + 1) : p;
    }
    if (ts.isElementAccessExpression(no)) {
      const chave = resolver(no.argumentExpression, amb, prof + 1);
      const base = alvo(REF(no.expression, amb), prof + 1);
      if (ok(chave) && chave.v.length === 1) {
        const p = propriedade(base, chave.v[0], prof + 1);
        if (p) return p.no ? alvo(p, prof + 1) : p;
      }
      // Chave com vários valores ou não resolvida, sobre objeto literal: qualquer valor do objeto (superconjunto).
      const obj = base.no && semEmbrulho(base.no);
      if (obj && ts.isObjectLiteralExpression(obj) && obj.properties.every((x) => ts.isPropertyAssignment(x) || ts.isShorthandPropertyAssignment(x)))
        return { uniaoRefs: obj.properties.map((x) => (ts.isPropertyAssignment(x) ? REF(x.initializer, base.amb) : REF(x.name, base.amb))) };
    }
    return { no, amb };
  }

  /** Desestruturação (const {a} = x / const [a] = x / parâmetro {a} / callback ([a, b]) / for (const {a} of x)). */
  function alvoDaDesestruturacao(be, amb, prof) {
    const caminho = [];
    let n = be;
    while (ts.isBindingElement(n)) {
      const padrao = n.parent;
      if (ts.isObjectBindingPattern(padrao)) caminho.unshift((n.propertyName ?? n.name).getText());
      else caminho.unshift(String(padrao.elements.indexOf(n)));
      n = padrao.parent;
    }
    let base;
    if (ts.isParameter(n) && ehFuncao(n.parent)) {
      if (amb?.has(n)) base = amb.get(n);
      else return { param: { funcao: n.parent, indice: n.parent.parameters.indexOf(n), caminho } };
    } else if (ts.isVariableDeclaration(n)) {
      const lista = n.parent;
      if (lista && lista.parent && ts.isForOfStatement(lista.parent)) {
        const els = elementosDe(REF(lista.parent.expression, amb), prof + 1);
        if (!Array.isArray(els)) return els;
        return { uniaoRefs: els.map((e) => seguir(alvo(e, prof + 1), caminho, prof)) };
      }
      if (!n.initializer) return { nao: "desestruturação sem valor" };
      base = REF(n.initializer, amb);
    } else return { nao: "desestruturação" };
    return seguir(alvo(base, prof + 1), caminho, prof);
  }

  function seguir(ref, caminho, prof) {
    let r = ref;
    for (const k of caminho) {
      if (r.param) { r = { param: { ...r.param, caminho: [...r.param.caminho, k] } }; continue; }
      const p = propriedade(r, k, prof + 1);
      if (!p) return { nao: `propriedade ${k}` };
      r = p.no ? alvo(p, prof + 1) : p;
    }
    return r;
  }

  /** Propriedade (ou índice de tupla) de um alvo. */
  function propriedade(base, chave, prof = 0) {
    if (prof > PROF_MAX) return { nao: "profundidade" };
    if (base.param) return { param: { ...base.param, caminho: [...base.param.caminho, chave] } };
    if (base.nao) return base;
    if (base.uniaoRefs) return { uniaoRefs: base.uniaoRefs.map((r) => propriedade(alvo(r, prof + 1), chave, prof + 1) ?? { nao: `propriedade ${chave}` }) };
    if (base.tupla) return base.tupla[Number(chave)] ?? { nao: `índice ${chave}` };
    if (base.val) return null;
    const no = semEmbrulho(base.no), amb = base.amb;
    if (ts.isObjectLiteralExpression(no)) {
      for (let i = no.properties.length - 1; i >= 0; i--) {
        const x = no.properties[i];
        if (ts.isSpreadAssignment(x)) { const p = propriedade(alvo(REF(x.expression, amb), prof + 1), chave, prof + 1); if (p && !p.nao) return p; continue; }
        const nome = x.name && (ts.isIdentifier(x.name) || ts.isStringLiteral(x.name) || ts.isNumericLiteral(x.name) ? x.name.text : null);
        if (nome !== chave) continue;
        if (ts.isPropertyAssignment(x)) return REF(x.initializer, amb);
        if (ts.isShorthandPropertyAssignment(x)) return REF(x.name, amb);
        if (ts.isMethodDeclaration(x)) return { nao: "método" };
      }
      return null;
    }
    if (ts.isArrayLiteralExpression(no) && /^\d+$/.test(chave)) {
      const e = no.elements[Number(chave)];
      return e && !ts.isSpreadElement(e) ? REF(e, amb) : { nao: `índice ${chave}` };
    }
    if (ts.isCallExpression(no) && ts.isPropertyAccessExpression(no.expression) && ["find", "at", "findLast"].includes(no.expression.name.text)) {
      const els = elementosDe(REF(no.expression.expression, amb), prof + 1);
      if (!Array.isArray(els)) return els;
      return { uniaoRefs: els.map((e) => propriedade(alvo(e, prof + 1), chave, prof + 1) ?? { nao: `propriedade ${chave}` }) };
    }
    if (ts.isCallExpression(no) && ts.isPropertyAccessExpression(no.expression) && no.expression.name.text === "get") {
      // new Map(pares).get(k): o valor de qualquer par.
      const m = alvo(REF(no.expression.expression, amb), prof + 1);
      const valores = valoresDoMapa(m, prof + 1);
      if (!Array.isArray(valores)) return valores;
      return { uniaoRefs: valores.map((v) => propriedade(alvo(v, prof + 1), chave, prof + 1) ?? { nao: `propriedade ${chave}` }) };
    }
    if (ts.isCallExpression(no)) {
      const f = funcaoDoCallee(no.expression);
      if (f) {
        const ret = retornoRefs(f, ligar(f, no, amb), prof + 1);
        if (!Array.isArray(ret)) return ret;
        const objetos = ret.filter((r) => !(r.no && (semEmbrulho(r.no).kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(semEmbrulho(r.no)) && semEmbrulho(r.no).text === "undefined"))));
        return { uniaoRefs: objetos.map((r) => propriedade(alvo(r, prof + 1), chave, prof + 1) ?? { nao: `propriedade ${chave}` }) };
      }
    }
    return null;
  }

  function valoresDoMapa(m, prof) {
    if (m.no && ts.isNewExpression(semEmbrulho(m.no)) && semEmbrulho(m.no).expression.getText() === "Map") {
      const arg = semEmbrulho(m.no).arguments?.[0];
      if (!arg) return [];
      const els = elementosDe(REF(arg, m.amb), prof + 1);
      if (!Array.isArray(els)) return els;
      return els.map((e) => propriedade(alvo(e, prof + 1), "1", prof + 1) ?? { nao: "par do Map" });
    }
    return { nao: "Map não resolvido" };
  }

  /** Ambiente para avaliar `f` chamada em `call`: cada parâmetro ligado ao argumento (referência no ambiente do chamador). */
  function ligar(f, call, amb) {
    const a2 = new Map(amb ?? []);
    f.parameters.forEach((p, i) => {
      const arg = call.arguments[i];
      const ref = arg ? (ts.isSpreadElement(arg) ? { nao: "spread" } : REF(arg, amb)) : p.initializer ? REF(p.initializer, amb) : { val: VAL([""]) };
      if (ts.isIdentifier(p.name)) a2.set(simboloDe(p.name), ref);
      else a2.set(p, ref); // parâmetro desestruturado: ligado pelo próprio nó
    });
    return a2;
  }
  /** Ligação dos parâmetros de um callback (map, replace…) a referências dadas. */
  function ligarCallback(cb, refs, amb) {
    const a2 = new Map(amb ?? []);
    cb.parameters.forEach((p, i) => {
      const ref = refs[i] ?? { val: VAL([""]) };
      if (ts.isIdentifier(p.name)) a2.set(simboloDe(p.name), ref);
      else a2.set(p, ref);
    });
    return a2;
  }

  /** Expressões de retorno de uma função, como referências no ambiente dado. */
  function retornoRefs(f, amb) {
    if (!f.body) return { nao: "função sem corpo" };
    if (!ts.isBlock(f.body)) return [REF(f.body, amb)];
    const saida = [];
    (function visitar(n) {
      if (n !== f && ehFuncao(n)) return;
      if (ts.isReturnStatement(n)) saida.push(n.expression ? REF(n.expression, amb) : { val: VAL([""]) });
      ts.forEachChild(n, visitar);
    })(f.body);
    return saida.length ? saida : { nao: `função ${nomeDaFuncao(f)} sem return` };
  }

  /** Elementos (referências) de um array: literal, spread, push/unshift/atribuição indexada, map/flatMap/filter/…, Object.entries/keys/values. */
  function elementosDe(ref, prof = 0) {
    if (prof > PROF_MAX) return { nao: "profundidade" };
    const variavel = ref.no && ts.isIdentifier(semEmbrulho(ref.no)) ? variavelDeArray(semEmbrulho(ref.no), ref.amb) : null;
    if (variavel) return elementosDaVariavel(variavel, ref.amb, prof);
    const a = alvo(ref, prof + 1);
    if (a.nao) return a;
    if (a.param) return { param: a.param };
    if (a.val) return a.val.v.map((x) => ({ val: VAL([x]) }));
    if (a.tupla) return a.tupla;
    if (a.uniaoRefs) { const out = []; for (const r of a.uniaoRefs) { const e = elementosDe(r, prof + 1); if (!Array.isArray(e)) return e; out.push(...e); } return out; }
    const no = semEmbrulho(a.no), amb = a.amb;
    if (ts.isConditionalExpression(no) || (ts.isBinaryExpression(no) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(no.operatorToken.kind))) {
      const out = [];
      for (const ramo of ts.isConditionalExpression(no) ? [no.whenTrue, no.whenFalse] : [no.left, no.right]) {
        const e = elementosDe(REF(ramo, amb), prof + 1); if (!Array.isArray(e)) return e; out.push(...e);
      }
      return out;
    }
    if (ts.isArrayLiteralExpression(no)) {
      const out = [];
      for (const e of no.elements) {
        if (ts.isSpreadElement(e)) { const x = elementosDe(REF(e.expression, amb), prof + 1); if (!Array.isArray(x)) return x; out.push(...x); }
        else out.push(REF(e, amb));
      }
      return out;
    }
    if (ts.isCallExpression(no) && ts.isPropertyAccessExpression(no.expression)) {
      const m = no.expression.name.text, base = no.expression.expression;
      if (["filter", "slice", "reverse", "sort", "toSorted", "toReversed", "concat"].includes(m)) {
        const els = elementosDe(REF(base, amb), prof + 1);
        if (!Array.isArray(els)) return els;
        if (m === "concat") for (const x of no.arguments) { const e = elementosDe(REF(x, amb), prof + 1); if (Array.isArray(e)) els.push(...e); else els.push(REF(x, amb)); }
        return els;
      }
      if (m === "map" || m === "flatMap") {
        const els = elementosDe(REF(base, amb), prof + 1);
        if (!Array.isArray(els)) return els;
        // Merge com staging 03/11 (cliente PJ, colunasCliente): callback também pode ser um identificador, mas só com
        // vínculo imutável (callbackImutavel: `const nome = <função literal>`). Reatribuição, alias, let/var, parâmetro
        // ou declaração de função seguem não resolvidos (P2-1 do Astra no delta do merge).
        const arg = semEmbrulho(no.arguments[0]);
        const cb = arg && (ehFuncao(arg) ? arg : ts.isIdentifier(arg) ? callbackImutavel(arg) : null);
        if (!cb || !ehFuncao(cb)) return { nao: "map sem função literal" };
        const out = [];
        els.forEach((e) => {
          const ret = retornoRefs(cb, ligarCallback(cb, [e, { val: VAL(["0"]) }], amb), prof + 1);
          if (!Array.isArray(ret)) { out.push(ret); return; }
          for (const r of ret) {
            if (m === "flatMap") { const x = elementosDe(r, prof + 1); if (Array.isArray(x)) out.push(...x); else out.push(r); } else out.push(r);
          }
        });
        return out;
      }
      if (m === "split" && no.arguments.length >= 1) {
        const texto = resolver(base, amb, prof + 1), sep = resolver(no.arguments[0], amb, prof + 1);
        if (!ok(texto)) return falha(texto);
        if (!ok(sep) || sep.v.length !== 1) return { nao: "split com separador não resolvido" };
        return texto.v.flatMap((t) => t.split(sep.v[0])).map((x) => ({ val: VAL([x]) }));
      }
      if (base.getText() === "Array" && m === "from" && no.arguments.length === 2 && ehFuncao(semEmbrulho(no.arguments[1]))) {
        const cb = semEmbrulho(no.arguments[1]);
        const ret = retornoRefs(cb, ligarCallback(cb, [{ val: VAL([""]) }, { val: VAL(["0"]) }], amb), prof + 1);
        return Array.isArray(ret) ? ret : ret;
      }
      if (base.getText() === "Object" && ["entries", "keys", "values"].includes(m)) {
        const alvoObj = alvo(REF(no.arguments[0], amb), prof + 1);
        if (alvoObj.param) return { param: alvoObj.param };
        const obj = semEmbrulho(alvoObj.no ?? no);
        if (!ts.isObjectLiteralExpression(obj)) return { nao: `Object.${m}` };
        const out = [];
        for (const x of obj.properties) {
          if (!ts.isPropertyAssignment(x) && !ts.isShorthandPropertyAssignment(x)) return { nao: `Object.${m} com spread` };
          const k = { val: VAL([x.name.getText().replace(/^["']|["']$/g, "")]) };
          const v = ts.isPropertyAssignment(x) ? REF(x.initializer, amb) : REF(x.name, amb);
          out.push(m === "entries" ? { tupla: [k, v] } : m === "keys" ? k : v);
        }
        return out;
      }
    }
    if (ts.isCallExpression(no)) {
      const f = funcaoDoCallee(no.expression);
      if (f) { const ret = retornoRefs(f, ligar(f, no, amb), prof + 1); if (!Array.isArray(ret)) return ret; const out = []; for (const r of ret) { const e = elementosDe(r, prof + 1); if (!Array.isArray(e)) return e; out.push(...e); } return out; }
    }
    const t = tipoLiteral(no);
    if (t) return t.v.map((x) => ({ val: VAL([x]) }));
    return { nao: `array ${ts.SyntaxKind[no.kind]}` };
  }

  /** Variável (const/let local, não ligada no ambiente, fora de for-of) que nomeia um array. */
  function variavelDeArray(id, amb) {
    const s = simbolo(id);
    if (!s || amb?.has(s)) return null;
    const d = (s.declarations ?? []).find((x) => ts.isVariableDeclaration(x));
    if (!d || !ts.isIdentifier(d.name) || (d.parent?.parent && ts.isForOfStatement(d.parent.parent))) return null;
    return { s, d };
  }
  /**
   * Elementos de uma variável array: inicializador e atribuições (let), mais push/unshift/atribuição indexada sobre ELA
   * no arquivo. Passar a variável como argumento de outra função (que poderia alterá-la) ou splice/fill = não resolvido.
   */
  function elementosDaVariavel({ s, d }, amb, prof) {
    const out = [];
    const fontes = [];
    if (d.initializer) fontes.push(d.initializer);
    const constante = d.parent && ts.isVariableDeclarationList(d.parent) && (d.parent.flags & ts.NodeFlags.Const);
    if (!constante) { const atrib = atribuicoesDe(s, d.getSourceFile()); if (atrib === null) return { nao: "array reatribuído de forma não resolvível" }; fontes.push(...atrib); }
    for (const fonte of fontes) { const e = elementosDe(REF(fonte, amb), prof + 1); if (!Array.isArray(e)) return e; out.push(...e); }
    let invalida = null;
    (function visitar(n) {
      if (ts.isIdentifier(n) && n !== d.name && simbolo(n) === s) {
        const p = n.parent;
        if (ts.isPropertyAccessExpression(p) && p.expression === n && ts.isCallExpression(p.parent) && p.parent.expression === p) {
          const m = p.name.text;
          if (m === "push" || m === "unshift") for (const x of p.parent.arguments) out.push(ts.isSpreadElement(x) ? { nao: "push com spread" } : REF(x, amb));
          else if (["splice", "fill", "copyWithin", "pop", "shift"].includes(m)) invalida = { nao: `array alterado por ${m}` };
        } else if (ts.isElementAccessExpression(p) && p.expression === n && ts.isBinaryExpression(p.parent) && p.parent.left === p) out.push(REF(p.parent.right, amb));
        else if (ts.isCallExpression(p) && p.arguments.includes(n)) invalida = { nao: `array ${n.text} passado a ${p.expression.getText().slice(0, 40)}` };
      }
      ts.forEachChild(n, visitar);
    })(d.getSourceFile());
    return invalida ?? out;
  }

  /** Valor (conjunto de textos) de uma referência. */
  function valorDe(ref, prof = 0) {
    if (prof > PROF_MAX) return NAO("profundidade");
    if (ref.val) return ref.val;
    if (ref.nao) return NAO(ref.nao);
    if (ref.param) return { param: ref.param };
    if (ref.uniaoRefs) return uniao(ref.uniaoRefs.map((r) => valorDe(r, prof + 1)));
    if (ref.tupla) return NAO("tupla como texto");
    return resolver(ref.no, ref.amb, prof + 1);
  }

  function resolver(expr, amb, prof = 0) {
    if (!expr) return NAO("vazio");
    if (prof > PROF_MAX) return NAO("profundidade");
    const r = (e) => resolver(e, amb, prof + 1);
    expr = semEmbrulho(expr);
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr) || ts.isNumericLiteral(expr)) return VAL([expr.text]);
    if (ts.isTemplateExpression(expr)) {
      let acc = VAL([expr.head.text]);
      for (const span of expr.templateSpans) {
        acc = produto(produto(acc, r(span.expression)), VAL([span.literal.text]));
      }
      return acc;
    }
    if (ts.isBinaryExpression(expr)) {
      const op = expr.operatorToken.kind;
      if (op === ts.SyntaxKind.PlusToken) {
        const t = tipoSimples(expr); if (t) return t;
        return produto(r(expr.left), r(expr.right));
      }
      if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) {
        return uniao([r(expr.left), r(expr.right)]);
      }
      const t = tipoSimples(expr); if (t) return t;
      return NAO(`operador ${ts.tokenToString(op)}`);
    }
    if (ts.isConditionalExpression(expr)) return uniao([r(expr.whenTrue), r(expr.whenFalse)]);
    if (ts.isCallExpression(expr)) return resolverChamada(expr, amb, prof);
    if (ts.isIdentifier(expr) && expr.text === "undefined") return VAL([""]);
    if (ts.isIdentifier(expr) && expr.text === "__dirname") return VAL([path.dirname(expr.getSourceFile().fileName)]);
    if (ts.isIdentifier(expr) && expr.text === "__filename") return VAL([expr.getSourceFile().fileName]);
    if (ts.isIdentifier(expr) || ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
      const a = alvo(REF(expr, amb), prof + 1);
      if (a.param) return { param: a.param };
      if (a.val) return a.val;
      if (a.uniaoRefs) return valorDe(a, prof + 1);
      if (a.nao) return tipoSimples(expr) ?? NAO(a.nao);
      if (a.no && a.no !== semEmbrulho(expr)) return resolver(a.no, a.amb, prof + 1);
      return tipoSimples(expr) ?? NAO(`${ts.isIdentifier(expr) ? "identificador" : "propriedade"} ${expr.getText().slice(0, 60)}`);
    }
    const t = tipoSimples(expr);
    if (t) return t;
    return NAO(`expressão ${ts.SyntaxKind[expr.kind]}`);
  }

  /** Tipo do checker: literal ou união de literais de string. */
  function tipoLiteral(expr) {
    let t;
    try { t = checker.getTypeAtLocation(expr); } catch { return null; }
    const partes = t.isUnion() ? t.types : [t];
    if (partes.length > LIMITE_VALORES) return null;
    if (partes.length && partes.every((p) => p.isStringLiteral())) return VAL(partes.map((p) => p.value));
    return null;
  }
  /** Números, booleanos, bigint, null e undefined não carregam texto SQL: representante "0". */
  function tipoSimples(expr) {
    let t;
    try { t = checker.getTypeAtLocation(expr); } catch { return null; }
    const partes = t.isUnion() ? t.types : [t];
    const F = ts.TypeFlags;
    if (partes.length && partes.every((p) => p.flags & (F.NumberLike | F.BooleanLike | F.BigIntLike | F.Null | F.Undefined | F.Void))) return VAL(["0"]);
    return tipoLiteral(expr);
  }

  /** Atribuições `x = …` a uma variável `let`/`var` no arquivo; null se houver atribuição composta. */
  function atribuicoesDe(s, sf) {
    const saida = [];
    let invalida = false;
    (function visitar(n) {
      if (ts.isBinaryExpression(n) && ts.isIdentifier(n.left) && simbolo(n.left) === s) {
        if (n.operatorToken.kind === ts.SyntaxKind.EqualsToken) saida.push(n.right);
        else if (n.operatorToken.kind >= ts.SyntaxKind.FirstCompoundAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastCompoundAssignment) invalida = true;
      }
      ts.forEachChild(n, visitar);
    })(sf);
    if (invalida) return null;
    mutacoes ??= coletarMutacoes();
    if (mutacoes.total || (mutacoes.atribuidos.get(s) ?? 0) > saida.length) return null; // P2-R2-1: outra forma de escrita
    return saida;
  }

  const PATH = { join: (...a) => path.join(...a), resolve: (...a) => path.resolve(raiz, ...a), normalize: (a) => path.normalize(a), dirname: (a) => path.dirname(a), basename: (...a) => path.basename(...a) };

  function resolverChamada(call, amb, prof) {
    const e = call.expression;
    const args = () => call.arguments.map((a) => resolver(a, amb, prof + 1));
    if (ts.isPropertyAccessExpression(e)) {
      const m = e.name.text, base = e.expression;
      if (m === "join" && !(ts.isIdentifier(base) && base.text === "path")) {
        const els = elementosDe(REF(base, amb), prof + 1);
        if (!Array.isArray(els)) return falha(els);
        const sep = call.arguments[0] ? resolver(call.arguments[0], amb, prof + 1) : VAL([","]);
        if (!ok(sep)) return sep;
        const vs = els.map((x) => valorDe(x, prof + 1));
        for (const x of vs) if (!ok(x)) return x;
        // Superconjunto (sem ordem de fluxo): todos os elementos possíveis, unidos pelo separador.
        return VAL([vs.map((x) => (x.v.length === 1 ? x.v[0] : x.v.join(" "))).join(sep.v[0] ?? ",")], vs.some((x) => x.v.length > 1 || x.aproximado));
      }
      if (ts.isIdentifier(base) && base.text === "path" && PATH[m]) {
        const a = args(); for (const x of a) if (!ok(x) || x.v.length !== 1) return ok(x) ? NAO("caminho com vários valores") : x;
        return VAL([PATH[m](...a.map((x) => x.v[0]))]);
      }
      if (ts.isIdentifier(base) && base.text === "process" && m === "cwd") return VAL([raiz]);
      if (m === "readFileSync" || (m === "readFile" && ts.isAwaitExpression(call.parent))) return lerArquivo(call, amb, prof);
      const textual = { toLowerCase: (s) => s.toLowerCase(), toUpperCase: (s) => s.toUpperCase(), trim: (s) => s.trim(), trimStart: (s) => s.trimStart(), trimEnd: (s) => s.trimEnd(), toString: (s) => s, normalize: (s) => s };
      if (textual[m] && call.arguments.length === 0) {
        const b = resolver(base, amb, prof + 1);
        return ok(b) ? VAL(b.v.map(textual[m]), b.aproximado) : b;
      }
      if ((m === "replace" || m === "replaceAll") && call.arguments.length === 2) {
        const b = resolver(base, amb, prof + 1);
        if (!ok(b)) return b;
        const [padrao, troca] = call.arguments;
        let re = null;
        if (ts.isRegularExpressionLiteral(padrao)) { const m2 = /^\/(.*)\/([a-z]*)$/s.exec(padrao.text); re = new RegExp(m2[1], m2[2]); }
        else { const p = resolver(padrao, amb, prof + 1); if (ok(p) && p.v.length === 1) re = p.v[0]; }
        if (re === null) return NAO("replace com padrão não resolvido");
        const cb = semEmbrulho(troca);
        if (ehFuncao(cb)) {
          const saida = [];
          for (const s of b.v) {
            let falha = null;
            saida.push(s[m](re, (...xs) => {
              const v = uniaoDeRefs(retornoRefs(cb, ligarCallback(cb, xs.map((x) => ({ val: VAL([String(x ?? "")]) })), amb), prof + 1), prof);
              if (!ok(v) || v.v.length !== 1) { falha = v; return ""; }
              return v.v[0];
            }));
            if (falha) return ok(falha) ? NAO("replace com troca de vários valores") : falha;
          }
          return VAL(saida, b.aproximado);
        }
        const t = resolver(troca, amb, prof + 1);
        if (!ok(t) || t.v.length !== 1) return ok(t) ? NAO("replace com troca de vários valores") : t;
        return VAL(b.v.map((s) => s[m](re, t.v[0])), b.aproximado);
      }
      if (["slice", "substring", "padStart", "padEnd", "repeat"].includes(m)) {
        const b = resolver(base, amb, prof + 1);
        if (!ok(b)) return b;
        const a = args(); for (const x of a) if (!ok(x) || x.v.length !== 1) return NAO(`${m} com argumento não resolvido`);
        // Os argumentos numéricos podem ter vindo do representante "0": o recorte é aproximado; o texto inteiro é o superconjunto.
        return m === "repeat" || m === "padStart" || m === "padEnd" ? VAL(b.v, b.aproximado) : VAL(b.v, true);
      }
      if (["find", "at", "findLast"].includes(m)) { const els = elementosDe(REF(base, amb), prof + 1); return Array.isArray(els) ? uniaoDeRefs(els, prof) : falha(els); }
      if (m === "get") { const mapa = valoresDoMapa(alvo(REF(base, amb), prof + 1), prof + 1); return Array.isArray(mapa) ? uniaoDeRefs(mapa, prof) : falha(mapa); }
    }
    if (ts.isIdentifier(e) && e.text === "String" && call.arguments.length === 1) return resolver(call.arguments[0], amb, prof + 1);
    if (ts.isIdentifier(e) && e.text === "readFileSync") return lerArquivo(call, amb, prof);
    const t = tipoLiteral(call); if (t) return t;
    const f = funcaoDoCallee(e);
    if (f && f.body && prof < PROF_MAX - 4) {
      const ret = retornoRefs(f, ligar(f, call, amb), prof + 1);
      const v = Array.isArray(ret) ? uniaoDeRefs(ret, prof) : NAO(ret.nao);
      if (ok(v) || v.param) return v;
      return tipoSimples(call) ?? NAO(`retorno de ${nomeDaFuncao(f)}: ${v.nao}`);
    }
    return tipoSimples(call) ?? NAO(`chamada ${e.getText().slice(0, 60)}`);
  }
  const falha = (x) => (x.param ? { param: x.param } : NAO(x.nao ?? "não resolvido"));
  function uniaoDeRefs(refs, prof) {
    return uniao(refs.map((x) => valorDe(x, prof + 1)));
  }
  /** readFileSync de caminho resolvido dentro do repositório: o valor é o conteúdo real do arquivo. */
  function lerArquivo(call, amb, prof) {
    const p = resolver(call.arguments[0], amb, prof + 1);
    if (p.param) return p;
    if (!ok(p)) return NAO(`readFileSync de caminho não resolvido (${p.nao})`);
    const conteudos = [];
    for (const c of p.v) {
      const abs = path.isAbsolute(c) ? c : path.resolve(raiz, c);
      if (!abs.startsWith(raiz) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return NAO(`readFileSync de arquivo fora do repositório ou ausente: ${path.relative(raiz, abs)}`);
      conteudos.push(fs.readFileSync(abs, "utf8"));
    }
    return VAL(conteudos, p.aproximado);
  }

  // ---- todas as chamadas, uma vez ----
  const chamadas = [];
  const sinkComoValor = [];
  for (const sf of nossos) {
    (function visitar(n) {
      if (ts.isCallExpression(n)) chamadas.push(n);
      else if (ts.isPropertyAccessExpression(n) && ["query", "execute"].includes(n.name.text) && !(ts.isCallExpression(n.parent) && n.parent.expression === n)) {
        // `.query` usado como valor (bind, callback, atribuição): o sink sairia da análise.
        const p = n.parent;
        if (!(ts.isBinaryExpression(p) && p.left === n) && !ts.isPropertyAccessExpression(p) && !ts.isTypeOfExpression(p)) sinkComoValor.push(n);
      }
      ts.forEachChild(n, visitar);
    })(sf);
  }

  // ---- ponto fixo dos sinks ----
  const resolucoes = new Map(); // call → [{r, origem}]
  const chamadas_ = new Set(); // sinks derivados com ao menos um ponto de chamada avaliado
  const feitas = new Set();
  let mudou = true, voltas = 0;
  while (mudou && voltas++ < 30) {
    mudou = false;
    for (const call of chamadas) {
      for (const { funcao, entrada } of entradasDoSink(call)) {
        const chaveAval = id(call) + "|" + id(entrada.expr) + "|" + entrada.pilha.map(([, c]) => id(c)).join(",");
        if (feitas.has(chaveAval)) continue;
        feitas.add(chaveAval);
        if (funcao) chamadas_.add(funcao);
        const r = avaliarEntrada(call, funcao, entrada);
        const lista = resolucoes.get(call) ?? [];
        lista.push({ r, origem: entrada.expr });
        resolucoes.set(call, lista);
        if (r.param && entrada.pilha.length < 8) {
          const pilha = funcao ? [[funcao, call], ...entrada.pilha] : entrada.pilha;
          const chave = id(entrada.expr) + "|" + pilha.map(([, c]) => id(c)).join(",");
          const atual = sinks.get(r.param.funcao) ?? new Map();
          if (!atual.has(chave)) { atual.set(chave, { expr: entrada.expr, pilha }); sinks.set(r.param.funcao, atual); mudou = true; }
        }
      }
    }
  }


  // Exceção por arquivo (`funcao: "*"`, decisão de Felipe em 01/11/2026) só vale em scripts/; a por função tem precedência.
  for (const x of excecoes) if (x.funcao === "*" && !/^scripts\//.test(x.arquivo)) throw new Error(`exceção por arquivo fora de scripts/: ${x.arquivo}`);
  const excecaoDe = (arquivo, funcao) => excecoes.find((x) => x.arquivo === arquivo && x.funcao === funcao) ??
    excecoes.find((x) => x.arquivo === arquivo && x.funcao === "*");
  const chamadoresDaExcecao = new Map();

  const escritas = [], naoResolvidos = [], excecoesUsadas = new Set();
  for (const [call, lista] of resolucoes) {
    const f = funcaoQueContem(call);
    const onde = { ...local(call), funcao: nomeDaFuncao(f) };
    const teste = ARQUIVO_DE_TESTE.test(onde.arquivo);
    const callee = funcaoDoCallee(call.expression);
    const viaEscreverSalao = !!callee && nomeDaFuncao(callee) === "escreverSalao" && /lib\/agenda\/escrever-salao\.ts$/.test(relativo(callee.getSourceFile()));
    for (const { r, origem } of lista) {
      if (r.param) continue; // a resolução acontece nos chamadores da função dona do parâmetro (sink derivado)
      if (r.nao) {
        const lo = local(origem), funcaoOrigem = nomeDaFuncao(funcaoQueContem(origem));
        const ex = excecaoDe(lo.arquivo, funcaoOrigem);
        if (ex) {
          excecoesUsadas.add(ex);
          const lista2 = chamadoresDaExcecao.get(ex) ?? new Set();
          lista2.add(onde.arquivo + ":" + onde.linha + " " + onde.funcao);
          chamadoresDaExcecao.set(ex, lista2);
          continue;
        }
        naoResolvidos.push({ ...onde, teste, sink: call.expression.getText().slice(0, 80), origem: lo.arquivo + ":" + lo.linha, arquivoOrigem: lo.arquivo, funcaoOrigem, motivo: r.nao });
        continue;
      }
      const achadas = r.v.flatMap((sql) => escritasDeSalao(sql));
      if (!achadas.length) continue;
      let escritor = null;
      if (viaEscreverSalao) {
        const marca = semEmbrulho(call.arguments[1]);
        const p = marca && ts.isObjectLiteralExpression(marca) && marca.properties.find((x) => ts.isPropertyAssignment(x) && x.name.getText() === "escritor");
        escritor = p && (ts.isStringLiteral(p.initializer) ? p.initializer.text : null);
      }
      const tabelas = [...new Set(achadas.map((a) => `${a.tabela}:${a.operacao}`))].sort();
      escritas.push({ ...onde, teste, via: viaEscreverSalao ? "escreverSalao" : call.expression.getText().slice(0, 60), escritor, tabelas, aproximado: !!r.aproximado });
    }
  }

  /** Implementação de executor (`query`/`execute` como método ou propriedade): o SQL vem dos `x.query(...)`, já sinks base. */
  const ehExecutor = (fn) => {
    if (ts.isMethodDeclaration(fn)) return ["query", "execute"].includes(fn.name?.getText());
    let p = fn.parent;
    while (p && (ts.isAsExpression(p) || ts.isParenthesizedExpression(p) || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(p)))) p = p.parent;
    return !!p && ts.isPropertyAssignment(p) && ["query", "execute"].includes(p.name.getText());
  };
  for (const [fn, entradas] of sinks) {
    if (chamadas_.has(fn) || ehExecutor(fn)) continue;
    for (const entrada of entradas.values()) {
      const lo = local(entrada.expr), funcaoOrigem = nomeDaFuncao(funcaoQueContem(entrada.expr));
      const onde = { ...local(fn), funcao: nomeDaFuncao(fn) };
      const ex = excecaoDe(lo.arquivo, funcaoOrigem);
      if (ex) { excecoesUsadas.add(ex); const l = chamadoresDaExcecao.get(ex) ?? new Set(); l.add(onde.arquivo + ":" + onde.linha + " " + onde.funcao + " (sem chamador)"); chamadoresDaExcecao.set(ex, l); continue; }
      naoResolvidos.push({ ...onde, teste: ARQUIVO_DE_TESTE.test(onde.arquivo), sink: "(sem chamador)", origem: lo.arquivo + ":" + lo.linha, arquivoOrigem: lo.arquivo, funcaoOrigem,
        motivo: "SQL depende de parâmetro de função sem chamador no repositório" });
    }
  }

  const derivados = [...sinks].map(([f, m]) => ({ ...local(f), funcao: nomeDaFuncao(f), entradas: m.size }));
  const comoValor = sinkComoValor.map((n) => ({ ...local(n), funcao: nomeDaFuncao(funcaoQueContem(n)), teste: ARQUIVO_DE_TESTE.test(local(n).arquivo), texto: n.parent.getText().slice(0, 80) }));

  const sql = [];
  for (const arquivo of arquivosSql(raiz)) {
    const achadas = escritasEmSql(fs.readFileSync(arquivo, "utf8"));
    if (achadas.length) sql.push({ arquivo: path.relative(raiz, arquivo).replace(/\\/g, "/"), escritas: achadas.map((a) => `${a.tabela}:${a.operacao}`) });
  }

  const excecoesAplicadas = excecoes.filter((x) => excecoesUsadas.has(x)).map((x) => ({ ...x, chamadores: [...chamadoresDaExcecao.get(x)].sort() }));
  return { arquivos: nossos.length, escritas, naoResolvidos, derivados, comoValor, sql, excecoesAplicadas, excecoesNaoUsadas: excecoes.filter((x) => !excecoesUsadas.has(x)) };
}

module.exports = { analisar, escritasDeSalao, escritasEmSql, limparSql, arquivosDoRepositorio, ARQUIVO_DE_TESTE };

if (require.main === module) {
  const inicio = Date.now();
  const r = analisar({ raiz: path.resolve(__dirname, ".."), excecoes: require("./guarda-salao-excecoes.cjs").EXCECOES });
  const destino = process.argv[2];
  if (destino) fs.writeFileSync(destino, JSON.stringify(r, null, 1));
  console.log(JSON.stringify({ segundos: Math.round((Date.now() - inicio) / 1000), arquivos: r.arquivos, escritas: r.escritas.length,
    naoResolvidosProducao: r.naoResolvidos.filter((x) => !x.teste).length, naoResolvidosTeste: r.naoResolvidos.filter((x) => x.teste).length,
    derivados: r.derivados.length, comoValor: r.comoValor.length, sql: r.sql.length }));
}
