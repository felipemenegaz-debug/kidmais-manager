/* eslint-disable @typescript-eslint/no-require-imports -- Runner CommonJS e hook TypeScript restritos ao processo de teste. */
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { createHash } = require('node:crypto');
const ts = require('typescript');
const { Client } = require('pg');
const root = resolve(__dirname, '..');
require.extensions['.ts'] = (module, filename) => {
  const output = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename,
  }).outputText.replace(/require\("@\/([^"\n]+)"\)/g, (_, path) => `require(${JSON.stringify(resolve(root, path))})`);
  module._compile(output, filename);
};
function client() {
  return new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' } : undefined });
}
const ctx = { origem: 'TESTE_PAGAMENTOS_ROLLBACK' };
const plano = { meioPagamento: 'PIX', modalidade: 'PARCELADO', parcelas: [
  { valor: 40, vencimento: '2098-10-01', confirmaReserva: true }, { valor: 60, vencimento: '2098-10-02' },
] };
async function fixture(c, { data = '2098-10-10', inicio = '11:00', fim = '15:00' } = {}) {
  const cliente = (await c.query("INSERT INTO clientes(nome_completo) VALUES ('TESTE SINTETICO PAGAMENTOS ROLLBACK') RETURNING id")).rows[0];
  const f = (await c.query(`INSERT INTO fechamentos (
    cliente_id,data_evento,horario_inicio,horario_fim,configuracao_agenda_id,pacote_id,tabela_preco_id,preco_pacote_id,
    categoria_horario,categoria_preco_aplicada,convidados,convidados_faturados,valor_pacote_base,valor_pacote_aplicado,
    valor_tabela,status,origem_fechamento,observacoes_equipe)
    SELECT $1,$2,$3,$4,ca.id,p.id,tp.id,pp.id,
    pp.categoria_horario,pp.categoria_horario,50,50,100,100,100,'CONTRATO_ASSINADO',
    'ATENDIMENTO_KIDMAIS','TESTE SINTETICO ROLLBACK'
    FROM configuracao_agenda ca
    JOIN pacotes p ON p.codigo='COMPLETA' AND p.ativo
    JOIN tabelas_preco tp ON tp.ativa
    JOIN precos_pacote pp ON pp.tabela_preco_id=tp.id AND pp.pacote_id=p.id AND pp.ativo
      AND pp.convidados_min<=50 AND (pp.convidados_max IS NULL OR pp.convidados_max>=50)
    WHERE ca.codigo='TURNO_1' AND ca.ativo
    ORDER BY CASE pp.categoria_horario WHEN 'PADRAO' THEN 0 ELSE 1 END,pp.convidados_min DESC
    LIMIT 1 RETURNING id`,
  [cliente.id, data, inicio, fim])).rows[0];
  assert.ok(f, 'Requer o catálogo comercial e a configuração de agenda preservados no clone sanitizado.');
  const contrato = (await c.query(`INSERT INTO contratos(fechamento_id,status,versao_atual,assinado_em)
    VALUES ($1,'ASSINADO',1,now()) RETURNING id`, [f.id])).rows[0];
  const snapshot = JSON.stringify({ comercial: { valorFinalContrato: 100 }, testeSintetico: true });
  const hash = createHash('sha256').update(snapshot).digest('hex');
  const versao = (await c.query(`INSERT INTO contrato_versoes(contrato_id,numero_versao,status,snapshot,snapshot_hash,
    assinado_em,documento_template_versao,documento_pdf_hash,aceite_metodo)
    VALUES ($1,1,'ASSINADA',$2,$3,now(),1,$3,'OTP') RETURNING id`, [contrato.id,snapshot,hash])).rows[0];
  return { clienteId: cliente.id, fechamentoId: f.id, contratoId: contrato.id, versaoId: versao.id, data };
}
function installPool(c) {
  globalThis.__kidmaisPgPool = {
    query: (sql, values) => c.query(sql, values),
    connect: async () => ({
      query: (sql, values) => c.query({ BEGIN: 'SAVEPOINT operacao', COMMIT: 'RELEASE SAVEPOINT operacao', ROLLBACK: 'ROLLBACK TO SAVEPOINT operacao' }[sql] || sql, values),
      release() {},
    }),
  };
}
async function fingerprint(c) {
  const names = ['clientes','fechamentos','contratos','contrato_versoes','pagamentos','pagamento_planos','pagamento_parcelas',
    'pagamento_recebimentos','pagamento_recebimento_alocacoes','pagamento_estornos','pagamento_comprovantes','auditoria','eventos_historico_cliente','bloqueios_agenda'];
  const result = {};
  for (const name of names) result[name] = (await c.query(`SELECT count(*)::int AS total, md5(COALESCE(string_agg(to_jsonb(t)::text, '' ORDER BY id),'')) AS hash FROM ${name} t`)).rows[0];
  return result;
}
async function rollbackTest(work) {
  const c = client(); await c.connect();
  const before = await fingerprint(c);
  try {
    await c.query('BEGIN'); await c.query("SET LOCAL lock_timeout='5s'");
    installPool(c);
    if ((await c.query("SELECT to_regclass('pagamento_gestoes') AS tabela")).rows[0].tabela) {
      const admin=await require('./admin-test-support.cjs').autenticarTeste(c);
      Object.assign(ctx,{usuarioId:admin.usuarioId,token:admin.token});
    }
    await work(c);
  } finally {
    await c.query('ROLLBACK'); delete globalThis.__kidmaisPgPool;
    try { assert.deepEqual(await fingerprint(c), before, 'O banco deve permanecer integralmente inalterado.'); }
    finally { await c.end(); }
  }
}
module.exports = { client, ctx, plano, fixture, installPool, rollbackTest, fingerprint };
