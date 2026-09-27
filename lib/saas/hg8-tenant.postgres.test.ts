import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import type { DbExecutor } from "../db/contracts.ts";
import { listarPacotesAdmin } from "../comercial/pacotes-admin.ts";
import { PacoteAdminError } from "../comercial/pacotes-admin.ts";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import { executarNoTenant, provarTenant } from "./provar-tenant.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function texto(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function codigo() {
  return `hg8p${randomBytes(4).toString("hex")}`;
}

function senhaFalsa() {
  return `scrypt$v=1$N=131072$r=8$p=1$${ "A".repeat(22) }==$${ "B".repeat(86) }==`;
}

function executor(client: Client): DbExecutor {
  return {
    async query<Row extends object>(text: string, values: readonly unknown[] = []) {
      const result = await client.query(text, [...values]);
      return { rows: result.rows as Row[], rowCount: result.rowCount };
    },
  };
}

async function empresa(client: Client, nome = "Empresa provada") {
  const id = (await client.query<{ id: string }>(
    `INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id`,
    [codigo(), nome],
  )).rows[0].id;
  await client.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [id]);
  return id;
}

async function usuario(client: Client, ativo = true) {
  return (await client.query<{ id: string }>(
    `INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo)
     VALUES ($1, 'Operador', $2, 'REPRESENTANTE_AUTORIZADO', $3) RETURNING id`,
    [`${codigo()}@example.test`, senhaFalsa(), ativo],
  )).rows[0].id;
}

async function membership(client: Client, empresaId: string, usuarioId: string, status: "PENDENTE" | "ATIVA" | "REVOGADA") {
  const id = (await client.query<{ id: string }>(
    `INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde)
     VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp()) RETURNING id`,
    [empresaId, usuarioId],
  )).rows[0].id;
  if (status === "ATIVA" || status === "REVOGADA") {
    await client.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [id]);
  }
  if (status === "REVOGADA") {
    await client.query(`UPDATE memberships SET status = 'REVOGADA' WHERE id = $1::uuid`, [id]);
  }
  return id;
}

function sessao(usuarioId: string) {
  return { usuario_id: usuarioId, papel: "REPRESENTANTE_AUTORIZADO" };
}

async function recusaProva(client: Client, usuarioId: string, empresaId?: string) {
  await client.query("SAVEPOINT prova");
  let code = "";
  try {
    await provarTenant(executor(client), sessao(usuarioId), empresaId);
    code = "passou";
  } catch (error) {
    code = error instanceof PacoteAdminError ? error.code : texto(error);
  }
  await client.query("ROLLBACK TO SAVEPOINT prova");
  assert.equal(code, "TENANT_NAO_COMPROVADO");
}

