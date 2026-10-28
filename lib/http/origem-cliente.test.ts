import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BORDA_CONFIRMADA, JANELA_MARCAS_MS, MARCAS_POR_JANELA, ambienteDaOrigem, causaDoErro, chaveDaOrigem, formatoDaOrigem, ipPublico, normalizarIp, origemConfiavel, registrarFormatoDaOrigem } from './origem-cliente.ts';
import { NOME_APLICACAO_WEB, opcoesDaConexaoWeb, opcoesDoPool, POOL_PADRAO } from '../db/postgres.ts';

// Render com a borda provada (ORIGEM_CLIENTE_BORDA); só RENDER=true não basta (revisão de 22/10).
const RENDER = { RENDER: 'true', ORIGEM_CLIENTE_BORDA: BORDA_CONFIRMADA };
const req = (h: Record<string, string>) => ({ headers: { get: (n: string) => h[n.toLowerCase()] ?? null } });

// Formato observado no G1 em staging (22/10/2026): [forjado pelo cliente…, IP do cliente, salto público da infraestrutura].
const CLIENTE = '177.10.20.30', SALTO = '104.23.190.11', FORJADO = '203.0.113.9';
const render = (xff: string, extra: Record<string, string> = { 'cf-connecting-ip': CLIENTE }) => req({ 'x-forwarded-for': xff, ...extra });

test('origem: 3 valores (forjado, cliente, salto) → o PENÚLTIMO, conferido com CF-Connecting-IP', () => {
    assert.equal(origemConfiavel(render(`${FORJADO}, ${CLIENTE}, ${SALTO}`), RENDER), CLIENTE);
    assert.equal(origemConfiavel(render(`${FORJADO}, ${CLIENTE}, ${SALTO}`, { 'cf-connecting-ip': CLIENTE, 'true-client-ip': CLIENTE }), RENDER), CLIENTE);
    // Vários valores forjados à esquerda não mudam nada.
    assert.equal(origemConfiavel(render(`1.1.1.1, 8.8.8.8, ${CLIENTE}, ${SALTO}`), RENDER), CLIENTE);
});

test('origem: 2 valores (cliente, salto) sem forja → o cliente; 1 valor ou fora do Render → null', () => {
    assert.equal(origemConfiavel(render(`${CLIENTE}, ${SALTO}`), RENDER), CLIENTE);
    assert.equal(origemConfiavel(render(CLIENTE), RENDER), null, 'sem o salto não há como saber quem acrescentou');
    assert.equal(origemConfiavel(render(''), RENDER), null);
    assert.equal(origemConfiavel(render(`${CLIENTE}, ${SALTO}`), {}), null, 'fora do Render não há proxy confiável');
    assert.equal(origemConfiavel(render(`${CLIENTE}, ${SALTO}`), { RENDER: 'false', ORIGEM_CLIENTE_BORDA: BORDA_CONFIRMADA }), null);
});

test('origem: CF-Connecting-IP divergente, ausente ou inválido → null (nunca o último valor nem uma chave global)', () => {
    assert.equal(origemConfiavel(render(`${FORJADO}, ${CLIENTE}, ${SALTO}`, {}), RENDER), null, 'sem CF-Connecting-IP');
    assert.equal(origemConfiavel(render(`${FORJADO}, ${CLIENTE}, ${SALTO}`, { 'cf-connecting-ip': SALTO }), RENDER), null, 'igual ao último, não ao penúltimo');
    assert.equal(origemConfiavel(render(`${FORJADO}, ${CLIENTE}, ${SALTO}`, { 'cf-connecting-ip': '189.6.16.247' }), RENDER), null, 'forjado para outra empresa');
    assert.equal(origemConfiavel(render(`${FORJADO}, ${CLIENTE}, ${SALTO}`, { 'cf-connecting-ip': 'nao-e-ip' }), RENDER), null);
    // True-Client-IP, quando vem, precisa concordar; sozinho nunca decide.
    assert.equal(origemConfiavel(render(`${CLIENTE}, ${SALTO}`, { 'cf-connecting-ip': CLIENTE, 'true-client-ip': '189.6.16.247' }), RENDER), null);
    assert.equal(origemConfiavel(render(`${CLIENTE}, ${SALTO}`, { 'true-client-ip': CLIENTE }), RENDER), null);
    // Forja que tenta colocar o IP de outra empresa no penúltimo lugar só consegue isso sem passar pela borda;
    // aí CF-Connecting-IP não confere com o valor forjado e a origem é recusada.
    assert.equal(origemConfiavel(render(`189.6.16.247, ${CLIENTE}`, { 'cf-connecting-ip': CLIENTE }), RENDER), null);
});

