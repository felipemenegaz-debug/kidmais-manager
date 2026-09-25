import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
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

function cliente(opcoes: {
    empresas?: number;
    unidades?: number;
    ativoNaReleitura?: boolean;
    duplicada?: boolean;
} = {}) {
    const sqls: string[] = [];
    let leiturasConta = 0;
    const consultas = {
        async query(sql: string, params: readonly unknown[] = []) {
            sqls.push(sql);
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.includes('pg_advisory_xact_lock'))
                return { rows: [], rowCount: 0 };
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
            if (sql.includes('FOR UPDATE OF c'))
                return { rows: [], rowCount: 0 };
            if (sql.includes('INSERT INTO public.perfil_empresa_concessoes'))
                return { rows: [], rowCount: 1 };
            if (sql.includes('INSERT INTO auditoria')) {
                assert.equal(JSON.stringify(params).includes('@'), false);
                return { rows: [], rowCount: 1 };
            }
            throw new Error(sql);
        },
    };
    return { sqls, consultas };
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
    const travaInicial = banco.sqls.findIndex((sql) => sql.includes('provisionamento-inicial'));
    const travaEmpresa = banco.sqls.findIndex((sql) => sql.includes('hashtextextended($1'));
    const usuario = banco.sqls.findIndex((sql) => sql.includes('WHERE id=$1 FOR UPDATE'));
    const concessao = banco.sqls.findIndex((sql) => sql.includes('INSERT INTO public.perfil_empresa_concessoes'));
    const auditoria = banco.sqls.findIndex((sql) => sql.includes('PERFIL_CONCESSAO_INICIAL'));
    assert.ok(travaInicial >= 0 && travaInicial < travaEmpresa && travaEmpresa < usuario && usuario < concessao && concessao < auditoria);
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

    const desativada = cliente({ ativoNaReleitura: false });
    await assert.rejects(() => provisionar(desativada.consultas, entrada), /Gestão ativa/);
    assert.equal(desativada.sqls.some((sql) => sql.includes('INSERT INTO public.perfil_empresa_concessoes')), false);
});
