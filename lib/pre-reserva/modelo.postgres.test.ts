import { garantiaAte } from './politica.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { conectarDescartavel, encerrarDescartavel } from '../comercial/postgres-descartavel.ts';
import { carregarComBanco, cliente, comercial, executor, fechamento } from '../marketing/harness-postgres.ts';
import { cenario, representante } from '../../scripts/integracao-importados-test-support.ts';
import { travarConfiguracaoAgenda } from '../agenda/trava-configuracao.ts';

test('migration A sobre a 128, isolamento, transferência concorrente e expiração na leitura', async () => {
  const db = await conectarDescartavel();
  const segunda = await conectarDescartavel({ travar: false });
  try {
    for (const arquivo of ['checks/20261120_130_precheck', 'migrations/20261120_130_pre_reserva_manual', 'checks/20261120_130_postcheck'])
      await db.query(readFileSync('database/' + arquivo + '.sql', 'utf8'));
    const postcheck = readFileSync('database/checks/20261120_130_postcheck.sql','utf8');
    await db.query('BEGIN');
    const pecas = (await db.query<{nome:string; ddl:string}>(`
      SELECT conname AS nome, format('ALTER TABLE %s DROP CONSTRAINT %I CASCADE',conrelid::regclass,conname) AS ddl
      FROM pg_constraint WHERE conrelid IN ('pre_reserva_configuracoes'::regclass,'pre_reserva_aceites'::regclass,
        'pre_reserva_recebimentos'::regclass) AND contype IN ('c','f','p','u')
      UNION ALL SELECT tgname, format('DROP TRIGGER %I ON %s',tgname,tgrelid::regclass) FROM pg_trigger
      WHERE tgrelid IN ('pre_reserva_aceites'::regclass,'pre_reserva_recebimentos'::regclass) AND NOT tgisinternal
      UNION ALL SELECT indexname, format('DROP INDEX %I CASCADE',indexname) FROM pg_indexes WHERE schemaname='public'
      AND indexname IN ('pre_reserva_um_sinal_por_pedido','pre_reserva_pendencias_por_empresa',
        'pre_reserva_contrato_pedido','pre_reserva_fechamento_titular')`)).rows;
    pecas.push({nome:'visão ausente',ddl:'DROP VIEW pre_reserva_situacoes'},
      {nome:'definição da visão',ddl:'CREATE OR REPLACE VIEW pre_reserva_situacoes AS '+
        (await db.query("SELECT pg_get_viewdef('pre_reserva_situacoes'::regclass) AS def")).rows[0].def.replace("'ATIVA'","'EXPIRADA'")},
      {nome:'CHECK trocado',ddl:'ALTER TABLE pre_reserva_configuracoes DROP CONSTRAINT pre_reserva_configuracoes_versao_check, ADD CONSTRAINT pre_reserva_configuracoes_versao_check CHECK (versao >= 0)'},
      {nome:'lista antiga de encerramentos',ddl:"ALTER TABLE pre_reserva_recebimentos DROP CONSTRAINT pre_reserva_recebimentos_encerramento_check, ADD CONSTRAINT pre_reserva_recebimentos_encerramento_check CHECK (encerramento IN ('DESISTENCIA','RECUSA','FORMALIZACAO'))"},
      {nome:'crédito limitado à vigência',ddl:"ALTER TABLE pre_reserva_recebimentos DROP CONSTRAINT pre_reserva_recebimentos_check6, ADD CONSTRAINT pre_reserva_recebimentos_check6 CHECK (contrato_id IS NULL OR (encerrado_em < garantia_ate AND devolucao_assumida_em IS NULL))"},
      {nome:'corpo do gatilho sem proteção',ddl:"CREATE OR REPLACE FUNCTION pre_reserva_preservar_movimento() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$"},
      {nome:'coluna de reversão com default',ddl:'ALTER TABLE pre_reserva_recebimentos ALTER COLUMN credito_revertido_em SET DEFAULT now()'},
      {nome:'motivo de reversão obrigatório antes da reversão',ddl:'ALTER TABLE pre_reserva_recebimentos ALTER COLUMN credito_reversao_motivo SET NOT NULL'},
      {nome:'autor da baixa com default',ddl:'ALTER TABLE pre_reserva_recebimentos ALTER COLUMN devolvido_por SET DEFAULT gen_random_uuid()'},
      {nome:'visão sem motivo e autor',ddl:'DROP VIEW pre_reserva_situacoes; CREATE VIEW pre_reserva_situacoes WITH (security_invoker=true) AS '+
        (await db.query("SELECT pg_get_viewdef('pre_reserva_situacoes'::regclass,true) AS def")).rows[0].def.replace(',\n    credito_reversao_motivo,\n    devolvido_por','')},
      {nome:'CHECK antigo da baixa',ddl:'ALTER TABLE pre_reserva_recebimentos DROP CONSTRAINT pre_reserva_recebimentos_check9, ADD CONSTRAINT pre_reserva_recebimentos_check9 CHECK ((devolvido_em IS NULL) = (referencia_devolucao IS NULL))'},
      {nome:'gatilho desligado',ddl:'ALTER TABLE pre_reserva_recebimentos DISABLE TRIGGER pre_reserva_movimento_historico'},
      {nome:'índice com predicado trocado',ddl:'DROP INDEX pre_reserva_um_sinal_por_pedido; CREATE UNIQUE INDEX pre_reserva_um_sinal_por_pedido ON pre_reserva_recebimentos(empresa_id,fechamento_id) WHERE sinal_garantido_centavos IS NULL'});
    for (const {nome,ddl} of pecas) {
      await db.query('SAVEPOINT defeito');
      await db.query(ddl);
      await assert.rejects(db.query(postcheck),/130: peça ausente ou divergente/,nome);
      await db.query('ROLLBACK TO SAVEPOINT defeito');
    }
    await db.query(postcheck);
    await db.query('COMMIT');
    assert.equal((await db.query('SELECT 1 FROM pre_reserva_configuracoes')).rowCount, 0);
    await db.query('BEGIN');
    const a = await cenario(db, 0);
    const b = await cenario(db, 0);
    const gestor = await representante(db, a);
    const gestorB = await representante(db, b);
    const sessao = { autenticado_em: new Date().toISOString() };
    type Config = { habilitada: boolean; sinalCentavos: number; versao: number };
    const servico = carregarComBanco('lib/pre-reserva/configuracao.ts', db, () => sessao) as {
      configuracaoPreReserva: (tx:ReturnType<typeof executor>, tenant:typeof gestor)=>Promise<Config>;
      salvarConfiguracaoPreReserva: (tx:ReturnType<typeof executor>, tenant:typeof gestor, s:typeof sessao, d:Config)=>Promise<Config>;
    };
    const tx = executor(db);
    const padrao = {habilitada:false,sinalCentavos:10000,versao:0};
    assert.deepEqual(await servico.configuracaoPreReserva(tx,gestor),padrao);
    await db.query("INSERT INTO empresa_pix_recebimento(empresa_id,tipo_chave,chave,nome_recebedor,cidade_recebedor,atualizado_por) VALUES($1,'EMAIL','pix@example.test','Buffet','Brasilia',$2)",[a.empresa,gestor.usuarioId]);
    const ativa = await servico.salvarConfiguracaoPreReserva(tx,gestor,sessao,{...padrao,habilitada:true});
    await db.query(postcheck);
    assert.deepEqual(ativa,{...padrao,habilitada:true,versao:1});
    assert.deepEqual(await servico.configuracaoPreReserva(tx,gestorB),padrao);
    assert.equal((await db.query("SELECT 1 FROM auditoria WHERE acao='PRE_RESERVA_CONFIGURADA' AND entidade_id=$1 AND usuario_id=$2",[a.empresa,gestor.usuarioId])).rowCount,1);
    const titular = await cliente(db, a.empresa, 'Titular sintético', null);
    const outro = await cliente(db, b.empresa, 'Outro titular sintético', null);
    const base = await comercial(db, a.empresa);
    await travarConfiguracaoAgenda(executor(db), a.empresa, {modo:'COMPARTILHADA',linha:'KEY_SHARE'});
    const pedido = await fechamento(db, a.empresa, base, titular, {data:'2028-08-01',status:'AGUARDANDO_CONTRATO'});
    const segundoPedido = await fechamento(db,a.empresa,base,titular,{data:'2028-08-02',status:'AGUARDANDO_CONTRATO'});
    await db.query('COMMIT');

    const aceite = `INSERT INTO pre_reserva_aceites(empresa_id, fechamento_id, cliente_id, inicio_evento, fim_evento,
      preco_aceito_centavos, sinal_centavos, recebedor, chave_pix, termos_versao, termos_aceitos)
      VALUES($1,$2,$3,'2028-08-01 18:00Z','2028-08-01 21:00Z',25000,$4,'Recebedor sintético','pix@example.test','1','Termos sintéticos')`;
    await assert.rejects(db.query(aceite,[b.empresa,pedido,outro,10000]),{code:'23503'});
    await assert.rejects(db.query(aceite,[a.empresa,pedido,outro,10000]),{code:'23503'});
    await db.query(aceite,[a.empresa,pedido,titular,8000]);
    await db.query(aceite,[a.empresa,pedido,titular,10000]);
    assert.deepEqual((await db.query('SELECT sequencia,sinal_centavos FROM pre_reserva_aceites WHERE fechamento_id=$1 ORDER BY sequencia',[pedido])).rows,
      [{sequencia:1,sinal_centavos:8000},{sequencia:2,sinal_centavos:10000}]);
    for (const sql of ['UPDATE pre_reserva_aceites SET sinal_centavos=7000', 'DELETE FROM pre_reserva_aceites'])
      await assert.rejects(db.query(sql+' WHERE fechamento_id=$1',[pedido]),{code:'23514'});
    const inserir = `INSERT INTO pre_reserva_recebimentos(empresa_id, fechamento_id, end_to_end_id, valor_centavos,
      confirmado_por, confirmado_em, sinal_garantido_centavos, garantia_ate) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`;
    const referencia = 'E12345678202611201234Ab123456789';
    const agora = new Date();
    const valores = [a.empresa,pedido,referencia,10000,gestor.usuarioId,agora,10000,garantiaAte(agora)];
    await assert.rejects(db.query(inserir,[...valores.slice(0,4),b.usuario,agora,10000,garantiaAte(agora)]),{code:'23503'});
    await assert.rejects(db.query(inserir,[...valores.slice(0,3),9000,gestor.usuarioId,agora,10000,garantiaAte(agora)]),{code:'23514'});
    await assert.rejects(db.query(inserir,[a.empresa,pedido,referencia,8000,gestor.usuarioId,agora,8000,garantiaAte(agora)]),{code:'23503'});
    const resultados = await Promise.allSettled([db.query(inserir,valores),segunda.query(inserir,valores)]);
    assert.equal(resultados.filter(x=>x.status === 'fulfilled').length,1);
    assert.equal(resultados.find(x=>x.status === 'rejected')?.reason.code,'23505');
    await assert.rejects(db.query(aceite,[a.empresa,pedido,titular,12000]),{code:'23514'});
    assert.equal((await db.query('SELECT aceite_sequencia FROM pre_reserva_recebimentos WHERE end_to_end_id=$1',[referencia])).rows[0].aceite_sequencia,2);
    for (const sql of ["UPDATE pre_reserva_recebimentos SET garantia_ate=garantia_ate + interval '1 minute'",
      'UPDATE pre_reserva_recebimentos SET aceite_sequencia=1','DELETE FROM pre_reserva_recebimentos'])
      await assert.rejects(db.query(sql+' WHERE end_to_end_id=$1',[referencia]),{code:'23514'});
    const situacao = async () => (await db.query('SELECT garantia,dinheiro FROM pre_reserva_situacoes WHERE empresa_id=$1 AND end_to_end_id=$2',[a.empresa,referencia])).rows[0];
    assert.deepEqual(await situacao(),{garantia:'ATIVA',dinheiro:'EM_GARANTIA'});
    const assumir = 'UPDATE pre_reserva_recebimentos SET devolucao_assumida_por=$2,devolucao_assumida_em=clock_timestamp() WHERE end_to_end_id=$1';
    await assert.rejects(db.query(assumir,[referencia,gestor.usuarioId]),{code:'23514'});
    const refExtra = referencia.slice(0,-1)+'X';
    await db.query(inserir,[a.empresa,pedido,refExtra,10000,gestor.usuarioId,agora,null,null]);
    assert.equal((await db.query('SELECT dinheiro FROM pre_reserva_situacoes WHERE end_to_end_id=$1',[refExtra])).rows[0].dinheiro,'A_DEVOLVER');

    await db.query(aceite,[a.empresa,segundoPedido,titular,10000]);
    await assert.rejects(db.query(inserir,[a.empresa,segundoPedido,referencia,10000,gestor.usuarioId,agora,null,null]),{code:'23505'});
    const vencida = referencia.slice(0,-1)+'V';
    await db.query(inserir,[a.empresa,segundoPedido,vencida,10000,gestor.usuarioId,new Date(agora.getTime()-3600000),10000,agora]);
    const fim = await db.query('SELECT garantia,dinheiro,status FROM pre_reserva_situacoes JOIN fechamentos ON id=fechamento_id WHERE end_to_end_id=$1',[vencida]);
    assert.deepEqual(fim.rows[0],{garantia:'EXPIRADA',dinheiro:'A_DEVOLVER',status:'AGUARDANDO_CONTRATO'});
    await db.query(assumir,[vencida,gestor.usuarioId]);
    await db.query("UPDATE pre_reserva_recebimentos SET devolvido_em=clock_timestamp(),devolvido_por=$2,referencia_devolucao='devolucao-sintetica' WHERE end_to_end_id=$1",[vencida,gestor.usuarioId]);
    assert.equal((await db.query('SELECT dinheiro FROM pre_reserva_situacoes WHERE end_to_end_id=$1',[vencida])).rows[0].dinheiro,'DEVOLVIDO');
  } finally {
    await encerrarDescartavel(segunda);
    await encerrarDescartavel(db);
  }
});
