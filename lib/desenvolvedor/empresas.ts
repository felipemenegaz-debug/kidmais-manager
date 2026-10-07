import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { DbExecutor } from '../db/contracts';
import type { SessaoAdmin } from '../autenticacao/service.ts';
import { travarUsuariosNaOrdem } from '../saas/provar-tenant.ts';
import { marcarAtor } from '../autenticacao/usuarios.ts';
import { nomePapelSistema } from '../autenticacao/papeis.ts';
import { erroAcesso, isAcessoServiceError, violacaoUnica } from '../acessos/erros.ts';
import { CODIGO_EMPRESA, emailObrigatorio, mascararEmail, nomeObrigatorio, normalizarDocumentoFiscal, normalizarTelefone, observacoes, sugerirCodigoEmpresa, textoOpcional } from '../acessos/validacao.ts';
import { criarConviteNaTransacao, enviarConvite, listarConvitesDaEmpresa, type ResultadoEnvioConvite } from '../acessos/convites.ts';
import { criarEnviarEmail, situacaoEmail, type EnviarEmail } from '../acessos/email.ts';
import { encerrarSessoesSemAcesso, exigirDesenvolvedorNaTransacao, exigirReautenticacaoRecente } from './autorizacao.ts';
import { auditarPainel, diferencas, type ContextoPainel } from './auditoria.ts';
import { buscarSemelhantes, painelDepsPadrao, type PainelDeps } from './interessadas.ts';
import { pendenciasImplantacao } from './implantacao.ts';
import { comercialDaEmpresa, comercialResumo } from './comercial.ts';
import { representacaoDaEmpresa } from './representacao.ts';

/**
 * Contratantes: empresas provisionadas (tabela `empresas`, ciclo no guard) + cadastro administrativo (063).
 *
 * "Em implantação" (D5) = empresa ATIVA com implantação não concluída: o responsável consegue entrar e configurar.
 * Provisionar = empresa PROVISIONAMENTO→ATIVA + cadastro + interessada CONVERTIDA + convite do responsável, numa
 * transação; o e-mail do convite sai depois do commit e o resultado real volta para a tela. Nenhum usuário é criado.
 * Suspender preserva todos os dados; o acesso cai na hora (provarTenant só aceita empresa ATIVA) e as sessões de
 * quem fica sem nenhum outro acesso são encerradas. Reativar devolve ATIVA.
 */
export type EmpresasDeps = PainelDeps & { enviarEmail: EnviarEmail; gerarToken: () => string };
export function empresasDepsPadrao(): EmpresasDeps {
    return { ...painelDepsPadrao, enviarEmail: criarEnviarEmail(), gerarToken: () => randomBytes(32).toString('base64url') };
}

export type StatusEmpresa = 'PROVISIONAMENTO' | 'ATIVA' | 'SUSPENSA' | 'DESATIVADA';
export type Implantacao = 'AGUARDANDO_PRIMEIRO_ACESSO' | 'EM_CONFIGURACAO' | 'CONCLUIDA';
export const ROTULO_IMPLANTACAO: Record<Implantacao, string> = {
    AGUARDANDO_PRIMEIRO_ACESSO: 'Aguardando primeiro acesso', EM_CONFIGURACAO: 'Em configuração', CONCLUIDA: 'Implantação concluída',
};
export type Situacao = 'EM_IMPLANTACAO' | 'ATIVA' | 'SUSPENSA' | 'DESATIVADA' | 'EM_PROVISIONAMENTO';
export const ROTULO_SITUACAO: Record<Situacao, string> = {
    EM_IMPLANTACAO: 'Em implantação', ATIVA: 'Ativa', SUSPENSA: 'Suspensa', DESATIVADA: 'Desativada', EM_PROVISIONAMENTO: 'Em provisionamento',
};
export function situacaoEmpresa(status: StatusEmpresa, implantacao: Implantacao | null): Situacao {
    if (status === 'SUSPENSA') return 'SUSPENSA';
    if (status === 'DESATIVADA') return 'DESATIVADA';
    if (status === 'PROVISIONAMENTO') return 'EM_PROVISIONAMENTO';
    return implantacao && implantacao !== 'CONCLUIDA' ? 'EM_IMPLANTACAO' : 'ATIVA';
}

