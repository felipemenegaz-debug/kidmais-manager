import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {perfis,nomePerfil} from './perfis.ts';
import {capacidades} from './domain.ts';
import {erroHumano,amigavel} from './ux.ts';
test('Gestão cinco capacidades; Equipe consulta e operação',()=>{assert.deepEqual(perfis.GESTAO,capacidades);assert.deepEqual(perfis.EQUIPE,['FESTA_CONSULTAR','FESTA_OPERAR']);assert.equal(nomePerfil(perfis.GESTAO),'Gestão');assert.equal(nomePerfil(perfis.EQUIPE),'Equipe');assert.equal(nomePerfil([]),'Sem acesso');});
test('mensagens sem códigos e prioridade como atenção',()=>{assert(!erroHumano('Capacidade necessária: FESTA_CORRIGIR').includes('FESTA_'));assert.match(erroHumano('Festa atualizada por outra operação'),/Seus dados não foram perdidos/);assert.equal(amigavel('CRITICA'),'Precisa de atenção');});
test('consultarPerfis expõe papel de sistema separado do acesso às Festas',()=>{
 const service=readFileSync('lib/festas/service.ts','utf8');
 assert.match(service,/nivelSistema:nomePapelSistema/);
 assert.match(service,/perfil:nomePerfil/);
});
