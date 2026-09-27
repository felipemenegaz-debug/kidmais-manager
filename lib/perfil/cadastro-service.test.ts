import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { DbExecutor } from '../db/contracts';
import { aplicarCadastroPerfil, consultarCadastroPerfil, lerCadastroPerfil, salvarRascunhoPerfil } from './cadastro-service.ts';
import type { CadastroPerfil } from './cadastro.ts';

/**
 * Double em memória. Não executa SQL e não prova concorrência no PostgreSQL.
 */

const empresaId = '00000000-0000-4000-8000-000000000001';
const unidadeId = '00000000-0000-4000-8000-000000000002';
const usuarioId = randomUUID();

function cadastro(parcial: Partial<CadastroPerfil> = {}): CadastroPerfil {
    return {
        nomeComercial: 'Kidmais',
        razaoSocial: 'Kidmais Festas Ltda',
        cnpj: '11222333000181',
        sede: { cep: '01001000', logradouro: 'Praça da Sé', numero: '', semNumero: true, complemento: '', bairro: 'Sé', cidade: 'São Paulo', uf: 'SP', pais: 'BR' },
        unidadeNome: 'Sé',
        mesmoEnderecoSede: true,
        unidade: { cep: '01001000', logradouro: 'Praça da Sé', numero: '', semNumero: true, complemento: '', bairro: 'Sé', cidade: 'São Paulo', uf: 'SP', pais: 'BR' },
        referenciaChegada: '',
        telefone: '11999999999',
        whatsapp: '',
        emailComercial: '',
        site: '',
        instagram: '',
        ...parcial,
    };
}

