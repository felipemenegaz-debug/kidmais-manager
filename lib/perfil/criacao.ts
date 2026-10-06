import type { DbExecutor } from '../db/contracts';
import type { AppendAuditoriaInput } from '../clientes/repositories/auditoria.repository.ts';
import { ClienteServiceError } from '../clientes/services/errors.ts';
import { cnpjRaizPlaceholder, cnpjValido, normalizarCnpj } from '../cadastro/cnpj.ts';
import { exigirGestaoNoTenant, type TenantComprovado } from '../saas/provar-tenant.ts';
import { EMPRESA_SAAS_DO_PERFIL } from './autorizacao.ts';
import { estruturaCadastroInstalada } from './cadastro-service.ts';
import { CAPACIDADES_PERFIL, type CapacidadePerfil } from './capacidades.ts';
import { travarEmpresasPerfil, travarProvisionamentoInicial } from './protecao-usuarios.ts';
import { exigirReautenticacaoPerfil } from './reautenticacao.ts';

/**
 * Perfil da empresa na implantação de uma contratante nova — duas operações da Gestão da empresa comprovada pelo
 * Tenant Context, ambas com reautenticação recente (mesma janela e mesmo relógio do restante do Perfil):
 *
 *   1. CRIAÇÃO (`criar-perfil`): a empresa ainda não tem Perfil (026/027). Cria SOMENTE a estrutura mínima:
 *      `perfil_empresas` com o MESMO código da empresa SaaS (é isso que associa os dois cadastros) e, como
 *      pré-preenchimento, apenas o nome da empresa e, quando o painel registrou, razão social e CNPJ válidos;
 *      uma `perfil_unidades` (a V1 opera com uma unidade), herdando o endereço da sede; e as quatro capacidades do
 *      perfil para quem criou (bootstrap: sem isso ninguém administraria o perfil novo). Nada é copiado de outra empresa.
 *   2. CONCESSÃO INICIAL (`concessao-inicial`): o Perfil já existe, mas nenhuma conta elegível o administra (ninguém
 *      com PERFIL_ADMINISTRAR_CONCESSOES ativa que seja Gestão ATIVA nesta empresa com conta ativa). A Gestão recebe
 *      as capacidades que lhe faltam — só as que faltam, sem duplicar — e passa a administrar. Com administrador
 *      elegível existente, nada é concedido (409: peça a concessão a quem administra). Capacidade parcial (ex.: só
 *      PERFIL_CONSULTAR) não comprova administrador: a regra olha os administradores elegíveis, não o pedinte.
 *
 * A elegibilidade (`elegibilidadeConcessaoInicial`) é uma leitura sem travas, para a tela oferecer a ação; a
 * autorização real é refeita dentro da transação de escrita, com as mesmas regras e com as travas.
 */
type Auditoria = (input: AppendAuditoriaInput, tx?: DbExecutor) => Promise<unknown>;

export const MOTIVO_CRIACAO_PERFIL = 'Criação do perfil da empresa na implantação';
export const MOTIVO_CONCESSAO_INICIAL = 'Concessão inicial do perfil: nenhum administrador elegível';
export const SUFIXO_UNIDADE_INICIAL = '-principal';

export type ResultadoCriacaoPerfil = {
    criado: boolean;
    perfilId: string;
    unidadeId: string | null;
    capacidadesConcedidas: string[];
    motivo: 'CRIADO' | 'JA_EXISTE' | 'CONCESSAO_INICIAL';
};

export type MotivoInelegibilidade = 'SEM_GESTAO' | 'ESTRUTURA_AUSENTE' | 'SEM_PERFIL' | 'AMBIGUO' | 'ADMINISTRADOR_EXISTENTE' | 'JA_ADMINISTRA';
export type ElegibilidadeConcessaoInicial = {
    elegivel: boolean;
    motivo: MotivoInelegibilidade | null;
    /** Capacidades que a conta receberia (só as que faltam). Vazio quando inelegível. */
    capacidadesFaltantes: CapacidadePerfil[];
};

