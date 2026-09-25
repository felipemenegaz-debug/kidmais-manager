import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { DbExecutor } from '../db/contracts';
import { consultarCapacidadesPerfil, exigirCapacidadePerfil } from './autorizacao.ts';
import {
    aplicarProtecaoPerfilNaAtualizacao,
    avaliarPerdaDeElegibilidade,
    MENSAGEM_ULTIMA_ADMINISTRADORA,
    revogarCapacidadePerfil,
    revogarConcessoesAtivasDoUsuario,
} from './protecao-usuarios.ts';

/**
 * Estes doubles conferem a sequência de SQL e o estado em memória.
 * Não executam PostgreSQL e não provam corrida nem rollback reais.
 */

type Usuario = { id: string; nome: string; email: string; papel: string; ativo: boolean };
type Concessao = {
    id: string;
    empresaId: string;
    usuarioId: string;
    capacidade: string;
    revogadoEm: string | null;
    revogadoPor: string | null;
    motivo: string | null;
};
type Estado = {
    instalada: boolean;
    empresas: string[];
    usuarios: Usuario[];
    concessoes: Concessao[];
    sessoesRevogadas: string[];
    locks: string[];
    sqls: string[];
    falha: { quando: string; code: string } | null;
    surgirAposTravaInicial?: { empresas: string[]; concessoes: Concessao[] };
};

function estadoInicial(parcial: Partial<Estado> = {}): Estado {
    return {
        instalada: true,
        empresas: [],
        usuarios: [],
        concessoes: [],
        sessoesRevogadas: [],
        locks: [],
        sqls: [],
        falha: null,
        ...parcial,
    };
}

function executor(estado: Estado): DbExecutor {
    return {
        async query(sql: string, params: readonly unknown[] = []) {
            estado.sqls.push(sql);
            if (estado.falha && sql.includes(estado.falha.quando))
                throw Object.assign(new Error('erro de banco'), { code: estado.falha.code });
            if (sql.includes("to_regclass('public.perfil_empresas')")) {
                return {
                    rows: [estado.instalada
                        ? { empresas: 'perfil_empresas', concessoes: 'perfil_empresa_concessoes' }
                        : { empresas: null, concessoes: null }],
                    rowCount: 1,
                };
            }
            if (sql.includes('pg_advisory_xact_lock')) {
                const chave = String(params[0]);
                estado.locks.push(chave);
                if (chave === 'kidmais:perfil-empresa:provisionamento-inicial' && estado.surgirAposTravaInicial) {
                    estado.empresas = estado.surgirAposTravaInicial.empresas;
                    estado.concessoes = estado.surgirAposTravaInicial.concessoes;
                }
                return { rows: [], rowCount: 1 };
            }
            if (sql.includes('FROM public.perfil_empresas ORDER BY id'))
                return { rows: estado.empresas.map((id) => ({ id })), rowCount: estado.empresas.length };
            if (sql.includes('WHERE id=$1 FOR UPDATE')) {
                const usuario = estado.usuarios.find((item) => item.id === params[0]);
                return { rows: usuario ? [usuario] : [], rowCount: usuario ? 1 : 0 };
            }
            if (sql.includes('FOR UPDATE OF c')) {
                const ids = params[0] as string[];
                const linhas = estado.concessoes
                    .filter((item) => item.capacidade === 'PERFIL_ADMINISTRAR_CONCESSOES' && item.revogadoEm == null && ids.includes(item.empresaId))
                    .map((item) => {
                        const usuario = estado.usuarios.find((atual) => atual.id === item.usuarioId);
                        return { empresa_id: item.empresaId, usuario_id: item.usuarioId, papel: usuario?.papel, ativo: usuario?.ativo };
                    });
                return { rows: linhas, rowCount: linhas.length };
            }
            if (sql.includes('SELECT id FROM public.perfil_empresa_concessoes')) {
                const ativa = estado.concessoes.some((item) => item.usuarioId === params[0] && item.revogadoEm == null);
                return { rows: ativa ? [{ id: 'ativa' }] : [], rowCount: ativa ? 1 : 0 };
            }
            if (sql.includes('UPDATE public.perfil_empresa_concessoes')) {
                const linhas = [];
                for (const item of estado.concessoes) {
                    if (item.usuarioId !== params[0] || item.revogadoEm != null)
                        continue;
                    if (params[3] && item.empresaId !== params[3])
                        continue;
                    if (params[4] && item.capacidade !== params[4])
                        continue;
                    item.revogadoEm = 'agora';
                    item.revogadoPor = String(params[1]);
                    item.motivo = String(params[2]);
                    linhas.push({ id: item.id, empresa_id: item.empresaId, capacidade: item.capacidade });
                }
                return { rows: linhas, rowCount: linhas.length };
            }
            if (sql.includes('SELECT id, papel, ativo FROM usuarios_administrativos')) {
                const usuario = estado.usuarios.find((item) => item.id === params[0]);
                return { rows: usuario ? [{ id: usuario.id, papel: usuario.papel, ativo: usuario.ativo }] : [], rowCount: usuario ? 1 : 0 };
            }
            if (sql.includes('SELECT capacidade FROM public.perfil_empresa_concessoes')) {
                const linhas = estado.concessoes.filter((item) => item.empresaId === params[0] && item.usuarioId === params[1] && item.revogadoEm == null);
                return { rows: linhas.map((item) => ({ capacidade: item.capacidade })), rowCount: linhas.length };
            }
            if (sql.includes('UPDATE usuarios_administrativos SET ativo=false')) {
                const usuario = estado.usuarios.find((item) => item.id === params[0]);
                if (!usuario)
                    return { rows: [], rowCount: 0 };
                usuario.ativo = false;
                return { rows: [{ ...usuario }], rowCount: 1 };
            }
            if (sql.includes('UPDATE sessoes_administrativas')) {
                estado.sessoesRevogadas.push(String(params[0]));
                return { rows: [], rowCount: 1 };
            }
            throw new Error(sql);
        },
    } as DbExecutor;
}

