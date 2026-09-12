/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const { Client } = require('pg');

function urlHomologacao() {
  const raw = process.env.KIDMAIS_HOMOLOGACAO_DATABASE_URL;
  if (!raw) throw new Error('KIDMAIS_HOMOLOGACAO_DATABASE_URL é obrigatória.');
  const url = new URL(raw);
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
      || url.pathname !== '/kidmais_v1_homologacao'
      || /kidmais_manager/i.test(raw)) {
    throw new Error('Teste 018 recusado: use somente kidmais_v1_homologacao local.');
  }
  return raw;
}

async function falhaRestricao(client, sql, params = []) {
  await client.query('SAVEPOINT whatsapp_018_espera_falha');
  try {
    await client.query(sql, params);
    assert.fail('A operação incompatível deveria ter sido recusada.');
  } catch (error) {
    assert.match(String(error.code), /23505|23514/);
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT whatsapp_018_espera_falha');
    await client.query('RELEASE SAVEPOINT whatsapp_018_espera_falha');
  }
}

async function main() {
  const connectionString = urlHomologacao();
  const a = new Client({ connectionString });
  const b = new Client({ connectionString });
  await Promise.all([a.connect(), b.connect()]);
  try {
    const antes = (await a.query(`SELECT
      (SELECT count(*)::int FROM whatsapp_conexoes) conexoes,
      (SELECT count(*)::int FROM whatsapp_onboarding_tentativas) tentativas,
      (SELECT count(*)::int FROM usuarios_administrativos) usuarios`)).rows[0];
    assert.deepEqual(antes, { conexoes: 0, tentativas: 0, usuarios: 0 });
    await a.query('BEGIN');
    const hash = `scrypt$v=1$N=131072$r=8$p=1$${'A'.repeat(22)}==$${'B'.repeat(86)}==`;
    const usuario = (await a.query(`INSERT INTO usuarios_administrativos(email,nome,senha_hash,papel)
      VALUES ('whatsapp.018@example.invalid','Usuário Sintético WhatsApp',$1,'REPRESENTANTE_AUTORIZADO') RETURNING id`, [hash])).rows[0];
    const tentativa = (await a.query(`INSERT INTO whatsapp_onboarding_tentativas
      (ambiente,usuario_id,sessao_referencia_id,state_hash,expira_em)
      VALUES ('STAGING',$1,gen_random_uuid(),digest('state-018','sha256'),clock_timestamp()+interval '10 minutes') RETURNING id`, [usuario.id])).rows[0];
    await falhaRestricao(a, `INSERT INTO whatsapp_onboarding_tentativas
      (ambiente,usuario_id,sessao_referencia_id,state_hash,expira_em)
      VALUES ('STAGING',$1,gen_random_uuid(),digest('outro-state-018','sha256'),clock_timestamp()+interval '10 minutes')`, [usuario.id]);
    await a.query(`UPDATE whatsapp_onboarding_tentativas SET status='VALIDANDO',consumida_em=clock_timestamp(),atualizada_em=clock_timestamp() WHERE id=$1`, [tentativa.id]);
    await falhaRestricao(a, `UPDATE whatsapp_onboarding_tentativas SET status='INICIADA',atualizada_em=clock_timestamp() WHERE id=$1`, [tentativa.id]);
    await a.query(`UPDATE whatsapp_onboarding_tentativas SET status='EXPIRADA',erro_codigo='TENTATIVA_EXPIRADA',atualizada_em=clock_timestamp() WHERE id=$1`, [tentativa.id]);
    await falhaRestricao(a, `UPDATE whatsapp_onboarding_tentativas SET erro_codigo='ALTERACAO_INDEVIDA',atualizada_em=clock_timestamp() WHERE id=$1`, [tentativa.id]);

    const conexao = (await a.query(`WITH instante AS (SELECT clock_timestamp() AS agora)
      INSERT INTO whatsapp_conexoes
      (ambiente,meta_app_id,business_id,waba_id,phone_number_id,numero_exibicao,nome_verificado,
       coexistencia_confirmada,escopos,credencial_cifrada,credencial_iv,credencial_tag,
       credencial_chave_versao,token_tipo,meta_validada_em,criada_por_usuario_id,sessao_referencia_id,
       criada_em,atualizada_em)
      SELECT 'STAGING','1','2','3','4','+55 11 0000-0000','Demo',true,
       ARRAY['whatsapp_business_management','whatsapp_business_messaging'],
       decode('010203','hex'),decode('000000000000000000000000','hex'),
       decode('00000000000000000000000000000000','hex'),1,'bearer',agora,$1,gen_random_uuid(),agora,agora
      FROM instante
      RETURNING id`, [usuario.id])).rows[0];
    await falhaRestricao(a, `INSERT INTO whatsapp_conexoes
      (ambiente,meta_app_id,business_id,waba_id,phone_number_id,numero_exibicao,nome_verificado,
       coexistencia_confirmada,escopos,credencial_cifrada,credencial_iv,credencial_tag,
       credencial_chave_versao,token_tipo,meta_validada_em,criada_por_usuario_id,sessao_referencia_id)
      SELECT ambiente,'9','8','7','6','+55 11 0000-0001','Outro',true,escopos,
       credencial_cifrada,credencial_iv,credencial_tag,1,'bearer',clock_timestamp(),$1,gen_random_uuid()
      FROM whatsapp_conexoes WHERE id=$2`, [usuario.id, conexao.id]);
    await falhaRestricao(a, `UPDATE whatsapp_conexoes SET phone_number_id='99',revisao=revisao+1,atualizada_em=clock_timestamp() WHERE id=$1`, [conexao.id]);

    await b.query('BEGIN');
    const lockLivre = (await a.query(`SELECT pg_try_advisory_xact_lock(hashtextextended('KIDMAIS_WHATSAPP_STAGING',0)) AS ok`)).rows[0].ok;
    const lockConcorrente = (await b.query(`SELECT pg_try_advisory_xact_lock(hashtextextended('KIDMAIS_WHATSAPP_STAGING',0)) AS ok`)).rows[0].ok;
    assert.equal(lockLivre, true);
    assert.equal(lockConcorrente, false);
    await b.query('ROLLBACK');
    await a.query('ROLLBACK');

    const depois = (await a.query(`SELECT
      (SELECT count(*)::int FROM whatsapp_conexoes) conexoes,
      (SELECT count(*)::int FROM whatsapp_onboarding_tentativas) tentativas,
      (SELECT count(*)::int FROM usuarios_administrativos) usuarios`)).rows[0];
    assert.deepEqual(depois, antes);
    console.log('PASS WhatsApp 018: constraints, one-time, conexão única, lock concorrente e rollback.');
  } finally {
    await Promise.allSettled([a.query('ROLLBACK'), b.query('ROLLBACK')]);
    await Promise.allSettled([a.end(), b.end()]);
  }
}

main().catch((error) => { console.error('[WhatsApp 018]', error.message); process.exitCode = 1; });
