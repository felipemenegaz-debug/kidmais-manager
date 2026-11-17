import test from "node:test";
import assert from "node:assert/strict";
import type { Client } from "pg";
import type { DbExecutor } from "../db/contracts.ts";
import type { TenantComprovado } from "../saas/provar-tenant.ts";
import { cenario, executor, representante } from "../../scripts/integracao-importados-test-support.ts";
import { calcularCondicaoComercial } from "./condicao-pagamento.ts";
import { conectarDescartavel, encerrarDescartavel } from "./postgres-descartavel.ts";
import { lerDescontosAdmin, salvarDescontosAdmin } from "./regras-pagamento-admin.ts";
import { lerRegrasPagamento, regraNaCondicao, REGRAS_NEUTRAS, regrasPagamentoInstaladas } from "./regras-pagamento.ts";

/**
 * D1 (16/11/2026) — Descontos e formas de pagamento no PostgreSQL DESCARTÁVEL (postgres-descartavel), com o serviço real.
 *   Modelo 122 (com a 077): sugestão sem efeito até salvar; gravação da própria linha; isolamento entre empresas;
 *   histórico com autor; versão otimista (409); teto (400); equipe (403); a transação só escreve na 077 e na auditoria;
 *   condição criada antes mantém o percentual copiado; Kidmais intacta (e o selo preservado se a Gestão dela salvar).
 *   Modelo 075 (sem a 077): leitura "indisponível" e gravação 503, sem tabela e sem auditoria.
 */
let client: Client;
let tx: DbExecutor;
const ESPERADAS = new Set(["empresa_regras_pagamento", "auditoria"]);

async function emTransacao<T>(trabalho: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    const r = await trabalho();
    await client.query("COMMIT");
    return r;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}

/**
 * Grava e devolve as tabelas que a gravação escreveu. pg_stat_xact_user_tables também carrega contadores ainda não
 * enviados de comandos anteriores na mesma conexão (fixtures), então mede a diferença antes/depois dentro da transação.
 */
async function salvarMedindo(tenant: TenantComprovado, corpo: unknown) {
  const contar = async () => new Map((await client.query<{ relname: string; n: string }>(
    "SELECT relname, (n_tup_ins + n_tup_upd + n_tup_del)::text AS n FROM pg_stat_xact_user_tables")).rows.map((r) => [r.relname, Number(r.n)] as const));
  return emTransacao(async () => {
    const antes = await contar();
    const estado = await salvarDescontosAdmin(tx, tenant, corpo, { requestId: null });
    const depois = await contar();
    const escritas = [...depois].filter(([nome, n]) => n > (antes.get(nome) ?? 0)).map(([nome]) => nome).sort();
    return { estado, escritas };
  });
}

const linha = async (empresa: string) => (await client.query(
  "SELECT pix_avista_percentual AS a, pix_parcelado_percentual AS p, cartao_rotulo AS c, desconto_dia_util AS d, motivo, atualizado_em::text AS v FROM empresa_regras_pagamento WHERE empresa_id = $1::uuid",
  [empresa])).rows[0] ?? null;
const auditorias = async () => Number((await client.query("SELECT count(*)::int AS n FROM auditoria WHERE entidade_tipo = 'EMPRESA_REGRAS_PAGAMENTO'")).rows[0].n);
const rejeita = async (p: Promise<unknown>, codigo: string, status: number) =>
  assert.rejects(p, (e: { code?: string; httpStatus?: number }) => e.code === codigo && e.httpStatus === status, codigo);

test.before(async () => {
  client = await conectarDescartavel();
  tx = executor(client);
});
test.after(async () => {
  if (client) await encerrarDescartavel(client);
});

