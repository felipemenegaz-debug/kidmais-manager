import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { DbExecutor } from '../db/contracts';
import { withTransaction as withTransactionPadrao } from '../db/postgres';
import { registrarAuditoria as registrarAuditoriaPadrao } from '../clientes/repositories/auditoria.repository';
import { consumirLimite, criarSessaoAdministrativa, prazoDoLimite, type SessaoAdmin } from '../autenticacao/service.ts';
import { criarHashSenha as criarHashSenhaPadrao, hashToken } from '../autenticacao/senha.ts';
import { concederPerfilFesta, criacaoDiretaDisponivel, inserirIdentidadeNeutra, marcarAtor } from '../autenticacao/usuarios.ts';
import { travarUsuariosNaOrdem } from '../saas/provar-tenant.ts';
import { erroAcesso, violacaoUnica } from '../acessos/erros.ts';
import { criarEnviarEmail, origemPublica, situacaoEmail, type EnviarEmail, type MensagemEmail } from '../acessos/email.ts';
import { validarNovaSenha, type ContextoRequisicao } from '../acessos/senha-propria.ts';
import { emailObrigatorio, mascararDocumento, nomeObrigatorio, normalizarTelefone, sugerirCodigoEmpresa } from '../acessos/validacao.ts';
import { exigirReautenticacaoRecente } from '../desenvolvedor/autorizacao.ts';
import { iniciarTeste } from '../assinatura/servico.ts';
import { cnpjRaizPlaceholder, cnpjValido, normalizarCnpj } from './cnpj.ts';
import { versaoVigente, type DocumentoLegal } from './documentos-legais.ts';

/**
 * Cadastro público (E6), em três passos:
 *   1. Pedido: nome, e-mail, senha e aceite da versão vigente dos termos e da privacidade. A resposta é SEMPRE a mesma
 *      e sai antes do processamento (rota com `after`), então nem o conteúdo nem o tempo revelam se o e-mail tem conta.
 *      E-mail sem conta recebe o link de confirmação (uso único, 24 h, token só em hash, no fragmento #t=); e-mail com
 *      conta recebe um aviso para entrar. Nenhuma conta nasce aqui.
 *   2. Confirmação: abrir o link cria a identidade com papel global NEUTRO, registra os aceites e abre a sessão.
 *   3. Empresa (sessão autenticada, inclusive de quem já tem conta e quer outro CNPJ): CNPJ (dígitos), razão social, nome
 *      fantasia, qualificação de quem cadastra e sócios declarados. Numa transação idempotente cria empresa ATIVA,
 *      cadastro administrativo, vínculo de Gestão SÓ para esta pessoa, teste grátis do CNPJ, representação DECLARADA
 *      e os aceites. CNPJ já cadastrado vira pedido de acesso, sem revelar nada da empresa existente e sem vínculo.
 *
 * Dígitos do CNPJ corretos não comprovam existência da empresa nem autoridade de quem cadastra: a representação fica
 * DECLARADA até decisão da plataforma. Nenhum fluxo daqui concede papel global, autoridade de plataforma ou concessão
 * de desenvolvedor. O cadastro só liga com e-mail configurado, CADASTRO_PUBLICO_ATIVO=true e criação direta de usuários
 * desligada (USUARIOS_CRIACAO_DIRETA=desativada) — pré-requisitos do E1.
 */
export const VALIDADE_CADASTRO_HORAS = 24;
const REGRA_ORIGEM = { namespace: 'cadastro', janelaSegundos: 3600, limite: 10 } as const;
const REGRA_EMAIL = { namespace: 'cadastro-email', janelaSegundos: 3600, limite: 3 } as const;
const REGRA_CONFIRMAR = { namespace: 'cadastro-confirmar', janelaSegundos: 900, limite: 30 } as const;
const REGRA_EMPRESA = { namespace: 'cadastro-empresa', janelaSegundos: 86_400, limite: 5 } as const;

