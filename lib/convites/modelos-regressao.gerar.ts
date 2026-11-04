// Gera os hashes congelados da regressão byte a byte. Rodado UMA vez com o modelos.ts da production 767fff4a.
import { writeFileSync } from 'node:fs';
import { hashesAtuais } from './modelos-regressao.fixture.ts';

const hashes = hashesAtuais();
writeFileSync(new URL('./modelos-regressao-767fff4a.json', import.meta.url), `${JSON.stringify(hashes, null, 1)}\n`);
console.log(`${Object.keys(hashes).length} casos gravados.`);
