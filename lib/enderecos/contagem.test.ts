import assert from 'node:assert/strict';
import test from 'node:test';
import { classificarHost, criarContagem, grupoDaRota } from './contagem.ts';

const envHosts = {
  ENDERECOS_ORIGEM_ANTIGA: 'https://manager.kidmaisfestas.com',
  ENDERECOS_ORIGEM_NOVA: 'https://iafest.demerzellabs.com.br',
};
const MINUTO = 60_000;

test('classifica hosts sem conservar o valor do cabeçalho', () => {
  for (const [host, classe] of [
    ['manager.kidmaisfestas.com', 'A'],
    ['iafest.demerzellabs.com.br', 'N'],
    ['MANAGER.KIDMAISFESTAS.COM.:443', 'A'],
    ['IAFEST.DEMERZELLABS.COM.BR:443', 'N'],
    ['servico.onrender.com', 'onrender'],
    ['cliente.exemplo.com.br', 'outro'],
    ['onrender.com', 'outro'],
    ['servico.onrender.com.exemplo.com', 'outro'],
    ['cliente.exemplo.com.br,manager.kidmaisfestas.com', 'sem_host'],
    ['127.0.0.1', 'sem_host'],
    ['', 'sem_host'],
    [null, 'sem_host'],
    [undefined, 'sem_host'],
  ] as const) {
    assert.equal(classificarHost(host, envHosts), classe, String(host));
  }
  assert.equal(classificarHost('manager.kidmaisfestas.com', {}), 'outro');
  assert.equal(classificarHost('servico.onrender.com', { ENDERECOS_ORIGEM_NOVA: 'https://servico.onrender.com' }), 'N');
  assert.equal(classificarHost('cliente.exemplo.com.br', { ENDERECOS_ORIGEM_ANTIGA: 'invalida' }), 'outro');
});

test('agrupa rotas por caminho, com precedência para MCP e segmentos de webhook', () => {
  for (const [caminho, grupo] of [
    ['/api/mcp', 'mcp'],
    ['/api/mcp/', 'mcp'],
    ['/.well-known/oauth-authorization-server', 'mcp'],
    ['/.well-known/oauth-protected-resource/api/mcp', 'mcp'],
    ['/api/webhook', 'webhook'],
    ['/api/integracoes/asaas/webhook', 'webhook'],
    ['/api/webhooks/entrega', 'webhook'],
    ['/api/mcp-v2', 'api'],
    ['/api/webhook-status', 'api'],
    ['/api/health', 'api'],
    ['/admin/webhook', 'pagina'],
    ['/apix/webhook', 'pagina'],
    ['/', 'pagina'],
  ] as const) {
    assert.equal(grupoDaRota('GET', caminho), grupo, caminho);
    assert.equal(grupoDaRota('POST', caminho), grupo, caminho);
  }
});

test('fecha uma janela no limite, ordena as chaves e conta o pedido de fechamento na próxima', () => {
  const { registrar } = criarContagem({ ENDERECOS_CONTAGEM_JANELA_MIN: '1' });
  assert.equal(registrar('N.mcp.passar', 0), undefined);
  assert.equal(registrar('A.pagina.passar', 1), undefined);
  assert.equal(registrar('N.mcp.passar', MINUTO - 1), undefined);
  assert.equal(registrar('outro.pagina.dominio', MINUTO),
    '[Kidmais Enderecos] CONTAGEM inicio=1970-01-01T00:00:00.000Z fim=1970-01-01T00:01:00.000Z total=3 A.pagina.passar=1 N.mcp.passar=2');
  assert.equal(registrar('A.pagina.limpeza', 4 * MINUTO),
    '[Kidmais Enderecos] CONTAGEM inicio=1970-01-01T00:01:00.000Z fim=1970-01-01T00:04:00.000Z total=1 outro.pagina.dominio=1');
});

