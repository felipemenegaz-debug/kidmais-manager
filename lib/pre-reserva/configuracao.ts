import { z } from 'zod';
import type { DbExecutor } from '../db/contracts.ts';
import type { SessaoAdmin } from '../autenticacao/service.ts';
import { exigirGestaoNoTenant, type TenantComprovado } from '../saas/provar-tenant.ts';
import { exigirRecursoPlano } from '../assinatura/recursos-plano.ts';
import { exigirReautenticacaoPerfil } from '../perfil/reautenticacao.ts';
import { PacoteAdminError } from '../comercial/pacotes-admin.ts';
import { registrarAuditoria } from '../clientes/repositories/auditoria.repository';
import { POLITICA_PRE_RESERVA as politica } from './politica.ts';

const schema = z.object({
  habilitada: z.boolean(),
  sinalCentavos: z.number().int().min(politica.sinalMinimoCentavos).max(politica.sinalMaximoCentavos),
  versao: z.number().int().nonnegative(),
}).strict();
type Configuracao = z.infer<typeof schema>;

export async function configuracaoPreReserva(tx: DbExecutor, tenant: TenantComprovado): Promise<Configuracao> {
  exigirGestaoNoTenant(tenant, 'Somente a Gestão consulta a configuração de pré-reserva.');
  const { rows } = await tx.query<Configuracao>(
    'SELECT habilitada, sinal_centavos AS "sinalCentavos", versao FROM pre_reserva_configuracoes WHERE empresa_id=$1',
    [tenant.empresaComprovada]);
  return rows[0] ?? { habilitada: false, sinalCentavos: politica.sinalPadraoCentavos, versao: 0 };
}

/** Executada na transação de tenant, que mantém a empresa e o papel da Gestão travados. */
export async function salvarConfiguracaoPreReserva(tx: DbExecutor, tenant: TenantComprovado, sessao: SessaoAdmin, entrada: unknown) {
  const antes = await configuracaoPreReserva(tx, tenant);
  exigirReautenticacaoPerfil(sessao);
  const dados = schema.parse(entrada);
  if (dados.versao !== antes.versao) throw new PacoteAdminError('PRE_RESERVA_VERSAO', 'Atualize a configuração antes de salvar.', 409);
  const empresa = tenant.empresaComprovada;
  if (dados.habilitada) {
    await exigirRecursoPlano(tx, empresa, 'ORCAMENTO_ONLINE');
    if (!(await tx.query('SELECT 1 FROM empresa_pix_recebimento WHERE empresa_id=$1 FOR SHARE', [empresa])).rows.length)
      throw new PacoteAdminError('PRE_RESERVA_SEM_PIX', 'Configure o recebedor Pix da empresa antes de aderir.', 409);
  }
  const { rows } = await tx.query<Configuracao>(`
    INSERT INTO pre_reserva_configuracoes(empresa_id, habilitada, sinal_centavos, atualizado_por)
    VALUES ($1,$2,$3,$4) ON CONFLICT (empresa_id) DO UPDATE SET
      habilitada=excluded.habilitada, sinal_centavos=excluded.sinal_centavos, atualizado_por=excluded.atualizado_por,
      versao=pre_reserva_configuracoes.versao+1, atualizado_em=clock_timestamp()
    RETURNING habilitada, sinal_centavos AS "sinalCentavos", versao`, [empresa, dados.habilitada, dados.sinalCentavos, tenant.usuarioId]);
  await registrarAuditoria({ atorTipo: 'USUARIO', usuarioId: tenant.usuarioId, acao: 'PRE_RESERVA_CONFIGURADA',
    entidadeTipo: 'EMPRESA', entidadeId: empresa, dadosAntes: antes, dadosDepois: rows[0], origem: 'CRM_INTERNO' }, tx);
  return rows[0];
}