function transacionar(estado: Estado) {
    return async <T>(fn: (tx: ReturnType<typeof executor>) => Promise<T>) => {
        const antes = JSON.stringify({
            usuarios: estado.usuarios,
            concessoes: estado.concessoes,
            sessoesRevogadas: estado.sessoesRevogadas,
        });
        try {
            return await fn(executor(estado));
        } catch (error) {
            const snap = JSON.parse(antes) as Pick<Estado, 'usuarios' | 'concessoes' | 'sessoesRevogadas'>;
            estado.usuarios = snap.usuarios;
            estado.concessoes = snap.concessoes;
            estado.sessoesRevogadas = snap.sessoesRevogadas;
            throw error;
        }
    };
}

function usuario(parcial: Partial<Usuario> = {}): Usuario {
    return {
        id: randomUUID(),
        nome: 'Ana',
        email: 'ana@example.invalid',
        papel: 'REPRESENTANTE_AUTORIZADO',
        ativo: true,
        ...parcial,
    };
}

function concessao(parcial: Partial<Concessao>): Concessao {
    return {
        id: randomUUID(),
        empresaId: randomUUID(),
        usuarioId: randomUUID(),
        capacidade: 'PERFIL_CONSULTAR',
        revogadoEm: null,
        revogadoPor: null,
        motivo: null,
        ...parcial,
    };
}

test('sem estrutura o perfil fica fechado e a avaliação não revoga concessão', async () => {
    const gestao = usuario();
    const estado = estadoInicial({ instalada: false, usuarios: [gestao] });
    const consulta = await consultarCapacidadesPerfil(executor(estado), randomUUID(), gestao.id);
    assert.equal(consulta.estruturaInstalada, false);
    assert.equal(consulta.gestaoAtiva, false);
    assert.deepEqual(Object.values(consulta.capacidades), [false, false, false, false]);
    const avaliacao = await avaliarPerdaDeElegibilidade(executor(estado), { usuarioId: gestao.id, modo: 'desativar' });
    assert.equal(avaliacao.instalada, false);
    assert.equal(estado.sqls.some((sql) => sql.includes('UPDATE public.perfil_empresa_concessoes')), false);
    assert.equal(estado.sqls.some((sql) => sql.includes('festa_usuario_capacidades')), false);
});