test('limita as chaves, preserva contadores conhecidos e zera o excedente na próxima janela', () => {
  const hosts = ['A', 'N', 'onrender', 'outro', 'sem_host'] as const;
  const grupos = ['mcp', 'webhook', 'api', 'pagina'] as const;
  const resultados = ['passar', 'redirecionar', 'neutra', 'limpeza', 'dominio'] as const;
  const chaves = hosts.flatMap((host) => grupos.flatMap((grupo) =>
    resultados.map((resultado) => `${host}.${grupo}.${resultado}` as const)));
  const { registrar } = criarContagem({ ENDERECOS_CONTAGEM_JANELA_MIN: '1' });

  for (const chave of chaves) assert.equal(registrar(chave, 0), undefined);
  assert.equal(registrar('A.mcp.passar', 1), undefined);
  assert.equal(registrar('sem_host.pagina.dominio', 1), undefined);
  const linha = registrar('sem_host.pagina.dominio', MINUTO);
  assert.ok(linha);
  const campos = linha.split(' ').slice(6);
  assert.deepEqual(campos, [
    ...chaves.slice(0, 64).sort().map((chave) => `${chave}=${chave === 'A.mcp.passar' ? 2 : 1}`),
    'excedente=37',
  ]);
  assert.ok(linha.includes(' total=102 '));
  assert.match(registrar('A.mcp.passar', 2 * MINUTO) ?? '', / total=1 sem_host\.pagina\.dominio=1$/);
});

test('só o valor literal false desliga a contagem', () => {
  const desativada = criarContagem({ ENDERECOS_CONTAGEM: 'false' });
  assert.equal(desativada.registrar('A.pagina.passar', 0), undefined);
  assert.equal(desativada.registrar('A.pagina.passar', 15 * MINUTO), undefined);

  for (const valor of [undefined, 'true', '0', 'FALSE', ' false ']) {
    const { registrar } = criarContagem({ ENDERECOS_CONTAGEM: valor });
    assert.equal(registrar('A.pagina.passar', 0), undefined);
    assert.match(registrar('A.pagina.passar', 15 * MINUTO) ?? '', / total=1 A\.pagina\.passar=1$/);
  }
});

test('usa 15 minutos com configuração inválida e aceita o limite de 1440 minutos', () => {
  for (const valor of ['', '0', '-1', '1.5', '1e2', '0x10', '1441', 'texto']) {
    const { registrar } = criarContagem({ ENDERECOS_CONTAGEM_JANELA_MIN: valor });
    assert.equal(registrar('A.pagina.passar', 0), undefined);
    assert.equal(registrar('A.pagina.passar', 15 * MINUTO - 1), undefined, valor);
    assert.match(registrar('A.pagina.passar', 15 * MINUTO) ?? '', / total=2 A\.pagina\.passar=2$/, valor);
  }
  const { registrar } = criarContagem({ ENDERECOS_CONTAGEM_JANELA_MIN: '1440' });
  assert.equal(registrar('A.pagina.passar', 0), undefined);
  assert.equal(registrar('A.pagina.passar', 1440 * MINUTO - 1), undefined);
  assert.match(registrar('A.pagina.passar', 1440 * MINUTO) ?? '', / total=2 A\.pagina\.passar=2$/);
});

test('registra só os grupos, sem host, método, caminho ou query da requisição', () => {
  const pedido = new URL('https://cliente.exemplo.com.br/api/pedido-particular?busca=termo-reservado');
  const metodo = 'PATCH';
  const { registrar } = criarContagem({ ENDERECOS_CONTAGEM_JANELA_MIN: '1' });
  const chave = `${classificarHost(pedido.host, envHosts)}.${grupoDaRota(metodo, pedido.pathname)}.passar` as const;
  registrar(chave, 0);
  const linha = registrar(chave, MINUTO);
  assert.ok(linha);
  assert.match(linha, /^\[Kidmais Enderecos\] CONTAGEM [a-zA-Z0-9._=: -]+$/);
  assert.match(linha, / total=1 outro\.api\.passar=1$/);
  for (const valor of [pedido.host, metodo, pedido.pathname, pedido.search, 'termo-reservado']) {
    assert.equal(linha.includes(valor), false);
  }
});
