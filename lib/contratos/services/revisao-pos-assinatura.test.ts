import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { analisarRevisao } from './alteracoes.ts';
import { hashSnapshotContrato } from './snapshot-core.ts';
import type { ContratoSnapshotV1 } from '../repositories/models';

const nativeRequire = createRequire(import.meta.url);
function carregar(path: string, mocks: Record<string, unknown>): Record<string, (...args: never[]) => unknown> {
    const exports = {};
    const code = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    new Function('require', 'exports', code)((name: string) => {
        if (name in mocks) return mocks[name];
        if (['zod','node:crypto'].includes(name)) return nativeRequire(name);
        return {};
    }, exports);
    return exports;
}
const base = {
    schemaVersao: 1, fechamento: { id: 'f', status: 'CONTRATO_ASSINADO' },
    contratante: { clienteId: 'cliente-a', nomeCompleto: 'Cliente sintético' },
    evento: { data: '2026-09-19', horarioInicio: '11:00', horarioFim: '15:00', convidados: 50, pacote: { id: 'p', nome: 'Pacote' } },
    comercial: { valorFinalContrato: 8091, formaPagamentoPretendida: 'PIX_AVISTA' },
} as ContratoSnapshotV1;
test('diferenças reais de data, convidados e valor preservam ambos os snapshots', () => {
    const antes = JSON.stringify(base), depois = structuredClone(base);
    depois.evento.data = '2026-09-26'; depois.evento.convidados = 60; depois.comercial.valorFinalContrato = 9200;
    const r = analisarRevisao(base, depois);
    assert.equal(r.natureza, 'MATERIAL'); assert(r.exigeNovaAssinatura && r.alteraAgenda && r.impactoFinanceiro);
    assert.deepEqual(r.campos.map(d => [d.campo,d.antes,d.depois]), [['evento.data','2026-09-19','2026-09-26'],['evento.convidados',50,60],['comercial.valorFinalContrato',8091,9200]]);
    assert.equal(JSON.stringify(base), antes);
});
test('retificação exclusivamente documental continua exigindo dupla assinatura', () => {
    const r = analisarRevisao(base, { ...base, documental: { observacoes: 'Correção textual sintética' } } as ContratoSnapshotV1);
    assert.equal(r.natureza, 'DOCUMENTAL'); assert(r.exigeNovaAssinatura); assert(!r.impactoFinanceiro);
});
test('troca de identidade com mesmo nome é material; metadados de preparação não são conteúdo', () => {
    assert.equal(analisarRevisao(base, { ...base, contratante: { ...base.contratante, clienteId: 'outro' } }).natureza, 'MATERIAL');
    assert.equal(analisarRevisao(base, { ...base, revisaoOperacional: { id: 'nova' }, fechamento: { ...base.fechamento, status: 'CONFIRMADO' } } as ContratoSnapshotV1).natureza, 'SEM_ALTERACOES');
});