function esperar(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidsDe(valor: unknown) {
  if (Array.isArray(valor)) return valor.map((item) => Number(item));
  return String(valor ?? "").replace(/[{}]/g, "").split(",").filter(Boolean).map((item) => Number(item));
}

async function esperarBloqueadoPor(observador: Client, pid: number, bloqueador: number) {
  const inicio = Date.now();
  while (Date.now() - inicio < 8_000) {
    const linha = await observador.query<{ pids: unknown }>(
      "SELECT pg_blocking_pids($1::integer) AS pids",
      [pid],
    );
    if (pidsDe(linha.rows[0]?.pids).includes(bloqueador)) return;
    await esperar(20);
  }
  assert.fail("a sessão concorrente não ficou bloqueada pela trava da outra");
}

function rastrear(trabalho: Promise<string>) {
  let terminou = false;
  const promessa = trabalho.finally(() => {
    terminou = true;
  });
  return {
    promessa,
    async aindaEspera() {
      await new Promise((resolve) => setTimeout(resolve, 600));
      assert.equal(terminou, false, "a revogação não ficou bloqueada");
    },
  };
}

async function limpar(client: Client) {
  await client.query("ALTER TABLE memberships DISABLE TRIGGER USER");
  await client.query("ALTER TABLE empresas DISABLE TRIGGER USER");
  try {
    await client.query(
      `DELETE FROM pacotes WHERE empresa_id IN (SELECT id FROM empresas WHERE codigo LIKE 'hg8p%')`,
    );
    await client.query(
      `DELETE FROM memberships
        WHERE empresa_id IN (SELECT id FROM empresas WHERE codigo LIKE 'hg8p%')
           OR usuario_id IN (SELECT id FROM usuarios_administrativos WHERE email LIKE 'hg8p%@example.test')`,
    );
    await client.query("DELETE FROM empresas WHERE codigo LIKE 'hg8p%'");
    await client.query("DELETE FROM usuarios_administrativos WHERE email LIKE 'hg8p%@example.test'");
  } finally {
    await client.query("ALTER TABLE empresas ENABLE TRIGGER USER");
    await client.query("ALTER TABLE memberships ENABLE TRIGGER USER");
  }
}

test("prova de tenant no postgres descartável", { timeout: 180_000 }, async (t) => {
  assert.equal(readFileSync(resolve(root, "lib/autenticacao/service.ts"), "utf8").includes("empresaComprovada"), false);
  const client = await conectarDescartavel();
  const db = client as unknown as Client;
  const tx = executor(db);
  try {
    const ident = await db.query<{ db: string; port: number }>(
      "SELECT current_database() AS db, inet_server_port() AS port",
    );
    assert.equal(ident.rows[0].db, "kidmais_pacotes_v1_descartavel");
    assert.equal(Number(ident.rows[0].port), 55498);

    await t.test("só membership ativa em empresa ativa prova, e o id do cliente só escolhe", async () => {
      await db.query("BEGIN");
      try {
        const empresaA = await empresa(db, "Empresa A");
        const empresaB = await empresa(db, "Empresa B");
        const usuarioA = await usuario(db);
        const semVinculo = await usuario(db);
        const dois = await usuario(db);
        await membership(db, empresaA, usuarioA, "ATIVA");
        await membership(db, empresaA, dois, "ATIVA");
        await membership(db, empresaB, dois, "ATIVA");
        const provada = await provarTenant(tx, sessao(usuarioA));
        assert.equal(provada.empresaComprovada, empresaA);
        assert.equal((await provarTenant(tx, sessao(usuarioA), empresaA)).empresaComprovada, empresaA);
        await recusaProva(db, usuarioA, empresaB);
        await recusaProva(db, usuarioA, randomUUID());
        await recusaProva(db, semVinculo);
        await recusaProva(db, dois);
        assert.equal((await provarTenant(tx, sessao(dois), empresaB)).empresaComprovada, empresaB);

        const pendente = await usuario(db);
        await membership(db, empresaA, pendente, "PENDENTE");
        await recusaProva(db, pendente, empresaA);
        const revogado = await usuario(db);
        await membership(db, empresaA, revogado, "REVOGADA");
        await recusaProva(db, revogado, empresaA);
        const inativo = await usuario(db, false);
        await membership(db, empresaA, inativo, "ATIVA");
        await recusaProva(db, inativo, empresaA);

        await db.query(`UPDATE empresas SET status = 'SUSPENSA' WHERE id = $1::uuid`, [empresaB]);
        await recusaProva(db, dois, empresaB);
        await db.query(`UPDATE empresas SET status = 'DESATIVADA' WHERE id = $1::uuid`, [empresaB]);
        await recusaProva(db, dois, empresaB);

        await db.query(
          `INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente)
           VALUES ($1::uuid, $2, 'Pacote da empresa', 900, true, true)`,
          [empresaA, `HG8P_${randomBytes(3).toString("hex").toUpperCase()}`],
        );
        const lista = await listarPacotesAdmin(tx, provada.empresaComprovada);
        const legado = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pacotes WHERE empresa_id IS NULL AND codigo = ANY($1::text[])`,
          [lista.map((item) => item.codigo)],
        );
        assert.equal(legado.rows[0].n, 0);
        assert.equal(lista.every((item) => item.empresaId === empresaA), true);
      } finally {
        await db.query("ROLLBACK");
      }
    });

    await t.test("a operação não confirma depois de uma revogação já confirmada", async () => {
      await db.query("BEGIN");
      const empresaId = await empresa(db);
      const usuarioId = await usuario(db);
      const membershipId = await membership(db, empresaId, usuarioId, "ATIVA");
      await db.query("COMMIT");
      const outro = await conectarDescartavel({ travar: false });
      try {
        await outro.query("BEGIN");
        await outro.query(`UPDATE memberships SET status = 'REVOGADA' WHERE id = $1::uuid`, [membershipId]);
        await outro.query("COMMIT");
        await db.query("BEGIN");
        let code = "";
        try {
          await executarNoTenant(tx, sessao(usuarioId), empresaId, async (transacao) => {
            await transacao.query(`UPDATE empresas SET nome = 'nao-deve-gravar' WHERE id = $1::uuid`, [empresaId]);
          });
          code = "passou";
        } catch (error) {
          code = error instanceof PacoteAdminError ? error.code : texto(error);
        }
        await db.query("ROLLBACK");
        assert.equal(code, "TENANT_NAO_COMPROVADO");
        const nome = await db.query<{ nome: string }>("SELECT nome FROM empresas WHERE id = $1::uuid", [empresaId]);
        assert.equal(nome.rows[0].nome, "Empresa provada");
      } finally {
        await outro.query("ROLLBACK").catch(() => undefined);
        await outro.end();
      }
    });

    await t.test("a revogação espera a operação que já travou a membership", async () => {
      await db.query("BEGIN");
      const empresaId = await empresa(db, "Empresa da corrida");
      const usuarioId = await usuario(db);
      const membershipId = await membership(db, empresaId, usuarioId, "ATIVA");
      await db.query("COMMIT");
      const titular = await conectarDescartavel({ travar: false });
      const outro = await conectarDescartavel({ travar: false });
      try {
        await titular.query("BEGIN");
        await executarNoTenant(executor(titular), sessao(usuarioId), null, async (transacao) => {
          await transacao.query(`UPDATE empresas SET nome = 'operacao-d10' WHERE id = $1::uuid`, [empresaId]);
        });
        const corrida = rastrear((async () => {
          await outro.query("BEGIN");
          await outro.query(`UPDATE memberships SET status = 'REVOGADA' WHERE id = $1::uuid`, [membershipId]);
          await outro.query("COMMIT");
          return "ok";
        })());
        await corrida.aindaEspera();
        await titular.query("COMMIT");
        assert.equal(await corrida.promessa, "ok");
        const nome = await db.query<{ nome: string }>("SELECT nome FROM empresas WHERE id = $1::uuid", [empresaId]);
        assert.equal(nome.rows[0].nome, "operacao-d10");
        await db.query("BEGIN");
        await recusaProva(db, usuarioId, empresaId);
        await db.query("ROLLBACK");
      } finally {
        await titular.query("ROLLBACK").catch(() => undefined);
        await outro.query("ROLLBACK").catch(() => undefined);
        await titular.end();
        await outro.end();
      }
    });

    await t.test("a suspensão não confirma enquanto a operação segura a empresa", async () => {
      await db.query("BEGIN");
      const empresaId = await empresa(db, "Empresa da suspensão");
      const usuarioId = await usuario(db);
      await membership(db, empresaId, usuarioId, "ATIVA");
      await db.query("COMMIT");
      const titular = await conectarDescartavel({ travar: false });
      const outro = await conectarDescartavel({ travar: false });
      const titularPid = Number((await titular.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      const suspensaoPid = Number((await outro.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      let fase = "inicio";
      let liberar = () => undefined as void;
      const segurar = new Promise<void>((resolve) => {
        liberar = resolve;
      });
      try {
        const operacao = (async () => {
          await titular.query("BEGIN");
          await executarNoTenant(executor(titular), sessao(usuarioId), null, async () => {
            fase = "segura";
            await segurar;
          });
          await titular.query("COMMIT");
        })();
        const inicio = Date.now();
        while (fase !== "segura") {
          if (Date.now() - inicio > 8_000) assert.fail("a operação não segurou a empresa");
          await esperar(20);
        }
        const suspensao = (async () => {
          await outro.query("BEGIN");
          await outro.query(`UPDATE empresas SET status = 'SUSPENSA' WHERE id = $1::uuid`, [empresaId]);
          await outro.query("COMMIT");
        })();
        await esperarBloqueadoPor(db, suspensaoPid, titularPid);
        const durante = await db.query<{ nome: string; status: string }>(
          "SELECT nome, status FROM empresas WHERE id = $1::uuid",
          [empresaId],
        );
        assert.equal(fase, "segura");
        assert.equal(durante.rows[0].nome, "Empresa da suspensão");
        assert.equal(durante.rows[0].status, "ATIVA");
        liberar();
        await operacao;
        await suspensao;
        const estado = await db.query<{ nome: string; status: string }>(
          "SELECT nome, status FROM empresas WHERE id = $1::uuid",
          [empresaId],
        );
        assert.equal(estado.rows[0].nome, "Empresa da suspensão");
        assert.equal(estado.rows[0].status, "SUSPENSA");
      } finally {
        liberar();
        await titular.query("ROLLBACK").catch(() => undefined);
        await outro.query("ROLLBACK").catch(() => undefined);
        await titular.end();
        await outro.end();
      }
    });

    await t.test("a suspensão que chega primeiro faz a operação esperar e recusar", async () => {
      await db.query("BEGIN");
      const empresaId = await empresa(db, "Empresa suspensa primeiro");
      const usuarioId = await usuario(db);
      await membership(db, empresaId, usuarioId, "ATIVA");
      await db.query("COMMIT");
      const titular = await conectarDescartavel({ travar: false });
      const outro = await conectarDescartavel({ travar: false });
      const titularPid = Number((await titular.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      const suspensaoPid = Number((await outro.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      let entrou = false;
      let code = "";
      try {
        await outro.query("BEGIN");
        await outro.query(`UPDATE empresas SET status = 'SUSPENSA' WHERE id = $1::uuid`, [empresaId]);
        const operacao = (async () => {
          await titular.query("BEGIN");
          try {
            await executarNoTenant(executor(titular), sessao(usuarioId), null, async () => {
              entrou = true;
            });
            await titular.query("COMMIT");
            code = "passou";
          } catch (error) {
            code = error instanceof PacoteAdminError ? error.code : texto(error);
            await titular.query("ROLLBACK").catch(() => undefined);
          }
        })();
        await esperarBloqueadoPor(db, titularPid, suspensaoPid);
        const durante = await db.query<{ nome: string; status: string }>(
          "SELECT nome, status FROM empresas WHERE id = $1::uuid",
          [empresaId],
        );
        assert.equal(entrou, false);
        assert.equal(durante.rows[0].nome, "Empresa suspensa primeiro");
        assert.equal(durante.rows[0].status, "ATIVA");
        await outro.query("COMMIT");
        await operacao;
        assert.equal(code.toLowerCase().includes("deadlock"), false, code);
        assert.equal(code, "TENANT_NAO_COMPROVADO");
        assert.equal(entrou, false);
        const estado = await db.query<{ nome: string; status: string }>(
          "SELECT nome, status FROM empresas WHERE id = $1::uuid",
          [empresaId],
        );
        assert.equal(estado.rows[0].nome, "Empresa suspensa primeiro");
        assert.equal(estado.rows[0].status, "SUSPENSA");
      } finally {
        await titular.query("ROLLBACK").catch(() => undefined);
        await outro.query("ROLLBACK").catch(() => undefined);
        await titular.end();
        await outro.end();
      }
    });

    await t.test("suspensão já confirmada impede a operação seguinte", async () => {
      await db.query("BEGIN");
      const empresaId = await empresa(db, "Empresa já suspensa");
      const usuarioId = await usuario(db);
      await membership(db, empresaId, usuarioId, "ATIVA");
      await db.query("COMMIT");
      const titular = await conectarDescartavel({ travar: false });
      try {
        await db.query(`UPDATE empresas SET status = 'SUSPENSA' WHERE id = $1::uuid`, [empresaId]);
        await titular.query("BEGIN");
        let code = "";
        try {
          await executarNoTenant(executor(titular), sessao(usuarioId), empresaId, async (transacao) => {
            await transacao.query(`UPDATE empresas SET nome = 'nao-deve-suspensa' WHERE id = $1::uuid`, [empresaId]);
          });
          await titular.query("COMMIT");
          code = "passou";
        } catch (error) {
          code = error instanceof PacoteAdminError ? error.code : texto(error);
          await titular.query("ROLLBACK");
        }
        assert.equal(code, "TENANT_NAO_COMPROVADO");
        const estado = await db.query<{ nome: string; status: string }>(
          "SELECT nome, status FROM empresas WHERE id = $1::uuid",
          [empresaId],
        );
        assert.equal(estado.rows[0].nome, "Empresa já suspensa");
        assert.equal(estado.rows[0].status, "SUSPENSA");
      } finally {
        await titular.query("ROLLBACK").catch(() => undefined);
        await titular.end();
      }
    });

    await t.test("a desativação não confirma enquanto a operação segura a empresa", async () => {
      await db.query("BEGIN");
      const empresaId = await empresa(db, "Empresa da desativação");
      const usuarioId = await usuario(db);
      await membership(db, empresaId, usuarioId, "ATIVA");
      await db.query("COMMIT");
      const titular = await conectarDescartavel({ travar: false });
      const outro = await conectarDescartavel({ travar: false });
      let fase = "inicio";
      let desativacaoTerminou = false;
      try {
        const operacao = (async () => {
          await titular.query("BEGIN");
          await executarNoTenant(executor(titular), sessao(usuarioId), null, async (transacao) => {
            await transacao.query(`UPDATE empresas SET nome = 'mutacao-desativada' WHERE id = $1::uuid`, [empresaId]);
            fase = "segura";
            await esperar(800);
          });
          await titular.query("COMMIT");
        })();
        while (fase !== "segura") await esperar(20);
        const desativacao = (async () => {
          await outro.query("BEGIN");
          await outro.query(`UPDATE empresas SET status = 'DESATIVADA' WHERE id = $1::uuid`, [empresaId]);
          desativacaoTerminou = true;
          await outro.query("COMMIT");
        })();
        await esperar(350);
        assert.equal(fase, "segura");
        assert.equal(desativacaoTerminou, false);
        await operacao;
        await desativacao;
        const estado = await db.query<{ nome: string; status: string }>(
          "SELECT nome, status FROM empresas WHERE id = $1::uuid",
          [empresaId],
        );
        assert.equal(estado.rows[0].nome, "mutacao-desativada");
        assert.equal(estado.rows[0].status, "DESATIVADA");
      } finally {
        await titular.query("ROLLBACK").catch(() => undefined);
        await outro.query("ROLLBACK").catch(() => undefined);
        await titular.end();
        await outro.end();
      }
    });

    await t.test("desativação já confirmada impede a operação seguinte", async () => {
      await db.query("BEGIN");
      const empresaId = await empresa(db, "Empresa já desativada");
      const usuarioId = await usuario(db);
      await membership(db, empresaId, usuarioId, "ATIVA");
      await db.query("COMMIT");
      const titular = await conectarDescartavel({ travar: false });
      try {
        await db.query(`UPDATE empresas SET status = 'DESATIVADA' WHERE id = $1::uuid`, [empresaId]);
        await titular.query("BEGIN");
        let code = "";
        try {
          await executarNoTenant(executor(titular), sessao(usuarioId), empresaId, async (transacao) => {
            await transacao.query(`UPDATE empresas SET nome = 'nao-deve-desativada' WHERE id = $1::uuid`, [empresaId]);
          });
          await titular.query("COMMIT");
          code = "passou";
        } catch (error) {
          code = error instanceof PacoteAdminError ? error.code : texto(error);
          await titular.query("ROLLBACK");
        }
        assert.equal(code, "TENANT_NAO_COMPROVADO");
        const estado = await db.query<{ nome: string; status: string }>(
          "SELECT nome, status FROM empresas WHERE id = $1::uuid",
          [empresaId],
        );
        assert.equal(estado.rows[0].nome, "Empresa já desativada");
        assert.equal(estado.rows[0].status, "DESATIVADA");
      } finally {
        await titular.query("ROLLBACK").catch(() => undefined);
        await titular.end();
      }
    });

    await t.test("suspensão e revogação não deadlockam com a operação", async () => {
      await db.query("BEGIN");
      const empresaId = await empresa(db, "Empresa da ordem");
      const usuarioId = await usuario(db);
      const membershipId = await membership(db, empresaId, usuarioId, "ATIVA");
      await db.query("COMMIT");
      const titular = await conectarDescartavel({ travar: false });
      const suspensao = await conectarDescartavel({ travar: false });
      const revogacao = await conectarDescartavel({ travar: false });
      let fase = "inicio";
      let erroSuspensao = "";
      let erroRevogacao = "";
      try {
        const operacao = (async () => {
          await titular.query("BEGIN");
          await executarNoTenant(executor(titular), sessao(usuarioId), null, async (transacao) => {
            await transacao.query(`UPDATE empresas SET nome = 'trava-ordem' WHERE id = $1::uuid`, [empresaId]);
            fase = "segura";
            await esperar(800);
          });
          await titular.query("COMMIT");
        })();
        while (fase !== "segura") await esperar(20);
        const pendurarSuspensao = (async () => {
          try {
            await suspensao.query("BEGIN");
            await suspensao.query(`UPDATE empresas SET status = 'SUSPENSA' WHERE id = $1::uuid`, [empresaId]);
            await suspensao.query("COMMIT");
          } catch (error) {
            erroSuspensao = texto(error);
            await suspensao.query("ROLLBACK").catch(() => undefined);
          }
        })();
        const pendurarRevogacao = (async () => {
          try {
            await revogacao.query("BEGIN");
            await revogacao.query(`UPDATE memberships SET status = 'REVOGADA' WHERE id = $1::uuid`, [membershipId]);
            await revogacao.query("COMMIT");
          } catch (error) {
            erroRevogacao = texto(error);
            await revogacao.query("ROLLBACK").catch(() => undefined);
          }
        })();
        await esperar(350);
        assert.equal(fase, "segura");
        await operacao;
        await pendurarSuspensao;
        await pendurarRevogacao;
        assert.equal(erroSuspensao.toLowerCase().includes("deadlock"), false, erroSuspensao);
        assert.equal(erroRevogacao.toLowerCase().includes("deadlock"), false, erroRevogacao);
        assert.equal(erroSuspensao, "");
        assert.equal(erroRevogacao, "");
        const estado = await db.query<{ nome: string; status: string; membership: string }>(
          `SELECT e.nome, e.status, m.status AS membership
             FROM empresas e
             JOIN memberships m ON m.empresa_id = e.id
            WHERE e.id = $1::uuid AND m.id = $2::uuid`,
          [empresaId, membershipId],
        );
        assert.equal(estado.rows[0].nome, "trava-ordem");
        assert.equal(estado.rows[0].status, "SUSPENSA");
        assert.equal(estado.rows[0].membership, "REVOGADA");
      } finally {
        await titular.query("ROLLBACK").catch(() => undefined);
        await suspensao.query("ROLLBACK").catch(() => undefined);
        await revogacao.query("ROLLBACK").catch(() => undefined);
        await titular.end();
        await suspensao.end();
        await revogacao.end();
      }
    });

    await t.test("duas operações na mesma empresa seguem a ordem e não deadlockam", async () => {
      await db.query("BEGIN");
      const empresaId = await empresa(db, "Empresa compartilhada");
      const usuarioA = await usuario(db);
      const usuarioB = await usuario(db);
      await membership(db, empresaId, usuarioA, "ATIVA");
      await membership(db, empresaId, usuarioB, "ATIVA");
      await db.query("COMMIT");
      const primeira = await conectarDescartavel({ travar: false });
      const segunda = await conectarDescartavel({ travar: false });
      let fase = "inicio";
      let erroSegunda = "";
      try {
        const operacaoA = (async () => {
          await primeira.query("BEGIN");
          await executarNoTenant(executor(primeira), sessao(usuarioA), empresaId, async (transacao) => {
            await transacao.query(`UPDATE empresas SET nome = 'ordem-a' WHERE id = $1::uuid`, [empresaId]);
            fase = "segura";
            await esperar(700);
          });
          await primeira.query("COMMIT");
        })();
        while (fase !== "segura") await esperar(20);
        const inicio = Date.now();
        try {
          await segunda.query("BEGIN");
          await executarNoTenant(executor(segunda), sessao(usuarioB), empresaId, async (transacao) => {
            await transacao.query(`UPDATE empresas SET nome = 'ordem-b' WHERE id = $1::uuid`, [empresaId]);
          });
          await segunda.query("COMMIT");
        } catch (error) {
          erroSegunda = texto(error);
          await segunda.query("ROLLBACK").catch(() => undefined);
        }
        const espera = Date.now() - inicio;
        await operacaoA;
        assert.equal(erroSegunda.toLowerCase().includes("deadlock"), false, erroSegunda);
        assert.equal(erroSegunda, "");
        assert.equal(espera >= 300, true);
        const nome = await db.query<{ nome: string }>("SELECT nome FROM empresas WHERE id = $1::uuid", [empresaId]);
        assert.equal(nome.rows[0].nome, "ordem-b");
      } finally {
        await primeira.query("ROLLBACK").catch(() => undefined);
        await segunda.query("ROLLBACK").catch(() => undefined);
        await primeira.end();
        await segunda.end();
      }
    });
  } finally {
    try {
      await db.query("ROLLBACK");
    } catch {
      /* sem transação */
    }
    try {
      await limpar(db);
      const resto = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM empresas WHERE codigo LIKE 'hg8p%'");
      const legado = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pacotes WHERE empresa_id IS NULL");
      assert.equal(resto.rows[0].n, 0);
      assert.equal(legado.rows[0].n, 7);
    } finally {
      await encerrarDescartavel(db);
    }
  }
});
