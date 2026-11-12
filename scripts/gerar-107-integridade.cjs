/* eslint-disable @typescript-eslint/no-require-imports */
// Gera database/checks/20261029_107_integridade.sql a partir de sqlIntegridade107() (scripts/migration-107-definicoes.cjs):
// um DO somente leitura que junta as verificações que falharam e RECUSA com "107 integridade: …". Determinístico, LF.
// Uso: node scripts/gerar-107-integridade.cjs            → escreve o arquivo
//      node scripts/gerar-107-integridade.cjs --conferir → não escreve; sai 1 se o arquivo versionado difere do gerado
//      --arquivo <caminho> troca o destino (testes)
const fs = require('node:fs'), path = require('node:path');
const {sqlIntegridade107, PG_MAIOR} = require('./migration-107-definicoes.cjs');

const ARQUIVO = 'database/checks/20261029_107_integridade.sql';

function texto() {
  const corpo = sqlIntegridade107().split('\n').map((l) => (l ? '    ' + l : l)).join('\n');
  if (corpo.includes('$$')) throw new Error('sqlIntegridade107 contém $$');
  return `-- Integridade da 107 (somente leitura, SÓ CATÁLOGO + registro kidmais107_reparos; plano E4 rev. 2.1, E4-2).
-- GERADO por scripts/gerar-107-integridade.cjs de sqlIntegridade107() (scripts/migration-107-definicoes.cjs); não editar à
-- mão: alterar o módulo e regerar (o teste e o --conferir recusam divergência).
-- Confere os 14 objetos da 107 pela DEFINIÇÃO (deparse esperado no PostgreSQL ${PG_MAIOR}), tabela certa, CHECK validado e não
-- NO INHERIT, índice válido/pronto, gatilho ligado com estrutura exata; nenhum nome de deriva; estrutura do registro; e a
-- coerência de cada ação registrada. Registro vazio = base canônica (legítimo). Rodar com search_path = pg_catalog.
DO $$
DECLARE
  kidmais107_l record;
  kidmais107_falhas text[] := ARRAY[]::text[];
BEGIN
  FOR kidmais107_l IN
${corpo}
  LOOP
    IF kidmais107_l.ok IS NOT TRUE THEN
      kidmais107_falhas := kidmais107_falhas || kidmais107_l.motivo;
    END IF;
  END LOOP;
  IF cardinality(kidmais107_falhas) > 0 THEN
    RAISE EXCEPTION '107 integridade: %', array_to_string(kidmais107_falhas, '; ');
  END IF;
END $$;
`;
}

function main(argv) {
  const k = argv.indexOf('--arquivo');
  const destino = k >= 0 && argv[k + 1] ? path.resolve(argv[k + 1]) : path.resolve(__dirname, '..', ARQUIVO);
  const gerado = texto();
  if (argv.includes('--conferir')) {
    let atual = null;
    try { atual = fs.readFileSync(destino, 'utf8'); } catch { /* ausente */ }
    if (atual !== gerado) {
      process.stderr.write(`${ARQUIVO}: ${atual === null ? 'ausente' : 'difere do gerado (regerar e revisar)'}\n`);
      return 1;
    }
    process.stdout.write(`${ARQUIVO}: igual ao gerado\n`);
    return 0;
  }
  fs.writeFileSync(destino, gerado, 'utf8');
  process.stdout.write(`${ARQUIVO}: escrito\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {ARQUIVO, texto, main};