test('origem: penúltimo não público ou inválido → null', () => {
    for (const cliente of ['10.1.2.3', '172.20.0.1', '192.168.0.10', '127.0.0.1', '100.64.1.1', '169.254.1.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::5', '2001:db8::1', FORJADO])
        assert.equal(origemConfiavel(render(`${cliente}, ${SALTO}`, { 'cf-connecting-ip': cliente }), RENDER), null, cliente);
    assert.equal(origemConfiavel(render(`nao-e-ip, ${SALTO}`), RENDER), null);
    assert.ok(ipPublico('8.8.8.8') && ipPublico('2804:14c:1::1') && !ipPublico('224.0.0.1'));
});

test('origem: IPv6 do cliente (normalizado) com salto IPv4 ou IPv6', () => {
    assert.equal(origemConfiavel(render(`${FORJADO}, 2804:14C:65:A1::1, ${SALTO}`, { 'cf-connecting-ip': '2804:14c:65:a1::1' }), RENDER), '2804:14c:65:a1::1');
    assert.equal(origemConfiavel(render('[2804:14c:65:a1::1], 2606:4700::6810:1', { 'cf-connecting-ip': '2804:14c:65:a1:0:0:0:1' }), RENDER), null, 'grafias diferentes do mesmo IPv6 não são normalizadas para igualdade: recusa segura');
    assert.equal(origemConfiavel(render('::ffff:177.10.20.30, 2606:4700::6810:1', { 'cf-connecting-ip': CLIENTE }), RENDER), CLIENTE);
});

test('origem: normalização e agrupamento IPv6 por /64', () => {
    assert.equal(normalizarIp('::ffff:177.10.20.30'), '177.10.20.30');
    assert.equal(normalizarIp(' [2804:14C:65::1] '), '2804:14c:65::1');
    assert.equal(normalizarIp('177.10.20.30:443'), null);
    assert.equal(chaveDaOrigem('177.10.20.30'), '177.10.20.30');
    assert.equal(chaveDaOrigem('2804:14c:65:a1::1'), '2804:14c:65:a1::/64');
    assert.equal(chaveDaOrigem('2804:14c:65:a1:ffff:1:2:3'), '2804:14c:65:a1::/64');
    assert.equal(chaveDaOrigem('2804:14c::9'), '2804:14c:0:0::/64');
    assert.notEqual(chaveDaOrigem('2804:14c:65:a1::1'), chaveDaOrigem('2804:14c:65:a2::1'));
});

