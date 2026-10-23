import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { concluirArrependimento, consultarArrependimento, mensagemAvisoArrependimento, mensagemConfirmacaoArrependimento, PROTOCOLO_ARREPENDIMENTO,
    registrarArrependimento, registrarComunicacaoIntermediador, type DepsArrependimento } from './arrependimento.ts';

// Grupo C (23/10/2026): direito de arrependimento pela ferramenta (097). Sem banco: textos, validações antes da transação,
// recusa sem a 097 e SQL da migration. O fluxo completo roda em arrependimento-097.postgres.test.ts.
const M = { protocolo: 'KA-20261023-ABCDEFGH', solicitadoEm: '2026-10-23T13:05:00.000Z' };
const agora = () => new Date().toISOString();
const sessao = (autenticadoEm = agora()) => ({ id: 's', usuario_id: '00000000-0000-4000-8000-000000000001', nome: 'Gestão', cargo: null, papel: 'REPRESENTANTE_AUTORIZADO' as const,
    autenticado_em: autenticadoEm, consultado_em: agora(), expira_em: '', csrf_hash: '' });
const CHAVE = '6f1c2a34-1b2c-4d5e-8f90-123456789abc';
/** Transação falsa: responde só a consulta de instalação; qualquer outra consulta falha (prova que não chegou lá). */
function deps(instalado: boolean, papel = 'REPRESENTANTE_AUTORIZADO'): DepsArrependimento & { consultas: string[] } {
    const consultas: string[] = [];
    const tx = { query: async (sql: string) => {
        consultas.push(sql);
        if (sql.includes("to_regclass('public.assinatura_arrependimentos')")) return { rows: [{ ok: instalado }], rowCount: 1 };
        throw new Error('consulta inesperada: ' + sql.slice(0, 40));
    } };
    const tenant = { empresaComprovada: '00000000-0000-4000-8000-0000000000aa', membershipId: 'm', usuarioId: 'u', papelAtual: papel };
    return { consultas, withTenantTransaction: async (_s, _e, t) => t(tx as never, tenant as never), withTransaction: async (t) => t(tx as never), env: {}, enviarEmail: null };
}
async function codigo(p: Promise<unknown>) { try { await p; return 'OK'; } catch (e) { return (e as { code?: string }).code ?? (e as Error).message; } }

test('protocolo KA-: formato próprio, distinto do KM- da devolução', () => {
    assert.match(M.protocolo, PROTOCOLO_ARREPENDIMENTO);
    assert.doesNotMatch('KM-20261023-ABCDEFGH', PROTOCOLO_ARREPENDIMENTO);
    assert.doesNotMatch('KA-20261023-ABCDEFGI', PROTOCOLO_ARREPENDIMENTO, 'sem I/L/O/U (Crockford)');
});

test('confirmação à Gestão: protocolo, hora de Brasília, registro ≠ deferimento e canal; HTML escapado', () => {
    const m = mensagemConfirmacaoArrependimento('gestao@exemplo.test', 'Buffet <Alegria>', M);
    assert.equal(m.para, 'gestao@exemplo.test');
    assert.equal(m.assunto, 'Kidmais Manager — arrependimento registrado, protocolo KA-20261023-ABCDEFGH');
    assert.match(m.texto, /Registrado em 23\/10\/2026,? 10:05 \(horário de Brasília\)/);
    // Revisão 8da88ba (P2-C2): confirma o REGISTRO; análise e restituição só quando cabível, sem prometer deferimento.
    assert.match(m.texto, /Este e-mail confirma o registro do pedido/);
    assert.match(m.texto, /vai analisá-lo e, quando cabível, comunicar o intermediador de pagamento e providenciar a restituição/);
    assert.doesNotMatch(m.texto, /Vamos providenciar a restituição|imediatamente/);
    assert.match(m.texto, /contato@demerzellabs\.com\.br, informando o protocolo/);
    assert.match(m.html, /Buffet &lt;Alegria&gt;/); assert.doesNotMatch(m.html, /<Alegria>/);
    assert.equal(m.idempotencia, 'arrependimento:KA-20261023-ABCDEFGH');
});

