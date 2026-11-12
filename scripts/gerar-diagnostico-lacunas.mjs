// Gera database/checks/diagnostico_lacunas_aceites.sql (consulta somente leitura das lacunas de texto dos aceites) a
// partir do catálogo das versões publicadas e das vigentes. Só escreve o arquivo; não conecta a nada.
//   node --experimental-strip-types scripts/gerar-diagnostico-lacunas.mjs
import { writeFileSync } from 'node:fs';
import { sqlDiagnosticoLacunas } from '../lib/cadastro/diagnostico-lacunas.ts';

writeFileSync('database/checks/diagnostico_lacunas_aceites.sql', sqlDiagnosticoLacunas());
console.error('database/checks/diagnostico_lacunas_aceites.sql gerado');
