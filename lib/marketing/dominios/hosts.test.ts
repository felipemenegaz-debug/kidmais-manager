import assert from 'node:assert/strict';
import test from 'node:test';
import { alvoDns, caminhoNoDominio, hostReservado, instrucoesDns, normalizarHost, rotear } from './hosts.ts';

const LIGADO = { MARKETING_DOMINIOS_PERSONALIZADOS: 'true', ADMIN_AUTH_ORIGIN: 'https://manager.exemplo.com.br', SITE_URL: 'https://kidmais.exemplo.com.br' };

test('Host: normaliza porta, caixa e ponto final; recusa lista, credencial, IP e formato inválido', () => {
  assert.equal(normalizarHost('Festas.Buffet.com.br:443'), 'festas.buffet.com.br');
  assert.equal(normalizarHost('buffet-alfa.test.'), 'buffet-alfa.test');
  for (const ruim of [null, '', 'a,b.com', 'user@buffet.com', '10.0.0.1', '[::1]', 'semponto', '-x.com', 'buffet..com', 'a/b.com', 'x'.repeat(64) + '.com'])
    assert.equal(normalizarHost(ruim), null, String(ruim));
});

test('proxy desligado por padrão: qualquer Host segue para a plataforma (nada muda no deploy sem configuração)', () => {
  assert.deepEqual(rotear('festas.buffet.com.br', '/', {}), { tipo: 'PLATAFORMA' });
  assert.deepEqual(rotear('festas.buffet.com.br', '/admin', { MARKETING_DOMINIOS_PERSONALIZADOS: 'false' }), { tipo: 'PLATAFORMA' });
});

test('proxy ligado: hosts da plataforma inalterados; domínio vai para /sd/<host>; painel e APIs nunca abrem pelo domínio', () => {
  for (const host of ['manager.exemplo.com.br', 'kidmais.exemplo.com.br', 'localhost:3000', '127.0.0.1:3000'])
    assert.deepEqual(rotear(host, '/admin', LIGADO), { tipo: 'PLATAFORMA' }, host);
  assert.deepEqual(rotear('festas.buffet.com.br', '/', LIGADO), { tipo: 'DOMINIO', host: 'festas.buffet.com.br', destino: '/sd/festas.buffet.com.br' });
  assert.equal((rotear('festas.buffet.com.br', '/robots.txt', LIGADO) as { destino: string }).destino, '/sd/festas.buffet.com.br/robots.txt');
  assert.equal((rotear('festas.buffet.com.br', '/c/nov-centro', LIGADO) as { destino: string }).destino, '/sd/festas.buffet.com.br/c/nov-centro');
  for (const caminho of ['/admin', '/admin/marketing', '/api/admin/marketing/site', '/clientes', '/s/outro-buffet', '/sd/outro.com', '/b/empresa/fechamento'])
    assert.equal((rotear('festas.buffet.com.br', caminho, LIGADO) as { destino: string }).destino, '/sd/festas.buffet.com.br/404', caminho);
  assert.deepEqual(rotear('festas.buffet.com.br', '/_next/static/x.js', LIGADO), { tipo: 'PASSAR' });
  assert.deepEqual(rotear('festas.buffet.com.br', '/api/publico/marketing/alegria/contato', LIGADO), { tipo: 'PASSAR' });
  const invalido = rotear('a,b.com', '/', LIGADO) as { tipo: string; destino: string };
  assert.equal(invalido.tipo, 'DOMINIO');
  assert.match(invalido.destino, /\/404$/);
});

test('/sd/... direto (destino interno da reescrita) é 404 em qualquer Host, com o proxy ligado ou não', () => {
  for (const env of [{}, LIGADO])
    for (const host of ['localhost:3000', 'manager.exemplo.com.br', null])
      for (const caminho of ['/sd', '/sd/festas.buffet.com.br', '/sd/festas.buffet.com.br/robots.txt'])
        assert.deepEqual(rotear(host, caminho, env), { tipo: 'DOMINIO', host: 'host-invalido.invalid', destino: '/sd/host-invalido.invalid/404' }, `${host} ${caminho}`);
  assert.deepEqual(rotear('localhost:3000', '/sdx', LIGADO), { tipo: 'PLATAFORMA' });
});

test('hosts reservados da plataforma não podem ser cadastrados por empresa', () => {
  assert.equal(hostReservado('manager.exemplo.com.br', LIGADO), true);
  assert.equal(hostReservado('x.manager.exemplo.com.br', LIGADO), true);
  assert.equal(hostReservado('meu.onrender.com', LIGADO), true);
  assert.equal(hostReservado('festas.buffet.com.br', LIGADO), false);
});

test('caminhos aceitos no domínio são só os do site público', () => {
  assert.equal(caminhoNoDominio('/'), '');
  assert.equal(caminhoNoDominio('/sitemap.xml'), '/sitemap.xml');
  assert.equal(caminhoNoDominio('/imagens/ABCDEF12-1234-4123-8123-1234567890AB'), '/imagens/abcdef12-1234-4123-8123-1234567890ab');
  assert.equal(caminhoNoDominio('/imagens/../admin'), null);
  assert.equal(caminhoNoDominio('/c/Maiuscula'), null);
});

test('instruções de DNS: raiz usa A; subdomínio usa CNAME; TXT de verificação com o token; alvo de demonstração por padrão', () => {
  const alvo = alvoDns({});
  assert.equal(alvo.ip, '192.0.2.10', 'TEST-NET (RFC 5737): nunca aponta para infraestrutura real');
  const raiz = instrucoesDns('buffetalegria.com.br', 'a'.repeat(32), alvo);
  assert.equal(raiz.ehRaiz, true);
  assert.equal(raiz.apontamento.tipo, 'A');
  assert.equal(raiz.verificacao.nome, '_kidmais-verificacao.buffetalegria.com.br');
  assert.equal(raiz.verificacao.valor, `kidmais-verificacao=${'a'.repeat(32)}`);
  const sub = instrucoesDns('festas.buffetalegria.com.br', 'b'.repeat(32), alvo);
  assert.equal(sub.apontamento.tipo, 'CNAME');
  assert.equal(sub.apontamento.valor, 'sites.kidmais-demo.invalid');
});
