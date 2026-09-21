// Explicit operational tool. No migration execution, no dotenv, no default target.
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { garantirFestaFormalizada } from '../lib/festas/formalizacao.ts';
import { validarAmbienteFesta } from '../lib/festas/ambiente.ts';

const args = process.argv.slice(2);
const value = flag => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
const expected = value('--database');
const id = value('--contrato');
const apply = args.includes('--apply');
let client;
try {
  if (!expected || !/^(kidmais_production|kidmais_019_\d+)$/.test(expected)) throw Error('Explicit allowed target required');
  const url = new URL(process.env.FESTA_019_RECONCILIACAO_URL ?? '');
  if (decodeURIComponent(url.pathname.slice(1)) !== expected || !['postgres:', 'postgresql:'].includes(url.protocol) || url.search || url.hash) throw Error('Target mismatch');
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (expected === 'kidmais_production' && local || expected !== 'kidmais_production' && !local) throw Error('Target mismatch');
  if (apply && (!args.includes('--authorize-write') || !/^[0-9a-f-]{36}$/i.test(id ?? ''))) throw Error('Explicit single-contract write authorization required');
  const internalRender = /^dpg-[a-z0-9]+-[a-z0-9]+$/.test(url.hostname);
  client = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 5000,
    ssl: local ? false : { rejectUnauthorized: !internalRender } });
  await client.connect();
  await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
  await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
  if ((await client.query('SELECT current_database() AS db')).rows[0].db !== expected) throw Error('Target mismatch');
  await validarAmbienteFesta(client);
  if (apply) {
    const c = (await client.query('SELECT * FROM contratos WHERE id=$1', [id])).rows[0];
    if (!c) throw Error('Contract missing');
    await client.query('SELECT id FROM fechamentos WHERE id=$1 FOR UPDATE', [c.fechamento_id]);
    await client.query('SELECT id FROM contratos WHERE id=$1 FOR UPDATE', [id]);
    const cf = (await client.query('SELECT versao_vigente_id FROM contrato_fluxos WHERE contrato_id=$1 FOR UPDATE', [id])).rows[0];
    const result = await garantirFestaFormalizada(client, id, cf?.versao_vigente_id, { requestId: randomUUID() }, 'RECONCILIAR');
    await client.query('COMMIT');
    console.log(JSON.stringify({ contratoId: id, status: 'APROVADO', ...result }));
  } else {
    const report = await client.query(`SELECT c.id AS contrato_id,cf.versao_vigente_id,
      public.kidmais019_formalizacao(c.id,cf.versao_vigente_id) AS elegivel,
      EXISTS(SELECT 1 FROM festas ft WHERE ft.contrato_id=c.id AND ft.invalidada_em IS NOT NULL) AS possui_invalidada,
      EXISTS(SELECT 1 FROM public.kidmais_ocupacoes_operacionais(f.data_evento,f.data_evento) o
        WHERE o.fechamento_id<>f.id AND o.horario_inicio<f.horario_fim AND o.horario_fim>f.horario_inicio) AS conflito_contrato,
      EXISTS(SELECT 1 FROM bloqueios_agenda b WHERE b.ativo AND b.data=f.data_evento AND (b.dia_inteiro OR b.horario_inicio IS NULL OR b.horario_fim IS NULL OR (b.horario_inicio<f.horario_fim AND b.horario_fim>f.horario_inicio))) AS conflito_bloqueio
      FROM contratos c JOIN fechamentos f ON f.id=c.fechamento_id LEFT JOIN contrato_fluxos cf ON cf.contrato_id=c.id
      WHERE c.status='ASSINADO' AND NOT EXISTS(SELECT 1 FROM festas ft WHERE ft.contrato_id=c.id AND ft.invalidada_em IS NULL)
      ORDER BY c.id`);
    await client.query('ROLLBACK');
    console.log(JSON.stringify({ modo: 'SOMENTE_LEITURA', contratos: report.rows }));
  }
} catch (error) {
  if (client) await client.query('ROLLBACK').catch(() => {});
  console.error(JSON.stringify({ status: 'RECUSADO', contratoId: id ?? null, codigo: error?.code ?? 'VALIDACAO_OU_EXECUCAO' }));
  process.exitCode = 1;
} finally { if (client) await client.end(); }