type LinhaEmpresa = {
    id: string; codigo: string; nome: string; status: StatusEmpresa; criado_em: string; atualizado_em: string;
    cad_empresa: string | null; nome_empresarial: string | null; documento_fiscal: string | null; responsavel_nome: string | null; email: string | null;
    telefone: string | null; observacoes: string | null; interessada_id: string | null; implantacao: Implantacao | null; implantacao_concluida_em: string | null;
    cad_revisao: number | null; membros_ativos: number; convites_pendentes: number;
};
const COLUNAS = `e.id, e.codigo, e.nome, e.status, e.criado_em::text, e.atualizado_em::text, c.empresa_id AS cad_empresa, c.nome_empresarial, c.documento_fiscal,
  c.responsavel_nome, c.email, c.telefone, c.observacoes, c.interessada_id, c.implantacao, c.implantacao_concluida_em::text, c.revisao::int AS cad_revisao,
  (SELECT count(*)::int FROM memberships m WHERE m.empresa_id = e.id AND m.status = 'ATIVA') AS membros_ativos,
  (SELECT count(*)::int FROM convites_acesso v WHERE v.empresa_id = e.id AND v.status = 'PENDENTE' AND v.expira_em > clock_timestamp()) AS convites_pendentes`;
const FROM = 'FROM empresas e LEFT JOIN plataforma_empresas_cadastro c ON c.empresa_id = e.id';

export type EmpresaResumo = {
    id: string; codigo: string; nome: string; status: StatusEmpresa; situacao: Situacao; situacaoRotulo: string; criadoEm: string;
    implantacao: Implantacao | null; implantacaoRotulo: string | null; responsavelNome: string | null; email: string | null;
    membrosAtivos: number; convitesPendentes: number; temCadastro: boolean;
};
function resumo(l: LinhaEmpresa): EmpresaResumo {
    const situacao = situacaoEmpresa(l.status, l.implantacao);
    return {
        id: l.id, codigo: l.codigo, nome: l.nome, status: l.status, situacao, situacaoRotulo: ROTULO_SITUACAO[situacao], criadoEm: l.criado_em,
        implantacao: l.implantacao, implantacaoRotulo: l.implantacao ? ROTULO_IMPLANTACAO[l.implantacao] : null, responsavelNome: l.responsavel_nome,
        email: l.email, membrosAtivos: l.membros_ativos, convitesPendentes: l.convites_pendentes, temCadastro: Boolean(l.cad_empresa),
    };
}

const filtrosSchema = z.object({
    busca: z.string().max(120).optional().transform((v) => (v ?? '').trim()),
    situacao: z.enum(['TODAS', 'EM_IMPLANTACAO', 'ATIVA', 'SUSPENSA', 'DESATIVADA', 'AGUARDANDO_PRIMEIRO_ACESSO', 'EM_CONFIGURACAO']).optional().default('TODAS'),
    pagina: z.coerce.number().int().min(1).max(1000).optional().default(1),
}).strict();

export async function listarEmpresas(sessao: SessaoAdmin, raw: unknown, deps: PainelDeps = painelDepsPadrao) {
    const filtros = filtrosSchema.parse(raw);
    const porPagina = 25;
    return deps.withTransaction(async (tx) => {
        await exigirDesenvolvedorNaTransacao(tx, sessao);
        const termo = filtros.busca ? `%${filtros.busca.toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : null;
        const condicoes = `($1::text IS NULL OR lower(e.nome) LIKE $1 OR e.codigo LIKE $1 OR lower(coalesce(c.nome_empresarial, '')) LIKE $1
              OR coalesce(c.email, '') LIKE $1 OR lower(coalesce(c.responsavel_nome, '')) LIKE $1 OR coalesce(c.documento_fiscal, '') LIKE $1)
          AND (CASE $2::text
                WHEN 'TODAS' THEN true
                WHEN 'EM_IMPLANTACAO' THEN e.status = 'ATIVA' AND c.implantacao IN ('AGUARDANDO_PRIMEIRO_ACESSO', 'EM_CONFIGURACAO')
                WHEN 'ATIVA' THEN e.status = 'ATIVA' AND (c.implantacao IS NULL OR c.implantacao = 'CONCLUIDA')
                WHEN 'AGUARDANDO_PRIMEIRO_ACESSO' THEN e.status = 'ATIVA' AND c.implantacao = 'AGUARDANDO_PRIMEIRO_ACESSO'
                WHEN 'EM_CONFIGURACAO' THEN e.status = 'ATIVA' AND c.implantacao = 'EM_CONFIGURACAO'
                ELSE e.status = $2::text END)`;
        const params = [termo, filtros.situacao];
        const total = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n ${FROM} WHERE ${condicoes}`, params)).rows[0].n;
        const linhas = (await tx.query<LinhaEmpresa>(`SELECT ${COLUNAS} ${FROM} WHERE ${condicoes} ORDER BY e.atualizado_em DESC LIMIT ${porPagina} OFFSET $3`, [...params, (filtros.pagina - 1) * porPagina])).rows;
        // E5: plano e situação comercial por empresa (sem a 067, "sem cobrança").
        const itens = [];
        for (const l of linhas)
            itens.push({ ...resumo(l), comercial: await comercialResumo(tx, l.id) });
        return { itens, total, pagina: filtros.pagina, porPagina };
    });
}

