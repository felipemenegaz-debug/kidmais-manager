import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import {
    coletarEntradaProvisionamento,
    confirmarSinal,
    exigirTerminalInterativo,
    lerOculto,
    mascaraConta,
    provisionar,
    validarDestino,
} from '../../scripts/perfil-empresa-provisionar.cjs';

const empresaId = '00000000-0000-4000-8000-000000000010';
const unidadeId = '00000000-0000-4000-8000-000000000011';
const operadorId = '00000000-0000-4000-8000-000000000012';
const contaId = '00000000-0000-4000-8000-000000000013';
const entrada = {
    operadorId, contaId, motivo: 'Concessão inicial autorizada', referencia: 'AUT-001', ambiente: 'staging',
};

const adminAlheio = '00000000-0000-4000-8000-000000000099';

function cliente(opcoes: {
    empresas?: number;
    unidades?: number;
    ativoNaReleitura?: boolean;
    duplicada?: boolean;
    adminAlheio?: boolean;
} = {}) {
    const sqls: string[] = [];
    const locks: string[] = [];
    let leiturasConta = 0;
    const consultas = {
        async query(sql: string, params: readonly unknown[] = []) {
            sqls.push(sql);
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK')
                return { rows: [], rowCount: 0 };
            if (sql.includes('pg_advisory_xact_lock')) {
                locks.push(String(params[0] ?? ''));
                return { rows: [], rowCount: 0 };
            }
            if (sql.includes('FROM public.perfil_empresas ORDER BY id')) {
                const linhas = Array.from({ length: opcoes.empresas ?? 1 }, (_, indice) => ({ id: indice === 0 ? empresaId : `00000000-0000-4000-8000-0000000000a${indice}` }));
                return { rows: linhas, rowCount: linhas.length };
            }
            if (sql.includes('INSERT INTO public.perfil_empresas'))
                return { rows: [{ id: empresaId }], rowCount: 1 };
            if (sql.includes('INSERT INTO public.perfil_unidades'))
                return { rows: [{ id: unidadeId }], rowCount: 1 };
            if (sql.includes('FROM public.perfil_empresas WHERE id=$1 FOR UPDATE'))
                return { rows: [{ id: empresaId }], rowCount: 1 };
            if (sql.includes('FROM public.perfil_unidades')) {
                const linhas = Array.from({ length: opcoes.unidades ?? 1 }, () => ({ id: unidadeId }));
                return { rows: linhas, rowCount: linhas.length };
            }
            if (sql.includes('WHERE id=$1 FOR UPDATE')) {
                const id = String(params[0]);
                if (id === contaId)
                    leiturasConta += 1;
                const ativo = id === contaId && opcoes.ativoNaReleitura === false && leiturasConta > 1 ? false : true;
                return { rows: [{ id, papel: 'REPRESENTANTE_AUTORIZADO', ativo }], rowCount: 1 };
            }
            if (sql.includes('SELECT capacidade FROM'))
                return { rows: opcoes.duplicada ? [{ capacidade: 'PERFIL_CONSULTAR' }] : [], rowCount: opcoes.duplicada ? 1 : 0 };
            if (sql.includes('FOR UPDATE OF c')) {
                if (!opcoes.adminAlheio)
                    return { rows: [], rowCount: 0 };
                return {
                    rows: [{ usuario_id: adminAlheio, papel: 'REPRESENTANTE_AUTORIZADO', ativo: true }],
                    rowCount: 1,
                };
            }
            if (sql.includes('INSERT INTO public.perfil_empresa_concessoes'))
                return { rows: [], rowCount: 1 };
            if (sql.includes('INSERT INTO auditoria')) {
                assert.equal(JSON.stringify(params).includes('@'), false);
                return { rows: [], rowCount: 1 };
            }
            throw new Error(sql);
        },
    };
    return { sqls, locks, consultas };
}

