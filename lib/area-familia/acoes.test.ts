import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { corpoAcaoFamilia, MENSAGENS_ACAO } from "./acoes-http.ts";
import { abasVisiveis, textoLivre } from "./formato.ts";
import { comLink, comMarca, marcasIniciais, marcasVigentes } from "./visita.ts";

// Área "Minha festa" F3 (125): partes sem banco. As regras com banco estão em acoes.postgres.test.ts.

const UUID = "7b0f7d3e-3c55-4f6e-9d5e-2a9f1b8c4d21";

test("F3: corpo das ações — uma ação por vez, estrito, ids uuid, limites de texto", () => {
  const aceita = (x: unknown) => corpoAcaoFamilia.safeParse(x).success;
  assert.ok(aceita({ acao: "AVISAR_PAGAMENTO", parcela: UUID }));
  assert.ok(aceita({ acao: "AVISAR_PAGAMENTO", parcela: UUID, observacao: null }));
  assert.ok(aceita({ acao: "AVISAR_PAGAMENTO", parcela: UUID, observacao: "x".repeat(280) }));
  assert.ok(!aceita({ acao: "AVISAR_PAGAMENTO", parcela: UUID, observacao: "x".repeat(281) }));
  assert.ok(!aceita({ acao: "AVISAR_PAGAMENTO", parcela: "1" }), "id que não é uuid");
  assert.ok(!aceita({ acao: "AVISAR_PAGAMENTO", parcela: UUID, valor: 100 }), "campo a mais (a família não informa valor)");
  assert.ok(!aceita({ acao: "AVISAR_PAGAMENTO", parcela: UUID, festaId: UUID }), "festa vem da sessão, nunca do corpo");
  assert.ok(aceita({ acao: "PENDENCIA_FEITA", pendencia: UUID }));
  assert.ok(!aceita({ acao: "PENDENCIA_FEITA", pendencia: UUID, estado: "RESOLVIDA" }));
  assert.ok(aceita({ acao: "CONVIDAR_SEGUNDO", nome: "João", whatsapp: "(21) 98888-7777" }));
  assert.ok(aceita({ acao: "CONVIDAR_SEGUNDO", nome: "João", whatsapp: "21988887777", documento: "123.456.789-09" }));
  assert.ok(!aceita({ acao: "CONVIDAR_SEGUNDO", nome: "   ", whatsapp: "21988887777" }), "nome vazio");
  assert.ok(!aceita({ acao: "CONVIDAR_SEGUNDO", nome: "x".repeat(121), whatsapp: "21988887777" }));
  assert.ok(!aceita({ acao: "CONVIDAR_SEGUNDO", nome: "João", whatsapp: "21988887777", papel: "CONTRATANTE" }), "papel não vem do corpo");
  assert.ok(aceita({ acao: "LINK_SEGUNDO" }));
  assert.ok(!aceita({ acao: "LINK_SEGUNDO", pessoaId: UUID }), "alvo não vem do corpo");
  assert.ok(aceita({ acao: "REMOVER_SEGUNDO" }));
  assert.ok(!aceita({ acao: "REMOVER_SEGUNDO", pessoaId: UUID }));
  assert.ok(!aceita({ acao: "DESCONECTAR_TODOS" }), "ação do painel não existe na área");
  assert.ok(!aceita(null));
  assert.ok(!aceita([]));
});

test("F3: toda recusa tem mensagem em português e status de erro; nenhuma expõe dado", () => {
  for (const [motivo, [msg, status]] of Object.entries(MENSAGENS_ACAO)) {
    assert.ok(msg.length > 10 && /[a-zà-ú]/.test(msg), motivo);
    assert.ok(status >= 400 && status < 500, motivo);
  }
  assert.equal(MENSAGENS_ACAO.SO_CONTRATANTE[1], 403);
  assert.equal(MENSAGENS_ACAO.NAO_ENCONTRADO[1], 404);
});

test("F3: texto livre — pontas fora, vazio vira null, acima do limite recusado", () => {
  assert.equal(textoLivre("  oi  ", 10), "oi");
  assert.equal(textoLivre("   ", 10), null);
  assert.equal(textoLivre(null, 10), null);
  assert.equal(textoLivre(undefined, 10), null);
  assert.equal(textoLivre("x".repeat(10), 10), "x".repeat(10));
  assert.equal(textoLivre("x".repeat(11), 10), false);
  assert.equal(textoLivre(` ${"x".repeat(10)} `, 10), "x".repeat(10), "o limite vale depois de tirar as pontas");
});

