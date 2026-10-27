import test from "node:test";
import assert from "node:assert/strict";
import type { DbExecutor } from "../../db/contracts";
import { executorFalso } from "../../acessos/teste-carregador.ts";
import type { ContratoSnapshot } from "../repositories/models";
import { salaoDoSnapshot, pacoteAplicadoDoSnapshot } from "../repositories/models.ts";
import { analisarRevisao, diferencasContratuais } from "./alteracoes.ts";
import { destinoDifereDoDocumento, salaoExigidoDaFesta } from "./salao-contrato.ts";
import { escolherSalao, escolherSalaoParaEmissao } from "../../agenda/salao-festa.ts";

/**
 * S-E (plano S-E/S-D rev. 4.1) sem banco: diff V1/V2 × V3 sem diferença artificial (R-E4), troca de salão e de horário
 * configurado altera a agenda; salão exigido pela versão (R3-E2/R3-E3); emissão estrita e escolha da equipe (R3-E5).
 * A ocupação e as travas são provadas no PostgreSQL (salao-contrato-se.postgres.test.ts).
 */
const evento = { data: "2026-12-05", horarioInicio: "15:00", horarioFim: "19:00", pacote: { id: "p", codigo: "P", nome: "Pacote", duracaoMinutos: 240 }, convidados: 80, convidadosFaturados: 80 };
const v1 = { schemaVersao: 1, fechamento: { id: "f", status: "AGUARDANDO_CONTRATO", origem: "ATENDIMENTO_KIDMAIS" }, evento } as unknown as ContratoSnapshot;
const v3 = (salao: { id: string; nome: string } | null, cfg = "cfg") =>
  ({ ...(v1 as object), schemaVersao: 3, evento: { ...evento, configuracaoAgendaId: cfg, salao } }) as unknown as ContratoSnapshot;

test("V3: salaoDoSnapshot só em V3 com salão; pacoteAplicado do V2 e do V3", () => {
  assert.equal(salaoDoSnapshot(v1), null);
  assert.equal(salaoDoSnapshot(v3(null)), null);
  assert.deepEqual(salaoDoSnapshot(v3({ id: "s1", nome: "Salão 1" })), { id: "s1", nome: "Salão 1" });
  const foto = { nome: "Congelado" } as never;
  assert.equal(pacoteAplicadoDoSnapshot({ ...(v1 as object), schemaVersao: 2, pacoteAplicado: foto } as unknown as ContratoSnapshot), foto);
  assert.equal(pacoteAplicadoDoSnapshot({ ...(v3(null) as object), pacoteAplicado: foto } as unknown as ContratoSnapshot), foto);
  assert.equal(pacoteAplicadoDoSnapshot(v3(null)), null);
  assert.equal(pacoteAplicadoDoSnapshot(v1), null);
});

test("diff (R-E4): V1 → V3 sem salão não acusa nada; salão novo e troca de salão/configuração são materiais e alteram a agenda", () => {
  assert.deepEqual(diferencasContratuais(v1, v3(null)), [], "ausente = nulo; configuração ausente de um lado não é comparada");
  const comSalao = analisarRevisao(v1, v3({ id: "s1", nome: "Salão 1" }));
  assert.equal(comSalao.natureza, "MATERIAL");
  assert.equal(comSalao.alteraAgenda, true);
  assert.deepEqual(comSalao.campos.map((c) => c.campo).sort(), ["evento.salao.id", "evento.salao.nome"]);
  const troca = analisarRevisao(v3({ id: "s1", nome: "Salão 1" }), v3({ id: "s2", nome: "Salão 2" }));
  assert.equal(troca.alteraAgenda, true);
  const config = analisarRevisao(v3({ id: "s1", nome: "Salão 1" }, "cfg-a"), v3({ id: "s1", nome: "Salão 1" }, "cfg-b"));
  assert.deepEqual(config.campos.map((c) => c.campo), ["evento.configuracaoAgendaId"]);
  assert.equal(config.alteraAgenda, true);
  assert.deepEqual(diferencasContratuais(v3({ id: "s1", nome: "Salão 1" }), v3({ id: "s1", nome: "Salão 1" })), []);
});