export const MENSAGEM_PEDIDO_CADASTRO = `Se for possível criar a conta com este e-mail, enviamos um link de confirmação. Ele vale por ${VALIDADE_CADASTRO_HORAS} horas. Confira também a caixa de spam.`;
export const MENSAGEM_CNPJ_EXISTENTE = 'Este CNPJ já está cadastrado no Kidmais Manager. Registramos seu pedido de acesso; a empresa e a Kidmais avaliam e você recebe um convite se for aprovado. Nenhum dado da empresa é exibido aqui.';

export type CadastroDeps = {
    withTransaction: typeof withTransactionPadrao;
    registrarAuditoria: typeof registrarAuditoriaPadrao;
    criarHashSenha: typeof criarHashSenhaPadrao;
    enviarEmail: EnviarEmail;
    gerarToken: () => string;
};
export function cadastroDepsPadrao(): CadastroDeps {
    return { withTransaction: withTransactionPadrao, registrarAuditoria: registrarAuditoriaPadrao, criarHashSenha: criarHashSenhaPadrao, enviarEmail: criarEnviarEmail(), gerarToken: () => randomBytes(32).toString('base64url') };
}

type Ambiente = Record<string, string | undefined>;
export function situacaoCadastro(env: Ambiente = process.env): { ativo: boolean; motivo: string | null } {
    if (env.CADASTRO_PUBLICO_ATIVO?.trim().toLowerCase() !== 'true')
        return { ativo: false, motivo: 'O cadastro público não está aberto neste ambiente.' };
    if (criacaoDiretaDisponivel(env))
        return { ativo: false, motivo: 'O cadastro público exige a criação direta de usuários desligada.' };
    const email = situacaoEmail({ EMAIL_PROVIDER: env.EMAIL_PROVIDER, EMAIL_ARQUIVO_DIR: env.EMAIL_ARQUIVO_DIR, EMAIL_REMETENTE: env.EMAIL_REMETENTE, RESEND_API_KEY: env.RESEND_API_KEY, NODE_ENV: env.NODE_ENV, RENDER: env.RENDER, KIDMAIS_DEPLOY_ENV: env.KIDMAIS_DEPLOY_ENV });
    if (!email.configurado)
        return { ativo: false, motivo: 'O cadastro público exige o envio de e-mail configurado.' };
    return { ativo: true, motivo: null };
}
export function exigirCadastroAtivo(env: Ambiente = process.env) {
    const s = situacaoCadastro(env);
    if (!s.ativo)
        throw erroAcesso('CADASTRO_INDISPONIVEL', 'O cadastro de novas empresas não está disponível no momento.', 503);
}

const aceiteSchema = { aceiteTermos: z.literal(true), aceitePrivacidade: z.literal(true), termosVersao: z.string().max(40), privacidadeVersao: z.string().max(40) };
function exigirVersoesVigentes(termosVersao: string, privacidadeVersao: string) {
    if (termosVersao !== versaoVigente('TERMOS_USO').versao || privacidadeVersao !== versaoVigente('PRIVACIDADE').versao)
        throw erroAcesso('DADOS_INVALIDOS', 'Os termos ou o aviso de privacidade foram atualizados. Recarregue a página e leia a versão atual.', 409);
}
async function registrarAceites(tx: DbExecutor, usuarioId: string, empresaId: string | null, origem: 'CADASTRO' | 'NOVA_EMPRESA', ctx: ContextoRequisicao, versoes?: Record<DocumentoLegal, { versao: string; hash: string }>) {
    for (const documento of ['TERMOS_USO', 'PRIVACIDADE'] as const) {
        const v = versoes?.[documento] ?? versaoVigente(documento);
        await tx.query(`INSERT INTO aceites_documentos_legais (usuario_id, empresa_id, documento, versao, hash_conteudo, origem, ip, user_agent)
                        VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::inet, $8)`, [usuarioId, empresaId, documento, v.versao, v.hash, origem, ctx.ip, ctx.userAgent?.slice(0, 1000) ?? null]);
    }
}

// ---------------------------------------------------------------------------------------------------------------
// 1. Pedido de conta
// ---------------------------------------------------------------------------------------------------------------

