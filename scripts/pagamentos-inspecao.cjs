/* eslint-disable @typescript-eslint/no-require-imports -- Script Node CommonJS. */
const { Client } = require('pg');
const { readFileSync } = require('node:fs');
const assert = require('node:assert/strict');
async function main() {
  const c = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
  await c.connect();
  try {
    await c.query('BEGIN READ ONLY');
    console.log('Banco', (await c.query('SELECT current_database() AS banco, inet_server_port() AS porta, current_setting(\'server_version\') AS versao')).rows);
    const checks = await c.query(readFileSync('database/checks/20260908_011_pagamentos_postcheck.sql', 'utf8'));
    const migration=readFileSync('database/migrations/20260908_011_pagamentos_base.sql','utf8');
    const expected={
      constraints:[...migration.matchAll(/CONSTRAINT\s+(\w+)/g)].map(m=>m[1]),
      indices:[...migration.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(\w+)/g)].map(m=>m[1]),
      triggers:[...migration.matchAll(/CREATE\s+TRIGGER\s+(\w+)/g)].map(m=>m[1]),
    };
    for(const [kind,rows,field] of [['constraints',checks[2].rows,'constraint_name'],['indices',checks[3].rows,'indexname'],['triggers',checks[4].rows,'trigger_name']]) {
      for(const name of expected[kind])assert.ok(rows.some(r=>r[field]===name),`Objeto físico ausente: ${name}`);
    }
    console.log('Objetos nomeados da migration 011 conferidos',Object.fromEntries(Object.entries(expected).map(([k,v])=>[k,v.length])));
    console.log('Postcheck', JSON.stringify({tabelas:checks[0].rows,contagens:checks[1].rows,
      constraintsSemNotNull:checks[2].rows.filter(r=>!r.definicao.startsWith('NOT NULL')).length,
      indicesTotais:checks[3].rows.length,triggers:checks[4].rows.length,legado:checks[5].rows}));
    if(process.argv.includes('--estrutura'))console.log('Estrutura completa',JSON.stringify(checks.map(r=>r.rows)));
    const ids = ['f9207fe7-ed6d-4149-a148-8143eedbd6bb', '59dcf33b-8da1-4cae-9d4d-1f3f3dd95b31'];
    for (const id of ids) {
      console.log('Caso', id);
      for (const sql of [
        `SELECT p.id, p.status, p.reserva_status, p.valor_total_contratado, p.quitado_em,
          f.id AS fechamento_id, f.status AS fechamento_status, f.valor_aprovado,
          c.id AS contrato_id, c.status AS contrato_status, cv.status AS versao_status,
          cv.snapshot->'comercial'->>'valorFinalContrato' AS valor_snapshot
          FROM pagamentos p JOIN contrato_versoes cv ON cv.id=p.contrato_versao_id
          JOIN contratos c ON c.id=cv.contrato_id JOIN fechamentos f ON f.id=c.fechamento_id WHERE p.id=$1`,
        `SELECT pl.numero_versao,pl.status,pl.meio_pagamento,pl.modalidade,pl.provedor_preferido,
          pl.substituido_em,pl.motivo_substituicao,pa.numero,pa.status AS parcela_status,pa.valor_previsto,pa.confirma_reserva
          FROM pagamento_planos pl JOIN pagamento_parcelas pa ON pa.plano_id=pl.id WHERE pl.pagamento_id=$1 ORDER BY pl.numero_versao,pa.numero`,
        `SELECT status,count(*),sum(valor_bruto) AS valor FROM pagamento_recebimentos WHERE pagamento_id=$1 GROUP BY status`,
        `SELECT e.status,count(*),sum(e.valor) AS valor FROM pagamento_estornos e JOIN pagamento_recebimentos r ON r.id=e.recebimento_id WHERE r.pagamento_id=$1 GROUP BY e.status`,
        `SELECT count(*) AS comprovantes FROM pagamento_comprovantes c JOIN pagamento_recebimentos r ON r.id=c.recebimento_id WHERE r.pagamento_id=$1`,
        `SELECT acao,count(*) FROM auditoria WHERE entidade_id=$1
          OR entidade_id IN (SELECT id FROM pagamento_recebimentos WHERE pagamento_id=$1)
          OR entidade_id IN (SELECT e.id FROM pagamento_estornos e JOIN pagamento_recebimentos r ON r.id=e.recebimento_id WHERE r.pagamento_id=$1)
          OR entidade_id IN (SELECT c.id FROM pagamento_comprovantes c JOIN pagamento_recebimentos r ON r.id=c.recebimento_id WHERE r.pagamento_id=$1) GROUP BY acao`,
        `SELECT tipo_evento,count(*) FROM eventos_historico_cliente WHERE entidade_id=$1
          OR entidade_id IN (SELECT id FROM pagamento_recebimentos WHERE pagamento_id=$1)
          OR entidade_id IN (SELECT e.id FROM pagamento_estornos e JOIN pagamento_recebimentos r ON r.id=e.recebimento_id WHERE r.pagamento_id=$1) GROUP BY tipo_evento`,
      ]) console.log(JSON.stringify((await c.query(sql, [id])).rows));
    }
  } finally { await c.query('ROLLBACK'); await c.end(); }
}
main().catch(e => { console.error(e.code || e.message); process.exitCode=1; });
