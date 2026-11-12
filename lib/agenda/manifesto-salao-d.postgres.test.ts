import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";

/**
 * Plano "liberar agenda com mais de um salão" (rev. 7, P3-1): manifesto D, no PostgreSQL DESCARTÁVEL (estado atual).
 *
 * - presença: as funções da aplicação (schema public) cujo corpo menciona salao_id são exatamente as 15 abaixo, mais a
 *   auxiliar kidmais098_saloes_cruzam (lista separada; recebe os ids por parâmetro). Identidade = schema + nome +
 *   pg_get_function_identity_arguments. O prefixo reservado da guarda dinâmica (kidmais_teste_) fica fora, explicitamente;
 * - classificação: nenhum corpo escreve fechamentos.salao_id / fechamento_revisoes.salao_id nem atribui NEW.salao_id
 *   (o mesmo classificador da guarda estática sobre os .sql). Uma função nova, removida ou com assinatura diferente reprova
 *   até o manifesto ser atualizado.
 */
const exigir = createRequire(import.meta.url);
const { escritasEmSql } = exigir("../../scripts/guarda-salao-estatica.cjs") as { escritasEmSql: (sql: string) => unknown[] };

const MANIFESTO: Record<string, string> = {
  kidmais019_validar_contrato: "leitora: ocupação",
  kidmais019_validar_destino: "leitora: destino",
  kidmais093_mesma_empresa: "leitora: NEW.salao_id dos vínculos de salão (configuração/pacote), não fechamentos",
  kidmais094_conflito_ocupacao: "leitora: conflito (nulo = todos)",
  kidmais094_ocupacoes: "leitora",
  kidmais094_salao_fechamento: "gatilho de validação; não atribui NEW.salao_id",
  kidmais094_salao_revisao: "idem, em fechamento_revisoes",
  kidmais098_salao_guarda: "leitora",
  kidmais098_validar_elegibilidade: "leitora",
  kidmais102_foto_antes: "outra tabela (fotos)",
  kidmais102_foto_depois: "outra tabela",
  kidmais102_item_antes: "outra tabela",
  kidmais102_item_depois: "outra tabela",
  kidmais_hash_revisao_operacional: "leitora: salão no hash hash_versao=2",
  kidmais_validar_agenda_revisao: "leitora",
};
const AUXILIAR = { kidmais098_saloes_cruzam: "regra do curinga; ids por parâmetro" };

/** Assinaturas completas (identity arguments), lidas no modelo 114 do cluster descartável (F5, 01/11/2026). */
const ASSINATURAS: Record<string, string> = {
  kidmais019_validar_contrato: "",
  kidmais019_validar_destino: "cid uuid",
  kidmais093_mesma_empresa: "",
  kidmais094_conflito_ocupacao: "fid uuid, dia date, ini time without time zone, fim time without time zone, emp uuid, uni uuid, cfg uuid, salao uuid",
  kidmais094_ocupacoes: "inicio date, fim date",
  kidmais094_salao_fechamento: "",
  kidmais094_salao_revisao: "",
  kidmais098_salao_guarda: "",
  kidmais098_validar_elegibilidade: "fid uuid",
  kidmais102_foto_antes: "",
  kidmais102_foto_depois: "",
  kidmais102_item_antes: "",
  kidmais102_item_depois: "",
  kidmais_hash_revisao_operacional: "rid uuid",
  kidmais_validar_agenda_revisao: "",
  kidmais098_saloes_cruzam: "a uuid, b uuid",
};

let db: Client;
test.before(async () => { db = await conectarDescartavel(); });
test.after(async () => { await encerrarDescartavel(db); });

async function funcoes(filtro: string) {
  const r = await db.query<{ nome: string; args: string; corpo: string }>(
    `SELECT p.proname AS nome, pg_get_function_identity_arguments(p.oid) AS args, p.prosrc AS corpo
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname NOT LIKE 'kidmais\\_teste\\_%' AND ${filtro}
      ORDER BY 1, 2`);
  return r.rows;
}

test("manifesto D: as 15 funções que mencionam salao_id, por identidade, e nenhuma escreve o salão", async () => {
  const achadas = await funcoes("p.prosrc ILIKE '%salao_id%'");
  const identidade = (nome: string, args: string) => `public.${nome}(${args})`;
  assert.deepEqual(achadas.map((f) => identidade(f.nome, f.args)),
    Object.keys(MANIFESTO).sort().map((nome) => identidade(nome, ASSINATURAS[nome]!)));
  for (const f of achadas) assert.deepEqual(escritasEmSql(f.corpo), [], `${f.nome} escreve salão`);
});

test("manifesto D: a auxiliar existe com a assinatura declarada e fica fora do filtro", async () => {
  const [aux] = await funcoes(`p.proname = 'kidmais098_saloes_cruzam'`);
  assert.ok(aux, "kidmais098_saloes_cruzam ausente");
  assert.equal(aux.args, ASSINATURAS.kidmais098_saloes_cruzam);
  assert.equal(/salao_id/i.test(aux.corpo), false);
  assert.deepEqual(Object.keys(AUXILIAR), ["kidmais098_saloes_cruzam"]);
});

test("manifesto D: o prefixo reservado da guarda dinâmica é excluído explicitamente", async () => {
  const r = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname LIKE 'kidmais\\_teste\\_%' AND p.prosrc ILIKE '%salao_id%'`);
  // Com o harness instalado (cluster da regressão), a função da guarda menciona salao_id e só não entra pelo prefixo.
  assert.ok(r.rows[0]!.n <= 1);
});
