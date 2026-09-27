import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";

const req = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function codigo(prefixo: string) {
  return `${prefixo}${randomBytes(4).toString("hex")}`;
}

function senhaFalsa() {
  return `scrypt$v=1$N=131072$r=8$p=1$${ "A".repeat(22) }==$${ "B".repeat(86) }==`;
}

function caminhoTs(base: string) {
  if (existsSync(`${base}.ts`)) return `${base}.ts`;
  if (existsSync(`${base}.tsx`)) return `${base}.tsx`;
  if (existsSync(`${base}/index.ts`)) return `${base}/index.ts`;
  return base;
}

function carregarCatalogo(sessao: { usuario_id: string; papel: string }) {
  const cache = new Map<string, Record<string, unknown>>();
  const postgres = {
    db() {
      throw new Error("DB_FORA_DA_TRANSACAO");
    },
    async withTransaction(fn: (tx: { query: (sql: string, values?: readonly unknown[]) => Promise<unknown> }) => Promise<unknown>) {
      const client = await conectarDescartavel({ travar: false });
      try {
        await client.query("BEGIN");
        const resultado = await fn({
          query: async (sql: string, values?: readonly unknown[]) => {
            const result = await client.query(sql, values ? [...values] : []);
            return { rows: result.rows, rowCount: result.rowCount };
          },
        });
        await client.query("COMMIT");
        return resultado;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        await client.end();
      }
    },
  };
  function load(file: string): Record<string, unknown> {
    const normal = resolve(file).replaceAll("\\", "/");
    const hit = cache.get(normal);
    if (hit) return hit;
    const exports: Record<string, unknown> = {};
    cache.set(normal, exports);
    const code = ts.transpileModule(readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const localRequire = (id: string) => {
      if (id === "zod" || id === "next/server" || (!id.startsWith(".") && !id.startsWith("@/"))) return req(id);
      const base = id.startsWith("@/") ? resolve(root, id.slice(2)) : resolve(dirname(file), id);
      const alvo = caminhoTs(base.replace(/\.ts$/, ""));
      const chave = resolve(alvo).replaceAll("\\", "/");
      if (chave.endsWith("lib/db/postgres.ts")) return postgres;
      if (chave.endsWith("lib/http/admin-crm-api.ts")) {
        return { exigirApiAdminCrmDisponivel: async () => sessao };
      }
      return load(alvo);
    };
    new Function("require", "exports", code)(localRequire, exports);
    return exports;
  }
  return load(resolve(root, "app/api/admin/configuracoes/catalogo/route.ts"));
}

function pedido(body: unknown) {
  return {
    method: "PATCH",
    nextUrl: new URL("http://localhost/api/admin/configuracoes/catalogo"),
    json: async () => body,
    headers: { get: () => null },
    cookies: { get: () => undefined },
  };
}

async function corpo(response: { json: () => Promise<unknown>; status: number }) {
  return { status: response.status, json: await response.json() as { codigo?: string; ok?: boolean; erro?: string } };
}

async function usuario(client: Client) {
  return (await client.query<{ id: string }>(
    `INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo)
     VALUES ($1, 'Operador catalogo', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id`,
    [`${codigo("hg8c")}@example.test`, senhaFalsa()],
  )).rows[0].id;
}

async function empresa(client: Client, nome: string) {
  const id = (await client.query<{ id: string }>(
    `INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id`,
    [codigo("hg8c"), nome],
  )).rows[0].id;
  await client.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [id]);
  return id;
}

async function membership(client: Client, empresaId: string, usuarioId: string) {
  const id = (await client.query<{ id: string }>(
    `INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde)
     VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp()) RETURNING id`,
    [empresaId, usuarioId],
  )).rows[0].id;
  await client.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [id]);
  return id;
}

