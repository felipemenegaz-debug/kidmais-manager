import test from "node:test";
import assert from "node:assert/strict";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import { conferirMapa, TIPOS_CONFERIDOS } from "./mapa-dados.ts";

/**
 * Guarda fase 3 (20/11/2026), PostgreSQL DESCARTÁVEL no modelo 130 (inventário inteiro de migrations, menos a 098 como
 * os demais modelos). Teste de guarda do mapa dos dados pessoais: toda coluna de texto, binária, JSON ou de endereço IP
 * do schema public precisa estar classificada em lib/guarda/mapa-dados.ts, e o mapa não pode citar coluna que não existe.
 * Coluna nova sem classificação faz a suíte FALHAR, para que a anonimização (fase 4) não deixe dado pessoal para trás.
 */
const opt = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL === "kidmais_pacotes_v1_descartavel";

test("mapa dos dados pessoais cobre exatamente as colunas de texto/bytea/JSON/inet do schema", { skip: !opt() }, async () => {
  const c = await conectarDescartavel();
  try {
    const r = await c.query<{ tabela: string; coluna: string }>(
      `SELECT c.table_name AS tabela, c.column_name AS coluna
         FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name)
        WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
          AND (c.data_type = ANY($1::text[]) OR (c.data_type = 'ARRAY' AND c.udt_name = ANY($2::text[])))
        ORDER BY 1, 2`, [TIPOS_CONFERIDOS.escalares, TIPOS_CONFERIDOS.vetores]);
    assert.ok(r.rows.length > 100, `inventário lido: ${r.rows.length} colunas`);
    const { faltam, sobram } = conferirMapa(r.rows);
    assert.deepEqual({ faltam, sobram }, { faltam: [], sobram: [] },
      `colunas fora do mapa (classifique em lib/guarda/mapa-dados.ts): ${JSON.stringify(faltam)}; citadas sem existir: ${JSON.stringify(sobram)}`);
  } finally { await encerrarDescartavel(c); }
});
