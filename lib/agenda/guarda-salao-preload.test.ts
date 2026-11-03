import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Plano "liberar agenda com mais de um salão", rodada 2 (P2 do Astra no preload): a ordem "configuração antes" vale para
 * transação que só tem trava/DML de LINHA nas tabelas inventariadas (antes saía sem avaliação) e para o autocommit.
 * Sem PG: um processo filho troca o `query` do driver por um falso ANTES de carregar o preload real e roda as sequências.
 */
const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PRELOAD = join(raiz, "scripts/guarda-salao-preload.cjs");
const PG = join(raiz, "node_modules/pg");
const CONFIG = "SELECT pg_advisory_xact_lock_shared(hashtextextended('kidmais:agenda-config:' || $1::text, 0))";

type Evento = { tipo: string; motivo?: string; autocommit?: boolean; desfecho?: string };

function rodar(sequencias: string[][]): Evento[][] {
  const dir = mkdtempSync(join(tmpdir(), "guarda-preload-"));
  try {
    const filho = join(dir, "filho.cjs");
    writeFileSync(filho, [
      "const pg = require(" + JSON.stringify(PG) + ");",
      "pg.Client.prototype.query = function () { return Promise.resolve({ rows: [] }); };",
      "require(" + JSON.stringify(PRELOAD) + ");",
      "const fs = require('node:fs');",
      "(async () => {",
      "  for (const [i, seq] of JSON.parse(process.argv[2]).entries()) {",
      "    const c = new pg.Client();",
      "    for (const q of seq) await c.query(q);",
      "    fs.appendFileSync(process.env.KIDMAIS_GUARDA_SALAO_ARQUIVO, JSON.stringify({ tipo: 'FIM', i }) + '\\n');",
      "  }",
      "})();",
    ].join("\n"));
    const arquivo = join(dir, "guarda.jsonl");
    const r = spawnSync(process.execPath, [filho, JSON.stringify(sequencias)], {
      env: { PATH: process.env.PATH ?? "", KIDMAIS_GUARDA_SALAO_ARQUIVO: arquivo, KIDMAIS_REGISTRO_TRANSACOES_ARQUIVO: "1" } as unknown as NodeJS.ProcessEnv,
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(arquivo), "o preload registra no arquivo");
    const linhas = readFileSync(arquivo, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Evento & { i?: number });
    assert.equal(linhas[0]!.tipo, "PRELOAD");
    const porSequencia: Evento[][] = sequencias.map(() => []);
    let atual = 0;
    for (const e of linhas.slice(1)) {
      if (e.tipo === "FIM") { atual = e.i! + 1; continue; }
      porSequencia[atual]!.push(e);
    }
    return porSequencia;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const ordens = (es: Evento[]) => es.filter((e) => e.tipo === "ORDEM");

test("rodada 2 (P2 do Astra): transação só com LINHA e autocommit são avaliados; controle com a configuração antes passa", () => {
  const [soLinha, soTrava, autocommit, controle, configDepois, semTabela] = rodar([
    ["BEGIN", "UPDATE fechamentos SET status = 'AGUARDANDO_PAGAMENTO' WHERE id = $1", "COMMIT"],
    ["BEGIN", "SELECT id FROM contratos WHERE id = $1 FOR UPDATE", "ROLLBACK"],
    ["UPDATE fechamentos SET status = 'CANCELADO' WHERE id = $1"],
    ["BEGIN", CONFIG, "UPDATE fechamentos SET status = 'AGUARDANDO_PAGAMENTO' WHERE id = $1", "COMMIT"],
    ["BEGIN", "INSERT INTO pagamentos (id) VALUES ($1)", CONFIG, "COMMIT"],
    ["BEGIN", "UPDATE clientes SET nome = 'x' WHERE id = $1", "COMMIT"],
  ]);
  // Controle negativo: só LINHA (DML) → ORDEM "sem a configuração" (antes da rodada 2: nenhum evento).
  assert.equal(ordens(soLinha!).length, 1, JSON.stringify(soLinha));
  assert.match(ordens(soLinha!)[0]!.motivo!, /^LINHA sem a configuração: UPDATE fechamentos/);
  assert.equal(ordens(soTrava!).length, 1, "só FOR UPDATE de linha também");
  assert.match(ordens(soTrava!)[0]!.motivo!, /^LINHA sem a configuração: SELECT id FROM contratos/);
  // Autocommit: nenhuma configuração pode valer → sempre ORDEM.
  assert.equal(ordens(autocommit!).length, 1);
  assert.equal(ordens(autocommit!)[0]!.autocommit, true);
  // Controle de sucesso: a configuração antes da primeira LINHA não gera ORDEM; a transação é registrada inteira.
  assert.deepEqual(ordens(controle!), []);
  assert.deepEqual(controle!.filter((e) => e.tipo === "TRANSACAO").length, 1);
  // Configuração depois da linha → ORDEM "antes da configuração".
  assert.equal(ordens(configDepois!).length, 1);
  assert.match(ordens(configDepois!)[0]!.motivo!, /^LINHA antes da configuração: INSERT INTO pagamentos/);
  // Tabela fora do inventário não é LINHA.
  assert.deepEqual(ordens(semTabela!), []);
});

test("rodada 2: FOR UPDATE trava só o FROM do próprio nível — subconsulta EXISTS em tabela da agenda não é LINHA; trava dentro de subconsulta é", async () => {
  const { createRequire } = await import("node:module");
  const { classificarComando } = createRequire(import.meta.url)("../../scripts/guarda-salao-harness.cjs") as { classificarComando: (t: string) => string | null };
  // pacotes-admin.ts (buscar com travar): só pacotes é travado; fechamentos/fechamento_revisoes só aparecem no EXISTS.
  assert.equal(classificarComando(`SELECT p.id, (EXISTS (SELECT 1 FROM fechamentos f WHERE f.pacote_id = p.id) OR EXISTS (SELECT 1 FROM fechamento_revisoes r WHERE r.pacote_id = p.id)) AS utilizado FROM pacotes p WHERE p.id = $1 FOR UPDATE`), null);
  assert.equal(classificarComando(`SELECT s.id FROM (SELECT id FROM fechamentos WHERE id = $1 FOR UPDATE) s`), "LINHA");
  assert.equal(classificarComando(`WITH alvo AS (SELECT id FROM contratos WHERE id = $1 FOR UPDATE) SELECT * FROM alvo`), "LINHA");
  assert.equal(classificarComando(`SELECT f.id FROM fechamentos f JOIN (SELECT 1 AS x) y ON true WHERE f.id = $1 FOR UPDATE OF f`), "LINHA");
  assert.equal(classificarComando(`SELECT id FROM agenda_saloes WHERE empresa_id = $1 AND (ativo OR true) FOR SHARE`), "AGENDA");
  assert.equal(classificarComando(`UPDATE fechamentos SET status = $1 WHERE id = (SELECT id FROM pacotes LIMIT 1)`), "LINHA");
});

test("rodada 2: nome de função de agenda só conta fora de literal (catálogo); chave advisory no literal continua AGENDA", async () => {
  const { createRequire } = await import("node:module");
  const { classificarComando } = createRequire(import.meta.url)("../../scripts/guarda-salao-harness.cjs") as { classificarComando: (t: string) => string | null };
  assert.equal(classificarComando(`SELECT count(*) FROM pg_proc WHERE proname = ANY (ARRAY['kidmais019_bloquear_contrato','kidmais_lock_datas_revisao'])`), null);
  assert.equal(classificarComando(`SELECT public.kidmais019_bloquear_contrato($1::uuid)`), "AGENDA");
  assert.equal(classificarComando(`SELECT kidmais_lock_datas_revisao($1)`), "AGENDA");
  assert.equal(classificarComando(`SELECT pg_advisory_xact_lock(hashtextextended('kidmais:agenda:' || $1, 0))`), "AGENDA");
  assert.equal(classificarComando(`SELECT pg_advisory_xact_lock_shared(hashtextextended('kidmais:agenda-config:' || $1::text, 0))`), "CONFIG");
});

/**
 * Rodada 3 (P2 do Astra, proveniência): serviço REAL transpilado (carregador por new Function, como nas suítes PG) que emite o
 * SQL por um executor/wrapper do teste. Antes, o primeiro quadro reconhecido era o wrapper e a ORDEM saía como "de teste".
 */
function rodarProveniencia(): Array<{ caso: string; ordens: Array<{ emissor?: string; producao?: boolean; pilha?: string[]; motivo?: string }> }> {
  const dir = mkdtempSync(join(tmpdir(), "guarda-proveniencia-"));
  try {
    const filho = join(dir, "filho.test.cjs"); // rodada 3.1 (P3-2 do Astra): wrapper com nome de teste em qualquer versão da guarda
    const TS = join(raiz, "node_modules/typescript");
    writeFileSync(filho, [
      "const pg = require(" + JSON.stringify(PG) + ");",
      "pg.Client.prototype.query = function () { return Promise.resolve({ rows: [] }); };",
      "require(" + JSON.stringify(PRELOAD) + ");",
      "const fs = require('node:fs'); const ts = require(" + JSON.stringify(TS) + ");",
      // Carregador igual ao das suítes: lê o .ts, transpila e avalia com new Function; dependências simuladas.
      "function carregar(rel) { const code = ts.transpileModule(fs.readFileSync(" + JSON.stringify(raiz) + " + '/' + rel, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;",
      "  const exports = {}; new Function('require', 'exports', code)(() => ({}), exports); return exports; }",
      "const repo = carregar('lib/fechamentos/repositories/fechamento.repository.ts');",
      "const trava = carregar('lib/agenda/trava-configuracao.ts');",
      "const casos = {",
      // Wrapper do teste (este arquivo, fora de lib/app/scripts) encaminhando o SQL do serviço.
      "  servicoSemConfiguracao: async (c) => { const exec = { query: (s, v) => c.query(s, v) }; await repo.buscarFechamentoPorIdParaAtualizacao('f1', exec); },",
      "  fixtureLiteral: async (c) => { await c.query('SELECT id FROM fechamentos WHERE id = $1 FOR UPDATE', ['f1']); },",
      "  servicoCorrigido: async (c) => { const exec = { query: (s, v) => c.query(s, v) }; await trava.travarConfiguracaoAgenda(exec, 'e1', { modo: 'COMPARTILHADA', linha: 'KEY_SHARE' }); await repo.buscarFechamentoPorIdParaAtualizacao('f1', exec); },",
      "  semIdentidade: async (c) => { await new Function('c', \"return c.query('SELECT id FROM contratos WHERE id = $1 FOR UPDATE', ['x'])\")(c); },",
      "};",
      // Quadro de aplicador de migration (identidade pelo filename do vm; o arquivo não é executado): anterior à 114 →
      // APLICADOR_MIGRACAO; 114 ou posterior → PRODUCAO; aplicador que chama código de produção → PRODUCAO.
      "const vm = require('node:vm'); const comoArquivo = (rel) => vm.runInThisContext('(async (f) => { await f(); })', { filename: " + JSON.stringify(raiz) + " + '/' + rel });",
      "casos.aplicador098 = async (c) => { await comoArquivo('scripts/migration-098-comum.cjs')(() => c.query('SELECT id FROM contratos WHERE id = $1 FOR UPDATE', ['x'])); };",
      "casos.aplicador114 = async (c) => { await comoArquivo('scripts/migration-114-comum.cjs')(() => c.query('SELECT id FROM contratos WHERE id = $1 FOR UPDATE', ['x'])); };",
      "casos.aplicadorComServico = async (c) => { const exec = { query: (s, v) => c.query(s, v) }; await comoArquivo('scripts/migration-107-108-comum.cjs')(() => repo.buscarFechamentoPorIdParaAtualizacao('f1', exec)); };",
      "(async () => { for (const [caso, f] of Object.entries(casos)) { const c = new pg.Client(); await c.query('BEGIN'); await f(c); await c.query('COMMIT');",
      "  fs.appendFileSync(process.env.KIDMAIS_GUARDA_SALAO_ARQUIVO, JSON.stringify({ tipo: 'FIM', caso }) + '\\n'); } })();",
    ].join("\n"));
    const arquivo = join(dir, "guarda.jsonl");
    const r = spawnSync(process.execPath, [filho], {
      env: { PATH: process.env.PATH ?? "", KIDMAIS_GUARDA_SALAO_ARQUIVO: arquivo } as unknown as NodeJS.ProcessEnv, encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    const saida: Array<{ caso: string; ordens: Array<{ emissor?: string; producao?: boolean; pilha?: string[]; motivo?: string }> }> = [];
    let atuais: Array<{ tipo: string; emissor?: string; producao?: boolean; pilha?: string[]; motivo?: string }> = [];
    for (const e of readFileSync(arquivo, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { tipo: string; caso?: string })) {
      if (e.tipo === "FIM") { saida.push({ caso: e.caso!, ordens: atuais.filter((x) => x.tipo === "ORDEM") }); atuais = []; } else atuais.push(e);
    }
    return saida;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("rodada 3 (P2 do Astra): serviço real transpilado → wrapper do teste → pg sem configuração reprova; fixture literal e serviço corrigido são controles separados; código sem identidade fica INDETERMINADO", () => {
  const casos = Object.fromEntries(rodarProveniencia().map((c) => [c.caso, c.ordens]));
  // Controle negativo: SQL interpolado do repositório real, emitido pelo wrapper do teste → PRODUCAO (reprova).
  // Rodada 3.1 (P3-2 do Astra): primeiro o booleano que reprova (existe em toda versão do preload), depois emissor/arquivo.
  assert.equal(casos.servicoSemConfiguracao.length, 1, JSON.stringify(casos.servicoSemConfiguracao));
  assert.equal(casos.servicoSemConfiguracao[0].producao, true, JSON.stringify(casos.servicoSemConfiguracao[0]));
  assert.equal(casos.servicoSemConfiguracao[0].emissor, "PRODUCAO");
  assert.match(casos.servicoSemConfiguracao[0].motivo!, /^LINHA sem a configuração: SELECT .*condicao_pagamento/);
  assert.ok(casos.servicoSemConfiguracao[0].pilha!.some((q) => q.startsWith("lib/fechamentos/repositories/fechamento.repository.ts:")), JSON.stringify(casos.servicoSemConfiguracao[0].pilha));
  // Fixture literal do teste: continua de teste (listada, não reprova).
  assert.equal(casos.fixtureLiteral.length, 1);
  assert.equal(casos.fixtureLiteral[0].emissor, "TESTE");
  assert.equal(casos.fixtureLiteral[0].producao, false);
  // Serviço corrigido (configuração real antes do FOR UPDATE): nenhuma ORDEM.
  assert.deepEqual(casos.servicoCorrigido, []);
  // Código avaliado sem identidade: o emissor não é determinável → INDETERMINADO (reprova até auditoria).
  assert.equal(casos.semIdentidade.length, 1);
  assert.equal(casos.semIdentidade[0].emissor, "INDETERMINADO");
  assert.equal(casos.semIdentidade[0].producao, true);
  // Aplicador de migration anterior à 114 (auditado): listado à parte, não reprova; 114+ ou com produção dentro reprova.
  assert.equal(casos.aplicador098.length, 1, JSON.stringify(casos.aplicador098));
  assert.equal(casos.aplicador098[0].emissor, "APLICADOR_MIGRACAO");
  assert.equal(casos.aplicador098[0].producao, false);
  assert.equal(casos.aplicador114[0]?.emissor, "PRODUCAO", JSON.stringify(casos.aplicador114));
  assert.equal(casos.aplicador114[0].producao, true);
  assert.equal(casos.aplicadorComServico[0]?.emissor, "PRODUCAO", JSON.stringify(casos.aplicadorComServico));
  assert.equal(casos.aplicadorComServico[0].producao, true);
});