test("D1 no banco: sugestão sem efeito, gravação própria, isolamento, histórico, versão, teto, equipe e Kidmais intacta", async (t) => {
  if (!(await regrasPagamentoInstaladas(tx))) {
    t.skip("modelo sem a 077: coberto pelo teste seguinte");
    return;
  }
  const A = await cenario(client);
  const B = await cenario(client);
  const gestaoA = await representante(client, A) as TenantComprovado;
  const gestaoB = await representante(client, B) as TenantComprovado;
  const kidmais = (await client.query<{ id: string }>("SELECT id FROM empresas WHERE codigo = 'kidmais'")).rows[0]?.id;
  assert.ok(kidmais, "a Kidmais existe no modelo");
  const kidmaisAntes = await linha(kidmais);
  assert.deepEqual([kidmaisAntes.a, kidmaisAntes.p, kidmaisAntes.c, kidmaisAntes.d], [10, 3, "Cielo", true], "semente da 077");

  // Buffet novo sem linha: a tela sugere 5%/2%, mas o que vale para fechamentos novos continua 0% — e ler não grava.
  const inicial = await emTransacao(() => lerDescontosAdmin(tx, gestaoA));
  assert.ok(inicial.instalada);
  assert.deepEqual([inicial.configurada, inicial.versao, inicial.historico.length], [false, null, 0]);
  assert.deepEqual(inicial.formulario, { pixAvistaPercentual: 5, pixParceladoPercentual: 2, cartaoRotulo: "Cartão de crédito" });
  assert.deepEqual(inicial.vigente, REGRAS_NEUTRAS);
  assert.equal(await linha(A.empresa), null, "a sugestão nunca é gravada sozinha");
  assert.deepEqual(await lerRegrasPagamento(tx, A.empresa), REGRAS_NEUTRAS);

  // Condição criada ANTES de salvar: o percentual (0) é copiado nela e o valor do contrato sai do copiado.
  const condicaoAntiga = await regraNaCondicao(tx, A.empresa, "PIX_AVISTA");
  assert.deepEqual(condicaoAntiga, { descontoPercentual: 0 });
  const contratoAntigo = calcularCondicaoComercial(4000, "PIX_AVISTA", condicaoAntiga.descontoPercentual);

  // Equipe (sem Gestão) e valores acima do teto: recusados, nada escrito.
  await rejeita(emTransacao(() => salvarDescontosAdmin(tx, A.tenant as TenantComprovado, { pixAvistaPercentual: 7, pixParceladoPercentual: 3, cartaoRotulo: "Visa", versao: null }, { requestId: null })), "PAPEL_NAO_AUTORIZADO", 403);
  await rejeita(emTransacao(() => lerDescontosAdmin(tx, A.tenant as TenantComprovado)), "PAPEL_NAO_AUTORIZADO", 403);
  await rejeita(emTransacao(() => salvarDescontosAdmin(tx, gestaoA, { pixAvistaPercentual: 51, pixParceladoPercentual: 3, cartaoRotulo: "Visa", versao: null }, { requestId: null })), "DESCONTO_ACIMA_DO_TETO", 400);
  assert.equal(await linha(A.empresa), null);
  const auditoriasAntes = await auditorias();

  // Gestão de A salva: cria a linha DELA, sem selo; a transação escreve só na 077 e na auditoria.
  const r1 = await salvarMedindo(gestaoA, { pixAvistaPercentual: 7, pixParceladoPercentual: 3, cartaoRotulo: "  Cartão   Visa ", versao: null });
  assert.deepEqual(r1.escritas.filter((n) => !ESPERADAS.has(n)), [], `escreveu fora: ${r1.escritas.join(",")}`);
  const a1 = await linha(A.empresa);
  assert.deepEqual([a1.a, a1.p, a1.c, a1.d, a1.motivo], [7, 3, "Cartão Visa", false, "Configurações › Descontos e formas de pagamento"]);
  assert.ok(r1.estado.instalada && r1.estado.configurada && r1.estado.versao === a1.v);
  assert.deepEqual(r1.estado.historico.map((h) => [h.por, h.mudancas]), [["Representante 062", ["Pix à vista: 0% → 7%", "Pix parcelado: 0% → 3%", "Nome do cartão: Cartão de crédito → Cartão Visa"]]]);
  assert.equal(await auditorias(), auditoriasAntes + 1);
  const aud = (await client.query("SELECT usuario_id::text AS u, entidade_id::text AS e, dados_depois->>'empresaId' AS emp FROM auditoria WHERE entidade_tipo = 'EMPRESA_REGRAS_PAGAMENTO' ORDER BY criado_em DESC LIMIT 1")).rows[0];
  assert.deepEqual([aud.u, aud.e, aud.emp], [gestaoA.usuarioId, A.empresa, A.empresa]);

  // Vale só para o que vier depois: condição nova copia 7%; a antiga continua com 0% e o mesmo valor.
  assert.deepEqual(await regraNaCondicao(tx, A.empresa, "PIX_AVISTA"), { descontoPercentual: 7 });
  assert.deepEqual(calcularCondicaoComercial(4000, "PIX_AVISTA", condicaoAntiga.descontoPercentual), contratoAntigo);
  assert.equal(contratoAntigo.valorFinalContrato, 4000);

  // Isolamento: B continua sem linha, com a sugestão, e não vê o histórico de A; Kidmais intacta.
  const deB = await emTransacao(() => lerDescontosAdmin(tx, gestaoB));
  assert.ok(deB.instalada);
  assert.deepEqual([deB.configurada, deB.historico.length, deB.vigente.pixAvistaPercentual], [false, 0, 0]);
  assert.equal(await linha(B.empresa), null);
  assert.deepEqual(await linha(kidmais), kidmaisAntes);

  // Versão otimista: salvar com a versão velha (ou sem versão, como se não houvesse linha) dá 409 e não muda nada.
  await rejeita(emTransacao(() => salvarDescontosAdmin(tx, gestaoA, { pixAvistaPercentual: 9, pixParceladoPercentual: 3, cartaoRotulo: "Visa", versao: null }, { requestId: null })), "DESCONTOS_VERSAO", 409);
  await rejeita(emTransacao(() => salvarDescontosAdmin(tx, gestaoA, { pixAvistaPercentual: 9, pixParceladoPercentual: 3, cartaoRotulo: "Visa", versao: "2000-01-01 00:00:00+00" }, { requestId: null })), "DESCONTOS_VERSAO", 409);
  assert.deepEqual(await linha(A.empresa), a1);

  // Atualização com a versão certa: muda, nova versão, histórico com a mudança mais recente primeiro.
  const r2 = await salvarMedindo(gestaoA, { pixAvistaPercentual: 7, pixParceladoPercentual: 0, cartaoRotulo: "Cartão Visa", versao: a1.v });
  assert.deepEqual(r2.escritas.filter((n) => !ESPERADAS.has(n)), []);
  const a2 = await linha(A.empresa);
  assert.deepEqual([a2.a, a2.p, a2.d], [7, 0, false]);
  assert.notEqual(a2.v, a1.v);
  assert.ok(r2.estado.instalada);
  assert.deepEqual(r2.estado.historico.map((h) => h.mudancas), [["Pix parcelado: 3% → 0%"], ["Pix à vista: 0% → 7%", "Pix parcelado: 0% → 3%", "Nome do cartão: Cartão de crédito → Cartão Visa"]]);
  // Salvar igual não gera histórico nem muda a versão.
  const r3 = await salvarMedindo(gestaoA, { pixAvistaPercentual: 7, pixParceladoPercentual: 0, cartaoRotulo: "Cartão Visa", versao: a2.v });
  assert.deepEqual(r3.escritas, []);
  assert.deepEqual(await linha(A.empresa), a2);

  // Kidmais: a Gestão DELA pode mudar os três campos, mas o selo (desconto do dia útil) fica como está.
  const gestaoK = await representante(client, { empresa: kidmais }) as TenantComprovado;
  const k = await emTransacao(() => lerDescontosAdmin(tx, gestaoK));
  assert.ok(k.instalada);
  assert.deepEqual([k.configurada, k.formulario, k.vigente.descontoDiaUtil], [true, { pixAvistaPercentual: 10, pixParceladoPercentual: 3, cartaoRotulo: "Cielo" }, true]);
  await salvarMedindo(gestaoK, { pixAvistaPercentual: 12, pixParceladoPercentual: 3, cartaoRotulo: "Cielo", versao: k.versao });
  const kDepois = await linha(kidmais);
  assert.deepEqual([kDepois.a, kDepois.p, kDepois.c, kDepois.d], [12, 3, "Cielo", true]);
});

test("D1 sem a 077 no ambiente: leitura indisponível, gravação 503 e nada escrito", async (t) => {
  if (await regrasPagamentoInstaladas(tx)) {
    t.skip("modelo com a 077: coberto pelo teste anterior");
    return;
  }
  const A = await cenario(client);
  const gestaoA = await representante(client, A) as TenantComprovado;
  assert.deepEqual(await emTransacao(() => lerDescontosAdmin(tx, gestaoA)), { instalada: false });
  await rejeita(emTransacao(() => salvarDescontosAdmin(tx, gestaoA, { pixAvistaPercentual: 5, pixParceladoPercentual: 2, cartaoRotulo: "Cartão de crédito", versao: null }, { requestId: null })), "REGRAS_PAGAMENTO_INDISPONIVEL", 503);
  assert.equal((await client.query("SELECT to_regclass('public.empresa_regras_pagamento') IS NULL AS ausente")).rows[0].ausente, true);
  assert.equal(await auditorias(), 0);
});