export type MembroPainel = {
    usuarioId: string; nome: string; email: string; papel: string; nivel: string; statusVinculo: 'PENDENTE' | 'ATIVA' | 'SUSPENSA' | 'REVOGADA';
    contaAtiva: boolean; membershipId: string; vinculoDesde: string; atualizadoEm: string; outrasEmpresasAtivas: number;
};

export async function membrosDaEmpresa(tx: DbExecutor, empresaId: string): Promise<MembroPainel[]> {
    const linhas = (await tx.query<{ usuario_id: string; nome: string; email: string; papel: string; status: MembroPainel['statusVinculo']; ativo: boolean; membership_id: string; criado_em: string; atualizado_em: string; outras: number }>(
        `SELECT u.id AS usuario_id, u.nome, u.email, m.papel, m.status, u.ativo, m.id AS membership_id, m.criado_em::text, m.atualizado_em::text,
                (SELECT count(*)::int FROM memberships o JOIN empresas oe ON oe.id = o.empresa_id
                  WHERE o.usuario_id = u.id AND o.empresa_id <> m.empresa_id AND o.status = 'ATIVA' AND oe.status = 'ATIVA') AS outras
           FROM memberships m JOIN usuarios_administrativos u ON u.id = m.usuario_id
          WHERE m.empresa_id = $1::uuid ORDER BY (m.status = 'ATIVA') DESC, (m.status = 'SUSPENSA') DESC, u.nome`, [empresaId])).rows;
    return linhas.map((l) => ({
        usuarioId: l.usuario_id, nome: l.nome, email: l.email, papel: l.papel, nivel: nomePapelSistema(l.papel), statusVinculo: l.status,
        contaAtiva: l.ativo, membershipId: l.membership_id, vinculoDesde: l.criado_em, atualizadoEm: l.atualizado_em, outrasEmpresasAtivas: l.outras,
    }));
}

/** Atividade administrativa da empresa: só metadados de auditoria (ação, ator, horário, resultado). */
export async function atividadeDaEmpresa(tx: DbExecutor, empresaId: string, limite = 30) {
    return (await tx.query<{ id: string; acao: string; origem: string; criado_em: string; ator: string | null; resultado: string | null }>(
        `SELECT a.id, a.acao, a.origem, a.criado_em::text, u.nome AS ator, a.dados_depois->>'resultado' AS resultado
           FROM auditoria a LEFT JOIN usuarios_administrativos u ON u.id = a.usuario_id
          WHERE (a.entidade_tipo = 'EMPRESA' AND a.entidade_id = $1::uuid)
             OR (a.origem IN ('PAINEL_DESENVOLVEDOR', 'CONVITE_PUBLICO') AND a.dados_depois->>'empresaId' = $1::text)
             OR (a.entidade_tipo = 'MEMBERSHIP' AND a.entidade_id IN (SELECT id FROM memberships WHERE empresa_id = $1::uuid))
          ORDER BY a.criado_em DESC LIMIT $2`, [empresaId, limite])).rows;
}

function detalhe(l: LinhaEmpresa) {
    return {
        ...resumo(l), atualizadoEm: l.atualizado_em,
        cadastro: l.cad_empresa ? {
            nomeEmpresarial: l.nome_empresarial, documentoFiscal: l.documento_fiscal, responsavelNome: l.responsavel_nome, email: l.email,
            telefone: l.telefone, observacoes: l.observacoes, interessadaId: l.interessada_id, implantacao: l.implantacao,
            implantacaoConcluidaEm: l.implantacao_concluida_em, revisao: l.cad_revisao,
        } : null,
    };
}

export async function obterEmpresa(sessao: SessaoAdmin, id: string, deps: PainelDeps = painelDepsPadrao) {
    const uuid = z.string().uuid().parse(id);
    return deps.withTransaction(async (tx) => {
        await exigirDesenvolvedorNaTransacao(tx, sessao);
        const l = (await tx.query<LinhaEmpresa>(`SELECT ${COLUNAS} ${FROM} WHERE e.id = $1::uuid`, [uuid])).rows[0];
        if (!l)
            throw erroAcesso('NAO_ENCONTRADO', 'Empresa não encontrada.', 404);
        const email = situacaoEmail();
        return {
            empresa: detalhe(l),
            membros: await membrosDaEmpresa(tx, uuid),
            convites: await listarConvitesDaEmpresa(tx, uuid),
            atividade: await atividadeDaEmpresa(tx, uuid),
            // Pendências reais de implantação (D5): só para contratante ativa com cadastro administrativo.
            implantacao: l.status === 'ATIVA' && l.cad_empresa ? await pendenciasImplantacao(tx, uuid) : null,
            envioEmail: { configurado: email.configurado, motivo: email.motivo },
            comercial: await comercialDaEmpresa(tx, uuid),
            representacao: await representacaoDaEmpresa(tx, uuid),
        };
    });
}

