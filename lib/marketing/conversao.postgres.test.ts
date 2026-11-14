import test from 'node:test';
import assert from 'node:assert/strict';
import { conectarDescartavel, encerrarDescartavel } from '../comercial/postgres-descartavel.ts';
import { carregarComBanco, comercial, contratoAssinado, empresa, executor, cliente, fechamento, SENHA_FALSA, cod, vincular } from './harness-postgres.ts';
import type { CriarFechamentoComercialInput, CriarFechamentoComercialResult } from '../fechamentos/services/models.ts';
import type { PainelMarketing } from './metricas.ts';
import type { DbExecutor } from '../db/contracts.ts';

test('conversão automática: criação comercial real, campanha → pedido idempotente → negociação → contrato; seleção e rollback', async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== 'kidmais_pacotes_v1_descartavel') return t.skip('opt-in descartável ausente');
  const c = await conectarDescartavel();
  try {
    await c.query('BEGIN');
    const A = await empresa(c, 'Alfa sintética'), B = await empresa(c, 'Beta sintética');
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('kidmais:agenda-config:' || $1::text, 0))",[A]);
    const base = await comercial(c, A);
    await c.query(`INSERT INTO regras_categoria_horario (dia_semana,configuracao_agenda_id,categoria_horario,vigencia_inicio)
      VALUES (6,$1,'PADRAO','2026-01-01')`,[base.agenda]);
    await c.query(`INSERT INTO regras_disponibilidade_pacote (pacote_id,dia_semana,configuracao_agenda_id,estado,vigencia_inicio)
      VALUES ($1,6,$2,'DISPONIVEL','2026-01-01')`,[base.pacote,base.agenda]);
    const usuario = (await c.query(`INSERT INTO usuarios_administrativos (email,nome,senha_hash,papel,ativo)
      VALUES ($1,'Pessoa sintética',$2,'REPRESENTANTE_AUTORIZADO',true) RETURNING id::text`,[`${cod('u')}@marketing.test`,SENHA_FALSA])).rows[0].id;
    await vincular(c,A,usuario,'REPRESENTANTE_AUTORIZADO');
    const escopo = (await c.query(`INSERT INTO tabela_preco_escopos (tabela_preco_id,pacote_id,categoria_horario,cobertura_continua)
      VALUES ($1,$2,'PADRAO',false) RETURNING id`,[base.tabela,base.pacote])).rows[0].id;
    await c.query('INSERT INTO tabela_preco_escopo_faixas (escopo_id,convidados_min,convidados_max) VALUES ($1,1,NULL)',[escopo]);
    await c.query('UPDATE tabelas_preco SET publicada_em = now() WHERE id = $1', [base.tabela]);
    const cache = new Map();
    const load = <T>(p: string) => carregarComBanco(p, c, () => null, {}, cache) as T;
    const contatos = load<typeof import('./contatos.ts')>('lib/marketing/contatos.ts');
    const campanhas = load<typeof import('./campanhas.ts')>('lib/marketing/campanhas.ts');
    const conversao = load<typeof import('./conversao.ts')>('lib/marketing/conversao.ts');
    const resumo = load<{ painelMarketing: typeof import('./metricas.ts').painelMarketing }>('lib/marketing/metricas.ts');
    const comercialReal = load<{ criarFechamentoComercial(i: CriarFechamentoComercialInput, tx?: unknown): Promise<CriarFechamentoComercialResult> }>('lib/fechamentos/services/fechamento.service.ts');
    const tx = executor(c);
    const campanha = await campanhas.executarAcaoCampanha(tx, A, usuario, {
      acao:'criar', codigo:'teste-conversao', nome:'Campanha sintética', canal:'INSTAGRAM', origemCodigo:'INSTAGRAM',
      inicio:'2026-01-01', utmSource:'instagram', utmMedium:'social',
    });
    const siteServico = load<typeof import('./site/servico.ts')>('lib/marketing/site/servico.ts');
    const site = (await siteServico.criarSite(tx,A,usuario,null,'conversao-sintetica')).id;
    const entrada = {nome:'Nina sintética',telefone:'5511988881234',email:null,dataDesejada:'2027-04-10',convidados:50,mensagem:null,chave:'pedido-conversao-sintetico'};
    const captura = {codigoCampanha:campanha.codigo,utm:{},descartados:[]};
    const recebido = await contatos.capturarContatoPublico(tx, {siteId:site,empresaId:A,estabelecimentoId:null}, entrada, captura);
    const pessoa = (await c.query('SELECT cliente_id::text FROM marketing_contatos WHERE id = $1',[recebido.contatoId])).rows[0].cliente_id;
    const criar = (data: string, clienteId = pessoa) => comercialReal.criarFechamentoComercial({
      clienteId, dataEvento:data,horarioInicio:'14:00',horarioFim:'18:00',configuracaoAgendaId:base.agenda,pacoteId:base.pacote,
      convidados:50,valorProposto:4500,origemFechamento:'ATENDIMENTO_KIDMAIS',
    },tx);
    const painel = (): Promise<PainelMarketing> => resumo.painelMarketing(tx,A,{de:'2020-01-01',ate:'2030-12-31',unidadeId:null});
    await t.test('pedido repetido não duplica; criar negociação converte sem Vincular e contrato aparece no painel', async () => {
      assert.equal((await contatos.capturarContatoPublico(tx,{siteId:site,empresaId:A,estabelecimentoId:null},entrada,captura)).repetido,true);
      const n = await criar('2027-04-10');
      const k = (await c.query('SELECT status, fechamento_id::text FROM marketing_contatos WHERE id=$1',[recebido.contatoId])).rows[0];
      assert.equal(k.status,'CONVERTIDO');
      assert.equal(k.fechamento_id,n.fechamento.id);
      await contratoAssinado(c,n.fechamento.id,4500,null);
      const p = await painel();
      assert.deepEqual([p.total.contatos,p.total.contatosComContrato,p.total.conversao],[1,1,1]);
      assert.deepEqual([p.linhas[0].campanhaId,p.linhas[0].contratos,p.linhas[0].receitaContratadaCentavos],[campanha.id,1,450000]);
      await conversao.vincularContatoAutomaticamente(tx,n.fechamento.id);
      assert.equal((await painel()).total.contatosComContrato,1);
    });
    await t.test('mais recente elegível; descartado intocado; desempate por id; idempotência e empresa', async () => {
      const outra = await cliente(c,B,'B sintético','5511988881234');
      const inserir = async (e: string, p: string, status: string, data: string) => (await c.query(
        `INSERT INTO marketing_contatos (empresa_id, cliente_id, nome, telefone, canal_atendimento, status, recebido_em, chave_idempotencia, vinculo_cliente)
         VALUES ($1,$2,'Sintético','5511988881234','WHATSAPP',$3,$4,gen_random_uuid()::text,'MANUAL') RETURNING id::text`,[e,p,status,data])).rows[0].id;
      const antigo = await inserir(A,pessoa,'NOVO','2026-10-01');
      const empate = await Promise.all(['NOVO','EM_ATENDIMENTO'].map(s=>inserir(A,pessoa,s,'2026-10-02')));
      const recente = [...empate].sort().reverse()[0];
      const descartado = await inserir(A,pessoa,'DESCARTADO','2026-10-03');
      const estrangeiro = await inserir(B,outra,'NOVO','2026-10-04');
      const n = await criar('2027-05-15');
      assert.equal((await c.query('SELECT fechamento_id::text FROM marketing_contatos WHERE id=$1',[recente])).rows[0].fechamento_id,n.fechamento.id);
      await conversao.vincularContatoAutomaticamente(tx,n.fechamento.id);
      const intactos = (await c.query('SELECT id::text,fechamento_id FROM marketing_contatos WHERE id=ANY($1::uuid[])',[[antigo,descartado,estrangeiro,...empate.filter(k=>k!==recente)]])).rows;
      assert.ok(intactos.every(k=>k.fechamento_id===null));
      assert.equal((await c.query('SELECT status FROM marketing_contatos WHERE id=$1',[descartado])).rows[0].status,'DESCARTADO');
    });
    await t.test('rollback desfaz negociação, vínculo e atribuição; histórico antigo permanece manual', async () => {
      await c.query('SAVEPOINT prova_rollback');
      const n = await criar('2027-06-19');
      assert.equal(Number((await c.query('SELECT count(*) AS n FROM marketing_contatos WHERE fechamento_id=$1',[n.fechamento.id])).rows[0].n),1);
      await c.query('ROLLBACK TO SAVEPOINT prova_rollback');
      assert.equal(Number((await c.query('SELECT count(*) AS n FROM fechamentos WHERE id=$1',[n.fechamento.id])).rows[0].n),0);
      const legadoCliente = await cliente(c,A,'Legado sintético',null);
      const legado = await fechamento(c,A,base,legadoCliente,{data:'2027-07-24'});
      await contratoAssinado(c,legado,4500,null);
      assert.equal((await painel()).total.contatosComContrato,1,'não infere vínculos históricos pelo cliente');
    });
    await t.test('vínculo manual mantém CRM_INTERNO e o autor administrativo', async () => {
      const manualCliente = await cliente(c,A,'Manual sintético','5511988889999');
      const manualFechamento = await fechamento(c,A,base,manualCliente,{data:'2027-07-31'});
      const manualContato = await contatos.executarAcaoContato(tx,A,usuario,{
        acao:'registrar',nome:'Manual sintético',telefone:'5511988889999',canal:'WHATSAPP',
        clienteId:manualCliente,chave:'contato-manual-historico',
      });
      await contatos.executarAcaoContato(tx,A,usuario,{acao:'vincular-negociacao',id:manualContato.id,fechamentoId:manualFechamento});
      const eventos = (await c.query("SELECT origem, usuario_id::text FROM eventos_historico_cliente WHERE entidade_id=$1 AND tipo_evento='CONTATO_MARKETING_NEGOCIACAO'",[manualFechamento])).rows;
      assert.deepEqual(eventos,[{origem:'CRM_INTERNO',usuario_id:usuario}]);
    });
    await t.test('caminho público real sem administrador: campanha → cliente comprovado fecha sozinho → conversão no painel', async () => {
      const env = { IDENTIDADE_OTP_PEPPER: 'somente-teste-sintetico-marketing', IDENTIDADE_OTP_PROVIDER: 'console',
        IDENTIDADE_OTP_EMAIL_RESERVA: 'desligado', KIDMAIS_DEPLOY_ENV: 'local' };
      const anteriores = Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));
      Object.assign(process.env,env);
      try {
        const contato = await contatos.capturarContatoPublico(tx,{siteId:site,empresaId:A,estabelecimentoId:null},
          {...entrada,nome:'Cliente público sintético',telefone:'5511988885678',chave:'pedido-publico-sintetico'},captura);
        const pessoaPublica = (await c.query('SELECT cliente_id::text FROM marketing_contatos WHERE id=$1',[contato.contatoId])).rows[0].cliente_id;
        const cpf = '52998224725';
        const dados = {nomeCompleto:'Cliente público sintético',cpf,telefone:'5511988885678',whatsapp:'5511988885678',email:'publico@marketing.test',
          cep:'01001000',logradouro:'Rua Sintética',numero:'1',bairro:'Centro',cidade:'São Paulo',uf:'SP'};
        await c.query(`UPDATE clientes SET cpf=$2,email=$3,cep=$4,logradouro=$5,numero=$6,bairro=$7,cidade=$8,uf=$9 WHERE id=$1`,
          [pessoaPublica,cpf,dados.email,dados.cep,dados.logradouro,dados.numero,dados.bairro,dados.cidade,dados.uf]);
        const identidade = load<typeof import('../identidade/services/index.ts')>('lib/identidade/services/index.ts');
        let codigo = '';
        const emissorSintetico = identidade.criarIdentityServiceComAmbiente(async x=>{codigo=x.codigo;});
        const desafio = await emissorSintetico.iniciarDesafio({cpf,canal:'WHATSAPP',escopo:{empresaId:A,incluirLegadoSemEmpresa:false}},tx);
        const prova = await emissorSintetico.confirmarCodigo({validacaoId:desafio.validacaoId,codigo},tx);
        const publico = load<typeof import('../fechamentos/services/fechamento-publico.service.ts')>('lib/fechamentos/services/fechamento-publico.service.ts');
        const antes = (await painel()).total.contatosComContrato;
        const n = await publico.criarFechamentoPublicoComIdentidade({
          dataEvento:'2027-08-21',horarioInicio:'14:00',horarioFim:'18:00',configuracaoAgendaId:base.agenda,pacoteId:base.pacote,
          convidados:50,valorProposto:4500,empresaEsperada:A,buffetStatus:'PENDENTE',
          identidade:{tipo:'CLIENTE_EXISTENTE',provaToken:prova.provaToken,atualizarCadastro:false},
          cliente:dados,aniversariante:{nome:'Aniversariante sintético'},
        },tx);
        assert.equal(n.fechamento.clienteId,pessoaPublica);
        assert.equal(n.cliente.novo,false);
        assert.equal((await c.query('SELECT iniciado_por_usuario_id FROM fechamentos WHERE id=$1',[n.fechamento.id])).rows[0].iniciado_por_usuario_id,null);
        assert.equal((await c.query('SELECT status FROM marketing_contatos WHERE id=$1',[contato.contatoId])).rows[0].status,'CONVERTIDO');
        const eventos = (await c.query("SELECT origem, usuario_id::text FROM eventos_historico_cliente WHERE entidade_id=$1 AND tipo_evento='CONTATO_MARKETING_NEGOCIACAO'",[n.fechamento.id])).rows;
        assert.deepEqual(eventos,[{origem:'FECHAMENTO_PUBLICO',usuario_id:null}]);
        await contratoAssinado(c,n.fechamento.id,4500,null);
        const p = await painel();
        assert.equal(p.total.contatosComContrato,antes+1);
        assert.equal(p.linhas.find(l=>l.campanhaId===campanha.id)?.contatosComContrato,2);
        assert.equal(p.total.conversao,p.total.contatosComContrato/p.total.contatos);
      } finally { for(const k of Object.keys(env)) { if(anteriores[k]===undefined)delete process.env[k];else process.env[k]=anteriores[k]; } }
    });
    await t.test('falha injetada no vínculo preserva venda, adicionais, escolhas e fotografia; log só tem id e código', async (caso) => {
      const pedido = await contatos.capturarContatoPublico(tx,{siteId:site,empresaId:A,estabelecimentoId:null},
        {...entrada,nome:'Falha sintética',telefone:'5511988887890',chave:'pedido-falha-sintetico'},captura);
      const pessoaFalha = (await c.query('SELECT cliente_id::text FROM marketing_contatos WHERE id=$1',[pedido.contatoId])).rows[0].cliente_id;
      const contatoAntes = (await c.query('SELECT * FROM marketing_contatos WHERE id=$1',[pedido.contatoId])).rows[0];
      const categoriaCodigo = cod('cat');
      const cat = (await c.query("INSERT INTO adicional_categorias(codigo,nome) VALUES($1,'Categoria sintética') RETURNING id",[categoriaCodigo])).rows[0].id;
      const buffet = (await c.query("INSERT INTO buffet_categorias(empresa_id,codigo,nome) VALUES($1,$2,'Sabores sintéticos') RETURNING id",[A,cod('bf')])).rows[0].id;
      const sabor = (await c.query("INSERT INTO buffet_itens(empresa_id,categoria_id,codigo,nome) VALUES($1,$2,$3,'Sabor sintético') RETURNING id",[A,buffet,cod('it')])).rows[0].id;
      const adicionalCodigo = cod('EXTRA').toUpperCase();
      const adicional = (await c.query(`INSERT INTO adicionais(empresa_id,codigo,nome,categoria,categoria_id,unidade_cobranca,ordem_exibicao,origem_buffet_categoria_id,escolhas_max)
        VALUES($1,$2,'Extra sintético',$3,$4,'PACOTE',1,$5,1) RETURNING id`,[A,adicionalCodigo,categoriaCodigo,cat,buffet])).rows[0].id;
      await c.query("INSERT INTO pacote_adicionais(pacote_id,adicional_id,modalidade) VALUES($1,$2,'EXTRA')",[base.pacote,adicional]);
      await c.query('INSERT INTO precos_adicional(tabela_preco_id,adicional_id,convidados_min,valor) VALUES($1,$2,1,25)',[base.tabela,adicional]);
      await c.query(`CREATE FUNCTION pg_temp.falha_vinculo_marketing() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.tipo_evento = 'CONTATO_MARKETING_NEGOCIACAO' THEN
          RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='Nome Sintético / privado@marketing.test / 5511988887890';
        END IF; RETURN NEW; END $$`);
      await c.query('CREATE TRIGGER teste_falha_vinculo_marketing BEFORE INSERT ON eventos_historico_cliente FOR EACH ROW EXECUTE FUNCTION pg_temp.falha_vinculo_marketing()');
      const logs = caso.mock.method(console,'error',()=>{});
      try {
        let n: CriarFechamentoComercialResult | undefined, falhou = false;
        try {
          // Sem customDb: passa pela transação real do serviço, representada pelo SAVEPOINT do harness.
          n = await comercialReal.criarFechamentoComercial({clienteId:pessoaFalha,dataEvento:'2027-09-18',horarioInicio:'14:00',horarioFim:'18:00',
            configuracaoAgendaId:base.agenda,pacoteId:base.pacote,convidados:50,valorProposto:4525,origemFechamento:'ATENDIMENTO_KIDMAIS',
            adicionais:[{codigo:adicionalCodigo,quantidade:1,escolhas:[sabor]}]});
        } catch { falhou = true; }
        if(falhou) {
          const gravadas = Number((await c.query('SELECT count(*) FROM fechamentos WHERE cliente_id=$1',[pessoaFalha])).rows[0].count);
          caso.diagnostic(`Código anterior: falha do vínculo desfez a venda; negociações gravadas = ${gravadas}`);
          assert.equal(gravadas,0);
        }
        assert.equal(falhou,false,'A falha do Marketing não pode impedir a criação da negociação');
        assert.ok(n);
        assert.deepEqual((await c.query('SELECT * FROM marketing_contatos WHERE id=$1',[pedido.contatoId])).rows[0],contatoAntes);
        assert.equal(Number((await c.query("SELECT count(*) FROM marketing_atribuicoes WHERE alvo_tipo='FECHAMENTO' AND alvo_id=$1",[n.fechamento.id])).rows[0].count),0);
        assert.equal(Number((await c.query("SELECT count(*) FROM eventos_historico_cliente WHERE entidade_id=$1 AND tipo_evento='CONTATO_MARKETING_NEGOCIACAO'",[n.fechamento.id])).rows[0].count),0);
        const extra = (await c.query('SELECT observacoes,valor_total FROM fechamento_adicionais WHERE fechamento_id=$1',[n.fechamento.id])).rows[0];
        assert.equal(extra.observacoes,'Escolhas: Sabor sintético');
        assert.equal(Number(extra.valor_total),25);
        assert.equal(Number((await c.query('SELECT count(*) FROM fechamento_pacote_snapshots WHERE fechamento_id=$1',[n.fechamento.id])).rows[0].count),1);
        assert.equal((await c.query('SELECT 1 AS valido')).rows[0].valido,1,'transação continua utilizável');
        assert.deepEqual(logs.mock.calls.map(l=>l.arguments),[['[Marketing] vínculo automático não concluído',{fechamentoId:n.fechamento.id,codigo:'P0001'}]]);
      } finally { await c.query('DROP TRIGGER teste_falha_vinculo_marketing ON eventos_historico_cliente'); }
    });
    await t.test('erro de serialização é recuperado e propagado para o dono da transação, sem log de vínculo', async (caso) => {
      const logs = caso.mock.method(console,'error',()=>{});
      const interceptado: DbExecutor = { async query<T extends object = Record<string, unknown>>(sql: string, valores?: readonly unknown[]) {
        if(sql.includes("SELECT to_regclass('public.marketing_contatos')")) {
          await c.query("DO $$ BEGIN RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='falha sintética de serialização'; END $$");
        }
        return tx.query<T>(sql,valores);
      } };
      await assert.rejects(conversao.vincularContatoAutomaticamente(interceptado,'00000000-0000-4000-8000-000000000001'),{code:'40001'});
      assert.equal((await c.query('SELECT 1 AS valido')).rows[0].valido,1);
      assert.equal(logs.mock.callCount(),0);
    });
    await t.test('transação já abortada antes do Marketing não é engolida nem registrada como falha do vínculo', async (caso) => {
      const logs = caso.mock.method(console,'error',()=>{});
      await c.query('SAVEPOINT teste_transacao_abortada');
      try {
        await assert.rejects(c.query('SELECT 1/0'),{code:'22012'});
        await assert.rejects(conversao.vincularContatoAutomaticamente(tx,'00000000-0000-4000-8000-000000000001'),{code:'25P02'});
        assert.equal(logs.mock.callCount(),0);
      } finally { await c.query('ROLLBACK TO SAVEPOINT teste_transacao_abortada'); await c.query('RELEASE SAVEPOINT teste_transacao_abortada'); }
    });
  } finally { await encerrarDescartavel(c); }
});
