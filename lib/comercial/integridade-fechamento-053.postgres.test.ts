import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import ts from "typescript";
import type { DbExecutor } from "../db/contracts.ts";
import { conectarDescartavel, encerrarDescartavel, semTransacaoExplicita } from "./postgres-descartavel.ts";
import { listarAdicionaisAtivosComPreco } from "./repositories/comercial.repository.ts";
import { listarCodigosInclusos } from "./composicao.ts";

const req = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const migration053 = resolve(root, "database/migrations/20260928_053_integridade_tenant_fechamento.sql");
const precheck053 = resolve(root, "database/checks/20260928_053_precheck.sql");
const postcheck053 = resolve(root, "database/checks/20260928_053_postcheck.sql");
const down053 = resolve(root, "database/rollback/20260928_053_integridade_tenant_fechamento_down.sql");
const HASH = "a".repeat(64);
const PREFIXO = "Fixture 053";

function texto(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function codigo(prefixo: string) {
  return `${prefixo}${randomBytes(4).toString("hex")}`;
}

function executor(db: Client): DbExecutor {
  return {
    async query<Row extends object>(text: string, values?: readonly unknown[]) {
      const result = await db.query(text, values as unknown[]);
      return { rows: result.rows as Row[], rowCount: result.rowCount };
    },
  };
}

/** fechamento.repository usa imports sem extensão: carregado transpilado, como nos testes de Fechamento. */
function carregarModulo(arquivo: string): Record<string, unknown> {
  const cache = new Map<string, Record<string, unknown>>();
  const caminho = (base: string) => [`${base}.ts`, `${base}/index.ts`, base].find(existsSync) ?? base;
  function load(file: string): Record<string, unknown> {
    const hit = cache.get(file);
    if (hit) return hit;
    const exports: Record<string, unknown> = {};
    cache.set(file, exports);
    const code = ts.transpileModule(readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const localRequire = (spec: string) => spec.startsWith(".")
      ? load(caminho(resolve(dirname(file), spec).replace(/\.ts$/, "")))
      : req(spec);
    new Function("require", "exports", code)(localRequire, exports);
    return exports;
  }
  return load(resolve(root, arquivo));
}

async function recusa(db: Client, sql: string, params: unknown[], trecho: string) {
  await db.query("SAVEPOINT prova");
  let message = "passou";
  try {
    await db.query(sql, params);
  } catch (error) {
    message = texto(error);
  }
  await db.query("ROLLBACK TO SAVEPOINT prova");
  assert.equal(message.includes(trecho), true, `${trecho}: ${message}`);
}

async function aceita(db: Client, sql: string, params: unknown[]) {
  await db.query("SAVEPOINT prova");
  try {
    await db.query(sql, params);
  } finally {
    await db.query("ROLLBACK TO SAVEPOINT prova");
  }
}

async function id(db: Client, sql: string, params: unknown[]) {
  return (await db.query<{ id: string }>(sql, params)).rows[0].id;
}

type Catalogo = {
  empresa: string | null;
  pacote: string;
  pacote2: string;
  tabela: string;
  tabela2: string;
  preco: string;
  precoTabela2: string;
  preco2: string;
  desconto: string;
  desconto2: string;
  adicional: string;
  categoria: string;
  precoAdicional: string;
  precoAdicionalTabela2: string;
};

/** Catálogo de uma empresa; `legado` cria tudo sem empresa (NULL/NULL). */
async function catalogo(db: Client, nome: string, legado = false): Promise<Catalogo> {
  const empresa = legado
    ? null
    : await id(db, `INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id`, [codigo("e53"), `${PREFIXO} ${nome}`]);
  const pacote = await id(db, `INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente) VALUES ($1::uuid, $2, $3, 530, true, true) RETURNING id`, [empresa, codigo("P53").toUpperCase(), `${PREFIXO} ${nome}`]);
  const pacote2 = await id(db, `INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente) VALUES ($1::uuid, $2, $3, 531, true, true) RETURNING id`, [empresa, codigo("P53").toUpperCase(), `${PREFIXO} ${nome} 2`]);
  const tabela = await id(db, `INSERT INTO tabelas_preco (empresa_id, codigo, nome, vigencia_inicio, ativa) VALUES ($1::uuid, $2, $3, '2026-01-01', false) RETURNING id`, [empresa, codigo("t53"), `${PREFIXO} ${nome}`]);
  const tabela2 = await id(db, `INSERT INTO tabelas_preco (empresa_id, codigo, nome, vigencia_inicio, ativa) VALUES ($1::uuid, $2, $3, '2026-01-01', false) RETURNING id`, [empresa, codigo("t53"), `${PREFIXO} ${nome} 2`]);
  const precoSql = `INSERT INTO precos_pacote (tabela_preco_id, pacote_id, convidados_min, tipo_calculo, valor, categoria_horario) VALUES ($1::uuid, $2::uuid, 1, 'FIXO', 100, 'PADRAO') RETURNING id`;
  const preco = await id(db, precoSql, [tabela, pacote]);
  const precoTabela2 = await id(db, precoSql, [tabela2, pacote]);
  const preco2 = await id(db, precoSql, [tabela, pacote2]);
  const descontoSql = `INSERT INTO regras_desconto_pacote (pacote_id, dia_semana, percentual, codigo, vigencia_inicio) VALUES ($1::uuid, 1, 10, $2, '2026-01-01') RETURNING id`;
  const desconto = await id(db, descontoSql, [pacote, codigo("d53")]);
  const desconto2 = await id(db, descontoSql, [pacote2, codigo("d53")]);
  const categoriaCodigo = codigo("ac53");
  const categoria = await id(db, `INSERT INTO adicional_categorias (codigo, nome) VALUES ($1, 'Categoria 053') RETURNING id`, [categoriaCodigo]);
  const adicional = await id(db, `INSERT INTO adicionais (empresa_id, codigo, nome, categoria, categoria_id, unidade_cobranca, ordem_exibicao) VALUES ($1::uuid, $2, 'Adicional 053', $3, $4::uuid, 'PACOTE', 1) RETURNING id`, [empresa, codigo("A53").toUpperCase(), categoriaCodigo, categoria]);
  const precoAdicionalSql = `INSERT INTO precos_adicional (tabela_preco_id, adicional_id, convidados_min, convidados_max, valor) VALUES ($1::uuid, $2::uuid, 1, NULL, 25) RETURNING id`;
  const precoAdicional = await id(db, precoAdicionalSql, [tabela, adicional]);
  const precoAdicionalTabela2 = await id(db, precoAdicionalSql, [tabela2, adicional]);
  return { empresa, pacote, pacote2, tabela, tabela2, preco, precoTabela2, preco2, desconto, desconto2, adicional, categoria, precoAdicional, precoAdicionalTabela2 };
}

async function apoio(db: Client) {
  const agenda = await id(db, `INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, ordem_exibicao) VALUES ($1, $2, '10:00', '18:00', 53) RETURNING id`, [codigo("ag53"), PREFIXO]);
  const cliente = await id(db, `INSERT INTO clientes (nome_completo) VALUES ($1) RETURNING id`, [PREFIXO]);
  const usuario = await id(db, `INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, $2, $3, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id`, [`${codigo("u53")}@example.test`, PREFIXO, `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`]);
  return { agenda, cliente, usuario };
}

const INSERIR_FECHAMENTO = `INSERT INTO fechamentos (
  data_evento, horario_inicio, horario_fim, configuracao_agenda_id, pacote_id, tabela_preco_id, preco_pacote_id,
  regra_desconto_pacote_id, categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados,
  valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status
) VALUES ('2031-03-01', '14:00', '18:00', $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
  'PADRAO', 'PADRAO', 20, 20, 100, 100, 100, 'ATENDIMENTO_KIDMAIS', $6::uuid, 'RASCUNHO') RETURNING id`;

const INSERIR_ADICIONAL = `INSERT INTO fechamento_adicionais (
  fechamento_id, adicional_id, preco_adicional_id, nome_aplicado, unidade_cobranca_aplicada, quantidade, valor_unitario_aplicado, valor_total
) VALUES ($1::uuid, $2::uuid, $3::uuid, 'Adicional 053', 'PACOTE', 1, 25, 25)`;

const INSERIR_FOTOGRAFIA = `INSERT INTO fechamento_pacote_snapshots (
  fechamento_id, sequencia, pacote_id, codigo_aplicado, nome_aplicado, tabela_preco_id, tabela_codigo_aplicado,
  tabela_nome_aplicado, preco_pacote_id, tipo_calculo, convidados_min_faixa, categoria_preco_linha, valor_linha,
  categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, desconto_percentual,
  valor_pacote_base, valor_desconto_pacote, valor_pacote_aplicado, valor_adicionais, valor_tabela, snapshot_anterior_id
) VALUES ($1::uuid, $2, $3::uuid, 'P53', 'Pacote 053', $4::uuid, 'T53', 'Tabela 053', $5::uuid, 'FIXO', 1, 'PADRAO', 100,
  'PADRAO', 'PADRAO', 20, 20, 0, 100, 0, 100, 0, 100, $6::uuid) RETURNING id`;

const INSERIR_REVISAO = `INSERT INTO fechamento_revisoes (
  fechamento_id, contrato_id, contrato_versao_id, versao_base_id, motivo, chave_criacao, fonte_base_hash, conteudo_hash,
  criado_por_usuario_id, atualizado_por_usuario_id, cliente_id, data_evento, horario_inicio, horario_fim,
  configuracao_agenda_id, pacote_id, tabela_preco_id, preco_pacote_id, regra_desconto_pacote_id, categoria_horario,
  categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela
) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'Revisão 053', $5::uuid, '${HASH}', '${HASH}', $6::uuid, $6::uuid, $7::uuid,
  '2031-03-01', '14:00', '18:00', $8::uuid, $9::uuid, $10::uuid, $11::uuid, $12::uuid, 'PADRAO', 'PADRAO', 20, 20, 100, 100, 100) RETURNING id`;

const INSERIR_ADICIONAL_REVISAO = `INSERT INTO fechamento_revisao_adicionais (
  fechamento_revisao_id, adicional_id, preco_adicional_id, nome_aplicado, unidade_cobranca_aplicada, quantidade, valor_unitario_aplicado, valor_total
) VALUES ($1::uuid, $2::uuid, $3::uuid, 'Adicional 053', 'PACOTE', 1, 25, 25)`;

/** Contrato com versão base (substituída) e versão em preparação: base mínima da revisão operacional. */
async function contratoDoFechamento(db: Client, fechamento: string) {
  const contrato = await id(db, `INSERT INTO contratos (fechamento_id, status) VALUES ($1::uuid, 'AGUARDANDO_ASSINATURA') RETURNING id`, [fechamento]);
  const versaoBase = await id(db, `INSERT INTO contrato_versoes (contrato_id, numero_versao, status, snapshot, snapshot_hash, substituido_em) VALUES ($1::uuid, 1, 'SUBSTITUIDA', '{}'::jsonb, $2, now()) RETURNING id`, [contrato, HASH]);
  const versaoNova = await id(db, `INSERT INTO contrato_versoes (contrato_id, numero_versao, status, snapshot, snapshot_hash) VALUES ($1::uuid, 2, 'ATIVA', '{}'::jsonb, $2) RETURNING id`, [contrato, HASH]);
  return { contrato, versaoBase, versaoNova };
}

async function instalada(db: Client) {
  return (await db.query<{ ok: boolean }>("SELECT to_regprocedure('public.kidmais_053_falhar_se_incompativel()') IS NOT NULL AS ok")).rows[0].ok;
}

async function objetos053(db: Client) {
  return (await db.query<{ funcoes: number; gatilhos: number; fk: number }>(
    `SELECT (SELECT count(*)::int FROM pg_proc WHERE proname LIKE 'kidmais\\_053\\_%') AS funcoes,
            (SELECT count(*)::int FROM pg_trigger WHERE tgname LIKE '%\\_053\\_%' AND NOT tgisinternal) AS gatilhos,
            (SELECT count(*)::int FROM pg_constraint WHERE conname = 'fechamento_pacote_snapshots_anterior_mesmo_fechamento_fk') AS fk`,
  )).rows[0];
}

/** Espera a conexão ficar bloqueada por outra (prova de que a trava de linha está em jogo). */
async function esperarBloqueio(observador: Client, pid: number) {
  for (let tentativa = 0; tentativa < 200; tentativa++) {
    const r = await observador.query<{ bloqueado: boolean }>("SELECT cardinality(pg_blocking_pids($1::int)) > 0 AS bloqueado", [pid]);
    if (r.rows[0].bloqueado) return;
    await new Promise((fim) => setTimeout(fim, 25));
  }
  assert.fail(`a conexão ${pid} não ficou bloqueada`);
}

test("integridade de tenant do fechamento 053 no postgres descartável", { timeout: 300_000 }, async () => {
  const client = await conectarDescartavel();
  const db = client as unknown as Client;
  const fonte = readFileSync(migration053, "utf8");
  let instalouAqui = false;
  try {
    const ident = await db.query<{ db: string; port: number }>("SELECT current_database() AS db, inet_server_port() AS port");
    assert.equal(ident.rows[0].db, "kidmais_pacotes_v1_descartavel");
    assert.equal(Number(ident.rows[0].port), 55498);
    assert.equal(process.env.KIDMAIS_POSTGRES_DESCARTAVEL, "kidmais_pacotes_v1_descartavel");
    assert.equal(process.env.DATABASE_URL, undefined);
    assert.equal(/\b(UPDATE|DELETE FROM|INSERT INTO)\s+(public\.)?(fechamentos|fechamento_\w+|pacotes|tabelas_preco|adicionais|precos_\w+|regras_\w+)\b/i.test(fonte), false, "a 053 não reescreve dado");

    // Ciclo autorizado: precheck → migration → postcheck ... rollback no fim.
    if (!(await instalada(db))) {
      await db.query(readFileSync(precheck053, "utf8"));
      await db.query(fonte);
      instalouAqui = true;
    }
    await db.query(readFileSync(postcheck053, "utf8"));
    const funcoesSearchPath = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_proc WHERE proname LIKE 'kidmais\\_053\\_%' AND proconfig @> ARRAY['search_path=pg_catalog, pg_temp']",
    );
    assert.equal(funcoesSearchPath.rows[0].n, 15, "search_path fixo em todas as funções da 053");

    await concorrencia(db);
    await principal(db, fonte);
    await trocaDeTabelaNoCommit(db);
  } finally {
    try {
      if (instalouAqui) {
        await db.query("ROLLBACK").catch(() => {});
        const antes = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM fechamentos");
        await db.query(readFileSync(down053, "utf8"));
        assert.deepEqual(await objetos053(db), { funcoes: 0, gatilhos: 0, fk: 0 }, "rollback oficial removeu a 053");
        const depois = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM fechamentos");
        assert.equal(depois.rows[0].n, antes.rows[0].n, "o rollback não apaga fechamento");
      }
      const sobra = await db.query<{ n: number }>(
        "SELECT (SELECT count(*) FROM empresas WHERE nome LIKE $1) + (SELECT count(*) FROM pacotes WHERE nome LIKE $1) + (SELECT count(*) FROM clientes WHERE nome_completo LIKE $1) AS n",
        [`${PREFIXO}%`],
      );
      assert.equal(Number(sobra.rows[0].n), 0, "nenhuma fixture do teste permanece");
    } finally {
      await encerrarDescartavel(client);
    }
  }
});

/** A4: reatribuição de preço/desconto e primeira utilização concorrentes, com duas conexões. */
async function concorrencia(db: Client) {
  const c1 = (await conectarDescartavel({ travar: false })) as unknown as Client;
  const c2 = (await conectarDescartavel({ travar: false })) as unknown as Client;
  const criados = { fechamentos: [] as string[] };
  // Fixtures confirmadas (duas conexões precisam vê-las). Catálogo legado: é removível no fim.
  const cat = await catalogo(db, "concorrência", true);
  const base = await apoio(db);
  // Destino da reatribuição sem faixa na tabela (o gatilho de sobreposição de faixas da 006 continua valendo).
  const pacote3 = await id(db, `INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente) VALUES (NULL, $1, $2, 532, true, true) RETURNING id`, [codigo("P53").toUpperCase(), `${PREFIXO} concorrência 3`]);
  const precoZ = cat.precoTabela2;
  // Segundo catálogo legado para F1 (troca de tabela × inclusão de filho) e para o preço de adicional.
  const cat2 = await catalogo(db, "concorrência F1", true);
  const categoria2 = (await db.query<{ codigo: string }>("SELECT codigo FROM adicional_categorias WHERE id = $1::uuid", [cat2.categoria])).rows[0].codigo;
  const novoAdicional = () => id(db, `INSERT INTO adicionais (empresa_id, codigo, nome, categoria, categoria_id, unidade_cobranca, ordem_exibicao) VALUES (NULL, $1, 'Adicional F1', $2, $3::uuid, 'PACOTE', 2) RETURNING id`, [codigo("A53").toUpperCase(), categoria2, cat2.categoria]);
  const adicional2 = await novoAdicional();
  const adicional3 = await novoAdicional();
  const precoA3 = await id(db, `INSERT INTO precos_adicional (tabela_preco_id, adicional_id, convidados_min, convidados_max, valor) VALUES ($1::uuid, $2::uuid, 1, NULL, 25) RETURNING id`, [cat2.tabela, adicional3]);
  const fechamentoF1 = () => id(db, INSERIR_FECHAMENTO, [base.agenda, cat2.pacote, cat2.tabela, cat2.preco, null, base.cliente]);
  const fF = await fechamentoF1();
  const fG = await fechamentoF1();
  const fH = await fechamentoF1();
  criados.fechamentos.push(fF, fG, fH);
  try {
    const pid2 = (await c2.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const pid1 = (await c1.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;

    // Cenário 1: a reatribuição trava a linha primeiro; a primeira utilização espera e vê a linha nova.
    await c1.query("BEGIN");
    await c1.query("UPDATE precos_pacote SET pacote_id = $2::uuid WHERE id = $1::uuid", [cat.preco, pacote3]);
    await c2.query("BEGIN");
    const uso1 = c2.query(INSERIR_FECHAMENTO, [base.agenda, cat.pacote, cat.tabela, cat.preco, null, base.cliente]).then(() => "passou", texto);
    await esperarBloqueio(db, pid2);
    await c1.query("COMMIT");
    const resultado1 = await uso1;
    await c2.query("ROLLBACK");
    assert.equal(resultado1.includes("053: fechamento: preço do pacote"), true, resultado1);
    const reatribuido = await db.query<{ pacote_id: string }>("SELECT pacote_id FROM precos_pacote WHERE id = $1::uuid", [cat.preco]);
    assert.equal(reatribuido.rows[0].pacote_id, pacote3);
    assert.equal((await db.query("SELECT 1 FROM fechamentos WHERE preco_pacote_id = $1::uuid", [cat.preco])).rowCount, 0);

    // Cenário 2: a primeira utilização trava primeiro; a reatribuição espera, vê a utilização e é recusada (030).
    await c2.query("BEGIN");
    const fechamento = await id(c2, INSERIR_FECHAMENTO, [base.agenda, cat.pacote, cat.tabela2, precoZ, null, base.cliente]);
    criados.fechamentos.push(fechamento);
    await c1.query("BEGIN");
    const reatribuicao2 = c1.query("UPDATE precos_pacote SET pacote_id = $2::uuid WHERE id = $1::uuid", [precoZ, pacote3]).then(() => "passou", texto);
    await esperarBloqueio(db, pid1);
    await c2.query("COMMIT");
    const resultado2 = await reatribuicao2;
    await c1.query("ROLLBACK");
    assert.equal(resultado2.includes("030: preço de pacote utilizado"), true, resultado2);
    const intacto = await db.query<{ pacote_id: string }>("SELECT pacote_id FROM precos_pacote WHERE id = $1::uuid", [precoZ]);
    assert.equal(intacto.rows[0].pacote_id, cat.pacote);

    // Cenário 3: desconto — primeira utilização trava primeiro; a reatribuição espera e é recusada (053).
    await c2.query("BEGIN");
    const comDesconto = await id(c2, `${INSERIR_FECHAMENTO.replace("'2031-03-01'", "'2031-03-02'")}`, [base.agenda, cat.pacote, cat.tabela2, precoZ, cat.desconto, base.cliente]);
    criados.fechamentos.push(comDesconto);
    await c1.query("BEGIN");
    const reatribuicao3 = c1.query("UPDATE regras_desconto_pacote SET pacote_id = $2::uuid WHERE id = $1::uuid", [cat.desconto, cat.pacote2]).then(() => "passou", texto);
    await esperarBloqueio(db, pid1);
    await c2.query("COMMIT");
    const resultado3 = await reatribuicao3;
    await c1.query("ROLLBACK");
    assert.equal(resultado3.includes("053: regra de desconto utilizada"), true, resultado3);

    // Cenário 4: desconto — a reatribuição trava primeiro; a primeira utilização espera e vê a linha nova.
    await c1.query("BEGIN");
    await c1.query("UPDATE regras_desconto_pacote SET pacote_id = $2::uuid WHERE id = $1::uuid", [cat.desconto2, cat.pacote]);
    await c2.query("BEGIN");
    const uso4 = c2.query(INSERIR_FECHAMENTO.replace("'2031-03-01'", "'2031-03-03'"), [base.agenda, cat.pacote2, cat.tabela, cat.preco2, cat.desconto2, base.cliente]).then(() => "passou", texto);
    await esperarBloqueio(db, pid2);
    await c1.query("COMMIT");
    const resultado4 = await uso4;
    await c2.query("ROLLBACK");
    assert.equal(resultado4.includes("053: fechamento: regra de desconto"), true, resultado4);

    const tabelaDe = async (fechamentoId: string) =>
      (await db.query<{ tabela_preco_id: string }>("SELECT tabela_preco_id FROM fechamentos WHERE id = $1::uuid", [fechamentoId])).rows[0].tabela_preco_id;
    const filhosDe = async (fechamentoId: string) =>
      (await db.query<{ preco: string }>("SELECT preco_adicional_id AS preco FROM fechamento_adicionais WHERE fechamento_id = $1::uuid", [fechamentoId])).rows.map((r) => r.preco);

    // F1-A: a troca de tabela do pai trava primeiro; o filho da tabela antiga espera, relê o pai e é recusado.
    await c1.query("BEGIN");
    await c1.query("UPDATE fechamentos SET tabela_preco_id = $2::uuid, preco_pacote_id = $3::uuid WHERE id = $1::uuid", [fF, cat2.tabela2, cat2.precoTabela2]);
    await c2.query("BEGIN");
    const filhoA = c2.query(INSERIR_ADICIONAL, [fF, cat2.adicional, cat2.precoAdicional]).then(() => "passou", texto);
    await esperarBloqueio(db, pid2);
    await c1.query("COMMIT");
    const resultadoF1A = await filhoA;
    const commitF1A = resultadoF1A === "passou" ? await c2.query("COMMIT").then(() => "passou", texto) : (await c2.query("ROLLBACK"), "recusado");
    assert.equal(resultadoF1A.includes("053: adicional do fechamento: preço do adicional"), true, `${resultadoF1A} / ${commitF1A}`);
    assert.equal(await tabelaDe(fF), cat2.tabela2);
    assert.deepEqual(await filhosDe(fF), [], "nenhum adicional da tabela antiga confirmado");

    // F1-B: o filho trava o pai primeiro; a troca de tabela espera e não confirma com o filho antigo.
    await c2.query("BEGIN");
    await c2.query(INSERIR_ADICIONAL, [fG, cat2.adicional, cat2.precoAdicional]);
    await c1.query("BEGIN");
    const troca = c1.query("UPDATE fechamentos SET tabela_preco_id = $2::uuid, preco_pacote_id = $3::uuid WHERE id = $1::uuid", [fG, cat2.tabela2, cat2.precoTabela2]).then(() => "passou", texto);
    await esperarBloqueio(db, pid1);
    await c2.query("COMMIT");
    const resultadoTroca = await troca;
    const commitTroca = resultadoTroca === "passou" ? await c1.query("COMMIT").then(() => "passou", texto) : (await c1.query("ROLLBACK"), resultadoTroca);
    assert.equal(commitTroca.includes("053: adicionais do fechamento após troca de tabela ou pacote"), true, `${resultadoTroca} / ${commitTroca}`);
    assert.equal(await tabelaDe(fG), cat2.tabela, "o pai continua na tabela do filho");
    assert.deepEqual(await filhosDe(fG), [cat2.precoAdicional]);

    // Preço de adicional: a primeira utilização trava primeiro; a reatribuição espera e é recusada (030).
    await c2.query("BEGIN");
    await c2.query(INSERIR_ADICIONAL, [fF, cat2.adicional, cat2.precoAdicionalTabela2]);
    await c1.query("BEGIN");
    const reatribuicaoA = c1.query("UPDATE precos_adicional SET adicional_id = $2::uuid WHERE id = $1::uuid", [cat2.precoAdicionalTabela2, adicional2]).then(() => "passou", texto);
    await esperarBloqueio(db, pid1);
    await c2.query("COMMIT");
    const resultadoA = await reatribuicaoA;
    await c1.query("ROLLBACK");
    assert.equal(resultadoA.includes("030: preço de adicional utilizado"), true, resultadoA);
    assert.deepEqual(await filhosDe(fF), [cat2.precoAdicionalTabela2]);

    // Preço de adicional: a reatribuição trava primeiro; a primeira utilização espera, relê o preço e é recusada.
    await c1.query("BEGIN");
    await c1.query("UPDATE precos_adicional SET adicional_id = $2::uuid WHERE id = $1::uuid", [precoA3, adicional2]);
    await c2.query("BEGIN");
    const usoA = c2.query(INSERIR_ADICIONAL, [fH, adicional3, precoA3]).then(() => "passou", texto);
    await esperarBloqueio(db, pid2);
    await c1.query("COMMIT");
    const resultadoUsoA = await usoA;
    await c2.query("ROLLBACK");
    assert.equal(resultadoUsoA.includes("053: adicional do fechamento: preço do adicional"), true, resultadoUsoA);
    assert.deepEqual(await filhosDe(fH), []);
  } finally {
    await c1.query("ROLLBACK").catch(() => {});
    await c2.query("ROLLBACK").catch(() => {});
    await encerrarDescartavel(c1 as never, false);
    await encerrarDescartavel(c2 as never, false);
    // Limpeza das fixtures confirmadas (catálogo legado, sem empresa: nenhuma guarda de exclusão).
    const adicionais = [cat.adicional, cat2.adicional, adicional2, adicional3];
    await db.query("DELETE FROM fechamento_adicionais WHERE fechamento_id = ANY($1::uuid[])", [criados.fechamentos]);
    await db.query("DELETE FROM fechamentos WHERE id = ANY($1::uuid[])", [criados.fechamentos]);
    await db.query("DELETE FROM precos_adicional WHERE adicional_id = ANY($1::uuid[])", [adicionais]);
    await db.query("DELETE FROM adicionais WHERE id = ANY($1::uuid[])", [adicionais]);
    await db.query("DELETE FROM adicional_categorias WHERE id = ANY($1::uuid[])", [[cat.categoria, cat2.categoria]]);
    await db.query("DELETE FROM regras_desconto_pacote WHERE id = ANY($1::uuid[])", [[cat.desconto, cat.desconto2, cat2.desconto, cat2.desconto2]]);
    const tabelas = [cat.tabela, cat.tabela2, cat2.tabela, cat2.tabela2];
    await db.query("DELETE FROM precos_pacote WHERE tabela_preco_id = ANY($1::uuid[])", [tabelas]);
    await db.query("DELETE FROM tabelas_preco WHERE id = ANY($1::uuid[])", [tabelas]);
    await db.query("DELETE FROM pacotes WHERE id = ANY($1::uuid[])", [[cat.pacote, cat.pacote2, pacote3, cat2.pacote, cat2.pacote2]]);
    await db.query("DELETE FROM configuracao_agenda WHERE id = $1::uuid", [base.agenda]);
    await db.query("DELETE FROM clientes WHERE id = $1::uuid", [base.cliente]);
    await db.query("DELETE FROM usuarios_administrativos WHERE id = $1::uuid", [base.usuario]);
  }
}

/** Transação única desfeita no fim; SET CONSTRAINTS ALL IMMEDIATE prova que o estado válido passaria no COMMIT. */
async function principal(db: Client, fonte: string) {
  await db.query("BEGIN");
  try {
    const a = await catalogo(db, "A");
    const b = await catalogo(db, "B");
    const legado = await catalogo(db, "legado", true);
    const { agenda, cliente, usuario } = await apoio(db);

    // Tenant A, tenant B e legado válidos, com desconto e adicional.
    const fechamentoA = await id(db, INSERIR_FECHAMENTO, [agenda, a.pacote, a.tabela, a.preco, a.desconto, cliente]);
    const fechamentoA2 = await id(db, INSERIR_FECHAMENTO, [agenda, a.pacote, a.tabela, a.preco, null, cliente]);
    const fechamentoB = await id(db, INSERIR_FECHAMENTO, [agenda, b.pacote, b.tabela, b.preco, null, cliente]);
    const fechamentoLegado = await id(db, INSERIR_FECHAMENTO, [agenda, legado.pacote, legado.tabela, legado.preco, legado.desconto, cliente]);
    await db.query(INSERIR_ADICIONAL, [fechamentoA, a.adicional, a.precoAdicional]);
    await db.query(INSERIR_ADICIONAL, [fechamentoB, b.adicional, b.precoAdicional]);
    await db.query(INSERIR_ADICIONAL, [fechamentoLegado, legado.adicional, legado.precoAdicional]);

    // Legado: NULL/NULL válido; NULL com empresa recusado (INSERT e UPDATE).
    await recusa(db, INSERIR_FECHAMENTO, [agenda, legado.pacote, a.tabela, a.preco, null, cliente], "053: fechamento: tabela de preço");
    await recusa(db, `UPDATE fechamentos SET tabela_preco_id = $2::uuid WHERE id = $1::uuid`, [fechamentoLegado, a.tabela], "053: fechamento: tabela de preço");
    await recusa(db, INSERIR_ADICIONAL, [fechamentoLegado, a.adicional, a.precoAdicional], "053: adicional do fechamento: adicional");

    // INSERT: pacote A com recurso de B ou fora do par.
    await recusa(db, INSERIR_FECHAMENTO, [agenda, a.pacote, b.tabela, a.preco, null, cliente], "053: fechamento: tabela de preço");
    await recusa(db, INSERIR_FECHAMENTO, [agenda, a.pacote, a.tabela, b.preco, null, cliente], "053: fechamento: preço do pacote");
    await recusa(db, INSERIR_FECHAMENTO, [agenda, a.pacote, a.tabela, a.preco2, null, cliente], "053: fechamento: preço do pacote");
    await recusa(db, INSERIR_FECHAMENTO, [agenda, a.pacote, a.tabela, a.preco, a.desconto2, cliente], "053: fechamento: regra de desconto");
    await recusa(db, INSERIR_FECHAMENTO, [agenda, a.pacote, a.tabela, a.preco, b.desconto, cliente], "053: fechamento: regra de desconto");
    await recusa(db, INSERIR_FECHAMENTO, [agenda, randomUUID(), a.tabela, a.preco, null, cliente], "053: fechamento: pacote inexistente");
    await recusa(db, INSERIR_ADICIONAL, [fechamentoA2, b.adicional, b.precoAdicional], "053: adicional do fechamento: adicional");
    await recusa(db, INSERIR_ADICIONAL, [fechamentoA2, a.adicional, a.precoAdicionalTabela2], "053: adicional do fechamento: preço do adicional");

    // UPDATEs: cada coluna comercial isolada e a troca de tenant.
    await recusa(db, `UPDATE fechamentos SET preco_pacote_id = $2::uuid WHERE id = $1::uuid`, [fechamentoA, a.preco2], "053: fechamento: preço do pacote");
    await recusa(db, `UPDATE fechamentos SET regra_desconto_pacote_id = $2::uuid WHERE id = $1::uuid`, [fechamentoA, a.desconto2], "053: fechamento: regra de desconto");
    await recusa(db, `UPDATE fechamentos SET tabela_preco_id = $2::uuid WHERE id = $1::uuid`, [fechamentoA, b.tabela], "053: fechamento: tabela de preço");
    await recusa(db, `UPDATE fechamentos SET pacote_id = $2::uuid, tabela_preco_id = $3::uuid, preco_pacote_id = $4::uuid, regra_desconto_pacote_id = NULL WHERE id = $1::uuid`, [fechamentoA, b.pacote, b.tabela, b.preco], "053: troca de pacote do fechamento");
    await recusa(db, `UPDATE fechamento_adicionais SET preco_adicional_id = $2::uuid WHERE fechamento_id = $1::uuid`, [fechamentoA, a.precoAdicionalTabela2], "053: adicional do fechamento: preço do adicional");
    await recusa(db, `UPDATE fechamento_adicionais SET adicional_id = $2::uuid, preco_adicional_id = $3::uuid WHERE fechamento_id = $1::uuid`, [fechamentoA, b.adicional, b.precoAdicional], "053: adicional do fechamento: adicional");
    await aceita(db, `UPDATE fechamentos SET pacote_id = $2::uuid, preco_pacote_id = $3::uuid, regra_desconto_pacote_id = $4::uuid WHERE id = $1::uuid`, [fechamentoA2, a.pacote2, a.preco2, a.desconto2]);

    // A3: cadeia de fotografias só no mesmo fechamento.
    const fotoA1 = await id(db, INSERIR_FOTOGRAFIA, [fechamentoA, 1, a.pacote, a.tabela, a.preco, null]);
    const fotoA2 = await id(db, INSERIR_FOTOGRAFIA, [fechamentoA, 2, a.pacote, a.tabela, a.preco, fotoA1]);
    assert.ok(fotoA2);
    await recusa(db, INSERIR_FOTOGRAFIA, [fechamentoA2, 1, a.pacote, a.tabela, a.preco, fotoA1], "fechamento_pacote_snapshots_anterior_mesmo_fechamento_fk");
    await recusa(db, INSERIR_FOTOGRAFIA, [fechamentoB, 1, b.pacote, b.tabela, b.preco, fotoA1], "fechamento_pacote_snapshots_anterior_mesmo_fechamento_fk");
    await recusa(db, INSERIR_FOTOGRAFIA, [fechamentoA, 3, b.pacote, b.tabela, b.preco, fotoA2], "053: fotografia do pacote");
    await db.query(
      `INSERT INTO fechamento_pacote_composicao (snapshot_id, tipo, adicional_id, codigo_aplicado, nome_aplicado) VALUES ($1::uuid, 'INCLUSO', $2::uuid, 'A53', 'Adicional 053')`,
      [fotoA1, a.adicional],
    );
    await recusa(
      db,
      `INSERT INTO fechamento_pacote_composicao (snapshot_id, tipo, adicional_id, codigo_aplicado, nome_aplicado) VALUES ($1::uuid, 'INCLUSO', $2::uuid, 'B53', 'Adicional B')`,
      [fotoA1, b.adicional],
      "053: adicional da composição",
    );

    // A2: regra de desconto — não utilizada segue a regra normal; utilizada não muda; outra empresa nunca.
    await aceita(db, `UPDATE regras_desconto_pacote SET pacote_id = $2::uuid WHERE id = $1::uuid`, [b.desconto2, b.pacote]);
    await recusa(db, `UPDATE regras_desconto_pacote SET pacote_id = $2::uuid WHERE id = $1::uuid`, [b.desconto2, a.pacote], "053: regra de desconto cruza");
    await recusa(db, `UPDATE regras_desconto_pacote SET pacote_id = $2::uuid WHERE id = $1::uuid`, [a.desconto, a.pacote2], "053: regra de desconto utilizada");
    await recusa(db, `UPDATE regras_desconto_pacote SET pacote_id = $2::uuid WHERE id = $1::uuid`, [a.desconto, b.pacote], "053: regra de desconto utilizada");

    // A5: composição só da empresa esperada, inclusive de pacote inativo de outra empresa.
    await db.query(`INSERT INTO pacote_adicionais (pacote_id, adicional_id, modalidade) VALUES ($1::uuid, $2::uuid, 'INCLUSO')`, [b.pacote2, b.adicional]);
    await db.query("UPDATE pacotes SET ativo = false WHERE id = $1::uuid", [b.pacote2]);
    const codigoB = (await db.query<{ codigo: string }>("SELECT codigo FROM adicionais WHERE id = $1::uuid", [b.adicional])).rows[0].codigo;
    assert.deepEqual(await listarCodigosInclusos(executor(db), b.pacote2, a.empresa), [], "pacote inativo de B não revela composição a A");
    assert.deepEqual(await listarCodigosInclusos(executor(db), b.pacote2, b.empresa), [codigoB]);
    assert.deepEqual(await listarCodigosInclusos(executor(db), b.pacote2, null), [], "legado não lê composição de empresa");

    // A8: tabela inexistente não vira legado; adicional por código só da empresa da tabela.
    assert.deepEqual(await listarAdicionaisAtivosComPreco({ tabelaPrecoId: randomUUID(), convidados: 20 }, executor(db)), []);
    const legadoPorTabela = await listarAdicionaisAtivosComPreco({ tabelaPrecoId: legado.tabela, convidados: 20 }, executor(db));
    assert.ok(legadoPorTabela.some((item) => item.id === legado.adicional));
    assert.ok(legadoPorTabela.every((item) => item.id !== a.adicional && item.id !== b.adicional));
    // O código é único por empresa: o mesmo código em A e B resolve só o da empresa da tabela.
    const mesmoCodigo = codigo("MC53").toUpperCase();
    await db.query("UPDATE adicionais SET codigo = $2 WHERE id = ANY($1::uuid[])", [[a.adicional, b.adicional], mesmoCodigo]);
    const porCodigo = await listarAdicionaisAtivosComPreco({ tabelaPrecoId: a.tabela, convidados: 20, codigos: [mesmoCodigo] }, executor(db));
    assert.deepEqual(porCodigo.map((item) => [item.id, item.preco?.tabelaPrecoId]), [[a.adicional, a.tabela]]);
    const porCodigoB = await listarAdicionaisAtivosComPreco({ tabelaPrecoId: b.tabela, convidados: 20, codigos: [mesmoCodigo] }, executor(db));
    assert.deepEqual(porCodigoB.map((item) => item.id), [b.adicional]);

    // Serviço: a empresa do fechamento vem do banco.
    // PR-B1: variantes explícitas sem trava (autorização) e com trava (pós-autorização).
    const repositorio = carregarModulo("lib/fechamentos/repositories/fechamento.repository.ts");
    for (const nome of ["empresaDoFechamentoSemTrava", "empresaDoFechamentoComTrava"]) {
      const empresaDoFechamento = repositorio[nome] as (fechamentoId: string, tx: DbExecutor) => Promise<string | null | undefined>;
      assert.equal(await empresaDoFechamento(fechamentoA, executor(db)), a.empresa);
      assert.equal(await empresaDoFechamento(fechamentoB, executor(db)), b.empresa);
      assert.equal(await empresaDoFechamento(fechamentoLegado, executor(db)), null);
      assert.equal(await empresaDoFechamento(randomUUID(), executor(db)), undefined);
    }

    // Todo o estado válido acima passaria no COMMIT (gatilhos diferidos e chaves estrangeiras).
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");

    // Precheck e migration abortam com histórico incompatível; o rollback remove só a guarda.
    await db.query("SAVEPOINT sem_guarda");
    await db.query(semTransacaoExplicita(readFileSync(down053, "utf8")));
    assert.deepEqual(await objetos053(db), { funcoes: 0, gatilhos: 0, fk: 0 });
    const cruzado = await id(db, INSERIR_FECHAMENTO, [agenda, a.pacote, b.tabela, a.preco, null, cliente]);
    const contagem = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM fechamentos WHERE id = ANY($1::uuid[])", [[fechamentoA, fechamentoB, fechamentoLegado, cruzado]]);
    assert.equal(contagem.rows[0].n, 4, "sem a 053 o vínculo cruzado volta a passar e nada foi apagado");
    await recusa(db, readFileSync(precheck053, "utf8"), [], "053 precheck: fechamento incompatível");
    await recusa(db, semTransacaoExplicita(fonte), [], "053: fechamento incompatível");
    // R2/R3: dependência 029, 030, 034 ou 036/038 ausente, desligada ou com configuração divergente:
    // precheck e migration recusam antes de olhar dados e antes de criar qualquer objeto da 053.
    const dependenciasDegradadas: Array<[string, string]> = [
      ["ALTER TABLE fechamento_pacote_snapshots DISABLE TRIGGER fechamento_pacote_snapshots_imutavel", "fechamento_pacote_snapshots_imutavel"],
      ["DROP TRIGGER fechamento_pacote_composicao_imutavel ON fechamento_pacote_composicao", "fechamento_pacote_composicao_imutavel"],
      [`DROP TRIGGER fechamento_pacote_snapshots_imutavel ON fechamento_pacote_snapshots;
        CREATE TRIGGER fechamento_pacote_snapshots_imutavel BEFORE UPDATE OR DELETE ON fechamento_pacote_snapshots
        FOR EACH ROW EXECUTE FUNCTION public.kidmais_036_empresa_pai_imutavel()`, "fechamento_pacote_snapshots_imutavel"],
      ["ALTER TABLE precos_pacote DISABLE TRIGGER precos_pacote_calculo_utilizado_trg", "precos_pacote_calculo_utilizado_trg"],
      ["DROP TRIGGER precos_adicional_calculo_utilizado_trg ON precos_adicional", "precos_adicional_calculo_utilizado_trg"],
      ["ALTER TABLE precos_adicional DISABLE TRIGGER precos_adicional_empresa_trg", "precos_adicional_empresa_trg"],
      [`DROP TRIGGER precos_pacote_empresa_trg ON precos_pacote;
        CREATE TRIGGER precos_pacote_empresa_trg BEFORE INSERT ON precos_pacote
        FOR EACH ROW EXECUTE FUNCTION public.kidmais_034_precos_pacote_empresa()`, "precos_pacote_empresa_trg"],
      ["ALTER TABLE pacotes DISABLE TRIGGER pacotes_empresa_imutavel_trg", "pacotes_empresa_imutavel_trg"],
      [`DROP TRIGGER tabelas_preco_empresa_imutavel_trg ON tabelas_preco;
        CREATE TRIGGER tabelas_preco_empresa_imutavel_trg BEFORE UPDATE OF empresa_id ON tabelas_preco
        FOR EACH ROW WHEN (OLD.empresa_id IS NULL) EXECUTE FUNCTION public.kidmais_036_empresa_pai_imutavel()`, "tabelas_preco_empresa_imutavel_trg"],
    ];
    for (const [alteracao, gatilho] of dependenciasDegradadas) {
      await db.query("SAVEPOINT dependencia");
      await db.query(alteracao);
      await recusa(db, readFileSync(precheck053, "utf8"), [], `053 precheck: dependência ausente ou degradada: ${gatilho}`);
      await recusa(db, semTransacaoExplicita(fonte), [], `053: dependência ausente ou degradada: ${gatilho}`);
      assert.deepEqual(await objetos053(db), { funcoes: 0, gatilhos: 0, fk: 0 }, `nada da 053 criado sem ${gatilho}`);
      await db.query("ROLLBACK TO SAVEPOINT dependencia");
    }
    await db.query("ROLLBACK TO SAVEPOINT sem_guarda");
    await db.query("SAVEPOINT anterior_cruzada");
    await db.query(semTransacaoExplicita(readFileSync(down053, "utf8")));
    await db.query(INSERIR_FOTOGRAFIA, [fechamentoB, 1, b.pacote, b.tabela, b.preco, fotoA1]);
    await recusa(db, readFileSync(precheck053, "utf8"), [], "fotografias anteriores de outro fechamento=1");
    await db.query("ROLLBACK TO SAVEPOINT anterior_cruzada");
    await db.query(readFileSync(postcheck053, "utf8"));

    // F2: o postcheck recusa cada configuração divergente, da 053 e das dependências.
    const divergentes: Array<[string, string]> = [
      ["ALTER TABLE fechamentos DISABLE TRIGGER fechamentos_053_empresa_trg", "fechamentos_053_empresa_trg"],
      [`DROP TRIGGER fechamento_adicionais_053_empresa_trg ON fechamento_adicionais;
        CREATE TRIGGER fechamento_adicionais_053_empresa_trg BEFORE INSERT OR UPDATE OF fechamento_id, adicional_id, preco_adicional_id
        ON fechamento_adicionais FOR EACH ROW WHEN (false) EXECUTE FUNCTION public.kidmais_053_fechamento_adicional()`, "fechamento_adicionais_053_empresa_trg"],
      [`DROP TRIGGER fechamentos_053_filhos_trg ON fechamentos;
        CREATE CONSTRAINT TRIGGER fechamentos_053_filhos_trg AFTER UPDATE OF pacote_id, tabela_preco_id ON fechamentos
        DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION public.kidmais_053_fechamento_filhos()`, "fechamentos_053_filhos_trg"],
      [`DROP TRIGGER regras_desconto_pacote_053_utilizada_trg ON regras_desconto_pacote;
        CREATE TRIGGER regras_desconto_pacote_053_utilizada_trg BEFORE UPDATE OF percentual ON regras_desconto_pacote
        FOR EACH ROW EXECUTE FUNCTION public.kidmais_053_desconto_utilizado()`, "regras_desconto_pacote_053_utilizada_trg"],
      [`DROP TRIGGER fechamento_pacote_snapshots_053_empresa_trg ON fechamento_pacote_snapshots;
        CREATE TRIGGER fechamento_pacote_snapshots_053_empresa_trg BEFORE INSERT ON fechamento_pacote_snapshots
        FOR EACH ROW EXECUTE FUNCTION public.kidmais_053_composicao()`, "fechamento_pacote_snapshots_053_empresa_trg"],
      ["ALTER TABLE precos_pacote DISABLE TRIGGER precos_pacote_empresa_trg", "precos_pacote_empresa_trg"],
      [`DROP TRIGGER pacote_adicionais_empresa_trg ON pacote_adicionais;
        CREATE TRIGGER pacote_adicionais_empresa_trg BEFORE INSERT ON pacote_adicionais
        FOR EACH ROW EXECUTE FUNCTION public.kidmais_034_pacote_adicionais_empresa()`, "pacote_adicionais_empresa_trg"],
      ["ALTER TABLE pacotes DISABLE TRIGGER pacotes_empresa_imutavel_trg", "pacotes_empresa_imutavel_trg"],
      ["DROP TRIGGER adicionais_empresa_imutavel_trg ON adicionais", "adicionais_empresa_imutavel_trg"],
      ["ALTER TABLE precos_adicional DISABLE TRIGGER precos_adicional_calculo_utilizado_trg", "precos_adicional_calculo_utilizado_trg"],
      ["ALTER TABLE fechamento_pacote_composicao DISABLE TRIGGER fechamento_pacote_composicao_imutavel", "fechamento_pacote_composicao_imutavel"],
      ["DROP TRIGGER fechamento_pacote_snapshots_imutavel ON fechamento_pacote_snapshots", "fechamento_pacote_snapshots_imutavel"],
    ];
    for (const [alteracao, gatilho] of divergentes) {
      await db.query("SAVEPOINT divergente");
      await db.query(alteracao);
      await recusa(db, readFileSync(postcheck053, "utf8"), [], `gatilho ausente ou divergente: ${gatilho}`);
      await db.query("ROLLBACK TO SAVEPOINT divergente");
    }
    await db.query("SAVEPOINT divergente");
    await db.query("ALTER TABLE fechamento_pacote_snapshots DROP CONSTRAINT fechamento_pacote_snapshots_anterior_mesmo_fechamento_fk");
    await recusa(db, readFileSync(postcheck053, "utf8"), [], "chave estrangeira composta da fotografia anterior ausente");
    await db.query("ROLLBACK TO SAVEPOINT divergente");
    await db.query("SAVEPOINT divergente");
    await db.query("ALTER FUNCTION public.kidmais_053_revisao() RESET search_path");
    await recusa(db, readFileSync(postcheck053, "utf8"), [], "sem search_path fixo");
    await db.query("ROLLBACK TO SAVEPOINT divergente");
    // R5: FK com ação referencial divergente e função SECURITY DEFINER também são recusadas.
    await db.query("SAVEPOINT divergente");
    await db.query(`ALTER TABLE fechamento_pacote_snapshots DROP CONSTRAINT fechamento_pacote_snapshots_anterior_mesmo_fechamento_fk;
      ALTER TABLE fechamento_pacote_snapshots ADD CONSTRAINT fechamento_pacote_snapshots_anterior_mesmo_fechamento_fk
      FOREIGN KEY (snapshot_anterior_id, fechamento_id) REFERENCES fechamento_pacote_snapshots (id, fechamento_id) ON DELETE CASCADE`);
    await recusa(db, readFileSync(postcheck053, "utf8"), [], "chave estrangeira composta da fotografia anterior ausente ou divergente");
    await db.query("ROLLBACK TO SAVEPOINT divergente");
    await db.query("SAVEPOINT divergente");
    await db.query("ALTER FUNCTION public.kidmais_053_fechamento() SECURITY DEFINER");
    await recusa(db, readFileSync(postcheck053, "utf8"), [], "SECURITY DEFINER");
    await db.query("ROLLBACK TO SAVEPOINT divergente");
    // R1: a revisão é travada FOR UPDATE desde a primeira leitura (sem promoção SHARE → UPDATE com a 014);
    // o fechamento continua FOR SHARE.
    const corpo = async (funcao: string) =>
      (await db.query<{ s: string }>("SELECT pg_get_functiondef(to_regprocedure($1)) AS s", [funcao])).rows[0].s;
    const revisaoAdicional = await corpo("public.kidmais_053_revisao_adicional()");
    assert.match(revisaoAdicional, /FOR UPDATE OF r/);
    assert.doesNotMatch(revisaoAdicional, /FOR SHARE OF r/);
    assert.match(await corpo("public.kidmais_053_fechamento_adicional()"), /FOR SHARE OF f/);
    const preservar = await corpo("public.kidmais_preservar_adicional_revisao()");
    assert.match(preservar, /FROM public\.fechamento_revisoes WHERE id=rid FOR UPDATE/, "a 014 trava a revisão FOR UPDATE");
    await db.query(readFileSync(postcheck053, "utf8"));

    // Revisão operacional: desconto e adicional válidos; cruzamentos recusados.
    // A base contratual é mínima (sem versão assinada por OTP), então as guardas diferidas da 014
    // não se aplicam a ela: volta ao modo diferido e, no fim, força só as restrições da 053.
    await db.query("SET CONSTRAINTS ALL DEFERRED");
    const base = await contratoDoFechamento(db, fechamentoA);
    const argsRevisao = (pacote: string, tabela: string, preco: string, desconto: string | null) =>
      [fechamentoA, base.contrato, base.versaoNova, base.versaoBase, randomUUID(), usuario, cliente, agenda, pacote, tabela, preco, desconto];
    await recusa(db, INSERIR_REVISAO, argsRevisao(b.pacote, b.tabela, b.preco, null), "053: revisão");
    await recusa(db, INSERIR_REVISAO, argsRevisao(a.pacote, b.tabela, a.preco, null), "053: revisão: tabela de preço");
    await recusa(db, INSERIR_REVISAO, argsRevisao(a.pacote, a.tabela, a.preco, a.desconto2), "053: revisão: regra de desconto");
    const revisaoA = await id(db, INSERIR_REVISAO, argsRevisao(a.pacote, a.tabela, a.preco, a.desconto));
    await db.query(INSERIR_ADICIONAL_REVISAO, [revisaoA, a.adicional, a.precoAdicional]);
    await recusa(db, INSERIR_ADICIONAL_REVISAO.replace("'Adicional 053'", "'Adicional B'"), [revisaoA, b.adicional, b.precoAdicional], "053: adicional da revisão: adicional");
    await recusa(db, `UPDATE fechamento_revisoes SET pacote_id = $2::uuid, tabela_preco_id = $3::uuid, preco_pacote_id = $4::uuid, regra_desconto_pacote_id = NULL WHERE id = $1::uuid`, [revisaoA, b.pacote, b.tabela, b.preco], "053: revisão");
    await recusa(db, `UPDATE fechamento_revisao_adicionais SET preco_adicional_id = $2::uuid WHERE fechamento_revisao_id = $1::uuid`, [revisaoA, a.precoAdicionalTabela2], "053: adicional da revisão: preço do adicional");
    await recusa(db, `UPDATE regras_desconto_pacote SET pacote_id = $2::uuid WHERE id = $1::uuid`, [a.desconto, a.pacote2], "053: regra de desconto utilizada");
    await db.query("SET CONSTRAINTS fechamentos_053_filhos_trg, fechamento_revisoes_053_filhos_trg IMMEDIATE");
  } finally {
    await db.query("ROLLBACK");
  }
}

/** A1: troca de tabela com adicionais antigos não confirma; com substituição correta, confirma. */
async function trocaDeTabelaNoCommit(db: Client) {
  type Cenario = { a: Catalogo; fechamento: string; revisao: string | null };
  // Com revisão em preparação, a guarda 014 congela o fechamento: os cenários são separados.
  async function preparar(comRevisao: boolean): Promise<Cenario> {
    const a = await catalogo(db, "troca de tabela");
    const { agenda, cliente, usuario } = await apoio(db);
    const fechamento = await id(db, INSERIR_FECHAMENTO, [agenda, a.pacote, a.tabela, a.preco, null, cliente]);
    await db.query(INSERIR_ADICIONAL, [fechamento, a.adicional, a.precoAdicional]);
    if (!comRevisao) return { a, fechamento, revisao: null };
    const base = await contratoDoFechamento(db, fechamento);
    const revisao = await id(db, INSERIR_REVISAO, [fechamento, base.contrato, base.versaoNova, base.versaoBase, randomUUID(), usuario, cliente, agenda, a.pacote, a.tabela, a.preco, null]);
    await db.query(INSERIR_ADICIONAL_REVISAO, [revisao, a.adicional, a.precoAdicional]);
    return { a, fechamento, revisao };
  }

  // Fechamento: o COMMIT real dispara todas as guardas diferidas. Revisão: a base contratual mínima
  // não satisfaz a 014, então força-se só a restrição diferida da 053 (o que o COMMIT também executaria).
  const forcarRevisao = "SET CONSTRAINTS fechamento_revisoes_053_filhos_trg IMMEDIATE";

  async function commitFalha(comRevisao: boolean, alterar: (c: Cenario) => Promise<void>, trecho: string) {
    await db.query("BEGIN");
    let message = "passou";
    try {
      const cenario = await preparar(comRevisao);
      await alterar(cenario);
      await db.query(comRevisao ? forcarRevisao : "COMMIT");
    } catch (error) {
      message = texto(error);
    } finally {
      await db.query("ROLLBACK").catch(() => {});
    }
    assert.equal(message.includes(trecho), true, `${trecho}: ${message}`);
  }

  async function commitValido(comRevisao: boolean, alterar: (c: Cenario) => Promise<void>) {
    await db.query("BEGIN");
    try {
      const cenario = await preparar(comRevisao);
      await alterar(cenario);
      await db.query(comRevisao ? forcarRevisao : "SET CONSTRAINTS ALL IMMEDIATE");
    } finally {
      await db.query("ROLLBACK");
    }
  }

  const trocarFechamento = (c: Cenario) =>
    db.query("UPDATE fechamentos SET tabela_preco_id = $2::uuid, preco_pacote_id = $3::uuid WHERE id = $1::uuid", [c.fechamento, c.a.tabela2, c.a.precoTabela2]);
  const trocarRevisao = (c: Cenario) =>
    db.query("UPDATE fechamento_revisoes SET tabela_preco_id = $2::uuid, preco_pacote_id = $3::uuid WHERE id = $1::uuid", [c.revisao, c.a.tabela2, c.a.precoTabela2]);

  // Fechamento: T1 → T2 sem recriar adicionais falha no COMMIT; com substituição, passa.
  await commitFalha(false, async (c) => { await trocarFechamento(c); }, "053: adicionais do fechamento após troca de tabela ou pacote");
  await commitValido(false, async (c) => {
    await trocarFechamento(c);
    await db.query("DELETE FROM fechamento_adicionais WHERE fechamento_id = $1::uuid", [c.fechamento]);
    await db.query(INSERIR_ADICIONAL, [c.fechamento, c.a.adicional, c.a.precoAdicionalTabela2]);
  });

  // Revisão: mesma lógica.
  await commitFalha(true, async (c) => { await trocarRevisao(c); }, "053: adicionais da revisão após troca de tabela ou pacote");
  await commitValido(true, async (c) => {
    await trocarRevisao(c);
    await db.query("DELETE FROM fechamento_revisao_adicionais WHERE fechamento_revisao_id = $1::uuid", [c.revisao]);
    await db.query(INSERIR_ADICIONAL_REVISAO, [c.revisao, c.a.adicional, c.a.precoAdicionalTabela2]);
  });
}