test('erro inesperado de banco não vira ausência de estrutura', async () => {
    const estado = estadoInicial({ falha: { quando: 'to_regclass', code: '53300' } });
    await assert.rejects(() => avaliarPerdaDeElegibilidade(executor(estado), { usuarioId: randomUUID(), modo: 'desativar' }), (error: unknown) => {
        return typeof error === 'object' && error !== null && 'code' in error && error.code === '53300';
    });
    const instalada = estadoInicial({ falha: { quando: 'perfil_empresas ORDER BY id', code: '42P01' } });
    await assert.rejects(() => avaliarPerdaDeElegibilidade(executor(instalada), { usuarioId: randomUUID(), modo: 'desativar' }), (error: unknown) => {
        return typeof error === 'object' && error !== null && 'code' in error && error.code === '42P01';
    });
});

test('Gestão inativa, recém-criada ou de Equipe não recebe capacidade', async () => {
    const empresaId = randomUUID();
    const inativa = usuario({ ativo: false });
    const nova = usuario({ email: 'nova@example.invalid' });
    const equipe = usuario({ papel: 'ADMINISTRATIVO', email: 'equipe@example.invalid' });
    const estado = estadoInicial({
        empresas: [empresaId],
        usuarios: [inativa, nova, equipe],
        concessoes: [
            concessao({ empresaId, usuarioId: inativa.id, capacidade: 'PERFIL_CONSULTAR' }),
            concessao({ empresaId, usuarioId: equipe.id, capacidade: 'PERFIL_ADMINISTRAR_CONCESSOES' }),
            concessao({ empresaId, usuarioId: nova.id, capacidade: 'FESTA_CORRIGIR' }),
        ],
    });
    const tx = executor(estado);
    assert.equal((await consultarCapacidadesPerfil(tx, empresaId, inativa.id)).gestaoAtiva, false);
    assert.equal((await consultarCapacidadesPerfil(tx, empresaId, nova.id)).capacidades.PERFIL_CONSULTAR, false);
    assert.equal((await consultarCapacidadesPerfil(tx, empresaId, equipe.id)).gestaoAtiva, false);
    await assert.rejects(() => exigirCapacidadePerfil(tx, empresaId, nova.id, 'PERFIL_CONSULTAR'));
    assert.equal(estado.sqls.some((sql) => sql.includes('festa_usuario_capacidades')), false);
});

test('concessão ativa de Gestão vale só para a capacidade e a empresa pedidas', async () => {
    const empresaA = '00000000-0000-4000-8000-0000000000a1';
    const empresaB = '00000000-0000-4000-8000-0000000000b2';
    const gestao = usuario();
    const estado = estadoInicial({
        empresas: [empresaB, empresaA],
        usuarios: [gestao],
        concessoes: [concessao({ empresaId: empresaA, usuarioId: gestao.id, capacidade: 'PERFIL_CONSULTAR' })],
    });
    const consulta = await consultarCapacidadesPerfil(executor(estado), empresaA, gestao.id);
    assert.equal(consulta.capacidades.PERFIL_CONSULTAR, true);
    assert.equal(consulta.capacidades.PERFIL_APLICAR, false);
    const outra = await consultarCapacidadesPerfil(executor(estado), empresaB, gestao.id);
    assert.equal(outra.capacidades.PERFIL_CONSULTAR, false);
});

test('desativar a última administradora é recusada antes de alterar a conta', async () => {
    const empresaId = randomUUID();
    const titular = usuario();
    const concessaoAtiva = concessao({ empresaId, usuarioId: titular.id, capacidade: 'PERFIL_ADMINISTRAR_CONCESSOES' });
    const estado = estadoInicial({ empresas: [empresaId], usuarios: [titular], concessoes: [concessaoAtiva] });
    const avaliacao = await avaliarPerdaDeElegibilidade(executor(estado), { usuarioId: titular.id, modo: 'desativar' });
    assert.equal(avaliacao.recusado, true);
    assert.equal(avaliacao.mensagem, MENSAGEM_ULTIMA_ADMINISTRADORA);
    assert.equal(titular.ativo, true);
    assert.equal(concessaoAtiva.revogadoEm, null);
    assert.deepEqual(estado.sessoesRevogadas, []);
    assert.equal(estado.sqls.some((sql) => sql.includes('SET ativo=false')), false);
});

