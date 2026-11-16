// Acrescenta ao manifesto dos textos legais as versões correntes ainda ausentes e grava o texto canônico de cada uma.
// Nunca reescreve entrada existente: versão já fixada com outro conteúdo é erro (crie uma versão nova).
// Uso: node --experimental-strip-types scripts/textos-legais-manifesto.mjs
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DOCUMENTOS, hashDocumento, textoCanonico } from '../lib/cadastro/documentos-legais.ts';
import { arquivoCanonico, conferirManifesto, sha256 } from '../lib/cadastro/manifesto-legal.ts';

const pasta = path.resolve(import.meta.dirname, '../lib/cadastro/textos-legais');
const caminho = path.join(pasta, 'manifesto.json');
const manifesto = JSON.parse(readFileSync(caminho, 'utf8'));
const ler = (arquivo) => existsSync(path.join(pasta, arquivo)) ? readFileSync(path.join(pasta, arquivo), 'utf8') : null;

for (const d of Object.values(DOCUMENTOS)) {
    const existente = manifesto.versoes.find((x) => x.documento === d.documento && x.versao === d.versao);
    if (existente) continue;
    const entrada = { documento: d.documento, versao: d.versao, sha256: hashDocumento(d), arquivo: arquivoCanonico(d.documento, d.versao) };
    if (d.documento === 'TERMOS_USO') entrada.dpa = { versao: DOCUMENTOS.DPA.versao, sha256: hashDocumento(DOCUMENTOS.DPA) };
    writeFileSync(path.join(pasta, entrada.arquivo), textoCanonico(d));
    if (sha256(textoCanonico(d)) !== entrada.sha256) throw new Error(`${d.documento}: hash do texto canônico divergente`);
    manifesto.versoes.push(entrada);
    console.log(`+ ${d.documento}@${d.versao} ${entrada.sha256}`);
}
const erros = conferirManifesto(DOCUMENTOS, manifesto.versoes, ler);
if (erros.length) { console.error(erros.join('\n')); process.exit(1); }
writeFileSync(caminho, JSON.stringify(manifesto, null, 2) + '\n');
console.log('manifesto conferido');
