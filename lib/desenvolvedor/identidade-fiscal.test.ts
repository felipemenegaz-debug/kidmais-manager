import assert from 'node:assert/strict';
import test from 'node:test';
import { carregarModulo } from '../acessos/teste-carregador.ts';
import { exigirNomeCivil } from '../assinatura/documento-contratante.ts';

/**
 * Identidade fiscal da contratante no painel (revisão completa de 22/10/2026, P2-1/P2-2). Banco, autoridade e auditoria
 * DUBLADOS; serviço real. Documentos SINTÉTICOS com DV calculado. O checkout (nome civil + documento igual ao do teste)
 * é exercitado no PostgreSQL descartável (documento-091, caso 6) e o piloto em comercial.postgres.
 */
type Mod = Record<string, (...a: unknown[]) => Promise<unknown>>;
const ID = '00000000-0000-4000-8000-0000000000f1';
const CPF_A = '52998224725', CPF_B = '00000000191', CNPJ_A = '11444777000161', CNPJ_B = '11222333000181';
const ctx = { requestId: ID, ip: null, userAgent: null };
async function codigo(p: Promise<unknown>) { try { await p; return 'OK'; } catch (e) { return (e as { code?: string }).code ?? (e as Error).message; } }

function painel(documentoFicha: string | null, documentoTeste: string | null, continuidade: string | null = null) {
    const gravados: unknown[][] = [];
    const atual = { id: ID, nome: 'Buffet Sintético', nome_empresarial: 'Titular Sintético A', documento_fiscal: documentoFicha, responsavel_nome: 'Responsável',
        email: 'ficha@exemplo.test', telefone: null, observacoes: null, cad_revisao: 1, cad_empresa: ID };
    const tx = {
        async query(sql: string, p: unknown[] = []) {
            if (sql.includes('FOR UPDATE OF e')) return { rows: [atual] };
            if (sql.includes('to_regclass')) return { rows: [{ ok: true }] };
            if (sql.startsWith('SELECT documento_teste')) return { rows: documentoTeste ? [{ documento_teste: documentoTeste }] : [] };
            if (sql.startsWith('SELECT documento_novo')) return { rows: continuidade ? [{ documento_novo: continuidade, situacao: 'CONCLUIDA' }] : [] };
            if (sql.startsWith('UPDATE plataforma_empresas_cadastro')) gravados.push(p);
            return { rows: [] };
        },
    };
    const mod = carregarModulo('lib/desenvolvedor/empresas.ts', {
        'db/postgres': { db: () => tx },
        'desenvolvedor/autorizacao': { exigirDesenvolvedorNaTransacao: async () => undefined, exigirReautenticacaoRecente: () => undefined, encerrarSessoesSemAcesso: async () => undefined },
        'desenvolvedor/auditoria': { diferencas: (_a: unknown, d: Record<string, unknown>) => ({ alterados: Object.keys(d), antes: {}, depois: {} }), auditarPainel: async () => undefined },
    }) as Mod;
    const salvar = (o: Record<string, unknown>) => mod.atualizarCadastroEmpresa({ usuario_id: ID }, ID, {
        nome: atual.nome, nomeEmpresarial: atual.nome_empresarial, documentoFiscal: documentoFicha, responsavelNome: atual.responsavel_nome, email: atual.email,
        telefone: null, observacoes: null, revisao: 1, ...o }, ctx, { withTransaction: async (f: (t: typeof tx) => Promise<unknown>) => f(tx), registrarAuditoria: async () => undefined });
    return { mod, salvar, gravados };
}

test('P2-1: CPF exige nome civil próprio; CNPJ e ficha sem documento seguem como antes', () => {
    for (const nome of [null, undefined, '', '   '])
        assert.throws(() => exigirNomeCivil(CPF_A, nome), (e: { code?: string; campo?: string; detalhes?: { campo?: string } }) => e.code === 'DADOS_INVALIDOS');
    exigirNomeCivil(CPF_A, 'Maria Sintética da Silva');
    exigirNomeCivil(CNPJ_A, null);
    exigirNomeCivil(null, null);
});

test('P2-1: painel recusa provisionar e editar CPF sem nome civil, antes de abrir transação', async () => {
    const { mod, salvar, gravados } = painel(null, null);
    const prov = (o: Record<string, unknown>) => mod.provisionarContratante({ usuario_id: ID }, { nome: 'Buffet da Maria', responsavelNome: 'Ana', email: 'ana@exemplo.test', confirmar: true, ...o }, ctx,
        { withTransaction: async () => { throw new Error('não deveria abrir transação'); }, registrarAuditoria: async () => undefined, enviarEmail: async () => undefined, gerarToken: () => 'x' });
    assert.equal(await codigo(prov({ documentoFiscal: '529.982.247-25' })), 'DADOS_INVALIDOS');
    assert.equal(await codigo(prov({ documentoFiscal: CPF_A, nomeEmpresarial: '  ' })), 'DADOS_INVALIDOS');
    assert.equal(await codigo(salvar({ documentoFiscal: CPF_A, nomeEmpresarial: null })), 'DADOS_INVALIDOS');
    assert.equal(gravados.length, 0);
});

test('P2-2: depois do teste, a ficha não troca o documento (CPF A→B, CNPJ A→B, CPF↔CNPJ) nem o apaga; nada é gravado', async () => {
    for (const [teste, novo] of [[CPF_A, CPF_B], [CNPJ_A, CNPJ_B], [CPF_A, CNPJ_A], [CNPJ_A, CPF_A], [CPF_A, null]] as const) {
        const { salvar, gravados } = painel(teste, teste);
        assert.equal(await codigo(salvar({ documentoFiscal: novo, nomeEmpresarial: 'Titular Sintético B' })), 'CONFLITO', `${teste} → ${novo}`);
        assert.equal(gravados.length, 0, `${teste} → ${novo}`);
    }
});

test('P2-2: mesmo documento do teste segue editável (correção de nome); sem teste, a ficha troca o documento', async () => {
    const mesmo = painel(CPF_A, CPF_A);
    assert.equal(await codigo(mesmo.salvar({ nomeEmpresarial: 'Titular Sintético A Corrigido' })), 'OK');
    assert.equal(mesmo.gravados.length, 1);
    // Ficha antiga divergente do teste volta ao documento do teste: permitido.
    const volta = painel(CPF_B, CPF_A);
    assert.equal(await codigo(volta.salvar({ documentoFiscal: CPF_A })), 'OK');
    const semTeste = painel(CPF_A, null);
    assert.equal(await codigo(semTeste.salvar({ documentoFiscal: CPF_B, nomeEmpresarial: 'Titular Sintético B' })), 'OK');
    assert.deepEqual(semTeste.gravados[0].slice(1, 3), ['Titular Sintético B', CPF_B]);
});

test('D5: depois da continuidade, a ficha segue o documento VIGENTE (o novo); voltar ao documento do teste é recusado', async () => {
    const depois = painel(CNPJ_A, CPF_A, CNPJ_A);
    assert.equal(await codigo(depois.salvar({ nomeEmpresarial: 'Titular Sintético ME' })), 'OK');
    const volta = painel(CNPJ_A, CPF_A, CNPJ_A);
    assert.equal(await codigo(volta.salvar({ documentoFiscal: CPF_A })), 'CONFLITO');
    assert.equal(volta.gravados.length, 0);
});
