import test from 'node:test';
import assert from 'node:assert/strict';
import type { DbExecutor } from '../../db/contracts.ts';
import type { PlanoImportacao } from '../../importacao-contrato/plano.ts';
import { fonteDoRascunho } from './rascunho.ts';
import { formularioCadastro } from '../../clientes/cadastro-contratual.ts';
import { hashCanonico } from './modelo.ts';

/** Cliente novo do rascunho: a fonte da simulação tem a MESMA forma que o repositório grava (hash do resumo estável). */
const tx: DbExecutor = { async query() { throw new Error('cliente novo não consulta o banco'); } };
const tenant = { empresaComprovada: 'e', membershipId: 'm', usuarioId: 'u', papelAtual: 'GESTAO' };
const importacao = { id: 'imp', documentoId: 'doc', extracaoId: 'ext', status: 'EM_REVISAO' as const, versao: 1, dados: {}, clienteId: null, resultado: null, criadoPor: 'u' };
const plano = (dados: Record<string, string | null>) => ({ pronto: true, snapshot: {}, passos: [{ tipo: 'CLIENTE', acao: 'CRIAR', dados }] }) as unknown as PlanoImportacao;

test('CPF, telefone, WhatsApp e e-mail do PDF chegam formatados e saem como o banco grava', async () => {
  const fonte = await fonteDoRascunho(tx, tenant, importacao, plano({ nomeCompleto: ' Ana Souza ', cpf: '529.982.247-25', telefone: '(11) 99999-0000', whatsapp: null, email: ' Ana@Example.com ' }));
  assert.equal(fonte.clienteNovo, true);
  const gravado = { id: 'imp', nomeCompleto: 'Ana Souza', cpf: '52998224725', telefone: '11999990000', whatsapp: null, email: 'ana@example.com', status: 'ATIVO' };
  assert.deepEqual(fonte.cliente, gravado);
  // O que entra no resumo/hash da simulação é idêntico ao que a confirmação relê do banco.
  assert.equal(hashCanonico(formularioCadastro(fonte.cliente)), hashCanonico(formularioCadastro(gravado)));
});