export function codigoUnidadeInicial(codigoEmpresa: string) {
    // perfil_unidades.codigo aceita até 64 caracteres; o código da empresa pode ter até 64.
    return `${codigoEmpresa.slice(0, 64 - SUFIXO_UNIDADE_INICIAL.length)}${SUFIXO_UNIDADE_INICIAL}`;
}

/** CNPJ aceito no perfil (CHECK 027: maiúsculo, 14 caracteres, DV válido, sem placeholder). */
export function cnpjParaPerfil(documento: string | null | undefined) {
    if (!documento)
        return null;
    const cnpj = normalizarCnpj(documento);
    return cnpj.length === 14 && cnpjValido(cnpj) && !cnpjRaizPlaceholder(cnpj) ? cnpj.toUpperCase() : null;
}

async function perfisAssociados(tx: DbExecutor, empresaSaasId: string) {
    return (await tx.query<{ id: string }>(
        `SELECT p.id::text AS id FROM public.perfil_empresas p JOIN LATERAL (${EMPRESA_SAAS_DO_PERFIL}) e ON e.candidatos = 1 WHERE e.id = $1::uuid ORDER BY p.id`,
        [empresaSaasId],
    )).rows.map((l) => l.id);
}

async function cadastroAdministrativo(tx: DbExecutor, empresaSaasId: string) {
    const instalada = (await tx.query<{ t: string | null }>("SELECT to_regclass('public.plataforma_empresas_cadastro') AS t")).rows[0]?.t;
    if (!instalada)
        return null;
    return (await tx.query<{ nome_empresarial: string | null; documento_fiscal: string | null }>(
        'SELECT nome_empresarial, documento_fiscal FROM public.plataforma_empresas_cadastro WHERE empresa_id = $1::uuid', [empresaSaasId],
    )).rows[0] ?? null;
}

/** Capacidades ATIVAS desta conta no perfil (lista branca das quatro conhecidas). */
async function capacidadesDaConta(tx: DbExecutor, perfilId: string, usuarioId: string): Promise<CapacidadePerfil[]> {
    const linhas = (await tx.query<{ capacidade: string }>(
        'SELECT capacidade FROM public.perfil_empresa_concessoes WHERE empresa_id = $1::uuid AND usuario_id = $2::uuid AND revogado_em IS NULL',
        [perfilId, usuarioId],
    )).rows.map((l) => l.capacidade);
    return CAPACIDADES_PERFIL.filter((c) => linhas.includes(c));
}

/**
 * Administradores ELEGÍVEIS do perfil: concessão PERFIL_ADMINISTRAR_CONCESSOES ativa, conta ativa e vínculo ATIVO de
 * Gestão NESTA empresa (uma concessão de quem perdeu a Gestão ou o vínculo não conta).
 */
