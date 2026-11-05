import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { enderecoPublicoAbsoluto, paginaInicialPublica, paginaPublica } from "./rota-publica.ts";

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
    assert.match(fonte, /metadata = metadataEmpresaPublica/, arquivo);
  }
  const inicial = readFileSync("app/b/[empresa]/page.tsx", "utf8");
  assert.match(inicial, /paginaPublica\("\/disponibilidade", empresa\.codigo\)/, "o orçamento começa pela consulta de datas");
  assert.doesNotMatch(inicial, /\/admin|\/login/, "o endereço público não leva ao painel");
});

test("D1: a navegação do cliente no endereço do buffet segue para /orcamento", () => {
  for (const arquivo of ["components/disponibilidade/DisponibilidadePublica.tsx", "components/saloes/ConhecaSaloes.tsx"]) {
    const fonte = readFileSync(arquivo, "utf8");
    assert.doesNotMatch(fonte, /paginaPublica\("\/fechamento"/, arquivo);
    assert.match(fonte, /paginaPublica\("\/orcamento", empresa\)/, arquivo);
  }
});
