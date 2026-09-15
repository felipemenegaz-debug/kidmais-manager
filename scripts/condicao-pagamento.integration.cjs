/* eslint-disable @typescript-eslint/no-require-imports -- Integração com serviços TypeScript reais. */
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { randomInt, randomUUID } = require('node:crypto');
const { rollbackTest, ctx, client, fingerprint } = require('./pagamentos-test-support.cjs');
const { closeDatabasePool } = require('../lib/db/postgres.ts');
const { criarFechamentoPublicoComIdentidade } = require('../lib/fechamentos/services/fechamento-publico.service.ts');
const { revisarComercial, obterRevisaoComercial } = require('../lib/fechamentos/services/revisao-comercial.service.ts');
const { gerarContrato } = require('../lib/contratos/services/contrato.service.ts');
const { iniciarDesafioContrato, assinarContratoPublico } = require('../lib/contratos/services/contrato-publico.service.ts');
const { criarIdentityServiceComAmbiente } = require('../lib/identidade/services/identity.service.ts');
const { gerarResumoContratacaoPdfDaVersao } = require('../lib/contratos/services/documento.service.ts');
const { operarContrato } = require('../lib/contratos/services/administrativo.service.ts');
const { documentoParaLeitura } = require('../lib/contratos/services/fluxo-publico.ts');
const { criarPagamentoDoFechamento } = require('../lib/pagamentos/services/pagamento.service.ts');
const { calcularResumoComercial } = require('../lib/comercial/services/index.ts');
const { NextRequest } = require('next/server');
const route = require('../app/api/admin/fechamentos/[fechamentoId]/revisao/route.ts');
const publicRoute = require('../app/api/fechamentos/route.ts');
const { pretensaoPixSchema } = require('../lib/http/condicao-pagamento-schema.ts');
let checks = 0;
function ok(label) { checks++; console.log('OK:', label); }
function cpf() {
  const digits = Array.from({ length: 9 }, () => randomInt(0,10));
  for (const peso of [10,11]) { const resto = digits.reduce((s,d,i)=>s+d*(peso-i),0)*10%11; digits.push(resto===10?0:resto); }
  return digits.join('');
}
async function run(c) {
  process.env.NODE_ENV = 'development';
  process.env.CRM_API_DEV_ENABLED = 'true';
  process.env.CONTRATO_ACEITE_DEV_ENABLED = 'true';
  const extraFingerprint = async () => (await c.query(`SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'' ORDER BY id),'')) AS hash FROM aprovacoes_negociacao t`)).rows[0];
  const extraBefore = await extraFingerprint();
  await c.query('SAVEPOINT escopo_comercial');
  const admin = await require('./admin-test-support.cjs').autenticarTeste(c);
  ctx.usuarioId = admin.usuarioId;
  const config = (await c.query("SELECT id FROM configuracao_agenda WHERE codigo='TURNO_1' LIMIT 1")).rows[0];
  const pacote = (await c.query("SELECT id FROM pacotes WHERE codigo='COMPLETA' LIMIT 1")).rows[0];
  assert.ok(config && pacote);
  const input = {
    dataEvento: '2098-10-11', horarioInicio: '11:00', horarioFim: '15:00', configuracaoAgendaId: config.id,
    pacoteId: pacote.id, convidados: 50, valorProposto: 9290, origemFechamento: 'CLIENTE',
    formaPagamentoPretendida: 'PIX_PARCELADO', condicaoPixPretendida: { entrada: '1000.00', valorParcela: '500.25', quantidadeParcelas: 16 },
    identidade: { tipo: 'NOVO_CLIENTE' }, idadeAniversarianteEvento: 7,
    cliente: { nomeCompleto: 'Teste Comercial Sintético', cpf: cpf(), telefone: '11999998888', whatsapp: '11999998888',
      email: 'teste-comercial@example.invalid', cep: '01001000', logradouro: 'Rua Sintética', numero: '1', bairro: 'Centro', cidade: 'São Paulo', uf: 'SP' },
    aniversariante: { nome: 'Aniversariante Sintético', temaPadrao: 'Teste' },
  };
  const countFinance = async () => (await c.query(`SELECT
    (SELECT count(*) FROM pagamentos) AS pagamentos, (SELECT count(*) FROM pagamento_planos) AS planos,
    (SELECT count(*) FROM pagamento_parcelas) AS parcelas, (SELECT count(*) FROM pagamento_recebimentos) AS recebimentos`)).rows[0];
  const beforeFinance = await countFinance();
  const novo = await criarFechamentoPublicoComIdentidade(input);
  const f = novo.fechamento;
  assert.equal(f.status, 'AGUARDANDO_APROVACAO');
  assert.equal(f.condicaoPagamento.pretendida.parcelaCentavos, 50025);
  assert.equal(f.condicaoPagamento.aprovada, null);
  assert.deepEqual(await countFinance(), beforeFinance);
  ok('Fechamento público persiste proposta parcial sem criar qualquer registro financeiro');
  await assert.rejects(gerarContrato({ fechamentoId: f.id },ctx), { code: 'STATUS_FECHAMENTO_NAO_PERMITE_CONTRATO' });
  ok('Contrato bloqueado antes da revisão');
  const body = { solicitacaoId: novo.aprovacaoNegociacao.id, decisao: 'APROVAR',
    ...(f.valorNegociado !== null ? { valorBaseAprovado: '9290.00' } : {}),
    condicaoAprovada: { entrada: 1500, valorParcela: '751.13', quantidadeParcelas: 10 }, motivo: 'Conferido com cliente sintético' };
  await assert.rejects(revisarComercial(f.id,{...body,condicaoAprovada:null},ctx),{code:'DADOS_INVALIDOS'});
  const primeiraResposta = await route.POST(admin.request('/api/admin/revisao','POST',body),
    {params:Promise.resolve({fechamentoId:f.id})});
  const primeiraDecisao = await primeiraResposta.json();
  assert.equal(primeiraResposta.status,201,JSON.stringify(primeiraDecisao));
  const decisao = primeiraDecisao.data;
  assert.equal(decisao.fechamento.status, 'AGUARDANDO_CONTRATO');
  assert.equal(decisao.fechamento.condicaoPagamento.pretendida.entradaCentavos,100000);
  assert.equal(decisao.fechamento.condicaoPagamento.aprovada.entradaCentavos,150000);
  assert.equal(decisao.decisao.condicaoPagamento.valores.valorFinalContrato,9011.30);
  assert.deepEqual(await countFinance(), beforeFinance);
  ok('Aprovação separada da intenção, base 9290 e final 9011,30, sem plano automático');
  assert.equal((await revisarComercial(f.id, body,ctx)).reutilizada,true);
  await assert.rejects(revisarComercial(f.id,{...body,motivo:'Outra decisão'},ctx),{code:'REVISAO_COMERCIAL_INVALIDA'});
  assert.equal((await obterRevisaoComercial(f.id)).aprovacoes.length,2);
  ok('Decisão idempotente e divergência rejeitada sem duplicar histórico');
  const contrato = await gerarContrato({ fechamentoId:f.id },ctx);
  assert.equal(contrato.versao.snapshot.comercial.valorFinalContrato,9011.30);
  assert.equal(contrato.versao.snapshot.comercial.valorBaseComercial,9290);
  assert.equal(contrato.versao.snapshot.comercial.valorDescontoFormaPagamento,278.70);
  assert.deepEqual(contrato.versao.snapshot.comercial.condicaoPagamento,decisao.fechamento.condicaoPagamento);
  assert.deepEqual(await countFinance(),beforeFinance);
  assert.equal((await gerarContrato({fechamentoId:f.id},ctx)).reutilizado,true);
  ok('Contrato novo congela base, desconto, total, proposta e aprovação; geração repetida reutiliza versão');
  const adminContext={requestId:randomUUID(),ip:null,userAgent:'Teste comercial'};
  const pdfAdmin=await operarContrato(contrato.versao.id,{acao:'gerar_pdf',revisao:1},admin.token,adminContext);
  await operarContrato(contrato.versao.id,{acao:'revisar',revisao:1,documentoId:pdfAdmin.documentoId},admin.token,adminContext);
  await operarContrato(contrato.versao.id,{acao:'assinar',revisao:1,documentoId:pdfAdmin.documentoId,chaveIdempotencia:randomUUID()},admin.token,adminContext);
  await operarContrato(contrato.versao.id,{acao:'liberar',revisao:1},admin.token,adminContext);
  // Serviços reais de desafio, confirmação e assinatura; somente o transporte OTP é simulado.
  let codigoOtp;
  const envioSimulado = async (delivery) => { codigoOtp = delivery.codigo; };
  const desafio = await iniciarDesafioContrato({contratoId:contrato.contrato.id,cpf:input.cliente.cpf,canal:'WHATSAPP'},envioSimulado);
  assert.ok(codigoOtp);
  const prova = await criarIdentityServiceComAmbiente(envioSimulado).confirmarCodigo({validacaoId:desafio.validacaoId,codigo:codigoOtp});
  const documento = await documentoParaLeitura(contrato.versao,c);
  const resumoDocumento = gerarResumoContratacaoPdfDaVersao(contrato.versao);
  assert.match(JSON.stringify(resumoDocumento.documento),/Condição pretendida pelo cliente/);
  assert.match(JSON.stringify(resumoDocumento.documento),/Condição aprovada pela Kidmais/);
  const aceite = {contratoId:contrato.contrato.id,versaoId:contrato.versao.id,snapshotHash:contrato.versao.snapshotHash,
    documentoPdfHash:documento.pdfHash,acessoToken:desafio.acessoToken,provaToken:prova.provaToken};
  const assinado = await assinarContratoPublico(aceite,envioSimulado);
  assert.equal(assinado.contrato.status,'ASSINADO');
  assert.equal(assinado.versao.status,'ASSINADA');
  assert.equal(assinado.fechamentoStatus,'CONTRATO_ASSINADO');
  assert.equal((await assinarContratoPublico(aceite,envioSimulado)).reutilizado,true);
  assert.deepEqual(await countFinance(),beforeFinance);
  ok('Assinatura real por OTP simulado no transporte é idempotente e não cria Pagamento');
  const plano = { meioPagamento:'PIX',modalidade:'PARCELADO',parcelas:[
    {valor:4505.65,vencimento:'2098-09-01',confirmaReserva:true},{valor:4505.65,vencimento:'2098-10-01'}] };
  await assert.rejects(criarPagamentoDoFechamento({fechamentoId:f.id,plano:{...plano,parcelas:[{valor:9290,vencimento:'2098-09-01',confirmaReserva:true}]}},ctx),{code:'PLANO_PAGAMENTO_INVALIDO'});
  assert.deepEqual(await countFinance(),beforeFinance);
  const pagamento = await criarPagamentoDoFechamento({fechamentoId:f.id,plano},ctx);
  assert.equal(pagamento.detalhe.pagamento.valorTotalContratado,9011.30);
  assert.equal(pagamento.detalhe.parcelas.reduce((s,p)=>s+Math.round(p.valorPrevisto*100),0),901130);
  ok('Pagamentos consome o snapshot assinado de 9011,30 e plano soma exatamente esse valor');
  await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  await c.query('SET CONSTRAINTS ALL DEFERRED');
  ok('Fluxo inicial completo satisfaz os triggers diferidos antes do rollback');
  await assert.rejects(gerarContrato({fechamentoId:f.id},ctx));
  assert.equal((await c.query('SELECT snapshot_hash FROM contrato_versoes WHERE id=$1',[contrato.versao.id])).rows[0].snapshot_hash,contrato.versao.snapshotHash);
  ok('Versão assinada permanece imutável');
  const resumo = await calcularResumoComercial({data:input.dataEvento,configuracaoAgendaId:config.id,pacoteId:pacote.id,convidados:50,adicionais:[]},c);
  const semNegociacao = await criarFechamentoPublicoComIdentidade({...input,cliente:{...input.cliente,cpf:cpf()},valorProposto:resumo.valorTotalTabela,condicaoPixPretendida:{valorParcela:100}});
  assert.equal(semNegociacao.fechamento.valorNegociado,null);
  assert.equal(semNegociacao.fechamento.status,'AGUARDANDO_APROVACAO');
  ok('PIX parcelado sem negociação de preço ainda exige revisão, sem valor negociado artificial');
  await c.query('SAVEPOINT aprovar_sem_negociacao');
  const aprovadoSemNegociacao = await revisarComercial(semNegociacao.fechamento.id,{solicitacaoId:semNegociacao.aprovacaoNegociacao.id,
    decisao:'APROVAR',condicaoAprovada:{valorParcela:100},motivo:'Condição parcial conferida'},ctx);
  assert.equal(aprovadoSemNegociacao.fechamento.valorNegociado,null);
  assert.equal(aprovadoSemNegociacao.fechamento.valorAprovado,null);
  assert.equal(aprovadoSemNegociacao.fechamento.status,'AGUARDANDO_CONTRATO');
  await c.query('ROLLBACK TO SAVEPOINT aprovar_sem_negociacao');
  ok('Aprovação apenas de condição preserva a semântica de valor negociado/aprovado');
  const recusa = await revisarComercial(semNegociacao.fechamento.id,{solicitacaoId:semNegociacao.aprovacaoNegociacao.id,decisao:'RECUSAR',motivo:'Condição recusada no teste'},ctx);
  assert.equal(recusa.fechamento.status,'RECUSADO');
  await assert.rejects(gerarContrato({fechamentoId:recusa.fechamento.id},ctx));
  ok('Recusa impede liberação contratual');
  for(const forma of ['PIX_AVISTA','CARTAO_CIELO']) {
    const outro = await criarFechamentoPublicoComIdentidade({...input,cliente:{...input.cliente,cpf:cpf()},formaPagamentoPretendida:forma,condicaoPixPretendida:null});
    if(outro.aprovacaoNegociacao) await revisarComercial(outro.fechamento.id,{solicitacaoId:outro.aprovacaoNegociacao.id,decisao:'APROVAR',valorBaseAprovado:9290,motivo:'Base aprovada'},ctx);
    const ct = await gerarContrato({fechamentoId:outro.fechamento.id},ctx);
    assert.equal(ct.versao.snapshot.comercial.valorFinalContrato,forma==='PIX_AVISTA'?8361:9290);
    ok(`Contrato ${forma} aplica desconto correto após precedência comercial`);
  }
  assert.equal(pretensaoPixSchema.safeParse({entrada:'1.00000000000001'}).success,false);
  assert.equal(pretensaoPixSchema.safeParse({valorParcela:true}).success,false);
  assert.equal(pretensaoPixSchema.safeParse({aprovada:true}).success,false);
  ok('Schema HTTP rejeita subcentavos, booleanos e aprovação na proposta');
  const contexto = {params:Promise.resolve({fechamentoId:f.id})};
  process.env.NODE_ENV='production';process.env.CRM_API_DEV_ENABLED='true';
  assert.equal((await route.GET(admin.request('/api/admin/revisao'),contexto)).status,403);
  process.env.NODE_ENV='development';
  assert.equal((await route.GET(admin.request('/api/admin/revisao'),contexto)).status,200);
  const http = await route.POST(admin.request('/api/admin/revisao','POST',body),contexto);
  assert.equal(http.status,200);assert.equal(http.headers.get('cache-control'),'no-store');
  assert.equal((await route.POST(admin.request('/api/admin/revisao','POST',{...body,valorBaseAprovado:'1.001'}),contexto)).status,400);
  ok('Handlers administrativos: proteção produção, consulta, replay, precisão e no-store');
  const publico = {
    identidadeTipo:'NOVO_CLIENTE',dataFesta:input.dataEvento,horarioBase:'almoco',ajusteHorario:'0',
    horarioInicio:'11:00',horarioFim:'15:00',statusDisponibilidade:'disponivel',pacote:'completa',convidadosPagantes:50,
    buffetDefinicao:'depois',valorCombinado:'R$ 9.290,00',nomeCliente:input.cliente.nomeCompleto,cpf:cpf(),
    email:input.cliente.email,telefone:input.cliente.telefone,whatsapp:input.cliente.whatsapp,
    cep:input.cliente.cep,logradouro:input.cliente.logradouro,numero:input.cliente.numero,bairro:input.cliente.bairro,
    cidade:input.cliente.cidade,uf:'SP',nomeAniversariante:'Teste API',idadeAniversariante:7,
    formaPagamento:'pix_parcelado',condicaoPixPretendida:{valorParcela:'500.25'},
  };
  const chamadaPublica = (body) => publicRoute.POST(new NextRequest('http://localhost/api/fechamentos',{method:'POST',body:JSON.stringify(body)}));
  const anteriorPublico = await countFinance();
  // O contrato assinado anteriormente já ocupa o horário, mesmo sem pagamento.
  const ocupado = await chamadaPublica(publico);
  assert.equal(ocupado.status,409);
  assert.equal((await ocupado.json()).codigo,'HORARIO_NAO_DISPONIVEL');
  publico.dataFesta='2098-10-12';
  const respostaPublica = await chamadaPublica(publico);
  const retornoPublico = await respostaPublica.json();
  assert.equal(respostaPublica.status,201,JSON.stringify(retornoPublico));
  assert.equal(retornoPublico.comercial.condicaoPagamento.pretendida.parcelaCentavos,50025);
  assert.deepEqual(await countFinance(),anteriorPublico);
  ok('Entrada pública completa persiste valor da parcela pretendida, sem qualquer registro financeiro');
  for (const extra of [
    {condicaoPagamento:{revisaoStatus:'APROVADA'}},{condicaoAprovada:{valorParcela:1}},{valorAprovado:1},
    {condicaoPixPretendida:{valorParcela:'1.0000000000001'}},{condicaoPixPretendida:{entrada:0.0100000001}},
    {valorCombinado:'9290.001'},{valorCombinado:'R$ 9.290,001'},
  ]) assert.equal((await chamadaPublica({...publico,cpf:cpf(),...extra})).status,400);
  assert.deepEqual(await countFinance(),anteriorPublico);
  ok('Payload público válido com injeção de aprovação ou subcentavos é rejeitado');
  await c.query('ROLLBACK TO SAVEPOINT escopo_comercial');
  assert.deepEqual(await extraFingerprint(),extraBefore);
  console.log(`${checks} cenários comerciais aprovados; aprovações, contratos e dados financeiros preservados por rollback.`);
}
const WORKER_REVISAO_LOCK = '--worker-revisao-lock';