test('aviso interno: [AÇÃO HOJE], prazo imediato, informativos; sem nome, e-mail ou documento', () => {
    for (const [dentro, provedor, esperado] of [[true, true, /dentro de 7 dias.*provedor configurado/], [false, false, /mais de 7 dias.*provedor indisponível/],
        [null, true, /sem data de contratação confirmada/]] as const) {
        const m = mensagemAvisoArrependimento('plataforma@exemplo.test', { ...M, dentroDe7Dias: dentro, provedorDisponivel: provedor });
        assert.match(m.assunto, /^\[AÇÃO HOJE\] Kidmais Manager — arrependimento KA-20261023-ABCDEFGH$/);
        assert.match(m.texto, esperado); assert.match(m.texto, /Prazo: IMEDIATO/); assert.match(m.texto, /Informativo \(não decide\)/);
        assert.doesNotMatch(m.texto, /@|Buffet|\d{11,14}/);
        assert.equal(m.idempotencia, 'arrependimento-interno:KA-20261023-ABCDEFGH');
    }
});

test('registro: confirmação, chave e senha recente conferidas ANTES de abrir a transação', async () => {
    const d = deps(true);
    assert.equal(await codigo(registrarArrependimento(sessao(), null, { chave: CHAVE }, { requestId: 'r' }, d)), 'DADOS_INVALIDOS');
    assert.equal(await codigo(registrarArrependimento(sessao(), null, { chave: 'nao-uuid', confirmar: true }, { requestId: 'r' }, d)), 'DADOS_INVALIDOS');
    assert.equal(await codigo(registrarArrependimento(sessao(new Date(Date.now() - 600_000).toISOString()), null, { chave: CHAVE, confirmar: true }, { requestId: 'r' }, d)), 'REAUTENTICACAO');
    assert.deepEqual(d.consultas, []);
});

test('sem a 097: consulta indica o canal oficial; registro recusado com ARREPENDIMENTO_INDISPONIVEL (503); Equipe recusada', async () => {
    assert.deepEqual(await consultarArrependimento(sessao(), null, deps(false)), { instalado: false, canalOficial: 'contato@demerzellabs.com.br', manifestacoes: [] });
    const d = deps(false);
    await assert.rejects(registrarArrependimento(sessao(), null, { chave: CHAVE, confirmar: true }, { requestId: 'r' }, d),
        (e: { code?: string; status?: number; message?: string }) => e.code === 'ARREPENDIMENTO_INDISPONIVEL' && /contato@demerzellabs\.com\.br/.test(e.message ?? ''));
    assert.equal(await codigo(consultarArrependimento(sessao(), null, deps(true, 'OPERADOR'))), 'COBRANCA_SEM_PERMISSAO');
    assert.equal(await codigo(registrarArrependimento(sessao(), null, { chave: CHAVE, confirmar: true }, { requestId: 'r' }, deps(true, 'OPERADOR'))), 'COBRANCA_SEM_PERMISSAO');
});

test('atendimento sem a 097 ou sem valor na restituição: recusa antes de escrever', async () => {
    const d = deps(false);
    const tx = { query: async (sql: string) => { d.consultas.push(sql); return { rows: [{ ok: sql.includes('to_regclass') ? false : true }], rowCount: 1 }; } };
    assert.equal(await codigo(registrarComunicacaoIntermediador(tx as never, { empresaId: 'e', protocolo: M.protocolo, referencia: 'Asaas' })), 'ARREPENDIMENTO_INDISPONIVEL');
    const instalado = { query: async () => ({ rows: [{ ok: true }], rowCount: 1 }) };
    for (const valorCentavos of [null, 0, -1, 1.5])
        assert.equal(await codigo(concluirArrependimento(instalado as never, { empresaId: 'e', protocolo: M.protocolo, usuarioId: 'u', situacao: 'RESTITUIDO', referencia: 'estorno', valorCentavos })), 'DADOS_INVALIDOS');
});

