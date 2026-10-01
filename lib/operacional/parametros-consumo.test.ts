import assert from "node:assert/strict";
import test from "node:test";
import type { DbExecutor } from "../db/contracts.ts";
import { fonteParametrosDisponivel, parametroVigente, registrarParametroConsumo, type NovoParametro } from "./parametros-consumo.ts";

/**
 * Serviço REAL de parâmetros de consumo (059) sobre uma tabela em memória que responde às consultas do próprio serviço
 * (sem banco). Confere SQL, empresa em cada consulta, versão esperada, substituição e idempotência por operação.
 * O comportamento do banco (gatilhos, índices, rollback) é coberto por migration-059.postgres.test.ts (opt-in).
 */
type Linha = { empresa_id: string; categoria: string; versao: number; quantidade_por_convidado: number | null; ml_por_convidado: number | null; embalagem_ml: number | null; margem_percentual: number | null; operacao_id: string; substituida_em: string | null; vigente_desde: string };

function tabela(disponivel = true) {
  const linhas: Linha[] = [];
  const consultas: string[] = [];
  const tx: DbExecutor = {
    async query<Row extends object>(sql: string, v: readonly unknown[] = []) {
      consultas.push(sql.replace(/\s+/g, " ").trim());
      const r = (rows: object[]) => ({ rows: rows as Row[], rowCount: rows.length });
      if (sql.includes("to_regclass")) return r([{ ok: disponivel }]);
      if (sql.includes("WHERE operacao_id = $1::uuid AND empresa_id = $2::uuid")) return r(linhas.filter((l) => l.operacao_id === v[0] && l.empresa_id === v[1]));
      if (sql.includes("SELECT categoria, versao")) return r(linhas.filter((l) => l.empresa_id === v[0] && l.categoria === v[1] && !l.substituida_em));
      if (sql.startsWith("UPDATE")) {
        const alvo = linhas.filter((l) => l.empresa_id === v[0] && l.categoria === v[1] && l.versao === v[2] && !l.substituida_em);
        alvo.forEach((l) => { l.substituida_em = "agora"; });
        return r(alvo);
      }
      if (sql.trim().startsWith("INSERT")) {
        linhas.push({ empresa_id: v[0] as string, categoria: v[1] as string, versao: v[2] as number, quantidade_por_convidado: v[3] as number | null, ml_por_convidado: v[4] as number | null, embalagem_ml: v[5] as number | null, margem_percentual: v[6] as number | null, operacao_id: v[8] as string, substituida_em: null, vigente_desde: "2026-10-01T00:00:00Z" });
        return r([]);
      }
      throw new Error(`SQL inesperado: ${sql}`);
    },
  };
  return { tx, linhas, consultas };
}

const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const B = "bbbbbbbb-0000-4000-8000-00000000000b";
const base = (o: Partial<NovoParametro> = {}): NovoParametro => ({ empresaId: A, usuarioId: "u", categoria: "DOCES", porConvidado: 4, mlPorConvidado: null, embalagemMl: null, margemPercentual: null, versaoEsperada: null, operacaoId: "op-1", ...o });

test("parâmetros de consumo: versão 1, substituição com versão esperada, idempotência e isolamento por empresa", async () => {
  const t = tabela();
  assert.deepEqual(await registrarParametroConsumo(t.tx, base()), { versao: 1, repetido: false });
  assert.deepEqual(await registrarParametroConsumo(t.tx, base()), { versao: 1, repetido: true }, "mesma operação não duplica");
  await assert.rejects(registrarParametroConsumo(t.tx, base({ operacaoId: "op-2", porConvidado: 5 })), /mudou desde a revisão/);
  assert.deepEqual(await registrarParametroConsumo(t.tx, base({ operacaoId: "op-2", porConvidado: 5, versaoEsperada: 1 })), { versao: 2, repetido: false });
  assert.equal(t.linhas.filter((l) => !l.substituida_em).length, 1);
  assert.equal((await parametroVigente(t.tx, A, "DOCES"))?.porConvidado, 5);
  assert.equal(await parametroVigente(t.tx, B, "DOCES"), null);
  assert.deepEqual(await registrarParametroConsumo(t.tx, base({ empresaId: B, operacaoId: "op-3" })), { versao: 1, repetido: false }, "a outra empresa tem a própria sequência");
  // Toda consulta de negócio filtra pela empresa.
  for (const sql of t.consultas.filter((s) => s.includes("operacional_parametros_consumo") && !s.includes("to_regclass"))) assert.match(sql, /empresa_id/);
});

test("parâmetros de consumo: dados inválidos e fonte ausente recusam sem escrever", async () => {
  const t = tabela();
  await assert.rejects(registrarParametroConsumo(t.tx, base({ porConvidado: null })), /inválido/);
  await assert.rejects(registrarParametroConsumo(t.tx, base({ categoria: "REFRIGERANTES", porConvidado: 4 })), /inválido/);
  assert.equal(t.linhas.length, 0);
  const sem = tabela(false);
  assert.equal(await fonteParametrosDisponivel(sem.tx), false);
  await assert.rejects(registrarParametroConsumo(sem.tx, base()), /não pode ser salva/);
});
