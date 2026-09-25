import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { ZodError, z } from 'zod';
import { exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { withTransaction } from '@/lib/db/postgres';
import { registrarAuditoria } from '@/lib/clientes/repositories/auditoria.repository';
import { isClienteServiceError } from '@/lib/clientes/services/errors';
import { aplicarCadastroPerfil, lerCadastroPerfil, salvarRascunhoPerfil } from '@/lib/perfil/cadastro-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const endereco = z.object({
    cep: z.string().max(16).optional(),
    logradouro: z.string().max(160).optional(),
    numero: z.string().max(20).optional(),
    semNumero: z.boolean().optional(),
    complemento: z.string().max(80).optional(),
    bairro: z.string().max(80).optional(),
    cidade: z.string().max(80).optional(),
    uf: z.string().max(2).optional(),
    pais: z.string().max(2).optional(),
}).strict();

const cadastro = z.object({
    nomeComercial: z.string().max(160).optional(),
    razaoSocial: z.string().max(160).optional(),
    cnpj: z.string().max(32).optional(),
    sede: endereco.optional(),
    unidadeNome: z.string().max(160).optional(),
    mesmoEnderecoSede: z.boolean().optional(),
    unidade: endereco.optional(),
    referenciaChegada: z.string().max(160).optional(),
    telefone: z.string().max(20).optional(),
    whatsapp: z.string().max(20).optional(),
    emailComercial: z.string().max(254).optional(),
    site: z.string().max(200).optional(),
    instagram: z.string().max(200).optional(),
}).strict();

const corpo = z.discriminatedUnion('acao', [
    z.object({
        acao: z.literal('salvar-rascunho'),
        numero: z.number().int().positive().nullable(),
        edicao: z.number().int().positive().nullable(),
        versaoBase: z.number().int().nonnegative(),
        empresaId: z.string().uuid().nullable().optional(),
        cadastro,
    }).strict(),
    z.object({
        acao: z.literal('aplicar'),
        numero: z.number().int().positive(),
        edicao: z.number().int().positive(),
        versaoBase: z.number().int().nonnegative(),
        confirmar: z.literal(true),
        motivo: z.string().trim().min(3).max(500),
        empresaId: z.string().uuid().nullable().optional(),
    }).strict(),
]);

function json(data: unknown, status = 200) {
    return NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

function fail(error: unknown) {
    if (error instanceof ZodError || error instanceof SyntaxError)
        return json({ ok: false, erro: 'Confira os dados do perfil.' }, 400);
    if (isClienteServiceError(error))
        return json({ ok: false, erro: error.message, codigo: error.code, detalhes: error.details ?? null }, error.httpStatus);
    const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
    if (['23505', '40001', '40P01'].includes(code))
        return json({ ok: false, erro: 'Outra operação alterou este registro. Atualize e tente novamente.', codigo: 'PERFIL_CONFLITO' }, 409);
    console.error('[PerfilEmpresa]', code || 'erro');
    return json({ ok: false, erro: 'Não foi possível concluir a operação.' }, 500);
}

export async function GET(request: NextRequest) {
    try {
        const sessao = await exigirApiAdminCrmDisponivel(request);
        const data = await withTransaction((tx) => lerCadastroPerfil(tx, sessao.usuario_id));
        return json({ ok: true, data });
    } catch (error) {
        return fail(error);
    }
}

export async function POST(request: NextRequest) {
    try {
        const sessao = await exigirApiAdminCrmDisponivel(request);
        const body = corpo.parse(await request.json());
        const requestId = randomUUID();
        const data = await withTransaction(async (tx) => {
            if (body.acao === 'salvar-rascunho') {
                return salvarRascunhoPerfil(tx, {
                    usuarioId: sessao.usuario_id,
                    empresaIdCliente: body.empresaId ?? null,
                    numero: body.numero,
                    edicao: body.edicao,
                    versaoBase: body.versaoBase,
                    cadastro: body.cadastro as Partial<import('@/lib/perfil/cadastro').CadastroPerfil>,
                    requestId,
                }, registrarAuditoria);
            }
            return aplicarCadastroPerfil(tx, {
                usuarioId: sessao.usuario_id,
                empresaIdCliente: body.empresaId ?? null,
                numero: body.numero,
                edicao: body.edicao,
                versaoBase: body.versaoBase,
                confirmar: true,
                motivo: body.motivo,
                autenticadoEm: sessao.autenticado_em,
                requestId,
            }, registrarAuditoria);
        });
        return json({ ok: true, data });
    } catch (error) {
        return fail(error);
    }
}