test('a conexão fica oculta e o destino não se prova pelo nome do banco', async () => {
    const entradaTerminal = new EventEmitter();
    Object.assign(entradaTerminal, { setRawMode() { }, resume() { }, pause() { } });
    const escritos: string[] = [];
    const pendente = lerOculto(entradaTerminal, { write(texto: string) { escritos.push(texto); } }, 'Conexão: ');
    entradaTerminal.emit('data', Buffer.from('segredo-oculto\r'));
    assert.equal(await pendente, 'segredo-oculto');
    assert.equal(escritos.join('').includes('segredo-oculto'), false);
    assert.throws(() => exigirTerminalInterativo({ isTTY: false }));
    const url = 'postgres://usuario:sintetica@db.exemplo.invalid:5432/kidmais_homologacao';
    assert.deepEqual(validarDestino(url, { host: 'db.exemplo.invalid', banco: 'kidmais_homologacao', ambiente: 'staging' }), {
        host: 'db.exemplo.invalid', banco: 'kidmais_homologacao', ambiente: 'staging',
    });
    assert.throws(() => validarDestino(url, { host: 'outro.invalid', banco: 'kidmais_homologacao', ambiente: 'staging' }));
    assert.throws(() => validarDestino(url, { host: 'db.exemplo.invalid', banco: 'kidmais_homologacao', ambiente: 'homologacao' }));
    const revisao = 'postgres://usuario:sintetica@127.0.0.1:55432/kidmais_perfil_v1_revisao';
    assert.equal(validarDestino(revisao, { host: '127.0.0.1', banco: 'kidmais_perfil_v1_revisao', ambiente: 'revisao-local' }).ambiente, 'revisao-local');
    assert.throws(() => validarDestino(revisao, { host: '127.0.0.1', banco: 'kidmais_perfil_v1_revisao', ambiente: 'staging' }));
    assert.throws(() => validarDestino('postgres://usuario:sintetica@db.exemplo.invalid:5432/kidmais_perfil_v1_revisao', {
        host: 'db.exemplo.invalid', banco: 'kidmais_perfil_v1_revisao', ambiente: 'revisao-local',
    }));
    assert.throws(() => validarDestino('postgres://usuario:sintetica@db.exemplo.invalid:5432/kidmais_manager', {
        host: 'db.exemplo.invalid', banco: 'kidmais_manager', ambiente: 'staging',
    }));
    assert.equal(mascaraConta('ana@example.invalid'), 'a***@e***');
    assert.throws(() => confirmarSinal('a***@e***', 'ana@example.invalid'));
    confirmarSinal('a***@e***', 'a***@e***');
});

test('empresa e unidade existentes são reutilizadas e a concessão entra na auditoria', async () => {
    const banco = cliente();
    const resultado = await provisionar(banco.consultas, entrada);
    assert.equal(resultado.empresaId, empresaId);
    assert.equal(resultado.unidadeId, unidadeId);
    assert.equal(banco.sqls.some((sql) => sql.includes('INSERT INTO public.perfil_empresas')), false);
    const travas = banco.sqls.flatMap((sql, indice) => sql.includes('pg_advisory_xact_lock') ? [indice] : []);
    const lista = banco.sqls.findIndex((sql) => sql.includes('FROM public.perfil_empresas ORDER BY id'));
    const usuario = banco.sqls.findIndex((sql) => sql.includes('WHERE id=$1 FOR UPDATE'));
    const concessao = banco.sqls.findIndex((sql) => sql.includes('INSERT INTO public.perfil_empresa_concessoes'));
    const auditoria = banco.sqls.findIndex((sql) => sql.includes('PERFIL_CONCESSAO_INICIAL'));
    assert.equal(banco.locks[0], 'kidmais:perfil-empresa:provisionamento-inicial');
    assert.equal(banco.locks[1], `kidmais:perfil-empresa:${empresaId}`);
    assert.ok(travas[0] < lista && lista < travas[1] && travas[1] < usuario && usuario < concessao && concessao < auditoria);
    assert.equal(banco.sqls.filter((sql) => sql.includes('INSERT INTO public.perfil_empresa_concessoes')).length, 4);
});