test('desativar outra conta pode revogar concessões nas empresas, com trava ordenada', async () => {
    const empresaA = '00000000-0000-4000-8000-0000000000a1';
    const empresaB = '00000000-0000-4000-8000-0000000000b2';
    const titular = usuario();
    const outra = usuario({ email: 'outra@example.invalid' });
    const operador = usuario({ email: 'op@example.invalid' });
    const estado = estadoInicial({
        empresas: [empresaB, empresaA],
        usuarios: [titular, outra, operador],
        concessoes: [
            concessao({ empresaId: empresaA, usuarioId: titular.id, capacidade: 'PERFIL_ADMINISTRAR_CONCESSOES' }),
            concessao({ empresaId: empresaA, usuarioId: outra.id, capacidade: 'PERFIL_ADMINISTRAR_CONCESSOES' }),
            concessao({ empresaId: empresaB, usuarioId: outra.id, capacidade: 'PERFIL_CONSULTAR' }),
        ],
    });
    const avaliacao = await avaliarPerdaDeElegibilidade(executor(estado), { usuarioId: outra.id, modo: 'desativar' });
    assert.equal(avaliacao.recusado, false);
    await revogarConcessoesAtivasDoUsuario(executor(estado), {
        usuarioId: outra.id,
        operadorId: operador.id,
        motivo: 'Desativação da conta administrativa',
    });
    assert.equal(estado.concessoes.filter((item) => item.usuarioId === outra.id).every((item) => item.revogadoEm === 'agora'), true);
    assert.equal(estado.concessoes.find((item) => item.usuarioId === titular.id)?.revogadoEm, null);
    assert.deepEqual(estado.locks, [
        'kidmais:perfil-empresa:provisionamento-inicial',
        'kidmais:perfil-empresa:00000000-0000-4000-8000-0000000000a1',
        'kidmais:perfil-empresa:00000000-0000-4000-8000-0000000000b2',
    ]);
});

test('lista vazia anterior à trava comum não libera desativar nem retirar a Gestão do novo titular', async () => {
    const empresaNova = '00000000-0000-4000-8000-0000000000c3';
    for (const modo of ['desativar', 'retirar-gestao'] as const) {
        const titular = usuario();
        const estado = estadoInicial({
            empresas: [],
            usuarios: [titular],
            concessoes: [],
            surgirAposTravaInicial: {
                empresas: [empresaNova],
                concessoes: [concessao({ empresaId: empresaNova, usuarioId: titular.id, capacidade: 'PERFIL_ADMINISTRAR_CONCESSOES' })],
            },
        });
        const avaliacao = await avaliarPerdaDeElegibilidade(executor(estado), { usuarioId: titular.id, modo });
        assert.equal(avaliacao.recusado, true);
        assert.equal(titular.ativo, true);
        assert.equal(titular.papel, 'REPRESENTANTE_AUTORIZADO');
        assert.equal(estado.concessoes[0]?.revogadoEm, null);
        const travas = estado.sqls.flatMap((sql, indice) => sql.includes('pg_advisory_xact_lock') ? [indice] : []);
        const lista = estado.sqls.findIndex((sql) => sql.includes('FROM public.perfil_empresas ORDER BY id'));
        const usuarioTravado = estado.sqls.findIndex((sql) => sql.includes('WHERE id=$1 FOR UPDATE'));
        const grants = estado.sqls.findIndex((sql) => sql.includes('FOR UPDATE OF c'));
        assert.equal(estado.locks[0], 'kidmais:perfil-empresa:provisionamento-inicial');
        assert.equal(estado.locks[1], `kidmais:perfil-empresa:${empresaNova}`);
        assert.ok(travas[0] < lista && lista < travas[1] && travas[1] < usuarioTravado && usuarioTravado < grants);
    }
});

test('última administradora em uma empresa bloqueia a desativação inteira', async () => {
    const empresaA = '00000000-0000-4000-8000-0000000000a1';
    const empresaB = '00000000-0000-4000-8000-0000000000b2';
    const titular = usuario();
    const colega = usuario({ email: 'colega@example.invalid' });
    const estado = estadoInicial({
        empresas: [empresaA, empresaB],
        usuarios: [titular, colega],
        concessoes: [
            concessao({ empresaId: empresaA, usuarioId: titular.id, capacidade: 'PERFIL_ADMINISTRAR_CONCESSOES' }),
            concessao({ empresaId: empresaB, usuarioId: titular.id, capacidade: 'PERFIL_ADMINISTRAR_CONCESSOES' }),
            concessao({ empresaId: empresaB, usuarioId: colega.id, capacidade: 'PERFIL_ADMINISTRAR_CONCESSOES' }),
        ],
    });
    const avaliacao = await avaliarPerdaDeElegibilidade(executor(estado), { usuarioId: titular.id, modo: 'desativar' });
    assert.equal(avaliacao.recusado, true);
    assert.deepEqual(avaliacao.empresasBloqueadas, [empresaA]);
    assert.equal(estado.concessoes.every((item) => item.revogadoEm == null), true);
});

