import assert from 'node:assert/strict';
import test from 'node:test';
import { rotear } from '../marketing/dominios/hosts.ts';
import { avaliarConfiguracao, decidirEndereco, telaDoClienteGlobal, type AmbienteEnderecos } from './roteamento.ts';

const A = 'https://manager.kidmaisfestas.com';
const N = 'https://iafest.demerzellabs.com.br';
const hA = 'manager.kidmaisfestas.com';
const hN = 'iafest.demerzellabs.com.br';

const base = { ENDERECOS_ORIGEM_ANTIGA: A, ENDERECOS_ORIGEM_NOVA: N };
const PREPARACAO: AmbienteEnderecos = { ...base, ENDERECOS_MODO: 'PREPARACAO', ADMIN_AUTH_ORIGIN: A };
const ATIVA: AmbienteEnderecos = { ...base, ENDERECOS_MODO: 'ATIVA', ADMIN_AUTH_ORIGIN: N };
const REVERSAO: AmbienteEnderecos = { ...base, ENDERECOS_MODO: 'REVERSAO', ADMIN_AUTH_ORIGIN: A };
const AUSENTE: AmbienteEnderecos = { ADMIN_AUTH_ORIGIN: A };

function decide(env: AmbienteEnderecos, host: string | null, url: string, metodo = 'GET') {
  const [pathname, query] = url.split('?');
  return decidirEndereco({ metodo, host, pathname, search: query ? `?${query}` : '' }, env);
}
const vai = (destino: string) => ({ tipo: 'REDIRECIONAR', destino });
const PASSA = { tipo: 'PASSAR' };
const NEUTRA = { tipo: 'NEUTRA' };

test('configuração: modo ausente e DESLIGADO não exigem origens', () => {
  assert.equal(avaliarConfiguracao({}).modoEfetivo, 'DESLIGADO');
  assert.equal(avaliarConfiguracao({}).modoSolicitado, 'AUSENTE');
  assert.equal(avaliarConfiguracao({ ENDERECOS_MODO: 'DESLIGADO' }).modoSolicitado, 'DESLIGADO');
  assert.equal(avaliarConfiguracao({ ENDERECOS_MODO: '  ' }).modoSolicitado, 'AUSENTE');
});

test('configuração inválida: cada problema tem o seu código e nenhum valor é ecoado', () => {
  const casos: Array<[AmbienteEnderecos, string]> = [
    [{ ...ATIVA, ENDERECOS_MODO: 'LIGADO' }, 'MODO_DESCONHECIDO'],
    [{ ...ATIVA, ENDERECOS_MODO: 'ativa' }, 'MODO_DESCONHECIDO'],
    [{ ...ATIVA, ENDERECOS_ORIGEM_ANTIGA: undefined }, 'ORIGEM_ANTIGA_INVALIDA'],
    [{ ...ATIVA, ENDERECOS_ORIGEM_ANTIGA: 'http://manager.kidmaisfestas.com' }, 'ORIGEM_ANTIGA_INVALIDA'],
    [{ ...ATIVA, ENDERECOS_ORIGEM_ANTIGA: `${A}/` }, 'ORIGEM_ANTIGA_INVALIDA'],
    [{ ...ATIVA, ENDERECOS_ORIGEM_ANTIGA: `${A}/x` }, 'ORIGEM_ANTIGA_INVALIDA'],
    [{ ...ATIVA, ENDERECOS_ORIGEM_ANTIGA: `${A}?a=1` }, 'ORIGEM_ANTIGA_INVALIDA'],
    [{ ...ATIVA, ENDERECOS_ORIGEM_ANTIGA: `${A}#f` }, 'ORIGEM_ANTIGA_INVALIDA'],
    [{ ...ATIVA, ENDERECOS_ORIGEM_ANTIGA: `${A}:8443` }, 'ORIGEM_ANTIGA_INVALIDA'],
    [{ ...ATIVA, ENDERECOS_ORIGEM_ANTIGA: 'https://u:s@manager.kidmaisfestas.com' }, 'ORIGEM_ANTIGA_INVALIDA'],
    [{ ...ATIVA, ENDERECOS_ORIGEM_ANTIGA: 'https://x.demerzellabs.com.br' }, 'ORIGEM_ANTIGA_INVALIDA'],
    [{ ...ATIVA, ENDERECOS_ORIGEM_NOVA: 'nao-e-url' }, 'ORIGEM_NOVA_INVALIDA'],
    [{ ...ATIVA, ENDERECOS_ORIGEM_NOVA: 'https://iafest.exemplo.com' }, 'ORIGEM_NOVA_INVALIDA'],
    [{ ...ATIVA, ADMIN_AUTH_ORIGIN: A }, 'ADMIN_DIVERGENTE'],
    [{ ...PREPARACAO, ADMIN_AUTH_ORIGIN: N }, 'ADMIN_DIVERGENTE'],
    [{ ...REVERSAO, ADMIN_AUTH_ORIGIN: N }, 'ADMIN_DIVERGENTE'],
    [{ ...ATIVA, ADMIN_AUTH_ORIGIN: undefined }, 'ADMIN_DIVERGENTE'],
    [{ ...ATIVA, ADMIN_AUTH_ORIGIN: 'x' }, 'ADMIN_DIVERGENTE'],
  ];
  for (const [env, codigo] of casos) {
    const cfg = avaliarConfiguracao(env);
    assert.equal(cfg.modoEfetivo, 'CONFIGURACAO_INVALIDA', codigo);
    assert.equal(cfg.codigo, codigo);
    assert.equal(cfg.antiga, null);
    assert.equal(cfg.nova, null);
  }
});

