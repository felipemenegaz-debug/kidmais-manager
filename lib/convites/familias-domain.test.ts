import assert from 'node:assert/strict';
import test from 'node:test';
import { comandoSchema } from './domain.ts';
const id = '00000000-0000-4000-8000-000000000001';
const cadastro = { acao: 'familia_adicionar', id, nome: ' Família Silva ', adultos: 2, criancas: 1 };
test('cadastro de família aceita nome normalizado e rejeita campos de autorização controlados pelo visitante', () => {
  assert.equal(comandoSchema.parse(cadastro).acao, 'familia_adicionar');
  assert.equal((comandoSchema.parse(cadastro) as { nome: string }).nome, 'Família Silva');
  for (const extra of [{ empresa_id: id }, { token_hash: 'x' }, { convite_id: id }, { presenca: true }]) assert.equal(comandoSchema.safeParse({ ...cadastro, ...extra }).success, false);
});
test('cadastro limita tamanho, UUID, quantidade e exige ao menos uma pessoa', () => {
  for (const campos of [{ id: 'invalido' }, { nome: ' ' }, { nome: 'a'.repeat(101) }, { adultos: -1 }, { criancas: 21 }, { adultos: 1.5 }, { adultos: 0, criancas: 0 }]) assert.equal(comandoSchema.safeParse({ ...cadastro, ...campos }).success, false);
});
test('alterações de família exigem revisão e ação explícita', () => {
  for (const comando of [{ acao: 'familia_editar', id, nome: 'Silva', adultos: 1, criancas: 0 }, { acao: 'familia_link', id, habilitado: false }, { acao: 'familia_status', id, ativa: false }]) {
    assert.equal(comandoSchema.safeParse(comando).success, false);
    assert.equal(comandoSchema.safeParse({ ...comando, revisao: 0 }).success, false);
    assert.equal(comandoSchema.safeParse({ ...comando, revisao: 1 }).success, true);
  }
});