test('retirar Gestão revoga concessões e reativar não as restaura', async () => {
    const empresaId = randomUUID();
    const titular = usuario();
    const colega = usuario({ email: 'colega@example.invalid' });
    const operador = usuario({ email: 'op@example.invalid' });
    const ativa = concessao({ empresaId, usuarioId: colega.id, capacidade: 'PERFIL_EDITAR_RASCUNHO' });
    const estado = estadoInicial({
        empresas: [empresaId],
        usuarios: [titular, colega, operador],
        concessoes: [
            concessao({ empresaId, usuarioId: titular.id, capacidade: 'PERFIL_ADMINISTRAR_CONCESSOES' }),
            ativa,
        ],
    });
    const tx = executor(estado);
    const efeito = await aplicarProtecaoPerfilNaAtualizacao(tx, {
        usuarioId: colega.id,
        papelAntes: 'REPRESENTANTE_AUTORIZADO',
        papelDepois: 'ADMINISTRATIVO',
        ativoAntes: true,
        ativoDepois: true,
        operadorId: operador.id,
    });
    assert.equal(efeito.recusado, false);
    assert.equal(efeito.revogar, true);
    assert.equal(efeito.retiradaGestaoSemEncerrarSessao, true);
    await revogarConcessoesAtivasDoUsuario(tx, {
        usuarioId: colega.id,
        operadorId: operador.id,
        motivo: 'Retirada do papel Gestão',
    });
    colega.ativo = false;
    colega.papel = 'ADMINISTRATIVO';
    colega.ativo = true;
    const reativacao = await aplicarProtecaoPerfilNaAtualizacao(executor(estado), {
        usuarioId: colega.id,
        papelAntes: 'ADMINISTRATIVO',
        papelDepois: 'ADMINISTRATIVO',
        ativoAntes: false,
        ativoDepois: true,
        operadorId: operador.id,
    });
    assert.equal(reativacao.reativacao, true);
    assert.equal(reativacao.revogar, false);
    assert.equal(ativa.revogadoEm, 'agora');
    assert.equal(estado.sqls.some((sql) => sql.includes('INSERT INTO perfil_empresa_concessoes')), false);
    assert.equal(estado.sqls.filter((sql) => sql.includes('SET revogado_por')).length, 1);
});

test('mudança para Equipe da última administradora é recusada sem alterar o papel', async () => {
    const empresaId = randomUUID();
    const titular = usuario();
    const estado = estadoInicial({
        empresas: [empresaId],
        usuarios: [titular],
        concessoes: [concessao({ empresaId, usuarioId: titular.id, capacidade: 'PERFIL_ADMINISTRAR_CONCESSOES' })],
    });
    const efeito = await aplicarProtecaoPerfilNaAtualizacao(executor(estado), {
        usuarioId: titular.id,
        papelAntes: 'REPRESENTANTE_AUTORIZADO',
        papelDepois: 'ADMINISTRATIVO',
        ativoAntes: true,
        ativoDepois: true,
        operadorId: randomUUID(),
    });
    assert.equal(efeito.recusado, true);
    assert.equal(titular.papel, 'REPRESENTANTE_AUTORIZADO');
    assert.equal(estado.concessoes[0]?.revogadoEm, null);
});

test('falha depois da revogação desfaz o estado no double de transação', async () => {
    const empresaId = randomUUID();
    const titular = usuario();
    const colega = usuario({ email: 'colega@example.invalid' });
    const ativa = concessao({ empresaId, usuarioId: colega.id, capacidade: 'PERFIL_CONSULTAR' });
    const estado = estadoInicial({
        empresas: [empresaId],
        usuarios: [titular, colega],
        concessoes: [
            concessao({ empresaId, usuarioId: titular.id, capacidade: 'PERFIL_ADMINISTRAR_CONCESSOES' }),
            ativa,
        ],
    });
    await assert.rejects(() => transacionar(estado)(async (tx) => {
        await revogarConcessoesAtivasDoUsuario(tx, {
            usuarioId: colega.id,
            operadorId: titular.id,
            motivo: 'Desativação da conta administrativa',
        });
        throw new Error('auditoria falhou');
    }));
    assert.equal(estado.concessoes.find((item) => item.id === ativa.id)?.revogadoEm, null);
    assert.equal(estado.usuarios.find((item) => item.id === colega.id)?.ativo, true);
});