async function contagensOperacionais(c) {
  const tabelas = [
    'clientes', 'fechamentos', 'contratos', 'contrato_versoes', 'pagamentos',
    'pagamento_parcelas', 'pagamento_recebimentos', 'validacoes_identidade_cliente',
  ];
  const contagens = {};
  for (const tabela of tabelas) {
    contagens[tabela] = Number((await c.query(`SELECT count(*)::int AS total FROM ${tabela}`)).rows[0].total);
  }
  return contagens;
}

async function criarFixtureSinteticaLock(c) {
  await c.query('BEGIN');
  try {
    const catalogo = (await c.query(`
      SELECT ca.id AS configuracao_agenda_id, pp.pacote_id, pp.tabela_preco_id,
             pp.id AS preco_pacote_id, GREATEST(pp.convidados_min, 1) AS convidados,
             pp.valor::numeric AS valor
        FROM configuracao_agenda ca
        CROSS JOIN LATERAL (
          SELECT pp.*
            FROM precos_pacote pp
            JOIN pacotes p ON p.id = pp.pacote_id AND p.ativo = true
            JOIN tabelas_preco tp ON tp.id = pp.tabela_preco_id AND tp.ativa = true
           WHERE pp.ativo = true
           ORDER BY pp.valor, pp.id
           LIMIT 1
        ) pp
       WHERE ca.ativo = true
       ORDER BY ca.ordem_exibicao, ca.id
       LIMIT 1
    `)).rows[0];
    assert.ok(catalogo, 'Catálogos mínimos de agenda, pacote e preço devem existir no clone');

    const marcador = randomUUID();
    const clienteId = (await c.query(`
      INSERT INTO clientes (
        nome_completo, cpf, email, telefone, whatsapp,
        cep, logradouro, numero, bairro, cidade, uf
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING id
    `, [
      'Cliente Sintético Concorrência', cpf(), `concorrencia-${marcador}@example.invalid`,
      '00000000000', '00000000000', '00000000', 'Rua Sintética', '0',
      'Bairro de Teste', 'Cidade de Teste', 'SP',
    ])).rows[0].id;

    const fechamentoId = (await c.query(`
      INSERT INTO fechamentos (
        cliente_id, pacote_id, tabela_preco_id, preco_pacote_id, configuracao_agenda_id,
        data_evento, horario_inicio, horario_fim, categoria_horario, categoria_preco_aplicada,
        convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado,
        valor_tabela, status, origem_fechamento, condicao_pagamento
      ) VALUES ($1,$2,$3,$4,$5, DATE '2098-08-17', TIME '11:00', TIME '15:00',
                'PADRAO','PADRAO',$6,$6,$7,$7,$7,'RASCUNHO','ATENDIMENTO_KIDMAIS',NULL)
      RETURNING id
    `, [
      clienteId, catalogo.pacote_id, catalogo.tabela_preco_id, catalogo.preco_pacote_id,
      catalogo.configuracao_agenda_id, catalogo.convidados, catalogo.valor,
    ])).rows[0].id;

    await c.query('COMMIT');
    return { clienteId, fechamentoId };
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  }
}

