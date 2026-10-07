import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import type { DbExecutor } from "../db/contracts.ts";
import { motivoDeExclusao } from "./adicionais-elegiveis.ts";
import { adicionaisDoPacoteNoTenant } from "./adicionais-tenant.ts";
import { PacoteAdminError } from "./pacotes-admin.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

test("regras oficiais: lembrancinha inclusa em Mini/Completa/Premium, adicional em Pocket/Compacta/Essencial", () => {
  const lembrancinha = { codigo: "LEMBRANCINHA_COPO", modalidade: "EXTRA" as const };
  for (const pacote of ["MINI_FESTA", "COMPLETA", "PREMIUM"]) assert.equal(motivoDeExclusao(pacote, lembrancinha), "LEMBRANCINHA_INCLUSA", pacote);
  for (const pacote of ["POCKET", "COMPACTA", "ESSENCIAL"]) assert.equal(motivoDeExclusao(pacote, lembrancinha), null, pacote);
});

test("regras oficiais: empratado premium incluso só na Premium; nunca oferecido como adicional para a Premium", () => {
  const empratado = { codigo: "EMPRATADO_PREMIUM", modalidade: "EXTRA" as const };
  assert.equal(motivoDeExclusao("PREMIUM", empratado), "EMPRATADO_INCLUSO");
  for (const pacote of ["POCKET", "COMPACTA", "ESSENCIAL", "MINI_FESTA", "COMPLETA"]) assert.equal(motivoDeExclusao(pacote, empratado), null, pacote);
});

test("regras oficiais: incluso ou indisponível no pacote e item de buffet incluso nunca aparecem como adicional pago", () => {
  assert.equal(motivoDeExclusao("COMPACTA", { codigo: "SORVETE", modalidade: "INCLUSO" }), "INCLUSO_NO_PACOTE");
  assert.equal(motivoDeExclusao("COMPACTA", { codigo: "SORVETE", modalidade: "INDISPONIVEL" }), "INDISPONIVEL_NO_PACOTE");
  assert.equal(motivoDeExclusao("COMPACTA", { codigo: "SORVETE", modalidade: "EXTRA" }, new Set(["SORVETE"])), "ITEM_DO_BUFFET_INCLUSO");
  assert.equal(motivoDeExclusao("COMPACTA", { codigo: "SORVETE", modalidade: "EXTRA" }), null);
});

/** Banco com dois tenants: o mesmo código de pacote em A e em B, cada um com seus adicionais e preços. */
function banco(tem070 = false) {
  const consultas: Array<{ sql: string; values: readonly unknown[] }> = [];
  const tx: DbExecutor = {
    async query<Row extends object>(sql: string, values: readonly unknown[] = []) {
      consultas.push({ sql, values });
      const r = (rows: object[]) => ({ rows: rows as Row[], rowCount: rows.length });
      if (sql.includes("information_schema.columns")) return r([{ ok: tem070 }]);
      if (sql.includes("FROM buffet_itens")) {
        assert.match(sql, /WHERE ativo AND categoria_id = ANY/);
        return r((values[0] as string[]).includes("cat-salgados") ? [
          { id: "i-coxinha", nome: "Coxinha", categoria_id: "cat-salgados" },
          { id: "i-kibe", nome: "Kibe", categoria_id: "cat-salgados" },
        ] : []);
      }
      if (sql.includes("FROM pacotes")) {
        assert.match(sql, /empresa_id = \$1::uuid AND codigo = \$2 AND vigente AND ativo AND arquivado_em IS NULL/);
        return r(values[0] === A && values[1] === "COMPLETA" ? [{ id: "pacote-a" }] : values[0] === B && values[1] === "COMPLETA" ? [{ id: "pacote-b" }] : []);
      }
      if (sql.includes("FROM tabelas_preco")) {
        assert.match(sql, /empresa_id = \$1::uuid AND publicada_em IS NOT NULL AND substituida_em IS NULL/);
        return r(values[0] === A ? [{ id: "tabela-a" }] : [{ id: "tabela-b" }]);
      }
      if (sql.includes("FROM pacote_adicionais")) {
        assert.match(sql, /a\.empresa_id = \$1::uuid/);
        if (values[1] === "pacote-a") {
          const deCategoria = tem070 ? [
            { codigo: "CATEGORIA_SALGADOS", nome: "Cento de salgados extra", categoria: "BUFFET", unidade_cobranca: "CENTO", modalidade: "EXTRA", valor: "120.00", origem_categoria: "cat-salgados", escolhas_max: 4 },
            { codigo: "CATEGORIA_VAZIA", nome: "Categoria sem itens ativos", categoria: "BUFFET", unidade_cobranca: "CENTO", modalidade: "EXTRA", valor: "90.00", origem_categoria: "cat-vazia", escolhas_max: null },
          ] : [];
          return r([
            ...deCategoria,
            { codigo: "MESA_CAFE", nome: "Mesa de café", categoria: "MESA", unidade_cobranca: "FIXO", modalidade: "EXTRA", valor: "350.00" },
            { codigo: "LEMBRANCINHA_COPO", nome: "Lembrancinha copo", categoria: "EXTRA", unidade_cobranca: "UNIDADE", modalidade: "EXTRA", valor: "9.00" },
            { codigo: "SORVETE", nome: "Sorvete", categoria: "BUFFET", unidade_cobranca: "FIXO", modalidade: "EXTRA", valor: "200.00" },
            { codigo: "PENNE", nome: "Penne", categoria: "BUFFET", unidade_cobranca: "FIXO", modalidade: "INCLUSO", valor: "0.00" },
            { codigo: "ARCO_BALAO_SIMPLES", nome: "Arco", categoria: "DECORACAO", unidade_cobranca: "FIXO", modalidade: "EXTRA", valor: null },
          ]);
        }
        return r([{ codigo: "MESA_FRIOS", nome: "Mesa de frios (B)", categoria: "MESA", unidade_cobranca: "FIXO", modalidade: "EXTRA", valor: "999.00" }]);
      }
      if (sql.includes("FROM pacote_buffet_itens")) return r(values[0] === "pacote-a" ? [{ codigo: "SORVETE" }] : []);
      throw new Error(`consulta inesperada: ${sql.slice(0, 60)}`);
    },
  };
  return { tx, consultas };
}

