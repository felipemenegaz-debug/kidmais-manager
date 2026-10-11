/* eslint-disable @typescript-eslint/no-require-imports */
// Testes offline do seed do navegador local: nenhuma conexão, nenhum servidor, nenhuma rede.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const s = require('./navegador-local-seed.cjs');

const raiz = path.resolve(__dirname, '..');
const codigo = fn => { try { fn(); return 'OK'; } catch (e) { return e.message; } };
const autorizacao = texto => ({[s.VAR_AUTORIZACAO]:texto});

test('modo: plano por padrão; execução só com a flag única', () => {
    assert.equal(s.modo([]), 'PLANO');
    assert.equal(s.modo(['--plano']), 'PLANO');
    assert.equal(s.modo([s.FLAG]), 'EXECUTAR');
    for (const argv of [[s.FLAG, '--plano'], ['--seed'], [s.FLAG, s.FLAG], ['--aplicar']]) assert.equal(s.modo(argv), null);
});

test('alvo: só 127.0.0.1/localhost, porta 55481 e banco kidmais_navegador_*', () => {
    assert.equal(codigo(() => s.alvo({})), 'AUTORIZACAO_AUSENTE');
    assert.equal(codigo(() => s.alvo(autorizacao('kidmais_navegador_x'))), 'AUTORIZACAO_MALFORMADA');
    assert.equal(codigo(() => s.alvo(autorizacao('postgresql://127.0.0.1:55481/kidmais_navegador_x'))), 'AUTORIZACAO_MALFORMADA');
    assert.equal(codigo(() => s.alvo(autorizacao('10.0.0.5:55481/kidmais_navegador_x'))), 'HOST_RECUSADO');
    assert.equal(codigo(() => s.alvo(autorizacao('dpg-exemplo.oregon-postgres.render.com:55481/kidmais_navegador_x'))), 'HOST_RECUSADO');
    assert.equal(codigo(() => s.alvo(autorizacao('127.0.0.1:5432/kidmais_navegador_x'))), 'PORTA_RECUSADA');
    assert.equal(codigo(() => s.alvo(autorizacao('127.0.0.1:55480/kidmais_navegador_x'))), 'PORTA_RECUSADA');
    for (const banco of ['kidmais_manager', 'kidmais_navegador_kidmais_manager', 'kidmais_navegador_staging', 'kidmais_navegador_production', 'kidmais_navegador_producao'])
        assert.equal(codigo(() => s.alvo(autorizacao(`127.0.0.1:55481/${banco}`))), 'BANCO_PROIBIDO', banco);
    for (const banco of ['kidmais_concorrencia_x', 'postgres', 'kidmais_navegador_', 'Kidmais_navegador_x'])
        assert.equal(codigo(() => s.alvo(autorizacao(`127.0.0.1:55481/${banco}`))), 'BANCO_FORA_DO_PADRAO', banco);
    assert.deepEqual({...s.alvo(autorizacao('localhost:55481/kidmais_navegador_20261010'))}, {host:'127.0.0.1', porta:55481, banco:'kidmais_navegador_20261010'});
});

test('conexão herdada: PG* sempre recusadas; DATABASE_URL só se for exatamente o mesmo alvo', () => {
    const a = s.alvo(autorizacao('127.0.0.1:55481/kidmais_navegador_20261010'));
    assert.equal(codigo(() => s.semConexaoHerdada({PGPASSWORD:'x'}, a)), 'CONEXAO_HERDADA PGPASSWORD');
    assert.equal(codigo(() => s.semConexaoHerdada({pghost:'x'}, a)), 'CONEXAO_HERDADA pghost');
    const recusada = ['postgresql://u:p@dpg-exemplo.render.com:5432/kidmais_staging_1z91', 'postgresql://127.0.0.1:5432/kidmais_manager',
        'postgresql://127.0.0.1:55481/kidmais_navegador_outro', 'postgresql://127.0.0.1:55480/kidmais_navegador_20261010', 'nao-e-url', 'mysql://127.0.0.1:55481/kidmais_navegador_20261010'];
    for (const url of recusada) {
        let erro = null;
        try { s.semConexaoHerdada({DATABASE_URL:url}, a); } catch (e) { erro = e; }
        assert.equal(erro?.codigo, 'DATABASE_URL_DIVERGENTE', url);
        assert.ok(!erro.message.includes(url), 'mensagem não repete o valor');
    }
    assert.doesNotThrow(() => s.semConexaoHerdada({DATABASE_URL:'postgresql://kidmais_navegador@127.0.0.1:55481/kidmais_navegador_20261010'}, a));
    assert.doesNotThrow(() => s.semConexaoHerdada({PATH:'x'}, a));
});