test('formato da origem: posições contadas do fim e classes, sem nenhum endereço', () => {
    const g1 = formatoDaOrigem(render(`${FORJADO}, ${CLIENTE}, ${SALTO}`, { 'cf-connecting-ip': CLIENTE, 'true-client-ip': CLIENTE }), RENDER);
    assert.deepEqual(g1, { render: true, bordaConfirmada: true, valoresNoEncaminhamento: 3, vazios: 0, penultimo: 'publico', ultimo: 'publico', cfConnectingIp: 2, trueClientIp: 2, aceito: true });
    const outro = formatoDaOrigem(render(`${CLIENTE}, 10.0.0.1`, { 'cf-connecting-ip': SALTO, 'true-client-ip': 'x' }), RENDER);
    assert.deepEqual(outro, { render: true, bordaConfirmada: true, valoresNoEncaminhamento: 2, vazios: 0, penultimo: 'publico', ultimo: 'nao-publico', cfConnectingIp: 'fora-da-lista', trueClientIp: 'invalido', aceito: false });
    // Elemento vazio aparece na contagem e na classe (não é compactado).
    const vazio = formatoDaOrigem(render(`${CLIENTE}, ,${SALTO}`), RENDER);
    assert.deepEqual([vazio.valoresNoEncaminhamento, vazio.vazios, vazio.penultimo, vazio.aceito], [3, 1, 'vazio', false]);
    // Sem a borda confirmada: o diagnóstico mostra as posições, mas nunca aceita.
    const semBorda = formatoDaOrigem(render(`${FORJADO}, ${CLIENTE}, ${SALTO}`), { RENDER: 'true' });
    assert.deepEqual([semBorda.render, semBorda.bordaConfirmada, semBorda.cfConnectingIp, semBorda.aceito], [true, false, 2, false]);
    assert.equal(formatoDaOrigem(req({}), RENDER).cfConnectingIp, 'ausente');
    assert.equal(formatoDaOrigem(req({}), RENDER).penultimo, 'ausente');
    const linhas: string[] = [];
    registrarFormatoDaOrigem(render(`${CLIENTE}, 10.0.0.1`), null, RENDER, (m) => linhas.push(m));
    registrarFormatoDaOrigem(render(`${CLIENTE}, ${SALTO}`), CLIENTE, RENDER, (m) => linhas.push(m));
    assert.equal(linhas.length, 1, 'formato normal: uma vez por processo');
    assert.match(linhas[0], /origem não confiável/);
    assert.doesNotMatch(linhas.join('\n'), /177\.10|10\.0\.0|104\.23|203\.0/);
});

test('borda não comprovada: forja coerente [forjado, salto] com CF igual ao forjado → null sem ORIGEM_CLIENTE_BORDA', () => {
    // Reprodução da revisão: indistinguível da lista legítima quando ambos os cabeçalhos vêm do remetente.
    const forja = render('8.8.8.8, 104.23.190.11', { 'cf-connecting-ip': '8.8.8.8' });
    const forjaTci = render('8.8.8.8, 104.23.190.11', { 'cf-connecting-ip': '8.8.8.8', 'true-client-ip': '8.8.8.8' });
    for (const env of [{ RENDER: 'true' }, { RENDER: 'true', ORIGEM_CLIENTE_BORDA: '' }, { RENDER: 'true', ORIGEM_CLIENTE_BORDA: 'true' }, { RENDER: 'true', ORIGEM_CLIENTE_BORDA: `${BORDA_CONFIRMADA} ` }, { ORIGEM_CLIENTE_BORDA: BORDA_CONFIRMADA }]) {
        assert.equal(origemConfiavel(forja, env), null, JSON.stringify(env));
        assert.equal(origemConfiavel(forjaTci, env), null, JSON.stringify(env));
        assert.equal(origemConfiavel(render(`${FORJADO}, ${CLIENTE}, ${SALTO}`), env), null, 'nem a lista legítima sem a confirmação');
    }
    // A confirmação vem do ambiente do processo, não de cabeçalho.
    assert.deepEqual(ambienteDaOrigem({ RENDER: 'true', ORIGEM_CLIENTE_BORDA: BORDA_CONFIRMADA, OUTRA: 'x' }), RENDER);
    assert.equal(origemConfiavel(req({ 'x-forwarded-for': `${CLIENTE}, ${SALTO}`, 'cf-connecting-ip': CLIENTE, 'origem-cliente-borda': BORDA_CONFIRMADA }), { RENDER: 'true' }), null);
});