test("tenant A: só adicionais EXTRA elegíveis, com preço da tabela da empresa; incluso, lembrancinha inclusa e sem preço ficam de fora", async () => {
  const { tx } = banco();
  const r = await adicionaisDoPacoteNoTenant(tx, { empresaId: A, pacoteCodigo: "COMPLETA", data: "2026-11-21", convidados: 80 });
  assert.deepEqual(r.map((a) => a.codigo), ["MESA_CAFE"]);
  assert.equal(r[0].preco, 350);
});

test("tenant B nunca vê adicional de A (mesmo código de pacote) e empresa sem o pacote recebe 404", async () => {
  const { tx } = banco();
  const deB = await adicionaisDoPacoteNoTenant(tx, { empresaId: B, pacoteCodigo: "COMPLETA", data: "2026-11-21", convidados: 80 });
  assert.deepEqual(deB.map((a) => a.nome), ["Mesa de frios (B)"]);
  await assert.rejects(
    adicionaisDoPacoteNoTenant(tx, { empresaId: B, pacoteCodigo: "PREMIUM", data: "2026-11-21", convidados: 80 }),
    (e: unknown) => e instanceof PacoteAdminError && e.httpStatus === 404,
  );
});

test("toda consulta leva a empresa comprovada; dados inválidos são recusados antes do banco", async () => {
  const { tx, consultas } = banco();
  await adicionaisDoPacoteNoTenant(tx, { empresaId: A, pacoteCodigo: "COMPLETA", data: "2026-11-21", convidados: 80 });
  for (const c of consultas.filter((x) => !x.sql.includes("pacote_buffet_itens") && !x.sql.includes("information_schema"))) assert.equal(c.values[0], A, c.sql.slice(0, 40));
  const vazio = banco();
  await assert.rejects(adicionaisDoPacoteNoTenant(vazio.tx, { empresaId: A, pacoteCodigo: "COMPLETA", data: "21/11/2026", convidados: 80 }), /válidos/);
  assert.equal(vazio.consultas.length, 0);
});

test("rota admin prova o tenant; a tela admin usa a rota com Tenant Context, não a pública fechada", () => {
  const rota = readFileSync("app/api/admin/fechamentos/adicionais/route.ts", "utf8");
  assert.match(rota, /exigirApiAdminCrmDisponivel\(request\)/);
  assert.match(rota, /withTenantTransaction\(sessao, parametros\.get\("empresaId"\)/);
  assert.match(rota, /empresaId: tenant\.empresaComprovada/);
  const tela = readFileSync("components/admin/FechamentoAdminWizard.tsx", "utf8");
  assert.match(tela, /\/api\/admin\/fechamentos\/adicionais\?/);
  assert.doesNotMatch(tela, /['`]\/api\/fechamentos\/adicionais/);
  // O catálogo público usa exclusivamente o escopo configurado no servidor.
  assert.match(readFileSync("app/api/fechamentos/adicionais/route.ts", "utf8"), /escopoCatalogoPublico\(db\)/);
});

test("070: adicional de categoria traz as opções ativas para escolher; categoria sem item ativo não é oferecida", async () => {
  const { tx } = banco(true);
  const r = await adicionaisDoPacoteNoTenant(tx, { empresaId: A, pacoteCodigo: "COMPLETA", data: "2026-11-21", convidados: 80 });
  assert.deepEqual(r.map((a) => a.codigo), ["CATEGORIA_SALGADOS", "MESA_CAFE"]);
  assert.deepEqual(r[0].escolhas, { max: 4, itens: [{ id: "i-coxinha", nome: "Coxinha" }, { id: "i-kibe", nome: "Kibe" }] });
  assert.equal(r[1].escolhas, undefined);
});

test("rotas de fechamento devolvem todos os adicionais da empresa: id antigo quando existe, senão o código", () => {
  for (const arquivo of ["app/api/fechamentos/adicionais/route.ts", "app/api/admin/fechamentos/adicionais/route.ts"]) {
    const rota = readFileSync(arquivo, "utf8");
    assert.match(rota, /idDoAdicionalNaTela\(a\.codigo\)/, arquivo);
    assert.doesNotMatch(rota, /\.filter\(\(?a\)? => idPorCodigo/, arquivo);
  }
});