function banco(versao: { snapshot: ContratoSnapshot; base: ContratoSnapshot | null } | null, festa: Record<string, unknown> | null) {
  return executorFalso([
    [/FROM contrato_versoes v/, () => (versao ? [versao] : [])],
    [/FROM fechamentos WHERE id = \$1::uuid/, () => (festa ? [festa] : [])],
  ]);
}
const festaIgual = { data: "2026-12-05", inicio: "15:00:00", fim: "19:00:00", cfg: "cfg" };

test("salão exigido (R3-E2/R3-E3): V1/V2 e V3 sem salão não fixam; V3 exige; base da revisão manda; festa diferente = desatualizada", async () => {
  assert.deepEqual(await salaoExigidoDaFesta(banco({ snapshot: v1, base: null }, festaIgual) as unknown as DbExecutor, "v"), { situacao: "SEM_SALAO_FIXADO" });
  assert.deepEqual(await salaoExigidoDaFesta(banco({ snapshot: v3(null), base: null }, festaIgual) as unknown as DbExecutor, "v"), { situacao: "SEM_SALAO_FIXADO" });
  assert.deepEqual(await salaoExigidoDaFesta(banco({ snapshot: v3({ id: "s1", nome: "A" }), base: null }, festaIgual) as unknown as DbExecutor, "v"), { situacao: "EXIGIDO", salaoId: "s1" });
  // Revisão operacional: a festa continua em A (base); o destino B da versão nova é conferido pela revisão.
  assert.deepEqual(await salaoExigidoDaFesta(banco({ snapshot: v3({ id: "s2", nome: "B" }), base: v3({ id: "s1", nome: "A" }) }, festaIgual) as unknown as DbExecutor, "v"), { situacao: "EXIGIDO", salaoId: "s1", daBase: true });
  for (const mudou of [{ data: "2026-12-06" }, { inicio: "16:00:00" }, { fim: "20:00:00" }, { cfg: "outra" }])
    assert.deepEqual(await salaoExigidoDaFesta(banco({ snapshot: v3({ id: "s1", nome: "A" }), base: null }, { ...festaIgual, ...mudou }) as unknown as DbExecutor, "v"), { situacao: "VERSAO_DESATUALIZADA" }, JSON.stringify(mudou));
});

test("salão exigido (P2 do Astra, 27/10): a base só manda enquanto a revisão está aberta; aplicada, a vigente exige o próprio salão", async () => {
  // Revisão aplicada: o JOIN filtrado não traz a base; a versão (agora vigente, com a nova data) exige B contra a festa em B.
  const aplicada = banco({ snapshot: v3({ id: "s2", nome: "B" }), base: null }, festaIgual);
  assert.deepEqual(await salaoExigidoDaFesta(aplicada as unknown as DbExecutor, "v"), { situacao: "EXIGIDO", salaoId: "s2" });
  const consulta = aplicada.executados.find((e) => /FROM contrato_versoes v/.test(e.sql))!.sql;
  assert.match(consulta, /LEFT JOIN fechamento_revisoes r ON r\.contrato_versao_id = v\.id AND r\.estado IN \('EM_ELABORACAO', 'CONGELADA'\)/);
});

