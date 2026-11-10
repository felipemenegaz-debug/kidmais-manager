import assert from 'node:assert/strict';
import test from 'node:test';
import { carregarComponente, texto } from '../admin/teste-componente.ts';

/**
 * GET da página pública executado de verdade: o carregador é estrito, então qualquer import novo (banco, helper de
 * marca, serviço) falha aqui. A resposta é a mesma para contrato existente, inexistente ou id inválido.
 */
const ARQUIVO = 'app/contrato/[contratoId]/page.tsx';

function carregar() {
  return carregarComponente(ARQUIVO, { '@/components/contrato/ContratoPublico': { default: 'ContratoPublico' } });
}

test('a página só importa o componente público e responde igual para qualquer id', async () => {
  const pagina = carregar();
  const montar = (contratoId: string) => (pagina.modulo.default as (p: object) => Promise<{ type: unknown; key: unknown; props: Record<string, unknown> }>)({ params: Promise.resolve({ contratoId }) });
  const respostas = [];
  for (const id of ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'nao-e-uuid']) {
    const r = await montar(id);
    assert.equal(r.type, 'ContratoPublico');
    assert.deepEqual(Object.keys(r.props), ['contratoId'], 'só o id vai para a tela');
    assert.equal(r.key, id, 'nova montagem por contrato');
    respostas.push(JSON.stringify({ ...r, key: null, props: { ...r.props, contratoId: null } }));
  }
  assert.equal(new Set(respostas).size, 1);
  assert.equal(texto(await montar('x')), '');
});

test('metadados neutros, sem nome de buffet nem da Kidmais', () => {
  const metadata = carregar().modulo.metadata as { title: string; description: string; robots: unknown };
  assert.equal(metadata.title, 'Contrato');
  assert.doesNotMatch(JSON.stringify(metadata), /kidmais|buffet estrela/i);
  assert.deepEqual(metadata.robots, { index: false, follow: false });
});