test('empresa já existente sem unidade única, duplicata ou desativação não concede', async () => {
    const semUnidade = cliente({ unidades: 0 });
    await assert.rejects(() => provisionar(semUnidade.consultas, entrada), /exatamente uma unidade/);
    assert.equal(semUnidade.sqls.some((sql) => sql.includes('INSERT INTO public.perfil_empresa_concessoes')), false);

    const duplicada = cliente({ duplicada: true });
    await assert.rejects(() => provisionar(duplicada.consultas, entrada), /não será duplicada/);
    assert.equal(duplicada.sqls.some((sql) => sql.includes('INSERT INTO public.perfil_empresa_concessoes')), false);
    assert.equal(duplicada.sqls.at(-1), 'ROLLBACK');

    const varias = cliente({ empresas: 2 });
    await assert.rejects(() => provisionar(varias.consultas, entrada), /mais de uma empresa/);
    assert.equal(varias.sqls.some((sql) => sql.includes('INSERT INTO public.perfil_empresa_concessoes')), false);

    const segundaConta = cliente({ adminAlheio: true });
    await assert.rejects(() => provisionar(segundaConta.consultas, entrada), /administrador elegível/);
    assert.equal(segundaConta.sqls.some((sql) => sql.includes('INSERT INTO public.perfil_empresa_concessoes')), false);
    assert.equal(segundaConta.sqls.some((sql) => sql.includes('PERFIL_CONCESSAO_INICIAL')), false);
    assert.equal(segundaConta.sqls.at(-1), 'ROLLBACK');

    const desativada = cliente({ ativoNaReleitura: false });
    await assert.rejects(() => provisionar(desativada.consultas, entrada), /Gestão ativa/);
    assert.equal(desativada.sqls.some((sql) => sql.includes('INSERT INTO public.perfil_empresa_concessoes')), false);
});

test('a composição do terminal não ecoa a conexão', { timeout: 5000 }, async () => {
    const marcador = 'postgres://marcador-sintetico:segredo@db.exemplo.invalid:5432/kidmais_homologacao';
    const respostas = [
        marcador,
        'db.exemplo.invalid',
        'kidmais_homologacao',
        'staging',
        'ana@example.invalid',
        'bia@example.invalid',
        'Motivo inicial autorizado',
        'AUT-001',
        'a***@e***',
        'b***@e***',
        'CONFIRMAR',
    ];
    const entradaTerminal = new PassThrough();
    Object.assign(entradaTerminal, { isTTY: true, setRawMode() { } });
    const escritos: string[] = [];
    let indice = 0;
    const saida = new PassThrough();
    Object.assign(saida, { isTTY: true });
    const prompts = [
        'Conexão PostgreSQL de provisionamento (oculta): ',
        'Host declarado: ',
        'Nome do banco declarado: ',
        'Ambiente explícito (staging ou producao): ',
        'Email do operador identificado: ',
        'Email da conta confirmada em canal privado: ',
        'Motivo da concessão inicial: ',
        'Referência da autorização: ',
        'Repita o sinal do operador: ',
        'Repita o sinal da conta: ',
        'Digite CONFIRMAR para concluir o provisionamento desta conta: ',
    ];
    saida.write = ((chunk: unknown) => {
        const texto = String(chunk);
        escritos.push(texto);
        if (prompts.some((prompt) => texto.includes(prompt)) && indice < respostas.length) {
            const linha = respostas[indice];
            indice += 1;
            queueMicrotask(() => entradaTerminal.write(`${linha}\n`));
        }
        return true;
    }) as typeof saida.write;
    const coletado = await coletarEntradaProvisionamento(entradaTerminal, saida);
    assert.equal(coletado.connection, marcador);
    assert.equal(coletado.confirmacao, 'CONFIRMAR');
    assert.equal(escritos.join('').includes(marcador), false);
    assert.equal(escritos.join('').includes('segredo'), false);
});
