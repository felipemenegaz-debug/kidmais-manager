import { z } from 'zod';
import type { DbExecutor } from '../../db/contracts';
import type { SessaoAdmin } from '../../autenticacao/service.ts';
import { registrarAuditoria as registrarAuditoriaPadrao } from '../../clientes/repositories/auditoria.repository';
import { PacoteAdminError } from '../../comercial/pacotes-admin.ts';
import { listarRecebiveis } from '../../financeiro/servico.ts';
import { exigirReautenticacaoPerfil } from '../../perfil/reautenticacao.ts';
import type { TenantComprovado } from '../../saas/provar-tenant.ts';
import { perfilDoTenantOuNulo } from '../../perfil/tenant.ts';
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

/**
 * Nome e cidade do recebedor no BR Code vêm do Perfil da empresa (nome comercial, senão razão social, senão o nome da
 * empresa; cidade da sede), já no limite do padrão (25 e 15, sem acentos). O app do banco mostra o nome cadastrado no
 * banco; estes campos são informativos e obrigatórios no padrão. Perfil ausente ou ambíguo: nome da empresa, sem cidade.
 */
export async function recebedorDoPerfil(tx: DbExecutor, empresaId: string) {
    const empresa = (await tx.query<{ nome: string }>('SELECT nome FROM empresas WHERE id = $1::uuid', [empresaId])).rows[0];
    let perfil: { nome_comercial: string | null; razao_social: string | null; sede_cidade: string | null } | undefined;
    try {
        const perfilId = await perfilDoTenantOuNulo(tx, empresaId);
        if (perfilId)
            perfil = (await tx.query<{ nome_comercial: string | null; razao_social: string | null; sede_cidade: string | null }>(
                'SELECT nome_comercial, razao_social, sede_cidade FROM perfil_empresas WHERE id = $1::uuid', [perfilId])).rows[0];
    } catch {
        perfil = undefined;
    }
    const nome = textoBrCode(perfil?.nome_comercial || perfil?.razao_social || empresa?.nome || '', 25);
    const cidade = textoBrCode(perfil?.sede_cidade ?? '', 15);
    return { nome, cidade };
}

export async function consultarConfiguracaoPix(tx: DbExecutor, tenant: TenantComprovado) {
    const podeEditar = tenant.papelAtual === GESTAO;
    if (!await pixInstalado(tx))
        return { instalado: false as const, configuracao: null, podeEditar, recebedor: null };
    const linha = await linhaDaEmpresa(tx, tenant.empresaComprovada);
    return {
        instalado: true as const,
        configuracao: linha ? publica(linha) : null,
        podeEditar,
        recebedor: await recebedorDoPerfil(tx, tenant.empresaComprovada),
    };
}

const salvarSchema = z.object({
    acao: z.literal('salvar'),
    tipoChave: z.enum(TIPOS_CHAVE_PIX),
    chave: z.string().max(120),
    // Legado da primeira tela: aceitos e ignorados; nome e cidade vêm sempre do Perfil.
    nomeRecebedor: z.string().max(120).optional(),
    cidadeRecebedor: z.string().max(120).optional(),
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
    const { nome, cidade } = await recebedorDoPerfil(tx, empresaId);
    if (!nome)
        erro('PIX_NOME_PERFIL', 'Informe o nome comercial no Perfil da empresa e aplique antes de cadastrar a chave Pix.', 409);
    if (!cidade)
        erro('PIX_CIDADE_PERFIL', 'Informe a cidade da sede no Perfil da empresa e aplique antes de cadastrar a chave Pix.', 409);
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
        erro('PIX_NAO_CONFIGURADO', 'Cadastre a chave Pix da empresa em Configurações → Perfil da empresa → Recebimento por Pix.', 409);
    const parcela = (await listarRecebiveis(tx, tenant.empresaComprovada, hoje))
        .find((r) => r.id === parcelaId && r.origem === 'CONTRATO');
    // Parcela de outra empresa, entrada manual ou inexistente: mesma resposta.
    if (!parcela)
        erro('PARCELA_NAO_ENCONTRADA', 'Parcela não encontrada.', 404);
    if (parcela.saldoCentavos <= 0 || parcela.status === 'Cancelado' || parcela.status === 'Reembolsado' || parcela.status === 'Pago')
        erro('PARCELA_SEM_SALDO', 'Esta parcela não tem saldo em aberto.', 409);
    const txid = txidDaParcela(parcela.id);
    // Perfil atual tem prioridade (nome ou cidade alterados depois); o gravado na chave é a reserva.
    const atual = await recebedorDoPerfil(tx, tenant.empresaComprovada);
    config.nome_recebedor = atual.nome || config.nome_recebedor;
    config.cidade_recebedor = atual.cidade || config.cidade_recebedor;
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
