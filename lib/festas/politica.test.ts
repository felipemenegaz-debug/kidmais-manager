import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {politicaOperacao,chaveCronologica,horarioResumo} from './politica.ts';
test('motivo opcional nas seis operações normais; obrigatório em correções',()=>{
 for(const acao of ['tarefa','pendencia','observacao','buffet','solicitacao','contagem'])assert.equal(politicaOperacao({acao,estado:'ABERTA'},null).motivoObrigatorio,false);
 assert(politicaOperacao({acao:'contagem',corrigeId:'anterior'},null).motivoObrigatorio);
});
test('tarefas e pendências não permitem contornar criticidade sem correção',()=>{
 for(const acao of ['tarefa','pendencia']){
  const before={estado:acao==='tarefa'?'CONCLUIDA':'RESOLVIDA',prioridade:'CRITICA',categoria:'ANTES'};
  for(const change of [{estado:'PENDENTE'},{estado:'NAO_SE_APLICA'},{prioridade:'NORMAL'},{categoria:'DEPOIS'}])assert.deepEqual(politicaOperacao({acao,...before,...change},before),{corrigir:true,motivoObrigatorio:true});
 }
});
test('Central ordena pela data e horário; resumo inclui faixa horária',()=>{
 const dados=[{evento:{data:'2026-09-12',horarioInicio:'09:00'}},{evento:{data:'2026-09-11',horarioInicio:'18:00'}},{evento:{data:'2026-09-11',horarioInicio:'10:00',horarioFim:'14:00'}}];
 const sorted=[...dados].sort((a,b)=>chaveCronologica(a).localeCompare(chaveCronologica(b)));
 assert.equal(sorted[0],dados[2]);assert.equal(sorted[1],dados[1]);assert.equal(horarioResumo(dados[2]),'10:00–14:00');
});
test('links de Festas no perfil usam cliente carregado canônico, inclusive acesso pelo UUID mesclado',()=>{
 const code=readFileSync('components/clientes/ClienteProfile.tsx','utf8');
 assert.equal((code.match(/\/admin\/festas\?clienteId=\$\{encodeURIComponent\(cliente.id\)/g)??[]).length,3);
 assert(!code.includes('/admin/festas?clienteId=${encodeURIComponent(clienteId)}'));
});
