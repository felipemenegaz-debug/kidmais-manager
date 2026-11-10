import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Client } from 'pg';
import { conectarDescartavel, encerrarDescartavel } from '../comercial/postgres-descartavel.ts';

/**
 * Entrega B — migration 112 (cliente pessoa jurídica) no PostgreSQL DESCARTÁVEL, modelo 109 (sem a 112): precheck,
 * aplicação, postcheck, CHECKs em INSERT e UPDATE, unicidade do CNPJ por empresa (com corrida real entre duas conexões),
 * linhas PF existentes intactas e rollback (recusado sem efeito com qualquer dado de PJ; aceito sem PJ; reaplica).
 */
const opt = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL === 'kidmais_pacotes_v1_descartavel';
let client: Client;
const ler = (r: string) => readFileSync(new URL(`../../${r}`, import.meta.url), 'utf8');
const UP = 'database/migrations/20261101_112_clientes_pessoa_juridica.sql';
const DOWN = 'database/rollback/20261101_112_clientes_pessoa_juridica_down.sql';
const PRE = 'database/checks/20261101_112_precheck.sql';
const POS = 'database/checks/20261101_112_postcheck.sql';
// Corpo sem o controle de transação próprio: roda dentro da transação do teste (BEGIN/ROLLBACK do teste).
const corpo = (sql: string) => sql.replace(/^BEGIN( TRANSACTION READ ONLY)?;$/m, '').replace(/^(COMMIT|ROLLBACK);$/m, '');
const CNPJ = '11222333000181';
const CNPJ_ALFA = '12ABC34501DE35';
const CPF = '52998224725';
const CPF_REP = '11144477735';

