import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { apiPublica, enderecoPublicoAbsoluto, paginaInicialPublica, paginaPublica } from "./rota-publica.ts";

test("D1: /orcamento no endereço do buffet; sem empresa o endereço atual continua /fechamento", () => {
  assert.equal(paginaPublica("/orcamento", "mundo-encantado"), "/b/mundo-encantado/orcamento");
  assert.equal(paginaPublica("/orcamento"), "/fechamento");
  assert.equal(paginaPublica("/orcamento", ""), "/fechamento");
  assert.equal(paginaPublica("/fechamento", "mundo-encantado"), "/b/mundo-encantado/fechamento", "links antigos seguem válidos");
  assert.equal(paginaPublica("/disponibilidade", "mundo-encantado"), "/b/mundo-encantado/disponibilidade");
  assert.equal(paginaInicialPublica("mundo-encantado"), "/b/mundo-encantado");
});

test("D1: endereço absoluto só com origem segura e sem caminho e com código no formato de empresas.codigo", () => {
  const origem = "https://iafest.demerzellabs.com.br";
  assert.equal(enderecoPublicoAbsoluto(origem, "mundo-encantado"), "https://iafest.demerzellabs.com.br/b/mundo-encantado");
  assert.equal(enderecoPublicoAbsoluto(`${origem}/`, "mundo-encantado", "/orcamento"), "https://iafest.demerzellabs.com.br/b/mundo-encantado/orcamento");
  assert.equal(enderecoPublicoAbsoluto(origem, "mundo-encantado", "/disponibilidade"), "https://iafest.demerzellabs.com.br/b/mundo-encantado/disponibilidade");
  assert.equal(enderecoPublicoAbsoluto("http://localhost:3000", "buffet-a", "/orcamento"), "http://localhost:3000/b/buffet-a/orcamento");
  // P3 da revisão r1: código fora do formato de empresas.codigo nunca vira link (sairia de /b/<código> ou cairia no fluxo sem empresa).
  for (const codigo of ["", "..", ".", "a/../admin", "%2e%2e", "Mundo", "mundo-", "-mundo", "ab", `a${"b".repeat(64)}`, "mundo encantado"])
    for (const destino of [undefined, "/orcamento", "/disponibilidade"] as const)
      assert.equal(enderecoPublicoAbsoluto(origem, codigo, destino), null, `${JSON.stringify(codigo)} ${destino}`);
  assert.equal(enderecoPublicoAbsoluto(origem, "abc"), "https://iafest.demerzellabs.com.br/b/abc", "menor código válido (3)");
  for (const ruim of [undefined, null, "", "nao-e-url", "http://iafest.demerzellabs.com.br", `${origem}/admin`, `${origem}/?x=1`, `${origem}/#a`, "https://u:s@iafest.demerzellabs.com.br", "ftp://iafest.demerzellabs.com.br"])
    assert.equal(enderecoPublicoAbsoluto(ruim, "mundo-encantado"), null, String(ruim));
});

test("a base conserva o fluxo global de APIs e coloca as páginas sob o código legado", () => {
  assert.equal(paginaPublica("/disponibilidade", null, "kidmais"), "/b/kidmais/disponibilidade");
  assert.equal(paginaPublica("/orcamento", null, "kidmais"), "/b/kidmais/fechamento");
  assert.equal(paginaPublica("/fechamento", null, "kidmais"), "/b/kidmais/fechamento");
  assert.equal(paginaPublica("/orcamento", "outro-buffet", null), "/b/outro-buffet/orcamento");
  assert.equal(apiPublica("/api/disponibilidade?data=2026-12-01", null), "/api/disponibilidade?data=2026-12-01");
  assert.equal(apiPublica("/api/disponibilidade?data=2026-12-01", "outro-buffet"), "/api/disponibilidade?data=2026-12-01&empresa=outro-buffet");
});