test('prazos comerciais herdados são recusados (mudariam o teste expirado)', () => {
    assert.equal(codigo(() => s.semPrazoComercialHerdado({ASSINATURA_SOMENTE_LEITURA_DIAS:'365'})), 'PRAZO_COMERCIAL_HERDADO ASSINATURA_SOMENTE_LEITURA_DIAS');
    assert.doesNotThrow(() => s.semPrazoComercialHerdado({PATH:'x'}));
});

test('identidade do servidor: banco, papel, 127.0.0.1, porta, cluster_name e cluster novo', () => {
    const a = s.alvo(autorizacao('127.0.0.1:55481/kidmais_navegador_20261010'));
    const linha = {db:'postgres', papel:'kidmais_navegador', endereco:'127.0.0.1', porta:55481, cluster:'kidmais_navegador', bancos:[]};
    assert.equal(s.conferirIdentidade(linha, a, 'postgres', []), true);
    for (const divergente of [{cluster:'kidmais_concorrencia'}, {papel:'postgres'}, {endereco:'10.0.0.5'}, {porta:5432}, {bancos:['kidmais_manager']}, {db:'kidmais_manager'}])
        assert.equal(codigo(() => s.conferirIdentidade({...linha, ...divergente}, a, 'postgres', [])), 'IDENTIDADE_DIVERGENTE', JSON.stringify(divergente));
    assert.equal(codigo(() => s.conferirIdentidade(undefined, a, 'postgres', [])), 'IDENTIDADE_DIVERGENTE');
});

test('pasta local de credenciais é ignorada pelo Git (regra .local-*/ do repositório)', () => {
    assert.equal(s.conferirGitignore(fs.readFileSync(path.join(raiz, '.gitignore'), 'utf8')).ignorada, true);
    assert.equal(s.conferirGitignore('.local-*/\n!.local-navegador/\n').ignorada, false);
    assert.equal(s.conferirGitignore('node_modules/\n').ignorada, false);
    assert.equal(s.ARQUIVO_CREDENCIAIS, path.join(raiz, '.local-navegador', 'credenciais.json'));
});

test('sanitizar remove senhas, e-mails, UUIDs e tokens, preservando códigos de recusa', () => {
    const senha = s.gerarSenha();
    const texto = `falhou ${senha} nav-x@example.invalid 0b7c6a52-3a7e-4f0e-9a0e-4c3f1d2e5b6a ${'a1'.repeat(16)} SCHEMA_DIVERGENTE_DO_PACOTE`;
    const limpo = s.sanitizar(texto);
    assert.ok(!limpo.includes(senha) && !limpo.includes('@example') && !limpo.includes('0b7c6a52'));
    assert.ok(limpo.includes('SCHEMA_DIVERGENTE_DO_PACOTE'));
});

test('senhas sintéticas: válidas para o login (8–128) e diferentes a cada geração', () => {
    const senhas = Array.from({length:50}, () => s.gerarSenha());
    assert.equal(new Set(senhas).size, 50);
    for (const x of senhas) assert.ok(x.length >= 8 && x.length <= 128 && /^Nav-[A-Za-z0-9_-]+$/.test(x));
});