function banco(opcoes: { instalada?: boolean; empresas?: number; edicao?: number | null; numero?: number | null; versao?: number; cnpj?: string; colunas?: number; maxEdicao?: number; maxNumero?: number } = {}) {
    const edicao = opcoes.edicao === undefined ? null : opcoes.edicao;
    const estado = {
        sqls: [] as string[],
        instalada: opcoes.instalada !== false,
        colunas: opcoes.colunas ?? (opcoes.instalada === false ? 0 : 2),
        empresas: opcoes.empresas ?? 1,
        versao: opcoes.versao ?? 0,
        numero: opcoes.numero === undefined ? (edicao == null ? null : 1) : opcoes.numero,
        edicao,
        versaoBaseRascunho: opcoes.versao ?? 0,
        maxEdicao: opcoes.maxEdicao ?? edicao ?? 0,
        maxNumero: opcoes.maxNumero ?? (edicao == null ? 0 : (opcoes.numero ?? 1)),
        conteudo: cadastro({ cnpj: opcoes.cnpj ?? '' }),
        cnpj: opcoes.cnpj ?? '',
        nome: '',
        historico: [] as Array<Record<string, unknown>>,
    };
    const tx = {
        async query(sql: string, params: readonly unknown[] = []) {
            estado.sqls.push(sql);
            if (sql.includes('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'))
                return { rows: [], rowCount: 0 };
            if (sql.includes('perfil_empresa_revisoes') && sql.includes('to_regclass')) {
                return { rows: [{ empresas: estado.instalada ? 'perfil_empresas' : null, unidades: estado.instalada ? 'perfil_unidades' : null, revisoes: estado.instalada ? 'perfil_empresa_revisoes' : null, colunas_revisao: estado.colunas }], rowCount: 1 };
            }
            if (sql.includes("to_regclass('public.perfil_empresas') AS empresas, to_regclass('public.perfil_empresa_concessoes')"))
                return { rows: [{ empresas: 'perfil_empresas', concessoes: 'perfil_empresa_concessoes' }], rowCount: 1 };
            if (sql.includes('FROM public.perfil_empresas')) {
                if (estado.empresas === 0)
                    return { rows: [], rowCount: 0 };
                const linhas = Array.from({ length: estado.empresas }, (_, indice) => ({
                    id: indice === 0 ? empresaId : randomUUID(),
                    codigo: 'EMP-1',
                    versao: estado.versao,
                    nome_comercial: estado.nome,
                    razao_social: '',
                    cnpj: estado.cnpj,
                    sede_cep: '', sede_logradouro: '', sede_numero: null, sede_sem_numero: false, sede_complemento: null,
                    sede_bairro: '', sede_cidade: '', sede_uf: '', sede_pais: 'BR',
                }));
                return { rows: linhas, rowCount: linhas.length };
            }
            if (sql.includes('pg_advisory_xact_lock'))
                return { rows: [], rowCount: 1 };
            if (sql.includes('FROM public.perfil_unidades'))
                return { rows: [{ id: unidadeId, codigo: 'UNI-1', nome: '', mesmo_endereco_sede: false, cep: '', logradouro: '', numero: null, sem_numero: false, complemento: null, bairro: '', cidade: '', uf: '', pais: 'BR', referencia_chegada: null, telefone: null, whatsapp: null, email_comercial: null, site: null, instagram: null }], rowCount: 1 };
            if (sql.includes('SELECT id, papel, ativo FROM usuarios_administrativos'))
                return { rows: [{ id: usuarioId, papel: 'REPRESENTANTE_AUTORIZADO', ativo: true }], rowCount: 1 };
            if (sql.includes('SELECT capacidade FROM public.perfil_empresa_concessoes'))
                return { rows: [{ capacidade: 'PERFIL_CONSULTAR' }, { capacidade: 'PERFIL_EDITAR_RASCUNHO' }, { capacidade: 'PERFIL_APLICAR' }], rowCount: 3 };
            if (sql.includes('COALESCE(max(edicao),0)'))
                return { rows: [{ max_edicao: estado.maxEdicao, max_numero: estado.maxNumero }], rowCount: 1 };
            if (sql.includes('SELECT') && sql.includes('conteudo') && sql.includes('perfil_empresa_revisoes'))
                return { rows: estado.edicao == null ? [] : [{ numero: estado.numero, edicao: estado.edicao, versao_base: estado.versaoBaseRascunho, conteudo: estado.conteudo }], rowCount: estado.edicao == null ? 0 : 1 };
            if (sql.includes('SELECT numero, edicao, versao_base FROM'))
                return { rows: estado.edicao == null ? [] : [{ numero: estado.numero, edicao: estado.edicao, versao_base: estado.versaoBaseRascunho }], rowCount: estado.edicao == null ? 0 : 1 };
            if (sql.includes('INSERT INTO public.perfil_empresa_revisoes')) {
                estado.numero = Number(params[2]);
                estado.edicao = Number(params[4]);
                estado.maxNumero = Number(params[2]);
                estado.maxEdicao = Number(params[4]);
                estado.versaoBaseRascunho = Number(params[3]);
                estado.conteudo = JSON.parse(String(params[5]));
                return { rows: [], rowCount: 1 };
            }
            if (sql.includes('AND numero=$2 AND edicao=$3 AND versao_base=$4')) {
                if (params[1] !== estado.numero || params[2] !== estado.edicao || params[3] !== estado.versaoBaseRascunho)
                    return { rows: [], rowCount: 0 };
                estado.conteudo = JSON.parse(String(params[4]));
                estado.edicao = Number(estado.edicao) + 1;
                estado.maxEdicao = estado.edicao;
                return { rows: [], rowCount: 1 };
            }
            if (sql.includes('UPDATE public.perfil_empresas SET')) {
                estado.versao += 1;
                estado.cnpj = String(params[3]);
                estado.nome = String(params[1]);
                return { rows: [], rowCount: 1 };
            }
            if (sql.includes('UPDATE public.perfil_unidades SET'))
                return { rows: [], rowCount: 1 };
            if (sql.includes("SET estado='APLICADA'")) {
                if (params[1] !== estado.numero || params[2] !== estado.edicao || params[6] !== estado.versaoBaseRascunho)
                    return { rows: [], rowCount: 0 };
                estado.edicao = null;
                estado.numero = null;
                return { rows: [], rowCount: 1 };
            }
            if (sql.includes('ORDER BY r.numero DESC'))
                return { rows: estado.historico, rowCount: estado.historico.length };
            throw new Error(sql);
        },
    };
    return { estado, tx: tx as DbExecutor };
}

test('sem a migration de cadastro a consulta não finge dados e não esconde outro erro', async () => {
    const ausente = banco({ instalada: false });
    const consulta = await consultarCadastroPerfil(ausente.tx, usuarioId, null);
    assert.equal(consulta.estruturaInstalada, false);
    assert.equal(ausente.estado.sqls.some((sql) => /contratos|documentos_publicos|festa_usuario_capacidades/.test(sql)), false);
});

