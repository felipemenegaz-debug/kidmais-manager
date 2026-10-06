import { z } from 'zod';
import type { DbExecutor } from '../../db/contracts';
import type { SessaoAdmin } from '../../autenticacao/service.ts';
import { registrarAuditoria as registrarAuditoriaPadrao } from '../../clientes/repositories/auditoria.repository';
import { PacoteAdminError } from '../../comercial/pacotes-admin.ts';
import { listarRecebiveis } from '../../financeiro/servico.ts';
import { exigirReautenticacaoPerfil } from '../../perfil/reautenticacao.ts';
import type { TenantComprovado } from '../../saas/provar-tenant.ts';
import {
    mascararChavePix, montarBrCodeEstatico, normalizarChavePix, qrSvg, textoBrCode, TIPOS_CHAVE_PIX, txidDaParcela, type TipoChavePix,
} from './brcode.ts';

/**
 * Chave Pix da própria empresa (066) e Pix "copia e cola" / QR estático das parcelas das festas.
 *
 * - Tudo roda na transação do tenant (withTenantTransaction no chamador): a empresa é sempre a COMPROVADA da sessão.
 * - Configurar ou remover a chave decide para onde vai o dinheiro dos clientes: só a Gestão desta empresa, com
 *   reautenticação recente (mesma janela do Perfil), controle de versão e auditoria com a chave mascarada.
 * - O Pix da parcela usa o mesmo saldo da lista de contas a receber (listarRecebiveis); não grava nada. A baixa
 *   continua manual: o sistema não sabe se o cliente pagou.
 */
export type PixDeps = { registrarAuditoria: typeof registrarAuditoriaPadrao };
const padrao: PixDeps = { registrarAuditoria: registrarAuditoriaPadrao };
const GESTAO = 'REPRESENTANTE_AUTORIZADO';

type Linha = { tipo_chave: TipoChavePix; chave: string; nome_recebedor: string; cidade_recebedor: string; versao: number; atualizado_em: string };

export type ConfiguracaoPix = {
    tipoChave: TipoChavePix;
    chaveMascarada: string;
    nomeRecebedor: string;
    cidadeRecebedor: string;
    versao: number;
    atualizadoEm: string;
};

function erro(code: string, message: string, status: number): never {
    throw new PacoteAdminError(code, message, status);
}

export async function pixInstalado(tx: DbExecutor) {
    return (await tx.query<{ ok: boolean }>("SELECT to_regclass('public.empresa_pix_recebimento') IS NOT NULL AS ok")).rows[0]?.ok === true;
}

async function linhaDaEmpresa(tx: DbExecutor, empresaId: string, travar = false) {
    return (await tx.query<Linha>(
        `SELECT tipo_chave, chave, nome_recebedor, cidade_recebedor, versao, atualizado_em::text
           FROM empresa_pix_recebimento WHERE empresa_id = $1::uuid${travar ? ' FOR UPDATE' : ''}`, [empresaId])).rows[0] ?? null;
}

function publica(l: Linha): ConfiguracaoPix {
    return { tipoChave: l.tipo_chave, chaveMascarada: mascararChavePix(l.tipo_chave, l.chave), nomeRecebedor: l.nome_recebedor, cidadeRecebedor: l.cidade_recebedor, versao: l.versao, atualizadoEm: l.atualizado_em };
}

function auditavel(l: Linha | null) {
    return l ? { tipoChave: l.tipo_chave, chave: mascararChavePix(l.tipo_chave, l.chave), nomeRecebedor: l.nome_recebedor, cidadeRecebedor: l.cidade_recebedor, versao: l.versao } : null;
}

export async function consultarConfiguracaoPix(tx: DbExecutor, tenant: TenantComprovado) {
    const podeEditar = tenant.papelAtual === GESTAO;
    if (!await pixInstalado(tx))
        return { instalado: false as const, configuracao: null, podeEditar, sugestao: null };
    const linha = await linhaDaEmpresa(tx, tenant.empresaComprovada);
    const empresa = (await tx.query<{ nome: string }>('SELECT nome FROM empresas WHERE id = $1::uuid', [tenant.empresaComprovada])).rows[0];
    return {
        instalado: true as const,
        configuracao: linha ? publica(linha) : null,
        podeEditar,
        sugestao: { nomeRecebedor: textoBrCode(empresa?.nome ?? '', 25) },
    };
}

const salvarSchema = z.object({
    acao: z.literal('salvar'),
    tipoChave: z.enum(TIPOS_CHAVE_PIX),
    chave: z.string().max(120),
    nomeRecebedor: z.string().max(120),
    cidadeRecebedor: z.string().max(120),
    versao: z.number().int().positive().nullable(),
}).strict();

const removerSchema = z.object({
    acao: z.literal('remover'),
    versao: z.number().int().positive(),
    confirmar: z.literal(true),
}).strict();

function exigirGestaoComReautenticacao(sessao: SessaoAdmin, tenant: TenantComprovado) {
    if (tenant.papelAtual !== 'REPRESENTANTE_AUTORIZADO')
        erro('PIX_SEM_PERMISSAO', 'Somente a Gestão desta empresa altera a chave Pix de recebimento.', 403);
    exigirReautenticacaoPerfil(sessao);
}

type Contexto = { requestId: string; ip?: string | null; userAgent?: string | null };

