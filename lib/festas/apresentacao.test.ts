import test from 'node:test';
import assert from 'node:assert/strict';
import { apresentarEventoFesta, linksContratoDaFesta, retornoFestaSeguro } from './apresentacao.ts';

const id='00000000-0000-4000-8000-000000000016';
test('links preservam contrato/versão e distinguem consulta, edição e financeiro',()=>{
    const links=linksContratoDaFesta('contrato vigente','versao vigente',id);
    for(const [tipo,href] of Object.entries(links)){
        const url=new URL(href,'http://localhost');
        assert.equal(url.searchParams.get('contratoId'),'contrato vigente');
        assert.equal(url.searchParams.get('versaoId'),'versao vigente');
        assert.equal(url.searchParams.get('returnTo'),`/admin/festas/${id}`);
        assert.equal(url.hash,tipo==='editar'?'#alteracoes':tipo==='pagamentos'?'#financeiro':'');
    }
});
test('retorno aceita somente rota interna de Festa e rejeita redirecionamentos arbitrários',()=>{
    assert.equal(retornoFestaSeguro(`/admin/festas/${id}`),`/admin/festas/${id}`);
    for(const path of [null,'https://example.com','//example.com',`/admin/festas/${id}?next=https://example.com`,`/admin/festas/${id}/..`,'/admin/contratos',`/admin/festas/${id}#x`,'/admin/festas/%2e%2e'])assert.equal(retornoFestaSeguro(path),null);
});
test('histórico distingue criação e conclusão comprovadas; sem antes usa descrição neutra',()=>{
    const base={tipo:'FESTA_TAREFA',dados_depois:{titulo:'Confirmar decoração',estado:'CONCLUIDA'},criado_em:'2026-09-11T09:55:00Z',identidade_snapshot:{nome:'Felipe'}};
    assert.equal(apresentarEventoFesta({...base,dados_antes:null}).titulo,'Tarefa criada');
    const final=apresentarEventoFesta({...base,dados_antes:{estado:'PENDENTE'}});
    assert.equal(final.titulo,'Tarefa concluída');assert.deepEqual(final.detalhes,['Confirmar decoração']);assert.equal(final.quando,'11/09/2026 às 06:55 • Felipe');
    assert.equal(apresentarEventoFesta(base).titulo,'Tarefa atualizada');
    assert.equal(apresentarEventoFesta({...base,dados_antes:{estado:'CONCLUIDA'}}).titulo,'Tarefa atualizada');
});
test('buffet mostra campos reconhecidos e alterados sem metadados ou JSON',()=>{
    const r=apresentarEventoFesta({tipo:'FESTA_BUFFET',dados_antes:{bolo:'Chocolate',lembrancinha:'Bola'},dados_depois:{bolo:'Chocolate',lembrancinha:'Carrinho',id:'interno',request_id:'segredo'}});
    assert.deepEqual(r.detalhes,['Lembrancinha: Carrinho']);
    assert.deepEqual(apresentarEventoFesta({tipo:'FESTA_BUFFET',dados_antes:{lembrancinha:'Bola'},dados_depois:{lembrancinha:''}}).detalhes,['Lembrancinha: Não definido']);
});
test('criação não exibe justificativa técnica e registros insuficientes não inventam fatos',()=>{
    const r=apresentarEventoFesta({tipo:'FESTA_CRIADA',motivo:'Criação explícita',dados_depois:{id}});
    assert.equal(r.titulo,'Festa adicionada ao Manager');assert.deepEqual(r.detalhes,[]);
    const legado=apresentarEventoFesta({tipo:'FESTA_COMANDO_DESCONHECIDO',dados_depois:{descricao:{campo:'x'}},motivo:'{"comando":"FESTA_X"}'});
    assert.equal(legado.titulo,'Registro da festa atualizado');assert.deepEqual(legado.detalhes,[]);
    assert.deepEqual(apresentarEventoFesta({tipo:'FESTA_OBSERVACAO',dados_depois:{descricao:'FESTA_OBSERVACAO'},motivo:id}).detalhes,[]);
});