const chave = '11111111-1111-4111-8111-111111111111';
function ambiente() {
    const origem = { id: 'v1', contratoId: 'c', numeroVersao: 1, status: 'ASSINADA', snapshot: structuredClone(base), snapshotHash: hashSnapshotContrato(base) };
    const versoes = [origem];
    const fluxo = { versao_vigente_id: 'v1', versao_em_preparacao_id: null as string | null };
    const edicoes: Record<string, { estado: string; revisao: number }> = { v1: { estado: 'CONCLUIDA', revisao: 1 } };
    let pedido: Record<string, unknown> | null = null, contratoStatus = 'ASSINADO';
    const queries: string[] = [];
    const tx = { query: async (sql: string, values: unknown[] = []) => {
        queries.push(sql);
        let rows: unknown[] = [];
        if (sql.startsWith('SELECT id,fechamento_id,status')) rows = [{ id: 'c', fechamento_id: 'f', status: contratoStatus }];
        else if (sql.startsWith('SELECT status FROM contratos')) rows = [{ status: contratoStatus }];
        else if (sql.startsWith('SELECT * FROM contrato_fluxos')) rows = [fluxo];
        else if (sql.startsWith('SELECT * FROM contrato_edicoes')) rows = [edicoes[String(values[0])]];
        else if (sql.includes('WHERE r.chave_criacao=')) rows = pedido && values[0] === chave ? [pedido] : [];
        else if (sql.startsWith('SELECT max(numero_versao)')) rows = [{ n: versoes.length + 1 }];
        else if (sql.startsWith('SELECT id FROM usuarios_administrativos')) rows = [{ id: 'u' }];
        else if (sql.startsWith('INSERT INTO contrato_edicoes')) edicoes[String(values[0])] = { estado: 'EM_ELABORACAO', revisao: 1 };
        else if (sql.startsWith('INSERT INTO contrato_fluxos')) fluxo.versao_em_preparacao_id = String(values[1]);
        else if (sql.startsWith('UPDATE contrato_versoes SET snapshot=')) {
            const v = versoes.find(v => v.id === values[0])!; v.snapshot = values[1] as ContratoSnapshotV1; v.snapshotHash = String(values[2]);
        } else if (!sql.includes('FOR UPDATE')) throw Error(`SQL inesperado: ${sql}`);
        return { rows };
    } };
    const schema = carregar('lib/fechamentos/services/edicao-administrativa-schema.ts', {});
    const mod = carregar('lib/contratos/services/administrativo.service.ts', {
        '../../db/postgres': { withTransaction: async (fn: (t: typeof tx) => unknown) => fn(tx) },
        '../../autenticacao/service': { consultarSessao: async () => ({ usuario_id: 'u' }) },
        '../../fechamentos/services/edicao-administrativa-schema': schema,
        './snapshot-core': { hashSnapshotContrato }, './errors': { ContratoServiceError: class extends Error { constructor(_code: string, message: string) { super(message); } } },
        '../repositories': {
            buscarVersaoPorId: async (id: string) => versoes.find(v => v.id === id),
            criarContratoVersao: async (input: typeof origem) => { const v = { ...input, id: 'v2', status: 'ATIVA' }; versoes.push(v); return v; },
        },
        '../../fechamentos/repositories/revisao.repository': { buscarRevisaoDaVersao: async () => null },
        '../../fechamentos/services/revisao-operacional.service': {
            iniciarPreparacao: async () => ({ id: 'r' }), snapshotPreparacao: async (_tx: unknown, _r: unknown, v: typeof origem) => v.snapshot,
        },
        '../../clientes/repositories': {
            registrarAuditoria: async (r: { acao: string; dadosDepois: { motivo: string; tipo: string } }) => {
                if (r.acao === 'CONTRATO_NOVA_VERSAO') pedido = { contrato_versao_id: 'v2', versao_base_id: 'v1', criado_por_usuario_id: 'u', pedido_motivo: r.dadosDepois.motivo, tipo: r.dadosDepois.tipo };
            }, registrarEventoHistorico: async () => {},
        },
    });
    const operar = mod.operarContrato as unknown as (id: string, body: object, token: string, context: object) => Promise<{ versaoId: string; reutilizado?: boolean }>;
    const criar = (extra: object = {}) => operar('v1', { acao: 'nova_versao', tipo: 'RETIFICACAO', motivo: 'Correção solicitada', chaveCriacao: chave, ...extra }, 'sessao-sintetica', { requestId: chave });
    return { criar, operar, fluxo, versoes, edicoes, queries, cancelarContrato: () => { contratoStatus = 'CANCELADO'; } };
}
test('nova revisão inicia elaboração, preserva V1/hash e mantém vigência/Festa/agenda', async () => {
    const a = ambiente(), original = JSON.stringify(a.versoes[0]);
    assert.equal((await a.criar()).versaoId, 'v2');
    assert.equal(a.edicoes.v2.estado, 'EM_ELABORACAO'); assert.equal(a.fluxo.versao_vigente_id, 'v1');
    assert.equal(a.fluxo.versao_em_preparacao_id, 'v2'); assert.equal(JSON.stringify(a.versoes[0]), original);
    assert(a.queries.some(s => s === 'SELECT id FROM contratos WHERE id=$1 FOR UPDATE'));
    assert(!a.queries.some(s => /(?:UPDATE|DELETE FROM|INSERT INTO) (?:festas|fechamentos|pagamentos|contrato_documentos|contrato_assinaturas)\b/.test(s)));
});
test('motivo obrigatório recusa antes de consultar ou criar versão', async () => {
    const a = ambiente(); await assert.rejects(a.criar({ motivo: ' ' })); assert.equal(a.queries.length, 0);
});
test('retry mesma chave reutiliza versão e dupla intenção encontra preparação única', async () => {
    const a = ambiente(); await a.criar(); assert((await a.criar()).reutilizado);
    assert((await a.criar({ chaveCriacao: '22222222-2222-4222-8222-222222222222' })).reutilizado);
    assert.equal(a.versoes.length, 2);
    await assert.rejects(a.criar({ motivo: 'Outra intenção' }), /outro pedido/);
});
test('contrato cancelado não permite criar revisão', async () => {
    const a = ambiente(); a.cancelarContrato(); await assert.rejects(a.criar(), /cancelada/); assert.equal(a.versoes.length, 1);
});
test('edição documental direta da versão assinada é recusada antes de escrita', async () => {
    const a = ambiente(); await assert.rejects(a.operar('v1', { acao: 'salvar', revisao: 1, observacoesDocumentais: 'Tentativa' }, 'sintetico', {}), /não pode ser editada/);
    assert(!a.queries.some(s => s.startsWith('UPDATE')));
});
test('preparação congelada não permite outra criação com chave nova', async () => {
    const a = ambiente(); await a.criar(); a.edicoes.v2.estado = 'AGUARDANDO_CLIENTE';
    await assert.rejects(a.criar({ chaveCriacao: '22222222-2222-4222-8222-222222222222' }), /congelada/);
    assert((await a.criar()).reutilizado);
});
test('constraints existentes garantem chave e preparação únicas; 019 conserva Festa por contrato', () => {
    const sql = readFileSync('database/migrations/20260909_014_revisao_operacional.sql', 'utf8');
    assert.match(sql, /UNIQUE\(chave_criacao\)/); assert.match(sql, /CREATE UNIQUE INDEX fechamento_revisoes_aberta_uk/);
    const festa = readFileSync('lib/festas/formalizacao.ts', 'utf8');
    assert.match(festa, /if \(ativa\) return \{ festaId: ativa.id, reutilizado: true \}/);
});
test('UX expõe criação, motivo, comparação, acesso às assinaturas e chave estável', () => {
    const ui = readFileSync('components/admin/ContratoAdmin.tsx', 'utf8');
    for (const text of ['Criar revisão / retificação','Editar dados desta revisão','pedidoRevisao.current.chave','operacaoEmCurso.current=true','v.motivo_nova_versao','origem.numero_versao','analise.impactoFinanceiro','comprovante_documento_id','Histórico de versões']) assert(ui.includes(text), text);
    assert.match(ui, /documentos.filter\(d => d.contrato_versao_id === vid\)/);
    assert.match(ui, /assinaturas.filter\(s => s.contrato_versao_id === vid\)/);
    assert.match(ui, /revisaoOperacional.ocupa_vigente/);
    assert.match(readFileSync('lib/contratos/services/administrativo.service.ts','utf8'), /kidmais019_ocupa\(f.id\) AS ocupa_vigente/);
});