export async function alterarConfiguracaoPix(tx: DbExecutor, tenant: TenantComprovado, sessao: SessaoAdmin, raw: unknown, ctx: Contexto, deps: PixDeps = padrao) {
    const acao = (raw as { acao?: unknown } | null)?.acao;
    const input = acao === 'remover' ? removerSchema.parse(raw) : salvarSchema.parse(raw);
    exigirGestaoComReautenticacao(sessao, tenant);
    if (!await pixInstalado(tx))
        erro('PIX_INDISPONIVEL', 'O recebimento por Pix ainda não está disponível neste ambiente.', 503);
    const empresaId = tenant.empresaComprovada;
    await tx.query("SELECT set_config('kidmais.ator_usuario_id', $1, true)", [sessao.usuario_id]);
    const antes = await linhaDaEmpresa(tx, empresaId, true);
    const conflito = () => erro('PIX_VERSAO', 'A chave Pix foi alterada por outra pessoa. Atualize a página e confira antes de salvar.', 409);
    const auditar = (acaoAuditoria: string, depois: Linha | null) => deps.registrarAuditoria({
        atorTipo: 'USUARIO', usuarioId: sessao.usuario_id, acao: acaoAuditoria, entidadeTipo: 'EMPRESA_PIX_RECEBIMENTO', entidadeId: empresaId,
        dadosAntes: antes ? { empresaId, ...auditavel(antes) } : null, dadosDepois: { empresaId, ...auditavel(depois) },
        origem: 'ADMIN_PIX', requestId: ctx.requestId, ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null,
    }, tx);

    if (input.acao === 'remover') {
        if (!antes || antes.versao !== input.versao)
            conflito();
        await tx.query('DELETE FROM empresa_pix_recebimento WHERE empresa_id = $1::uuid AND versao = $2', [empresaId, input.versao]);
        await auditar('PIX_RECEBIMENTO_REMOVIDO', null);
        return { configuracao: null };
    }

    const chave = normalizarChavePix(input.tipoChave, input.chave);
    if (!chave)
        erro('PIX_CHAVE_INVALIDA', 'Confira a chave Pix: ela não corresponde ao tipo escolhido.', 400);
    const nome = textoBrCode(input.nomeRecebedor, 25);
    const cidade = textoBrCode(input.cidadeRecebedor, 15);
    if (!nome)
        erro('PIX_NOME_INVALIDO', 'Informe o nome do recebedor (como aparece no banco).', 400);
    if (!cidade)
        erro('PIX_CIDADE_INVALIDA', 'Informe a cidade do recebedor.', 400);
    if ((antes?.versao ?? null) !== input.versao)
        conflito();
    const depois = antes
        ? (await tx.query<Linha>(
            `UPDATE empresa_pix_recebimento SET tipo_chave = $3, chave = $4, nome_recebedor = $5, cidade_recebedor = $6, versao = versao + 1,
                    atualizado_por = $7, atualizado_em = clock_timestamp()
              WHERE empresa_id = $1::uuid AND versao = $2
          RETURNING tipo_chave, chave, nome_recebedor, cidade_recebedor, versao, atualizado_em::text`,
            [empresaId, antes.versao, chave.tipo, chave.chave, nome, cidade, sessao.usuario_id])).rows[0]
        : (await tx.query<Linha>(
            `INSERT INTO empresa_pix_recebimento (empresa_id, tipo_chave, chave, nome_recebedor, cidade_recebedor, atualizado_por)
             VALUES ($1::uuid, $2, $3, $4, $5, $6)
          RETURNING tipo_chave, chave, nome_recebedor, cidade_recebedor, versao, atualizado_em::text`,
            [empresaId, chave.tipo, chave.chave, nome, cidade, sessao.usuario_id])).rows[0];
    if (!depois)
        conflito();
    await auditar('PIX_RECEBIMENTO_CONFIGURADO', depois);
    return { configuracao: publica(depois) };
}

/** Pix copia e cola + QR da parcela em aberto, no valor do saldo. Nada é gravado. */
export async function pixDaParcela(tx: DbExecutor, tenant: TenantComprovado, parcelaIdRaw: string, hoje: string) {
    const parcelaId = z.string().uuid().parse(parcelaIdRaw).toLowerCase();
    if (!await pixInstalado(tx))
        erro('PIX_INDISPONIVEL', 'O recebimento por Pix ainda não está disponível neste ambiente.', 503);
    const config = await linhaDaEmpresa(tx, tenant.empresaComprovada);
    if (!config)
        erro('PIX_NAO_CONFIGURADO', 'Cadastre a chave Pix da empresa em Configurações → Recebimento por Pix.', 409);
    const parcela = (await listarRecebiveis(tx, tenant.empresaComprovada, hoje))
        .find((r) => r.id === parcelaId && r.origem === 'CONTRATO');
    // Parcela de outra empresa, entrada manual ou inexistente: mesma resposta.
    if (!parcela)
        erro('PARCELA_NAO_ENCONTRADA', 'Parcela não encontrada.', 404);
    if (parcela.saldoCentavos <= 0 || parcela.status === 'Cancelado' || parcela.status === 'Reembolsado' || parcela.status === 'Pago')
        erro('PARCELA_SEM_SALDO', 'Esta parcela não tem saldo em aberto.', 409);
    const txid = txidDaParcela(parcela.id);
    const copiaECola = montarBrCodeEstatico({
        chave: config.chave, nomeRecebedor: config.nome_recebedor, cidadeRecebedor: config.cidade_recebedor,
        valorCentavos: parcela.saldoCentavos, txid,
    });
    return {
        copiaECola,
        qrSvg: qrSvg(copiaECola),
        valorCentavos: parcela.saldoCentavos,
        txid,
        parcela: { id: parcela.id, numero: parcela.parcela, vencimento: parcela.vencimento, cliente: parcela.cliente },
        recebedor: { nome: config.nome_recebedor, cidade: config.cidade_recebedor, tipoChave: config.tipo_chave, chaveMascarada: mascararChavePix(config.tipo_chave, config.chave) },
    };
}