test('fixtures cobrem a matriz do navegador; contas só em example.invalid', () => {
    const tipos = Object.fromEntries(s.EMPRESAS.map(e => [e.chave, [e.tipo, e.plano]]));
    assert.deepEqual(tipos, {essencial:['PLANO', 'essencial'], profissional:['PLANO', 'profissional'], premium:['PLANO', 'premium'],
        teste:['TESTE', null], isenta:['ISENTA', null], expirada:['TESTE_EXPIRADO', null]});
    assert.deepEqual(s.EMPRESAS.filter(e => e.catalogo).map(e => e.chave), ['essencial', 'profissional', 'premium']);
    assert.deepEqual(s.EMPRESAS.filter(e => e.renovacao).map(e => e.chave), ['premium']);
    for (const e of s.EMPRESAS) {
        assert.match(e.codigo, /^[a-z][a-z0-9-]{1,62}[a-z0-9]$/);
        assert.ok(s.CONTAS.some(c => c.empresas[0] === e.chave && c.papel === 'REPRESENTANTE_AUTORIZADO'), 'Gestão de ' + e.chave);
    }
    assert.ok(s.CONTAS.some(c => c.empresas.length === 2), 'conta com seleção de empresa');
    assert.equal(s.CONTAS.filter(c => c.empresas.includes('essencial')).length, 2, 'Gestão + Equipe; o convite completa 3/3');
    for (const email of [...s.CONTAS.map(c => c.email), s.EMAIL_CONVITE_ESSENCIAL]) assert.match(email, /^nav-[a-z-]+@example\.invalid$/);
});

test('credenciais: uma senha por conta, endereços públicos com o resultado esperado, nada fora de localhost', () => {
    const a = s.alvo(autorizacao('127.0.0.1:55481/kidmais_navegador_20261010'));
    const senhas = new Map(s.CONTAS.map(c => [c.rotulo, s.gerarSenha()]));
    const d = s.montarCredenciais(a, senhas, new Date('2026-10-10T12:00:00Z'));
    assert.equal(d.contas.length, s.CONTAS.length);
    for (const c of d.contas) assert.equal(c.senha, senhas.get(c.rotulo));
    assert.equal(d.origem, 'http://localhost:3481');
    assert.deepEqual(d.enderecosPublicos.map(e => [e.codigo, e.esperado]), [['nav-essencial', 404], ['nav-profissional', 200], ['nav-premium', 200]]);
    for (const e of d.enderecosPublicos) assert.ok(e.fechamento.startsWith('http://localhost:3481/b/') && e.disponibilidade.startsWith('http://localhost:3481/b/'));
});

test('credenciais: grava com 0600 e nunca sobrescreve', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kidmais-nav-'));
    try {
        const arquivo = path.join(dir, 'sub', 'credenciais.json');
        s.escreverCredenciais(arquivo, {x:1});
        assert.deepEqual(JSON.parse(fs.readFileSync(arquivo, 'utf8')), {x:1});
        if (process.platform !== 'win32') assert.equal(fs.statSync(arquivo).mode & 0o777, 0o600);
        assert.throws(() => s.escreverCredenciais(arquivo, {x:2}), e => e.code === 'EEXIST');
        assert.deepEqual(JSON.parse(fs.readFileSync(arquivo, 'utf8')), {x:1});
    } finally { fs.rmSync(dir, {recursive:true, force:true}); }
});

test('plano offline: inventário aprovado (076/077/078 incluídas) com checks, impressão fixada no pacote', async () => {
    const p = await s.plano();
    assert.equal(p.impressao, s.IMPRESSAO_SCHEMA, 'migrations/checks mudaram: revisar o pacote');
    assert.equal(p.ultima, '20261011_079_convite_recuperacao_manual.sql');
    const fim = p.etapas.slice(-4);
    assert.deepEqual(fim.map(e => [e.antes, e.migration, e.depois]), [
        [['database/checks/20261010_076_precheck.sql'], 'database/migrations/20261010_076_cpf_por_empresa.sql', ['database/checks/20261010_076_postcheck.sql']],
        [['database/checks/20261010_077_precheck.sql'], 'database/migrations/20261010_077_regras_pagamento_empresa.sql', ['database/checks/20261010_077_postcheck.sql']],
        [['database/checks/20261010_078_precheck.sql'], 'database/migrations/20261010_078_catalogo_buffet_por_empresa.sql', ['database/checks/20261010_078_postcheck.sql']],
        [['database/checks/20261011_079_precheck.sql'], 'database/migrations/20261011_079_convite_recuperacao_manual.sql', ['database/checks/20261011_079_postcheck.sql']]]);
    assert.equal(new Set(p.etapas.map(e => e.migration)).size, p.etapas.length, 'nenhuma migration duplicada');
});

test('documento sintético: 14 dígitos iniciados por 7, sem repetição (A2 de 10/10 falhou com readUIntBE de 7 bytes)', () => {
    const usados = new Set();
    for (let i = 0; i < 1000; i++) assert.match(s.documentoSintetico(usados), /^7\d{13}$/);
    assert.equal(usados.size, 1000);
});

