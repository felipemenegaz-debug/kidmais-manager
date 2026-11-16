import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EXEMPLOS_LINK, validarLinkAvaliacao } from "./links.ts";
import { OBJETOS_111 } from "./instalacao.ts";

/**
 * PS-3 sem banco: gramática positiva do link do Google (plano rev. 2.1, B'), manifesto da instalação igual ao postcheck
 * da 111 (PS3-R21-P3-2) e guardas estáticas do contrato temporal (A': sem now(); rota sem instante injetado).
 */
const aceito = (url: string) => assert.deepEqual(validarLinkAvaliacao(url), { ok: true, url }, url);
const recusado = (url: unknown, motivo?: string) => {
  const r = validarLinkAvaliacao(url);
  assert.equal(r.ok, false, `deveria recusar: ${String(url)}`);
  if (motivo && !r.ok) assert.equal(r.motivo, motivo, String(url));
};

test("link do Google: um positivo por host e por chave opcional do Maps; exemplos da tela aceitos", () => {
  for (const exemplo of EXEMPLOS_LINK) aceito(exemplo);
  aceito("https://search.google.com/local/writereview?placeid=ChIJN1t_tDeuEmsRUsoyG83frY4");
  aceito("https://g.page/r/CabcdEFGhij123/review");
  aceito("https://g.page/buffet-exemplo");
  aceito("https://g.page/r/CabcdEFGhij123");
  aceito("https://maps.app.goo.gl/AbCdEfGh12345");
  aceito("https://www.google.com/maps");
  aceito("https://google.com/maps/place/Buffet+Exemplo");
  aceito("https://maps.google.com/maps/place/Buffet+Exemplo/");
  aceito("https://www.google.com/maps/place/Buffet+Exemplo?hl=pt-BR");
  aceito("https://www.google.com/maps/place/Buffet+Exemplo?entry=ttu");
  aceito("https://www.google.com/maps/place/Buffet+Exemplo?g_ep=EgoyMDI0MTAyOS4wIKXMDSoASAFQAw%3D%3D");
  aceito("https://www.google.com/maps/place/Buffet+Exemplo?hl=pt&entry=ttu&g_ep=abc_DEF-123");
});

test("link do Google: placeid ausente, repetido ou fora do formato; chaves desconhecidas ou repetidas; query nos curtos", () => {
  recusado("https://search.google.com/local/writereview", "QUERY_OBRIGATORIA");
  recusado("https://search.google.com/local/writereview?", "QUERY");
  recusado("https://search.google.com/local/writereview?placeid=ABCDEFGHIJK&placeid=LMNOPQRSTUV", "CHAVE_REPETIDA");
  recusado("https://search.google.com/local/writereview?placeid=curto", "VALOR");
  recusado("https://search.google.com/local/writereview?placeid=ABCDEFGHIJK&x=1", "CHAVE_DESCONHECIDA");
  recusado("https://search.google.com/local/writereview?placeid=ABC%2FDEFGHIJK", "VALOR");
  recusado("https://www.google.com/maps?hl=pt&hl=en", "CHAVE_REPETIDA");
  recusado("https://www.google.com/maps?api=1&query=Buffet", "CHAVE_DESCONHECIDA");
  recusado("https://www.google.com/maps?hl=pt&", "QUERY");
  recusado("https://www.google.com/maps?entry=https%3A%2F%2Fevil.test", "VALOR");
  recusado("https://www.google.com/maps?g_ep=a%2F%2Fb", "VALOR");
  recusado("https://g.page/r/CabcdEFGhij123/review?g_st=ic", "QUERY");
  recusado("https://maps.app.goo.gl/AbCdEfGh12345?g_st=ic", "QUERY");
  recusado("https://maps.app.goo.gl/AbCdEfGh12345?", "QUERY");
});

