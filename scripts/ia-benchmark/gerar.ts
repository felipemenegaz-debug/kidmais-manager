import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REFERENCIA } from "./ambiente.ts";
import { executarBenchmark } from "./avaliar.ts";
import { CASOS } from "./casos.ts";
import { baselineJson, relatorioMarkdown } from "./relatorio.ts";

/**
 * `npm run benchmark:ia`: roda o benchmark (modo REGRAS) e grava o baseline em docs/ia-benchmark/.
 * Só escreve esses dois arquivos; não acessa banco, rede nem env. Rodar de novo quando um PR da V1.1 mudar o
 * comportamento — a catraca do teste impede que um caso aprovado volte a falhar.
 */
const destino = join(dirname(fileURLToPath(import.meta.url)), "../../docs/ia-benchmark");
const relatorio = await executarBenchmark(CASOS, REFERENCIA);
mkdirSync(destino, { recursive: true });
writeFileSync(join(destino, "BASELINE.md"), relatorioMarkdown(relatorio));
writeFileSync(join(destino, "baseline.json"), `${JSON.stringify(baselineJson(relatorio), null, 2)}\n`);
const s = relatorio.seguranca;
console.log(`benchmark ${relatorio.versao}: ${relatorio.aprovados.corretos}/${relatorio.total} aprovados; segurança ${JSON.stringify(s)}`);