test('configuração: as origens iguais são recusadas por qualquer dos caminhos', () => {
  const cfg = avaliarConfiguracao({ ENDERECOS_MODO: 'ATIVA', ENDERECOS_ORIGEM_ANTIGA: N, ENDERECOS_ORIGEM_NOVA: N, ADMIN_AUTH_ORIGIN: N });
  assert.equal(cfg.modoEfetivo, 'CONFIGURACAO_INVALIDA');
});

test('invariante: sem modo, nenhum host demerzellabs serve as páginas globais', () => {
  for (const h of [hN, 'staging-iafest.demerzellabs.com.br', 'demerzellabs.com.br', 'www.demerzellabs.com.br']) {
    for (const p of ['/', '/disponibilidade', '/fechamento', '/fechamento?x=1', '/disponibilidade/'])
      assert.deepEqual(decide(AUSENTE, h, p), vai(`https://${h}/conheca`), `${h} ${p}`);
    assert.deepEqual(decide(AUSENTE, h, '/fechamento?contexto=ADMIN'), vai(`${A}/clientes?acao=fechamento`));
    assert.deepEqual(decide(AUSENTE, h, '/conheca'), PASSA);
    assert.deepEqual(decide(AUSENTE, h, '/contrato/abc'), PASSA);
  }
});

test('invariante: atalho sem origem https do painel fica no mesmo host, sem adivinhar destino', () => {
  assert.deepEqual(decide({}, hN, '/fechamento?origem=ATENDIMENTO_KIDMAIS'), vai(`${N}/clientes?acao=fechamento`));
  assert.deepEqual(decide({ ADMIN_AUTH_ORIGIN: 'http://painel.exemplo.com' }, hN, '/fechamento?contexto=ADMIN'), vai(`${N}/clientes?acao=fechamento`));
});

test('invariante: destino é sempre absoluto (o proxy do Next recusa Location relativa) e fica no domínio', () => {
  for (const env of [AUSENTE, PREPARACAO, ATIVA]) {
    for (const p of ['/', '/disponibilidade', '/fechamento', '/fechamento?contexto=ADMIN']) {
      const d = decide(env, 'x.demerzellabs.com.br', p) as { destino: string };
      assert.ok(new URL(d.destino).protocol === 'https:', d.destino);
    }
  }
  // Host parecido, lista e credencial não entram na regra do domínio.
  for (const h of ['demerzellabs.com.br.evil.com', 'evildemerzellabs.com.br', 'x.demerzellabs.com.br,evil.com', 'evil.com@x.demerzellabs.com.br'])
    assert.deepEqual(decide(AUSENTE, h, '/'), PASSA, h);
});

test('sem modo: host fora de demerzellabs não muda', () => {
  for (const p of ['/', '/disponibilidade', '/fechamento', '/admin/login', '/cadastro', '/b/x', '/s/x'])
    assert.deepEqual(decide(AUSENTE, hA, p), PASSA, p);
});

test('caminhos livres passam em qualquer modo, inclusive nas globais do invariante', () => {
  const livres = ['/api/x', '/api', '/_next/static/a.js', '/.well-known/oauth', '/sd/x/y', '/favicon.ico', '/robots.txt', '/sitemap.xml', '/site/logo.png', '/assets/a.b.svg'];
  for (const env of [AUSENTE, PREPARACAO, ATIVA, REVERSAO, { ...ATIVA, ADMIN_AUTH_ORIGIN: A }])
    for (const h of [hA, hN])
      for (const p of livres) assert.deepEqual(decide(env, h, p), PASSA, `${env.ENDERECOS_MODO} ${h} ${p}`);
});

