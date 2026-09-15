// Offline generator. Run after editing migration 019; never connects to a database.
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
fs.writeFileSync('lib/festas/estrutura-019.ts', `/** Generated offline by scripts/festa-019-manifest.mjs. */\nexport const estruturaFesta019Sql = ${JSON.stringify(query + ' AS valida')};\n`);
const baseline = fs.readFileSync('lib/festas/estrutura-016.ts', 'utf8');
const tables = baseline.match(/tabelasFesta016 = (\[[^;]+\])/)[1];
const oldSql = baseline.match(/estruturaFesta016Sql = `([\s\S]*?)`;/)[1].replaceAll('$1::text[]', 'ARRAY' + tables + '::text[]');
const oldHash = baseline.match(/assinaturaEstruturaFesta016 = "([a-f0-9]+)"/)[1];
fs.writeFileSync('database/checks/20260915_019_postcheck.sql', `BEGIN READ ONLY;\nDO $check$ BEGIN\n IF NOT (${query}) THEN RAISE EXCEPTION 'Postcheck 019: instalação divergente'; END IF;\n IF (${oldSql}) <> '${oldHash}' THEN RAISE EXCEPTION 'Postcheck 019: baseline 016 divergente'; END IF;\nEND $check$;\n-- Report only: old contracts need explicit reconciliation.\nSELECT c.id contrato_id,cf.versao_vigente_id FROM public.contratos c\nLEFT JOIN public.contrato_fluxos cf ON cf.contrato_id=c.id\nWHERE c.status='ASSINADO' AND NOT EXISTS(SELECT 1 FROM public.festas f WHERE f.contrato_id=c.id AND f.invalidada_em IS NULL);\nCOMMIT;\n`);