test('conflito no destino impede aplicação; cancelamento da revisão conserva ocupação vigente', async () => {
    const f = { id: 'f', dataEvento: '2026-09-19', status: 'CONTRATO_ASSINADO' };
    const r = { id: 'r', fechamento_id: 'f', contrato_id: 'c', contrato_versao_id: 'v2', estado: 'CONGELADA', hold_destino_adquirido_em: 'sintetico', operacao: { clienteId: 'cl', dataEvento: '2026-09-26', horarioInicio: '11:00', horarioFim: '15:00', configuracaoAgendaId: 'cfg' } };
    let livre = false, aplicacoes = 0;
    const sqls: string[] = [];
    const tx = { query: async (sql: string) => { sqls.push(sql); return { rows: sql.includes(' AS ocupa') ? [{ ocupa: true }] : [] }; } };
    const mod = carregar('lib/fechamentos/services/revisao-operacional.service.ts', {
        '../repositories': { buscarFechamentoPorId: async () => f, buscarFechamentoPorIdParaAtualizacao: async () => f },
        '../repositories/revisao.repository': { aplicarOperacaoPreparada: async () => { aplicacoes++; } },
        '../../disponibilidade/services': { consultarDisponibilidadeData: async () => ({ periodos: [{ configuracaoId: 'cfg', horarios: [{ status: livre ? 'DISPONIVEL' : 'OCUPADO', inicio: '11:00', fim: '15:00' }] }] }) },
        '../../clientes/repositories': { registrarAuditoria: async () => {} },
        './errors': { FechamentoServiceError: class extends Error { constructor(_code: string, message: string) { super(message); } } },
    });
    const concluir = mod.concluirPreparacao as unknown as (tx: object, r: object, c: object) => Promise<void>;
    await assert.rejects(concluir(tx,r,{ usuarioId: null }), /indisponível/);
    assert.equal(aplicacoes, 0); assert.equal(f.dataEvento, '2026-09-19');
    livre = true; await concluir(tx,r,{ usuarioId: null }); assert.equal(aplicacoes, 1);
    const cancelar = mod.cancelarPreparacao as unknown as (tx: object, r: object, c: object, motivo: string) => Promise<void>;
    await cancelar(tx,r,{ usuarioId: 'u' },'Desistência da proposta');
    assert.equal(f.dataEvento, '2026-09-19');
    assert(!sqls.some(sql => /UPDATE (?:festas|fechamentos|pagamentos)\b/.test(sql)));
    assert(!sqls.some(sql => /SET versao_vigente_id/.test(sql)));
});

