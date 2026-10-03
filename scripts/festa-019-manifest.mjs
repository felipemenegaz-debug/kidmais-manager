// Offline generator. Run after editing migration 019 or 061; never connects to a database.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const sql = fs.readFileSync('database/migrations/20260915_019_festa_formalizacao.sql', 'utf8').replaceAll('\r', '');
const functions = [...sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\([\s\S]*?AS \$\$([\s\S]*?)\$\$;/g)]
  .map(m => [m[1], createHash('sha256').update(m[2]).digest('hex')]);
if (functions.length !== 10) throw Error('Expected ten function definitions');
const triggers = [...sql.matchAll(/CREATE (?:CONSTRAINT )?TRIGGER (\w+) [\s\S]*? ON public\.(\w+) [\s\S]*?EXECUTE FUNCTION public\.(\w+)\(\);/g)]
  .map(m => [m[1], m[2], m[3], m[0].includes('DEFERRABLE')]);
const query = `WITH esperadas(nome,hash) AS (VALUES ${functions.map(([n,h]) => `('${n}','${h}')`).join(',\n')}),
gatilhos(nome,tabela,funcao,diferido) AS (VALUES ${triggers.map(([n,t,f,d]) => `('${n}','${t}','${f}',${d})`).join(',\n')})
SELECT
 NOT EXISTS(SELECT 1 FROM esperadas e WHERE NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname=e.nome AND NOT p.prosecdef
 AND encode(sha256(convert_to(replace(p.prosrc,E'\\r',''),'UTF8')),'hex')=e.hash))
 AND NOT EXISTS(SELECT 1 FROM gatilhos g WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
 WHERE t.tgname=g.nome AND t.tgrelid=to_regclass('public.'||g.tabela) AND p.proname=g.funcao AND t.tgenabled='O'
 AND t.tgdeferrable=g.diferido AND t.tginitdeferred=g.diferido AND t.tgtype=CASE WHEN g.diferido THEN 21 ELSE 23 END))
 AND (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND
 ((table_name='festas' AND column_name='origem_criacao') OR (table_name='festa_eventos' AND column_name='ator_tipo'))
 AND data_type='text' AND is_nullable='NO')=2
 AND (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND
 ((table_name='festas' AND column_name='criado_por') OR (table_name='festa_eventos' AND column_name='usuario_id'))
 AND is_nullable='YES')=2
 AND (SELECT count(*) FROM pg_constraint WHERE connamespace='public'::regnamespace
 AND conname IN ('festa019_autoria_check','festa019_evento_autoria_check') AND convalidated)=2`;

// O módulo Festa aceita CONJUNTOS COERENTES de corpos, nunca uma mistura função a função:
//   019 — como instalada pela 019;
//   061 — 019 com formalização, ocupações e agenda da revisão da 061 (regra explícita da importação histórica);
//   062 — 061 com destino, contrato, bloqueio e agenda da revisão da 062 (agenda por empresa e unidade).
// kidmais019_ocupa, bloquear_contrato, lock_ocupacao e proteger_invalidacao são da 019 nos três. O postcheck da 019
// continua exigindo exatamente a 019.
const corpos = (arquivo, nomes) => {
  if (!fs.existsSync(arquivo)) return [];
  const sqlX = fs.readFileSync(arquivo, 'utf8').replaceAll('\r', '');
  return nomes.map((n) => {
    const m = sqlX.match(new RegExp(String.raw`CREATE (?:OR REPLACE )?FUNCTION public\.` + n + String.raw`\([\s\S]*?AS \$\$([\s\S]*?)\$\$;`));
    if (!m) throw Error(`${arquivo} sem ${n}`);
    return [n, createHash('sha256').update(m[1]).digest('hex')];
  });
};
const de061 = corpos('database/migrations/20261002_061_contratos_importados_integracao.sql', ['kidmais019_formalizacao', 'kidmais_ocupacoes_operacionais', 'kidmais_validar_agenda_revisao']);
const de062 = de061.length ? corpos('database/migrations/20261002_062_agenda_empresa_unidade.sql', ['kidmais019_validar_destino', 'kidmais019_validar_contrato', 'kidmais_proteger_bloqueio_revisao', 'kidmais_validar_agenda_revisao']) : [];
const sobre = (base, novos) => base.map(([n, h]) => novos.find(([x]) => x === n) ?? [n, h]);
const conjuntos = [['019', functions]];
if (de061.length) conjuntos.push(['061', sobre(functions, de061)]);
if (de062.length) conjuntos.push(['062', sobre(sobre(functions, de061), de062)]);
for (const [, lista] of conjuntos) if (lista.length !== 10) throw Error('Conjunto incompleto');
const estrito = ` NOT EXISTS(SELECT 1 FROM esperadas e WHERE NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname=e.nome AND NOT p.prosecdef
 AND encode(sha256(convert_to(replace(p.prosrc,E'\\r',''),'UTF8')),'hex')=e.hash))`;
