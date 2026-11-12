/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador da 118 em produção — autenticação do servidor num HANDSHAKE TLS REAL (parecer r2 da produção, P2). Um servidor
// TLS local (certificados gerados pelo openssl na hora) recebe a conexão com as opções EXATAS que `alvo(env)` entrega ao pg:
//   - CA confiável: certificado de outra CA é recusado no handshake, antes de qualquer byte da aplicação;
//   - CA + pin: certificado da CA certa mas folha diferente da fixada é recusado (TLS_PIN_DIVERGENTE); a folha certa passa;
//   - exceção registrada: conecta sem verificar (o caso que a exceção de Felipe aceita, e que fica no marcador).
// Rodada 4 (canal ligado, padrão): um PostgreSQL FALSO sobre TLS real tenta cada atalho de autenticação (senha em claro, MD5,
// SCRAM sem PLUS, "autenticado" sem SASL, Ok antes do Final, SASL repetido, assinatura falsa) e o cliente de `clienteSeguro`
// recusa sem mandar senha, prova ou consulta. O caminho feliz e o intermediário contra um PostgreSQL real estão na prova
// local ambientes-locais/prova-canal-ligado-118-production.cjs (o CI não tem PostgreSQL com TLS).
// Sem openssl no PATH o teste é pulado (o CI do GitHub tem openssl).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');
const net = require('node:net');
const {Client} = require('pg');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const prd = require('./migration-118-production.cjs');

const temOpenssl = spawnSync('openssl', ['version'], {encoding: 'utf8'}).status === 0;
const ENV = Object.freeze({RENDER: 'true', RENDER_SERVICE_ID: prd.ALVO.servico, KIDMAIS_DEPLOY_ENV: 'production', DATABASE_SSL: 'true',
  DATABASE_SSL_REJECT_UNAUTHORIZED: 'false', DATABASE_URL: `postgresql://usuario:SENHA_FALSA@${prd.ALVO.host}:5432/kidmais_production`});

function openssl(dir, args) {
  const r = spawnSync('openssl', args, {cwd: dir, encoding: 'utf8'});
  assert.equal(r.status, 0, r.stderr);
}
/** CA + folha assinada com SAN = host do alvo. */
function emitir(dir, nome) {
  openssl(dir, ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '2', '-subj', `/CN=${nome}-ca`,
    '-keyout', `${nome}-ca.key`, '-out', `${nome}-ca.pem`]);
  openssl(dir, ['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-subj', `/CN=${prd.ALVO.host}`, '-keyout', `${nome}.key`, '-out', `${nome}.csr`]);
  fs.writeFileSync(path.join(dir, `${nome}.ext`), `subjectAltName=DNS:${prd.ALVO.host}\n`);
  openssl(dir, ['x509', '-req', '-in', `${nome}.csr`, '-CA', `${nome}-ca.pem`, '-CAkey', `${nome}-ca.key`, '-CAcreateserial', '-days', '2',
    '-extfile', `${nome}.ext`, '-out', `${nome}.pem`]);
  const ler = a => fs.readFileSync(path.join(dir, a), 'utf8');
  return {ca: ler(`${nome}-ca.pem`), cert: ler(`${nome}.pem`), key: ler(`${nome}.key`)};
}
/** Servidor TLS que conta os bytes de aplicação recebidos depois do handshake. */
async function servidor(par) {
  const estado = {bytes: 0, seguros: 0};
  const s = tls.createServer({cert: par.cert, key: par.key, minVersion: 'TLSv1.2'}, sock => {
    estado.seguros++; sock.on('data', d => { estado.bytes += d.length; }); sock.on('error', () => {});
  });
  s.on('tlsClientError', () => {});
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  return {porta: s.address().port, estado, fechar: () => new Promise(r => s.close(r))};
}
/** Conecta com as opções TLS de `alvo(env)` (servername = host do alvo) e manda 1 byte só depois do handshake aceito. */
function conectar(porta, ssl) {
  return new Promise(resolve => {
    const c = tls.connect({host: '127.0.0.1', port: porta, servername: prd.ALVO.host, ...ssl}, () => {
      c.write('X', () => { c.end(); resolve({ok: true}); });
    });
    c.on('error', e => resolve({ok: false, erro: e.message, codigo: e.code}));
  });
}
const b64 = s => Buffer.from(s).toString('base64');
const pinDe = pem => crypto.createHash('sha256').update(new crypto.X509Certificate(pem).raw).digest('hex');

