import type { DbExecutor } from '../db/contracts';
import type { AppendAuditoriaInput } from '../clientes/repositories/auditoria.repository.ts';
import { ClienteServiceError } from '../clientes/services/errors.ts';
import type { CapacidadePerfil } from './capacidades.ts';
import { exigirCapacidadePerfil } from './autorizacao.ts';
import { estruturaPerfilInstalada } from './estrutura.ts';
import { exigirReautenticacaoPerfil } from './reautenticacao.ts';

export const MENSAGEM_ULTIMA_ADMINISTRADORA = 'Esta conta é a última que administra as concessões do perfil. Transfira essa capacidade antes de desativar, revogar ou retirar a Gestão.';

export type UsuarioPerfilRow = {
    id: string;
    nome: string;
    email: string;
    papel: string;
    ativo: boolean;
};

export type ModoPerdaElegibilidade = 'desativar' | 'retirar-gestao' | 'revogar-administrar' | 'revogar-outra';

export type AvaliacaoPerda = {
    instalada: boolean;
    recusado: boolean;
    empresasBloqueadas: string[];
    usuario: UsuarioPerfilRow | null;
    mensagem: string | null;
};

type LinhaElegivel = { empresa_id: string; usuario_id: string; papel: string; ativo: boolean };

function chaveEmpresa(empresaId: string) {
    return `kidmais:perfil-empresa:${empresaId}`;
}

export async function travarEmpresasPerfil(tx: DbExecutor, empresaIds: readonly string[]) {
    for (const empresaId of [...empresaIds].sort()) {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [chaveEmpresa(empresaId)]);
    }
}

async function lerUsuario(tx: DbExecutor, usuarioId: string) {
    return (await tx.query<UsuarioPerfilRow>(
        'SELECT id,nome,email,papel,ativo FROM usuarios_administrativos WHERE id=$1 FOR UPDATE',
        [usuarioId],
    )).rows[0] ?? null;
}

function empresasOndeEhUltima(linhas: readonly LinhaElegivel[], usuarioId: string) {
    const porEmpresa = new Map<string, LinhaElegivel[]>();
    for (const linha of linhas) {
        const lista = porEmpresa.get(linha.empresa_id) ?? [];
        lista.push(linha);
        porEmpresa.set(linha.empresa_id, lista);
    }
    const bloqueadas: string[] = [];
    for (const [empresaId, lista] of porEmpresa) {
        const elegiveis = lista.filter((linha) => linha.ativo && linha.papel === 'REPRESENTANTE_AUTORIZADO');
        if (elegiveis.length === 1 && elegiveis[0]?.usuario_id === usuarioId)
            bloqueadas.push(empresaId);
    }
    return bloqueadas.sort();
}

export async function avaliarPerdaDeElegibilidade(tx: DbExecutor, input: {
    usuarioId: string;
    modo: ModoPerdaElegibilidade;
    empresaId?: string;
}): Promise<AvaliacaoPerda> {
    const instalada = await estruturaPerfilInstalada(tx);
    if (!instalada)
        return { instalada: false, recusado: false, empresasBloqueadas: [], usuario: null, mensagem: null };
    const empresas = input.empresaId
        ? [input.empresaId]
        : (await tx.query<{ id: string }>('SELECT id FROM public.perfil_empresas ORDER BY id')).rows.map((linha) => linha.id);
    await travarEmpresasPerfil(tx, empresas);
    const usuario = await lerUsuario(tx, input.usuarioId);
    if (!usuario)
        throw new ClienteServiceError('PERFIL_CONTA_AUSENTE', 'Conta não encontrada.', 404);
    const linhas = empresas.length === 0
        ? []
        : (await tx.query<LinhaElegivel>(
            `SELECT c.empresa_id, c.usuario_id, u.papel, u.ativo
             FROM public.perfil_empresa_concessoes c
             JOIN usuarios_administrativos u ON u.id = c.usuario_id
             WHERE c.revogado_em IS NULL
               AND c.capacidade = 'PERFIL_ADMINISTRAR_CONCESSOES'
               AND c.empresa_id = ANY($1::uuid[])
             ORDER BY c.empresa_id, c.id
             FOR UPDATE OF c`,
            [empresas],
        )).rows;
    const bloqueadas = input.modo === 'revogar-outra' ? [] : empresasOndeEhUltima(linhas, input.usuarioId);
    const aplica = input.modo === 'desativar'
        ? usuario.ativo
        : input.modo === 'retirar-gestao'
            ? usuario.ativo && usuario.papel === 'REPRESENTANTE_AUTORIZADO'
            : input.modo === 'revogar-administrar';
    const recusado = aplica && bloqueadas.length > 0;
    return {
        instalada: true,
        recusado,
        empresasBloqueadas: recusado ? bloqueadas : [],
        usuario,
        mensagem: recusado ? MENSAGEM_ULTIMA_ADMINISTRADORA : null,
    };
}

export async function possuiConcessaoAtiva(tx: DbExecutor, usuarioId: string) {
    const result = await tx.query<{ id: string }>(
        `SELECT id FROM public.perfil_empresa_concessoes WHERE usuario_id=$1 AND revogado_em IS NULL LIMIT 1`,
        [usuarioId],
    );
    return result.rows.length > 0;
}

