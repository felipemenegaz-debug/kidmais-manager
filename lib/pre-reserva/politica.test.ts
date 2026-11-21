import assert from 'node:assert/strict';
import test from 'node:test';
import { garantiaAte, POLITICA_PRE_RESERVA, referenciaTransferencia, sinalDaOferta } from './politica.ts';
import { carregarModulo } from '../acessos/teste-carregador.ts';

test('oferta depende de adesão, orçamento online, centavos e preço aceito', () => {
  assert.equal(sinalDaOferta(true,true,10000,8000),8000);
  assert.equal(sinalDaOferta(true,true,10000,25000),10000);
  for (const valor of [999,50001,1000.5,NaN]) assert.equal(sinalDaOferta(true,true,valor,60000),null);
  assert.equal(sinalDaOferta(true,true,1000,999),null);
  assert.equal(sinalDaOferta(true,false,10000,25000),null);
  assert.equal(sinalDaOferta(false,true,10000,25000),null);
});

test('EndToEndId obrigatório preserva o sufixo do identificador bancário', () => {
  const ref = 'E12345678202611201234aBc34567890';
  assert.equal(referenciaTransferencia(' '+ref+' '),ref);
  for (const v of ['', 'txid', ref.slice(1), ref.replace('a','-'), ref+'0']) assert.throws(()=>referenciaTransferencia(v));
});

test('Gestão comprovada, plano e Pix governam alterações e desligamento', async () => {
  let plano = false, pix = false, escritas = 0, auditorias = 0;
  const tenant = {empresaComprovada:'empresa',usuarioId:'gestor',papelAtual:'REPRESENTANTE_AUTORIZADO'};
  const mod = carregarModulo('lib/pre-reserva/configuracao.ts',{
    'db/postgres': {},
    'assinatura/recursos-plano': { exigirRecursoPlano: async (_tx:unknown,e:string,r:string)=>{
      assert.equal(e,'empresa'); assert.equal(r,'ORCAMENTO_ONLINE'); if (!plano) throw Error('Sem orçamento online');
    }},
    'clientes/repositories/auditoria.repository': {registrarAuditoria: async ()=>{auditorias++;}},
  });
  const db = {query(sql:string) {
    if(sql.includes('FROM pre_reserva_configuracoes')) return {rows:[]};
    if(sql.includes('FROM empresa_pix_recebimento')) return {rows:pix?[{}]:[]};
    assert.match(sql,/INSERT INTO pre_reserva_configuracoes/); escritas++; return {rows:[{versao:1}]};
  }};
  const sessao = {autenticado_em:new Date().toISOString()};
  const dados = {versao:0,sinalCentavos:10000,habilitada:true};
  const ler = mod.configuracaoPreReserva as (db:unknown, t:typeof tenant)=>Promise<unknown>;
  const salvar = mod.salvarConfiguracaoPreReserva as (db:unknown,t:typeof tenant,s:typeof sessao,d:unknown)=>Promise<unknown>;
  assert.deepEqual(await ler(db,tenant),{versao:0,sinalCentavos:10000,habilitada:false});
  await assert.rejects(salvar(db,{...tenant,papelAtual:'ADMINISTRATIVO'},sessao,dados),/Gestão/);
  await assert.rejects(salvar(db,tenant,{autenticado_em:'2000-01-01'},dados),/senha/);
  await assert.rejects(salvar(db,tenant,sessao,{...dados,versao:1}),/Atualize/);
  await assert.rejects(salvar(db,tenant,sessao,{...dados,empresaId:'outra'}));
  await assert.rejects(salvar(db,tenant,sessao,dados),/orçamento/);
  plano=true;
  await assert.rejects(salvar(db,tenant,sessao,dados),/recebedor Pix/);
  assert.equal(escritas,0);
  pix=true;
  await salvar(db,tenant,sessao,dados);
  plano=false;
  await salvar(db,tenant,sessao,{...dados,habilitada:false});
  assert.equal(escritas,2); assert.equal(auditorias,2);
});

test('prazo padrão da garantia e comunicação da devolução', () => {
  assert.equal(garantiaAte(new Date('2026-11-21T01:30Z')).toISOString(), '2026-11-23T01:30:00.000Z');
  assert.equal(POLITICA_PRE_RESERVA.prazoDevolucao, 'em até 2 dias úteis');
});
