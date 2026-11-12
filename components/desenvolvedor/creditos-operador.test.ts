import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { carregarModulo } from '../../lib/acessos/teste-carregador.ts';

/**
 * R3 e R4 da janela sandbox de 09/11/2026 (créditos de IA): tela do operador para concluir a devolução manual e situação
 * do pedido devolvido/estornado na tela da Gestão. Textos e regras puras; o efeito no banco está em
 * lib/creditos/creditos-095.postgres.test.ts.
 */
type Operador = {
    ESTADO_DEVOLUCAO: Record<string, string>; TIPO_DEVOLUCAO: Record<string, string>; reais: (c: number | string) => string;
    podeConcluir: (d: { estado: string }) => boolean; referenciaValida: (r: string) => boolean;
};
const operador = () => carregarModulo('components/desenvolvedor/CreditosOperador.tsx', {
    'admin/workspace.module.css': {}, 'admin/admin.module.css': {}, 'desenvolvedor/desenvolvedor.module.css': {},
    'desenvolvedor/cliente': { chamar: async () => ({ ok: true, data: { instalado: false } }), formatarData: (s: string) => s },
    'desenvolvedor/Reautenticacao': { useReautenticacao: () => ({ executar: () => undefined, dialogo: null }) },
}) as unknown as Operador;

