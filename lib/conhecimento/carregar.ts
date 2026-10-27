import { readFileSync } from "node:fs";
import path from "node:path";
import { CorpusInvalido, montarCorpus, type Corpus } from "./corpus.ts";

/**
 * Carregamento estritamente controlado do corpus aprovado: só `conhecimento/manifesto.json` e os arquivos que ele
 * lista, por nome validado (sem barra, sem `..`), lidos dentro dessa pasta. Nunca vault, docs internos ou URL.
 *
 * SEM CACHE (revisão P2-4): cada chamada relê o manifesto e confere o hash de cada arquivo. Mudança de ACL, situação,
 * vigência, versão ou remoção vale na chamada seguinte; uma falha não fica "presa" até o reinício. O corpus é pequeno
 * (poucos KiB); se crescer, um cache precisará de chave com o hash do manifesto e teste de invalidação.
 * Corpus inválido ⇒ null (busca indisponível), registrado só como código.
 *
 * Pasta FORA de `data/` (27/10/2026): no Render, staging e produção montam um disco persistente em
 * `/opt/render/project/src/data`, que esconde o que o repositório traz em `data/`. O corpus é versionado com o código,
 * não é dado de operação; por isso fica em `conhecimento/` na raiz (teste em conhecimento.test.ts).
 */
export const PASTA_CORPUS = "conhecimento";
const PASTA = () => path.join(process.cwd(), PASTA_CORPUS);

export function carregarCorpusAprovado(pasta = PASTA()): Corpus | null {
  try {
    const manifesto = JSON.parse(readFileSync(path.join(pasta, "manifesto.json"), "utf8")) as unknown;
    return montarCorpus(manifesto, (arquivo) => {
      if (!/^[a-z0-9][a-z0-9-]{0,80}\.md$/.test(arquivo)) return null;
      try {
        return readFileSync(path.join(pasta, arquivo), "utf8");
      } catch {
        return null;
      }
    });
  } catch (error) {
    console.error(`[Kidmais MCP] corpus de conhecimento indisponível: ${error instanceof CorpusInvalido ? "INVALIDO" : "LEITURA"}`);
    return null;
  }
}