test('clientes sintéticos: CPF válido pela regra do servidor, contatos não roteáveis, A ≠ B; só no arquivo ignorado', async () => {
    const {pathToFileURL} = require('node:url');
    const {carregarModulo} = await import(pathToFileURL(path.join(raiz, 'lib/acessos/teste-carregador.ts')).href);
    const {cpfValido} = carregarModulo(path.join(raiz, 'lib/clientes/utils.ts'), {}, new Map());
    for (let i = 0; i < 300; i++) { const cpf = s.gerarCpfSintetico(); assert.ok(cpfValido(cpf), cpf.slice(0, 3)); assert.notEqual(new Set(cpf).size, 1); }
    const [a, b] = s.clientesSinteticos();
    assert.notEqual(a.cpf, b.cpf);
    for (const c of [a, b]) {
        assert.match(c.email, /@example\.invalid$/);
        assert.match(c.whatsapp, /^11900000\d{3}$/);
        assert.equal(c.cep, '01001000', 'CEP digitado; consulta externa desligada no servidor local');
    }
    const d = s.montarCredenciais({host:'127.0.0.1', porta:55481, banco:'kidmais_navegador_x'}, new Map(), new Date('2026-10-10T12:00:00Z'), [a, b]);
    assert.deepEqual(d.clientesSinteticos.map(c => c.rotulo), ['A', 'B']);
    assert.equal(d.enderecoLegado.fechamento, `${s.ORIGEM_APP}/fechamento`);
});

test('dados de isolamento: Profissional e Premium com preço, composição, adicional e regras diferentes', () => {
    assert.notEqual(s.PRECO_POCKET.profissional, s.PRECO_POCKET.premium);
    // Disponibilidade por empresa: o Profissional vende o Pocket no sábado (6) e no domingo (7); o Premium, só em dias úteis.
    assert.ok(s.DIAS_POCKET.profissional.includes(6) && !s.DIAS_POCKET.premium.includes(6), 'sábado só no Profissional');
    assert.ok([...s.DIAS_POCKET.profissional, ...s.DIAS_POCKET.premium].every(d => Number.isInteger(d) && d >= 1 && d <= 7), 'dia ISO 1..7');
    // 078: a MESMA categoria (SALGADOS) nas duas empresas, com itens diferentes (catálogo próprio de cada uma).
    const categorias = chave => s.COMPOSICAO[chave].map(([codigo]) => codigo);
    assert.ok(categorias('profissional').includes('SALGADOS') && categorias('premium').includes('SALGADOS'), 'mesma categoria nas duas');
    const itens = chave => s.COMPOSICAO[chave].flatMap(([, , , lista]) => lista);
    assert.deepEqual(itens('profissional').filter(i => itens('premium').includes(i)), [], 'itens diferentes');
    for (const [, , escolhas, lista] of [...s.COMPOSICAO.profissional, ...s.COMPOSICAO.premium]) assert.ok(escolhas >= 1 && escolhas <= lista.length);
    const fonte078 = fs.readFileSync(path.join(__dirname, 'navegador-local-seed.cjs'), 'utf8');
    assert.match(fonte078, /s\.catalogoBuffet\.criarCategoriaBuffet\(tx, empresaId, nome, true, codigo\)/, 'catálogo pelo serviço com escopo');
    assert.doesNotMatch(fonte078, /FROM buffet_categorias WHERE ativo AND codigo = ANY/, 'nunca pega as categorias da Kidmais');
    assert.notEqual(s.ADICIONAL_EMPRESA.profissional.nome, s.ADICIONAL_EMPRESA.premium.nome);
    assert.notEqual(s.ADICIONAL_EMPRESA.profissional.preco, s.ADICIONAL_EMPRESA.premium.preco);
    assert.ok(s.REGRAS_PROFISSIONAL.pixAvista > 0, 'Premium fica com regras neutras (0%)');
    const fonte = fs.readFileSync(path.join(__dirname, 'navegador-local-seed.cjs'), 'utf8');
    assert.doesNotMatch(fonte, /INSERT INTO empresas[^;]*'kidmais'/, 'a empresa kidmais vem da 046; o seed nunca a insere');
    assert.match(fonte, /SELECT id::text AS id FROM empresas WHERE codigo = 'kidmais' AND status = 'ATIVA'/);
});
