import { z } from 'zod';
import type { DbExecutor } from '../db/contracts';
import { withTransaction as withTransactionPadrao } from '../db/postgres';
import { registrarAuditoria as registrarAuditoriaPadrao } from '../clientes/repositories/auditoria.repository';
import type { SessaoAdmin } from '../autenticacao/service.ts';
import { erroAcesso, violacaoUnica } from '../acessos/erros.ts';
import { emailOpcional, nomeObrigatorio, normalizarDocumentoFiscal, normalizarTelefone, observacoes, textoOpcional } from '../acessos/validacao.ts';
import { exigirDesenvolvedorNaTransacao } from './autorizacao.ts';
import { auditarPainel, diferencas, type ContextoPainel } from './auditoria.ts';

/**
 * Interessadas: registro comercial de quem entrou em contato. Nunca cria empresa, usuário, vínculo nem convite.
 * CONVERTIDA só acontece pelo provisionamento (empresas.ts). Duplicidade:
 *   - bloqueante: mesmo documento ou e-mail em outra interessada em aberto, ou documento já usado por contratante;
 *   - aviso (exige confirmação): mesmo telefone ou mesmo nome em outra interessada em aberto.
 */
export const STATUS_INTERESSADA = ['NOVA', 'EM_CONTATO', 'PROPOSTA', 'CONVERTIDA', 'DESCARTADA'] as const;
export type StatusInteressada = typeof STATUS_INTERESSADA[number];
export const ROTULO_STATUS_INTERESSADA: Record<StatusInteressada, string> = {
    NOVA: 'Nova', EM_CONTATO: 'Em contato', PROPOSTA: 'Proposta enviada', CONVERTIDA: 'Contratante', DESCARTADA: 'Descartada',
};

export type PainelDeps = { withTransaction: typeof withTransactionPadrao; registrarAuditoria: typeof registrarAuditoriaPadrao };
export const painelDepsPadrao: PainelDeps = { withTransaction: withTransactionPadrao, registrarAuditoria: registrarAuditoriaPadrao };

type Linha = {
    id: string; nome: string; nome_empresarial: string | null; documento_fiscal: string | null; responsavel_nome: string | null;
    email: string | null; telefone: string | null; status: StatusInteressada; observacoes: string | null; empresa_id: string | null;
    empresa_nome: string | null; criado_em: string; atualizado_em: string; revisao: number; criado_por_nome: string | null;
};
const COLUNAS = `i.id, i.nome, i.nome_empresarial, i.documento_fiscal, i.responsavel_nome, i.email, i.telefone, i.status, i.observacoes,
  i.empresa_id, e.nome AS empresa_nome, i.criado_em::text, i.atualizado_em::text, i.revisao::int, u.nome AS criado_por_nome`;
const FROM = `FROM plataforma_interessadas i LEFT JOIN empresas e ON e.id = i.empresa_id LEFT JOIN usuarios_administrativos u ON u.id = i.criado_por`;

export type Interessada = {
    id: string; nome: string; nomeEmpresarial: string | null; documentoFiscal: string | null; responsavelNome: string | null;
    email: string | null; telefone: string | null; status: StatusInteressada; statusRotulo: string; observacoes: string | null;
    empresaId: string | null; empresaNome: string | null; criadoEm: string; atualizadoEm: string; revisao: number; criadoPorNome: string | null;
};
function mapear(l: Linha): Interessada {
    return {
        id: l.id, nome: l.nome, nomeEmpresarial: l.nome_empresarial, documentoFiscal: l.documento_fiscal, responsavelNome: l.responsavel_nome,
        email: l.email, telefone: l.telefone, status: l.status, statusRotulo: ROTULO_STATUS_INTERESSADA[l.status], observacoes: l.observacoes,
        empresaId: l.empresa_id, empresaNome: l.empresa_nome, criadoEm: l.criado_em, atualizadoEm: l.atualizado_em, revisao: l.revisao, criadoPorNome: l.criado_por_nome,
    };
}

