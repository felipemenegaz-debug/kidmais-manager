import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { conectarDescartavel } from "../../comercial/postgres-descartavel.ts";

/**
 * Postcheck da 082 (B2 da revisão de aa04387, 12/10/2026): passa no schema criado pela 082 final e RECUSA variantes que
 * uma 082 anterior (ou adulterada) teria — coluna da posse ausente, default trocado, tipo trocado, índice de execução
 * única não único, motivo de cancelamento sem GRUPO_INCOMPLETO, estado sem INTERROMPIDA. Cada variante roda numa
 * transação desfeita (nada fica no banco). Controle negativo do próprio verificador operacional.
 * A 082 foi revisada antes de qualquer aplicação: um banco com uma versão antiga dela exige plano explícito de evolução
 * (reaplicar a migration não é presumido permitido); este postcheck só garante que essa diferença não passe despercebida.
 */
const POSTCHECK = readFileSync("database/checks/20261011_082_postcheck.sql", "utf8");
const VARIANTES: [string, string][] = [
  ["sem a coluna do token da posse", "ALTER TABLE whatsapp_atendimento_retencao_execucoes DROP COLUMN posse_token"],
  ["sem a validade da posse", "ALTER TABLE whatsapp_atendimento_retencao_execucoes DROP COLUMN posse_ate"],
  ["por_empresa sem default", "ALTER TABLE whatsapp_atendimento_retencao_execucoes ALTER COLUMN por_empresa DROP DEFAULT"],
  ["config_alterada com outro tipo", "ALTER TABLE whatsapp_atendimento_retencao_execucoes ALTER COLUMN config_alterada TYPE bigint"],
  ["índice de execução única não único", "DROP INDEX whatsapp_retencao_uma_por_vez; CREATE INDEX whatsapp_retencao_uma_por_vez ON whatsapp_atendimento_retencao_execucoes (ambiente) WHERE estado = 'EM_ANDAMENTO'"],
  ["motivo sem GRUPO_INCOMPLETO", "ALTER TABLE whatsapp_atendimento_mensagens DROP CONSTRAINT whatsapp_mensagens_motivo_cancelamento, ADD CONSTRAINT whatsapp_mensagens_motivo_cancelamento CHECK (motivo_cancelamento IN ('ARQUIVO_INDISPONIVEL', 'ARQUIVO_REVOGADO'))"],
  ["estado sem INTERROMPIDA", `DO $$ DECLARE n text; BEGIN SELECT conname INTO n FROM pg_constraint WHERE conrelid = 'public.whatsapp_atendimento_retencao_execucoes'::regclass AND contype = 'c' AND position('INTERROMPIDA' IN pg_get_constraintdef(oid)) > 0;
    EXECUTE format('ALTER TABLE whatsapp_atendimento_retencao_execucoes DROP CONSTRAINT %I', n);
    ALTER TABLE whatsapp_atendimento_retencao_execucoes ADD CHECK (estado IN ('EM_ANDAMENTO', 'CONCLUIDA', 'CONCLUIDA_COM_FALHAS', 'FALHOU')); END $$`],
];

test("postcheck 082: aceita a 082 final e recusa variantes antigas ou adulteradas da retenção", { timeout: 120_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  try {
    await assert.doesNotReject(c.query(POSTCHECK), "082 final: postcheck aprovado");
    for (const [nome, sql] of VARIANTES) {
      await c.query("BEGIN");
      try {
        await c.query(sql);
        await assert.rejects(c.query(POSTCHECK), /postcheck 082/, `variante "${nome}": postcheck precisa recusar`);
      } finally {
        await c.query("ROLLBACK");
      }
    }
    await assert.doesNotReject(c.query(POSTCHECK), "nada ficou alterado depois das variantes");
  } finally {
    await c.end();
  }
});
