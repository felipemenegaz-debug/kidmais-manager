import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '../db/contracts';
import { exigirGestaoNoTenant, type TenantComprovado } from '../saas/provar-tenant.ts';
import { listarRecebiveis } from '../financeiro/servico.ts';
import { registrarAuditoria } from '../clientes/repositories/auditoria.repository.ts';
import { csv } from './csv.ts';

/**
 * Exportação básica dos dados da PRÓPRIA empresa (E9): CSV de clientes e de contas a receber. Só Gestão; auditada sem
 * conteúdo. Fica disponível em qualquer situação comercial (o paywall sempre permite /api/admin/exportacao): a
 * política documentada garante que o vencimento nunca prende os dados da empresa.
 * Leitura pura: nenhum serviço que escreva (ex.: criação de categorias do contas a pagar) é chamado aqui.
 */
export const TIPOS_EXPORTACAO = ['clientes', 'contas-receber'] as const;
export type TipoExportacao = typeof TIPOS_EXPORTACAO[number];

const reais = (centavos: number) => (centavos / 100).toFixed(2).replace('.', ',');

export async function exportarDados(tx: DbExecutor, tenant: TenantComprovado, tipo: TipoExportacao, ctx: { requestId?: string; ip: string | null; userAgent: string | null }, hoje: string) {
    exigirGestaoNoTenant(tenant, 'Só a Gestão da empresa exporta os dados.');
    let conteudo: string;
    let total: number;
    if (tipo === 'clientes') {
        const linhas = (await tx.query<Record<string, string | null>>(
            `SELECT nome_completo, cpf, telefone, whatsapp, email, cep, logradouro, numero, complemento, bairro, cidade, uf, status, criado_em::date::text AS criado_em
               FROM clientes WHERE empresa_id = $1::uuid ORDER BY nome_completo, id`, [tenant.empresaComprovada])).rows;
        conteudo = csv(['Nome', 'CPF', 'Telefone', 'WhatsApp', 'E-mail', 'CEP', 'Logradouro', 'Número', 'Complemento', 'Bairro', 'Cidade', 'UF', 'Situação', 'Cadastrado em'],
            linhas.map((c) => [c.nome_completo, c.cpf, c.telefone, c.whatsapp, c.email, c.cep, c.logradouro, c.numero, c.complemento, c.bairro, c.cidade, c.uf, c.status, c.criado_em]));
        total = linhas.length;
    }
    else {
        const recebiveis = await listarRecebiveis(tx, tenant.empresaComprovada, hoje);
        conteudo = csv(['Cliente', 'Pacote', 'Data da festa', 'Parcela', 'Vencimento', 'Valor (R$)', 'Recebido (R$)', 'Saldo (R$)', 'Forma', 'Situação'],
            recebiveis.map((r) => [r.cliente, r.pacote, r.data, r.parcela, r.vencimento, reais(r.valorCentavos), reais(r.recebidoCentavos), reais(r.saldoCentavos), r.forma, r.status]));
        total = recebiveis.length;
    }
    await registrarAuditoria({
        atorTipo: 'USUARIO', usuarioId: tenant.usuarioId, acao: 'EXPORTACAO_DADOS', entidadeTipo: 'EMPRESA', entidadeId: tenant.empresaComprovada,
        dadosAntes: null, dadosDepois: { tipo, linhas: total, empresaId: tenant.empresaComprovada, resultado: 'SUCESSO' }, justificativa: null,
        origem: 'EXPORTACAO', requestId: ctx.requestId ?? randomUUID(), ip: ctx.ip, userAgent: ctx.userAgent,
    }, tx);
    return { conteudo, total, arquivo: `kidmais-${tipo}-${hoje}.csv` };
}
