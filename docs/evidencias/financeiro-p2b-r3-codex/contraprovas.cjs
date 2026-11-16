/* eslint-disable @typescript-eslint/no-require-imports */
// Reusa as contraprovas históricas sem sobrescrever as evidências da rodada 2.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const old = path.resolve(__dirname, '../financeiro-p2b-r2-codex/contraprovas.cjs');
let source = fs.readFileSync(old, 'utf8');
source = source.replace("financeiro-p2b-r2-codex.tmp.test.ts", "financeiro-p2b-r3-codex.tmp.test.ts");
// A reprodução positiva da falha antiga deve agora falhar; preservamos só o contrato correto.
source = source.replace(/test\('R2: reproduz data apagada[\s\S]*?(?=test\('R2: leitura recusada)/, '');
const extras = `
for (const ordem of ['antiga-primeiro', 'nova-primeiro', 'erro-nova', 'rede-nova']) {
  test('R3: vazio seguido de nova data: ' + ordem, async () => {
    const { t, pedidos } = comRede();
    const props = { aoMudar: () => undefined };
    t.render('PainelAbertura', props); t.efeitos();
    pedidos[0].responder(200, LEITURA('2026-11-10', 'hoje'));
    await tique(); await tique();
    const arvore = () => elementos(t.render('PainelAbertura', props) as Elemento);
    const campo = () => arvore().find(e => e.type === 'input' && e.props.name === 'dataBase')!;
    const botao = () => arvore().find(e => e.type === 'button' && e.props.type === 'submit')!;
    const mudar = (value: string) => (campo().props.onChange as (e: unknown) => void)({ target: { value } });
    mudar('2026-10-01'); mudar(''); mudar('2026-09-01');
    const antiga = async () => { pedidos[1].responder(200, LEITURA('2026-10-01', 'antiga')); await tique(); await tique(); };
    if (ordem === 'antiga-primeiro') { await antiga(); assert.equal(botao().props.disabled, true); }
    if (ordem === 'erro-nova') pedidos[2].responder(409, { ok: false, erro: 'recusada' });
    else if (ordem === 'rede-nova') pedidos[2].falhar();
    else pedidos[2].responder(200, LEITURA('2026-09-01', 'nova'));
    await tique(); await tique();
    if (ordem !== 'antiga-primeiro') await antiga();
    assert.equal(campo().props.value, '2026-09-01');
    assert.equal(botao().props.disabled, ordem === 'erro-nova' || ordem === 'rede-nova');
    const original = globalThis.FormData;
    globalThis.FormData = function() { return formulario({ saldo: '100', justificativa: 'extrato' }); } as unknown as typeof FormData;
    try {
      void (arvore().find(e => e.type === 'form')!.props.onSubmit as (e: unknown) => Promise<void>)({ preventDefault() {}, currentTarget: {} });
      await tique();
      if (ordem === 'erro-nova' || ordem === 'rede-nova') assert.equal(pedidos.length, 3);
      else { assert.equal(pedidos[3].corpo?.dataBase, '2026-09-01'); assert.equal(pedidos[3].corpo?.conjuntoHash, 'nova'); }
    } finally { globalThis.FormData = original; }
  });
}
for (const status of [200, 409]) {
  test('R3: POST ' + status + ' bloqueia edição e recarrega; vazio posterior descarta GET', async () => {
    const { t, pedidos } = comRede();
    let mudou = 0;
    const props = { aoMudar: () => { mudou++; } };
    assert.equal(t.render('PainelAbertura', props), null); t.efeitos();
    pedidos[0].responder(200, LEITURA('2026-11-10', 'inicial'));
    await tique(); await tique();
    const arvore = () => elementos(t.render('PainelAbertura', props) as Elemento);
    const campo = () => arvore().find(e => e.type === 'input' && e.props.name === 'dataBase')!;
    const botao = () => arvore().find(e => e.type === 'button' && e.props.type === 'submit')!;
    assert.equal(campo().props.value, '2026-11-10');
    const original = globalThis.FormData;
    globalThis.FormData = function() { return formulario({ saldo: '100', justificativa: 'extrato' }); } as unknown as typeof FormData;
    try {
      const tarefa = (arvore().find(e => e.type === 'form')!.props.onSubmit as (e: unknown) => Promise<void>)({ preventDefault() {}, currentTarget: {} });
      await tique();
      assert.equal(campo().props.disabled, true); assert.equal(botao().props.disabled, true);
      pedidos[1].responder(status, status === 200 ? { ok: true } : { ok: false, erro: 'conflito' });
      await tique(); await tique();
      assert.equal(campo().props.disabled, true);
      assert.equal(pedidos[2].url, '/api/admin/financeiro/abertura' + (status === 409 ? '?dataBase=2026-11-10' : ''));
      pedidos[2].responder(200, LEITURA('2026-11-10', 'recarregada'));
      await tarefa;
      assert.equal(mudou, status === 200 ? 1 : 0);
      assert.equal(campo().props.disabled, false);
      (campo().props.onChange as (e: unknown) => void)({ target: { value: '2026-10-01' } });
      (campo().props.onChange as (e: unknown) => void)({ target: { value: '' } });
      pedidos[3].responder(200, LEITURA('2026-10-01', 'abandonada'));
      await tique(); await tique();
      assert.equal(campo().props.value, ''); assert.equal(botao().props.disabled, true);
    } finally { globalThis.FormData = original; }
  });
}
`;
source = source.replace('const extra = `', 'const extra = `' + extras);
source = source.replace("'^R2:'", "'^R[23]:'");
source = source.replace("  run('controle-direcionado'", "  run('baseline', [uiTest, writerTest, 'lib/financeiro/escritor-p2-rotas.test.ts', 'lib/financeiro/contas-pagar-rota-datas.test.ts', 'lib/financeiro/recebimento-data-rota.test.ts', 'lib/financeiro/submissao.test.ts']);\n  mutate('mutante-sem-invalidacao-vazio', ui, 'leituraRef.current += 1;', '/* invalidação no vazio removida */', [uiTest]);\n  run('controle-direcionado'");
vm.runInNewContext(source, { require, __dirname, process, console, Buffer }, { filename: __filename });
