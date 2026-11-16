/* eslint-disable @typescript-eslint/no-require-imports */
// Execução LOCAL: mocks apenas; não carrega .env nem importa o driver do banco.
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const path = require('node:path');
process.chdir(path.resolve(__dirname, '../../..'));
const env = { ...process.env };
for (const k of Object.keys(env)) if (/DATABASE_URL|^PG|^NODE_OPTIONS$|^NODE_ENV$/i.test(k)) delete env[k];
const out = __dirname;
const ui = 'components/admin/FinanceiroTelas.tsx';
const writer = 'lib/financeiro/escritor-p2.ts';
const uiTest = 'components/admin/financeiro-p2b-acoes.test.ts';
const writerTest = 'lib/financeiro/escritor-p2.test.ts';
const files = [ui, writer, 'lib/financeiro/submissao.ts', uiTest, writerTest];
const originals = new Map(files.map(f => [f, fs.readFileSync(f)]));
const sha = b => createHash('sha256').update(b).digest('hex');
const results = [];
function run(name, tests, pattern) {
  const args = ['--experimental-strip-types', '--test', ...(pattern ? ['--test-name-pattern', pattern] : []), ...tests];
  const r = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 60000 });
  fs.writeFileSync(path.join(out, name + '.log'), r.stdout + r.stderr);
  const result = { name, exit: r.status, error: r.error?.message };
  results.push(result); console.log(result);
  return r;
}
function mutate(name, file, from, to, tests) {
  const original = originals.get(file);
  const text = original.toString('utf8');
  if (!text.includes(from)) throw new Error('marcador ausente: ' + name);
  try {
    fs.writeFileSync(file, text.replace(from, to));
    run(name, tests);
  } finally {
    fs.writeFileSync(file, original);
    if (sha(fs.readFileSync(file)) !== sha(original)) throw new Error('restauração falhou');
  }
}
const temp = 'components/admin/financeiro-p2b-r2-codex.tmp.test.ts';
const extra = `
// Contraprovas independentes da rodada 2: controles e reprodução da lacuna.
test('R2: reversão renova na recusa e preserva em rede e JSON ilegível', async () => {
  const { t, pedidos } = comRede();
  const amostra = { contas: [conta('c1', 'Pago', 1000)], categorias: [], operacoes: LIGADAS };
  linhas(t.render('default', { tela: 'pagar', amostra }))[0].extra!.aoClicar();
  pedidos[0].responder(200, { ok: true, data: [{ id: 's1', data: '2026-11-09', valorCentavos: 1000, revertidoCentavos: 0, restanteCentavos: 1000, forma: 'PIX' }] });
  await tique(); await tique();
  const enviar = async () => {
    (porNome(t.render('default', { tela: 'pagar', amostra }), 'Dialogo')!.props.aoEnviar as (f: unknown) => void)(formulario({ saidaId: 's1', valor: '4', data: '2026-11-09', motivo: 'ajuste' }));
    await tique(); return pedidos[pedidos.length - 1];
  };
  const a = await enviar();
  assert.match(a.url, /reversoes$/);
  a.responder(409, { ok: false, erro: 'recusada' });
  await tique(); await tique();
  const b = await enviar(); assert.notEqual(b.corpo?.chave, a.corpo?.chave);
  b.falhar(); await tique(); await tique();
  const c = await enviar(); assert.equal(c.corpo?.chave, b.corpo?.chave);
  c.responder(502, new SyntaxError('JSON ilegível simulado')); await tique(); await tique();
  const d = await enviar(); assert.equal(d.corpo?.chave, c.corpo?.chave);
});

test('R2: pagamento da fase A preserva chave após recusa', async () => {
  const { t, pedidos } = comRede();
  const amostra = { contas: [conta('c1', 'A pagar', 0)], categorias: [], operacoes: LIGADAS };
  linhas(t.render('default', { tela: 'pagar', amostra }))[0].acao!();
  const enviar = async () => {
    (porNome(t.render('default', { tela: 'pagar', amostra }), 'Dialogo')!.props.aoEnviar as (f: unknown) => void)(formulario({ valor: '4', data: '2026-11-09', forma: 'PIX' }));
    await tique(); return pedidos[pedidos.length - 1];
  };
  const a = await enviar(); a.responder(409, { ok: false, erro: 'recusada' });
  await tique(); await tique();
  const b = await enviar(); assert.equal(b.corpo?.chave, a.corpo?.chave);
});

test('R2: JSON ilegível preserva a chave da liquidação', async () => {
  const { t, pedidos } = comRede();
  const amostra = { recebiveis: [entrada('e1', 'A receber', 1000)], operacoes: LIGADAS };
  linhas(t.render('default', { tela: 'receber', amostra }))[0].acao!();
  const enviar = async () => {
    (porNome(t.render('default', { tela: 'receber', amostra }), 'Dialogo')!.props.aoEnviar as (f: unknown) => void)(formulario({ valor: '4', data: '2026-11-09', forma: 'PIX' }));
    await tique(); return pedidos[pedidos.length - 1];
  };
  const a = await enviar();
  a.responder(502, new SyntaxError('JSON ilegível simulado'));
  await tique(); await tique();
  const b = await enviar();
  assert.equal(b.corpo?.chave, a.corpo?.chave);
});

test('R2: limpar data invalida a leitura pendente (contrato esperado)', async () => {
  const { t, pedidos } = comRede();
  const props = { aoMudar: () => undefined };
  t.render('PainelAbertura', props); t.efeitos();
  pedidos[0].responder(200, LEITURA('2026-11-10', 'h-hoje'));
  await tique(); await tique();
  const arvore = () => elementos(t.render('PainelAbertura', props) as Elemento);
  const campo = () => arvore().find(e => e.type === 'input' && e.props.name === 'dataBase')!;
  const mudar = (value: string) => (campo().props.onChange as (e: unknown) => void)({ target: { value } });
  mudar('2026-10-01'); mudar('');
  assert.equal(campo().props.value, '');
  pedidos[1].responder(200, LEITURA('2026-10-01', 'h-outubro'));
  await tique(); await tique();
  assert.equal(campo().props.value, '', 'resposta de seleção abandonada não deve repor a data apagada');
  assert.equal(arvore().find(e => e.type === 'button' && e.props.type === 'submit')!.props.disabled, true);
});

test('R2: reproduz data apagada reposta e POST liberado pela resposta abandonada', async () => {
  const { t, pedidos } = comRede();
  const props = { aoMudar: () => undefined };
  t.render('PainelAbertura', props); t.efeitos();
  pedidos[0].responder(200, LEITURA('2026-11-10', 'h-hoje'));
  await tique(); await tique();
  const arvore = () => elementos(t.render('PainelAbertura', props) as Elemento);
  const campo = () => arvore().find(e => e.type === 'input' && e.props.name === 'dataBase')!;
  const mudar = (value: string) => (campo().props.onChange as (e: unknown) => void)({ target: { value } });
  mudar('2026-10-01'); mudar('');
  assert.equal(campo().props.value, '');
  assert.equal(arvore().find(e => e.type === 'button' && e.props.type === 'submit')!.props.disabled, true);
  pedidos[1].responder(200, LEITURA('2026-10-01', 'h-outubro'));
  await tique(); await tique();
  assert.equal(campo().props.value, '2026-10-01');
  assert.equal(arvore().find(e => e.type === 'button' && e.props.type === 'submit')!.props.disabled, false);
  const old = globalThis.FormData;
  globalThis.FormData = function() { return formulario({ saldo: '100', justificativa: 'extrato' }); } as unknown as typeof FormData;
  try {
    void (arvore().find(e => e.type === 'form')!.props.onSubmit as (e: unknown) => Promise<void>)({ preventDefault() {}, currentTarget: {} });
    await tique();
    assert.equal(pedidos[2].corpo?.dataBase, '2026-10-01');
    assert.equal(pedidos[2].corpo?.conjuntoHash, 'h-outubro');
  } finally { globalThis.FormData = old; }
});

test('R2: leitura recusada mantém envio bloqueado; resposta mais antiga não altera nada', async () => {
  const { t, pedidos } = comRede();
  const props = { aoMudar: () => undefined };
  t.render('PainelAbertura', props); t.efeitos();
  pedidos[0].responder(200, LEITURA('2026-11-10', 'h-hoje'));
  await tique(); await tique();
  const arvore = () => elementos(t.render('PainelAbertura', props) as Elemento);
  const campo = () => arvore().find(e => e.type === 'input' && e.props.name === 'dataBase')!;
  for (const value of ['2026-10-01', '2026-09-01']) (campo().props.onChange as (e: unknown) => void)({ target: { value } });
  pedidos[2].responder(409, { ok: false, erro: 'recusada' });
  await tique(); await tique();
  pedidos[1].responder(200, LEITURA('2026-10-01', 'h-outubro'));
  await tique(); await tique();
  assert.equal(campo().props.value, '2026-09-01');
  assert.equal(arvore().find(e => e.type === 'button' && e.props.type === 'submit')!.props.disabled, true);
});
`;
try {
  run('controle-direcionado', [uiTest, writerTest]);
  mutate('mutante-sem-bloqueio', ui, 'if (ocupado || !previaDaData) return;', 'if (ocupado) return;', [uiTest]);
  mutate('mutante-sem-descarte', ui, 'if (numero !== leituraRef.current) return;', '/* descarte removido */', [uiTest]);
  mutate('mutante-sem-renovacao', ui, 'opcoes.renovarNaRecusa ? recusarAcao(acaoRef.current, () => crypto.randomUUID()) : finalizarAcao(acaoRef.current, \'erro\')', 'finalizarAcao(acaoRef.current, \'erro\')', [uiTest]);
  mutate('mutante-sem-comparacao-lote', writer, 'if (!mesmo) recusar(', 'if (false) recusar(', [writerTest]);
  fs.writeFileSync(temp, fs.readFileSync(uiTest, 'utf8').replace('json: async () => corpo', 'json: async () => { if (corpo instanceof Error) throw corpo; return corpo; }') + extra);
  run('contraprovas-extras', [temp], '^R2:');
  run('controle-final', [uiTest, writerTest]);
} finally {
  if (fs.existsSync(temp)) fs.unlinkSync(temp);
  const hashes = files.map(file => ({ file, before: sha(originals.get(file)), after: sha(fs.readFileSync(file)) }));
  fs.writeFileSync(path.join(out, 'resultado.json'), JSON.stringify({ results, hashes }, null, 2));
  if (hashes.some(h => h.before !== h.after)) throw new Error('SHA divergente ao terminar');
}
