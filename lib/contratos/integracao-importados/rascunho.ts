import type { DbExecutor } from '../../db/contracts.ts';
import type { TenantComprovado } from '../../saas/provar-tenant.ts';
import type { PlanoImportacao } from '../../importacao-contrato/plano.ts';
import type { ImportacaoLida } from '../../importacao-contrato/repositorio-importacao.ts';
import { clienteDaEmpresa } from './repositorio.ts';
import { normalizarCpf, normalizarEmail, normalizarTelefone } from '../../clientes/repositories/normalizers.ts';
import type { FonteIntegracaoRascunho } from './servico.ts';
import { IntegracaoImportadoError } from './servico.ts';

/** Preview sem writes nem UUID inventado de cliente persistido. Somente o plano validado no tenant entra aqui. */
export async function fonteDoRascunho(tx: DbExecutor, tenant: TenantComprovado, importacao: ImportacaoLida, plano: PlanoImportacao): Promise<FonteIntegracaoRascunho> {
  if (!plano.pronto || importacao.status !== 'EM_REVISAO') throw new IntegracaoImportadoError('IMPORTACAO_BLOQUEADA', 'Confira o cliente e os dados do contrato antes de continuar.', 409);
  const passo = plano.passos.find(p => p.tipo === 'CLIENTE');
  if (!passo || passo.tipo !== 'CLIENTE') throw new IntegracaoImportadoError('IMPORTACAO_BLOQUEADA', 'Defina o cliente.', 409);
  const cliente = passo.acao === 'VINCULAR'
    ? await clienteDaEmpresa(tx, tenant.empresaComprovada, passo.clienteId, false)
    // Cliente novo: mesma forma que o repositório grava (só dígitos, e-mail minúsculo). Assim o resumo e o hash da
    // simulação coincidem com a confirmação, que relê o cliente já criado no banco.
    : { id: importacao.id, ...passo.dados, nomeCompleto: passo.dados.nomeCompleto.trim(), cpf: normalizarCpf(passo.dados.cpf),
        telefone: normalizarTelefone(passo.dados.telefone), whatsapp: normalizarTelefone(passo.dados.whatsapp), email: normalizarEmail(passo.dados.email), status: 'ATIVO' };
  if (!cliente) throw new IntegracaoImportadoError('NAO_ENCONTRADO', 'Cliente não encontrado.', 404);
  return { cliente, clienteNovo: passo.acao === 'CRIAR', importacao: { id: importacao.id, documentoId: importacao.documentoId, clienteId: cliente.id, status: 'EM_REVISAO', snapshot: plano.snapshot,
    recebimentosDocumento: (importacao.dados as { extracao?: { recebimentosDocumento?: unknown } }).extracao?.recebimentosDocumento } };
}
