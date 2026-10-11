import assert from "node:assert/strict";
import test from "node:test";
import type { DbExecutor } from "../db/contracts.ts";
import type { TenantComprovado } from "../saas/provar-tenant.ts";
import type { RespostaLeitura } from "./contratos.ts";
import { ferramentaRegistrada, SEM_PORTAS, type ContextoFerramenta } from "./ferramentas.ts";
import { manifestoLeitura, saidaValida } from "./registro-ferramentas.ts";

/** Etapa 3: a IA não indica telas do financeiro completo a quem não tem o recurso no plano; demais planos inalterados. */
const EMPRESA_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HOJE = "2026-10-10";
const tx: DbExecutor = { async query<Row extends object>() { return { rows: [] as Row[], rowCount: 0 }; } };
const tenant = { empresaComprovada: EMPRESA_A } as TenantComprovado;

function contexto(financeiroCompleto: boolean | null) {
    const chamadas: string[] = [];
    const recursos = financeiroCompleto === null ? undefined : { async financeiroCompleto(_tx: DbExecutor, empresaId: string) { chamadas.push(empresaId); return financeiroCompleto; } };
    return { chamadas, ctx: { hoje: HOJE, geradoEm: `${HOJE}T15:00:00Z`, portas: { ...SEM_PORTAS, recursos } } as ContextoFerramenta };
}

async function ler(capacidade: string, parametros: unknown, ctx: ContextoFerramenta) {
    const f = ferramentaRegistrada(capacidade)!;
    const executar = f.preparar(parametros) as (tx: DbExecutor, t: TenantComprovado, c: ContextoFerramenta) => Promise<RespostaLeitura>;
    const r = await executar(tx, tenant, ctx);
    assert.equal(saidaValida(manifestoLeitura(f)!.saida, r), true, `${capacidade}: saída fora do schema`);
    return r;
}

test("onde encontrar contas a pagar: Essencial recebe explicação sem link; outros planos mantêm o link", async () => {
    const essencial = contexto(false);
    const r = await ler("onde_encontrar", { tema: "contas_pagar" }, essencial.ctx);
    assert.doesNotMatch(JSON.stringify(r), /contas-pagar/);
    assert.match(r.resumo, /não faz parte do plano/);
    assert.deepEqual(essencial.chamadas, [EMPRESA_A], "consulta o plano da empresa comprovada");
    for (const ctx of [contexto(true).ctx, contexto(null).ctx]) {
        const ok = await ler("onde_encontrar", { tema: "contas_pagar" }, ctx);
        assert.match(JSON.stringify(ok), /\/admin\/financeiro\/contas-pagar/);
    }
    const receber = await ler("onde_encontrar", { tema: "financeiro" }, contexto(false).ctx);
    assert.match(JSON.stringify(receber), /\/admin\/financeiro\/contas-receber/, "contas a receber continua no Essencial");
});

test("analisar_pagamentos: Essencial aponta para contas a receber; plano completo mantém fluxo de caixa", async () => {
    const recebido: DbExecutor = { async query<Row extends object>() { return { rows: [{ total: "100.00", centavos: 10000 }] as unknown as Row[], rowCount: 1 }; } };
    const executar = (ctx: ContextoFerramenta) =>
        (ferramentaRegistrada("analisar_pagamentos")!.preparar({}) as (tx: DbExecutor, t: TenantComprovado, c: ContextoFerramenta) => Promise<RespostaLeitura>)(recebido, tenant, ctx);
    const essencial = JSON.stringify(await executar(contexto(false).ctx));
    const completo = JSON.stringify(await executar(contexto(true).ctx));
    assert.doesNotMatch(essencial, /fluxo-caixa/);
    if (/\/admin\/financeiro\//.test(essencial)) assert.match(essencial, /contas-receber/);
    if (/\/admin\/financeiro\//.test(completo)) assert.match(completo, /fluxo-caixa/);
});