test("D1 r2: o formato do código no helper é o mesmo de CODIGO_EMPRESA_PUBLICA (migration 031)", async () => {
  const { CODIGO_EMPRESA_PUBLICA } = await import("../http/empresas-publicas.ts");
  const fonte = readFileSync("lib/fechamentos/rota-publica.ts", "utf8");
  const local = /const CODIGO_EMPRESA = \/(.+)\/([a-z]*);/.exec(fonte);
  assert.ok(local, "regex local presente");
  assert.equal(local[1], CODIGO_EMPRESA_PUBLICA.source);
  // P3 da revisão r2: uma flag nova no servidor (ex.: i) muda o que é aceito sem mudar o .source.
  assert.equal(local[2], CODIGO_EMPRESA_PUBLICA.flags, "mesmas flags");
  const helper = (codigo: string) => enderecoPublicoAbsoluto("https://iafest.demerzellabs.com.br", codigo) !== null;
  for (const codigo of ["mundo-encantado", "Mundo", "MUNDO", "abc", "ab", "a".repeat(64), "a".repeat(65), "mundo-", "1mundo", "mundo\nx", "ÿmundo"])
    assert.equal(helper(codigo), CODIGO_EMPRESA_PUBLICA.test(codigo), `helper e servidor discordam em ${JSON.stringify(codigo)}`);
});

test("D1: páginas /b/<código> e /b/<código>/orcamento passam pela mesma guarda das demais e levam o contato da empresa", () => {
  for (const arquivo of ["app/b/[empresa]/page.tsx", "app/b/[empresa]/orcamento/page.tsx", "app/b/[empresa]/fechamento/page.tsx"]) {
    const fonte = readFileSync(arquivo, "utf8");
    assert.match(fonte, /await exigirEmpresaPublica\(params\)/, arquivo);
    assert.match(fonte, /contato=\{empresa\.contato\}/, arquivo);
    assert.match(fonte, /gerarMetadataEmpresaPublica as generateMetadata/, arquivo);
  }
  const inicial = readFileSync("app/b/[empresa]/page.tsx", "utf8");
  assert.match(inicial, /paginaPublica\("\/disponibilidade", empresa\.codigo\)/, "o orçamento começa pela consulta de datas");
  assert.doesNotMatch(inicial, /\/admin|\/login/, "o endereço público não leva ao painel");
});

test("D1: a navegação do cliente no endereço do buffet segue para /orcamento", () => {
  for (const arquivo of ["components/disponibilidade/DisponibilidadePublica.tsx", "components/saloes/ConhecaSaloes.tsx"]) {
    const fonte = readFileSync(arquivo, "utf8");
    assert.doesNotMatch(fonte, /paginaPublica\("\/fechamento"/, arquivo);
    const base = arquivo.includes("DisponibilidadePublica") ? ", base" : "";
    assert.ok(fonte.includes(`paginaPublica("/orcamento", empresa${base})`), arquivo);
  }
});

test("as telas usam a base nas páginas e só empresa nas APIs, inclusive quando empresa é omitida", () => {
  for (const arquivo of ["components/disponibilidade/DisponibilidadePublica.tsx", "components/fechamento/FechamentoWizard.tsx"]) {
    const fonte = readFileSync(arquivo, "utf8");
    assert.match(fonte, /export default function \w+\(\{ empresa = null,/);
    assert.doesNotMatch(fonte, /[?&]empresa=/, arquivo);
    const ast = ts.createSourceFile(arquivo, fonte, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const chamadas = { apiPublica: 0, paginaPublica: 0 };
    function visitar(no: ts.Node) {
      if (ts.isCallExpression(no) && ts.isIdentifier(no.expression)) {
        const nome = no.expression.text;
        if (nome === "apiPublica" || nome === "paginaPublica") {
          const argumentosDeEscopo = no.arguments.slice(1).map(arg => arg.getText(ast));
          assert.deepEqual(argumentosDeEscopo, nome === "apiPublica" ? ["empresa"] : ["empresa", "base"], arquivo);
          chamadas[nome]++;
        }
      }
      ts.forEachChild(no, visitar);
    }
    visitar(ast);
    assert.ok(chamadas.apiPublica > 0 && chamadas.paginaPublica > 0, arquivo);
  }
  const disponibilidade = readFileSync("components/disponibilidade/DisponibilidadePublica.tsx", "utf8");
  assert.match(disponibilidade, /if \(empresa && convidados\) \{[\s\S]*?fetch\(apiPublica\(`\/api\/publico\/saloes/);
  const fechamento = readFileSync("components/fechamento/FechamentoWizard.tsx", "utf8");
  assert.match(fechamento, /base == null && empresa \? `\/b\/\$\{encodeURIComponent\(empresa\)\}\/meu-pedido` : "\/meu-pedido"/);
});
