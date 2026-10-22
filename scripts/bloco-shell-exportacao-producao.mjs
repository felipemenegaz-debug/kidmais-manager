/**
 * Gera o bloco de Shell SOMENTE LEITURA da exportação para o Web Shell de PRODUÇÃO (P2-5 / P2-3 da revisão de 21/10):
 *   - conta linhas com empresa_id NULO nas tabelas do pacote filtradas diretamente por empresa_id que aceitam nulo
 *     (linhas legadas sem empresa não entram no pacote de ninguém);
 *   - lista as tabelas públicas que o inventário da exportação não classifica (a geração recusaria com 503).
 * Só contagens e nomes de tabela: nenhum dado de negócio, nenhuma credencial (DATABASE_URL nunca é impressa).
 * Transação READ ONLY com prazo; o bloco recusa rodar fora do serviço de produção (guarda de RENDER_SERVICE_ID).
 *
 * Uso (local): node --experimental-strip-types scripts/bloco-shell-exportacao-producao.mjs <arquivo-de-saída>
 * Gerar NÃO executa nada; executar o bloco em produção exige autorização explícita de Felipe (docs/OPERACAO_AGENTES.md).
 */
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

export const SERVICO_PRODUCAO = "srv-dak77m2d0e5s73b8rkkg";

export async function gerarBloco(raiz = process.cwd()) {
  const { ENTIDADES, FORA_DO_ESCOPO } = await import(pathToFileURL(path.join(raiz, "lib/exportacao/entidades.ts")).href);
  const diretas = ENTIDADES.filter((e) => e.onde === "t.empresa_id = $1::uuid").map((e) => e.tabela).sort();
  const classificadas = [...new Set([...ENTIDADES.map((e) => e.tabela), ...Object.keys(FORA_DO_ESCOPO)])].sort();
  const js = `const { Client } = require("pg");
const DIRETAS = ${JSON.stringify(diretas)};
const CLASSIFICADAS = new Set(${JSON.stringify(classificadas)});
(async () => {
  const ssl = process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false" } : undefined;
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl, application_name: "kidmais-exportacao-conferir" });
  await c.connect();
  let codigo = 0;
  try {
    await c.query("BEGIN READ ONLY");
    await c.query("SET LOCAL statement_timeout = '20s'");
    await c.query("SET LOCAL lock_timeout = '2s'");
    if ((await c.query("SHOW transaction_read_only")).rows[0].transaction_read_only !== "on") throw new Error("TRANSACAO_NAO_E_SOMENTE_LEITURA");
    console.log("BANCO", (await c.query("SELECT current_database() AS d")).rows[0].d);
    const nulaveis = (await c.query("SELECT table_name AS t FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'empresa_id' AND is_nullable = 'YES' AND table_name = ANY($1::text[]) ORDER BY 1", [DIRETAS])).rows.map((r) => r.t);
    let totalNulas = 0;
    for (const t of nulaveis) {
      const r = (await c.query('SELECT count(*) FILTER (WHERE empresa_id IS NULL)::int AS nulas, count(*)::int AS total FROM public."' + t + '"')).rows[0];
      totalNulas += r.nulas;
      console.log("EMPRESA_NULA", t, "nulas=" + r.nulas, "total=" + r.total);
    }
    console.log("EMPRESA_NULA_TABELAS", nulaveis.length, "EMPRESA_NULA_TOTAL", totalNulas);
    const publicas = (await c.query("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1")).rows.map((r) => r.t);
    const sem = publicas.filter((t) => !CLASSIFICADAS.has(t));
    console.log("TABELAS_PUBLICAS", publicas.length, "NAO_CLASSIFICADAS", sem.length ? sem.join(",") : "NENHUMA");
    await c.query("ROLLBACK");
  } catch (erro) {
    codigo = 1;
    console.log("FALHA", erro && erro.code ? erro.code : "", erro && erro.message ? String(erro.message).replace(/postgres(ql)?:\\/\\/\\S+/g, "[url]") : "");
    await c.query("ROLLBACK").catch(() => {});
  } finally {
    await c.end();
  }
  process.exit(codigo);
})().catch((erro) => { console.log("FALHA_CONEXAO", erro && erro.code ? erro.code : ""); process.exit(1); });`;
  return `#!/usr/bin/env bash
# BLOCO-SHELL-EXPORTACAO-PRODUCAO-CONTAR - Web Shell do ${SERVICO_PRODUCAO} (kidmais-manager-production). Colar inteiro, uma vez, e Enter.
# SOMENTE LEITURA (transação READ ONLY, prazo de 20 s por comando): conta empresa_id NULO nas tabelas do pacote filtradas
# diretamente por empresa e lista tabelas públicas sem classificação no inventário da exportação. Só contagens e nomes de
# tabela; nada é gravado; a DATABASE_URL nunca é impressa. Gerado por scripts/bloco-shell-exportacao-producao.mjs.
# No fim sai CODIGO_SAIDA_BLOCO=<n> (0 ok, 1 consulta, 4 bloco); outro código ou ausência da linha = parar e ler.
# Prompt \`>\` depois de colar = colagem incompleta: Ctrl-C e colar o MESMO bloco.
bind 'set enable-bracketed-paste off' 2>/dev/null
if [ "$RENDER_SERVICE_ID" != "${SERVICO_PRODUCAO}" ]; then echo "SHELL_ERRADO_NAO_E_PRODUCAO ($RENDER_SERVICE_ID): nada executado"; else
(
set -euo pipefail
umask 077
cd '/opt/render/project/src' || { echo "DESTINO_INACESSIVEL"; exit 4; }
command -v node >/dev/null || { echo "FERRAMENTA_AUSENTE node"; exit 4; }
[ -n "\${DATABASE_URL:-}" ] || { echo "DATABASE_URL_AUSENTE"; exit 4; }
[ -d node_modules/pg ] || { echo "PG_AUSENTE"; exit 4; }
NODE_PATH="$PWD/node_modules" node - <<'KIDMAIS_EXPORTACAO_JS'
${js}
KIDMAIS_EXPORTACAO_JS
)
echo "CODIGO_SAIDA_BLOCO=$?"
fi
`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const destino = process.argv[2];
  if (!destino) { console.error("uso: node --experimental-strip-types scripts/bloco-shell-exportacao-producao.mjs <arquivo-de-saída>"); process.exit(2); }
  const bloco = await gerarBloco();
  writeFileSync(destino, bloco, { encoding: "utf8" });
  const { createHash } = await import("node:crypto");
  console.log(`bloco gravado em ${destino} (${Buffer.byteLength(bloco)} bytes, sha256 ${createHash("sha256").update(bloco).digest("hex")})`);
}