const porConjunto = ` EXISTS(SELECT 1 FROM (SELECT DISTINCT conjunto FROM esperadas) c WHERE NOT EXISTS(SELECT 1 FROM esperadas e WHERE e.conjunto=c.conjunto
 AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname=e.nome AND NOT p.prosecdef
 AND encode(sha256(convert_to(replace(p.prosrc,E'\\r',''),'UTF8')),'hex')=e.hash)))`;
if (!query.includes(estrito)) throw Error('Unexpected 019 query shape');
const cabecalho = `WITH esperadas(nome,hash) AS (VALUES ${functions.map(([n,h]) => `('${n}','${h}')`).join(',\n')})`;
if (!query.startsWith(cabecalho)) throw Error('Unexpected 019 header');
const cabecalhoConjuntos = `WITH esperadas(conjunto,nome,hash) AS (VALUES ${conjuntos.flatMap(([c, lista]) => lista.map(([n,h]) => `('${c}','${n}','${h}')`)).join(',\n')})`;
const runtime = conjuntos.length > 1
  ? cabecalhoConjuntos + query.slice(cabecalho.length).replace(estrito, porConjunto)
  : query;
fs.writeFileSync('lib/festas/estrutura-019.ts', `/** Generated offline by scripts/festa-019-manifest.mjs. */\nexport const estruturaFesta019Sql = ${JSON.stringify(runtime + ' AS valida')};\n`);
const baseline = fs.readFileSync('lib/festas/estrutura-016.ts', 'utf8');
const tables = baseline.match(/tabelasFesta016 = (\[[^;]+\])/)[1];
const oldSql = baseline.match(/estruturaFesta016Sql = `([\s\S]*?)`;/)[1].replaceAll('$1::text[]', 'ARRAY' + tables + '::text[]');
const oldHash = baseline.match(/assinaturaEstruturaFesta016 = "([a-f0-9]+)"/)[1];
fs.writeFileSync('database/checks/20260915_019_postcheck.sql', `BEGIN READ ONLY;\nDO $check$ BEGIN\n IF NOT (${query}) THEN RAISE EXCEPTION 'Postcheck 019: instalação divergente'; END IF;\n IF (${oldSql}) <> '${oldHash}' THEN RAISE EXCEPTION 'Postcheck 019: baseline 016 divergente'; END IF;\nEND $check$;\n-- Report only: old contracts need explicit reconciliation.\nSELECT c.id contrato_id,cf.versao_vigente_id FROM public.contratos c\nLEFT JOIN public.contrato_fluxos cf ON cf.contrato_id=c.id\nWHERE c.status='ASSINADO' AND NOT EXISTS(SELECT 1 FROM public.festas f WHERE f.contrato_id=c.id AND f.invalidada_em IS NULL);\nCOMMIT;\n`);
