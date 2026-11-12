// Offline: sha256 (LF) do corpo de cada função criada ou substituída pela 098, na forma conferida pelo PostgreSQL
// (prosrc). Uso: node scripts/migration-098-hashes.mjs. Nunca conecta em banco.
import fs from 'node:fs';
import { createHash } from 'node:crypto';

export function hashesDaMigration(arquivo = 'database/migrations/20261023_098_saloes_combinados.sql') {
  const sql = fs.readFileSync(arquivo, 'utf8').replaceAll('\r', '');
  return [...sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\(([^)]*)\)[\s\S]*?AS \$\$([\s\S]*?)\$\$;/g)]
    .map((m) => ({ nome: m[1], hash: createHash('sha256').update(m[3]).digest('hex') }));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/').split('/').pop())) {
  for (const { nome, hash } of hashesDaMigration()) console.log(`${nome} ${hash}`);
}