const camposSchema = {
    nome: nomeObrigatorio(2, 160),
    nomeEmpresarial: textoOpcional(200),
    documentoFiscal: z.string().max(40).nullish(),
    responsavelNome: textoOpcional(160),
    email: emailOpcional,
    telefone: z.string().max(40).nullish(),
    observacoes,
};
const criarSchema = z.object({ ...camposSchema, confirmarSemelhantes: z.boolean().optional() }).strict();
const atualizarSchema = z.object({ ...camposSchema, revisao: z.number().int().positive(), confirmarSemelhantes: z.boolean().optional() }).strict();
const statusSchema = z.object({
    status: z.enum(['NOVA', 'EM_CONTATO', 'PROPOSTA', 'DESCARTADA']),
    motivo: textoOpcional(500),
    revisao: z.number().int().positive(),
}).strict();
const filtrosSchema = z.object({
    busca: z.string().max(120).optional().transform((v) => (v ?? '').trim()),
    status: z.enum([...STATUS_INTERESSADA, 'ABERTAS', 'TODAS']).optional().default('ABERTAS'),
    pagina: z.coerce.number().int().min(1).max(1000).optional().default(1),
}).strict();

function normalizarCampos(input: z.infer<typeof criarSchema> | z.infer<typeof atualizarSchema>) {
    const dados = {
        nome: input.nome,
        nomeEmpresarial: input.nomeEmpresarial ?? null,
        documentoFiscal: normalizarDocumentoFiscal(input.documentoFiscal),
        responsavelNome: input.responsavelNome ?? null,
        email: input.email ?? null,
        telefone: normalizarTelefone(input.telefone),
        observacoes: input.observacoes ?? null,
    };
    if (!dados.email && !dados.telefone)
        throw erroAcesso('DADOS_INVALIDOS', 'Informe ao menos um contato: e-mail ou telefone.', 400);
    return dados;
}
type Dados = ReturnType<typeof normalizarCampos>;

export type Semelhante = { id: string; nome: string; status: string; motivo: 'DOCUMENTO' | 'EMAIL' | 'TELEFONE' | 'NOME' | 'DOCUMENTO_CONTRATANTE'; empresaId?: string | null };

/** Duplicidades contra interessadas em aberto (e contratantes, para documento). `ignorar` = a própria interessada. */
export async function buscarSemelhantes(tx: DbExecutor, dados: Pick<Dados, 'nome' | 'documentoFiscal' | 'email' | 'telefone'>, ignorar: string | null) {
    const linhas = (await tx.query<{ id: string; nome: string; status: string; documento: boolean; email: boolean; telefone: boolean; nome_igual: boolean }>(
        `SELECT id, nome, status,
                ($2::text IS NOT NULL AND documento_fiscal = $2) AS documento,
                ($3::text IS NOT NULL AND email = $3) AS email,
                ($4::text IS NOT NULL AND telefone = $4) AS telefone,
                (lower(nome) = lower($5)) AS nome_igual
           FROM plataforma_interessadas
          WHERE status <> 'DESCARTADA' AND ($1::uuid IS NULL OR id <> $1::uuid)
            AND (($2::text IS NOT NULL AND documento_fiscal = $2) OR ($3::text IS NOT NULL AND email = $3)
                 OR ($4::text IS NOT NULL AND telefone = $4) OR lower(nome) = lower($5))
          ORDER BY atualizado_em DESC LIMIT 10`,
        [ignorar, dados.documentoFiscal, dados.email, dados.telefone, dados.nome])).rows;
    const bloqueantes: Semelhante[] = [], avisos: Semelhante[] = [];
    for (const l of linhas) {
        if (l.documento) bloqueantes.push({ id: l.id, nome: l.nome, status: l.status, motivo: 'DOCUMENTO' });
        else if (l.email) bloqueantes.push({ id: l.id, nome: l.nome, status: l.status, motivo: 'EMAIL' });
        else avisos.push({ id: l.id, nome: l.nome, status: l.status, motivo: l.telefone ? 'TELEFONE' : 'NOME' });
    }
    if (dados.documentoFiscal) {
        const contratante = (await tx.query<{ empresa_id: string; nome: string; status: string }>(
            `SELECT c.empresa_id, e.nome, e.status FROM plataforma_empresas_cadastro c JOIN empresas e ON e.id = c.empresa_id WHERE c.documento_fiscal = $1`, [dados.documentoFiscal])).rows[0];
        if (contratante)
            bloqueantes.push({ id: contratante.empresa_id, nome: contratante.nome, status: contratante.status, motivo: 'DOCUMENTO_CONTRATANTE', empresaId: contratante.empresa_id });
    }
    return { bloqueantes, avisos };
}

