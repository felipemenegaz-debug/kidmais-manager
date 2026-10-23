/* eslint-disable @typescript-eslint/no-require-imports */
// Blocos de Shell da prova de e-mail em produção (V6, 20/10/2026): executados DE VERDADE com bash num deploy temporário
// (só as pastas diferem das de produção). O executor transportado roda a partir da pasta própria: no plano (sem ambiente)
// e nos modos reais, que recusam ANTES de qualquer gravação ou rede por estarem fora do Render. Inclui colagem interativa
// (bash -i) e colagem truncada. Nenhum envio, nenhum acesso a /opt.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawnSync} = require('node:child_process'), {createHash} = require('node:crypto');
const b = require('./bloco-shell-email-producao-20261020.cjs');
const root = path.resolve(__dirname, '..');
const sha = s => createHash('sha256').update(s).digest('hex');
const posix = p => p.replace(/\\/g, '/');
const PASTA = '.kidmais-email-producao-20261020';
const SENTINELA = '// arquivo do deploy: nunca lido, sobrescrito nem removido\r\n';
const CHAVE = 're_SEGREDOsinteticoNAOREAL_0123456789abcdef';

function deploy() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bloco-email-'));
  fs.mkdirSync(path.join(d, 'scripts'), {recursive: true});
  fs.writeFileSync(path.join(d, b.EXECUTOR), SENTINELA);
  fs.mkdirSync(path.join(d, 'data/lancamento-email-producao-20261020'), {recursive: true});
  fs.writeFileSync(path.join(d, 'data/lancamento-email-producao-20261020/outro.json'), '{}');
  fs.mkdirSync(path.join(d, 'tmp'));
  return d;
}
function sessao(d, conteudo, opcoes = {}) {
  const interativo = opcoes.interativo === true, servico = Object.hasOwn(opcoes, 'servico') ? opcoes.servico : b.SERVICO;
  const f = d + '-sessao.sh'; fs.writeFileSync(f, conteudo);
  const env = {...process.env, TMPDIR: posix(path.join(d, 'tmp'))};
  for (const k of Object.keys(env)) if (/^(RENDER|DATABASE_|KIDMAIS_|PG|EMAIL_|RESEND_)/.test(k)) delete env[k];
  // Ambiente de e-mail "de produção" sintético: o executor real precisa recusar sem imprimir a chave.
  Object.assign(env, {KIDMAIS_DEPLOY_ENV: 'production', EMAIL_PROVIDER: 'resend', EMAIL_REMETENTE: 'Kidmais Manager <nao-responda@notificacoes.kidmaisfestas.com>', RESEND_API_KEY: CHAVE});
  if (servico !== undefined) env.RENDER_SERVICE_ID = servico;
  const r = interativo ? spawnSync('bash', ['--norc', '--noprofile', '-i'], {input: fs.readFileSync(f), encoding: 'utf8', env})
    : spawnSync('bash', [f], {encoding: 'utf8', env});
  fs.rmSync(f, {force: true});
  return {status: r.status, saida: (r.stdout || '') + (r.stderr || '')};
}
const gerar = (d, modo, comando) => b.gerar({modo, rotulo: 'abcdef1', destino: posix(path.join(d, PASTA)), deploy: posix(d), comando});
const rodar = (d, modo, comando, opcoes) => sessao(d, gerar(d, modo, comando), opcoes);
const codigo = s => [...s.matchAll(/^CODIGO_SAIDA_BLOCO=(\d+)$/gm)].map(x => Number(x[1])).at(-1);
const presentes = d => b.ARQUIVOS.filter(a => fs.existsSync(path.join(d, PASTA, a)));
const intactos = d => fs.readFileSync(path.join(d, b.EXECUTOR), 'utf8') === SENTINELA
  && fs.readdirSync(path.join(d, 'data/lancamento-email-producao-20261020')).join() === 'outro.json';
