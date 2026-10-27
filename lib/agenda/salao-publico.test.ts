import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { OcupacaoConfirmadaRecord, RegraCapacidadeAgenda } from "../disponibilidade/repositories/models.ts";
import { motivoEstrutural, salaoComporta, situacaoPorSalao } from "../disponibilidade/services/availability.service.ts";
import { dtoPublico, motivoRecomendado, recomendado, saloesPublicosLigados } from "./salao-publico.ts";

// S-D (R-D4/R3-D3/R3-E5): situação por salão, comporta nos dois sentidos, recomendado e DTO público por lista branca.
const tarde = { inicioMinutos: 15 * 60, fimMinutos: 19 * 60 };
const ocup = (f: string, salao: string | null, ini = "15:00", fim = "19:00"): OcupacaoConfirmadaRecord =>
  ({ fechamentoId: f, data: "2026-11-21", horarioInicio: ini, horarioFim: fim, configuracaoAgendaId: "T", salaoId: salao });
const regra = (cap: Record<string, number | null>, min: Record<string, number | null> = {}, extra: Partial<RegraCapacidadeAgenda> = {}): RegraCapacidadeAgenda => ({
  capacidadeTipo: "POR_SALAO", limiteFestasDia: null, intervaloMinimoMinutos: 0, capacidadePorHorario: {},
  saloesPorHorario: { T: Object.keys(cap) }, saloesDoEscopo: Object.keys(cap), capacidadePorSalao: cap, minimoPorSalao: min, ...extra,
});
const situacoes = (r: RegraCapacidadeAgenda, o: OcupacaoConfirmadaRecord[], n: number, pacote: string[] | null = null, bloqueado = false) =>
  Object.fromEntries((situacaoPorSalao(r, "T", tarde, o, pacote, n, bloqueado) ?? []).map((x) => [x.salaoId, x.situacao]));

test("S-D: comporta nos dois sentidos com limites exatos (mínimo e máximo; nulos abertos)", () => {
  const r = regra({ G: 120, X: null }, { G: 60, X: null });
  assert.equal(motivoEstrutural(r, "G", 59), "abaixo_do_minimo");
  assert.equal(motivoEstrutural(r, "G", 60), null, "N = mínimo");
  assert.equal(motivoEstrutural(r, "G", 120), null, "N = máximo");
  assert.equal(motivoEstrutural(r, "G", 121), "nao_comporta", "N = máximo + 1");
  assert.equal(salaoComporta(r, "X", 1), true);
  assert.equal(salaoComporta(r, "X", 9999), true, "mínimo e máximo nulos");
  assert.equal(salaoComporta({ capacidadePorSalao: { G: 120 } }, "G", 10), true, "antes da 102 (sem mínimo) só a capacidade conta");
});

test("S-D: precedência — estrutural vence ocupado; ocupado vence livre; inelegível nem aparece", () => {
  const r = regra({ P: 50, G: 120 }, { P: null, G: 60 });
  assert.deepEqual(situacoes(r, [], 80), { P: "nao_comporta", G: "livre" });
  assert.deepEqual(situacoes(r, [ocup("1", "P"), ocup("2", "G")], 80), { P: "nao_comporta", G: "ocupado" }, "não comporta E ocupado: o estrutural");
  assert.deepEqual(situacoes(r, [ocup("1", "G")], 40), { P: "livre", G: "abaixo_do_minimo" }, "abaixo do mínimo E ocupado: o estrutural");
  assert.deepEqual(situacoes(r, [], 70, ["G"]), { G: "livre" }, "pacote só no Grande: o Pequeno é inelegível e some");
  assert.deepEqual(situacoes(r, [], 70, null, true), { P: "nao_comporta", G: "ocupado" }, "bloqueio da data = ocupado");
  assert.deepEqual(situacoes(regra({ P: 50, G: 120 }, {}, { limiteFestasDia: 1 }), [ocup("9", "P", "09:00", "11:00")], 40), { P: "ocupado", G: "ocupado" }, "limite do dia");
  assert.equal(situacaoPorSalao({ ...r, capacidadeTipo: "POR_HORARIO" }, "T", tarde, [], null, 80, false), null);
  assert.equal(situacaoPorSalao(null, "T", tarde, [], null, 80, false), null);
});