function recusarDuplicidade(semelhantes: { bloqueantes: Semelhante[]; avisos: Semelhante[] }, confirmar: boolean | undefined) {
    if (semelhantes.bloqueantes.length)
        throw erroAcesso('DUPLICIDADE', 'Já existe cadastro com o mesmo documento ou e-mail.', 409, { semelhantes: semelhantes.bloqueantes, bloqueante: true });
    if (semelhantes.avisos.length && !confirmar)
        throw erroAcesso('DUPLICIDADE', 'Há cadastros parecidos (mesmo telefone ou nome). Confira antes de salvar.', 409, { semelhantes: semelhantes.avisos, bloqueante: false });
}

function traduzirUnicidade(error: unknown): never {
    if (violacaoUnica(error, 'kidmais_063_int_documento_uk') || violacaoUnica(error, 'kidmais_063_int_email_uk'))
        throw erroAcesso('DUPLICIDADE', 'Já existe interessada em aberto com o mesmo documento ou e-mail.', 409, { bloqueante: true });
    throw error;
}

export async function listarInteressadas(sessao: SessaoAdmin, raw: unknown, deps: PainelDeps = painelDepsPadrao) {
    const filtros = filtrosSchema.parse(raw);
    const porPagina = 25;
    return deps.withTransaction(async (tx) => {
        await exigirDesenvolvedorNaTransacao(tx, sessao);
        const termo = filtros.busca ? `%${filtros.busca.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
        const digitos = filtros.busca.replace(/\D/g, '');
        const condicoes = `($1::text IS NULL OR lower(i.nome) LIKE $1 OR lower(coalesce(i.nome_empresarial, '')) LIKE $1 OR coalesce(i.email, '') LIKE $1
              OR lower(coalesce(i.responsavel_nome, '')) LIKE $1 OR ($2::text <> '' AND (coalesce(i.documento_fiscal, '') LIKE '%' || $2 || '%' OR coalesce(i.telefone, '') LIKE '%' || $2 || '%')))
          AND (CASE $3::text WHEN 'TODAS' THEN true WHEN 'ABERTAS' THEN i.status IN ('NOVA', 'EM_CONTATO', 'PROPOSTA') ELSE i.status = $3::text END)`;
        const total = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM plataforma_interessadas i WHERE ${condicoes}`, [termo, digitos.length >= 3 ? digitos : '', filtros.status])).rows[0].n;
        const linhas = (await tx.query<Linha>(`SELECT ${COLUNAS} ${FROM} WHERE ${condicoes} ORDER BY i.atualizado_em DESC LIMIT ${porPagina} OFFSET $4`,
            [termo, digitos.length >= 3 ? digitos : '', filtros.status, (filtros.pagina - 1) * porPagina])).rows;
        const contagem = (await tx.query<{ status: StatusInteressada; n: number }>('SELECT status, count(*)::int AS n FROM plataforma_interessadas GROUP BY status')).rows;
        return { itens: linhas.map(mapear), total, pagina: filtros.pagina, porPagina, contagem: Object.fromEntries(contagem.map((c) => [c.status, c.n])) };
    });
}

async function linhaTravada(tx: DbExecutor, id: string) {
    const l = (await tx.query<Linha>(`SELECT ${COLUNAS} ${FROM} WHERE i.id = $1::uuid FOR UPDATE OF i`, [id])).rows[0];
    if (!l)
        throw erroAcesso('NAO_ENCONTRADO', 'Interessada não encontrada.', 404);
    return l;
}