// ---------------------------------------------------------------------------------------------------------------
// Provisionamento
// ---------------------------------------------------------------------------------------------------------------

const provisionarSchema = z.object({
    interessadaId: z.string().uuid().nullish(),
    nome: nomeObrigatorio(2, 160),
    codigo: z.string().trim().toLowerCase().max(64).optional(),
    nomeEmpresarial: textoOpcional(200),
    documentoFiscal: z.string().max(40).nullish(),
    responsavelNome: nomeObrigatorio(2, 120),
    email: emailObrigatorio,
    telefone: z.string().max(40).nullish(),
    observacoes,
    confirmar: z.boolean().optional(),
}).strict();

function dadosProvisionamento(raw: unknown) {
    const input = provisionarSchema.parse(raw);
    const codigo = input.codigo || sugerirCodigoEmpresa(input.nome);
    if (!CODIGO_EMPRESA.test(codigo))
        throw erroAcesso('DADOS_INVALIDOS', 'Código inválido: use letras minúsculas, números e hífen (4 a 64 caracteres, começando por letra).', 400, { campo: 'codigo' });
    if (`${codigo}\n${input.nome}`.toLocaleLowerCase('pt-BR').includes('kidmais'))
        throw erroAcesso('DADOS_INVALIDOS', 'O painel não provisiona a marca Kidmais.', 400, { campo: 'nome' });
    return {
        ...input, codigo,
        documentoFiscal: normalizarDocumentoFiscal(input.documentoFiscal),
        telefone: normalizarTelefone(input.telefone),
        nomeEmpresarial: input.nomeEmpresarial ?? null,
        observacoes: input.observacoes ?? null,
        interessadaId: input.interessadaId ?? null,
    };
}
type DadosProvisionamento = ReturnType<typeof dadosProvisionamento>;

async function conflitosProvisionamento(tx: DbExecutor, d: DadosProvisionamento) {
    const conflitos: string[] = [];
    if ((await tx.query('SELECT 1 FROM empresas WHERE codigo = $1', [d.codigo])).rows.length)
        conflitos.push('Já existe empresa com este código.');
    if (d.documentoFiscal && (await tx.query('SELECT 1 FROM plataforma_empresas_cadastro WHERE documento_fiscal = $1', [d.documentoFiscal])).rows.length)
        conflitos.push('Já existe contratante com este documento.');
    let interessada: { id: string; nome: string; status: string } | null = null;
    if (d.interessadaId) {
        interessada = (await tx.query<{ id: string; nome: string; status: string }>('SELECT id, nome, status FROM plataforma_interessadas WHERE id = $1 FOR UPDATE', [d.interessadaId])).rows[0] ?? null;
        if (!interessada)
            conflitos.push('Interessada não encontrada.');
        else if (interessada.status === 'CONVERTIDA')
            conflitos.push('Esta interessada já foi provisionada.');
        else if (interessada.status === 'DESCARTADA')
            conflitos.push('Interessada descartada: reabra antes de provisionar.');
    }
    else {
        const semelhantes = await buscarSemelhantes(tx, { nome: d.nome, documentoFiscal: d.documentoFiscal, email: d.email, telefone: d.telefone }, null);
        for (const s of semelhantes.bloqueantes)
            if (s.motivo !== 'DOCUMENTO_CONTRATANTE')
                conflitos.push(`Já existe interessada em aberto com o mesmo ${s.motivo === 'DOCUMENTO' ? 'documento' : 'e-mail'} (${s.nome}). Provisione a partir dela.`);
    }
    return { conflitos, interessada };
}

