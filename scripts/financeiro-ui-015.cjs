/* eslint-disable @typescript-eslint/no-require-imports */
const assert=require('node:assert/strict');
module.exports=async({page,url})=>{
 const {Client}=require('pg'),c=new Client({connectionString:url});await c.connect();
 try{
  const pend=(await c.query(`SELECT p.contrato_id FROM contrato_pendencias_financeiras p JOIN contrato_fluxos f ON f.versao_vigente_id=p.versao_nova_id WHERE NOT EXISTS(SELECT 1 FROM pagamento_ajustes_contratuais a WHERE a.pagamento_id=p.pagamento_id AND a.versao_reconhecida_id=p.versao_nova_id) ORDER BY p.criado_em LIMIT 1`)).rows[0];assert(pend);
  await page.getByLabel('Contrato',{exact:true}).selectOption(pend.contrato_id);
  const ui=page.getByRole('region',{name:'Financeiro da contratação'});
  await ui.getByRole('button',{name:'Abrir tratamento da alteração',exact:true}).click();
  await ui.getByRole('heading',{name:'1. Conferir a alteração',exact:true}).waitFor();await ui.getByRole('button',{name:'Continuar',exact:true}).click();
  await ui.getByLabel('Justificativa e autorização').fill('Cancelamento apenas da tentativa no navegador');await ui.getByRole('button',{name:'Cancelar tentativa',exact:true}).click();
  await ui.getByText('Tentativa #1: cancelada',{exact:true}).waitFor();await ui.getByRole('button',{name:'Abrir tratamento da alteração',exact:true}).waitFor();
  await ui.getByRole('button',{name:'Abrir tratamento da alteração',exact:true}).click();await ui.getByRole('button',{name:'Continuar',exact:true}).click();await ui.getByLabel('Justificativa e autorização').fill('Regularização validada no navegador; parcelas anteriores preservadas');await ui.getByRole('button',{name:'Continuar',exact:true}).click();
  await ui.getByRole('heading',{name:'3. Conferir parcelas futuras',exact:true}).waitFor();
  const novaParcela=ui.locator('input[aria-label^="Valor da parcela"]:not([readonly])').first();
  const valorAnterior=await novaParcela.inputValue();await novaParcela.fill('0,001');await novaParcela.blur();
  await ui.getByRole('alert').filter({hasText:'Valor não aplicado; o valor anterior foi restaurado.'}).waitFor();
  assert.equal(await novaParcela.inputValue(),valorAnterior,'Subcentavo não permanece visível como valor aceito');
  await novaParcela.fill(valorAnterior);await novaParcela.blur();
  await page.screenshot({path:'.tmp/financeiro-015-cronograma.png',fullPage:true});await ui.getByRole('button',{name:'Continuar',exact:true}).click();await ui.getByRole('button',{name:'Validar simulação',exact:true}).click();await ui.getByRole('button',{name:'Confirmar tratamento financeiro',exact:true}).click();await ui.getByText('Tratamento confirmado. Nenhum recebimento foi criado.',{exact:true}).waitFor();
  await ui.getByRole('heading',{name:'Cronograma consolidado vigente',exact:true}).waitFor();assert.equal(await ui.getByRole('button',{name:'Abrir tratamento da alteração',exact:true}).count(),0);
  await ui.getByRole('button',{name:'Registrar recebimento',exact:true}).click();await ui.getByLabel('Parcela a receber',{exact:true}).locator('option').nth(1).waitFor({state:'attached'});const parcela=await ui.getByLabel('Parcela a receber',{exact:true}).locator('option').evaluateAll(options=>options.find(o=>o.value)?.value);await ui.getByLabel('Parcela a receber',{exact:true}).selectOption(parcela);await ui.getByLabel('Valor do movimento em reais').fill('1,00');await ui.getByLabel('Descrição do movimento').fill('Recebimento sintético pelo navegador');await ui.getByLabel('Data e hora do recebimento').fill(new Date(Date.now()-86400000).toISOString().slice(0,16));await ui.getByRole('button',{name:'Confirmar movimento financeiro',exact:true}).click();await ui.getByText('Recebimento confirmado.',{exact:true}).waitFor();
  const aloc=(await c.query(`SELECT a.id FROM pagamento_recebimento_alocacoes a JOIN pagamento_recebimentos r ON r.id=a.recebimento_id WHERE a.parcela_id=$1 ORDER BY r.criado_em DESC LIMIT 1`,[parcela])).rows[0].id;
  await ui.getByRole('button',{name:'Estornar recebimento',exact:true}).click();await ui.getByLabel('Origem do estorno',{exact:true}).selectOption(aloc);await ui.getByLabel('Valor do movimento em reais').fill('1,00');await ui.getByLabel('Descrição do movimento').fill('Estorno sintético pelo navegador');await ui.getByRole('button',{name:'Confirmar movimento financeiro',exact:true}).click();await ui.getByText('Estorno confirmado.',{exact:true}).waitFor();
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'.tmp/financeiro-015-mobile.png',fullPage:true});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Sem overflow financeiro mobile');await page.setViewportSize({width:1280,height:900});
  const credito=(await c.query(`SELECT g.contrato_id FROM pagamento_gestoes g JOIN pagamento_devolucoes d ON d.pagamento_id=g.pagamento_id WHERE d.estado='CONCLUIDA' ORDER BY d.criado_em DESC LIMIT 1`)).rows[0];assert(credito);
  await page.getByLabel('Contrato',{exact:true}).selectOption(credito.contrato_id);await ui.getByRole('button',{name:'Solicitar devolução de crédito',exact:true}).click();
  const form=ui.getByRole('group',{name:'Solicitar devolução — reserva de crédito'});await form.getByLabel('Valor em reais',{exact:true}).fill('10,00');await form.getByLabel('Beneficiário',{exact:true}).fill('Beneficiário sintético do navegador');await form.getByLabel('Motivo da solicitação',{exact:true}).fill('Teste de reserva e devolução pelo navegador');await form.getByRole('button',{name:'Confirmar solicitação usando as origens acima, em ordem'}).click();await ui.getByText('Devolução solicitada; crédito reservado.',{exact:true}).waitFor();
  await ui.getByLabel('Comprovante (PDF, JPEG ou PNG)').setInputFiles({name:'comprovante-sintetico.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4\n% Comprovante sintético de teste\n%%EOF')});await ui.getByRole('link',{name:'comprovante-sintetico.pdf',exact:true}).waitFor();await ui.getByRole('button',{name:'Registrar saída financeira efetivada',exact:true}).click();
  await ui.getByLabel('Data e hora reais').fill(new Date(Date.now()-86400000).toISOString().slice(0,16));await ui.getByLabel('Observação da execução').fill('Saída sintética no clone de teste');await ui.getByRole('button',{name:'Confirmo que a saída financeira ocorreu',exact:true}).click();await ui.getByText('Devolução concluída e saída financeira registrada.',{exact:true}).waitFor();
  await page.screenshot({path:'.tmp/financeiro-015-devolucao.png',fullPage:true});
  console.log('PASS navegador 015: cancelamento mantém pendência, quatro etapas, cronograma, mobile, solicitação, BYTEA de comprovante e conclusão de devolução.');
 }finally{await c.end();}
};