function iniciarTentativaConcorrente(fechamentoId, solicitacaoId, numero) {
  const url = new URL(process.env.DATABASE_URL);
  const aplicacao = `kidmais-v1-revisao-lock-${process.pid}-${numero}`;
  url.searchParams.set('application_name', aplicacao);
  const filho = fork(__filename, [WORKER_REVISAO_LOCK, fechamentoId, solicitacaoId], {
    env: { ...process.env, DATABASE_URL: url.toString() },
    silent: true,
  });
  let mensagem;
  let stderr = '';
  filho.stderr.on('data', (parte) => { stderr += parte.toString(); });
  filho.on('message', (valor) => { mensagem = valor; });
  const resultado = new Promise((resolve, reject) => {
    const limite = setTimeout(() => {
      filho.kill();
      reject(new Error(`Tentativa concorrente ${numero} excedeu o limite de tempo`));
    }, 15000);
    filho.on('error', (error) => { clearTimeout(limite); reject(error); });
    filho.on('exit', (codigo) => {
      clearTimeout(limite);
      if (codigo !== 0 || !mensagem) {
        reject(new Error(`Tentativa concorrente ${numero} terminou com código ${codigo}: ${stderr}`));
        return;
      }
      resolve(mensagem);
    });
  });
  return { aplicacao, resultado };
}