/** Prévia sem escrita: dados normalizados, efeitos da operação e conflitos. A tela confirma com base nela. */
export async function previaProvisionamento(sessao: SessaoAdmin, raw: unknown, deps: PainelDeps = painelDepsPadrao) {
    const d = dadosProvisionamento(raw);
    return deps.withTransaction(async (tx) => {
        await exigirDesenvolvedorNaTransacao(tx, sessao);
        const { conflitos, interessada } = await conflitosProvisionamento(tx, d);
        const contaExistente = (await tx.query('SELECT 1 FROM usuarios_administrativos WHERE email = $1', [d.email])).rows.length > 0;
        const email = situacaoEmail();
        return {
            dados: { nome: d.nome, codigo: d.codigo, nomeEmpresarial: d.nomeEmpresarial, documentoFiscal: d.documentoFiscal, responsavelNome: d.responsavelNome, email: d.email, telefone: d.telefone, observacoes: d.observacoes, interessadaId: d.interessadaId },
            interessada,
            efeitos: [
                `Cria a empresa "${d.nome}" (código ${d.codigo}) já ativa, com a implantação em "Aguardando primeiro acesso".`,
                'Grava o cadastro administrativo (responsável, contatos, documento e observações).',
                interessada ? `Marca a interessada "${interessada.nome}" como contratante.` : 'Não há interessada vinculada.',
                `Cria um convite de Gestão para ${d.email}, válido por 7 dias. Nenhum usuário é criado agora.`,
                contaExistente ? 'Este e-mail já tem conta no Kidmais Manager: no aceite, a pessoa confirma com a senha atual.' : 'Este e-mail ainda não tem conta: no aceite, a pessoa define nome e senha.',
                email.configurado ? 'O e-mail do convite é enviado logo após a confirmação.' : `O convite fica criado, mas NÃO será enviado: ${email.motivo}`,
            ],
            conflitos,
            podeConfirmar: conflitos.length === 0,
        };
    });
}