test('só GET e HEAD: outros métodos nunca recebem 307', () => {
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    assert.deepEqual(decide(ATIVA, hA, '/admin/login', m), PASSA, m);
    assert.deepEqual(decide(AUSENTE, hN, '/', m), PASSA, m);
  }
  assert.deepEqual(decide(ATIVA, hA, '/admin/login', 'HEAD'), vai(`${N}/admin/login`));
});

test('ATIVA, host A: Grupo P servido, atalho e resto vão para N', () => {
  for (const p of ['/', '/disponibilidade', '/fechamento', '/fechamento?data=2026-12-01&convidados=80', '/contrato/abc', '/contrato/abc?x=1', '/fechamento?contexto=OUTRO'])
    assert.deepEqual(decide(ATIVA, hA, p), PASSA, p);
  assert.deepEqual(decide(ATIVA, hA, '/fechamento?contexto=ADMIN'), vai(`${N}/clientes?acao=fechamento`));
  assert.deepEqual(decide(ATIVA, hA, '/fechamento?origem=ATENDIMENTO_KIDMAIS&x=1'), vai(`${N}/clientes?acao=fechamento`));
  // Primeiro valor, a mesma regra da página.
  assert.deepEqual(decide(ATIVA, hA, '/fechamento?contexto=OUTRO&contexto=ADMIN'), PASSA);
  for (const p of ['/admin/login', '/admin/festas/1?a=b', '/clientes', '/cadastro', '/acesso/redefinir', '/convite/abc', '/conheca', '/b/kidmais', '/s/slug', '/documentos/termos/v1', '/festas/1', '/contrato'])
    assert.deepEqual(decide(ATIVA, hA, p), vai(`${N}${p}`), p);
});

test('ATIVA, host N: invariante; o resto serve', () => {
  for (const p of ['/', '/disponibilidade', '/fechamento']) assert.deepEqual(decide(ATIVA, hN, p), vai(`${N}/conheca`), p);
  assert.deepEqual(decide(ATIVA, hN, '/fechamento?contexto=ADMIN'), vai(`${N}/clientes?acao=fechamento`));
  for (const p of ['/admin/login', '/clientes', '/contrato/abc', '/b/x', '/conheca', '/s/x']) assert.deepEqual(decide(ATIVA, hN, p), PASSA, p);
});

test('PREPARACAO, host N: vitrine e /b servem; o resto vai para A com caminho e query', () => {
  for (const p of ['/', '/disponibilidade', '/fechamento']) assert.deepEqual(decide(PREPARACAO, hN, p), vai(`${N}/conheca`), p);
  assert.deepEqual(decide(PREPARACAO, hN, '/fechamento?contexto=ADMIN'), vai(`${A}/clientes?acao=fechamento`));
  for (const p of ['/conheca', '/planos', '/termos', '/privacidade', '/acordo-de-tratamento', '/b', '/b/x', '/b/x/orcamento', '/documentos/termos/2026-10-22'])
    assert.deepEqual(decide(PREPARACAO, hN, p), PASSA, p);
  for (const p of ['/cadastro', '/cadastro?ref=1', '/admin/login', '/acesso/recuperar', '/clientes', '/s/x', '/convite/a', '/contrato/a', '/documentos', '/documentos/a', '/documentos/a/b/c', '/conheca/x'])
    assert.deepEqual(decide(PREPARACAO, hN, p), vai(`${A}${p}`), p);
});

test('PREPARACAO e REVERSAO, host A: como hoje', () => {
  for (const env of [PREPARACAO, REVERSAO])
    for (const p of ['/', '/disponibilidade', '/admin/login', '/clientes', '/b/x', '/fechamento?contexto=ADMIN'])
      assert.deepEqual(decide(env, hA, p), PASSA, `${env.ENDERECOS_MODO} ${p}`);
});

test('REVERSAO, host N: toda página vai para A; atalho vai direto ao painel', () => {
  for (const p of ['/', '/disponibilidade', '/fechamento', '/fechamento?data=1', '/admin/login', '/b/x', '/conheca', '/clientes?a=b', '/contrato/a'])
    assert.deepEqual(decide(REVERSAO, hN, p), vai(`${A}${p}`), p);
  assert.deepEqual(decide(REVERSAO, hN, '/fechamento?contexto=ADMIN'), vai(`${A}/clientes?acao=fechamento`));
});