async function administradoresElegiveis(tx: DbExecutor, perfilId: string, empresaSaasId: string) {
    return (await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM public.perfil_empresa_concessoes c
           JOIN usuarios_administrativos u ON u.id = c.usuario_id
           JOIN memberships m ON m.usuario_id = c.usuario_id AND m.empresa_id = $2::uuid
          WHERE c.empresa_id = $1::uuid AND c.revogado_em IS NULL AND c.capacidade = 'PERFIL_ADMINISTRAR_CONCESSOES'
            AND u.ativo AND m.status = 'ATIVA' AND m.papel = 'REPRESENTANTE_AUTORIZADO'`,
        [perfilId, empresaSaasId],
    )).rows[0]?.n ?? 0;
}

/**
 * Leitura sem travas, para a tela: a Gestão desta empresa pode assumir a administração de um perfil existente?
 * Não devolve nada do cadastro do perfil (nem versão, nem histórico): só o veredito e as capacidades que faltam.
 */
export async function elegibilidadeConcessaoInicial(tx: DbExecutor, tenant: TenantComprovado): Promise<ElegibilidadeConcessaoInicial> {
    const inelegivel = (motivo: MotivoInelegibilidade): ElegibilidadeConcessaoInicial => ({ elegivel: false, motivo, capacidadesFaltantes: [] });
    if (tenant.papelAtual !== 'REPRESENTANTE_AUTORIZADO')
        return inelegivel('SEM_GESTAO');
    if (!await estruturaCadastroInstalada(tx))
        return inelegivel('ESTRUTURA_AUSENTE');
    const perfis = await perfisAssociados(tx, tenant.empresaComprovada);
    if (perfis.length === 0)
        return inelegivel('SEM_PERFIL');
    if (perfis.length > 1)
        return inelegivel('AMBIGUO');
    const perfilId = perfis[0]!;
    const minhas = await capacidadesDaConta(tx, perfilId, tenant.usuarioId);
    const faltantes = CAPACIDADES_PERFIL.filter((c) => !minhas.includes(c));
    if (await administradoresElegiveis(tx, perfilId, tenant.empresaComprovada) > 0)
        return inelegivel(faltantes.length === 0 ? 'JA_ADMINISTRA' : 'ADMINISTRADOR_EXISTENTE');
    if (faltantes.length === 0)
        return inelegivel('JA_ADMINISTRA');
    return { elegivel: true, motivo: null, capacidadesFaltantes: faltantes };
}

async function concederCapacidades(tx: DbExecutor, perfilId: string, usuarioId: string, capacidades: readonly CapacidadePerfil[], motivo: string, referencia: string) {
    for (const capacidade of capacidades) {
        await tx.query(
            `INSERT INTO public.perfil_empresa_concessoes (empresa_id, usuario_id, capacidade, concedido_por, motivo, referencia_autorizacao)
             VALUES ($1::uuid, $2::uuid, $3, $2::uuid, $4, $5)`,
            [perfilId, usuarioId, capacidade, motivo, referencia],
        );
    }
    return [...capacidades];
}

export async function criarPerfilDaEmpresa(tx: DbExecutor, tenant: TenantComprovado, input: {
    autenticadoEm: string;
    agora?: number;
    requestId: string;
}, auditoria: Auditoria, opcoes: { exigirExistente?: boolean } = {}): Promise<ResultadoCriacaoPerfil> {
    exigirGestaoNoTenant(tenant, 'Somente a Gestão desta empresa cria o perfil da empresa.');
    exigirReautenticacaoPerfil({ autenticado_em: input.autenticadoEm }, input.agora);
    if (!await estruturaCadastroInstalada(tx))
        throw new ClienteServiceError('PERFIL_ESTRUTURA_AUSENTE', 'A estrutura do perfil ainda não está instalada neste ambiente.', 409);
    // Mesma trava do provisionamento legado do perfil: criações e concessões concorrentes (duplo clique, duas abas) serializam.
    await travarProvisionamentoInicial(tx);
    const empresa = (await tx.query<{ id: string; codigo: string; nome: string; status: string }>(
        'SELECT id::text AS id, codigo, nome, status FROM empresas WHERE id = $1::uuid FOR UPDATE', [tenant.empresaComprovada],
    )).rows[0];
    if (!empresa || empresa.status !== 'ATIVA')
        throw new ClienteServiceError('PERFIL_ESTRUTURA_AUSENTE', 'A empresa não está ativa.', 409);
    const referencia = `IMPLANTACAO:${empresa.id}`;
    const existentes = await perfisAssociados(tx, empresa.id);
    if (existentes.length > 1)
        throw new ClienteServiceError('PERFIL_LIMITE_V1', 'Há mais de um perfil associado a esta empresa. A plataforma precisa corrigir a associação.', 409);
    if (existentes.length === 1) {
        const perfilId = existentes[0]!;
        await travarEmpresasPerfil(tx, [perfilId]);
        // Travada a linha de cada concessão de administração: duas Gestões ao mesmo tempo não assumem as duas.
        await tx.query("SELECT 1 FROM public.perfil_empresa_concessoes WHERE empresa_id = $1::uuid AND capacidade = 'PERFIL_ADMINISTRAR_CONCESSOES' AND revogado_em IS NULL FOR UPDATE", [perfilId]);
        const minhas = await capacidadesDaConta(tx, perfilId, tenant.usuarioId);
        const faltantes = CAPACIDADES_PERFIL.filter((c) => !minhas.includes(c));
        const administradores = await administradoresElegiveis(tx, perfilId, empresa.id);
        if (administradores > 0) {
            if (faltantes.length === 0)
                return { criado: false, perfilId, unidadeId: null, capacidadesConcedidas: [], motivo: 'JA_EXISTE' };
            throw new ClienteServiceError('PERFIL_SEM_CONCESSAO', 'O perfil desta empresa já é administrado por outra conta. Peça a concessão a quem administra o perfil.', 409);
        }
        if (faltantes.length === 0)
            return { criado: false, perfilId, unidadeId: null, capacidadesConcedidas: [], motivo: 'JA_EXISTE' };
        const capacidades = await concederCapacidades(tx, perfilId, tenant.usuarioId, faltantes, MOTIVO_CONCESSAO_INICIAL, referencia);
        await auditoria({
            atorTipo: 'USUARIO', usuarioId: tenant.usuarioId, acao: 'PERFIL_CONCESSAO_INICIAL', entidadeTipo: 'PERFIL_EMPRESA', entidadeId: perfilId,
            dadosDepois: { empresaId: empresa.id, usuarioId: tenant.usuarioId, capacidades, jaPossuia: minhas, origemConcessao: 'IMPLANTACAO', resultado: 'SUCESSO' },
            justificativa: MOTIVO_CONCESSAO_INICIAL, origem: 'PERFIL_EMPRESA', requestId: input.requestId,
        }, tx);
        return { criado: false, perfilId, unidadeId: null, capacidadesConcedidas: capacidades, motivo: 'CONCESSAO_INICIAL' };
    }
    if (opcoes.exigirExistente)
        throw new ClienteServiceError('PERFIL_ESTRUTURA_AUSENTE', 'Esta empresa ainda não tem perfil; use a criação do perfil.', 409);
    const cadastro = await cadastroAdministrativo(tx, empresa.id);
    const razaoSocial = cadastro?.nome_empresarial?.trim().slice(0, 160) || null;
    const cnpj = cnpjParaPerfil(cadastro?.documento_fiscal);
    const perfilId = (await tx.query<{ id: string }>(
        `INSERT INTO public.perfil_empresas (codigo, nome_comercial, razao_social, cnpj) VALUES ($1, $2, $3, $4) RETURNING id::text AS id`,
        [empresa.codigo, empresa.nome.trim().slice(0, 160), razaoSocial, cnpj],
    )).rows[0].id;
    await travarEmpresasPerfil(tx, [perfilId]);
    const unidadeId = (await tx.query<{ id: string }>(
        `INSERT INTO public.perfil_unidades (empresa_id, codigo, nome, mesmo_endereco_sede) VALUES ($1::uuid, $2, $3, true) RETURNING id::text AS id`,
        [perfilId, codigoUnidadeInicial(empresa.codigo), empresa.nome.trim().slice(0, 160)],
    )).rows[0].id;
    const capacidades = await concederCapacidades(tx, perfilId, tenant.usuarioId, CAPACIDADES_PERFIL, MOTIVO_CRIACAO_PERFIL, referencia);
    await auditoria({
        atorTipo: 'USUARIO', usuarioId: tenant.usuarioId, acao: 'PERFIL_ESTRUTURA_CRIADA', entidadeTipo: 'PERFIL_EMPRESA', entidadeId: perfilId,
        dadosDepois: {
            empresaId: empresa.id, codigoEmpresa: empresa.codigo, unidadeId, capacidades,
            preenchidos: ['nomeComercial', ...(razaoSocial ? ['razaoSocial'] : []), ...(cnpj ? ['cnpj'] : [])], resultado: 'SUCESSO',
        },
        justificativa: MOTIVO_CRIACAO_PERFIL, origem: 'PERFIL_EMPRESA', requestId: input.requestId,
    }, tx);
    return { criado: true, perfilId, unidadeId, capacidadesConcedidas: capacidades, motivo: 'CRIADO' };
}