test('R3: estados abertos da devolução com texto legível; só EM_CURSO não oferece conclusão manual', () => {
    const { ESTADO_DEVOLUCAO, podeConcluir } = operador();
    for (const estado of ['AGUARDANDO_MANUAL', 'EM_CURSO', 'SOLICITADO', 'SEM_CONFIRMACAO', 'RECUSADO']) {
        assert.ok(ESTADO_DEVOLUCAO[estado], `rótulo de ${estado}`);
        assert.doesNotMatch(ESTADO_DEVOLUCAO[estado], /_/);
        assert.equal(podeConcluir({ estado }), estado !== 'EM_CURSO');
    }
    // Mesma regra do servidor: EM_CURSO é recusado com 409 em operarCreditos.
    const servidor = readFileSync('lib/desenvolvedor/creditos.ts', 'utf8');
    assert.match(servidor, /if \(d\.estado === 'EM_CURSO'\) throw erroAcesso\('CONFLITO'/);
});

test('R3: referência de 3 a 200 caracteres (sem as pontas), como o schema do servidor', () => {
    const { referenciaValida, reais } = operador();
    assert.equal(referenciaValida('  ab '), false);
    assert.equal(referenciaValida('pay_123'), true);
    assert.equal(referenciaValida('x'.repeat(200)), true);
    assert.equal(referenciaValida('x'.repeat(201)), false);
    assert.match(readFileSync('lib/desenvolvedor/creditos.ts', 'utf8'), /acao: z\.literal\('concluir_devolucao'\), protocolo: PROTOCOLO, referencia: z\.string\(\)\.trim\(\)\.min\(3\)\.max\(200\)/);
    assert.equal(reais('19700').replace(/\s/g, ' '), 'R$ 197,00');
});

test('R3 (P3 do Astra): forma da devolução usa as chaves do domínio, inclusive CARTAO', () => {
    const { FORMA_PAGAMENTO } = operador() as unknown as { FORMA_PAGAMENTO: Record<string, string> };
    const { FORMAS } = carregarModulo('lib/creditos/dominio.ts', {}) as unknown as { FORMAS: readonly string[] };
    assert.deepEqual(Object.keys(FORMA_PAGAMENTO).sort(), [...FORMAS].sort());
    assert.equal(FORMA_PAGAMENTO.CARTAO, 'Cartão de crédito');
    assert.equal(FORMA_PAGAMENTO.CREDIT_CARD, undefined, 'billingType do Asaas não é a chave da fila');
    // A fila lê ia_credito_devolucoes.forma, cujo CHECK na 095 é o mesmo conjunto.
    assert.match(readFileSync('database/migrations/20261022_095_ia_creditos.sql', 'utf8'), /forma text NOT NULL CHECK \(forma IN \('PIX', 'CARTAO', 'BOLETO'\)\)/);
});

test('R3: a tela envia só concluir_devolucao com senha recente e exige a conferência no Asaas', () => {
    const fonte = readFileSync('components/desenvolvedor/CreditosOperador.tsx', 'utf8');
    assert.match(fonte, /executar\(\(\) => chamar<[^>]+>\('\/api\/desenvolvedor\/creditos', 'POST', \{ acao: 'concluir_devolucao', protocolo: d\.protocolo, referencia: referencia\.trim\(\) \}\)/);
    assert.equal(fonte.match(/acao: '/g)?.length, 1, 'nenhuma outra ação de créditos nesta tela');
    assert.match(fonte, /disabled=\{ocupado \|\| !conferido \|\| !referenciaValida\(referencia\)\}/);
    assert.match(fonte, /Conferi no Asaas que a restituição/);
    assert.match(fonte, /\{podeConcluir\(d\) && aberta !== d\.protocolo && /);
    assert.doesNotMatch(fonte, /asaas\.com|estornarCobranca/i, 'a tela não chama o Asaas');
});

test('R3: página guardada pelo painel do desenvolvedor e item no menu', () => {
    const pagina = readFileSync('app/desenvolvedor/creditos/page.tsx', 'utf8');
    assert.match(pagina, /await exigirDesenvolvedorNaPagina\('\/desenvolvedor\/creditos'\);\s*return <CreditosOperador \/>;/);
    assert.match(readFileSync('components/desenvolvedor/DesenvolvedorShell.tsx', 'utf8'), /\{ href: '\/desenvolvedor\/creditos', rotulo: 'Créditos de IA', icone: 'wallet' as const \}/);
    const { rotuloAcao } = carregarModulo('components/desenvolvedor/cliente.ts', {}) as unknown as { rotuloAcao: (a: string) => string };
    assert.equal(rotuloAcao('CREDITOS_DEVOLUCAO_CONCLUIDA'), 'Devolução de créditos de IA concluída (restituição conferida no Asaas)');
    assert.equal(rotuloAcao('CREDITOS_DEVOLUCAO_ATENDIMENTO'), 'Devolução de créditos de IA registrada pelo atendimento');
    assert.equal(rotuloAcao('CREDITOS_CORTESIA'), 'Cortesia de créditos de IA concedida');
});

type Gestao = { situacaoDoPedido: (p: { estado: string; devolucao: { estado: string } | null; saldoCancelado?: boolean }) => string };
const gestao = () => carregarModulo('components/admin/AssinaturaCreditos.tsx', {
    'admin/workspace.module.css': {}, 'lib/http/admin-fetch': { adminFetch: async () => null, reautenticarSessao: async () => false },
    'admin/Assinatura': { reais: (c: number) => String(c) }, 'admin/AvisoComercial': { dataCurta: (s: string) => s },
}) as unknown as Gestao;

test('R4: pedido com devolução ou pagamento revertido nunca mostra "Créditos liberados"', () => {
    const { situacaoDoPedido } = gestao();
    const liberado = situacaoDoPedido({ estado: 'CREDITADO', devolucao: null });
    assert.equal(liberado, 'Créditos liberados');
    assert.equal(situacaoDoPedido({ estado: 'CREDITADO', devolucao: { estado: 'AGUARDANDO_MANUAL' } }), 'Devolução em andamento: saldo restante cancelado');
    assert.equal(situacaoDoPedido({ estado: 'CREDITADO', devolucao: { estado: 'SEM_CONFIRMACAO' } }), 'Devolução em andamento: saldo restante cancelado');
    assert.equal(situacaoDoPedido({ estado: 'CREDITADO', devolucao: { estado: 'CONCLUIDO' } }), 'Devolvido: saldo restante cancelado');
    assert.equal(situacaoDoPedido({ estado: 'CREDITADO', devolucao: null, saldoCancelado: true }), 'Pagamento revertido no Asaas: saldo restante cancelado');
    assert.equal(situacaoDoPedido({ estado: 'AGUARDANDO_PAGAMENTO', devolucao: null, saldoCancelado: false }), 'Pagamento em confirmação');
    const fonte = readFileSync('components/admin/AssinaturaCreditos.tsx', 'utf8');
    assert.match(fonte, /data-estado=\{p\.estado\} data-devolucao-estado=\{p\.devolucao\?\.estado\}>/);
    assert.match(fonte, /\{situacaoDoPedido\(p\)\}\./);
    assert.match(readFileSync('lib/creditos/servico.ts', 'utf8'), /saldoCancelado: p\.saldo_cancelado === true/);
});