async function limpar(client: Client) {
  const empresas = await client.query<{ id: string }>("SELECT id FROM empresas WHERE codigo LIKE 'hg8c%'");
  if (empresas.rows.length === 0) {
    await client.query("DELETE FROM usuarios_administrativos WHERE email LIKE 'hg8c%@example.test'");
    return;
  }
  await client.query("ALTER TABLE memberships DISABLE TRIGGER USER");
  await client.query("ALTER TABLE empresas DISABLE TRIGGER USER");
  await client.query("ALTER TABLE precos_pacote DISABLE TRIGGER USER");
  try {
    for (const empresaId of empresas.rows.map((row) => row.id)) {
      await client.query(
        "DELETE FROM fechamentos WHERE pacote_id IN (SELECT id FROM pacotes WHERE empresa_id = $1::uuid)",
        [empresaId],
      );
      await client.query(
        "DELETE FROM pacote_buffet_itens WHERE pacote_id IN (SELECT id FROM pacotes WHERE empresa_id = $1::uuid)",
        [empresaId],
      );
      await client.query(
        "DELETE FROM pacote_buffet_categorias WHERE pacote_id IN (SELECT id FROM pacotes WHERE empresa_id = $1::uuid)",
        [empresaId],
      );
      await client.query(
        "DELETE FROM pacote_adicionais WHERE pacote_id IN (SELECT id FROM pacotes WHERE empresa_id = $1::uuid)",
        [empresaId],
      );
      await client.query(
        `DELETE FROM precos_pacote
          WHERE tabela_preco_id IN (SELECT id FROM tabelas_preco WHERE empresa_id = $1::uuid)
             OR pacote_id IN (SELECT id FROM pacotes WHERE empresa_id = $1::uuid)`,
        [empresaId],
      );
      await client.query("DELETE FROM pacotes WHERE empresa_id = $1::uuid", [empresaId]);
      await client.query("DELETE FROM tabelas_preco WHERE empresa_id = $1::uuid", [empresaId]);
      await client.query("DELETE FROM adicionais WHERE empresa_id = $1::uuid", [empresaId]);
      await client.query("DELETE FROM memberships WHERE empresa_id = $1::uuid", [empresaId]);
      await client.query("DELETE FROM empresas WHERE id = $1::uuid", [empresaId]);
    }
    await client.query("DELETE FROM usuarios_administrativos WHERE email LIKE 'hg8c%@example.test'");
  } finally {
    await client.query("ALTER TABLE precos_pacote ENABLE TRIGGER USER");
    await client.query("ALTER TABLE empresas ENABLE TRIGGER USER");
    await client.query("ALTER TABLE memberships ENABLE TRIGGER USER");
  }
}