test("S-D: recomendado — só livres, menor capacidade, nula por último, desempate (ordem, id)", () => {
  const s = (id: string, capacidade: number | null, situacao: "livre" | "ocupado" | "nao_comporta", ordem = 1) => ({ id, capacidade, situacao, ordem });
  assert.equal(recomendado([s("a", 120, "livre"), s("b", 90, "livre"), s("c", 60, "nao_comporta")]), "b");
  assert.equal(recomendado([s("a", null, "livre"), s("b", 200, "livre")]), "b", "capacidade nula por último");
  assert.equal(recomendado([s("b", 100, "livre", 1), s("a", 100, "livre", 1)]), "a", "mesma capacidade e ordem: id");
  assert.equal(recomendado([s("b", 100, "livre", 1), s("a", 100, "livre", 2)]), "b", "ordem antes do id");
  assert.equal(recomendado([s("a", 60, "ocupado"), s("b", 50, "nao_comporta")]), null, "nenhum livre");
  assert.equal(motivoRecomendado(80, 120), "indicado para 80 · cabe até 120");
  assert.equal(motivoRecomendado(80, null), "indicado para 80");
});

test("S-D: flag SALOES_PUBLICOS desligada por padrão", () => {
  assert.equal(saloesPublicosLigados({}), false);
  assert.equal(saloesPublicosLigados({ SALOES_PUBLICOS: "false" }), false);
  assert.equal(saloesPublicosLigados({ SALOES_PUBLICOS: "1" }), false);
  assert.equal(saloesPublicosLigados({ SALOES_PUBLICOS: " true " }), true);
});

test("S-D: DTO público só com a lista branca (nada de declaração, versão, autor ou ocupação)", () => {
  const linha = {
    id: "s1", nome: "Grande", ordem: 1, capacidade_convidados: 120, convidados_minimo: 60, convidados_sentados: 80, area_m2: 150,
    idade_min: null, idade_max: null, frase: "Amplo", outra_festa_simultanea: true, exclusivos: ["ENTRADA", "INVENTADO"], fotos_referencia: "2026-09-01",
    fotos: 6, conteudo_versao: 7, declaracao_versao: 7, ativo: true,
  };
  const dto = dtoPublico(linha, [
    { grupo: "BRINCADEIRAS", nome: "Piscina de bolinhas", destaque: true, idadeMin: 2, idadeMax: 6, catalogo: true },
    { grupo: "ADULTOS", nome: "Lounge", destaque: false, idadeMin: null, idadeMax: null, catalogo: false },
  ], [{ id: "f1", legenda: "Entrada", ordem: 1, largura: 1600, altura: 1200 }], ["Monitores"], "livre");
  assert.deepEqual(Object.keys(dto).sort(), ["convivencia", "destaques", "emTodosOsPacotes", "fotos", "frase", "grupos", "id", "idade", "mesDasFotos", "nome", "numeros", "situacao"]);
  assert.deepEqual(dto.numeros, { capacidade: 120, minimo: 60, sentados: 80, areaM2: 150 });
  assert.deepEqual(dto.idade, { min: 2, max: 6, sugerida: true }, "idade sugerida pelos itens do catálogo");
  assert.equal(dto.mesDasFotos, "2026-09");
  assert.match(dto.convivencia ?? "", /outro salão pode receber outra festa no mesmo horário/);
  assert.deepEqual(Object.keys(dto.fotos[0]!).sort(), ["altura", "id", "largura", "legenda", "ordem"]);
  const texto = JSON.stringify(dto);
  for (const proibido of ["conteudo_versao", "declaracao", "fechamento", "ocupacao", "INVENTADO", "\"7\""]) assert.equal(texto.includes(proibido), false, proibido);
});

test("S-D: 106 — checks e rollback gerados com os corpos exatos da migration", () => {
  const mig = readFileSync("database/migrations/20261027_106_salao_preferido.sql", "utf8").replace(/\r/g, "");
  const corpo = (nome: string) => createHash("sha256").update(mig.match(new RegExp(`CREATE FUNCTION public\\.${nome}\\(\\)[^$]*AS \\$\\$([\\s\\S]*?)\\$\\$;`))![1]!, "utf8").digest("hex");
  for (const arquivo of ["database/checks/20261027_106_postcheck.sql", "database/checks/20261027_106_integridade.sql", "database/rollback/20261027_106_salao_preferido_down.sql"]) {
    const texto = readFileSync(arquivo, "utf8");
    assert.ok(texto.includes(corpo("kidmais106_salao_preferido_escopo")), arquivo);
    assert.ok(texto.includes(corpo("kidmais106_salao_escopo_referenciado")), arquivo);
    assert.match(texto, /provolatile = 'v'/, `${arquivo}: VOLATILE verificado`);
  }
  assert.match(mig, /LANGUAGE plpgsql VOLATILE SET search_path = public, pg_catalog AS \$\$\nDECLARE s record;/);
  assert.match(mig, /FOR SHARE;/, "a preferência lê o salão FOR SHARE");
  assert.match(readFileSync("database/rollback/20261027_106_salao_preferido_down.sql", "utf8"), /WHERE salao_preferido_id IS NOT NULL\) THEN\s+RAISE EXCEPTION '106 rollback: há festa/);
});