test("F3: abas — sem a 125 só as de leitura; Pendências para os dois; Pessoas só para o contratante", () => {
  const ids = (papel: "CONTRATANTE" | "SEGUNDO_RESPONSAVEL", disponivel: boolean) => abasVisiveis({ papel, acoes: { disponivel } }).map((a) => a.id);
  assert.deepEqual(ids("CONTRATANTE", false), ["inicio", "festa", "pagamentos", "documentos"]);
  assert.deepEqual(ids("SEGUNDO_RESPONSAVEL", false), ["inicio", "festa", "pagamentos", "documentos"]);
  assert.deepEqual(ids("CONTRATANTE", true), ["inicio", "festa", "pagamentos", "pendencias", "documentos", "pessoas"]);
  assert.deepEqual(ids("SEGUNDO_RESPONSAVEL", true), ["inicio", "festa", "pagamentos", "pendencias", "documentos"]);
});

test("F3: rota da família — ordem das guardas, sessão relida na transação, sem dado pessoal em log", () => {
  const src = readFileSync("app/b/[empresa]/minha-festa/api/acao/route.ts", "utf8");
  const ordem = ["areaFamiliaLigada()", "origemPublicaValida(request)", "corpoAcaoFamilia.safeParse", "pepperIdentidade()",
    "lerSessao(db()", "limitarAcaoDaSessao(", "withTransaction(", "agirComSessao(tx, empresa, token, sessao,"];
  let ultimo = -1;
  for (const marca of ordem) {
    const i = src.indexOf(marca);
    assert.ok(i > ultimo, `${marca} fora de ordem`);
    ultimo = i;
  }
  // Dentro da transação: festa travada ANTES de reler e prender a sessão (mesma ordem do painel), mesma sessão e festa.
  const acoes = readFileSync("lib/area-familia/acoes.ts", "utf8");
  const corpo = acoes.slice(acoes.indexOf("export async function agirComSessao("), acoes.indexOf("// Leitura das partes da F3"));
  let antes = -1;
  for (const marca of ['"SELECT 1 FROM festas WHERE id = $1::uuid FOR UPDATE", [previa.festaId]', "lerSessao(tx, empresa, token, { travar: true })",
    "atual.sessaoId !== previa.sessaoId || atual.festaId !== previa.festaId", "acoesInstaladas(tx)", "executarAcaoFamilia(tx, atual,"]) {
    const i = corpo.indexOf(marca);
    assert.ok(i > antes, `agirComSessao: ${marca} fora de ordem`);
    antes = i;
  }
  assert.equal((src.match(/console\./g) ?? []).length, 1);
  assert.match(src, /error instanceof Error \? error\.name : "erro"/, "log só do nome do erro");
});