async function empresa() {
  return (await client.query("INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Buffet 112', 'PROVISIONAMENTO') RETURNING id::text AS id",
    [`pj${randomBytes(4).toString('hex')}`])).rows[0].id as string;
}
async function emTx<T>(f: () => Promise<T>) {
  await client.query('BEGIN');
  try { return await f(); } finally { await client.query('ROLLBACK'); }
}
async function recusa(sql: string, params: unknown[], padrao: RegExp) {
  await client.query('SAVEPOINT recusa');
  await assert.rejects(client.query(sql, params), padrao);
  await client.query('ROLLBACK TO SAVEPOINT recusa');
}
const pj = (e: string, extra: Record<string, unknown> = {}) => {
  const d = { empresa_id: e, nome_completo: 'Escola Pequeno Saber Ltda', razao_social: 'Escola Pequeno Saber Ltda', cnpj: CNPJ,
    tipo_pessoa: 'PJ', telefone: '62998765432', ...extra };
  const k = Object.keys(d);
  return [`INSERT INTO clientes (${k.join(', ')}) VALUES (${k.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id::text AS id`, Object.values(d)] as const;
};
const colunas112 = async () => (await client.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'public'
  AND table_name = 'clientes' AND column_name IN ('tipo_pessoa','cnpj','razao_social','nome_fantasia','representante_nome','representante_cpf')`)).rows[0].n as number;

// O arquivo abre a própria transação; recusado no DO, a sessão fica abortada até o ROLLBACK (como o psql ao sair).
async function downRecusado() {
  await assert.rejects(client.query(ler(DOWN)), /rollback recusado/);
  await client.query('ROLLBACK');
}

test.before(async () => { if (opt()) client = await conectarDescartavel(); });
test.after(async () => { if (client) await encerrarDescartavel(client); });

test('112: precheck no modelo 109, aplicação e postcheck; PF existente intacta (tipo PF, colunas novas nulas)', { skip: !opt() }, async () => {
  await emTx(async () => {
    const e = await empresa();
    const pf = (await client.query("INSERT INTO clientes (empresa_id, nome_completo, cpf, telefone) VALUES ($1, 'Paula Ramos', $2, '61987654321') RETURNING id", [e, CPF])).rows[0].id;
    await client.query(corpo(ler(PRE)));
    await client.query(corpo(ler(UP)));
    await client.query(corpo(ler(POS)));
    const l = (await client.query('SELECT tipo_pessoa, cpf, cnpj, razao_social, nome_fantasia, representante_nome, representante_cpf FROM clientes WHERE id = $1', [pf])).rows[0];
    assert.deepEqual(l, { tipo_pessoa: 'PF', cpf: CPF, cnpj: null, razao_social: null, nome_fantasia: null, representante_nome: null, representante_cpf: null });
    // Reaplicar recusa (marcador de "já aplicada") e o precheck também recusa depois.
    await recusa(corpo(ler(UP)), [], /112 já aplicada/);
    await recusa(corpo(ler(PRE)), [], /112 já \(parcialmente\) presente/);
  });
});

test('112 postcheck: corpo de função trocado com a mesma assinatura e atributos é divergência (mesclagem e DV); corpo original volta a passar', { skip: !opt() }, async () => {
  await emTx(async () => {
    await empresa();
    await client.query(corpo(ler(UP)));
    await client.query(corpo(ler(POS)));
    const original = (await client.query(`SELECT pg_get_functiondef('public.kidmais_112_mesclagem_mesmo_tipo()'::regprocedure) AS d`)).rows[0].d as string;
    // Revisão do Astra (r1, P2-2): a função só devolve NEW, com assinatura, search_path e sem SECURITY DEFINER mantidos.
    await client.query(`CREATE OR REPLACE FUNCTION public.kidmais_112_mesclagem_mesmo_tipo() RETURNS trigger
      LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $f$ BEGIN RETURN NEW; END $f$`);
    await recusa(corpo(ler(POS)), [], /112 postcheck: funções divergentes/);
    // A instalação divergente deixou de impedir PF×PJ: é exatamente o que o postcheck agora barra.
    await client.query(original);
    await client.query(corpo(ler(POS)));
    // DV permissivo com os mesmos atributos, feito para passar nos vetores conhecidos: só o corpo conferido o pega.
    const dv = (await client.query(`SELECT pg_get_functiondef('public.kidmais_112_cpf_valido(text)'::regprocedure) AS d`)).rows[0].d as string;
    await client.query(`CREATE OR REPLACE FUNCTION public.kidmais_112_cpf_valido(doc text) RETURNS boolean
      LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $f$
      BEGIN IF doc = '11111111111' OR doc = '52998224726' THEN RETURN false; END IF; RETURN doc ~ '^[0-9]{11}$'; END $f$`);
    await recusa(corpo(ler(POS)), [], /112 postcheck: funções divergentes/);
    await client.query(dv);
    await client.query(corpo(ler(POS)));
  });
});

test('112: CHECKs de PF e PJ em INSERT (DV no banco, campos de PJ nulos em PF, razão social = nome, CPF nulo em PJ)', { skip: !opt() }, async () => {
  await emTx(async () => {
    await client.query(corpo(ler(UP)));
    const e = await empresa();
    // Válidos: CNPJ numérico e alfanumérico, representante com CPF válido.
    await client.query(...pj(e));
    await client.query(...pj(e, { cnpj: CNPJ_ALFA, nome_fantasia: 'Pequeno Saber', representante_nome: 'Carla Dias', representante_cpf: CPF_REP }));
    // PF com qualquer campo de PJ: recusada (o rollback nunca perde dado de PF).
    for (const campo of ['cnpj', 'razao_social', 'nome_fantasia', 'representante_nome', 'representante_cpf']) {
      const valor = campo === 'cnpj' ? '45723174000110' : campo === 'representante_cpf' ? CPF_REP : 'Texto';
      await recusa(`INSERT INTO clientes (empresa_id, nome_completo, telefone, ${campo}) VALUES ($1, 'PF', '61987654321', $2)`, [e, valor], /clientes_112_pf_sem_campos_pj/);
    }
    await recusa(...pj(e, { cnpj: '11222333000182' }), /clientes_112_cnpj_formato/);
    await recusa(...pj(e, { cnpj: '12abc34501de35' }), /clientes_112_cnpj_formato/);
    await recusa(...pj(e, { cnpj: '11.222.333/0001-81' }), /clientes_112_cnpj_formato/);
    await recusa(...pj(e, { cnpj: null }), /clientes_112_pj_identidade/);
    await recusa(...pj(e, { cnpj: '45723174000110', cpf: CPF }), /clientes_112_pj_identidade/);
    await recusa(...pj(e, { cnpj: '45723174000110', razao_social: 'Outra Razão' }), /clientes_112_pj_identidade/);
    await recusa(...pj(e, { cnpj: '45723174000110', razao_social: null }), /clientes_112_pj_identidade/);
    await recusa(...pj(e, { cnpj: '45723174000110', nome_fantasia: '  ' }), /clientes_112_textos_nao_vazios/);
    await recusa(...pj(e, { cnpj: '45723174000110', representante_cpf: '52998224726', representante_nome: 'Carla' }), /clientes_112_representante_cpf_formato/);
    await recusa(...pj(e, { cnpj: '45723174000110', representante_cpf: CPF_REP }), /clientes_112_representante_nome/);
    await recusa(...pj(e, { cnpj: '45723174000110', tipo_pessoa: 'MEI' }), /clientes_112_tipo_pessoa_check/);
  });
});

test('112: CHECKs também no UPDATE (PF→PJ com CPF, PJ→PF sem limpar, razão social divergente do nome)', { skip: !opt() }, async () => {
  await emTx(async () => {
    await client.query(corpo(ler(UP)));
    const e = await empresa();
    const pf = (await client.query("INSERT INTO clientes (empresa_id, nome_completo, cpf, telefone) VALUES ($1, 'Paula Ramos', $2, '61987654321') RETURNING id", [e, CPF])).rows[0].id;
    const j = (await client.query(...pj(e))).rows[0].id;
    await recusa("UPDATE clientes SET tipo_pessoa = 'PJ', cnpj = $2, razao_social = nome_completo WHERE id = $1", [pf, '45723174000110'], /clientes_112_pj_identidade/);
    await recusa("UPDATE clientes SET tipo_pessoa = 'PF' WHERE id = $1", [j], /clientes_112_pf_sem_campos_pj/);
    await recusa("UPDATE clientes SET nome_completo = 'Outro Nome' WHERE id = $1", [j], /clientes_112_pj_identidade/);
    // Troca explícita com limpeza na mesma gravação: aceita (PF→PJ com CPF nulo; PJ→PF com os cinco campos nulos).
    await client.query("UPDATE clientes SET tipo_pessoa = 'PJ', cpf = NULL, cnpj = $2, razao_social = nome_completo WHERE id = $1", [pf, '45723174000110']);
    await client.query("UPDATE clientes SET tipo_pessoa = 'PF', cnpj = NULL, razao_social = NULL, nome_fantasia = NULL, representante_nome = NULL, representante_cpf = NULL WHERE id = $1", [j]);
  });
});

test('112: CNPJ único por empresa fora de MESCLADO; o mesmo CNPJ em outra empresa é permitido; CPF do representante não é chave', { skip: !opt() }, async () => {
  await emTx(async () => {
    await client.query(corpo(ler(UP)));
    const e1 = await empresa();
    const e2 = await empresa();
    const a = (await client.query(...pj(e1, { representante_nome: 'Carla Dias', representante_cpf: CPF_REP }))).rows[0].id;
    await recusa(...pj(e1), /clientes_cnpj_empresa_canonico_uk/);
    await client.query(...pj(e2));
    // Representante compartilhado por duas PJs da mesma empresa: permitido.
    await client.query(...pj(e1, { cnpj: '45723174000110', representante_nome: 'Carla Dias', representante_cpf: CPF_REP }));
    // E também como PF da mesma empresa (o CPF do representante não conflita com o CPF de cliente).
    await client.query("INSERT INTO clientes (empresa_id, nome_completo, cpf, telefone) VALUES ($1, 'Carla Dias', $2, '61987654321')", [e1, CPF_REP]);
    // Mesclado sai do índice: outro cadastro com o mesmo CNPJ passa a ser possível.
    const b = (await client.query(...pj(e1, { cnpj: CNPJ_ALFA }))).rows[0].id;
    await client.query("UPDATE clientes SET status = 'MESCLADO', cliente_principal_id = $2, mesclado_em = now() WHERE id = $1", [a, b]);
    await client.query(...pj(e1));
  });
});

test('112: mesclagem só entre clientes do mesmo tipo (status MESCLADO, registro em mesclagens_clientes e troca de tipo do principal)', { skip: !opt() }, async () => {
  await emTx(async () => {
    await client.query(corpo(ler(UP)));
    const e = await empresa();
    const pf = async (cpf: string | null) => (await client.query("INSERT INTO clientes (empresa_id, nome_completo, cpf, telefone) VALUES ($1, 'Pessoa', $2, '61987654321') RETURNING id::text AS id", [e, cpf])).rows[0].id as string;
    const pf1 = await pf(CPF);
    const pf2 = await pf(null);
    const j1 = (await client.query(...pj(e))).rows[0].id as string;
    const j2 = (await client.query(...pj(e, { cnpj: CNPJ_ALFA }))).rows[0].id as string;
    const usuario = (await client.query("INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Op', $2, 'ADMINISTRATIVO', true) RETURNING id::text AS id",
      [`op${randomBytes(4).toString('hex')}@example.test`, `scrypt$v=1$N=131072$r=8$p=1$${'A'.repeat(22)}==$${'B'.repeat(86)}==`])).rows[0].id;
    const mesclar = "UPDATE clientes SET status = 'MESCLADO', cliente_principal_id = $2, mesclado_em = now() WHERE id = $1";
    const registro = 'INSERT INTO mesclagens_clientes (cliente_principal_id, cliente_secundario_id, motivo, executado_por_usuario_id) VALUES ($1, $2, $3, $4)';
    // Tipos diferentes: recusado nos dois sentidos, no status e no registro.
    await recusa(mesclar, [j1, pf1], /mesclagem só entre clientes do mesmo tipo/);
    await recusa(mesclar, [pf1, j1], /mesclagem só entre clientes do mesmo tipo/);
    await recusa(registro, [pf1, j1, 'Teste', usuario], /mesclagem só entre clientes do mesmo tipo/);
    await recusa(registro, [j1, pf1, 'Teste', usuario], /mesclagem só entre clientes do mesmo tipo/);
    // Mesmo tipo: aceito (PJ com PJ, PF com PF).
    await client.query(mesclar, [j2, j1]);
    await client.query(registro, [j1, j2, 'Mesmo CNPJ?', usuario]);
    await client.query(mesclar, [pf2, pf1]);
    await client.query(registro, [pf1, pf2, 'Duplicado', usuario]);
    // O principal com mesclado do outro tipo não troca de tipo; o mesclado também não (o principal é de outro tipo).
    await recusa("UPDATE clientes SET tipo_pessoa = 'PF', cnpj = NULL, razao_social = NULL WHERE id = $1", [j1], /não muda de tipo/);
    await recusa("UPDATE clientes SET tipo_pessoa = 'PJ', cpf = NULL, cnpj = '45723174000110', razao_social = nome_completo WHERE id = $1", [pf2], /mesclagem só entre clientes do mesmo tipo/);
    // Postcheck continua aprovando com dados de mesclagem.
    await client.query(corpo(ler(POS)));
  });
});

test('112: corrida real entre duas conexões com o mesmo CNPJ na mesma empresa — uma vence, a outra recebe 23505', { skip: !opt() }, async () => {
  // Aplicada com COMMIT neste banco de trabalho da suíte (restaurado do modelo a cada execução); os testes seguintes
  // partem da 112 aplicada.
  await client.query(ler(UP));
  const e = await empresa();
  const outra = await conectarDescartavel({ travar: false });
  try {
    await client.query('BEGIN');
    await outra.query('BEGIN');
    await client.query(...pj(e));
    const segunda = outra.query(...pj(e));
    await client.query('COMMIT');
    await assert.rejects(segunda, (erro: { code?: string; constraint?: string }) => erro.code === '23505' && erro.constraint === 'clientes_cnpj_empresa_canonico_uk');
    await outra.query('ROLLBACK');
  } finally { await encerrarDescartavel(outra, false); }
  assert.equal((await client.query('SELECT count(*)::int AS n FROM clientes WHERE empresa_id = $1', [e])).rows[0].n, 1);
});

test('112 rollback: recusado SEM efeito com PJ ATIVO, INATIVO ou MESCLADO; aceito sem PJ; precheck volta a passar e a 112 reaplica', { skip: !opt() }, async () => {
  const pjs = (await client.query("SELECT id, status FROM clientes WHERE tipo_pessoa = 'PJ'")).rows;
  assert.ok(pjs.length >= 1, 'a corrida deixou uma PJ');
  // ATIVO
  await downRecusado();
  assert.equal(await colunas112(), 6, 'recusa sem efeito');
  // INATIVO
  await client.query("UPDATE clientes SET status = 'INATIVO' WHERE tipo_pessoa = 'PJ'");
  await downRecusado();
  assert.equal(await colunas112(), 6);
  // MESCLADO (aponta para outra PJ da mesma empresa: mesclagem só entre clientes do mesmo tipo)
  const alvo = pjs[0].id as string;
  const e = (await client.query('SELECT empresa_id::text AS e FROM clientes WHERE id = $1', [alvo])).rows[0].e;
  const principal = (await client.query(...pj(e, { cnpj: CNPJ_ALFA }))).rows[0].id;
  await client.query("UPDATE clientes SET status = 'MESCLADO', cliente_principal_id = $1, mesclado_em = now() WHERE tipo_pessoa = 'PJ' AND id <> $1", [principal]);
  await downRecusado();
  assert.equal(await colunas112(), 6);
  // Sem nenhuma PJ: o rollback passa, as colunas e funções somem, o precheck volta a passar e a 112 reaplica.
  await client.query("DELETE FROM clientes WHERE tipo_pessoa = 'PJ'");
  await client.query(ler(DOWN));
  assert.equal(await colunas112(), 0);
  assert.equal((await client.query(`SELECT to_regprocedure('public.kidmais_112_cnpj_valido(text)') IS NULL AND to_regclass('public.clientes_cnpj_empresa_canonico_uk') IS NULL
    AND to_regprocedure('public.kidmais_112_mesclagem_mesmo_tipo()') IS NULL
    AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname IN ('clientes_112_mesclagem_mesmo_tipo','mesclagens_clientes_112_mesmo_tipo')) AS ok`)).rows[0].ok, true);
  await client.query(ler(PRE));
  await client.query(ler(UP));
  await client.query(ler(POS));
});
