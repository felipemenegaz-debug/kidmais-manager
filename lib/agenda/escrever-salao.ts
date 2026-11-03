import { createHash } from "node:crypto";
import type { DbExecutor } from "../db/contracts.ts";

/**
 * Plano "liberar agenda com mais de um salão" (rev. 5–7, aprovado pelo Astra; D-LIB-4): toda escrita de
 * fechamentos.salao_id ou fechamento_revisoes.salao_id passa por aqui, com a marca do escritor (B1–B7), do caminho e da
 * origem. A marca é diagnóstico dos testes PG (gatilho instalado só pelo harness do cluster descartável, que compara
 * md5(current_query()) com o hash da marca); em produção ela só custa os dois set_config.
 */
export type EscritorSalao = "B1" | "B2" | "B3" | "B4" | "B5" | "B6" | "B7";

/** Caminho do mapa fechado (entradas 1–16). Sem padrão: cada chamador declara o seu. */
export type CaminhoSalao =
  | "EMISSAO"
  | "APLICACAO_REVISAO_INICIAL"
  | "FORMALIZACAO_PRE_ASSINATURA"
  | "APLICACAO_REVISAO_OPERACIONAL"
  | "FORMALIZACAO_POS_ASSINATURA"
  | "CONFIRMACAO_PAGAMENTO"
  | "INTEGRACAO_IMPORTADO"
  | "PREPARACAO_REVISAO"
  | "ATRIBUICAO_AVULSA"
  | "EDICAO_LIMPA_SALAO";

/** Quem iniciou a entrada; separa, por exemplo, a entrada 5 (aceite público) da 16 (reconciliação). */
export type OrigemSalao = "ACEITE_PUBLICO" | "RECONCILIACAO_OPERACIONAL" | "PAGAMENTO" | "IMPORTACAO" | "EQUIPE";

export type MarcaSalao = { caminho: CaminhoSalao; origem: OrigemSalao };

/**
 * Quantas instruções o texto tem, ignorando literais ('...', E'...', "..."), dollar-quotes ($tag$...$tag$) e comentários
 * (-- e /* *\/, aninhados). Um ";" final seguido só de espaços não conta como segunda instrução.
 */
export function contarInstrucoes(sql: string) {
  let n = 0, conteudo = false, i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === "-" && sql[i + 1] === "-") { const fim = sql.indexOf("\n", i); i = fim < 0 ? sql.length : fim + 1; continue; }
    if (c === "/" && sql[i + 1] === "*") {
      let nivel = 1; i += 2;
      while (i < sql.length && nivel > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") { nivel++; i += 2; } else if (sql[i] === "*" && sql[i + 1] === "/") { nivel--; i += 2; } else i++;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      const escape = c === "'" && /[eE]/.test(sql[i - 1] ?? "") && !/\w/.test(sql[i - 2] ?? "");
      i++;
      while (i < sql.length) {
        if (escape && sql[i] === "\\") { i += 2; continue; }
        if (sql[i] === c) { if (sql[i + 1] === c) { i += 2; continue; } break; }
        i++;
      }
      i++; conteudo = true; continue;
    }
    if (c === "$") {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tag && !/\w/.test(sql[i - 1] ?? "")) {
        const fim = sql.indexOf(tag[0], i + tag[0].length);
        i = fim < 0 ? sql.length : fim + tag[0].length; conteudo = true; continue;
      }
    }
    if (c === ";") { if (conteudo) n++; conteudo = false; i++; continue; }
    if (!/\s/.test(c)) conteudo = true;
    i++;
  }
  return n + (conteudo ? 1 : 0);
}

export const md5Sql = (sql: string) => createHash("md5").update(sql, "utf8").digest("hex");

/**
 * Contrato (rev. 7, P2-1):
 * 1. recusa, sem SQL, texto com mais de uma instrução ou sem parâmetros. Com parâmetros, o driver usa o protocolo
 *    estendido, em que o servidor recusa lotes num único Parse (o DbExecutor não expõe queryMode; ver o pacote);
 * 2. marca logo antes da instrução, no mesmo comando que confere que não há marca aberta (marcas não se aninham);
 * 3. sucesso: limpa a marca; falha da limpeza propaga;
 * 4. falha da instrução: nenhuma SQL e o erro original relançado intacto. O ROLLBACK (ou ROLLBACK TO SAVEPOINT, sempre
 *    anterior à marca) do dono da transação desfaz o set_config local.
 */
export async function escreverSalao<Row extends object = Record<string, unknown>>(
  tx: DbExecutor, marca: MarcaSalao & { escritor: EscritorSalao }, sql: string, params: readonly unknown[],
) {
  if (contarInstrucoes(sql) !== 1) throw new Error("escreverSalao: o texto precisa ter exatamente uma instrução SQL.");
  if (params.length === 0) throw new Error("escreverSalao: a escrita de salão precisa de parâmetros (protocolo estendido).");
  const valor = `${marca.escritor}:${marca.caminho}:${marca.origem}:${md5Sql(sql)}`;
  const aberta = await tx.query<{ ok: string }>(
    `SELECT set_config('kidmais.escritor_salao', $1, true) AS ok WHERE coalesce(current_setting('kidmais.escritor_salao', true), '') = ''`,
    [valor],
  );
  if (aberta.rows.length !== 1) throw new Error("escreverSalao: já existe uma marca de escritor aberta (marcas não se aninham).");
  const r = await tx.query<Row>(sql, params);
  await tx.query(`SELECT set_config('kidmais.escritor_salao', '', true)`);
  return r;
}