export async function revogarConcessoesAtivasDoUsuario(tx: DbExecutor, input: {
    usuarioId: string;
    operadorId: string;
    motivo: string;
    empresaId?: string;
    capacidade?: CapacidadePerfil;
}) {
    const motivo = input.motivo.trim();
    if (motivo.length < 3)
        throw new ClienteServiceError('PERFIL_CADASTRO_INVALIDO', 'Informe o motivo da revogação.', 400);
    if (!input.operadorId)
        throw new ClienteServiceError('PERFIL_OPERADOR_OBRIGATORIO', 'A revogação do perfil precisa de um operador identificado.', 409);
    return (await tx.query<{ id: string; empresa_id: string; capacidade: string }>(
        `UPDATE public.perfil_empresa_concessoes
         SET revogado_por=$2, revogado_em=clock_timestamp(), motivo_revogacao=$3
         WHERE usuario_id=$1
           AND revogado_em IS NULL
           AND ($4::uuid IS NULL OR empresa_id=$4)
           AND ($5::text IS NULL OR capacidade=$5)
         RETURNING id, empresa_id, capacidade`,
        [input.usuarioId, input.operadorId, motivo, input.empresaId ?? null, input.capacidade ?? null],
    )).rows;
}

export async function aplicarProtecaoPerfilNaAtualizacao(tx: DbExecutor, input: {
    usuarioId: string;
    papelAntes: string;
    papelDepois: string;
    ativoAntes: boolean;
    ativoDepois: boolean;
    operadorId: string | null;
}) {
    const desativa = input.ativoAntes && !input.ativoDepois;
    const retiraGestao = input.papelAntes === 'REPRESENTANTE_AUTORIZADO' && input.papelDepois !== 'REPRESENTANTE_AUTORIZADO';
    const reativacao = !input.ativoAntes && input.ativoDepois;
    const retiradaGestaoSemEncerrarSessao = Boolean(input.ativoAntes && input.ativoDepois && retiraGestao);
    if (!desativa && !retiraGestao) {
        return {
            recusado: false,
            mensagem: null as string | null,
            empresasBloqueadas: [] as string[],
            revogar: false,
            reativacao,
            retiradaGestaoSemEncerrarSessao: false,
        };
    }
    const avaliacao = await avaliarPerdaDeElegibilidade(tx, {
        usuarioId: input.usuarioId,
        modo: desativa ? 'desativar' : 'retirar-gestao',
    });
    if (!avaliacao.instalada) {
        return {
            recusado: false,
            mensagem: null,
            empresasBloqueadas: [],
            revogar: false,
            reativacao,
            retiradaGestaoSemEncerrarSessao,
        };
    }
    if (avaliacao.recusado) {
        if (!input.operadorId)
            throw new ClienteServiceError('PERFIL_OPERADOR_OBRIGATORIO', 'A recusa precisa de um operador identificado.', 409);
        return {
            recusado: true,
            mensagem: avaliacao.mensagem,
            empresasBloqueadas: avaliacao.empresasBloqueadas,
            revogar: false,
            reativacao: false,
            retiradaGestaoSemEncerrarSessao: false,
        };
    }
    const revogar = await possuiConcessaoAtiva(tx, input.usuarioId);
    if (revogar && !input.operadorId)
        throw new ClienteServiceError('PERFIL_OPERADOR_OBRIGATORIO', 'A atualização revoga concessões do perfil e precisa de um operador identificado.', 409);
    return {
        recusado: false,
        mensagem: null,
        empresasBloqueadas: [],
        revogar,
        reativacao,
        retiradaGestaoSemEncerrarSessao,
    };
}

type Auditoria = (input: AppendAuditoriaInput, tx?: DbExecutor) => Promise<unknown>;

export async function revogarCapacidadePerfil(tx: DbExecutor, input: {
    empresaId: string;
    usuarioId: string;
    capacidade: CapacidadePerfil;
    operadorId: string;
    motivo: string;
    sessao: { autenticado_em: string };
    agora?: number;
    requestId: string;
}, auditoria: Auditoria) {
    exigirReautenticacaoPerfil(input.sessao, input.agora);
    const avaliacao = await avaliarPerdaDeElegibilidade(tx, {
        usuarioId: input.usuarioId,
        modo: input.capacidade === 'PERFIL_ADMINISTRAR_CONCESSOES' ? 'revogar-administrar' : 'revogar-outra',
        empresaId: input.empresaId,
    });
    if (!avaliacao.instalada)
        throw new ClienteServiceError('PERFIL_ESTRUTURA_AUSENTE', 'A estrutura do perfil ainda não está instalada.', 409);
    await exigirCapacidadePerfil(tx, input.empresaId, input.operadorId, 'PERFIL_ADMINISTRAR_CONCESSOES');
    const trilha = {
        atorTipo: 'USUARIO' as const,
        usuarioId: input.operadorId,
        entidadeTipo: 'PERFIL_EMPRESA',
        entidadeId: input.empresaId,
        justificativa: input.motivo.trim(),
        origem: 'PERFIL_EMPRESA',
        requestId: input.requestId,
    };
    if (avaliacao.recusado) {
        await auditoria({
            ...trilha,
            acao: 'PERFIL_REVOGACAO_RECUSADA',
            dadosDepois: { usuarioId: input.usuarioId, capacidade: input.capacidade, empresas: avaliacao.empresasBloqueadas },
        }, tx);
        return { recusado: true as const, empresasBloqueadas: avaliacao.empresasBloqueadas, linhas: [] };
    }
    const linhas = await revogarConcessoesAtivasDoUsuario(tx, input);
    await auditoria({
        ...trilha,
        acao: 'PERFIL_REVOGADO',
        dadosDepois: { usuarioId: input.usuarioId, capacidade: input.capacidade, concessoes: linhas.map((linha) => linha.id) },
    }, tx);
    return { recusado: false as const, empresasBloqueadas: [] as string[], linhas };
}
