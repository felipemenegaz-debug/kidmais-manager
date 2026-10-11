/* eslint-disable @typescript-eslint/no-require-imports */
// P0b SOMENTE LEITURA; autossuficiente para executar antes do deploy. Sem .env, HTTP ou escrita SQL.
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const ALVO=Object.freeze({"servico":"srv-dak77m2d0e5s73b8rkkg","host":"dpg-dak750gae00c73fudmg0-a","database":"kidmais_production","port":5432});
const ETAPAS=Object.freeze([
  {
    "nome": "bloqueios e copias",
    "arquivo": "database/checks/20261011_lancamento_production_preflight.sql",
    "sha256": "5f3af3919f9012b7d7aea8b458513f44311c680c4ecdf40f9219b9201706d687",
    "sql": "-- PREPARADO, NAO EXECUTADO. P0b: leitura delimitada para revisar bloqueios e copias da 078.\nBEGIN TRANSACTION READ ONLY;\nSET LOCAL statement_timeout = '10s';\nSET LOCAL lock_timeout = '3s';\nSET LOCAL search_path = public, pg_catalog;\nDO $$ BEGIN\n  IF current_database() <> 'kidmais_production' THEN RAISE EXCEPTION 'BANCO_RECUSADO'; END IF;\n  IF (SELECT count(*) FROM empresas WHERE codigo='kidmais' AND id='7e990a2b-e64b-4630-9aae-4646fe936ede' AND status='ATIVA') <> 1 THEN\n    RAISE EXCEPTION 'IDENTIDADE_KIDMAIS_DIVERGENTE';\n  END IF;\n  IF to_regclass('public.agenda_062_bloqueios_resolucao') IS NULL THEN RAISE EXCEPTION 'BASE_062_AUSENTE'; END IF;\n  IF (SELECT count(*) FROM bloqueios_agenda WHERE ativo AND empresa_id IS NULL AND data>=current_date) > 20 THEN\n    RAISE EXCEPTION 'MAIS_DE_20_BLOQUEIOS_REVISAR_ESCOPO';\n  END IF;\nEND $$;\n-- Nao le motivo, nome/e-mail/ID do autor nem dados de clientes. Vinculo do autor e apenas indicio, nao decisao.\nSELECT b.id AS bloqueio_id, b.data, b.dia_inteiro, b.horario_inicio, b.horario_fim,\n  ARRAY(SELECT DISTINCT e.codigo FROM memberships m JOIN empresas e ON e.id=m.empresa_id\n    WHERE m.usuario_id=b.criado_por_usuario_id ORDER BY e.codigo) AS indicio_empresas_do_autor,\n  e.codigo AS decisao_empresa, r.estabelecimento_id AS decisao_unidade,\n  CASE WHEN r.bloqueio_id IS NULL THEN 'PENDENTE' ELSE 'RESOLVIDO' END AS situacao\nFROM bloqueios_agenda b LEFT JOIN agenda_062_bloqueios_resolucao r ON r.bloqueio_id=b.id\nLEFT JOIN empresas e ON e.id=r.empresa_id\nWHERE b.ativo AND b.empresa_id IS NULL AND b.data>=current_date\nORDER BY b.data, b.horario_inicio NULLS FIRST, b.id;\n-- Mesma origem de uso da consulta revisada no precheck 078; a migration copia somente o que ja e utilizado.\nWITH k AS (SELECT id FROM empresas WHERE codigo='kidmais'), uso AS (\n  SELECT p.empresa_id, pbc.categoria_id FROM pacote_buffet_categorias pbc JOIN pacotes p ON p.id=pbc.pacote_id\n  UNION SELECT p.empresa_id, i.categoria_id FROM pacote_itens_especificos pe JOIN pacotes p ON p.id=pe.pacote_id JOIN buffet_itens i ON i.id=pe.item_id\n  UNION SELECT a.empresa_id, a.origem_buffet_categoria_id FROM adicionais a WHERE a.origem_buffet_categoria_id IS NOT NULL\n  UNION SELECT a.empresa_id, i.categoria_id FROM adicionais a JOIN buffet_itens i ON i.id=a.origem_buffet_item_id\n)\nSELECT e.codigo AS empresa_que_recebe_copia,\n  count(DISTINCT uso.categoria_id) FILTER (WHERE uso.categoria_id IS NOT NULL) AS categorias_usadas,\n  bool_or(uso.categoria_id IS NULL) AS usa_item_sem_categoria\nFROM uso JOIN empresas e ON e.id=uso.empresa_id\nWHERE uso.empresa_id IS DISTINCT FROM (SELECT id FROM k)\nGROUP BY e.codigo ORDER BY e.codigo;\nROLLBACK;\n"
  },
  {
    "nome": "074a",
    "arquivo": "database/checks/20261009_074a_precheck.sql",
    "sha256": "d90bd9ec4a47a69de22480637842f70221f78507893009a7f1aca56becf746aa",
    "sql": "-- 074 precheck PREPARADO, NÃO EXECUTADO. Somente leitura; não mostra dados de clientes.\nBEGIN TRANSACTION READ ONLY;\nSET LOCAL search_path = public, pg_catalog;\nDO $$ BEGIN\n  IF to_regclass('public.empresa_assinaturas') IS NULL\n     OR to_regclass('public.cobranca_eventos') IS NULL\n     OR to_regclass('public.plataforma_empresas_cadastro') IS NULL THEN\n    RAISE EXCEPTION '074 precheck: modelo comercial/cobrança/cadastro ausentes.';\n  END IF;\n  IF to_regclass('public.assinatura_isencoes') IS NOT NULL\n     OR to_regclass('public.assinatura_fundadores') IS NOT NULL\n     OR to_regclass('public.assinatura_contratacoes') IS NOT NULL\n     OR to_regprocedure('public.kidmais_074_registro_guarda()') IS NOT NULL\n     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'empresa_assinaturas' AND column_name = 'contratacao_atual_id') THEN\n    RAISE EXCEPTION '074 precheck: instalação total ou parcial já existe.';\n  END IF;\n  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.empresa_assinaturas'::regclass\n       AND tgname = 'empresa_assinaturas_068_guarda_trg' AND NOT tgisinternal AND tgenabled = 'O')\n     OR to_regprocedure('public.kidmais_068_assinatura_guarda()') IS NULL THEN\n    RAISE EXCEPTION '074 precheck: guarda 068 ausente/desativada.';\n  END IF;\n  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.empresa_assinaturas'::regclass\n       AND conname = 'empresa_assinaturas_plano_check' AND convalidated)\n     OR EXISTS (SELECT 1 FROM empresa_assinaturas WHERE plano <> 'UNICO') THEN\n    RAISE EXCEPTION '074 precheck: plano legado divergiu; revisar antes de aplicar.';\n  END IF;\n  IF (SELECT md5(regexp_replace(prosrc, '[[:space:]]', '', 'g')) FROM pg_proc\n      WHERE oid = 'public.kidmais_068_assinatura_guarda()'::regprocedure)\n      IS DISTINCT FROM '6587469604572b17146a1346a8c01c47' THEN\n    RAISE EXCEPTION '074 precheck: definição da guarda divergiu da base; revisar o diff da função.';\n  END IF;\n  RAISE NOTICE '074 precheck OK. Não autoriza aplicação nem comprova prontidão do checkout.';\nEND $$;\nROLLBACK;\n"
  },
  {
    "nome": "076",
    "arquivo": "database/checks/20261010_076_precheck.sql",
    "sha256": "0c57d854e02a59e23003463fc9e501d4fec1f2309a6fe91c7a557fa5f52c3392",
    "sql": "-- 076 precheck PREPARADO, NÃO EXECUTADO. Somente leitura; não mostra CPF nem dados de clientes.\nBEGIN TRANSACTION READ ONLY;\nSET LOCAL search_path = public, pg_catalog;\nDO $$ BEGIN\n  IF NOT EXISTS (SELECT 1 FROM information_schema.columns\n       WHERE table_schema = 'public' AND table_name = 'clientes' AND column_name = 'empresa_id') THEN\n    RAISE EXCEPTION '076 precheck: 054 ausente.';\n  END IF;\n  IF to_regclass('public.clientes_cpf_empresa_canonico_uk') IS NOT NULL THEN\n    RAISE EXCEPTION '076 precheck: já aplicada.';\n  END IF;\n  IF to_regclass('public.clientes_cpf_canonico_uk') IS NULL THEN\n    RAISE EXCEPTION '076 precheck: índice global ausente.';\n  END IF;\n  -- Com o índice global vigente não pode haver duplicidade; conferido mesmo assim.\n  IF EXISTS (SELECT 1 FROM clientes WHERE cpf IS NOT NULL AND status <> 'MESCLADO'\n             GROUP BY COALESCE(empresa_id, '00000000-0000-0000-0000-000000000000'::uuid), cpf HAVING count(*) > 1) THEN\n    RAISE EXCEPTION '076 precheck: CPF duplicado na mesma empresa.';\n  END IF;\nEND $$;\nSELECT current_database() AS banco,\n       (SELECT count(*) FROM clientes WHERE cpf IS NOT NULL AND status <> 'MESCLADO') AS clientes_com_cpf,\n       (SELECT count(*) FROM clientes WHERE empresa_id IS NULL AND cpf IS NOT NULL AND status <> 'MESCLADO') AS legado_sem_empresa_com_cpf;\nROLLBACK;\n"
  },
  {
    "nome": "077",
    "arquivo": "database/checks/20261010_077_precheck.sql",
    "sha256": "ab24f9ee4a217f92372d0645a150da77a549d19f495cf7b0826fe25a482b1a21",
    "sql": "-- 077 precheck PREPARADO, NÃO EXECUTADO. Somente leitura.\nBEGIN TRANSACTION READ ONLY;\nSET LOCAL search_path = public, pg_catalog;\nDO $$ BEGIN\n  IF to_regclass('public.empresas') IS NULL THEN\n    RAISE EXCEPTION '077 precheck: empresas ausente.';\n  END IF;\n  IF to_regclass('public.empresa_regras_pagamento') IS NOT NULL THEN\n    RAISE EXCEPTION '077 precheck: já aplicada.';\n  END IF;\nEND $$;\n-- Informativo: a empresa que receberá as regras legadas (deve ser exatamente uma neste banco).\nSELECT current_database() AS banco,\n       (SELECT count(*) FROM empresas WHERE codigo = 'kidmais') AS empresas_kidmais,\n       (SELECT count(*) FROM empresas WHERE codigo = 'kidmais' AND status = 'ATIVA') AS kidmais_ativa;\nROLLBACK;\n"
  },
  {
    "nome": "078",
    "arquivo": "database/checks/20261010_078_precheck.sql",
    "sha256": "51d2845be5c6b234dcc1357fa483743638c786c7005170686461f78e7e7b7d62",
    "sql": "-- 078 precheck PREPARADO, NÃO EXECUTADO. Somente leitura.\nBEGIN TRANSACTION READ ONLY;\nSET LOCAL search_path = public, pg_catalog;\nDO $$ BEGIN\n  IF to_regclass('public.buffet_categorias') IS NULL OR to_regclass('public.pacote_itens_especificos') IS NULL THEN\n    RAISE EXCEPTION '078 precheck: catálogo (021/050) ausente.';\n  END IF;\n  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'buffet_categorias' AND column_name = 'empresa_id') THEN\n    RAISE EXCEPTION '078 precheck: já aplicada.';\n  END IF;\n  IF (SELECT count(*) FROM empresas WHERE codigo = 'kidmais') > 1 THEN\n    RAISE EXCEPTION '078 precheck: mais de uma empresa kidmais.';\n  END IF;\nEND $$;\n-- Informativo: dono do catálogo atual e tamanho dele.\nSELECT current_database() AS banco,\n       (SELECT count(*) FROM empresas WHERE codigo = 'kidmais') AS empresas_kidmais,\n       (SELECT count(*) FROM buffet_categorias) AS categorias, (SELECT count(*) FROM buffet_itens) AS itens;\n-- Informativo: OUTRAS empresas que receberão cópia só do que já usam (pacotes ou adicionais do buffet).\nWITH k AS (SELECT id FROM empresas WHERE codigo = 'kidmais'),\nuso AS (\n  SELECT p.empresa_id, pbc.categoria_id FROM pacote_buffet_categorias pbc JOIN pacotes p ON p.id = pbc.pacote_id\n  UNION SELECT p.empresa_id, i.categoria_id FROM pacote_itens_especificos pe JOIN pacotes p ON p.id = pe.pacote_id JOIN buffet_itens i ON i.id = pe.item_id\n  UNION SELECT a.empresa_id, a.origem_buffet_categoria_id FROM adicionais a WHERE a.origem_buffet_categoria_id IS NOT NULL\n  UNION SELECT a.empresa_id, i.categoria_id FROM adicionais a JOIN buffet_itens i ON i.id = a.origem_buffet_item_id\n)\nSELECT e.codigo AS empresa_que_recebe_copia,\n       count(DISTINCT uso.categoria_id) FILTER (WHERE uso.categoria_id IS NOT NULL) AS categorias_usadas,\n       bool_or(uso.categoria_id IS NULL) AS usa_item_sem_categoria\n  FROM uso JOIN empresas e ON e.id = uso.empresa_id\n WHERE uso.empresa_id IS DISTINCT FROM (SELECT id FROM k)\n GROUP BY e.codigo ORDER BY e.codigo;\n-- Informativo: pacotes SEM empresa (legado) ligados ao catálogo — continuam ligados; mudanças futuras neles são recusadas.\nSELECT count(*) AS pacotes_sem_empresa_com_buffet\n  FROM (SELECT DISTINCT pbc.pacote_id FROM pacote_buffet_categorias pbc JOIN pacotes p ON p.id = pbc.pacote_id WHERE p.empresa_id IS NULL) x;\nROLLBACK;\n"
  },
  {
    "nome": "079",
    "arquivo": "database/checks/20261011_079_precheck.sql",
    "sha256": "50e82cbffd07085f0ef180a5850ed9379b3a89cd4ce1bad020af33645c2ad08c",
    "sql": "-- Somente leitura. Confirma schema de convites e que a 079 ainda não foi aplicada.\nDO $$\nDECLARE definicao text;\n  item record;\nBEGIN\n  IF to_regclass('public.convite_geracoes') IS NULL\n    OR to_regclass('public.convite_consumos') IS NULL\n    OR to_regclass('public.convite_orcamento_global') IS NULL\n    OR to_regclass('public.convites') IS NULL\n    OR to_regclass('public.convite_eventos') IS NULL\n    OR to_regclass('public.usuarios_administrativos') IS NULL THEN\n    RAISE EXCEPTION '079 precheck: schema base de convites/identidade ausente';\n  END IF;\n  SELECT pg_get_constraintdef(oid) INTO definicao FROM pg_constraint\n    WHERE conrelid='public.convite_geracoes'::regclass AND conname='convite_geracoes_estado_check';\n  IF definicao IS NULL OR definicao NOT LIKE '%RESERVADA%' OR definicao NOT LIKE '%CONCLUIDA%' OR definicao NOT LIKE '%INCERTA%' THEN\n    RAISE EXCEPTION '079 precheck: CHECK de estado não corresponde ao schema de convites';\n  END IF;\n  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='convite_geracoes'\n      AND column_name IN ('resolucao_resultado','resolucao_por','resolucao_em','resolucao_evidencia','reserva_microusd'))\n    OR to_regclass('public.convite_geracoes_incertas') IS NOT NULL\n    OR EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.convite_geracoes'::regclass AND conname='convite_geracoes_resolucao_consistente') THEN\n    RAISE EXCEPTION '079 precheck: aplicação anterior ou parcial encontrada';\n  END IF;\n  FOR item IN SELECT * FROM (VALUES\n    ('convite_geracoes','id','uuid'),('convite_geracoes','convite_id','uuid'),('convite_geracoes','empresa_id','uuid'),\n    ('convite_geracoes','ator','text'),('convite_geracoes','payload_hash','text'),('convite_geracoes','estado','text'),('convite_geracoes','criado_em','timestamp with time zone'),\n    ('convites','usado_festa','integer'),('convites','usado_cliente','integer'),\n    ('convite_consumos','empresa_id','uuid'),('convite_consumos','mes','date'),('convite_consumos','usado','integer'),\n    ('convite_orcamento_global','dia','date'),('convite_orcamento_global','reservado_microusd','bigint'),\n    ('convite_eventos','convite_id','uuid'),('convite_eventos','ator','text'),('convite_eventos','acao','text'),('convite_eventos','detalhe','jsonb'),\n    ('usuarios_administrativos','id','uuid')\n  ) AS colunas(tabela,coluna,tipo)\n  LOOP\n    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=item.tabela\n        AND column_name=item.coluna AND data_type=item.tipo) THEN\n      RAISE EXCEPTION '079 precheck: coluna base incompatível: %.%', item.tabela, item.coluna;\n    END IF;\n  END LOOP;\n  RAISE NOTICE '079 precheck OK';\nEND $$;\n"
  }
]);
const FLAG='--preflight-somente-leitura';
function alvo(env) {
    assert.equal(env.RENDER, 'true', 'FORA_DO_RENDER');
    assert.equal(env.RENDER_SERVICE_ID, ALVO.servico, 'SERVICO_RECUSADO');
    assert.equal(env.KIDMAIS_DEPLOY_ENV, 'production', 'AMBIENTE_RECUSADO');
    assert.equal(env.DATABASE_SSL, 'true', 'TLS_OBRIGATORIO');
    const u = new URL(env.DATABASE_URL);
    assert.equal(u.hostname, ALVO.host, 'HOST_RECUSADO');
    assert.equal(decodeURIComponent(u.pathname.slice(1)), ALVO.database, 'BANCO_RECUSADO');
    assert.ok(!u.port || Number(u.port) === ALVO.port, 'PORTA_RECUSADA');
    assert.ok(![...u.searchParams.keys()].some(k => /^ssl/i.test(k)), 'SSL_URL_RECUSADO');
    return { connectionString: u.toString(), connectionTimeoutMillis: 5000,
        ssl: { rejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false', minVersion: 'TLSv1.2' } };
}
function revisar(){for(const e of ETAPAS){assert.equal(createHash('sha256').update(e.sql).digest('hex'),e.sha256,'HASH_DIVERGENTE');assert.ok(!/\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/i.test(e.sql),'SQL_NAO_LEITURA');}}
async function conferir(c){
 const resultado=[];
 try {
   await c.query('BEGIN TRANSACTION READ ONLY');
   const id=(await c.query('SELECT current_database() AS db, (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS tls')).rows[0];
   assert.equal(id.db,ALVO.database,'BANCO_DIVERGENTE'); assert.equal(id.tls,true,'SEM_TLS');
   await c.query('ROLLBACK');
   for(const e of ETAPAS){
     await c.query('BEGIN TRANSACTION READ ONLY');
     await c.query("SET LOCAL statement_timeout='10s'"); await c.query("SET LOCAL lock_timeout='3s'");
     try {const r=await c.query(e.sql);resultado.push({etapa:e.nome,resultado:'PASS',linhas:(Array.isArray(r)?r:[r]).flatMap(x=>x.rows??[])});}
     finally {await c.query('ROLLBACK').catch(()=>{});}
   }
   return {resultado:'PREFLIGHT',etapas:resultado,dependencia075:'Precheck 075 exige 074a aplicada; executar somente no cutover autorizado'};
 }finally{await c.query('ROLLBACK').catch(()=>{});}
}
async function main(){
 assert.deepEqual(process.argv.slice(2),[FLAG],'AGUARDANDO_AUTORIZACAO_P0B'); revisar();
 const c=new(require('pg').Client)({...alvo(process.env),application_name:'kidmais-p0b-somente-leitura'});
 c.on('error',()=>undefined);
 try {await c.connect(); console.log(JSON.stringify(await conferir(c),null,2));}
 finally{await c.end().catch(()=>{});}
}
if(require.main===module)main().catch(e=>{console.error(String(e.message).slice(0,160));process.exitCode=1;});
module.exports={ALVO,ETAPAS,FLAG,alvo,revisar,conferir};