test('impacto financeiro registra pendência sem alterar recebimentos ou obrigação reconhecida', async () => {
    const sqls: string[] = [];
    const p = { pagamento: { id: 'pg' }, reconhecida: { id: 'v1', snapshot: base }, posicao: { obrigacao: 809100n }, futuro: [], pendencias: [], ajustes: [] };
    const mod = carregar('lib/pagamentos/services/pendencias-financeiras.service.ts', {
        '../repositories/alteracao-financeira.repository': { lerPosicaoFinanceira: async () => p },
        '../../contratos/services/snapshot-core': { hashSnapshotContrato },
        './alteracao-financeira-core': { reaisCentavos: (n: number) => BigInt(Math.round(n * 100)) },
    });
    const tx = { query: async (sql: string) => { sqls.push(sql); return { rows: sql.startsWith('SELECT p.id') ? [{ id: 'pg' }] : [] }; } };
    const detectar = mod.detectarPendenciasFinanceiras as unknown as (tx: object, v: object, anterior: string) => Promise<void>;
    await detectar(tx,{ id: 'v2', contratoId: 'c', snapshot: { ...base, comercial: { ...base.comercial, valorFinalContrato: 9200 } } },'v1');
    assert(sqls.some(s => s.startsWith('INSERT INTO contrato_pendencias_financeiras')));
    assert(!sqls.some(s => /(?:UPDATE|DELETE|INSERT INTO) (?:pagamentos|recebimentos|estornos)\b/.test(s)));
    assert.equal(p.posicao.obrigacao,809100n);
});

test('promoção atualiza ponteiro no mesmo fluxo; Festa lê versão vigente e conserva identidade', () => {
    const publico = readFileSync('lib/contratos/services/contrato-publico.service.ts','utf8');
    assert(publico.indexOf('await bloquearAgendaFormalizacao(tx, contrato.id);') < publico.indexOf('const versaoAssinada = await marcarVersaoContratoAssinada'));
    assert.match(publico,/await garantirFestaFormalizada\(tx, contrato.id, versaoAssinada.id, context\)/);
    const fluxo = readFileSync('lib/contratos/services/fluxo-publico.ts','utf8');
    assert(fluxo.indexOf('await concluirPreparacao(tx,preparacao') < fluxo.indexOf('SET versao_vigente_id=$2'));
    assert.match(readFileSync('lib/festas/service.ts','utf8'), /JOIN contrato_versoes v ON v.id=cf.versao_vigente_id/);
});