test('nenhum laço: seguir o destino não troca de origem de novo, em nenhum modo', () => {
  const caminhos = ['/', '/disponibilidade', '/fechamento', '/fechamento?contexto=ADMIN', '/admin/login', '/clientes', '/cadastro', '/b/x', '/s/x', '/conheca', '/contrato/a', '/documentos/a/b', '/documentos/a'];
  for (const env of [PREPARACAO, ATIVA, REVERSAO]) {
    for (const hostInicial of [hA, hN]) {
      for (const inicial of caminhos) {
        let host = hostInicial;
        let url = inicial;
        let trocas = 0;
        for (let i = 0; i < 5; i += 1) {
          const d = decide(env, host, url);
          if (d.tipo !== 'REDIRECIONAR') break;
          if (d.destino.startsWith('https://')) {
            const alvo = new URL(d.destino);
            if (alvo.hostname !== host) trocas += 1;
            host = alvo.hostname;
            url = `${alvo.pathname}${alvo.search}`;
          }
          else url = d.destino;
          assert.notEqual(i, 4, `laço: ${env.ENDERECOS_MODO} ${hostInicial} ${inicial}`);
        }
        assert.ok(trocas <= 1, `${env.ENDERECOS_MODO} ${hostInicial} ${inicial}: ${trocas} trocas de origem`);
      }
    }
  }
});

test('host fora de A e N, reservado ou de cliente: comportamento atual nos modos válidos', () => {
  for (const env of [PREPARACAO, ATIVA, REVERSAO]) {
    for (const h of ['kidmais-manager-production.onrender.com', 'buffet-do-cliente.com.br', 'festas.exemplo.com']) {
      for (const p of ['/', '/admin/login', '/c/oferta']) assert.deepEqual(decide(env, h, p), PASSA, `${h} ${p}`);
    }
  }
});

test('outro host demerzellabs: invariante vale em todos os modos, sem servir as globais', () => {
  const outro = 'www.demerzellabs.com.br';
  assert.deepEqual(decide(ATIVA, outro, '/'), vai(`https://${outro}/conheca`));
  assert.deepEqual(decide(PREPARACAO, outro, '/'), vai(`https://${outro}/conheca`));
  assert.deepEqual(decide(REVERSAO, outro, '/'), vai(`${A}/`));
  assert.deepEqual(decide(ATIVA, outro, '/qualquer'), PASSA);
});

test('host inválido ou lista em cabeçalho: não redireciona e cai na regra atual', () => {
  for (const h of [null, '', `${hA},evil.com`, `evil@${hA}`, '1.2.3.4', 'localhost:3000', '[::1]:3000'])
    assert.deepEqual(decide(ATIVA, h, '/admin/login'), PASSA, String(h));
});

test('destino nunca escapa da origem configurada: caminhos malformados', () => {
  for (const p of ['//evil/x', '//evil.com/x', '/\\evil', '/\\evil/x', '/%2f%2fevil', '/%2F%2Fevil/x', '/..//evil/x', '/\\\\evil/x', '///evil/x']) {
    const d = decide(ATIVA, hA, p) as { tipo: string; destino?: string };
    assert.equal(d.tipo, 'REDIRECIONAR', p);
    assert.equal(new URL(d.destino!).origin, N, p);
  }
  // Último segmento com ponto é tratado como arquivo: passa sem redirecionar, logo sem destino para abusar.
  for (const p of ['//evil.com', '/\\evil.com', '/%2f%2fevil.com']) assert.deepEqual(decide(ATIVA, hA, p), PASSA, p);
  const d = decide(ATIVA, hA, '/x?u=https://evil.com/') as { destino: string };
  assert.equal(new URL(d.destino).origin, N);
});

test('host com porta, caixa alta e ponto final: normalizado antes de comparar', () => {
  assert.deepEqual(decide(ATIVA, 'MANAGER.kidmaisfestas.com', '/admin'), vai(`${N}/admin`));
  assert.deepEqual(decide(ATIVA, `${hA}.`, '/admin'), vai(`${N}/admin`));
  assert.deepEqual(decide(ATIVA, `${hA}:443`, '/admin'), vai(`${N}/admin`));
});