export async function obterInteressada(sessao: SessaoAdmin, id: string, deps: PainelDeps = painelDepsPadrao) {
    const uuid = z.string().uuid().parse(id);
    return deps.withTransaction(async (tx) => {
        await exigirDesenvolvedorNaTransacao(tx, sessao);
        const l = (await tx.query<Linha>(`SELECT ${COLUNAS} ${FROM} WHERE i.id = $1::uuid`, [uuid])).rows[0];
        if (!l)
            throw erroAcesso('NAO_ENCONTRADO', 'Interessada não encontrada.', 404);
        const historico = (await tx.query<{ acao: string; criado_em: string; ator: string | null; dados_antes: Record<string, unknown> | null; dados_depois: Record<string, unknown> | null; justificativa: string | null }>(
            `SELECT a.acao, a.criado_em::text, u.nome AS ator, a.dados_antes, a.dados_depois, a.justificativa
               FROM auditoria a LEFT JOIN usuarios_administrativos u ON u.id = a.usuario_id
              WHERE a.entidade_tipo = 'PLATAFORMA_INTERESSADA' AND a.entidade_id = $1::uuid ORDER BY a.criado_em DESC LIMIT 50`, [uuid])).rows;
        return { interessada: mapear(l), historico };
    });
}

export async function criarInteressada(sessao: SessaoAdmin, raw: unknown, ctx: ContextoPainel, deps: PainelDeps = painelDepsPadrao) {
    const input = criarSchema.parse(raw);
    const dados = normalizarCampos(input);
    try {
        return await deps.withTransaction(async (tx) => {
            await exigirDesenvolvedorNaTransacao(tx, sessao);
            // Serializa cadastros concorrentes do painel para a checagem de semelhantes valer.
            await tx.query("SELECT pg_advisory_xact_lock(hashtext('kidmais:plataforma-interessadas'))");
            recusarDuplicidade(await buscarSemelhantes(tx, dados, null), input.confirmarSemelhantes);
            const id = (await tx.query<{ id: string }>(
                `INSERT INTO plataforma_interessadas (nome, nome_empresarial, documento_fiscal, responsavel_nome, email, telefone, observacoes, criado_por, atualizado_por)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING id`,
                [dados.nome, dados.nomeEmpresarial, dados.documentoFiscal, dados.responsavelNome, dados.email, dados.telefone, dados.observacoes, sessao.usuario_id])).rows[0].id;
            await auditarPainel(deps.registrarAuditoria, tx, {
                atorId: sessao.usuario_id, acao: 'INTERESSADA_CADASTRADA', entidadeTipo: 'PLATAFORMA_INTERESSADA', entidadeId: id, resultado: 'SUCESSO',
                depois: { nome: dados.nome, status: 'NOVA', camposInformados: Object.entries(dados).filter(([, v]) => v !== null).map(([k]) => k), semelhantesConfirmados: Boolean(input.confirmarSemelhantes) }, ctx,
            });
            return mapear((await tx.query<Linha>(`SELECT ${COLUNAS} ${FROM} WHERE i.id = $1`, [id])).rows[0]);
        });
    }
    catch (error) {
        traduzirUnicidade(error);
    }
}

const CHAVES_EDITAVEIS = ['nome', 'nomeEmpresarial', 'documentoFiscal', 'responsavelNome', 'email', 'telefone', 'observacoes'] as const;