test('e-mail de conclusão: restituição com valor, sem referência interna; não se aplica com a justificativa', async () => {
    const { mensagemConclusaoArrependimento } = await import('./arrependimento.ts');
    const r = mensagemConclusaoArrependimento('gestao@exemplo.test', 'Buffet', { protocolo: M.protocolo, situacao: 'RESTITUIDO', valorRestituidoCentavos: 19_700, justificativa: 'nota interna' });
    assert.equal(r.assunto, 'Kidmais Manager — resultado do pedido de arrependimento, protocolo KA-20261023-ABCDEFGH');
    assert.match(r.texto, /restituição de R\$\s?197,00 foi solicitada ao intermediador/);
    assert.doesNotMatch(r.texto, /nota interna/);
    assert.equal(r.idempotencia, 'arrependimento-conclusao:KA-20261023-ABCDEFGH');
    // P3-N1: o efeito no acesso só aparece quando é o real.
    assert.doesNotMatch(r.texto, /somente leitura|permanece ativa/, 'sem efeito informado: nada sobre o acesso');
    const enc = mensagemConclusaoArrependimento('g@exemplo.test', 'B', { protocolo: M.protocolo, situacao: 'RESTITUIDO', valorRestituidoCentavos: 1, justificativa: null, efeito: 'ENCERRADO' });
    assert.match(enc.texto, /período contratado foi encerrado; a área do sistema fica disponível em somente leitura/);
    const mantida = mensagemConclusaoArrependimento('g@exemplo.test', 'B', { protocolo: M.protocolo, situacao: 'RESTITUIDO', valorRestituidoCentavos: 1, justificativa: null, efeito: 'CONTRATACAO_ATUAL_MANTIDA' });
    assert.match(mantida.texto, /A contratação atual permanece ativa\./); assert.doesNotMatch(mantida.texto, /somente leitura/);
    const sem = mensagemConclusaoArrependimento('g@exemplo.test', 'B', { protocolo: M.protocolo, situacao: 'RESTITUIDO', valorRestituidoCentavos: 1, justificativa: null, efeito: 'SEM_ALTERACAO' });
    assert.doesNotMatch(sem.texto, /somente leitura|permanece ativa/);
    const n = mensagemConclusaoArrependimento('gestao@exemplo.test', 'Buffet', { protocolo: M.protocolo, situacao: 'NAO_APLICAVEL', valorRestituidoCentavos: null, justificativa: 'Pedido retirado pelo cliente <b>' });
    assert.match(n.texto, /Resultado: não se aplica\. Motivo: Pedido retirado pelo cliente/);
    assert.match(n.html, /&lt;b&gt;/);
    assert.match(n.texto, /contato@demerzellabs\.com\.br/);
});

test('registro pelo atendimento: e-mail, texto e data conferidos antes de consultar o banco', async () => {
    const { registrarArrependimentoAtendimento } = await import('./arrependimento.ts');
    const consultas: string[] = [];
    const tx = { query: async (sql: string) => { consultas.push(sql); return { rows: [{ ok: true }], rowCount: 1 }; } };
    const base = { empresaId: 'e', atendenteId: 'u', chave: CHAVE, emailSolicitante: 'gestao@exemplo.test', recebidoEm: '2026-10-23T10:00:00-03:00', referencia: 'E-mail de 23/10 10h' };
    for (const errado of [{ chave: 'x' }, { emailSolicitante: 'sem-arroba' }, { referencia: 'oi' }, { recebidoEm: '23/10/2026' }, { recebidoEm: '2026-10-23T10:00' }])
        assert.equal(await codigo(registrarArrependimentoAtendimento(tx as never, { ...base, ...errado })), 'DADOS_INVALIDOS', JSON.stringify(errado));
    assert.deepEqual(consultas, []);
});

test('097 (texto): só cria a tabela, guarda própria, down recusa com dados, sem tocar tabelas existentes', () => {
    const up = readFileSync('database/migrations/20261023_097_assinatura_arrependimentos.sql', 'utf8');
    const down = readFileSync('database/rollback/20261023_097_assinatura_arrependimentos_down.sql', 'utf8');
    assert.match(up, /^BEGIN;$/m); assert.match(up, /^COMMIT;$/m);
    assert.doesNotMatch(up, /ALTER TABLE|^s*UPDATE |INSERT INTO|DELETE FROM/im);
    assert.match(up, /CREATE TABLE assinatura_arrependimentos/);
    assert.match(up, /BEFORE INSERT OR UPDATE OR DELETE ON assinatura_arrependimentos/);
    assert.match(down, /097 rollback recusado: já há manifestação/);
    assert.doesNotMatch(down, /empresa_assinaturas|usuarios_administrativos/);
});
