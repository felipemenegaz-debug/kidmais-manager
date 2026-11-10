import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { conversaSoLeu, dependeDaResposta, ehConsulta } from './consultas-admin.ts';

const com = (corpo: object) => ({ method: 'POST', body: JSON.stringify(corpo) });

test('consultas auditadas', () => {
    const casos: Array<[string, RequestInit]> = [
        ['/api/endereco/consultar-cep', com({ cep: '1' })],
        ['/api/admin/clientes/analisar-cadastro', com({ nome: 'x' })],
        ['/api/admin/clientes/analisar-cadastro/', com({ nome: 'x' })],
        ['/api/admin/clientes/analisar-cadastro?empresaId=e', com({ nome: 'x' })],
        ['/api/admin/contratos/c1/financeiro/cronograma/simulacao', com({})],
        ['/api/admin/contratos/c1/financeiro/tratamentos/t1/simulacao', com({})],
        ['/api/admin/configuracoes/whatsapp/demo-ativos', { method: 'POST' }],
        ['/api/admin/atendimento/prontas', com({ acao: 'rascunho' })],
        ['/api/admin/inteligencia/importacoes', com({ acao: 'ler' })],
        ['/api/admin/inteligencia', com({ capacidade: 'atencao_hoje' })],
        ['/api/admin/inteligencia/preparacoes', com({ acao: 'situacao' })],
        ['/api/admin/inteligencia/preparacoes', com({ acao: 'abrir' })],
        ['/api/admin/inteligencia/importacoes', com({ acao: 'estado' })],
        ['/api/admin/inteligencia/importacoes', com({ acao: 'listar' })],
        ['/api/admin/inteligencia/importacoes', com({ acao: 'opcoes-completas' })],
        ['/api/admin/inteligencia/importacoes', com({ acao: 'simular-completa' })],
        ['/api/admin/contratos/importados/abc/integracao', com({ acao: 'simular' })],
        ['/api/admin/contratos/importados/abc/integracao', com({ acao: 'simular-financeiro' })],
        ['/api/admin/configuracoes/tabelas-preco', com({ acao: 'simular' })],
        ['/api/admin/configuracoes/tabelas-preco', com({ acao: 'simular_festa' })],
        ['/api/admin/configuracoes/modelo-contrato/abc', com({ acao: 'previa' })],
        ['/api/admin/marketing/automacoes', com({ acao: 'simular' })],
        ['/api/admin/atendimento', com({ acao: 'sugerir' })],
        ['/api/desenvolvedor/empresas', com({ acao: 'previa' })],
    ];
    for (const [url, init] of casos) assert.equal(ehConsulta(url, init), true, url + ' ' + init.body);
});

test('o que altera algo nunca é consulta, mesmo na mesma rota', () => {
    const casos: Array<[string, RequestInit]> = [
        ['/api/admin/inteligencia/preparacoes', com({ acao: 'concluir' })],
        ['/api/admin/inteligencia/conversa', com({ texto: 'oi' })],
        ['/api/admin/inteligencia/importacoes', com({ acao: 'abrir' })],
        ['/api/admin/inteligencia/importacoes', com({ acao: 'retomar' })],
        ['/api/admin/inteligencia/importacoes', com({ acao: 'preparar' })],
        ['/api/admin/contratos/c1/financeiro/cronograma/reprogramar', com({})],
        ['/api/admin/contratos/c1/financeiro/tratamentos/t1/resolver', com({})],
        ['/api/admin/atendimento/prontas', com({ acao: 'publicar' })],
        ['/api/admin/exportacao', com({ tipo: 'completa' })],
        ['/api/admin/pagamentos', com({ plano: {} })],
        ['/api/admin/marketing/dominios', com({ acao: 'verificar' })],
        ['/api/admin/inteligencia/importacoes', com({ acao: 'descartar' })],
        ['/api/admin/contratos/importados/abc/integracao', com({ acao: 'confirmar' })],
        ['/api/admin/contratos/importados/abc/integracao', com({ acao: 'conferir-financeiro' })],
        ['/api/admin/configuracoes/tabelas-preco', com({ acao: 'publicar' })],
        ['/api/admin/configuracoes/modelo-contrato/abc', com({ acao: 'publicar' })],
        ['/api/admin/inteligencia/modelo-contrato?id=abc', { method: 'POST' }],
        ['/api/admin/marketing/automacoes', com({ acao: 'ativar' })],
        ['/api/admin/atendimento', com({ acao: 'responder' })],
        ['/api/desenvolvedor/empresas', com({ acao: 'provisionar' })],
        ['/api/admin/inteligencia', com({ capacidade: 'outra' })],
        ['/api/admin/inteligencia', com({ acao: 'atencao_hoje' })],
        ['/api/admin/inteligencia/operacoes', com({ decisao: 'confirmar' })],
        ['/api/admin/festas', com({ acao: 'simular' })],
    ];
    for (const [url, init] of casos) assert.equal(ehConsulta(url, init), false, url + ' ' + init.body);
});

