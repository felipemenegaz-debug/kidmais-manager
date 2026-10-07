// Hooks de resolução para rodar o código real fora do Next (avaliação local do Wall-e).
// '@/x' -> <raiz do checkout do arquivo que importa>/x (a pasta com package.json mais próxima): assim a avaliação roda
// tanto o código desta worktree quanto o de outra (versão "antes"), cada um com os próprios módulos.
// Especificador relativo ou '@/' sem extensão -> tenta .ts, .tsx e /index.ts.
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const padrao = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const candidatos = (base) => [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')];
const arquivo = (p) => existsSync(p) && statSync(p).isFile();
const raizes = new Map();
function raizDe(parentURL) {
  if (!parentURL?.startsWith('file:')) return padrao;
  const inicio = path.dirname(fileURLToPath(parentURL));
  if (raizes.has(inicio)) return raizes.get(inicio);
  let dir = inicio;
  while (!existsSync(path.join(dir, 'package.json')) || dir.includes(`${path.sep}node_modules${path.sep}`)) {
    const acima = path.dirname(dir);
    if (acima === dir) { dir = padrao; break; }
    dir = acima;
  }
  raizes.set(inicio, dir);
  return dir;
}

export async function resolve(especificador, contexto, proximo) {
  let base = null;
  if (especificador.startsWith('@/')) base = path.join(raizDe(contexto.parentURL), especificador.slice(2));
  else if ((especificador.startsWith('./') || especificador.startsWith('../')) && contexto.parentURL?.startsWith('file:')) {
    base = path.resolve(path.dirname(fileURLToPath(contexto.parentURL)), especificador);
  }
  if (base) {
    const achado = candidatos(base).find(arquivo);
    if (achado) return { url: pathToFileURL(achado).href, shortCircuit: true };
  }
  return proximo(especificador, contexto);
}