const PLANO = `node ${b.EXECUTOR} --plano`;
/** Sonda do bash interativo: a expressão aritmética só aparece avaliada ("_2") se o shell EXECUTOU a linha. */
const BASH_INTERATIVO = /SONDA_INTERATIVO_2/.test((r => (r.stdout || '') + (r.stderr || ''))(
  spawnSync('bash', ['--norc', '--noprofile', '-i'], {input: 'echo SONDA_INTERATIVO_$((1+1))\n', encoding: 'utf8', timeout: 20000})));

test('três blocos oficiais: ≤ 32 KB, ASCII, bind e guarda de produção antes de tudo, subshell, código impresso, sem segredo', () => {
  assert.deepEqual(b.MODOS, ['CONFERIR', 'ENVIAR', 'LIMPEZA']);
  for (const modo of b.MODOS) {
    const x = b.gerar({modo, rotulo: 'abcdef1'});
    assert.ok(Buffer.byteLength(x) <= 32768, modo + ' ' + Buffer.byteLength(x));
    assert.match(x, /^[\x09\x0a\x20-\x7e]*$/);
    const L = x.split('\n'), i = L.findIndex(l => l.startsWith('if [ "$RENDER_SERVICE_ID" != "srv-dak77m2d0e5s73b8rkkg" ]'));
    assert.ok(i > 0 && L.slice(0, i).every(l => l.startsWith('#') || l.startsWith('bind ')), modo);
    assert.equal(L[i - 1], "bind 'set enable-bracketed-paste off' 2>/dev/null");
    assert.equal(L[i + 1], '('); assert.ok(L.includes(')') && L.includes('echo "CODIGO_SAIDA_BLOCO=$?"') && L.at(-2) === 'fi');
    assert.doesNotMatch(x, /RESEND_API_KEY|re_[A-Za-z0-9]{8}|DATABASE_URL|Bearer/);
    assert.match(x, /Ctrl-C, nunca colar por cima/);
    assert.doesNotMatch(x, /\/opt\/render\/project\/src\/(scripts|lib)|rm -rf -- '\/opt/, 'nunca toca scripts/lib do deploy');
    // O disco persistente só aparece numa listagem (ls -l) depois do executor: o bloco nunca grava nem remove nada lá.
    assert.ok(L.filter(l => l.includes('/opt/render/project/src/data')).every(l => l.startsWith("ls -l '/opt/render/project/src/data/lancamento-email-producao-20261020' ")), modo);
  }
  assert.match(b.gerar({modo: 'CONFERIR', rotulo: 'abcdef1'}), /^node --experimental-strip-types scripts\/email-producao-20261020\.cjs --conferir \|\| codigo=\$\?$/m);
  assert.match(b.gerar({modo: 'ENVIAR', rotulo: 'abcdef1'}), /^node --experimental-strip-types scripts\/email-producao-20261020\.cjs --enviar-autorizado \|\| codigo=\$\?$/m);
  assert.match(b.gerar({modo: 'ENVIAR', rotulo: 'abcdef1'}), /UMA mensagem a contato@demerzellabs\.com\.br \(fixo\)/);
  assert.doesNotMatch(b.gerar({modo: 'CONFERIR', rotulo: 'abcdef1'}), /--enviar-autorizado/);
  assert.doesNotMatch(b.gerar({modo: 'LIMPEZA', rotulo: 'abcdef1'}), /^node |B64|--enviar/m);
  assert.throws(() => b.gerar({modo: 'X', rotulo: 'abcdef1'}), /MODO_DESCONHECIDO/);
  assert.throws(() => b.gerar({modo: 'CONFERIR', rotulo: 'abc; rm -rf /'}), /ROTULO_INVALIDO/);
});

test('carga: o executor com o sha LF da árvore', () => {
  const c = b.carga(root);
  assert.deepEqual(c.map(x => x.arquivo), [...b.ARQUIVOS]);
  for (const x of c) assert.equal(x.sha, sha(fs.readFileSync(path.join(root, x.arquivo), 'utf8').replace(/\r\n/g, '\n')));
});

test('shell de outro serviço (staging) ou sem RENDER_SERVICE_ID não executa nada, em nenhum bloco', () => {
  for (const servico of ['srv-daif418ae00c73e8k2gg', undefined]) {
    const d = deploy();
    try {
      for (const modo of b.MODOS) {
        const s = rodar(d, modo, undefined, {servico});
        assert.match(s.saida, /SHELL_ERRADO_NAO_E_PRODUCAO/); assert.equal(codigo(s.saida), undefined, modo);
      }
      assert.equal(fs.existsSync(path.join(d, PASTA)), false); assert.ok(intactos(d));
    } finally { fs.rmSync(d, {recursive: true, force: true}); }
  }
});

test('CONFERIR/ENVIAR: transportam o executor com sha conferido e o rodam da pasta própria; comando oficial recusa fora do Render (1), sem chave na saída', () => {
  const d = deploy();
  try {
    const p = rodar(d, 'CONFERIR', PLANO);
    assert.equal(codigo(p.saida), 0, p.saida); assert.match(p.saida, /ARQUIVOS_OK 1/); assert.match(p.saida, /"resultado":"PLANO"/);
    assert.match(p.saida, /"destinatario":"contato@demerzellabs\.com\.br"/);
    assert.deepEqual(presentes(d), [...b.ARQUIVOS]);
    for (const x of b.carga(root)) assert.equal(sha(fs.readFileSync(path.join(d, PASTA, x.arquivo))), x.sha, x.arquivo);
    assert.equal(fs.readdirSync(path.join(d, 'tmp')).length, 0, 'temporário removido');
    for (const modo of ['CONFERIR', 'ENVIAR']) {
      const r = rodar(d, modo);
      assert.equal(codigo(r.saida), 1, r.saida); assert.match(r.saida, /"motivo":"FORA_DO_RENDER"/);
      assert.match(r.saida, /JA_PRESENTE scripts\/email-producao-20261020\.cjs/); assert.match(r.saida, /=== REGISTRO/);
      assert.ok(!r.saida.includes(CHAVE));
    }
    assert.ok(intactos(d));
  } finally { fs.rmSync(d, {recursive: true, force: true}); }
});

test('recusas do bloco (código 4, nada gravado): arquivo presente diferente, carga corrompida', () => {
  const d = deploy();
  try {
    fs.mkdirSync(path.join(d, PASTA, 'scripts'), {recursive: true});
    fs.writeFileSync(path.join(d, PASTA, b.EXECUTOR), '// outro conteudo\n');
    const s = rodar(d, 'ENVIAR', PLANO);
    assert.equal(codigo(s.saida), 4); assert.match(s.saida, /JA_EXISTE_DIFERENTE scripts\/email-producao-20261020\.cjs/);
    assert.equal(fs.readFileSync(path.join(d, PASTA, b.EXECUTOR), 'utf8'), '// outro conteudo\n');
    assert.doesNotMatch(s.saida, /"resultado"/, 'executor não rodou');
    fs.rmSync(path.join(d, PASTA), {recursive: true});
    const bloco = gerar(d, 'ENVIAR', PLANO), i = bloco.indexOf("<<'B64'\n") + 200;
    const corrompido = bloco.slice(0, i) + (bloco[i] === 'A' ? 'B' : 'A') + bloco.slice(i + 1);
    const c = sessao(d, corrompido);
    assert.equal(codigo(c.saida), 4); assert.match(c.saida, /CONTEUDO_DIVERGENTE/); assert.deepEqual(presentes(d), []);
    assert.doesNotMatch(c.saida, /"resultado"/);
    assert.ok(intactos(d));
  } finally { fs.rmSync(d, {recursive: true, force: true}); }
});

test('colagem interativa (bash -i) funciona; colagem truncada não executa nada',
  {skip: BASH_INTERATIVO ? false : 'bash interativo (bash -i com stdin em pipe) indisponível neste ambiente'}, () => {
  const d = deploy();
  try {
    const s = sessao(d, gerar(d, 'ENVIAR', PLANO), {interativo: true});
    assert.equal(codigo(s.saida), 0, s.saida); assert.deepEqual(presentes(d), [...b.ARQUIVOS]);
    const o = sessao(d, gerar(d, 'ENVIAR'), {interativo: true});
    assert.equal(codigo(o.saida), 1, o.saida); assert.match(o.saida, /FORA_DO_RENDER/); assert.ok(!o.saida.includes(CHAVE));
    fs.rmSync(path.join(d, PASTA), {recursive: true});
    const bloco = gerar(d, 'ENVIAR', PLANO);
    const t = sessao(d, bloco.slice(0, Math.floor(bloco.length / 2)), {interativo: true});
    assert.equal(codigo(t.saida), undefined); assert.equal(fs.existsSync(path.join(d, PASTA)), false);
    assert.ok(intactos(d));
  } finally { fs.rmSync(d, {recursive: true, force: true}); }
});

test('LIMPEZA: remove só o arquivo com sha conferido, preserva divergente, nunca toca deploy nem disco; sem pasta = nada a limpar', () => {
  const d = deploy();
  try {
    const vazio = rodar(d, 'LIMPEZA');
    assert.equal(codigo(vazio.saida), 0); assert.match(vazio.saida, /PASTA_AUSENTE/);
    rodar(d, 'CONFERIR', PLANO);
    fs.writeFileSync(path.join(d, PASTA, b.EXECUTOR), '// alterado\n');
    const s = rodar(d, 'LIMPEZA');
    assert.equal(codigo(s.saida), 0); assert.match(s.saida, /DIVERGENTE_PRESERVADO scripts\/email-producao-20261020\.cjs/);
    assert.match(s.saida, /PASTA_MANTIDA/); assert.deepEqual(presentes(d), [b.EXECUTOR]);
    fs.rmSync(path.join(d, PASTA, b.EXECUTOR));
    rodar(d, 'CONFERIR', PLANO);
    const s2 = rodar(d, 'LIMPEZA');
    assert.match(s2.saida, /REMOVIDO scripts\/email-producao-20261020\.cjs/); assert.match(s2.saida, /PASTA_REMOVIDA/);
    assert.equal(fs.existsSync(path.join(d, PASTA)), false);
    assert.ok(intactos(d));
  } finally { fs.rmSync(d, {recursive: true, force: true}); }
});

// O gzip grava o sistema operacional no cabeçalho (byte 9: 10 no Windows, 3 no Linux) e o zlib embutido varia por versão
// do Node: os blocos do pacote foram gerados no Windows (Node 24.20.0, zlib 1.3.2.1-motley). Fora dessa combinação o
// conteúdo transportado é o mesmo (teste "carga"), mas os bytes do bloco diferem; por isso a fixação só roda nela.
const MESMO_GERADOR = process.platform === 'win32' && process.versions.zlib === '1.3.2.1-motley-42c2f19';
test('blocos do pacote pacote-email-producao-20261020 (árvore 7494087) continuam byte a byte iguais',
  {skip: MESMO_GERADOR ? false : 'bytes do gzip dependem do SO/zlib; blocos do pacote gerados no Windows com zlib 1.3.2.1-motley'}, () => {
  // Mudar o executor ou o gerador muda estes sha: exige nova geração, nova revisão e novo pacote (docs/EMAIL_PRODUCAO_20261020.md §10).
  // Revalidação de 23/10/2026 (só o hash fixado de lib/acessos/erros.ts no executor; mudança só de tipo): pacote anterior
  // CONFERIR 8f77a397… (9612), ENVIAR 7cdbb59c… (9743), LIMPEZA 9e9967a0… (2285). Ver docs/EMAIL_PRODUCAO_20261020.md.
  const pacote = {CONFERIR: ['dd8ebb2fb2a75e3cf5f1a3f851088eb6fde274d81b38d34ab0bed61640e63c97', 9985],
    ENVIAR: ['85218447e5fc14fb674896ac8de598faf44e67fcb265435c6a68ec4744503ecb', 10116],
    LIMPEZA: ['03bcae5b5b9ba4553dc1f62afd639d413b2c9690d5de8836cb63fa654468af5c', 2285]};
  for (const [modo, [h, bytes]] of Object.entries(pacote)) {
    const x = b.gerar({modo, rotulo: '7494087'});
    assert.equal(sha(x), h, modo); assert.equal(Buffer.byteLength(x), bytes, modo);
  }
});