test('revogar a capacidade de administrar exige reautenticação e preserva a última', async () => {
    const empresaId = randomUUID();
    const titular = usuario();
    const estado = estadoInicial({
        empresas: [empresaId],
        usuarios: [titular],
        concessoes: [concessao({ empresaId, usuarioId: titular.id, capacidade: 'PERFIL_ADMINISTRAR_CONCESSOES' })],
    });
    const antiga = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const auditorias: Array<{ acao: string; usuarioId?: string | null; dadosDepois?: Record<string, unknown> | null }> = [];
    const auditar = async (input: { acao: string; usuarioId?: string | null; dadosDepois?: Record<string, unknown> | null }) => {
        auditorias.push(input);
    };
    await assert.rejects(() => revogarCapacidadePerfil(executor(estado), {
        empresaId,
        usuarioId: titular.id,
        capacidade: 'PERFIL_ADMINISTRAR_CONCESSOES',
        operadorId: titular.id,
        motivo: 'Transferência recusada no teste',
        sessao: { autenticado_em: antiga },
        requestId: 'revoga-1',
    }, auditar));
    const recusa = await revogarCapacidadePerfil(executor(estado), {
        empresaId,
        usuarioId: titular.id,
        capacidade: 'PERFIL_ADMINISTRAR_CONCESSOES',
        operadorId: titular.id,
        motivo: 'Transferência recusada no teste',
        sessao: { autenticado_em: new Date().toISOString() },
        requestId: 'revoga-2',
    }, auditar);
    assert.equal(recusa.recusado, true);
    assert.equal(estado.concessoes[0]?.revogadoEm, null);
    assert.equal(auditorias.at(-1)?.acao, 'PERFIL_REVOGACAO_RECUSADA');
    assert.equal(auditorias.at(-1)?.usuarioId, titular.id);
    assert.equal(JSON.stringify(auditorias.at(-1)?.dadosDepois).includes('@'), false);
});

test('revogar sem a capacidade de administrar não altera a concessão', async () => {
    const empresaId = randomUUID();
    const titular = usuario();
    const outro = usuario({ email: 'outro@example.invalid' });
    const estado = estadoInicial({
        empresas: [empresaId],
        usuarios: [titular, outro],
        concessoes: [concessao({ empresaId, usuarioId: titular.id, capacidade: 'PERFIL_CONSULTAR' })],
    });
    await assert.rejects(() => revogarCapacidadePerfil(executor(estado), {
        empresaId,
        usuarioId: titular.id,
        capacidade: 'PERFIL_CONSULTAR',
        operadorId: outro.id,
        motivo: 'Sem permissão de administrar',
        sessao: { autenticado_em: new Date().toISOString() },
        requestId: 'revoga-3',
    }, async () => ({})), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'PERFIL_SEM_CONCESSAO');
    assert.equal(estado.concessoes[0]?.revogadoEm, null);
});

test('o provisionamento atual não insere concessão de perfil', () => {
    const script = readFileSync('scripts/admin-provision.cjs', 'utf8');
    const usuarios = readFileSync('lib/autenticacao/usuarios.ts', 'utf8');
    const precos = readFileSync('app/api/admin/configuracoes/tabela-pacotes/route.ts', 'utf8');
    assert.match(script, /aplicarProtecaoPerfilNaAtualizacao/);
    assert.match(script, /retiradaGestaoSemEncerrarSessao && !hash/);
    assert.doesNotMatch(script, /INSERT INTO perfil_empresa_concessoes/);
    assert.doesNotMatch(usuarios, /INSERT INTO perfil_empresa_concessoes/);
    assert.match(precos, /sessao\.papel !== 'REPRESENTANTE_AUTORIZADO'/);
    assert.doesNotMatch(precos, /PERFIL_/);
});