test("F3: limites do painel batem com o banco (texto para a família 280, aviso fixo 500)", () => {
  const rota = readFileSync("app/api/admin/festas/[festaId]/area-familia/route.ts", "utf8");
  const sql = readFileSync("database/migrations/20261115_125_area_familia_acoes.sql", "utf8");
  assert.match(rota, /PENDENCIA_FAMILIA"\), pendenciaId: z\.string\(\)\.uuid\(\), visivel: z\.boolean\(\), texto: z\.string\(\)\.max\(280\)/);
  assert.match(rota, /AVISO_FIXO"\), texto: z\.string\(\)\.max\(500\)\.nullable\(\)/);
  assert.match(sql, /length\(btrim\(texto\)\) BETWEEN 1 AND 280/);
  assert.match(sql, /length\(btrim\(texto\)\) BETWEEN 1 AND 500/);
});

test("F3: tela — resultado das ações fica acima das abas e os dados são relidos do servidor depois de cada ação", () => {
  const src = readFileSync("components/area-familia/AreaFamilia.tsx", "utf8");
  const bloco = (nome: string) => src.slice(src.indexOf(`function ${nome}(`), src.indexOf("\nfunction ", src.indexOf(`function ${nome}(`) + 1));
  const logado = bloco("Logado");
  for (const marca of ["useState(() => marcasIniciais(dados))", "marcasVigentes(marcas, dados)", "router.refresh()"]) {
    assert.ok(logado.includes(marca), `Logado guarda ${marca}`);
  }
  assert.ok(!bloco("Pendencias").includes("useState<string[]>"), "o feito não vive só na aba");
  assert.ok(bloco("Pendencias").includes("visita.marcarFeita(id)"));
  assert.ok(!bloco("Pessoas").includes("setLink"), "o link gerado não vive só na aba");
  assert.ok(bloco("Pessoas").includes("visita.mudouSegundo("));
  assert.ok(!src.includes("window.location.reload()"), "sem recarregar a página (perderia o link gerado)");
  assert.ok(bloco("JaPaguei").includes("aoAvisar(parcela.id)"));
  assert.ok(bloco("JaPaguei").includes("if (avisada) return"), "o avisado vem só de avisada (servidor ou marcação sobre os mesmos dados)");
  assert.ok(!/estado?.ok|setEstado|useState<{ ok/.test(bloco("JaPaguei")), "JaPaguei não guarda sucesso próprio (aviso descartado faria o botão sumir)");
  assert.ok(bloco("Inicio").includes("!feitas.includes(p.id)"), "contagem do Início considera o feito desta visita");
});

test("F3: tela — marcações da visita cedem aos dados novos do servidor (pendência devolvida volta a aparecer)", () => {
  type D = { acoes: { segundo?: { linkId: string | null } | null; pendencias: { id: string; feita: boolean; devolvida: boolean }[] } };
  const dados = (pend: { id: string; feita: boolean; devolvida: boolean }[], segundo: { linkId: string | null } | null = null): D => ({ acoes: { segundo, pendencias: pend } });
  const feitaNaTela = (d: D, feitas: string[], id: string) => d.acoes.pendencias.find((p) => p.id === id)!.feita || feitas.includes(id);

  // Cenário do Astra (r2): marca A; refresh traz A feita; buffet devolve A; outra ação (B) e novo refresh.
  const d0 = dados([{ id: "A", feita: false, devolvida: false }, { id: "B", feita: false, devolvida: false }]);
  let m = comMarca(marcasIniciais(d0), d0, "feitas", "A");
  assert.ok(feitaNaTela(d0, marcasVigentes(m, d0).feitas, "A"), "antes do refresh, o feito desta visita aparece");
  const d1 = dados([{ id: "A", feita: true, devolvida: false }, { id: "B", feita: false, devolvida: false }]);
  assert.deepEqual(marcasVigentes(m, d1).feitas, [], "dados novos: o servidor manda");
  const d2 = dados([{ id: "A", feita: false, devolvida: true }, { id: "B", feita: false, devolvida: false }]);
  m = comMarca(m, d2, "feitas", "B");
  assert.deepEqual(marcasVigentes(m, d2).feitas, ["B"], "a marca antiga de A não volta junto com a nova");
  const d3 = dados([{ id: "A", feita: false, devolvida: true }, { id: "B", feita: true, devolvida: false }]);
  assert.equal(feitaNaTela(d3, marcasVigentes(m, d3).feitas, "A"), false, "A devolvida aparece aberta e pode ser marcada de novo");
  // Mesmo sem refresh entre a marca e a devolução: a marca de A some quando os dados mudam.
  const m2 = comMarca(marcasIniciais(d0), d0, "feitas", "A");
  assert.equal(feitaNaTela(d2, marcasVigentes(m2, d2).feitas, "A"), false);

  // "Já paguei": mesma regra.
  const ma = comMarca(marcasIniciais(d0), d0, "avisadas", "P1");
  assert.deepEqual(marcasVigentes(ma, d0).avisadas, ["P1"]);
  assert.deepEqual(marcasVigentes(ma, d1).avisadas, []);

  // Link do segundo: segue só enquanto for o link ativo do servidor (mesmo id).
  const s0 = dados([], null);
  const ml = comLink(marcasIniciais(s0), s0, { url: "https://x/link-Ana", linkId: "L-Ana" });
  assert.equal(marcasVigentes(ml, s0).link, "https://x/link-Ana", "antes do refresh o segundo ainda não aparece, o link sim");
  const ana = dados([], { linkId: "L-Ana" });
  assert.equal(marcasVigentes(ml, ana).link, "https://x/link-Ana", "refresh com o mesmo link ativo: segue");
  assert.equal(marcasVigentes(ml, dados([], null)).link, null, "Ana removida no servidor: link some");
  // Cenário do Astra (r3): Ana removida, refresh esconde; outro aparelho cadastra Bia; novo refresh NÃO traz o link de Ana.
  assert.equal(marcasVigentes(ml, dados([], { linkId: "L-Bia" })).link, null, "outro segundo (Bia): link de Ana não volta");
  assert.equal(marcasVigentes(ml, dados([], { linkId: null })).link, null, "Ana sem link ativo (revogado): some");
  assert.equal(marcasVigentes(ml, dados([], { linkId: "L-Ana-2" })).link, null, "link novo gerado em outro aparelho: o antigo some");
  assert.equal(marcasVigentes(comLink(ml, ana, null), ana).link, null, "remoção pela família apaga o link");
  // Uma marca nova não ressuscita um link que deixou de valer, nem depois com o id antigo de volta.
  const semAna = dados([{ id: "A", feita: false, devolvida: false }], null);
  const depois = comMarca(ml, semAna, "feitas", "A");
  assert.equal(depois.link, null);
  assert.equal(marcasVigentes(depois, ana).link, null);
});