test("catálogo HG-8 no postgres descartável", { timeout: 120_000 }, async (t) => {
  const fonte = readFileSync(resolve(root, "app/api/admin/configuracoes/catalogo/route.ts"), "utf8");
  assert.equal(fonte.includes("ON CONFLICT"), false);
  assert.equal(/UPDATE buffet_categorias|UPDATE buffet_itens|INSERT INTO buffet_/.test(fonte), false);
  assert.match(fonte, /alterarComposicaoPacoteAdmin/);
  assert.match(fonte, /CATALOGO_GLOBAL_SEM_AUTORIDADE/);

  const client = await conectarDescartavel();
  const db = client as unknown as Client;
  try {
    const ident = await db.query<{ db: string; port: number }>(
      "SELECT current_database() AS db, inet_server_port() AS port",
    );
    assert.equal(ident.rows[0].db, "kidmais_pacotes_v1_descartavel");
    assert.equal(Number(ident.rows[0].port), 55498);

    await t.test("tenant A não altera referência global usada por B", async () => {
      const empresaA = await empresa(db, "Empresa A catalogo");
      const empresaB = await empresa(db, "Empresa B catalogo");
      const usuarioA = await usuario(db);
      await membership(db, empresaA, usuarioA);
      const categoria = (await db.query<{ id: string; nome: string }>(
        "SELECT id, nome FROM buffet_categorias ORDER BY codigo LIMIT 1",
      )).rows[0];
      const antes = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM buffet_categorias")).rows[0].n;
      const itens = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM buffet_itens")).rows[0].n;
      const modulo = carregarCatalogo({
        usuario_id: usuarioA,
        papel: "REPRESENTANTE_AUTORIZADO",
      });
      const patch = modulo.PATCH as (request: object) => Promise<{ status: number; json: () => Promise<unknown> }>;
      const resposta = await corpo(await patch(pedido({
        empresaId: empresaA,
        acao: "categoria",
        id: categoria.id,
        nome: "Nome invasor HG8",
        ativo: true,
      })));
      assert.equal(resposta.status, 403);
      assert.equal(resposta.json.codigo, "CATALOGO_GLOBAL_SEM_AUTORIDADE");
      const depois = await db.query<{ nome: string }>("SELECT nome FROM buffet_categorias WHERE id = $1::uuid", [categoria.id]);
      assert.equal(depois.rows[0].nome, categoria.nome);
      assert.equal((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM buffet_categorias")).rows[0].n, antes);
      assert.equal((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM buffet_itens")).rows[0].n, itens);
      const nova = await corpo(await patch(pedido({
        empresaId: empresaA,
        acao: "nova_categoria",
        nome: "Categoria invasora",
      })));
      assert.equal(nova.status, 403);
      assert.equal(nova.json.codigo, "CATALOGO_GLOBAL_SEM_AUTORIDADE");
      assert.equal((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM buffet_categorias")).rows[0].n, antes);
      assert.equal(empresaB.length > 0, true);
    });

    await t.test("item e novo item não alteram a referência global compartilhada", async () => {
      const empresaA = await empresa(db, "Empresa A item");
      const empresaB = await empresa(db, "Empresa B item");
      const usuarioA = await usuario(db);
      await membership(db, empresaA, usuarioA);
      const item = (await db.query<{ id: string; nome: string; categoria_id: string }>(
        "SELECT id, nome, categoria_id FROM buffet_itens ORDER BY nome LIMIT 1",
      )).rows[0];
      const pacoteB = (await db.query<{ id: string }>(
        `INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente)
         VALUES ($1::uuid, $2, 'Pacote da referencia', 430, true, true) RETURNING id`,
        [empresaB, codigo("HG8I").toUpperCase()],
      )).rows[0].id;
      await db.query(
        `INSERT INTO pacote_buffet_categorias (pacote_id, categoria_id, modo_itens, escolhas_min, escolhas_max, ativo)
         VALUES ($1::uuid, $2::uuid, 'SELECIONADOS', 0, 1, true)`,
        [pacoteB, item.categoria_id],
      );
      await db.query(
        `INSERT INTO pacote_buffet_itens (pacote_id, categoria_id, item_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid)`,
        [pacoteB, item.categoria_id, item.id],
      );
      const antes = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM buffet_itens")).rows[0].n;
      const modulo = carregarCatalogo({ usuario_id: usuarioA, papel: "REPRESENTANTE_AUTORIZADO" });
      const patch = modulo.PATCH as (request: object) => Promise<{ status: number; json: () => Promise<unknown> }>;
      const alterado = await corpo(await patch(pedido({
        empresaId: empresaA,
        acao: "item",
        id: item.id,
        nome: "Item invasor HG8",
        ativo: true,
      })));
      assert.equal(alterado.status, 403);
      assert.equal(alterado.json.codigo, "CATALOGO_GLOBAL_SEM_AUTORIDADE");
      const criado = await corpo(await patch(pedido({
        empresaId: empresaA,
        acao: "novo_item",
        categoriaId: item.categoria_id,
        nome: "Item novo invasor",
      })));
      assert.equal(criado.status, 403);
      assert.equal(criado.json.codigo, "CATALOGO_GLOBAL_SEM_AUTORIDADE");
      const depois = await db.query<{ nome: string }>("SELECT nome FROM buffet_itens WHERE id = $1::uuid", [item.id]);
      assert.equal(depois.rows[0].nome, item.nome);
      assert.equal((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM buffet_itens")).rows[0].n, antes);
      const referencia = await db.query<{ nome: string; n: number }>(
        `SELECT i.nome, count(*)::int AS n
           FROM pacote_buffet_itens v
           JOIN buffet_itens i ON i.id = v.item_id
          WHERE v.pacote_id = $1::uuid AND v.item_id = $2::uuid
          GROUP BY i.nome`,
        [pacoteB, item.id],
      );
      assert.equal(referencia.rows.length, 1);
      assert.equal(referencia.rows[0].n, 1);
      assert.equal(referencia.rows[0].nome, item.nome);
    });

    await t.test("composição pela rota revisa pacote usado e grava uma auditoria", async () => {
      const empresaId = await empresa(db, "Empresa da composicao");
      const usuarioId = await usuario(db);
      await membership(db, empresaId, usuarioId);
      const pacoteId = (await db.query<{ id: string }>(
        `INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente)
         VALUES ($1::uuid, $2, 'Pacote usado', 410, true, true) RETURNING id`,
        [empresaId, codigo("HG8C").toUpperCase()],
      )).rows[0].id;
      const adicionalId = (await db.query<{ id: string }>(
        `INSERT INTO adicionais (empresa_id, codigo, nome, categoria, categoria_id, unidade_cobranca, ordem_exibicao)
         SELECT $1::uuid, $2, 'Adicional HG8', categoria, categoria_id, unidade_cobranca, 410
           FROM adicionais WHERE codigo = 'SALADA_PREMIUM' RETURNING id`,
        [empresaId, codigo("HG8A").toUpperCase()],
      )).rows[0].id;
      const tabelaId = (await db.query<{ id: string }>(
        `INSERT INTO tabelas_preco (empresa_id, codigo, nome, vigencia_inicio, vigencia_fim, ativa)
         VALUES ($1::uuid, $2, 'Tabela HG8', DATE '2098-01-01', DATE '2098-06-30', false) RETURNING id`,
        [empresaId, codigo("hg8t")],
      )).rows[0].id;
      const precoId = (await db.query<{ id: string }>(
        `INSERT INTO precos_pacote (
           tabela_preco_id, pacote_id, convidados_min, convidados_max, tipo_calculo, valor, categoria_horario
         ) VALUES ($1::uuid, $2::uuid, 20, 40, 'FIXO', 10.00, 'PADRAO') RETURNING id`,
        [tabelaId, pacoteId],
      )).rows[0].id;
      const agenda = (await db.query<{ id: string }>(
        "SELECT id FROM configuracao_agenda WHERE codigo = 'TURNO_1' AND ativo LIMIT 1",
      )).rows[0].id;
      await db.query(
        `INSERT INTO fechamentos (
           data_evento, horario_inicio, horario_fim, configuracao_agenda_id,
           pacote_id, tabela_preco_id, preco_pacote_id,
           categoria_horario, categoria_preco_aplicada,
           convidados, convidados_faturados,
           valor_pacote_base, desconto_percentual, valor_desconto_pacote, valor_pacote_aplicado,
           valor_adicionais, valor_tabela, status, origem_fechamento
         ) VALUES (
           DATE '2026-11-11', TIME '10:00', TIME '14:00', $1::uuid,
           $2::uuid, $3::uuid, $4::uuid,
           'PADRAO', 'PADRAO', 30, 30,
           10, 0, 0, 10, 0, 10, 'RASCUNHO', 'ATENDIMENTO_KIDMAIS'
         )`,
        [agenda, pacoteId, tabelaId, precoId],
      );
      const modulo = carregarCatalogo({ usuario_id: usuarioId, papel: "REPRESENTANTE_AUTORIZADO" });
      const patch = modulo.PATCH as (request: object) => Promise<{ status: number; json: () => Promise<unknown> }>;
      const resposta = await corpo(await patch(pedido({
        empresaId,
        acao: "vinculo_adicional",
        pacoteId,
        adicionalId,
        modalidade: "EXTRA",
        motivo: "Composicao pela rota do catalogo",
      })));
      assert.equal(resposta.status, 200, JSON.stringify(resposta.json));
      assert.equal(resposta.json.ok, true);
      const anterior = await db.query<{ vigente: boolean; vinculos: number }>(
        `SELECT p.vigente, (SELECT count(*)::int FROM pacote_adicionais pa WHERE pa.pacote_id = p.id) AS vinculos
           FROM pacotes p WHERE p.id = $1::uuid`,
        [pacoteId],
      );
      assert.equal(anterior.rows[0].vigente, false);
      assert.equal(anterior.rows[0].vinculos, 0);
      const nova = await db.query<{ id: string; modalidade: string }>(
        `SELECT p.id, pa.modalidade
           FROM pacotes p
           JOIN pacote_adicionais pa ON pa.pacote_id = p.id
          WHERE p.revisao_anterior_id = $1::uuid AND p.empresa_id = $2::uuid`,
        [pacoteId, empresaId],
      );
      assert.equal(nova.rows.length, 1);
      assert.equal(nova.rows[0].modalidade, "EXTRA");
      const auditoria = await db.query<{ acao: string; n: number }>(
        `SELECT acao, count(*)::int AS n
           FROM auditoria
          WHERE entidade_id IN ($1::uuid, $2::uuid) AND acao = 'PACOTE_COMPOSICAO'
          GROUP BY acao`,
        [pacoteId, nova.rows[0].id],
      );
      assert.equal(auditoria.rows.length, 1);
      assert.equal(auditoria.rows[0].n, 1);
    });

    await t.test("regra de buffet pela rota revisa pacote usado e grava uma auditoria", async () => {
      const empresaId = await empresa(db, "Empresa da regra");
      const usuarioId = await usuario(db);
      await membership(db, empresaId, usuarioId);
      const pacoteId = (await db.query<{ id: string }>(
        `INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente)
         VALUES ($1::uuid, $2, 'Pacote da regra', 440, true, true) RETURNING id`,
        [empresaId, codigo("HG8R").toUpperCase()],
      )).rows[0].id;
      const categoriaId = (await db.query<{ id: string }>(
        "SELECT id FROM buffet_categorias ORDER BY codigo LIMIT 1",
      )).rows[0].id;
      const tabelaId = (await db.query<{ id: string }>(
        `INSERT INTO tabelas_preco (empresa_id, codigo, nome, vigencia_inicio, vigencia_fim, ativa)
         VALUES ($1::uuid, $2, 'Tabela regra', DATE '2098-07-01', DATE '2098-12-31', false) RETURNING id`,
        [empresaId, codigo("hg8u")],
      )).rows[0].id;
      const precoId = (await db.query<{ id: string }>(
        `INSERT INTO precos_pacote (
           tabela_preco_id, pacote_id, convidados_min, convidados_max, tipo_calculo, valor, categoria_horario
         ) VALUES ($1::uuid, $2::uuid, 20, 40, 'FIXO', 10.00, 'PADRAO') RETURNING id`,
        [tabelaId, pacoteId],
      )).rows[0].id;
      const agenda = (await db.query<{ id: string }>(
        "SELECT id FROM configuracao_agenda WHERE codigo = 'TURNO_1' AND ativo LIMIT 1",
      )).rows[0].id;
      await db.query(
        `INSERT INTO fechamentos (
           data_evento, horario_inicio, horario_fim, configuracao_agenda_id,
           pacote_id, tabela_preco_id, preco_pacote_id,
           categoria_horario, categoria_preco_aplicada,
           convidados, convidados_faturados,
           valor_pacote_base, desconto_percentual, valor_desconto_pacote, valor_pacote_aplicado,
           valor_adicionais, valor_tabela, status, origem_fechamento
         ) VALUES (
           DATE '2026-11-12', TIME '10:00', TIME '14:00', $1::uuid,
           $2::uuid, $3::uuid, $4::uuid,
           'PADRAO', 'PADRAO', 30, 30,
           10, 0, 0, 10, 0, 10, 'RASCUNHO', 'ATENDIMENTO_KIDMAIS'
         )`,
        [agenda, pacoteId, tabelaId, precoId],
      );
      const modulo = carregarCatalogo({ usuario_id: usuarioId, papel: "REPRESENTANTE_AUTORIZADO" });
      const patch = modulo.PATCH as (request: object) => Promise<{ status: number; json: () => Promise<unknown> }>;
      const resposta = await corpo(await patch(pedido({
        empresaId,
        acao: "regra_buffet",
        pacoteId,
        categoriaId,
        ativo: true,
        max: 2,
        motivo: "Regra de buffet pela rota do catalogo",
      })));
      assert.equal(resposta.status, 200, JSON.stringify(resposta.json));
      assert.equal(resposta.json.ok, true);
      const anterior = await db.query<{ vigente: boolean; regras: number }>(
        `SELECT p.vigente,
                (SELECT count(*)::int FROM pacote_buffet_categorias r WHERE r.pacote_id = p.id) AS regras
           FROM pacotes p WHERE p.id = $1::uuid`,
        [pacoteId],
      );
      assert.equal(anterior.rows[0].vigente, false);
      assert.equal(anterior.rows[0].regras, 0);
      const nova = await db.query<{ id: string; modo: string; minimo: number; maximo: number }>(
        `SELECT p.id, r.modo_itens AS modo, r.escolhas_min AS minimo, r.escolhas_max AS maximo
           FROM pacotes p
           JOIN pacote_buffet_categorias r ON r.pacote_id = p.id
          WHERE p.revisao_anterior_id = $1::uuid AND p.empresa_id = $2::uuid AND r.categoria_id = $3::uuid`,
        [pacoteId, empresaId, categoriaId],
      );
      assert.equal(nova.rows.length, 1);
      assert.equal(nova.rows[0].modo, "SELECIONADOS");
      assert.equal(Number(nova.rows[0].minimo), 0);
      assert.equal(Number(nova.rows[0].maximo), 2);
      const auditoria = await db.query<{ acao: string; n: number }>(
        `SELECT acao, count(*)::int AS n
           FROM auditoria
          WHERE entidade_id IN ($1::uuid, $2::uuid) AND acao = 'PACOTE_COMPOSICAO'
          GROUP BY acao`,
        [pacoteId, nova.rows[0].id],
      );
      assert.equal(auditoria.rows.length, 1);
      assert.equal(auditoria.rows[0].n, 1);
    });

    await t.test("duas memberships exigem empresaId autorizado e payload estrito", async () => {
      const empresaA = await empresa(db, "Empresa envelope A");
      const empresaB = await empresa(db, "Empresa envelope B");
      const usuarioId = await usuario(db);
      await membership(db, empresaA, usuarioId);
      await membership(db, empresaB, usuarioId);
      const adicionalId = (await db.query<{ id: string }>(
        `INSERT INTO adicionais (empresa_id, codigo, nome, categoria, categoria_id, unidade_cobranca, ordem_exibicao)
         SELECT $1::uuid, $2, 'Adicional envelope', categoria, categoria_id, unidade_cobranca, 420
           FROM adicionais WHERE codigo = 'SALADA_PREMIUM' RETURNING id`,
        [empresaA, codigo("HG8E").toUpperCase()],
      )).rows[0].id;
      const modulo = carregarCatalogo({ usuario_id: usuarioId, papel: "REPRESENTANTE_AUTORIZADO" });
      const patch = modulo.PATCH as (request: object) => Promise<{ status: number; json: () => Promise<unknown> }>;
      const semEmpresa = await corpo(await patch(pedido({
        acao: "adicional", id: adicionalId, nome: "Nao deve", ativo: true,
      })));
      assert.equal(semEmpresa.status, 403);
      assert.equal(semEmpresa.json.codigo, "TENANT_NAO_COMPROVADO");
      const alheia = await corpo(await patch(pedido({
        empresaId: randomUUID(),
        acao: "adicional",
        id: adicionalId,
        nome: "Nao deve",
        ativo: true,
      })));
      assert.equal(alheia.status, 403);
      assert.equal(alheia.json.codigo, "TENANT_NAO_COMPROVADO");
      const invalido = await corpo(await patch(pedido({
        empresaId: empresaA,
        acao: "adicional",
        id: adicionalId,
        nome: "Invalido",
      })));
      assert.equal(invalido.status, 400);
      assert.equal(invalido.json.codigo, "DADOS_INVALIDOS");
      const nome = await db.query<{ nome: string }>("SELECT nome FROM adicionais WHERE id = $1::uuid", [adicionalId]);
      assert.equal(nome.rows[0].nome, "Adicional envelope");
      const autorizado = await corpo(await patch(pedido({
        empresaId: empresaA,
        acao: "adicional",
        id: adicionalId,
        nome: "Adicional autorizado",
        ativo: true,
      })));
      assert.equal(autorizado.status, 200, JSON.stringify(autorizado.json));
      const gravado = await db.query<{ nome: string }>("SELECT nome FROM adicionais WHERE id = $1::uuid", [adicionalId]);
      assert.equal(gravado.rows[0].nome, "Adicional autorizado");
    });
  } finally {
    try {
      await limpar(db);
      const resto = await db.query<{ empresas: number; legado: number; kidmais: number }>(
        `SELECT
           (SELECT count(*)::int FROM empresas WHERE codigo LIKE 'hg8c%') AS empresas,
           (SELECT count(*)::int FROM pacotes WHERE empresa_id IS NULL) AS legado,
           (SELECT count(*)::int FROM empresas WHERE codigo ILIKE '%kidmais%' OR nome ILIKE '%kidmais%') AS kidmais`,
      );
      assert.equal(resto.rows[0].empresas, 0);
      assert.equal(resto.rows[0].legado, 7);
      assert.equal(resto.rows[0].kidmais, 0);
    } finally {
      await encerrarDescartavel(db);
    }
  }
});
