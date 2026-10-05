import test from 'node:test';
import assert from 'node:assert/strict';
import { achar, carregarComponente, elementos, texto, tique } from './teste-componente.ts';

test('cancelamento na tela do contrato exige permissão, motivo e confirmação; retry usa mesma chave', async () => {
  for (const permitido of [false, true]) {
    const pedidos: Record<string, unknown>[] = []; let concluido = 0;
    const tela = carregarComponente('components/admin/CancelarContratoFesta.tsx', {
      '@/lib/http/admin-fetch': { adminFetch: async (_url: string, init?: RequestInit) => {
        if (!init) return Response.json({ ok: true, data: { festa: { revisao: 7 }, contrato: { versao_id: 'vigente' }, capacidades: permitido ? ['FESTA_CORRIGIR'] : [] } });
        pedidos.push(JSON.parse(String(init.body)));
        return Response.json(pedidos.length === 1 ? { ok: false, erro: 'Tente novamente' } : { ok: true });
      } },
    });
    const render = () => tela.render('default', { festaId: 'festa', nome: 'Cliente de teste', onCancelado: async () => { concluido++; } });
    const clicar = async (rotulo: string) => { (achar(render(), 'button', rotulo).props.onClick as () => void)(); await tique(); };
    await clicar('Cancelar contrato');
    if (!permitido) { assert.match(texto(render()), /Seu acesso não permite cancelar/); assert.equal(pedidos.length, 0); continue; }
    assert.equal(achar(render(), 'button', 'Confirmar cancelamento').props.disabled, true);
    const motivo = elementos(render()).find(e => e.type === 'textarea')!;
    (motivo.props.onChange as (e: unknown) => void)({ target: { value: 'Cancelamento solicitado pelo cliente' } });
    assert.equal(achar(render(), 'button', 'Confirmar cancelamento').props.disabled, true);
    const confirmacao = elementos(render()).find(e => e.type === 'input' && e.props.type === 'checkbox')!;
    (confirmacao.props.onChange as (e: unknown) => void)({ target: { checked: true } });
    await clicar('Confirmar cancelamento');
    assert.match(texto(render()), /Tente novamente/); assert.equal(concluido, 0);
    await clicar('Confirmar cancelamento');
    assert.equal(concluido, 1); assert.deepEqual(pedidos[0], pedidos[1]);
    assert.equal(pedidos[0].versaoId, 'vigente'); assert.equal(pedidos[0].revisao, 7);
    assert.equal(pedidos[0].acao, 'cancelar_contratacao');
  }
});
