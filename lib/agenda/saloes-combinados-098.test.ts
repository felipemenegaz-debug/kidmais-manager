import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ocupacaoImpedeCandidato } from "../disponibilidade/services/availability.service.ts";
import { estruturaFesta019Sql } from "../festas/estrutura-019.ts";
import { conjuntosDosSaloes, membrosCanonicos, salaoElegivel, saloesCruzam, type SalaoDoEscopo } from "./saloes-conjuntos.ts";

/**
 * 098 (fase 1 dos salões) sem banco: a regra pura (espelho de kidmais098_*), o cálculo de candidatos com conjuntos e as
 * conferências estáticas da migration (corpos = 094 + linhas declaradas, hashes do verificador, rollback com os corpos
 * da 094, manifesto da Festa com o conjunto 098). A paridade com o SQL roda na suíte PostgreSQL.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ler = (p: string) => readFileSync(resolve(root, p), "utf8").replaceAll("\r", "");
const M094 = "database/migrations/20261022_094_agenda_capacidade.sql";
const M098 = "database/migrations/20261023_098_saloes_combinados.sql";
const D098 = "database/rollback/20261023_098_saloes_combinados_down.sql";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";
const AB = "00000000-0000-4000-8000-0000000000ab";
const BC = "00000000-0000-4000-8000-0000000000bc";
const salao = (id: string, membros: string[] | null = null, ativo = true): SalaoDoEscopo => ({ id, ativo, combinado: membros != null, membros });

test("098: conjuntos e interseção (A × B livres; A × AB, AB × BC, nulo e o mesmo cruzam)", () => {
  const conjuntos = conjuntosDosSaloes([salao(A), salao(B), salao(C), salao(AB, [A, B]), salao(BC, [B, C])]);
  assert.equal(saloesCruzam(A, B, conjuntos), false);
  assert.equal(saloesCruzam(A, C, conjuntos), false);
  assert.equal(saloesCruzam(A, AB, conjuntos), true);
  assert.equal(saloesCruzam(AB, A, conjuntos), true);
  assert.equal(saloesCruzam(AB, BC, conjuntos), true);
  assert.equal(saloesCruzam(A, BC, conjuntos), false);
  assert.equal(saloesCruzam(AB, AB, conjuntos), true);
  assert.equal(saloesCruzam(null, A, conjuntos), true, "festa sem salão ocupa todos");
  assert.equal(saloesCruzam(AB, undefined, conjuntos), true);
  // Sem a 098 (sem conjuntos): cada salão é ele mesmo, como a regra da 094.
  assert.equal(saloesCruzam(A, AB, null), false);
  assert.equal(saloesCruzam(A, A, null), true);
});

test("098: elegibilidade (ativo; combinado só com todos os membros presentes, simples e ativos) e forma canônica", () => {
  const todos = [salao(A), salao(B, null, false), salao(C), salao(AB, [A, B]), salao(BC, [B, C]), salao("ac", [A, C])];
  assert.equal(salaoElegivel(todos[0]!, todos), true);
  assert.equal(salaoElegivel(todos[1]!, todos), false, "inativo");
  assert.equal(salaoElegivel(todos[3]!, todos), false, "membro B inativo");
  assert.equal(salaoElegivel(todos[5]!, todos), true);
  assert.equal(salaoElegivel(salao("x", [A, "ausente"]), todos), false, "membro ausente nunca é conjunto vazio");
  assert.equal(salaoElegivel(salao("y", [A, AB]), todos), false, "membro combinado (aninhado)");
  assert.deepEqual(membrosCanonicos([B.toUpperCase(), A, B]), [A, B]);
});

const tarde = { inicioMinutos: 15 * 60, fimMinutos: 19 * 60 };
const ocup = (f: string, salaoId: string | null, ini = "15:00", fim = "19:00") =>
  ({ fechamentoId: f, data: "2026-11-21", horarioInicio: ini, horarioFim: fim, configuracaoAgendaId: "T", salaoId });
const regra = (escopo: string[], conjuntos?: Record<string, string[]>, porHorario: string[] = []) => ({
  capacidadeTipo: "POR_SALAO" as const, limiteFestasDia: null, intervaloMinimoMinutos: 0, capacidadePorHorario: {},
  saloesPorHorario: (porHorario.length ? { T: porHorario } : {}) as Record<string, string[]>, saloesDoEscopo: escopo, ...(conjuntos ? { conjuntos } : {}),
});

test("098: candidatos com conjuntos — o combinado ocupado ocupa os membros e vice-versa", () => {
  const conjuntos = { [A]: [A], [B]: [B], [AB]: [A, B] };
  const r = regra([A, B, AB], conjuntos);
  // Só AB permitido pelo pacote (pacote grande): A ocupado impede; nada ocupado libera.
  assert.equal(ocupacaoImpedeCandidato(r, "T", tarde, [], [AB]), false);
  assert.equal(ocupacaoImpedeCandidato(r, "T", tarde, [ocup("1", A)], [AB]), true);
  // Pacote com A e B (sem AB): AB ocupado impede os dois; A ocupado deixa B.
  assert.equal(ocupacaoImpedeCandidato(r, "T", tarde, [ocup("1", AB)], [A, B]), true);
  assert.equal(ocupacaoImpedeCandidato(r, "T", tarde, [ocup("1", A)], [A, B]), false);
  // Festa sem salão ocupa todos.
  assert.equal(ocupacaoImpedeCandidato(r, "T", tarde, [ocup("1", null)], [A, B, AB]), true);
  // Fora do horário (com intervalo 0, bordas que se tocam), não impede.
  assert.equal(ocupacaoImpedeCandidato(r, "T", tarde, [ocup("1", AB, "19:00", "21:00")], [A]), false);
});

test("098: hold — origem e destino são ocupações separadas (não consolida pela festa)", () => {
  const conjuntos = { [A]: [A], [B]: [B], [C]: [C], [AB]: [A, B] };
  const r = regra([A, B, C, AB], conjuntos);
  // Festa 1 com origem em C e destino (hold) em AB no mesmo dia: A, B, AB e C ocupados.
  const hold = [ocup("1", C), ocup("1", AB)];
  for (const candidato of [A, B, C, AB]) assert.equal(ocupacaoImpedeCandidato(r, "T", tarde, hold, [candidato]), true, candidato);
  // Aplicada (só o destino AB fica): C livre. Cancelada (só a origem C): A, B e AB livres.
  assert.equal(ocupacaoImpedeCandidato(r, "T", tarde, [ocup("1", AB)], [C]), false);
  for (const candidato of [A, B, AB]) assert.equal(ocupacaoImpedeCandidato(r, "T", tarde, [ocup("1", C)], [candidato]), false, candidato);
});

test("098: sem candidato elegível = indisponível; permissão por identidade (A e B não liberam AB)", () => {
  const conjuntos = { [A]: [A], [B]: [B], [AB]: [A, B] };
  // AB inelegível (membro inativo): fora de saloesDoEscopo; pacote só com AB → indisponível mesmo sem ocupação.
  assert.equal(ocupacaoImpedeCandidato(regra([A, B], conjuntos), "T", tarde, [], [AB]), true);
  // Horário que lista só AB inelegível: sem candidato.
  assert.equal(ocupacaoImpedeCandidato(regra([A, B], conjuntos, [AB]), "T", tarde, []), true);
  // Pacote com A e B: AB nunca é candidato; com A e B ocupados, indisponível.
  assert.equal(ocupacaoImpedeCandidato(regra([A, B, AB], conjuntos), "T", tarde, [ocup("1", A), ocup("2", B)], [A, B]), true);
  // Sem a 098 (sem conjuntos), escopo sem salões continua com a regra da 094 (qualquer sobreposição).
  assert.equal(ocupacaoImpedeCandidato(regra([]), "T", tarde, []), false);
  assert.equal(ocupacaoImpedeCandidato(regra([], {}), "T", tarde, []), true);
});

const corpo = (sql: string, nome: string) => {
  const m = sql.match(new RegExp(String.raw`CREATE (?:OR REPLACE )?FUNCTION public\.` + nome + String.raw`\([\s\S]*?AS \$\$([\s\S]*?)\$\$;`));
  assert.ok(m, `sem ${nome}`);
  return m[1]!;
};
const sha = (texto: string) => createHash("sha256").update(texto).digest("hex");

test("098: corpos substituídos = 094 + só as linhas declaradas; rollback devolve os corpos da 094", async () => {
  const m094 = ler(M094);
  const m098 = ler(M098);
  const down = ler(D098);
  assert.equal(corpo(m098, "kidmais094_conflito_ocupacao"),
    corpo(m094, "kidmais094_conflito_ocupacao").replace("AND (o.salao_id IS NULL OR salao IS NULL OR o.salao_id = salao)", "AND kidmais098_saloes_cruzam(o.salao_id, salao)"));
  assert.equal(corpo(m098, "kidmais019_validar_contrato").replace(" IF kidmais019_ocupa(fid) THEN PERFORM kidmais098_validar_elegibilidade(fid); END IF;\n", ""),
    corpo(m094, "kidmais019_validar_contrato"));
  assert.equal(corpo(m098, "kidmais_validar_agenda_revisao").replace(" PERFORM public.kidmais098_validar_elegibilidade(fid);\n", ""),
    corpo(m094, "kidmais_validar_agenda_revisao"));
  for (const nome of ["kidmais094_conflito_ocupacao", "kidmais019_validar_contrato", "kidmais_validar_agenda_revisao"]) {
    assert.equal(corpo(down, nome), corpo(m094, nome), `rollback: ${nome}`);
  }
  // Ordem dentro do validador da revisão: datas → elegibilidade (salões por último) → conflito.
  const revisao = corpo(m098, "kidmais_validar_agenda_revisao");
  assert.ok(revisao.indexOf("kidmais_lock_datas_revisao") < revisao.indexOf("kidmais098_validar_elegibilidade"));
  assert.ok(revisao.indexOf("kidmais098_validar_elegibilidade") < revisao.indexOf("kidmais094_conflito_ocupacao"));
  // P2-1 da revisão do Astra: o rollback roda o verificador COMPLETO da 098 antes de qualquer alteração e o verificador
  // COMPLETO da 094 antes do COMMIT — os MESMOS blocos dos arquivos de check (mesma fonte, sem listas reduzidas).
  const blocos = (sql: string) => {
    const r: string[] = [];
    for (let i = sql.indexOf("DO $$"); i >= 0; i = sql.indexOf("DO $$", i + 1)) r.push(sql.slice(i, sql.indexOf("END $$;", i) + "END $$;".length));
    return r;
  };
  const b098 = blocos(ler("database/checks/20261023_098_integridade.sql"));
  const [pos] = blocos(ler("database/checks/20261022_094_integridade.sql"));
  assert.equal(b098.length, 3, "verificador 098: corpo + colunas e FKs exatas + retrato estrutural");
  const [pre, fks, retrato098] = b098 as [string, string, string];
  // Rodada 4 do Astra: retrato estrutural canônico com FONTE ÚNICA (database/checks/20261023_098_retrato.sql) nos
  // checks e no rollback; 094 no precheck e depois das remoções; 098 no postcheck, no verificador e antes do LOCK.
  const fonte = ler("database/checks/20261023_098_retrato.sql");
  const expressao = fonte.slice(fonte.indexOf("-- @@RETRATO-INICIO"), fonte.indexOf("-- @@RETRATO-FIM") + "-- @@RETRATO-FIM".length);
  assert.ok(expressao.length > 2000);
  const { RETRATO_094, RETRATO_098 } = await import("../../scripts/migration-098-retrato.mjs") as { RETRATO_094: string; RETRATO_098: string };
  const retratoDe = (sql: string, estado: string) => {
    const i = sql.indexOf(`-- @@BLOCO-RETRATO-INICIO ${estado}`);
    const f = sql.indexOf(`-- @@BLOCO-RETRATO-FIM ${estado}`);
    assert.ok(i >= 0 && f > i, `bloco do retrato ${estado}`);
    return sql.slice(i, f);
  };
  for (const [arquivo, estado, hash] of [["database/checks/20261023_098_precheck.sql", "094", RETRATO_094], ["database/checks/20261023_098_postcheck.sql", "098", RETRATO_098],
    ["database/checks/20261023_098_integridade.sql", "098", RETRATO_098]] as const) {
    const bloco = retratoDe(ler(arquivo), estado);
    assert.equal(bloco.split(expressao).length, 2, `${arquivo}: expressão idêntica à fonte`);
    assert.ok(bloco.includes(`IS DISTINCT FROM '${hash}'`), `${arquivo}: hash do estado ${estado}`);
  }
  assert.ok(retrato098.includes(expressao) && retrato098.includes(RETRATO_098));
  assert.ok(down.indexOf(retrato098) < down.indexOf("LOCK TABLE public.agenda_saloes"), "retrato 098 antes de qualquer alteração");
  const pos094 = retratoDe(down, "094");
  assert.ok(pos094.includes(expressao) && pos094.includes(RETRATO_094));
  assert.ok(down.indexOf("DROP FUNCTION public.kidmais098_hoje()") < down.indexOf(pos094) && down.indexOf(pos094) < down.lastIndexOf("COMMIT;"), "retrato 094 depois das remoções e antes do COMMIT");
  assert.ok(pre.length > 1000 && pos!.length > 1000 && /conkey/.test(fks) && /confkey/.test(fks));
  assert.equal(down.split(pre).length, 2, "verificador 098 completo embutido uma vez");
  assert.equal(down.split(pos!).length, 2, "verificador 094 completo embutido uma vez");
  assert.equal(down.split(fks).length, 3, "FKs exatas: na pré e na pós-condição");
  const lock = down.indexOf("LOCK TABLE public.agenda_saloes");
  assert.ok(down.indexOf(pre) < lock && down.indexOf(fks) < lock, "pré-condição completa antes de qualquer alteração");
  const drop = down.indexOf("DROP FUNCTION public.kidmais098_hoje()");
  assert.ok(drop < down.indexOf(pos!) && drop < down.lastIndexOf(fks), "pós-condição depois das remoções");
  assert.ok(down.lastIndexOf(fks) < down.lastIndexOf("COMMIT;"), "pós-condição antes do COMMIT");
  // Rollback: recusa com qualquer combinado, trava a tabela e confere de novo antes de remover; transação única.
  assert.match(down, /existe salão combinado/);
  assert.ok(down.indexOf("LOCK TABLE public.agenda_saloes") < down.indexOf("DROP TRIGGER"));
  assert.equal(down.match(/^BEGIN;$/gm)?.length, 1);
  assert.equal(down.match(/^COMMIT;$/gm)?.length, 1);
});

test("098: o verificador fixa o hash de cada função da migration e o manifesto da Festa tem o conjunto 098", () => {
  const m098 = ler(M098);
  const integridade = ler("database/checks/20261023_098_integridade.sql");
  const nomes = [...m098.matchAll(/CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\(/g)].map((m) => m[1]!);
  assert.equal(nomes.length, 13);
  for (const nome of nomes) {
    const linha = integridade.split("\n").find((l) => l.includes(`('${nome}(`));
    assert.ok(linha, `verificador sem ${nome}`);
    assert.ok(linha.includes(sha(corpo(m098, nome))), `hash divergente: ${nome}`);
  }
  const conjuntos: Record<string, Record<string, string>> = {};
  for (const [, c, nome, hash] of estruturaFesta019Sql.matchAll(/\('(\d{3})','(\w+)','([0-9a-f]{64})'\)/g)) (conjuntos[c!] ??= {})[nome!] = hash!;
  assert.deepEqual(Object.keys(conjuntos), ["019", "061", "062", "094", "098"]);
  assert.equal(conjuntos["098"]!.kidmais019_validar_contrato, sha(corpo(m098, "kidmais019_validar_contrato")));
  assert.equal(conjuntos["098"]!.kidmais_validar_agenda_revisao, sha(corpo(m098, "kidmais_validar_agenda_revisao")));
  for (const nome of Object.keys(conjuntos["094"]!)) {
    if (!["kidmais019_validar_contrato", "kidmais_validar_agenda_revisao"].includes(nome)) assert.equal(conjuntos["098"]![nome], conjuntos["094"]![nome], nome);
  }
});

test("098: guardas declaradas (identidade, D5, contratos, TRUNCATE) e corte de hoje em São Paulo", () => {
  const m098 = ler(M098);
  assert.match(m098, /ROW\(NEW\.id, NEW\.empresa_id, NEW\.estabelecimento_id, NEW\.combinado, NEW\.membros\)/);
  assert.match(m098, /CREATE TRIGGER contratos_098_guarda_trg BEFORE DELETE OR UPDATE OF fechamento_id ON public\.contratos/);
  assert.match(m098, /CREATE TRIGGER contratos_098_truncate_trg BEFORE TRUNCATE ON public\.contratos/);
  assert.match(m098, /CREATE TRIGGER agenda_saloes_098_truncate_trg BEFORE TRUNCATE ON public\.agenda_saloes/);
  assert.match(m098, /CREATE CONSTRAINT TRIGGER agenda_saloes_098_combinado_diferido AFTER INSERT ON public\.agenda_saloes\s+DEFERRABLE INITIALLY DEFERRED/);
  assert.match(corpo(m098, "kidmais098_hoje"), /clock_timestamp\(\) AT TIME ZONE 'America\/Sao_Paulo'/);
  assert.doesNotMatch(m098, /CURRENT_DATE/, "a 098 nunca usa o fuso da sessão");
  // União ordenada ANTES da primeira aquisição: um único SELECT … ORDER BY … FOR SHARE.
  const validar = corpo(m098, "kidmais098_validar_elegibilidade");
  assert.equal(validar.match(/FOR SHARE/g)?.length, 1);
  assert.ok(validar.indexOf("ORDER BY x") < validar.indexOf("FOR SHARE"));
  assert.ok(validar.indexOf("FOR SHARE") < validar.indexOf("kidmais098_salao_elegivel"));
});