test('rascunho divergente não grava e a aplicação sensível exige reautenticação', async () => {
    const divergente = banco({ edicao: 2 });
    await assert.rejects(() => salvarRascunhoPerfil(divergente.tx, {
        usuarioId, empresaIdCliente: null, numero: 1, edicao: 1, versaoBase: 0, cadastro: cadastro(), requestId: 'r1',
    }, async () => ({})), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'PERFIL_CONFLITO');
    assert.equal(divergente.estado.conteudo.nomeComercial, 'Kidmais');

    const sensivel = banco({ edicao: 1, cnpj: '' });
    sensivel.estado.conteudo = cadastro();
    await assert.rejects(() => aplicarCadastroPerfil(sensivel.tx, {
        usuarioId, empresaIdCliente: 'outra-empresa', numero: 1, edicao: 1, versaoBase: 0, confirmar: true,
        motivo: 'Correção cadastral', autenticadoEm: new Date().toISOString(), requestId: 'r2',
    }, async () => ({})), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'PERFIL_SEM_CONCESSAO');

    const antiga = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    await assert.rejects(() => aplicarCadastroPerfil(sensivel.tx, {
        usuarioId, empresaIdCliente: null, numero: 1, edicao: 1, versaoBase: 0, confirmar: true,
        motivo: 'Correção cadastral', autenticadoEm: antiga, requestId: 'r3',
    }, async () => ({})), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'PERFIL_REAUTENTICACAO');
    assert.equal(sensivel.estado.versao, 0);
    assert.equal(sensivel.estado.sqls.some((sql) => /contrato|documentos_publicos|tabela_pacotes/.test(sql)), false);

    const aplicado = await aplicarCadastroPerfil(sensivel.tx, {
        usuarioId, empresaIdCliente: null, numero: 1, edicao: 1, versaoBase: 0, confirmar: true,
        motivo: 'Correção cadastral', autenticadoEm: new Date().toISOString(), requestId: 'r4',
    }, async () => ({}));
    assert.equal(aplicado.versao, 1);
    assert.equal(sensivel.estado.cnpj, '11222333000181');
});

test('aba antiga com a mesma edição não grava por cima de outro rascunho', async () => {
    const atual = banco({ numero: 2, edicao: 1, maxEdicao: 4, maxNumero: 2 });
    atual.estado.conteudo = cadastro({ nomeComercial: 'Rascunho novo' });
    await assert.rejects(() => salvarRascunhoPerfil(atual.tx, {
        usuarioId, empresaIdCliente: null, numero: 1, edicao: 1, versaoBase: 0,
        cadastro: cadastro({ nomeComercial: 'Aba antiga' }), requestId: 'antiga',
    }, async () => ({})), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'PERFIL_CONFLITO');
    assert.equal(atual.estado.conteudo.nomeComercial, 'Rascunho novo');
    assert.equal(atual.estado.numero, 2);
});

test('duas abas sem rascunho não deixam a segunda substituir a primeira', async () => {
    const vazio = banco({ edicao: null });
    const primeira = await salvarRascunhoPerfil(vazio.tx, {
        usuarioId, empresaIdCliente: null, numero: null, edicao: null, versaoBase: 0,
        cadastro: cadastro({ nomeComercial: 'Primeira' }), requestId: 't1',
    }, async () => ({}));
    assert.equal(primeira.edicao, 1);
    assert.equal(primeira.numero, 1);
    await assert.rejects(() => salvarRascunhoPerfil(vazio.tx, {
        usuarioId, empresaIdCliente: null, numero: null, edicao: null, versaoBase: 0,
        cadastro: cadastro({ nomeComercial: 'Segunda' }), requestId: 't2',
    }, async () => ({})), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'PERFIL_CONFLITO');
    assert.equal(vazio.estado.conteudo.nomeComercial, 'Primeira');
});

test('publicar antes do salvamento da outra aba não cria rascunho sobre a versão nova', async () => {
    const publicado = banco({ versao: 1, edicao: null });
    await assert.rejects(() => salvarRascunhoPerfil(publicado.tx, {
        usuarioId, empresaIdCliente: null, numero: null, edicao: null, versaoBase: 0,
        cadastro: cadastro({ nomeComercial: 'Atrasada' }), requestId: 'pub',
    }, async () => ({})), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'PERFIL_CONFLITO');
    assert.equal(publicado.estado.edicao, null);
    assert.equal(publicado.estado.sqls.some((sql) => sql.includes('INSERT INTO public.perfil_empresa_revisoes')), false);
});

test('a leitura devolve versão, rascunho e histórico do mesmo snapshot', async () => {
    const leitura = banco({ edicao: 3, numero: 5, versao: 2 });
    leitura.estado.versaoBaseRascunho = 2;
    leitura.estado.historico = [{
        numero: 5, estado: 'RASCUNHO', motivo: null, versao_base: 2,
        editor_nome: 'Ana', editado_em: '2026-09-25T00:00:00.000Z', aplicador_nome: null, aplicado_em: null,
    }];
    const lido = await lerCadastroPerfil(leitura.tx, usuarioId);
    assert.match(leitura.estado.sqls[0] ?? '', /REPEATABLE READ/);
    assert.equal(lido.contexto?.versao, lido.contexto?.rascunho?.versaoBase);
    assert.equal(lido.historico[0]?.editorNome, 'Ana');
    assert.equal(lido.historico[0]?.aplicadorNome, null);
    assert.equal('email' in (lido.historico[0] ?? {}), false);
    assert.equal(lido.capacidades?.PERFIL_CONSULTAR, true);
});

test('mais de uma empresa é recusada pelo serviço, sem índice de singleton', async () => {
    const varias = banco({ empresas: 2 });
    await assert.rejects(() => consultarCadastroPerfil(varias.tx, usuarioId, null), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'PERFIL_LIMITE_V1');
});
