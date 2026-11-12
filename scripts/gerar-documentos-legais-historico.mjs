// Gera lib/cadastro/documentos-legais-historico.ts: catálogo das versões PUBLICADAS (commits ancestrais da base staging)
// dos documentos legais, com o texto canônico e o hash de cada versão calculados pelo módulo da própria época
// (revisão 00cecac, P2-B2). Só lê o Git e escreve o arquivo; não conecta a nada.
//   node --experimental-strip-types scripts/gerar-documentos-legais-historico.mjs [base]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ARQ = 'lib/cadastro/documentos-legais.ts';
const BASE = process.argv[2] ?? '326895e';
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const commits = git('log', '--format=%H', BASE, '--', ARQ).trim().split('\n').filter(Boolean);
const dir = mkdtempSync(join(tmpdir(), 'hist-docs-'));
const vistos = new Map();
let n = 0;
try {
  for (const c of commits) {
    const f = join(dir, `d${n++}.ts`);
    writeFileSync(f, git('show', `${c}:${ARQ}`));
    const m = await import(pathToFileURL(f).href);
    for (const d of Object.values(m.DOCUMENTOS ?? {})) {
      const conteudo = m.textoCanonico(d), hash = m.hashDocumento(d), chave = `${d.documento}|${d.versao}`;
      const antes = vistos.get(chave);
      if (antes && antes.hash !== hash) throw new Error(`versão publicada com dois textos: ${chave} (${antes.commit} e ${c.slice(0, 8)})`);
      if (!antes) vistos.set(chave, { documento: d.documento, versao: d.versao, hash, commit: c.slice(0, 8), conteudo });
    }
  }
} finally { rmSync(dir, { recursive: true, force: true }); }
const lista = [...vistos.values()].sort((a, b) => (a.documento + a.versao).localeCompare(b.documento + b.versao));
const cab = `/**
 * Catálogo das versões PUBLICADAS dos documentos legais anteriores às vigentes (grupo B, revisão 00cecac, P2-B2): texto
 * canônico e SHA-256 de cada versão, reconstruídos do histórico do Git da base staging ${BASE} com o módulo de cada
 * commit (gerado; não editar à mão). Permite recuperar o texto exato de aceites antigos, conferido pelo hash. Versões
 * locais nunca publicadas ficam fora. Versão sem texto aqui nem no banco é lacuna explícita (404), nunca trocada.
 */
export type VersaoPublicada = { documento: 'TERMOS_USO' | 'PRIVACIDADE' | 'DPA'; versao: string; hash: string; commit: string; conteudo: string };
`;
writeFileSync('lib/cadastro/documentos-legais-historico.ts', cab + 'export const VERSOES_PUBLICADAS: readonly VersaoPublicada[] = ' + JSON.stringify(lista, null, 1) + ';\n');
console.error(`commits ${commits.length}; versões ${lista.length}`);