test('corpo que não é texto JSON conta como escrita', () => {
    assert.equal(ehConsulta('/api/admin/inteligencia/importacoes', { method: 'POST', body: new FormData() }), false);
    assert.equal(ehConsulta('/api/admin/inteligencia/importacoes', { method: 'POST', body: '<html>' }), false);
    assert.equal(ehConsulta('/api/admin/inteligencia/importacoes', { method: 'POST', body: 'null' }), false);
    assert.equal(ehConsulta('/api/admin/inteligencia/importacoes', { method: 'POST' }), false);
});

test('aceita URL e Request, como o fetch', () => {
    assert.equal(ehConsulta(new URL('https://x.test/api/endereco/consultar-cep?a=1'), { method: 'POST' }), true);
    assert.equal(ehConsulta(new Request('https://x.test/api/endereco/consultar-cep', { method: 'POST' }), { method: 'POST' }), true);
    assert.equal(ehConsulta('/api/endereco/consultar-cep/outra', { method: 'POST' }), false);
});

test('barra final conta como a mesma rota; a raiz não some', () => {
    assert.equal(ehConsulta('/api/endereco/consultar-cep//', { method: 'POST' }), true);
    assert.equal(ehConsulta('/', { method: 'POST' }), false);
});

test('conversa: só a resposta diz se foi leitura', async () => {
    assert.equal(dependeDaResposta('/api/admin/inteligencia/conversa?empresaId=e'), true);
    assert.equal(dependeDaResposta('/api/admin/inteligencia/conversa/'), true);
    assert.equal(dependeDaResposta('/api/admin/inteligencia'), false);
    const resposta = (data: unknown, status = 200, ok = true) => new Response(JSON.stringify({ ok, data }), { status });
    for (const tipo of ['resposta', 'agente', 'precisa_contexto', 'navegacao']) assert.equal(await conversaSoLeu(resposta({ tipo })), true, tipo);
    for (const tipo of ['rascunho', 'preview', 'resultado_acao', 'nao_suportado', undefined]) assert.equal(await conversaSoLeu(resposta({ tipo })), false, String(tipo));
    assert.equal(await conversaSoLeu(resposta({ tipo: 'navegacao', proposta: { id: 1 } })), false);
    assert.equal(await conversaSoLeu(resposta({ tipo: 'resposta' }, 200, false)), false);
    assert.equal(await conversaSoLeu(resposta({ tipo: 'resposta' }, 500)), false);
    assert.equal(await conversaSoLeu(new Response('<html>')), false);
    const r = resposta({ tipo: 'resposta' });
    await conversaSoLeu(r);
    assert.deepEqual(await r.json(), { ok: true, data: { tipo: 'resposta' } });
});

test('as rotas da tabela ainda aceitam essas ações', () => {
    const fontes: Array<[string, RegExp]> = [
        ['app/api/admin/contratos/importados/[importacaoId]/integracao/route.ts', /z\.literal\('simular-financeiro'\)/],
        ['app/api/admin/configuracoes/tabelas-preco/route.ts', /z\.literal\("simular_festa"\)/],
        ['app/api/desenvolvedor/empresas/route.ts', /\`previa\` não escreve nada/],
        ['app/api/admin/contratos/[contratoId]/financeiro/[[...acao]]/route.ts', /a\[1\]==='simulacao'/],
        ['app/api/admin/contratos/[contratoId]/financeiro/[[...acao]]/route.ts', /a\[2\]==='simulacao'/],
        ['lib/inteligencia/importacao/revisao.ts', /entrada\.acao === "ler"/],
        ['lib/inteligencia/importacao/revisao.ts', /z\.literal\("simular-completa"\)/],
    ];
    for (const [arquivo, trecho] of fontes) assert.match(readFileSync(arquivo, 'utf8'), trecho, arquivo);
});