test('estrutura: vírgula vazia, último inválido ou não público → null; espaços e prefixos do cliente continuam aceitos', () => {
    for (const xff of [`${CLIENTE}, ,${SALTO}`, `${CLIENTE},,${SALTO}`, `${CLIENTE}, ${SALTO},`, `, ${CLIENTE}, ${SALTO}`, `${FORJADO}, , ${CLIENTE}, ${SALTO}`,
        `${CLIENTE}, lixo`, `${CLIENTE}, 10.0.0.1`, `${CLIENTE}, 192.168.1.1`, `${CLIENTE}, ${FORJADO}`, `${CLIENTE}, fe80::1`, `${CLIENTE}, ${SALTO}:443`, ' , '])
        assert.equal(origemConfiavel(render(xff), RENDER), null, xff);
    // Espaços válidos ao redor dos valores e prefixos arbitrários (forjados, até inválidos) do cliente continuam aceitos.
    assert.equal(origemConfiavel(render(`  ${CLIENTE}  ,${SALTO}  `), RENDER), CLIENTE);
    assert.equal(origemConfiavel(render(`${FORJADO},${CLIENTE},${SALTO}`), RENDER), CLIENTE);
    assert.equal(origemConfiavel(render(`lixo, 10.0.0.1, ${CLIENTE}, ${SALTO}`), RENDER), CLIENTE);
    assert.equal(origemConfiavel(render(`${CLIENTE}, 2606:4700::6810:1`), RENDER), CLIENTE, 'salto IPv6 público');
});

test('marca de diagnóstico do G1: força a linha e entra nela; formato fora de [A-Za-z0-9-]{8,64} é ignorado', () => {
    const linhas: string[] = [];
    const log = (m: string) => linhas.push(m);
    const comMarca = (marca: string) => render(`${FORJADO}, ${CLIENTE}, ${SALTO}`, { 'cf-connecting-ip': CLIENTE, 'x-kidmais-diagnostico': marca });
    registrarFormatoDaOrigem(render(`${CLIENTE}, ${SALTO}`), CLIENTE, RENDER, log); // garante que a 1ª linha do processo já saiu
    linhas.length = 0;
    registrarFormatoDaOrigem(comMarca('g1-7f3a9c2e'), CLIENTE, RENDER, log);
    assert.equal(linhas.length, 1, 'com marca, a linha sai mesmo depois da primeira do processo');
    const json = JSON.parse(linhas[0].slice(linhas[0].indexOf('{')));
    assert.deepEqual(json, { render: true, bordaConfirmada: true, valoresNoEncaminhamento: 3, vazios: 0, penultimo: 'publico', ultimo: 'publico', cfConnectingIp: 2, trueClientIp: 'ausente', aceito: true, marca: 'g1-7f3a9c2e' });
    for (const ruim of ['curta', 'a'.repeat(65), 'tem espaço aqui', 'g1\n[origem] falso', '177.10.20.30', 'x"}{"aceito":true'])
        registrarFormatoDaOrigem(comMarca(ruim), CLIENTE, RENDER, log);
    assert.equal(linhas.length, 1, 'marca inválida não força linha');
    registrarFormatoDaOrigem(comMarca('177-10-20-30-x'), null, RENDER, log);
    assert.doesNotMatch(linhas.join('\n'), /177\.10|104\.23|203\.0/, 'nenhum endereço no log');
});

