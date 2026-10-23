// Offline: embute o bloco do retrato estrutural canônico (database/checks/20261023_098_retrato.sql, entre os
// marcadores @@RETRATO-INICIO/@@RETRATO-FIM) no precheck (estado 094), no postcheck e no verificador (estado 098) da
// 098. O rollback recebe os mesmos blocos pelo seu gerador (098 antes, 094 depois). Nunca conecta em banco.
// Retratos esperados calculados em PostgreSQL 18 descartável, nos modelos 094 e 098 construídos do inventário
// (scripts/regressao-v1-postgres-receita.cjs), com search_path = pg_catalog. "Estado 094" = inventário inteiro ANTES da 098
// (staging dde49b8: até a 097, modelo 097 da receita); recalculado em 23/10/2026 na composição com o staging, depois de
// investigar a diferença (só FKs das tabelas novas da 090/091/095–097 para empresas e usuarios_administrativos); a suíte lib/agenda/saloes-combinados-098.postgres.test.ts confere de novo.
// Uso: node scripts/migration-098-retrato.mjs
import fs from 'node:fs';

export const RETRATO_094 = 'd87890a6d261bccee5c83eaaa29fdd69e8912a8304abf59deaeeb6c243e7a146';
export const RETRATO_098 = '2dfe0b4fb72311b3d5b23df32fe0b8af8dd15dceb469285c0200dcbb9630e64d';

const ler = (p) => fs.readFileSync(p, 'utf8').replaceAll('\r', '');

/** Expressão do retrato, com os marcadores, exatamente como em database/checks/20261023_098_retrato.sql. */
export function expressaoDoRetrato() {
  const sql = ler('database/checks/20261023_098_retrato.sql');
  const inicio = sql.indexOf('-- @@RETRATO-INICIO');
  const fim = sql.indexOf('-- @@RETRATO-FIM') + '-- @@RETRATO-FIM'.length;
  if (inicio < 0 || fim < inicio) throw new Error('retrato sem marcadores');
  return sql.slice(inicio, fim);
}

export function blocoDoRetrato(estado, hash) {
  return `-- @@BLOCO-RETRATO-INICIO ${estado}
-- Retrato estrutural canônico (rodada 4 do Astra, P2-1): colunas e defaults, constraints, índices, gatilhos, regras,
-- políticas e atributos das funções do escopo idênticos ao estado ${estado} esperado. Divergência: rodar
-- database/checks/20261023_098_retrato.sql e comparar com o modelo ${estado} do inventário.
-- Calculado sempre com search_path = pg_catalog (o texto das definições depende do search_path da sessão); o valor
-- anterior é restaurado em seguida.
DO $$
DECLARE caminho text := current_setting('search_path');
BEGIN
  PERFORM set_config('search_path', 'pg_catalog', true);
  IF encode(sha256(convert_to((
${expressaoDoRetrato()}
  ), 'UTF8')), 'hex') IS DISTINCT FROM '${hash}' THEN
    RAISE EXCEPTION '098 retrato: estrutura diferente do estado ${estado} esperado; compare com database/checks/20261023_098_retrato.sql';
  END IF;
  PERFORM set_config('search_path', caminho, true);
  RAISE NOTICE '098 retrato ${estado} OK';
END $$;
-- @@BLOCO-RETRATO-FIM ${estado}`;
}

function embutir(arquivo, estado, hash) {
  let sql = ler(arquivo);
  const bloco = blocoDoRetrato(estado, hash);
  const ini = sql.indexOf('-- @@BLOCO-RETRATO-INICIO');
  if (ini >= 0) {
    const marca = '-- @@BLOCO-RETRATO-FIM';
    const fim = sql.indexOf('\n', sql.indexOf(marca, ini));
    sql = sql.slice(0, ini) + bloco + (fim < 0 ? '\n' : sql.slice(fim));
  } else {
    sql = `${sql.trimEnd()}\n${bloco}\n`;
  }
  fs.writeFileSync(arquivo, sql);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/').split('/').pop())) {
  embutir('database/checks/20261023_098_precheck.sql', '094', RETRATO_094);
  embutir('database/checks/20261023_098_postcheck.sql', '098', RETRATO_098);
  embutir('database/checks/20261023_098_integridade.sql', '098', RETRATO_098);
  console.log('ok');
}