export async function atualizarInteressada(sessao: SessaoAdmin, id: string, raw: unknown, ctx: ContextoPainel, deps: PainelDeps = painelDepsPadrao) {
    const uuid = z.string().uuid().parse(id);
    const input = atualizarSchema.parse(raw);
    const dados = normalizarCampos(input);
    try {
        return await deps.withTransaction(async (tx) => {
            await exigirDesenvolvedorNaTransacao(tx, sessao);
            await tx.query("SELECT pg_advisory_xact_lock(hashtext('kidmais:plataforma-interessadas'))");
            const atual = await linhaTravada(tx, uuid);
            if (atual.revisao !== input.revisao)
                throw erroAcesso('REVISAO_DESATUALIZADA', 'Este cadastro foi alterado por outra pessoa. Recarregue antes de salvar.', 409);
            if (atual.status === 'CONVERTIDA')
                throw erroAcesso('CONFLITO', 'Interessada convertida: edite os dados na ficha da empresa.', 409);
            const antes = mapear(atual);
            const mudanca = diferencas(antes as unknown as Record<string, unknown>, dados, CHAVES_EDITAVEIS);
            if (!mudanca.alterados.length)
                return antes;
            recusarDuplicidade(await buscarSemelhantes(tx, dados, uuid), input.confirmarSemelhantes);
            await tx.query(
                `UPDATE plataforma_interessadas SET nome = $2, nome_empresarial = $3, documento_fiscal = $4, responsavel_nome = $5, email = $6, telefone = $7, observacoes = $8, atualizado_por = $9
                  WHERE id = $1`,
                [uuid, dados.nome, dados.nomeEmpresarial, dados.documentoFiscal, dados.responsavelNome, dados.email, dados.telefone, dados.observacoes, sessao.usuario_id]);
            await auditarPainel(deps.registrarAuditoria, tx, {
                atorId: sessao.usuario_id, acao: 'INTERESSADA_ATUALIZADA', entidadeTipo: 'PLATAFORMA_INTERESSADA', entidadeId: uuid, resultado: 'SUCESSO',
                antes: mudanca.antes, depois: { ...mudanca.depois, alterados: mudanca.alterados }, ctx,
            });
            return mapear((await tx.query<Linha>(`SELECT ${COLUNAS} ${FROM} WHERE i.id = $1`, [uuid])).rows[0]);
        });
    }
    catch (error) {
        traduzirUnicidade(error);
    }
}

export async function alterarStatusInteressada(sessao: SessaoAdmin, id: string, raw: unknown, ctx: ContextoPainel, deps: PainelDeps = painelDepsPadrao) {
    const uuid = z.string().uuid().parse(id);
    const input = statusSchema.parse(raw);
    try {
        return await deps.withTransaction(async (tx) => {
            await exigirDesenvolvedorNaTransacao(tx, sessao);
            const atual = await linhaTravada(tx, uuid);
            if (atual.revisao !== input.revisao)
                throw erroAcesso('REVISAO_DESATUALIZADA', 'Este cadastro foi alterado por outra pessoa. Recarregue antes de salvar.', 409);
            if (atual.status === 'CONVERTIDA')
                throw erroAcesso('CONFLITO', 'Interessada convertida em contratante não muda de situação.', 409);
            if (atual.status === input.status)
                return mapear(atual);
            if (input.status === 'DESCARTADA' && !input.motivo)
                throw erroAcesso('DADOS_INVALIDOS', 'Informe o motivo do descarte.', 400);
            await tx.query('UPDATE plataforma_interessadas SET status = $2, atualizado_por = $3 WHERE id = $1', [uuid, input.status, sessao.usuario_id]);
            await auditarPainel(deps.registrarAuditoria, tx, {
                atorId: sessao.usuario_id, acao: 'INTERESSADA_STATUS_ALTERADO', entidadeTipo: 'PLATAFORMA_INTERESSADA', entidadeId: uuid, resultado: 'SUCESSO',
                antes: { status: atual.status }, depois: { status: input.status }, justificativa: input.motivo, ctx,
            });
            return mapear((await tx.query<Linha>(`SELECT ${COLUNAS} ${FROM} WHERE i.id = $1`, [uuid])).rows[0]);
        });
    }
    catch (error) {
        if (violacaoUnica(error))
            throw erroAcesso('DUPLICIDADE', 'Não dá para reabrir: já existe outra interessada em aberto com o mesmo documento ou e-mail.', 409, { bloqueante: true });
        throw error;
    }
}