test('P3-R3-3: marca repetida mil vezes gera no máximo MARCAS_POR_JANELA linhas por janela; nova janela libera de novo', () => {
    const linhas: string[] = [];
    const log = (m: string) => linhas.push(m);
    let t = Date.now() + 3_600_000; // à frente das janelas usadas pelos outros testes deste processo
    const pedido = render(`${FORJADO}, ${CLIENTE}, ${SALTO}`, { 'cf-connecting-ip': CLIENTE, 'x-kidmais-diagnostico': 'g1-repetida-01' });
    for (let i = 0; i < 1000; i++)
        registrarFormatoDaOrigem(pedido, CLIENTE, RENDER, log, () => t);
    assert.equal(linhas.length, MARCAS_POR_JANELA);
    assert.ok(linhas.every((l) => l.includes('"marca":"g1-repetida-01"')));
    t += JANELA_MARCAS_MS;
    registrarFormatoDaOrigem(pedido, CLIENTE, RENDER, log, () => t);
    assert.equal(linhas.length, MARCAS_POR_JANELA + 1, 'janela seguinte: a marca volta a valer (o G1 continua correlacionável)');
    // Recusadas continuam registradas (comportamento anterior), mas sem a marca acima do teto.
    for (let i = 0; i < MARCAS_POR_JANELA; i++)
        registrarFormatoDaOrigem(pedido, CLIENTE, RENDER, () => undefined, () => t);
    registrarFormatoDaOrigem(render(`${CLIENTE}, 10.0.0.1`, { 'x-kidmais-diagnostico': 'g1-repetida-01' }), null, RENDER, log, () => t);
    assert.match(linhas.at(-1)!, /"marca":null/);
});

test('causa do 500 vai ao log sem e-mail e sem texto longo', () => {
    const c = causaDoErro(Object.assign(new Error('timeout exceeded when trying to connect para pessoa@exemplo.test'), { code: 'ETIMEDOUT' }));
    assert.deepEqual(c, { nome: 'Error', codigo: 'ETIMEDOUT', mensagem: 'timeout exceeded when trying to connect para <email>' });
    assert.equal(causaDoErro(undefined).nome, 'undefined');
    assert.ok((causaDoErro(new Error('x'.repeat(999))).mensagem ?? '').length <= 200);
});

test('pool: padrão 30 / 10 s, valor inválido cai no padrão, teto 40', () => {
    assert.deepEqual(opcoesDoPool({}), { max: 30, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
    assert.equal(opcoesDoPool({ DATABASE_POOL_MAX: '12' }).max, 12);
    assert.equal(opcoesDoPool({ DATABASE_POOL_MAX: '500' }).max, POOL_PADRAO.teto);
    for (const ruim of ['0', '-1', 'abc', '1e3', ''])
        assert.equal(opcoesDoPool({ DATABASE_POOL_MAX: ruim }).max, 30, ruim);
    assert.equal(opcoesDoPool({ DATABASE_CONNECTION_TIMEOUT_MS: 'NaN' }).connectionTimeoutMillis, 10_000);
});

test('pool do web: identifica-se como kidmais-web (B-14, prova de drenagem) sem mudar o resto', () => {
    assert.equal(NOME_APLICACAO_WEB, 'kidmais-web');
    assert.deepEqual(opcoesDaConexaoWeb({ DATABASE_POOL_MAX: '12' }), { application_name: 'kidmais-web', ...opcoesDoPool({ DATABASE_POOL_MAX: '12' }) });
});

test('rota de login passa o IP confiável (não null) e o serviço não tem chave global de origem', () => {
    const rota = readFileSync('app/api/admin/autenticacao/route.ts', 'utf8');
    assert.match(rota, /loginAdmin\(body\.data\.email, body\.data\.senha, randomUUID\(\), ip, userAgent\)/);
    assert.match(rota, /reautenticarAdmin\(tokenAdmin\(request\), body\.data\.senha, ip, userAgent\)/);
    const servico = readFileSync('lib/autenticacao/service.ts', 'utf8');
    const login = servico.slice(servico.indexOf('export async function loginAdmin('), servico.indexOf('export async function logoutAdmin'));
    assert.doesNotMatch(login, /ORIGEM_NAO_VERIFICADA/);
    // O scrypt roda fora de transação: conferirSenha aparece antes da transação do resultado, não dentro de outra.
    const antes = login.slice(0, login.indexOf('conferirSenha('));
    assert.equal((antes.match(/withTransaction\(/g) ?? []).length, 1, 'só a transação curta dos limites antes do scrypt');
    assert.ok(antes.lastIndexOf('});') > antes.lastIndexOf('withTransaction('), 'a transação dos limites termina antes do scrypt');
});