const festaPorSalao = { por_salao: true, data: "2026-12-05", inicio: "15:00:00", fim: "19:00:00", cfg: "cfg", pacote: "pac", empresa: "emp", unidade: null, convidados: 80 };
function agenda(festa: Record<string, unknown>, servem: (somente: unknown) => Array<{ id: string; nome: string }>) {
  return executorFalso([
    [/to_regprocedure\('public\.kidmais094_conflito_ocupacao/, () => [{ ok: true }]],
    [/to_regprocedure\('public\.kidmais098_salao_elegivel/, () => [{ ok: false }]],
    [/attname = 'convidados_minimo'/, () => [{ ok: true }]],
    [/FROM fechamentos f WHERE f\.id = \$1::uuid/, () => [festa]],
    [/FROM agenda_saloes s/, (p) => servem(p[9])],
    [/^UPDATE /, () => []],
  ]);
}

test("emissão (R3-E5): escolha da equipe que não serve recusa (nunca vira outra); automático estrito; documento atual fica se serve; nada é gravado", async () => {
  const equipe = agenda({ ...festaPorSalao, salao_id: "B" }, (somente) => (somente === "B" ? [] : [{ id: "C", nome: "C" }]));
  assert.deepEqual(await escolherSalaoParaEmissao(equipe as unknown as DbExecutor, "f"), { porSalao: true, salao: null, motivo: "ESCOLHIDO_NAO_SERVE" });
  const auto = agenda({ ...festaPorSalao, salao_id: null }, () => [{ id: "C", nome: "Salão C" }]);
  assert.deepEqual(await escolherSalaoParaEmissao(auto as unknown as DbExecutor, "f"), { porSalao: true, salao: { id: "C", nome: "Salão C" } });
  const sql = auto.executados.find((e) => /FROM agenda_saloes s/.test(e.sql))!.sql;
  assert.match(sql, /\$9::int IS NULL OR \(\(s\.capacidade_convidados IS NULL OR \$9::int <= s\.capacidade_convidados\) AND \(s\.convidados_minimo IS NULL OR \$9::int >= s\.convidados_minimo\)\)/, "comporta estrito: mínimo e máximo");
  assert.match(sql, /ORDER BY s\.capacidade_convidados NULLS LAST, s\.ordem, s\.id/);
  const doc = agenda({ ...festaPorSalao, salao_id: null }, (somente) => (somente === "D" ? [{ id: "D", nome: "Salão D" }] : [{ id: "C", nome: "Salão C" }]));
  assert.deepEqual(await escolherSalaoParaEmissao(doc as unknown as DbExecutor, "f", "D"), { porSalao: true, salao: { id: "D", nome: "Salão D" } }, "o documento não troca sozinho");
  const nenhum = agenda({ ...festaPorSalao, salao_id: null }, () => []);
  assert.deepEqual(await escolherSalaoParaEmissao(nenhum as unknown as DbExecutor, "f"), { porSalao: true, salao: null, motivo: "SEM_SALAO_QUE_SERVE" });
  for (const b of [equipe, auto, doc, nenhum]) assert.ok(!b.executados.some((e) => /^\s*UPDATE/i.test(e.sql)), "emissão só lê");
  const horario = agenda({ ...festaPorSalao, por_salao: false, salao_id: null }, () => []);
  assert.deepEqual(await escolherSalaoParaEmissao(horario as unknown as DbExecutor, "f"), { porSalao: false });
});

test("proposta (revisão inicial): o salão gravado só conta como escolha da equipe se o destino não muda", async () => {
  const b = agenda({ ...festaPorSalao, salao_id: "A" }, (somente) => (somente === "A" ? [{ id: "A", nome: "A" }] : [{ id: "C", nome: "C" }]));
  const mesmo = { data: "2026-12-05", inicio: "15:00", fim: "19:00", configuracaoId: "cfg", pacoteId: "pac", convidados: 80 };
  assert.deepEqual(await escolherSalaoParaEmissao(b as unknown as DbExecutor, "f", null, mesmo), { porSalao: true, salao: { id: "A", nome: "A" } });
  assert.deepEqual(await escolherSalaoParaEmissao(b as unknown as DbExecutor, "f", null, { ...mesmo, data: "2026-12-06" }), { porSalao: true, salao: { id: "C", nome: "C" } });
  const alvo = b.executados.filter((e) => /FROM agenda_saloes s/.test(e.sql)).at(-1)!;
  assert.equal(alvo.params[1], "2026-12-06", "a escolha usa o destino proposto");
});

test("salão exigido na festa: confere e grava; festa em outro salão ou exigido indisponível = sem salão; nunca substitui", async () => {
  const livre = agenda({ ...festaPorSalao, salao_id: null }, (somente) => (somente === "A" ? [{ id: "A", nome: "A" }] : [{ id: "C", nome: "C" }]));
  assert.deepEqual(await escolherSalao(livre as unknown as DbExecutor, "f", "A"), { exigido: true, salao: "A" });
  assert.ok(livre.executados.some((e) => /UPDATE fechamentos SET salao_id/.test(e.sql)));
  const outro = agenda({ ...festaPorSalao, salao_id: "B" }, () => [{ id: "A", nome: "A" }]);
  assert.deepEqual(await escolherSalao(outro as unknown as DbExecutor, "f", "A"), { exigido: true, salao: null });
  assert.ok(!outro.executados.some((e) => /^\s*UPDATE/i.test(e.sql)));
  const ocupado = agenda({ ...festaPorSalao, salao_id: null }, (somente) => (somente === "A" ? [] : [{ id: "C", nome: "C" }]));
  assert.deepEqual(await escolherSalao(ocupado as unknown as DbExecutor, "f", "A"), { exigido: true, salao: null }, "sem substituto C");
  assert.ok(!ocupado.executados.some((e) => /^\s*UPDATE/i.test(e.sql)));
});

test("P1 (27/10): destino × documento independe do hash — salão diferente do V3 acusa; V1/V2 não fixam; fora de POR_SALAO = sem salão", async () => {
  const destino = (porSalao: boolean, salao: string | null) => executorFalso([
    [/to_regprocedure\('public\.kidmais094_conflito_ocupacao/, () => [{ ok: true }]],
    [/FROM fechamento_revisoes r JOIN fechamentos f/, () => [{ por_salao: porSalao, id: salao, nome: salao ? `Salão ${salao}` : null }]],
  ]) as unknown as DbExecutor;
  assert.equal(await destinoDifereDoDocumento(destino(true, "C"), "rev", v3({ id: "B", nome: "B" })), true, "documento diz B, destino C (hash v1 igual)");
  assert.equal(await destinoDifereDoDocumento(destino(true, "B"), "rev", v3({ id: "B", nome: "B" })), false);
  assert.equal(await destinoDifereDoDocumento(destino(true, null), "rev", v3({ id: "B", nome: "B" })), true, "destino sem salão");
  assert.equal(await destinoDifereDoDocumento(destino(false, null), "rev", v3(null)), false, "fora de POR_SALAO, V3 sem salão");
  assert.equal(await destinoDifereDoDocumento(destino(true, "C"), "rev", v1), false, "V1 nunca escreveu salão");
});

test("P1 (27/10): o serviço confere destino × documento DEPOIS da revalidação no PDF/revisar/assinar e na revalidação manual", async () => {
  const { readFileSync } = await import("node:fs");
  const fonte = readFileSync(new URL("./administrativo.service.ts", import.meta.url), "utf8");
  assert.match(fonte, /const revalidada=\(await revalidarAgendaRevisao\(tx,preparacao,rc\)\)\.revisao;\s*if\(revalidada\.conteudo_hash!==preparacao\.conteudo_hash\|\|await destinoDifereDoDocumento\(tx,revalidada\.id,v\.snapshot\)\)conflito\('O salão do destino mudou/);
  assert.match(fonte, /relida\.estado==='EM_ELABORACAO'&&\(relida\.conteudo_hash!==preparacao\.conteudo_hash\|\|await destinoDifereDoDocumento\(tx,relida\.id,v\.snapshot\)\)/);
});

test("rodada 2: salão exigido da BASE (assinatura de revisão) não reavalia a capacidade; o da própria versão reavalia", async () => {
  const b = agenda({ ...festaPorSalao, salao_id: "A", convidados: 30 }, (somente) => (somente === "A" ? [{ id: "A", nome: "A" }] : []));
  assert.deepEqual(await escolherSalao(b as unknown as DbExecutor, "f", "A", { capacidade: false }), { exigido: true, salao: "A" });
  assert.equal(b.executados.find((e) => /FROM agenda_saloes s/.test(e.sql))!.params[8], null, "convidados nulos: sem filtro de capacidade");
  await escolherSalao(b as unknown as DbExecutor, "f", "A");
  assert.equal(b.executados.filter((e) => /FROM agenda_saloes s/.test(e.sql)).at(-1)!.params[8], 30, "padrão: capacidade estrita");
  const { readFileSync } = await import("node:fs");
  assert.match(readFileSync(new URL("../../festas/formalizacao.ts", import.meta.url), "utf8"), /escolherSalaoDoContrato\(tx, contratoId, exigido\?\.salaoId, \{ capacidade: !exigido\?\.daBase \}\)/);
});

test("rótulo do salão: nome que já começa com 'Salão' não duplica", async () => {
  const { rotuloSalao } = await import("../repositories/models.ts");
  assert.equal(rotuloSalao("Jardim"), "salão Jardim");
  assert.equal(rotuloSalao("Jardim", true), "Salão Jardim");
  assert.equal(rotuloSalao("Salão Kids"), "Salão Kids");
  assert.equal(rotuloSalao("salao azul", true), "salao azul");
  assert.equal(rotuloSalao("Salãozinho"), "salão Salãozinho");
});