test("link do Google: normalização, autoridade, caracteres e caminhos fora do subconjunto", () => {
  recusado("https://www.google.com/maps/../url?hl=pt", "NORMALIZACAO");
  recusado("https://www.google.com/maps/./place", "NORMALIZACAO");
  recusado("https://www.google.com/maps/%2e%2e/url", "CAMINHO");
  recusado("https://www.google.com/maps//x", "CAMINHO");
  recusado("https://www.google.com/maps-x", "CAMINHO");
  recusado("https://www.google.com/url?q=https://evil.test", "CAMINHO");
  recusado("https://www.google.com/search?q=buffet", "CAMINHO");
  recusado("https://www.google.com/aclk?x=1", "CAMINHO");
  recusado("https://www.google.com/maps/place/Buffet/@-23,-46,17z", "CARACTERE");
  recusado("https://WWW.google.com/maps", "HOST");
  recusado("https://www.google.com:443/maps", "HOST");
  recusado("https://www.google.com./maps", "HOST");
  recusado("https://www.google.com.evil.test/maps", "HOST");
  recusado("https://evilgoogle.com/maps", "HOST");
  recusado("https://xn--ggle-0nda.com/maps", "HOST");
  recusado("https://user@www.google.com/maps", "CARACTERE");
  recusado("https://www.google.com/maps#x", "CARACTERE");
  recusado("https://www.google.com/maps\\x", "CARACTERE");
  recusado("http://www.google.com/maps", "ESQUEMA");
  recusado("HTTPS://www.google.com/maps", "ESQUEMA");
  recusado(" https://www.google.com/maps", "CARACTERE");
  recusado("https://www.google.com/maps place", "CARACTERE");
  recusado("https://www.google.com/maps/café", "CARACTERE");
  recusado("https://www.google.com/maps\n", "CARACTERE");
  recusado(`https://www.google.com/maps/${"a".repeat(500)}`, "TAMANHO");
  recusado("", "TAMANHO");
  recusado(null, "TIPO");
  recusado("javascript:alert(1)", "ESQUEMA");
  recusado("https://g.page/r/CabcdEFGhij123/review/x", "CAMINHO");
  recusado("https://maps.app.goo.gl/curto", "CAMINHO");
  recusado("https://search.google.com/local/writereview/x?placeid=ABCDEFGHIJK", "CAMINHO");
});

test("manifesto da instalação 111 = postcheck = down (gatilhos por relação/função/tipo, restrições, tabelas e funções)", () => {
  for (const arquivo of ["database/checks/20261031_111_postcheck.sql", "database/rollback/20261031_111_satisfacao_links_auditoria_down.sql"]) conferirManifesto(arquivo);
  const migration = readFileSync("database/migrations/20261031_111_satisfacao_links_auditoria.sql", "utf8");
  for (const g of OBJETOS_111.gatilhos) assert.match(migration, new RegExp(`CREATE TRIGGER ${g.nome} BEFORE [A-Z ]+ ON ${g.tabela} FOR EACH (ROW|STATEMENT) EXECUTE FUNCTION ${g.funcao.replace(/[()]/g, "\\$&")}`), g.nome);
  // O down confere a integridade ANTES de remover (e de novo depois do LOCK); nenhum DROP antes da conferência.
  const down = readFileSync("database/rollback/20261031_111_satisfacao_links_auditoria_down.sql", "utf8");
  assert.ok(down.indexOf("111 parcial (") < down.indexOf("LOCK TABLE") && down.indexOf("LOCK TABLE") < down.indexOf("111 parcial depois do LOCK"));
  assert.ok(down.indexOf("111 parcial depois do LOCK") < down.indexOf("DROP TABLE"));
  assert.doesNotMatch(down.replace(/^--.*$/gm, ""), /CASCADE|satisfacao_envios|satisfacao_retornos/);
});

function conferirManifesto(arquivo: string) {
  const post = readFileSync(arquivo, "utf8");
  const gatilhos = [...post.matchAll(/\('(satisfacao_[a-z_]+)', '(satisfacao_[a-z_]+)', '(kidmais111_[a-z_]+\(\))', (\d+)\)/g)]
    .map(([, nome, tabela, funcao, tipo]) => ({ nome, tabela, funcao, tipo: Number(tipo) }));
  assert.deepEqual(gatilhos, OBJETOS_111.gatilhos.map((g) => ({ ...g })), `${arquivo}: gatilhos`);
  const restricoes = [...post.matchAll(/\('(satisfacao_[a-z_]+)', '(satisfacao_[a-z_]+)', '([ufc])'\)/g)].map(([, nome, tabela, tipo]) => ({ nome, tabela, tipo }));
  assert.deepEqual(restricoes, OBJETOS_111.restricoes.map((r) => ({ ...r })), `${arquivo}: restrições`);
  for (const t of OBJETOS_111.tabelas) assert.match(post, new RegExp(`\\('${t}'\\)`), t);
  for (const f of OBJETOS_111.funcoes) assert.ok(post.includes(`('${f}')`), `${arquivo}: ${f}`);
  assert.match(post, /NOT tg\.tgisinternal[\s\S]*tgenabled IN \('O', 'A'\) AND tg\.tgtype = /, `${arquivo}: gatilho por habilitação e tipo`);
  assert.match(post, /indnullsnotdistinct/, `${arquivo}: NULLS NOT DISTINCT`);
}

test("contrato temporal: a pesquisa não decide vigência com now(); a rota nunca injeta o instante", () => {
  const tarefas = readFileSync("lib/satisfacao/tarefas.ts", "utf8");
  assert.doesNotMatch(tarefas.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""), /\bnow\(\)/, "tarefas.ts não usa now()");
  assert.match(tarefas, /WITH agora AS MATERIALIZED/);
  for (const rota of ["app/api/admin/satisfacao/tarefas/route.ts", "app/api/admin/satisfacao/tarefas/[id]/concluir/route.ts", "app/api/admin/satisfacao/links/route.ts"]) {
    assert.doesNotMatch(readFileSync(rota, "utf8"), /instanteDecisao/, rota);
  }
});