test('CONFIGURACAO_INVALIDA: não adivinha destino e não derruba o host do painel', () => {
  const invalida: AmbienteEnderecos = { ...ATIVA, ENDERECOS_ORIGEM_NOVA: 'x' };
  // Host do painel (N, por ADMIN_AUTH_ORIGIN): serve, salvo o invariante.
  assert.deepEqual(decide(invalida, hN, '/admin/login'), PASSA);
  for (const p of ['/', '/disponibilidade', '/fechamento', '/fechamento?contexto=ADMIN']) assert.deepEqual(decide(invalida, hN, p), NEUTRA, p);
  // Host antigo: fluxo público serve; o que depende do painel recebe a página neutra.
  for (const p of ['/', '/disponibilidade', '/fechamento', '/contrato/a']) assert.deepEqual(decide(invalida, hA, p), PASSA, p);
  for (const p of ['/admin/login', '/clientes', '/cadastro', '/b/x', '/contrato']) assert.deepEqual(decide(invalida, hA, p), NEUTRA, p);
  // Outro host demerzellabs: nem o Grupo P é servido.
  assert.deepEqual(decide(invalida, 'www.demerzellabs.com.br', '/contrato/a'), NEUTRA);
  // Painel em A com a configuração inválida.
  const emA: AmbienteEnderecos = { ...REVERSAO, ENDERECOS_ORIGEM_ANTIGA: 'x' };
  assert.deepEqual(decide(emA, hA, '/admin/login'), PASSA);
  assert.deepEqual(decide(emA, hN, '/admin/login'), NEUTRA);
});

test('CONFIGURACAO_INVALIDA: domínio de cliente e host desconhecido não mudam; livres passam', () => {
  const invalida: AmbienteEnderecos = { ...ATIVA, ENDERECOS_MODO: 'XPTO' };
  for (const p of ['/', '/admin/login', '/c/oferta']) assert.deepEqual(decide(invalida, 'buffet-do-cliente.com.br', p), PASSA, p);
  for (const p of ['/api/x', '/_next/a.js', '/.well-known/x', '/sd/a/b']) assert.deepEqual(decide(invalida, hN, p), PASSA, p);
});

test('sem origem do painel e configuração inválida: nenhum host vira o do painel', () => {
  const invalida: AmbienteEnderecos = { ...ATIVA, ADMIN_AUTH_ORIGIN: undefined };
  assert.deepEqual(decide(invalida, hN, '/admin/login'), NEUTRA);
  assert.deepEqual(decide(invalida, hA, '/admin/login'), NEUTRA);
  assert.deepEqual(decide(invalida, hA, '/'), PASSA);
});

test('regressão da guarda: /sd continua livre aqui e vira 404 no rotear, em qualquer modo', () => {
  for (const env of [AUSENTE, PREPARACAO, ATIVA, REVERSAO]) {
    assert.deepEqual(decide(env, hA, '/sd/x'), PASSA);
    const rota = rotear(hA, '/sd/x', env);
    assert.equal(rota.tipo, 'DOMINIO');
  }
});

test('regressão de domínio personalizado: A e N seguem reservados mesmo fora de ADMIN_AUTH_ORIGIN', () => {
  const ligado = { ...ATIVA, MARKETING_DOMINIOS_PERSONALIZADOS: 'true' };
  assert.deepEqual(rotear(hA, '/', ligado), { tipo: 'PLATAFORMA' });
  assert.deepEqual(rotear(hN, '/', ligado), { tipo: 'PLATAFORMA' });
  assert.equal(rotear('buffet-do-cliente.com.br', '/', ligado).tipo, 'DOMINIO');
});

test('H21: "Ver tela do cliente" da empresa global aponta para A só em ATIVA', () => {
  assert.equal(telaDoClienteGlobal(ATIVA), `${A}/disponibilidade`);
  assert.equal(telaDoClienteGlobal(PREPARACAO), '/disponibilidade');
  assert.equal(telaDoClienteGlobal(REVERSAO), '/disponibilidade');
  assert.equal(telaDoClienteGlobal(AUSENTE), '/disponibilidade');
  // Configuração inválida com o painel em N: relativo, cai na resposta neutra sem adivinhar destino.
  const invalida: AmbienteEnderecos = { ...ATIVA, ENDERECOS_ORIGEM_ANTIGA: 'x' };
  assert.equal(telaDoClienteGlobal(invalida), '/disponibilidade');
  assert.deepEqual(decide(invalida, hN, telaDoClienteGlobal(invalida)), NEUTRA);
});