const pedidoSchema = z.object({ nome: nomeObrigatorio(2, 120), email: emailObrigatorio, senha: z.string().max(512), confirmacao: z.string().max(512), ...aceiteSchema }).strict();
export type PedidoCadastro = z.infer<typeof pedidoSchema>;

/** Validação barata, ANTES de responder: formato, senha e versões aceitas. Nada de banco aqui. */
export function validarPedidoCadastro(raw: unknown): PedidoCadastro {
    const parsed = pedidoSchema.safeParse(raw);
    if (!parsed.success)
        throw erroAcesso('DADOS_INVALIDOS', 'Confira nome, e-mail, senha e o aceite dos termos e da privacidade.', 400);
    validarNovaSenha(parsed.data.senha, parsed.data.confirmacao);
    exigirVersoesVigentes(parsed.data.termosVersao, parsed.data.privacidadeVersao);
    return parsed.data;
}

export function linkConfirmacao(token: string, origem = origemPublica()) {
    return `${origem}/cadastro/confirmar#t=${token}`;
}
function escapar(t: string) {
    return t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
export function mensagemConfirmacao(para: string, link: string): MensagemEmail {
    const p = ['Recebemos um pedido para criar uma conta no Kidmais Manager com este e-mail.', `Confirme em até ${VALIDADE_CADASTRO_HORAS} horas. O link só pode ser usado uma vez.`];
    return {
        para, assunto: 'Confirme seu e-mail no Kidmais Manager',
        texto: `${p.join('\n\n')}\n\n${link}\n\nSe você não pediu, ignore esta mensagem: nenhuma conta é criada sem a confirmação.`,
        html: `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#111">${p.map((x) => `<p>${escapar(x)}</p>`).join('')}<p><a href="${escapar(link)}" style="display:inline-block;padding:12px 20px;border-radius:10px;background:#7C3AED;color:#fff;text-decoration:none">Confirmar e-mail</a></p><p style="color:#555;font-size:13px">Se você não pediu, ignore esta mensagem: nenhuma conta é criada sem a confirmação.</p></div>`,
    };
}
export function mensagemContaExistente(para: string, origem = origemPublica()): MensagemEmail {
    const p = ['Recebemos um pedido para criar uma conta no Kidmais Manager com este e-mail, mas ele já tem uma conta.', 'Entre com a sua senha. Para cadastrar outra empresa, use "Cadastrar empresa" depois de entrar. Se esqueceu a senha, use "Esqueci minha senha" na tela de entrada.'];
    const link = `${origem}/admin/login`;
    return {
        para, assunto: 'Você já tem conta no Kidmais Manager',
        texto: `${p.join('\n\n')}\n\n${link}\n\nSe não foi você, ignore esta mensagem.`,
        html: `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#111">${p.map((x) => `<p>${escapar(x)}</p>`).join('')}<p><a href="${escapar(link)}">Entrar no Kidmais Manager</a></p><p style="color:#555;font-size:13px">Se não foi você, ignore esta mensagem.</p></div>`,
    };
}

/**
 * Processamento do pedido (fora da resposta). Limites por origem e por e-mail antes de qualquer scrypt. Falha de envio
 * invalida o pedido (o link nunca chega a valer) e fica auditada sem o e-mail.
 */
export async function processarPedidoCadastro(input: PedidoCadastro, ctx: ContextoRequisicao, deps: CadastroDeps = cadastroDepsPadrao()) {
    const r = await deps.withTransaction(async (tx) => {
        if (!await consumirLimite(tx, 'ORIGEM', ctx.ip ?? 'ORIGEM_NAO_VERIFICADA', REGRA_ORIGEM) || !await consumirLimite(tx, 'IDENTIFICADOR', input.email, REGRA_EMAIL))
            return { tipo: 'limite' as const };
        const conta = (await tx.query<{ id: string }>('SELECT id FROM usuarios_administrativos WHERE lower(btrim(email)) = $1', [input.email])).rows[0];
        if (conta) {
            await deps.registrarAuditoria({ atorTipo: 'SISTEMA', acao: 'CADASTRO_CONTA_EXISTENTE', entidadeTipo: 'USUARIO_ADMINISTRATIVO', entidadeId: conta.id,
                dadosDepois: { resultado: 'SUCESSO' }, origem: 'CADASTRO_PUBLICO', requestId: ctx.requestId, ip: ctx.ip, userAgent: ctx.userAgent }, tx);
            return { tipo: 'conta' as const };
        }
        const token = deps.gerarToken();
        const termos = versaoVigente('TERMOS_USO'), privacidade = versaoVigente('PRIVACIDADE');
        await tx.query("UPDATE cadastros_publicos SET situacao = 'SUBSTITUIDO', senha_hash = NULL WHERE email = $1 AND situacao = 'PENDENTE'", [input.email]);
        const id = (await tx.query<{ id: string }>(
            `INSERT INTO cadastros_publicos (email, nome, senha_hash, token_hash, expira_em, termos_versao, termos_hash, privacidade_versao, privacidade_hash)
             VALUES ($1, $2, $3, $4, clock_timestamp() + make_interval(hours => $5::int), $6, $7, $8, $9) RETURNING id`,
            [input.email, input.nome, await deps.criarHashSenha(input.senha), hashToken(token), VALIDADE_CADASTRO_HORAS, termos.versao, termos.hash, privacidade.versao, privacidade.hash])).rows[0].id;
        await deps.registrarAuditoria({ atorTipo: 'SISTEMA', acao: 'CADASTRO_SOLICITADO', entidadeTipo: 'CADASTRO_PUBLICO', entidadeId: id,
            dadosDepois: { termos: termos.versao, privacidade: privacidade.versao, resultado: 'SUCESSO' }, origem: 'CADASTRO_PUBLICO', requestId: ctx.requestId, ip: ctx.ip, userAgent: ctx.userAgent }, tx);
        return { tipo: 'novo' as const, id, token };
    });
    if (r.tipo === 'limite')
        return { enviado: false as const, motivo: 'LIMITE' };
    try {
        await deps.enviarEmail(r.tipo === 'conta' ? mensagemContaExistente(input.email) : mensagemConfirmacao(input.email, linkConfirmacao(r.token)));
    }
    catch {
        if (r.tipo === 'novo')
            await deps.withTransaction(async (tx) => {
                await tx.query("UPDATE cadastros_publicos SET situacao = 'SUBSTITUIDO', senha_hash = NULL WHERE id = $1 AND situacao = 'PENDENTE'", [r.id]);
                await deps.registrarAuditoria({ atorTipo: 'SISTEMA', acao: 'CADASTRO_ENVIO_FALHOU', entidadeTipo: 'CADASTRO_PUBLICO', entidadeId: r.id,
                    dadosDepois: { resultado: 'FALHA' }, origem: 'CADASTRO_PUBLICO', requestId: ctx.requestId, ip: ctx.ip, userAgent: ctx.userAgent }, tx);
            });
        return { enviado: false as const, motivo: 'ENVIO' };
    }
    if (r.tipo === 'novo')
        await deps.withTransaction((tx) => tx.query("UPDATE cadastros_publicos SET envios = envios + 1, ultimo_envio_em = clock_timestamp() WHERE id = $1 AND situacao = 'PENDENTE'", [r.id]));
    return { enviado: true as const, tipo: r.tipo };
}

// ---------------------------------------------------------------------------------------------------------------
// 2. Confirmação do e-mail
// ---------------------------------------------------------------------------------------------------------------

const confirmarSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();

export async function confirmarCadastro(raw: unknown, ctx: ContextoRequisicao, deps: CadastroDeps = cadastroDepsPadrao()) {
    const parsed = confirmarSchema.safeParse(raw);
    const r = await deps.withTransaction(async (tx) => {
        if (!await consumirLimite(tx, 'ORIGEM', ctx.ip ?? 'ORIGEM_NAO_VERIFICADA', REGRA_CONFIRMAR))
            return { tipo: 'limite' as const, aguardar: await prazoDoLimite(tx, 'ORIGEM', ctx.ip ?? 'ORIGEM_NAO_VERIFICADA', REGRA_CONFIRMAR.namespace) };
        if (!parsed.success)
            return { tipo: 'link' as const };
        const p = (await tx.query<{ id: string; email: string; nome: string; senha_hash: string | null; situacao: string; expirado: boolean; termos_versao: string; termos_hash: string; privacidade_versao: string; privacidade_hash: string }>(
            `SELECT id, email, nome, senha_hash, situacao, expira_em <= clock_timestamp() AS expirado, termos_versao, termos_hash, privacidade_versao, privacidade_hash
               FROM cadastros_publicos WHERE token_hash = $1 FOR UPDATE`, [hashToken(parsed.data.token)])).rows[0];
        if (!p || p.situacao !== 'PENDENTE' || p.expirado || !p.senha_hash)
            return { tipo: 'link' as const };
        await tx.query("SELECT pg_advisory_xact_lock(hashtext('kidmais:cadastro-email:' || $1))", [p.email]);
        if ((await tx.query('SELECT 1 FROM usuarios_administrativos WHERE lower(btrim(email)) = $1', [p.email])).rows.length) {
            await tx.query("UPDATE cadastros_publicos SET situacao = 'SUBSTITUIDO', senha_hash = NULL WHERE id = $1", [p.id]);
            return { tipo: 'conta' as const };
        }
        const usuarioId = await inserirIdentidadeNeutra(tx, p.email, { nome: p.nome }, p.senha_hash);
        await marcarAtor(tx, usuarioId);
        await registrarAceites(tx, usuarioId, null, 'CADASTRO', ctx, {
            TERMOS_USO: { versao: p.termos_versao, hash: p.termos_hash }, PRIVACIDADE: { versao: p.privacidade_versao, hash: p.privacidade_hash },
        });
        await tx.query("UPDATE cadastros_publicos SET situacao = 'CONFIRMADO', usuario_id = $2, confirmado_em = clock_timestamp(), senha_hash = NULL WHERE id = $1", [p.id, usuarioId]);
        await deps.registrarAuditoria({ atorTipo: 'USUARIO', usuarioId, acao: 'CADASTRO_CONFIRMADO', entidadeTipo: 'USUARIO_ADMINISTRATIVO', entidadeId: usuarioId,
            dadosDepois: { cadastroId: p.id, papelGlobal: 'ADMINISTRATIVO', resultado: 'SUCESSO' }, origem: 'CADASTRO_PUBLICO', requestId: ctx.requestId, ip: ctx.ip, userAgent: ctx.userAgent }, tx);
        const sessao = await criarSessaoAdministrativa(tx, usuarioId, ctx.ip, ctx.userAgent?.slice(0, 1000) ?? null);
        return { tipo: 'ok' as const, usuarioId, sessao };
    });
    switch (r.tipo) {
        case 'ok': return { usuarioId: r.usuarioId, sessao: r.sessao };
        case 'limite': throw erroAcesso('LIMITE_TENTATIVAS', 'Muitas tentativas. Aguarde alguns minutos.', 429, r.aguardar ? { retryAfterSegundos: r.aguardar } : undefined);
        case 'conta': throw erroAcesso('CONFLITO', 'Já existe uma conta com este e-mail. Entre com a sua senha.', 409);
        default: throw erroAcesso('LINK_INVALIDO', 'Este link é inválido, já foi usado ou expirou. Faça o cadastro novamente.', 410);
    }
}

// ---------------------------------------------------------------------------------------------------------------
// 3. Empresa
// ---------------------------------------------------------------------------------------------------------------

const QUALIFICACOES_REPRESENTACAO = ['SOCIO_ADMINISTRADOR', 'PROCURADOR', 'RESPONSAVEL_INDICADO'] as const;
const empresaSchema = z.object({
    chave: z.string().uuid(),
    cnpj: z.string().max(40),
    razaoSocial: nomeObrigatorio(2, 200),
    nomeFantasia: nomeObrigatorio(2, 160),
    telefone: z.string().max(40).nullish(),
    qualificacao: z.enum(QUALIFICACOES_REPRESENTACAO),
    socios: z.array(z.object({ nome: nomeObrigatorio(2, 160), qualificacao: z.enum(['SOCIO', 'ADMINISTRADOR', 'SOCIO_ADMINISTRADOR']) }).strict()).max(10).default([]),
    ...aceiteSchema,
}).strict();

export type ResultadoEmpresa = { situacao: 'CRIADA'; empresaId: string; testeFim: string; repetido: boolean } | { situacao: 'CNPJ_EXISTENTE' };

export async function cadastrarEmpresa(sessao: SessaoAdmin, raw: unknown, ctx: ContextoRequisicao, deps: CadastroDeps = cadastroDepsPadrao(), env: Ambiente = process.env): Promise<ResultadoEmpresa> {
    exigirCadastroAtivo(env);
    exigirReautenticacaoRecente(sessao);
    const parsed = empresaSchema.safeParse(raw);
    if (!parsed.success)
        throw erroAcesso('DADOS_INVALIDOS', 'Confira CNPJ, razão social, nome fantasia, sua qualificação e o aceite dos termos.', 400);
    const d = parsed.data;
    exigirVersoesVigentes(d.termosVersao, d.privacidadeVersao);
    const documento = normalizarCnpj(d.cnpj);
    if (!cnpjValido(documento) || cnpjRaizPlaceholder(documento))
        throw erroAcesso('DADOS_INVALIDOS', 'CNPJ inválido. Confira os números.', 400, { campo: 'cnpj' });
    let telefone: string | null;
    try {
        telefone = normalizarTelefone(d.telefone ?? null);
    }
    catch {
        throw erroAcesso('DADOS_INVALIDOS', 'Telefone inválido.', 400, { campo: 'telefone' });
    }
    try {
        return await deps.withTransaction(async (tx) => {
            await travarUsuariosNaOrdem(tx, [sessao.usuario_id]);
            const usuario = (await tx.query<{ nome: string; email: string; ativo: boolean }>('SELECT nome, email, ativo FROM usuarios_administrativos WHERE id = $1::uuid', [sessao.usuario_id])).rows[0];
            if (!usuario?.ativo)
                throw erroAcesso('NAO_ENCONTRADO', 'Conta indisponível.', 404);
            const repetido = (await tx.query<{ empresa_id: string; teste_fim: string }>(
                `SELECT c.empresa_id::text, to_char(a.teste_fim AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS teste_fim
                   FROM cadastros_empresas c LEFT JOIN empresa_assinaturas a ON a.empresa_id = c.empresa_id WHERE c.usuario_id = $1::uuid AND c.chave = $2::uuid`, [sessao.usuario_id, d.chave])).rows[0];
            if (repetido)
                return { situacao: 'CRIADA' as const, empresaId: repetido.empresa_id, testeFim: repetido.teste_fim, repetido: true };
            if (!await consumirLimite(tx, 'IDENTIFICADOR', sessao.usuario_id, REGRA_EMPRESA))
                throw erroAcesso('LIMITE_TENTATIVAS', 'Limite diário de cadastros de empresa atingido. Fale com a Kidmais.', 429);
            await tx.query("SELECT pg_advisory_xact_lock(hashtext('kidmais:cnpj:' || $1))", [documento]);
            const existente = (await tx.query<{ empresa_id: string | null }>(
                `SELECT empresa_id::text FROM plataforma_empresas_cadastro WHERE documento_fiscal = $1
                 UNION ALL SELECT empresa_id::text FROM empresa_assinaturas WHERE documento_teste = $1
                 UNION ALL SELECT NULL FROM perfil_empresas WHERE cnpj = $1 LIMIT 1`, [documento])).rows[0];
            if (existente) {
                await tx.query(`INSERT INTO solicitacoes_acesso_empresa (usuario_id, documento, empresa_id) VALUES ($1::uuid, $2, $3::uuid)
                                ON CONFLICT (usuario_id, documento) WHERE situacao = 'PENDENTE' DO NOTHING`, [sessao.usuario_id, documento, existente.empresa_id]);
                await deps.registrarAuditoria({ atorTipo: 'USUARIO', usuarioId: sessao.usuario_id, acao: 'CADASTRO_CNPJ_EXISTENTE', entidadeTipo: 'USUARIO_ADMINISTRATIVO', entidadeId: sessao.usuario_id,
                    dadosDepois: { documento: mascararDocumento(documento), empresaId: existente.empresa_id, resultado: 'RECUSADO' }, origem: 'CADASTRO_PUBLICO', requestId: ctx.requestId, ip: ctx.ip, userAgent: ctx.userAgent }, tx);
                return { situacao: 'CNPJ_EXISTENTE' as const };
            }
            await marcarAtor(tx, sessao.usuario_id);
            const codigo = `${sugerirCodigoEmpresa(d.nomeFantasia).slice(0, 55).replace(/-+$/, '')}-${randomBytes(3).toString('hex')}`;
            const empresaId = (await tx.query<{ id: string }>("INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id::text AS id", [codigo, d.nomeFantasia])).rows[0].id;
            await tx.query("UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid", [empresaId]);
            await tx.query(
                `INSERT INTO plataforma_empresas_cadastro (empresa_id, nome_empresarial, documento_fiscal, responsavel_nome, email, telefone, implantacao, criado_por, atualizado_por)
                 VALUES ($1::uuid, $2, $3, $4, lower(btrim($5)), $6, 'EM_CONFIGURACAO', $7::uuid, $7::uuid)`,
                [empresaId, d.razaoSocial, documento, usuario.nome, usuario.email, telefone, sessao.usuario_id]);
            const membershipId = (await tx.query<{ id: string }>(
                `INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO') RETURNING id`,
                [empresaId, sessao.usuario_id])).rows[0].id;
            await tx.query("UPDATE memberships SET status = 'ATIVA' WHERE id = $1 AND empresa_id = $2", [membershipId, empresaId]);
            await concederPerfilFesta(tx, empresaId, membershipId, 'GESTAO', sessao.usuario_id);
            const teste = await iniciarTeste(tx, { empresaId, documento });
            await tx.query('INSERT INTO empresa_representacoes (empresa_id, usuario_id, qualificacao) VALUES ($1::uuid, $2::uuid, $3)', [empresaId, sessao.usuario_id, d.qualificacao]);
            for (const s of d.socios)
                await tx.query('INSERT INTO empresa_socios (empresa_id, nome, qualificacao, declarado_por) VALUES ($1::uuid, $2, $3, $4::uuid)', [empresaId, s.nome, s.qualificacao, sessao.usuario_id]);
            await registrarAceites(tx, sessao.usuario_id, empresaId, 'NOVA_EMPRESA', ctx);
            await tx.query('INSERT INTO cadastros_empresas (usuario_id, chave, empresa_id, documento) VALUES ($1::uuid, $2::uuid, $3::uuid, $4)', [sessao.usuario_id, d.chave, empresaId, documento]);
            await deps.registrarAuditoria({ atorTipo: 'USUARIO', usuarioId: sessao.usuario_id, acao: 'EMPRESA_CADASTRADA_PUBLICO', entidadeTipo: 'EMPRESA', entidadeId: empresaId,
                dadosDepois: { empresaId, codigo, documento: mascararDocumento(documento), qualificacao: d.qualificacao, socios: d.socios.length, testeFim: teste.testeFim, resultado: 'SUCESSO' },
                origem: 'CADASTRO_PUBLICO', requestId: ctx.requestId, ip: ctx.ip, userAgent: ctx.userAgent }, tx);
            return { situacao: 'CRIADA' as const, empresaId, testeFim: teste.testeFim, repetido: false };
        });
    }
    catch (error) {
        // Corrida com outro cadastro do mesmo CNPJ (índice único do cadastro ou do teste): mesma resposta neutra.
        if (violacaoUnica(error, 'kidmais_063_cad_documento_uk') || violacaoUnica(error, 'empresa_assinaturas_documento_teste_uk'))
            return { situacao: 'CNPJ_EXISTENTE' };
        throw error;
    }
}