export async function provisionarContratante(sessao: SessaoAdmin, raw: unknown, ctx: ContextoPainel, deps: EmpresasDeps = empresasDepsPadrao()) {
    exigirReautenticacaoRecente(sessao);
    const d = dadosProvisionamento(raw);
    if (d.confirmar !== true)
        throw erroAcesso('DADOS_INVALIDOS', 'Confirme a operação depois de revisar os efeitos.', 400);
    let criado: { empresaId: string; conviteId: string; token: string; substituiu: string | null };
    try {
        criado = await deps.withTransaction(async (tx) => {
            await travarUsuariosNaOrdem(tx, [sessao.usuario_id]);
            await exigirDesenvolvedorNaTransacao(tx, sessao);
            await tx.query("SELECT pg_advisory_xact_lock(hashtext('kidmais:plataforma-interessadas'))");
            const { conflitos, interessada } = await conflitosProvisionamento(tx, d);
            if (conflitos.length)
                throw erroAcesso('CONFLITO', conflitos.join(' '), 409, { conflitos });
            await marcarAtor(tx, sessao.usuario_id);
            const empresaId = (await tx.query<{ id: string }>(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id::text AS id`, [d.codigo, d.nome])).rows[0].id;
            await tx.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [empresaId]);
            await tx.query(
                `INSERT INTO plataforma_empresas_cadastro (empresa_id, nome_empresarial, documento_fiscal, responsavel_nome, email, telefone, observacoes, interessada_id, criado_por, atualizado_por)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
                [empresaId, d.nomeEmpresarial, d.documentoFiscal, d.responsavelNome, d.email, d.telefone, d.observacoes, interessada?.id ?? null, sessao.usuario_id]);
            if (interessada) {
                await tx.query(`UPDATE plataforma_interessadas SET status = 'CONVERTIDA', empresa_id = $2, atualizado_por = $3 WHERE id = $1`, [interessada.id, empresaId, sessao.usuario_id]);
                await auditarPainel(deps.registrarAuditoria, tx, {
                    atorId: sessao.usuario_id, acao: 'INTERESSADA_STATUS_ALTERADO', entidadeTipo: 'PLATAFORMA_INTERESSADA', entidadeId: interessada.id, empresaId, resultado: 'SUCESSO',
                    antes: { status: interessada.status }, depois: { status: 'CONVERTIDA' }, justificativa: 'Provisionada como contratante', ctx,
                });
            }
            const convite = await criarConviteNaTransacao(tx, deps, { empresaId, email: d.email, nomeSugerido: d.responsavelNome, papel: 'REPRESENTANTE_AUTORIZADO', criadoPor: sessao.usuario_id });
            await auditarPainel(deps.registrarAuditoria, tx, {
                atorId: sessao.usuario_id, acao: 'EMPRESA_PROVISIONADA', entidadeTipo: 'EMPRESA', entidadeId: empresaId, empresaId, resultado: 'SUCESSO',
                depois: { codigo: d.codigo, nome: d.nome, status: 'ATIVA', implantacao: 'AGUARDANDO_PRIMEIRO_ACESSO', interessadaId: interessada?.id ?? null, conviteId: convite.id, documentoFiscal: d.documentoFiscal }, ctx,
            });
            await auditarPainel(deps.registrarAuditoria, tx, {
                atorId: sessao.usuario_id, acao: 'CONVITE_CRIADO', entidadeTipo: 'CONVITE_ACESSO', entidadeId: convite.id, empresaId, resultado: 'SUCESSO',
                depois: { email: d.email, papel: 'REPRESENTANTE_AUTORIZADO', responsavelInicial: true }, ctx,
            });
            return { empresaId, conviteId: convite.id, token: convite.token, substituiu: convite.substituiu };
        });
    }
    catch (error) {
        if (violacaoUnica(error))
            throw erroAcesso('CONFLITO', 'Código, documento ou interessada já usados por outro cadastro. Revise e tente de novo.', 409);
        throw error;
    }
    const envio = await enviarConvite(deps, { conviteId: criado.conviteId, email: d.email, empresaNome: d.nome, papel: 'REPRESENTANTE_AUTORIZADO', token: criado.token });
    await registrarEnvio(deps, sessao, ctx, criado.empresaId, criado.conviteId, envio);
    return { empresaId: criado.empresaId, codigo: d.codigo, conviteId: criado.conviteId, envio };
}

/** Registra o resultado real do envio (fora da transação principal, que já foi confirmada). */
export async function registrarEnvio(deps: PainelDeps, sessao: SessaoAdmin, ctx: ContextoPainel, empresaId: string, conviteId: string, envio: ResultadoEnvioConvite) {
    await auditarPainel(deps.registrarAuditoria, undefined, {
        atorId: sessao.usuario_id, acao: envio.enviado ? 'CONVITE_ENVIADO' : 'CONVITE_ENVIO_FALHOU', entidadeTipo: 'CONVITE_ACESSO', entidadeId: conviteId, empresaId,
        resultado: envio.enviado ? 'SUCESSO' : 'FALHA', depois: { destino: envio.destino, motivo: envio.enviado ? null : envio.motivo }, ctx,
    });
}

// ---------------------------------------------------------------------------------------------------------------
// Cadastro, implantação, suspensão e reativação
// ---------------------------------------------------------------------------------------------------------------

const cadastroSchema = z.object({
    nome: nomeObrigatorio(2, 160),
    nomeEmpresarial: textoOpcional(200),
    documentoFiscal: z.string().max(40).nullish(),
    responsavelNome: nomeObrigatorio(2, 160),
    email: emailObrigatorio,
    telefone: z.string().max(40).nullish(),
    observacoes,
    revisao: z.number().int().positive().nullable(),
}).strict();

async function empresaTravada(tx: DbExecutor, empresaId: string) {
    const l = (await tx.query<LinhaEmpresa>(`SELECT ${COLUNAS} ${FROM} WHERE e.id = $1::uuid FOR UPDATE OF e`, [empresaId])).rows[0];
    if (!l)
        throw erroAcesso('NAO_ENCONTRADO', 'Empresa não encontrada.', 404);
    return l;
}

export async function atualizarCadastroEmpresa(sessao: SessaoAdmin, id: string, raw: unknown, ctx: ContextoPainel, deps: PainelDeps = painelDepsPadrao) {
    const empresaId = z.string().uuid().parse(id);
    const input = cadastroSchema.parse(raw);
    const dados = {
        nome: input.nome, nomeEmpresarial: input.nomeEmpresarial ?? null, documentoFiscal: normalizarDocumentoFiscal(input.documentoFiscal),
        responsavelNome: input.responsavelNome, email: input.email, telefone: normalizarTelefone(input.telefone), observacoes: input.observacoes ?? null,
    };
    try {
        return await deps.withTransaction(async (tx) => {
            await exigirDesenvolvedorNaTransacao(tx, sessao);
            const atual = await empresaTravada(tx, empresaId);
            if ((atual.cad_revisao ?? null) !== input.revisao)
                throw erroAcesso('REVISAO_DESATUALIZADA', 'O cadastro foi alterado por outra pessoa. Recarregue antes de salvar.', 409);
            const antes = { nome: atual.nome, nomeEmpresarial: atual.nome_empresarial, documentoFiscal: atual.documento_fiscal, responsavelNome: atual.responsavel_nome, email: atual.email, telefone: atual.telefone, observacoes: atual.observacoes };
            const mudanca = diferencas(antes, dados, ['nome', 'nomeEmpresarial', 'documentoFiscal', 'responsavelNome', 'email', 'telefone', 'observacoes']);
            if (!mudanca.alterados.length)
                return { alterados: [] as string[] };
            if (dados.nome !== atual.nome) {
                await marcarAtor(tx, sessao.usuario_id);
                await tx.query('UPDATE empresas SET nome = $2 WHERE id = $1', [empresaId, dados.nome]);
            }
            if (atual.cad_empresa) {
                await tx.query(
                    `UPDATE plataforma_empresas_cadastro SET nome_empresarial = $2, documento_fiscal = $3, responsavel_nome = $4, email = $5, telefone = $6, observacoes = $7, atualizado_por = $8 WHERE empresa_id = $1`,
                    [empresaId, dados.nomeEmpresarial, dados.documentoFiscal, dados.responsavelNome, dados.email, dados.telefone, dados.observacoes, sessao.usuario_id]);
            }
            else {
                // Empresa anterior ao painel (ex.: legado): o cadastro nasce agora, com a implantação já concluída.
                await tx.query(
                    `INSERT INTO plataforma_empresas_cadastro (empresa_id, nome_empresarial, documento_fiscal, responsavel_nome, email, telefone, observacoes, implantacao, implantacao_concluida_em, criado_por, atualizado_por)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, 'CONCLUIDA', clock_timestamp(), $8, $8)`,
                    [empresaId, dados.nomeEmpresarial, dados.documentoFiscal, dados.responsavelNome, dados.email, dados.telefone, dados.observacoes, sessao.usuario_id]);
            }
            await auditarPainel(deps.registrarAuditoria, tx, {
                atorId: sessao.usuario_id, acao: atual.cad_empresa ? 'EMPRESA_CADASTRO_ATUALIZADO' : 'EMPRESA_CADASTRO_CRIADO', entidadeTipo: 'EMPRESA', entidadeId: empresaId, empresaId,
                resultado: 'SUCESSO', antes: mudanca.antes, depois: { ...mudanca.depois, alterados: mudanca.alterados }, ctx,
            });
            return { alterados: mudanca.alterados };
        });
    }
    catch (error) {
        if (violacaoUnica(error, 'kidmais_063_cad_documento_uk'))
            throw erroAcesso('DUPLICIDADE', 'Já existe outra contratante com este documento.', 409);
        throw error;
    }
}

const implantacaoSchema = z.object({ implantacao: z.enum(['AGUARDANDO_PRIMEIRO_ACESSO', 'EM_CONFIGURACAO', 'CONCLUIDA']), revisao: z.number().int().positive() }).strict();

export async function alterarImplantacao(sessao: SessaoAdmin, id: string, raw: unknown, ctx: ContextoPainel, deps: PainelDeps = painelDepsPadrao) {
    const empresaId = z.string().uuid().parse(id);
    const input = implantacaoSchema.parse(raw);
    try {
        return await alterarImplantacaoNaTransacao(sessao, empresaId, input, ctx, deps);
    }
    catch (error) {
        // A recusa por pendências é auditada FORA da transação recusada (que foi desfeita), como as recusas de acesso.
        if (isAcessoServiceError(error) && error.code === 'IMPLANTACAO_PENDENTE') {
            const detalhes = error.details as { pendencias?: Array<{ codigo: string }>; implantacaoAtual?: string | null } | undefined;
            await auditarPainel(deps.registrarAuditoria, undefined, {
                atorId: sessao.usuario_id, acao: 'EMPRESA_IMPLANTACAO_RECUSADA', entidadeTipo: 'EMPRESA', entidadeId: empresaId, empresaId, resultado: 'RECUSADO',
                antes: { implantacao: detalhes?.implantacaoAtual ?? null }, depois: { implantacao: input.implantacao, pendencias: (detalhes?.pendencias ?? []).map((p) => p.codigo) }, ctx,
            }).catch(() => undefined);
        }
        throw error;
    }
}

async function alterarImplantacaoNaTransacao(sessao: SessaoAdmin, empresaId: string, input: z.infer<typeof implantacaoSchema>, ctx: ContextoPainel, deps: PainelDeps) {
    return deps.withTransaction(async (tx) => {
        await exigirDesenvolvedorNaTransacao(tx, sessao);
        const atual = await empresaTravada(tx, empresaId);
        if (!atual.cad_empresa)
            throw erroAcesso('CONFLITO', 'Complete o cadastro administrativo da empresa antes.', 409);
        if (atual.cad_revisao !== input.revisao)
            throw erroAcesso('REVISAO_DESATUALIZADA', 'O cadastro foi alterado por outra pessoa. Recarregue antes de salvar.', 409);
        if (atual.implantacao === input.implantacao)
            return { implantacao: input.implantacao, alterado: false };
        // CONCLUÍDA só com os requisitos reais atendidos (Gestão ativa, perfil criado e cadastro aplicado).
        let pendencias: Awaited<ReturnType<typeof pendenciasImplantacao>> | null = null;
        if (input.implantacao === 'CONCLUIDA') {
            pendencias = await pendenciasImplantacao(tx, empresaId);
            if (!pendencias.podeConcluir) {
                const pendentes = pendencias.itens.filter((i) => i.obrigatoria && !i.atendida).map(({ codigo, titulo, detalhe }) => ({ codigo, titulo, detalhe }));
                throw erroAcesso('IMPLANTACAO_PENDENTE', `Há pendência(s) obrigatória(s) antes de concluir a implantação: ${pendentes.map((p) => p.titulo).join('; ')}.`, 409, { pendencias: pendentes, implantacaoAtual: atual.implantacao });
            }
        }
        await tx.query(
            `UPDATE plataforma_empresas_cadastro SET implantacao = $2, implantacao_concluida_em = CASE WHEN $2 = 'CONCLUIDA' THEN clock_timestamp() ELSE NULL END, atualizado_por = $3 WHERE empresa_id = $1`,
            [empresaId, input.implantacao, sessao.usuario_id]);
        await auditarPainel(deps.registrarAuditoria, tx, {
            atorId: sessao.usuario_id, acao: 'EMPRESA_IMPLANTACAO_ALTERADA', entidadeTipo: 'EMPRESA', entidadeId: empresaId, empresaId, resultado: 'SUCESSO',
            antes: { implantacao: atual.implantacao }, depois: { implantacao: input.implantacao, requisitosConferidos: pendencias ? pendencias.itens.filter((i) => i.obrigatoria).map((i) => i.codigo) : null }, ctx,
        });
        return { implantacao: input.implantacao, alterado: true };
    });
}

const situacaoSchema = z.object({ motivo: z.string().trim().min(3, 'Informe o motivo.').max(500), confirmacaoCodigo: z.string().trim().toLowerCase() }).strict();

/** Suspender (ATIVA→SUSPENSA) ou reativar (SUSPENSA→ATIVA). Exige reautenticação, motivo e o código digitado. */
export async function alterarSituacaoEmpresa(sessao: SessaoAdmin, id: string, acao: 'suspender' | 'reativar', raw: unknown, ctx: ContextoPainel, deps: PainelDeps = painelDepsPadrao) {
    exigirReautenticacaoRecente(sessao);
    const empresaId = z.string().uuid().parse(id);
    const input = situacaoSchema.parse(raw);
    return deps.withTransaction(async (tx) => {
        // Ordem de locks dos fluxos de tenant: usuários → empresa → memberships.
        const usuarios = (await tx.query<{ usuario_id: string }>('SELECT usuario_id FROM memberships WHERE empresa_id = $1::uuid', [empresaId])).rows.map((r) => r.usuario_id);
        await travarUsuariosNaOrdem(tx, [...usuarios, sessao.usuario_id]);
        await exigirDesenvolvedorNaTransacao(tx, sessao);
        const atual = await empresaTravada(tx, empresaId);
        if (input.confirmacaoCodigo !== atual.codigo)
            throw erroAcesso('DADOS_INVALIDOS', 'O código digitado não confere com o da empresa.', 400, { campo: 'confirmacaoCodigo' });
        const de = atual.status, para = acao === 'suspender' ? 'SUSPENSA' : 'ATIVA';
        if ((acao === 'suspender' && de !== 'ATIVA') || (acao === 'reativar' && de !== 'SUSPENSA'))
            throw erroAcesso('CONFLITO', acao === 'suspender' ? 'Só uma empresa ativa pode ser suspensa.' : 'Só uma empresa suspensa pode ser reativada.', 409);
        await marcarAtor(tx, sessao.usuario_id);
        await tx.query('UPDATE empresas SET status = $2 WHERE id = $1', [empresaId, para]);
        const sessoes = acao === 'suspender' ? await encerrarSessoesSemAcesso(tx, usuarios) : { usuarios: 0, sessoes: 0 };
        await auditarPainel(deps.registrarAuditoria, tx, {
            atorId: sessao.usuario_id, acao: acao === 'suspender' ? 'EMPRESA_SUSPENSA' : 'EMPRESA_REATIVADA', entidadeTipo: 'EMPRESA', entidadeId: empresaId, empresaId, resultado: 'SUCESSO',
            antes: { status: de }, depois: { status: para, usuariosComSessaoEncerrada: sessoes.usuarios, sessoesEncerradas: sessoes.sessoes }, justificativa: input.motivo, ctx,
        });
        return { status: para, sessoesEncerradas: sessoes.sessoes, usuariosDesconectados: sessoes.usuarios };
    });
}

export { mascararEmail };
