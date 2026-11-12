/** Gera database/checks/20261029_109_postcheck.sql do contrato (lib/assinatura/renovacao-schema.ts). `--conferir`: só compara. */
import fs from 'node:fs';
import path from 'node:path';
const { postcheck109 } = await import('../lib/assinatura/renovacao-schema.ts');
const arquivo = path.resolve(import.meta.dirname, '../database/checks/20261029_109_postcheck.sql');
const gerado = postcheck109();
if (process.argv.includes('--conferir')) {
    if (!fs.existsSync(arquivo) || fs.readFileSync(arquivo, 'utf8') !== gerado) { console.error('109 postcheck diverge do contrato'); process.exit(1); }
    console.log('109 postcheck igual ao contrato');
} else { fs.writeFileSync(arquivo, gerado); console.log(`gerado ${path.relative(process.cwd(), arquivo)}`); }