test('handshake TLS real: CA confiável, pin da folha e exceção registrada com as opções exatas do alvo', {skip: !temOpenssl && 'openssl ausente'}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls118p-'));
  try {
    const certa = emitir(dir, 'certa'), outra = emitir(dir, 'outra');
    const srvCerto = await servidor(certa), srvOutro = await servidor(outra);
    try {
      const sslCa = prd.alvo({...ENV, KIDMAIS_118_TLS_CA: b64(certa.ca)}).ssl;
      // CA confiável: o servidor certo passa; o de outra CA é recusado no handshake, sem nenhum byte de aplicação.
      assert.deepEqual(await conectar(srvCerto.porta, sslCa), {ok: true});
      const r = await conectar(srvOutro.porta, sslCa);
      assert.equal(r.ok, false); assert.match(r.codigo ?? r.erro, /UNABLE_TO_VERIFY|SELF_SIGNED|CERT/);
      // CA + pin: a folha fixada passa; outra folha da MESMA CA é recusada (TLS_PIN_DIVERGENTE) antes de qualquer byte.
      const outraFolha = emitir(dir, 'irma');
      fs.writeFileSync(path.join(dir, 'irma-assinada.ext'), `subjectAltName=DNS:${prd.ALVO.host}\n`);
      openssl(dir, ['x509', '-req', '-in', 'irma.csr', '-CA', 'certa-ca.pem', '-CAkey', 'certa-ca.key', '-CAcreateserial', '-days', '2',
        '-extfile', 'irma-assinada.ext', '-out', 'irma-assinada.pem']);
      const irma = {cert: fs.readFileSync(path.join(dir, 'irma-assinada.pem'), 'utf8'), key: outraFolha.key};
      const srvIrma = await servidor(irma);
      try {
        const sslPin = prd.alvo({...ENV, KIDMAIS_118_TLS_CA: b64(certa.ca), KIDMAIS_118_TLS_PIN: pinDe(certa.cert)}).ssl;
        assert.deepEqual(await conectar(srvCerto.porta, sslPin), {ok: true});
        const p = await conectar(srvIrma.porta, sslPin);
        assert.equal(p.ok, false); assert.equal(p.erro, 'TLS_PIN_DIVERGENTE');
        assert.equal(srvIrma.estado.bytes, 0, 'nenhum byte de aplicação para a folha não fixada');
        // Sem pin, a irmã (mesma CA, mesmo SAN) passaria: o pin é o que fixa o servidor.
        assert.deepEqual(await conectar(srvIrma.porta, sslCa), {ok: true});
      } finally { await srvIrma.fechar(); }
      assert.equal(srvOutro.estado.bytes, 0, 'nenhum byte de aplicação para o servidor de outra CA');
      // Exceção registrada: conecta sem verificar (por isso exige a decisão de Felipe).
      const sslExc = prd.alvo({...ENV, KIDMAIS_118_TLS_EXCECAO: 'D-118-TLS 2026-11-20 Felipe aceita servidor sem certificado verificado'}).ssl;
      assert.deepEqual(await conectar(srvOutro.porta, sslExc), {ok: true});
      // Sem nenhuma das duas: canal ligado (o handshake não verifica; quem autentica é o SCRAM-PLUS, testes abaixo).
      assert.equal(prd.alvo(ENV).enableChannelBinding, true);
    } finally { await srvCerto.fechar(); await srvOutro.fechar(); }
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

// ---------------------------------------------------------------------------------------------------------------------
// Canal ligado: PostgreSQL falso sobre TLS real.
const R = (codigo, extra = Buffer.alloc(0)) => {
  const b = Buffer.alloc(9 + extra.length); b.write('R', 0); b.writeInt32BE(8 + extra.length, 1); b.writeInt32BE(codigo, 5); extra.copy(b, 9); return b;
};
const Z = Buffer.from([0x5a, 0, 0, 0, 5, 0x49]);
/** Aceita o SSLRequest, faz o TLS, lê a inicialização e segue o roteiro; registra o tipo e o corpo de cada mensagem depois dela. */
async function pgFalso(par, roteiro) {
  const recebidas = [];
  const s = net.createServer(raw => {
    raw.on('error', () => {});
    raw.once('data', d => {
      if (d.length !== 8 || d.readInt32BE(4) !== 80877103) { raw.destroy(); return; }
      raw.write('S');
      const t2 = new tls.TLSSocket(raw, {isServer: true, cert: par.cert, key: par.key, minVersion: 'TLSv1.2'});
      t2.on('error', () => {});
      let buf = Buffer.alloc(0), inicio = true;
      t2.on('data', parte => {
        buf = Buffer.concat([buf, parte]);
        for (;;) {
          if (inicio) {
            if (buf.length < 4 || buf.length < buf.readInt32BE(0)) return;
            buf = buf.subarray(buf.readInt32BE(0)); inicio = false; roteiro.inicio(t2); continue;
          }
          if (buf.length < 5) return;
          const n = buf.readInt32BE(1); if (buf.length < n + 1) return;
          const msg = {tipo: String.fromCharCode(buf[0]), corpo: Buffer.from(buf.subarray(5, n + 1))}; buf = buf.subarray(n + 1);
          recebidas.push(msg); roteiro.mensagem?.(t2, msg, recebidas);
        }
      });
    });
  });
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  return {porta: s.address().port, recebidas, fechar: () => new Promise(r => s.close(r))};
}
/** Conecta com a configuração EXATA do alvo (canal ligado), só com host/porta locais; nunca consulta se conectar. */
async function conectarCanal(porta) {
  const cfg = prd.alvo(ENV); cfg.host = '127.0.0.1'; cfg.port = porta;   // senha não enumerável: mutar, não espalhar
  const Seguro = prd.clienteSeguro(Client);
  const c = new Seguro(cfg); c.on('error', () => {});
  try { await c.connect(); await c.end(); return {ok: true}; } catch (e) { await c.end().catch(() => {}); return {ok: false, erro: e.message}; }
}
const tipos = l => l.map(m => m.tipo).join('');
/** Desafio SCRAM válido (nonce do cliente + do servidor, sal, iterações) para a resposta inicial recebida. */
const desafioValido = msg => {
  const nonce = /r=([^,]+)$/.exec(msg.corpo.toString('latin1'))[1];
  return R(11, Buffer.from('r=' + nonce + 'servidor,s=' + crypto.randomBytes(16).toString('base64') + ',i=4096'));
};

test('canal ligado: cada atalho de um servidor falso é recusado sem consulta, e a falha diz se a prova pode ter saído', {skip: !temOpenssl && 'openssl ausente'}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canal118p-'));
  try {
    const par = emitir(dir, 'falso');
    const casos = [
      ['senha em claro', {inicio: s => s.write(R(3))}, 'CANAL_SEM_SCRAM', ''],
      ['MD5', {inicio: s => s.write(R(5, Buffer.from([1, 2, 3, 4])))}, 'CANAL_SEM_SCRAM', ''],
      ['SCRAM sem PLUS', {inicio: s => s.write(R(10, Buffer.from('SCRAM-SHA-256\0\0')))}, 'CANAL_SEM_PLUS', ''],
      ['autenticado sem SASL', {inicio: s => s.write(Buffer.concat([R(0), Z]))}, 'CANAL_NAO_AUTENTICADO', ''],
      ['Ok antes do Final', {inicio: s => s.write(R(10, Buffer.from('SCRAM-SHA-256-PLUS\0SCRAM-SHA-256\0\0'))),
        mensagem: s => s.write(Buffer.concat([R(0), Z]))}, 'CANAL_NAO_AUTENTICADO', 'p'],
      ['SASL repetido', {inicio: s => s.write(R(10, Buffer.from('SCRAM-SHA-256-PLUS\0\0'))),
        mensagem: s => s.write(R(10, Buffer.from('SCRAM-SHA-256-PLUS\0\0')))}, 'CANAL_FORA_DE_ORDEM', 'p'],
      // Parecer r4, P3: dois desafios válidos NO MESMO PACOTE → recusa no segundo, antes de o pg calcular qualquer prova.
      ['desafio duplicado no mesmo pacote', {inicio: s => s.write(R(10, Buffer.from('SCRAM-SHA-256-PLUS\0\0'))),
        mensagem: (s, msg) => { const d = desafioValido(msg); s.write(Buffer.concat([d, d])); }}, 'CANAL_FORA_DE_ORDEM', 'p',
        // O 1º desafio já foi repassado: a prova não saiu aqui ('p'), mas a fase é conservadora (pode ter saído).
        'CANAL_PROVA_EXPOSTA'],
      ['Final sem desafio', {inicio: s => s.write(R(10, Buffer.from('SCRAM-SHA-256-PLUS\0\0'))),
        mensagem: s => s.write(R(12, Buffer.from('v=' + crypto.randomBytes(32).toString('base64'))))}, 'CANAL_FORA_DE_ORDEM', 'p'],
      // Parecer r5, P2: desafio válido → o cliente manda a prova → o impostor encerra com Ok prematuro (sem Final). Recusa,
      // nenhuma consulta, e a fase diz que a prova saiu (girar a credencial).
      ['Ok prematuro depois da prova', {inicio: s => s.write(R(10, Buffer.from('SCRAM-SHA-256-PLUS\0\0'))),
        mensagem: (s, msg, l) => s.write(l.length === 1 ? desafioValido(msg) : Buffer.concat([R(0), Z]))}, 'CANAL_NAO_AUTENTICADO', 'pp'],
      ['fechamento depois da prova', {inicio: s => s.write(R(10, Buffer.from('SCRAM-SHA-256-PLUS\0\0'))),
        mensagem: (s, msg, l) => { if (l.length === 1) s.write(desafioValido(msg)); else s.destroy(); }}, null, 'pp'],
    ];
    for (const [nome, roteiro, codigo, esperadas, faseFixa] of casos) {
      const srv = await pgFalso(par, roteiro);
      try {
        const r = await conectarCanal(srv.porta);
        assert.equal(r.ok, false, nome); const fase = (faseFixa ?? (esperadas.length > 1 ? prd.FASE_PROVA_EXPOSTA : prd.FASE_ANTES_DA_PROVA)) + ' ';
        if (codigo) assert.equal(r.erro, fase + codigo, nome); else assert.ok(r.erro.startsWith(fase), nome + ': ' + r.erro);
        await new Promise(res => setTimeout(res, 50));
        // 'p' = só a resposta inicial do SASL (nonce, sem prova; fase ANTES_DA_PROVA); 'pp' = a prova saiu (PROVA_EXPOSTA).
        // Nenhuma senha em claro, nenhuma consulta ('Q'). Nem o
        // Terminate ('X'): a recusa derruba o socket NA mensagem, antes de o cliente processá-la e encerrar normalmente.
        assert.equal(tipos(srv.recebidas), esperadas, nome + ': mensagens recebidas pelo servidor falso');
      } finally { await srv.fechar(); }
    }
    // Impostor que segue o SCRAM-PLUS inteiro mas não tem a chave do servidor: assinatura falsa → recusa, nenhuma consulta.
    // E a prova do cliente leva o hash do certificado que ele viu (tls-server-end-point), não "y"/"n".
    let finalCliente = '';
    const srv = await pgFalso(par, {
      inicio: s => s.write(R(10, Buffer.from('SCRAM-SHA-256-PLUS\0SCRAM-SHA-256\0\0'))),
      mensagem: (s, msg, l) => {
        if (l.length === 1) {
          const txt = msg.corpo.toString('latin1'); const nonce = /r=([^,]+)$/.exec(txt)[1];
          assert.match(txt, /^SCRAM-SHA-256-PLUS\0/); assert.match(txt, /p=tls-server-end-point,,n=\*,r=/);
          s.write(R(11, Buffer.from('r=' + nonce + 'servidor,s=' + crypto.randomBytes(16).toString('base64') + ',i=4096')));
        } else if (l.length === 2) {
          finalCliente = msg.corpo.toString('latin1');
          s.write(R(12, Buffer.from('v=' + crypto.randomBytes(32).toString('base64'))));
        }
      }});
    try {
      const r = await conectarCanal(srv.porta);
      assert.equal(r.ok, false); assert.match(r.erro, /^CANAL_PROVA_EXPOSTA .*server signature does not match/);
      await new Promise(res => setTimeout(res, 50));
      assert.equal(tipos(srv.recebidas).replace(/X$/, ''), 'pp', 'nenhuma consulta depois da assinatura falsa');
      const cb = Buffer.from(/^c=([^,]+),/.exec(finalCliente)[1], 'base64');
      const hashCert = crypto.createHash('sha256').update(new crypto.X509Certificate(par.cert).raw).digest();
      assert.deepEqual(cb, Buffer.concat([Buffer.from('p=tls-server-end-point,,'), hashCert]), 'channel binding com o certificado visto');
    } finally { await srv.fechar(); }
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('canal ligado, camadas internas: recusa se o pg escolher outro mecanismo e se "conectar" sem autenticação completa', async () => {
  const {EventEmitter} = require('node:events');
  /** Imitação mínima do cliente do pg: liga o channel binding pela configuração e tem um socket TLS (não conectado). */
  class Falso {
    constructor(cfg) { this.enableChannelBinding = cfg?.enableChannelBinding === true; this.connection = new EventEmitter(); this.connection.stream = new tls.TLSSocket(new net.Socket()); }
    on() {}
    async end() {}
  }
  // Um pg que escolhesse SCRAM sem PLUS mesmo com o PLUS oferecido (mudança de versão, configuração ignorada).
  class EscolheSemPlus extends Falso {
    connect() {
      return new Promise((ok, erro) => {
        this.connection.on('authenticationSASL', () => { this.saslSession = {mechanism: 'SCRAM-SHA-256'}; });
        this.connection.on('error', erro);
        this.connection.emit('authenticationSASL', {mechanisms: ['SCRAM-SHA-256-PLUS', 'SCRAM-SHA-256']});
        ok();
      });
    }
  }
  // Um pg que "conectasse" sem nenhuma mensagem de autenticação.
  class ConectaSemAutenticar extends Falso { async connect() {} }
  for (const [Base, codigo] of [[EscolheSemPlus, 'CANAL_SEM_PLUS'], [ConectaSemAutenticar, 'CANAL_NAO_AUTENTICADO']]) {
    const C = prd.clienteSeguro(Base);
    await assert.rejects(new C(prd.alvo(ENV)).connect(), e => e.message === prd.FASE_ANTES_DA_PROVA + ' ' + codigo, codigo);
  }
});
