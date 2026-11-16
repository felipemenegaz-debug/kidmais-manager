import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {cpfEditavelNaEdicao,patchDeEdicaoCliente} from './edicao-cpf.ts';

// Achado da promoção (15/11/2026): o campo CPF ficava travado na edição mesmo sem CPF salvo, e o cliente vindo de
// contato do Marketing nunca chegava ao Fechamento. Completar um CPF ausente é permitido; trocar o salvo, não.
test('campo CPF na edição: liberado sem CPF salvo ou na troca de tipo; travado com CPF salvo', () => {
 assert.equal(cpfEditavelNaEdicao(null,false),true);
 assert.equal(cpfEditavelNaEdicao(undefined,false),true);
 assert.equal(cpfEditavelNaEdicao('',false),true);
 assert.equal(cpfEditavelNaEdicao(' . - ',false),true);
 assert.equal(cpfEditavelNaEdicao('529.982.247-25',false),false);
 assert.equal(cpfEditavelNaEdicao('52998224725',true),true);
});

test('patch da edição: só envia o CPF ao completar um cadastro sem CPF', () => {
 const pf=(cpf:string|null)=>({tipoPessoa:'PF' as const,cpf,nomeCompleto:'Teste'});
 assert.deepEqual(patchDeEdicaoCliente(pf('529.982.247-25'),null),pf('529.982.247-25'));
 assert.deepEqual(patchDeEdicaoCliente(pf('529.982.247-25'),''),pf('529.982.247-25'));
 // Sem CPF digitado: não envia (não grava nulo à toa).
 assert.deepEqual(patchDeEdicaoCliente(pf(null),null),{tipoPessoa:'PF',nomeCompleto:'Teste'});
 // Com CPF salvo: nunca envia, nem outro valor nem vazio (trocar continua no fluxo de identidade).
 assert.deepEqual(patchDeEdicaoCliente(pf('11144477735'),'52998224725'),{tipoPessoa:'PF',nomeCompleto:'Teste'});
 assert.deepEqual(patchDeEdicaoCliente(pf(null),'52998224725'),{tipoPessoa:'PF',nomeCompleto:'Teste'});
 // PJ envia o CPF nulo (é assim que PF→PJ remove o CPF da pessoa).
 const pj={tipoPessoa:'PJ' as const,cpf:null,nomeCompleto:'Empresa'};
 assert.deepEqual(patchDeEdicaoCliente(pj,'52998224725'),pj);
});

test('formulário e cliente de API usam a regra única', () => {
 const form=fs.readFileSync('components/clientes/ClienteForm.tsx','utf8');
 assert.match(form,/cpfEditavelNaEdicao\(detalheInicial\?\.cliente\.cpf, trocandoTipo\)/);
 assert.match(form,/disabled=\{cpfBloqueado\}/);
 assert.doesNotMatch(form,/disabled=\{mode === "edit" && !trocandoTipo\}/);
 assert.match(form,/atualizarClienteApi\(clienteId!, form, detalheInicial\?\.cliente\.cpf\)/);
 const api=fs.readFileSync('lib/clientes/api-client.ts','utf8');
 assert.match(api,/patchDeEdicaoCliente\(formParaPayload\(form\), cpfSalvo\)/);
});