async function executarWorkerRevisaoLock() {
  const fechamentoId = process.argv[3];
  const solicitacaoId = process.argv[4];
  try {
    const resultado = await revisarComercial(fechamentoId, {
      solicitacaoId,
      decisao: 'RECUSAR',
      motivo: 'Teste sintético concorrente sem escrita',
    }, { origem: 'REGRESSAO_HOMOLOGACAO' });
    process.send?.({ sucesso: true, reutilizada: resultado.reutilizada === true });
  } catch (error) {
    process.send?.({ sucesso: false, code: error?.code, message: error?.message });
  } finally {
    await closeDatabasePool();
  }
}

async function removerFixtureSinteticaLock(c, fixture) {
  await c.query('BEGIN');
  try {
    await c.query('DELETE FROM fechamentos WHERE id=$1', [fixture.fechamentoId]);
    await c.query('DELETE FROM clientes WHERE id=$1', [fixture.clienteId]);
    await c.query('COMMIT');
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  }
}

async function validarLockRevisao() {
  const bloqueador = client();
  const monitor = client();
  await bloqueador.connect();
  await monitor.connect();
  const antes = await fingerprint(monitor);
  const contagensAntes = await contagensOperacionais(monitor);
  let fixture;
  let tentativas = [];
  let resultados;
  try {
    fixture = await criarFixtureSinteticaLock(monitor);
    const estadoInicial = (await monitor.query(
      `SELECT condicao_pagamento, md5(to_jsonb(f)::text) AS hash
         FROM fechamentos f WHERE id=$1`,
      [fixture.fechamentoId],
    )).rows[0];
    assert.ok(estadoInicial, 'A fixture sintética deve existir');
    assert.equal(estadoInicial.condicao_pagamento, null);

    await bloqueador.query('BEGIN');
    await bloqueador.query('SELECT id FROM fechamentos WHERE id=$1 FOR UPDATE', [fixture.fechamentoId]);
    const solicitacaoId = randomUUID();
    tentativas = [
      iniciarTentativaConcorrente(fixture.fechamentoId, solicitacaoId, 1),
      iniciarTentativaConcorrente(fixture.fechamentoId, solicitacaoId, 2),
    ];

    let bloqueadas = 0;
    for (let i=0; i<150; i++) {
      bloqueadas = Number((await monitor.query(`
        SELECT count(*)::int AS total
          FROM pg_stat_activity
         WHERE datname = current_database()
           AND application_name = ANY($1::text[])
           AND wait_event_type = 'Lock'
      `, [tentativas.map((item) => item.aplicacao)])).rows[0].total);
      if (bloqueadas === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(bloqueadas, 2, 'As duas revisões devem aguardar o lock físico do Fechamento');
    await bloqueador.query('ROLLBACK');
    resultados = await Promise.all(tentativas.map((item) => item.resultado));
    assert.deepEqual(resultados.map((item) => item.code), [
      'REVISAO_COMERCIAL_INVALIDA', 'REVISAO_COMERCIAL_INVALIDA',
    ]);

    const estadoFinal = (await monitor.query(`
      SELECT condicao_pagamento, md5(to_jsonb(f)::text) AS hash,
             (SELECT count(*)::int FROM aprovacoes_negociacao a WHERE a.fechamento_id=f.id) AS aprovacoes,
             (SELECT count(*)::int FROM contratos c WHERE c.fechamento_id=f.id) AS contratos
        FROM fechamentos f WHERE f.id=$1
    `, [fixture.fechamentoId])).rows[0];
    assert.equal(estadoFinal.condicao_pagamento, null);
    assert.equal(estadoFinal.hash, estadoInicial.hash, 'As tentativas não podem perder nem alterar dados');
    assert.equal(estadoFinal.aprovacoes, 0, 'As tentativas recusadas não podem duplicar aprovações');
    assert.equal(estadoFinal.contratos, 0, 'As tentativas recusadas não podem criar contratos');
    ok('Duas revisões concorrentes aguardam o lock e revalidam a fixture sintética sem duplicidade');
  } finally {
    await bloqueador.query('ROLLBACK').catch(() => {});
    if (tentativas.length > 0 && !resultados) {
      await Promise.allSettled(tentativas.map((item) => item.resultado));
    }
    if (fixture) await removerFixtureSinteticaLock(monitor, fixture);
    assert.deepEqual(await fingerprint(monitor), antes);
    assert.deepEqual(await contagensOperacionais(monitor), contagensAntes);
    await bloqueador.end();
    await monitor.end();
  }
}

if (process.argv[2] === WORKER_REVISAO_LOCK) {
  executarWorkerRevisaoLock().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  rollbackTest(run).then(validarLockRevisao).then(()=>console.log(`${checks} cenários totais aprovados.`))
    .catch(e=>{console.error(e);process.exitCode=1;});
}
