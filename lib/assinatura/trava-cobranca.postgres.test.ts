import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import pg, { type Client } from 'pg';
import { conectarDescartavel, encerrarDescartavel, portaDescartavel, senhaRecusada } from '../comercial/postgres-descartavel.ts';
import { carregarModulo } from '../acessos/teste-carregador.ts';
import { condicoesComerciais } from './planos-comerciais.ts';
import { CATALOGO_VIGENTE } from '../creditos/catalogo.ts';
import { versaoVigente } from '../cadastro/documentos-legais.ts';
import { empresaFundador, hojeBanco, inserir, somar, usuarioSintetico } from './renovacao-109-apoio.postgres.test-apoio.ts';
import { cobrancaDestravada } from './trava-cobranca.ts';

/**
 * B-25 no PostgreSQL DESCARTÁVEL, modelo 109, com LINHA PRESENTE (assinatura ativa, renovação AVISADA, aviso ENVIADO).
 *
 * Fixture e rodada 2 da revisão: o usuário tem concessão de desenvolvedor, para o caminho aberto ir além da autorização.
 *
 *   1. em quatro retratos de production e um ambiente não reconhecido, cada entrada C1 e cada ponto guardado recusa, com L1
 *      satisfeita de propósito. Prova de recusa em três camadas: o código e o log vêm da guarda; a sequência SQL da entrada é
 *      só a leitura do banco e o fim da transação (nada antes, nada depois, nem DML revertido); auditoria, e-mail, limite,
 *      agendamento e provedor são espiões e não são chamados;
 *   2. a fotografia compara o conteúdo final das tabelas de `public`. Não mede tentativa, estado intermediário nem efeito
 *      externo: isso é o papel da sequência SQL e dos espiões;
 *   3. controles abertos (staging e local): a entrada leu o banco na guarda, seguiu adiante e terminou no resultado de domínio
 *      esperado para ela. Erro genérico, SQLSTATE ou outro código reprovam;
 *   4. leituras fora da guarda, em production: exigem sucesso e o conteúdo esperado do retorno;
 *   5. webhooks: 503 no caminho guardado, enquanto autenticação, corpo inválido e evento que não é de falha mantêm as respostas;
 *   6. banco chamado de verdade `kidmais_production`, vazio, sem nenhuma variável de production: todas as entradas e os dois
 *      webhooks recusam antes de tocar tabela. Só este teste prova o nome real; os demais simulam sinais no banco descartável;
 *   7. a função POST da rota de cadastro, com `after` observado. É a função chamada direto, não o servidor Next em execução.
 */
type Fn = (...args: never[]) => Promise<never>;
const req = (f: string) => carregarModulo(f, { 'db/postgres': { db: () => client, withTransaction } }, cache) as Record<string, Fn>;
const cache = new Map<string, Record<string, unknown>>();
let client: Client;

/** Nos controles cada entrada roda dentro de um BEGIN externo, desfeito no fim: todas partem da mesma fixture. */
let isolado = false;
async function withTransaction<T>(work: (tx: Client) => Promise<T>): Promise<T> {
    if (isolado) {
        await client.query('SAVEPOINT b25');
        try { const r = await work(client); await client.query('RELEASE SAVEPOINT b25'); return r; }
        catch (error) { await client.query('ROLLBACK TO SAVEPOINT b25'); throw error; }
    }
    await client.query('BEGIN');
    try { const r = await work(client); await client.query('COMMIT'); return r; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
}

process.env.ADMIN_AUTH_SECRET = `segredo-sintetico-de-teste-${'x'.repeat(24)}`;
const PROD = 'srv-dak77m2d0e5s73b8rkkg';
const STG = 'srv-daif418ae00c73e8k2gg';
const TOKEN = 'token-webhook-de-teste-com-32-caracteres!';
const CHAVE_RESEND = randomBytes(32);
const SEGREDO_RESEND = `whsec_${CHAVE_RESEND.toString('base64')}`;
/** L1 ligada de propósito: o que se prova é a L2. */
const L1 = {
    CADASTRO_PUBLICO_ATIVO: 'true', USUARIOS_CRIACAO_DIRETA: 'desativada', EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 'simulado-no-teste', EMAIL_REMETENTE: 'iA.Fest <naoresponda@example.test>',
    ASSINATURA_PLANOS_ATIVOS: 'true', CREDITOS_CATALOGO_ATIVO: 'true', CREDITOS_COMPRA_ATIVA: 'true', ASSINATURA_CONTINUIDADE_ATIVA: 'true',
    ASAAS_AMBIENTE: 'sandbox', ASAAS_API_KEY: '$aact_hmlg_000000000000000000000000chave', ASAAS_WEBHOOK_TOKEN: TOKEN, RESEND_WEBHOOK_SECRET: SEGREDO_RESEND,
    CREDITOS_CATALOGO_APROVADO: CATALOGO_VIGENTE.versao,
};
/** Catálogo com aprovação sintética: sem isto a L1 recusaria a compra em production antes de a L2 ser exercitada. */
const CATALOGO_APROVADO = { ...CATALOGO_VIGENTE, aprovacao: { referencia: 'prova-sintetica-b25', em: '2026-11-06' } };
const VARIAVEIS = [...Object.keys(L1), 'RENDER', 'RENDER_SERVICE_ID', 'KIDMAIS_DEPLOY_ENV'];
const CENARIOS: Array<{ nome: string; env: Record<string, string> }> = [
    { nome: 'serviço de production rotulado como staging', env: { RENDER: 'true', RENDER_SERVICE_ID: PROD, KIDMAIS_DEPLOY_ENV: 'staging' } },
    { nome: 'production declarado', env: { RENDER: 'true', RENDER_SERVICE_ID: PROD, KIDMAIS_DEPLOY_ENV: 'production', ASAAS_AMBIENTE: 'producao', ASAAS_API_KEY: '$aact_prod_000000000000000000000000chave' } },
    { nome: 'serviço de production sem declaração', env: { RENDER: 'true', RENDER_SERVICE_ID: PROD } },
    { nome: 'deploy production, sem serviço nem Render', env: { KIDMAIS_DEPLOY_ENV: 'production', ASAAS_AMBIENTE: 'producao', ASAAS_API_KEY: '$aact_prod_000000000000000000000000chave' } },
    { nome: 'ambiente não reconhecido', env: { RENDER: 'true', RENDER_SERVICE_ID: 'srv-outro', KIDMAIS_DEPLOY_ENV: 'homologacao' } },
];
const ABERTOS: Array<{ nome: string; env: Record<string, string> }> = [
    { nome: 'staging declarado', env: { RENDER: 'true', RENDER_SERVICE_ID: STG, KIDMAIS_DEPLOY_ENV: 'staging' } },
    { nome: 'execução local', env: {} },
];

async function comAmbiente<T>(env: Record<string, string>, acao: () => Promise<T>): Promise<T> {
    const guardado = new Map(VARIAVEIS.map((k) => [k, process.env[k]]));
    for (const k of VARIAVEIS) delete process.env[k];
    Object.assign(process.env, L1, env);
    try { return await acao(); }
    finally {
        for (const [k, v] of guardado) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

/** Hash do conteúdo final das tabelas de `public`. Linha revertida na transação não aparece aqui: ver a sequência SQL. */
async function fotografia() {
    const tabelas = (await client.query<{ t: string }>("SELECT quote_ident(tablename) AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")).rows.map((r) => r.t);
    const partes: Record<string, string> = {};
    for (const t of tabelas)
        partes[t] = (await client.query<{ h: string }>(`SELECT md5(coalesce(string_agg(x::text, ',' ORDER BY x::text), '')) AS h FROM public.${t} x`)).rows[0].h;
    return partes;
}

async function capturandoAvisos<T>(acao: () => Promise<T>) {
    const avisos: string[] = [];
    const original = console.warn;
    console.warn = (...a: unknown[]) => { avisos.push(a.map(String).join(' ')); };
    try { return { r: await acao(), avisos }; }
    finally { console.warn = original; }
}

const ids: Record<string, string> = {};
const sessao = () => { const agora = new Date().toISOString(); return { usuario_id: ids.usuario, autenticado_em: agora, consultado_em: agora } as never; };
const ctx = () => ({ requestId: randomUUID(), ip: null, userAgent: 'teste' }) as never;
const tenant = () => ({ empresaComprovada: ids.empresa, membershipId: 'm', usuarioId: ids.usuario, papelAtual: 'REPRESENTANTE_AUTORIZADO' });
/** Espiões: tudo o que uma recusa não pode tentar. Na recusa a lista tem de ficar vazia. */
const efeitos: string[] = [];
const provedorFalso = new Proxy({}, { get: (_a, nome) => (nome === 'then' ? undefined : async () => { efeitos.push('provedor'); throw Object.assign(new Error('provedor falso alcançado'), { code: 'PROVEDOR_FALSO_ALCANCADO' }); }) });
const provedor = () => provedorFalso as never;
const espiaEmail = async () => { efeitos.push('email'); return { provedor: 'arquivo', idExterno: null }; };
const espiaAuditoria = async () => { efeitos.push('auditoria'); };
const depsTenant = () => ({
    withTenantTransaction: (_s: unknown, _e: unknown, t: (tx: Client, te: unknown) => Promise<unknown>) => withTransaction((tx) => t(tx, tenant())),
    withTransaction, provedor, travarContratacao: async (_e: unknown, t: () => Promise<unknown>) => t(), consumirLimite: async () => { efeitos.push('limite'); return true; }, enviarEmail: espiaEmail, catalogo: CATALOGO_APROVADO,
}) as never;
const depsPainel = () => ({ withTransaction, registrarAuditoria: espiaAuditoria, provedor, enviarEmail: espiaEmail }) as never;
const depsCadastro = () => ({ withTransaction, registrarAuditoria: espiaAuditoria, criarHashSenha: (carregarModulo('lib/autenticacao/senha.ts', {}, new Map()) as unknown as { criarHashSenha: unknown }).criarHashSenha, enviarEmail: espiaEmail, gerarToken: () => randomBytes(32).toString('base64url') }) as never;

/** Registro de todo SQL do cliente, para provar a posição da guarda e a ausência de tentativa depois da recusa. */
const LEITURA_BANCO = 'SELECT current_database() AS banco';
const CONTROLE_TX = /^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i;
let sqls: string[] = [];
function registrarSql(c: Client) {
    const original = c.query.bind(c) as (...a: unknown[]) => unknown;
    (c as unknown as { query: unknown }).query = (...a: unknown[]) => {
        sqls.push(typeof a[0] === 'string' ? a[0] : String((a[0] as { text?: string })?.text ?? ''));
        return original(...a);
    };
}
const sqlDeDominio = () => sqls.filter((s) => !CONTROLE_TX.test(s.trim()));
function assertSoGuarda(nome: string) {
    assert.deepEqual(sqlDeDominio(), [LEITURA_BANCO], `${nome}: SQL além da guarda`);
    assert.deepEqual(efeitos, [], `${nome}: efeito tentado`);
}
const uuid = () => randomUUID();
const motivo = 'Prova sintética da trava';
const KM = 'KM-20261106-ABCDEFGH';
const KA = 'KA-20261106-ABCDEFGH';

const OPERACOES_COMERCIAIS: Array<Record<string, unknown>> = [
    { operacao: 'iniciar-teste', dias: 5, motivo },
    { operacao: 'estender-teste', dias: 5, motivo },
    { operacao: 'conceder-excecao', tipo: 'CORTESIA', dias: 5, motivo },
    { operacao: 'revogar-excecao', excecaoId: uuid(), motivo },
    { operacao: 'registrar-continuidade', tipo: 'RETIFICACAO', documentoNovo: '11222333000181', nomeNovo: 'Novo Nome', instrumento: 'Instrumento', evidencias: 'Evidências', dataEfetiva: '2026-11-06', motivo },
    { operacao: 'concluir-continuidade', continuidadeId: uuid(), motivo },
    { operacao: 'arrependimento-registrar', chave: uuid(), emailSolicitante: 'gestao@example.test', recebidoEm: '2026-11-06T10:00:00Z', referencia: 'Mensagem recebida', motivo },
    { operacao: 'arrependimento-comunicar', protocolo: KA, referencia: 'Ref 1', motivo },
    { operacao: 'arrependimento-concluir', protocolo: KA, situacao: 'NAO_APLICAVEL', referencia: 'Ref 12345', motivo },
    { operacao: 'recuperar-vinculo', assinaturaId: 'sub_123', motivo },
];
const OPERACOES_CREDITOS: Array<Record<string, unknown>> = [
    { acao: 'cortesia', empresaId: 'EMPRESA', campanha: 'piloto', quantidade: 1, motivo, chave: uuid() },
    { acao: 'concluir_devolucao', protocolo: KM, referencia: 'Ref 1' },
    { acao: 'devolucao_atendimento', empresaId: 'EMPRESA', pedido: KM, tipo: 'ARREPENDIMENTO_7_DIAS', valorEsperadoCentavos: 100, chave: uuid() },
    { acao: 'reprocessar_pedido', protocolo: KM },
    { acao: 'resolver_revisao', protocolo: KM, resultado: 'ENCERRAR', referencia: 'Ref 1' },
    { acao: 'concluir_cobranca_extra', pagamentoId: 'pay_1', referencia: 'Ref 1' },
    { acao: 'resolver_bloqueio', pagamentoId: 'pay_1', resultado: 'CANCELAR', referencia: 'Ref 1' },
];

type Entrada = { nome: string; ponto: string; chamar: () => Promise<unknown> };
function entradas(): Entrada[] {
    const comercial = req('lib/desenvolvedor/comercial.ts');
    const creditos = req('lib/desenvolvedor/creditos.ts');
    const cobrancaPainel = req('lib/desenvolvedor/cobranca.ts');
    const cadastro = req('lib/cadastro/publico.ts');
    const arrependimento = req('lib/assinatura/arrependimento.ts');
    const cobranca = req('lib/assinatura/cobranca.ts');
    const devolucao = req('lib/assinatura/devolucao.ts');
    const compra = req('lib/creditos/compra.ts');
    const devolucaoCreditos = req('lib/creditos/devolucao.ts');
    const f = (fn: Fn, ...a: unknown[]) => (fn as unknown as (...x: unknown[]) => Promise<unknown>)(...a);
    const docs = { termosVersao: versaoVigente('TERMOS_USO').versao, privacidadeVersao: versaoVigente('PRIVACIDADE').versao, aceiteTermos: true, aceitePrivacidade: true };
    const oferta = CATALOGO_VIGENTE.ofertas[0];
    const lista: Entrada[] = [
        { nome: 'POST /api/cadastro (rota, antes do after)', ponto: 'POST /api/cadastro', chamar: () => f(cadastro.exigirPedidoCadastroDestravado, withTransaction) },
        { nome: 'processamento do pedido de cadastro', ponto: 'processarPedidoCadastro', chamar: () => f(cadastro.processarPedidoCadastro,
            { nome: 'Pessoa', email: `p${randomBytes(3).toString('hex')}@example.test`, senha: 'senha-forte-123', confirmacao: 'senha-forte-123', ...docs }, ctx(), depsCadastro()) },
        { nome: 'POST /api/cadastro/empresa', ponto: 'cadastrarEmpresa', chamar: () => f(cadastro.cadastrarEmpresa, sessao(),
            { chave: uuid(), cnpj: '11222333000181', razaoSocial: 'Alegria Festas Ltda', nomeFantasia: 'Buffet Alegria', telefone: '(11) 98888-0069', qualificacao: 'RESPONSAVEL_INDICADO',
                socios: [{ nome: 'Sócia Fundadora', qualificacao: 'SOCIO_ADMINISTRADOR' }], ...docs }, ctx(), depsCadastro()) },
        ...OPERACOES_COMERCIAIS.map((op) => ({ nome: `operarComercial ${op.operacao}`, ponto: 'operarComercial', chamar: () => f(comercial.operarComercial, sessao(), ids.empresa, op, ctx(), depsPainel()) })),
        ...OPERACOES_CREDITOS.map((op) => ({ nome: `operarCreditos ${op.acao}`, ponto: 'operarCreditos',
            chamar: () => f(creditos.operarCreditos, sessao(), op.empresaId ? { ...op, empresaId: ids.empresa } : op, ctx(), depsPainel(), () => ({ provedor: provedorFalso, ambiente: 'sandbox', conta: 'conta-sintetica' })) })),
        { nome: 'POST .../cobranca', ponto: 'sincronizarCobrancaEmpresa', chamar: () => f(cobrancaPainel.sincronizarCobrancaEmpresa, sessao(), ids.empresa, ctx(), depsPainel()) },
        { nome: 'POST .../cobranca/pendencias', ponto: 'liberarIntencaoCobranca', chamar: () => f(cobrancaPainel.liberarIntencaoCobranca, sessao(), ids.empresa, { pendenciaId: uuid(), confirmacao: 'CONFERI_NO_PROVEDOR_QUE_NAO_FOI_CRIADA', motivo: 'Motivo sintético da liberação' }, ctx(), depsPainel()) },
        { nome: 'POST /api/admin/assinatura/arrependimento', ponto: 'registrarArrependimento', chamar: () => f(arrependimento.registrarArrependimento, sessao(), null, { chave: uuid(), confirmar: true, motivo }, ctx(), depsTenant()) },
        { nome: 'POST /api/admin/assinatura/cancelamento', ponto: 'cancelarAssinatura', chamar: () => f(cobranca.cancelarAssinatura, sessao(), null, { confirmar: true, chave: uuid(), motivo }, ctx(), depsTenant()) },
        { nome: 'POST /api/admin/assinatura/checkout, plano', ponto: 'iniciarAssinatura', chamar: () => f(cobranca.iniciarAssinatura, sessao(), null,
            { plano: 'essencial', ciclo: 'MENSAL', valorEsperadoCentavos: 11820, versao: condicoesComerciais.versao }, ctx(), depsTenant()) },
        { nome: 'POST /api/admin/assinatura/checkout, legado', ponto: 'iniciarAssinatura', chamar: () => f(cobranca.iniciarAssinatura, sessao(), null, { ciclo: 'MENSAL' }, ctx(), depsTenant()) },
        { nome: 'POST /api/admin/assinatura/devolucao', ponto: 'solicitarEncerramento', chamar: () => f(devolucao.solicitarEncerramento, sessao(), null,
            { tipo: 'ENCERRAMENTO_ANUAL_PROPORCIONAL', confirmar: true, chave: uuid(), valorEsperadoCentavos: 100, motivo }, ctx(), depsTenant()) },
        { nome: 'POST /api/admin/creditos', ponto: 'criarPedido', chamar: () => f(compra.criarPedido, sessao(), null,
            { oferta: oferta.codigo, forma: 'PIX', confirmar: true, termosVersao: CATALOGO_VIGENTE.termos.versao, precoEsperadoCentavos: oferta.precoCentavos, chave: uuid() }, depsTenant()) },
        { nome: 'POST /api/admin/creditos/devolucao', ponto: 'solicitarDevolucao', chamar: () => f(devolucaoCreditos.solicitarDevolucao, sessao(), null,
            { pedido: KM, tipo: 'ARREPENDIMENTO_7_DIAS', confirmar: true, valorEsperadoCentavos: 100, chave: uuid() }, depsTenant()) },
    ];
    return lista;
}

/** Erro sem código de domínio nunca se confunde com resultado esperado. */
async function resultado(p: Promise<unknown>) {
    try { await p; return 'OK'; }
    catch (e) {
        const { code, name } = e as { code?: string; name?: string };
        if (typeof code === 'string' && /^[A-Z][A-Z_]+$/.test(code)) return code;
        return `GENERICO:${code ?? name ?? 'desconhecido'}`;
    }
}

// Webhooks.
const bounce = (id: string) => ({ type: 'email.bounced', data: { email_id: id } });
function pedidoResend(corpoObj: unknown, svixId: string, assinatura?: string) {
    const corpo = typeof corpoObj === 'string' ? corpoObj : JSON.stringify(corpoObj);
    const carimbo = String(Math.floor(Date.now() / 1000));
    return new Request('http://teste.local/api/integracoes/resend/webhook', { method: 'POST', body: corpo, headers: {
        'content-type': 'application/json', 'svix-id': svixId, 'svix-timestamp': carimbo,
        'svix-signature': assinatura ?? `v1,${createHmac('sha256', CHAVE_RESEND).update(`${svixId}.${carimbo}.${corpo}`).digest('base64')}`,
    } });
}
const resend = (req2: Request, tx = withTransaction as never) => (carregarModulo('lib/assinatura/renovacao-entrega.ts', { 'db/postgres': { db: () => client, withTransaction } }, cache) as unknown as
    { receberWebhookResend: (r: Request, d: unknown) => Promise<Response> }).receberWebhookResend(req2, { env: process.env, withTransaction: tx });
const pedidoAsaas = (token: string | null) => new Request('http://teste.local/api/integracoes/asaas/webhook', { method: 'POST',
    body: JSON.stringify({ id: `evt_${randomBytes(4).toString('hex')}`, event: 'PAYMENT_RECEIVED', payment: { id: 'pay_1', subscription: 'sub_1' } }),
    headers: { 'content-type': 'application/json', ...(token ? { 'asaas-access-token': token } : {}) } });
const asaas = (req2: Request, tx = withTransaction as never) => (carregarModulo('lib/assinatura/webhook-asaas.ts', { 'db/postgres': { db: () => client, withTransaction } }, cache) as unknown as
    { receberWebhookAsaas: (r: Request, d: unknown) => Promise<Response> }).receberWebhookAsaas(req2, { env: process.env, ip: '198.51.100.7', withTransaction: tx,
    consumirLimite: async () => { efeitos.push('limite'); return true; },
    agendar: () => { efeitos.push('agendamento'); } });

test.before(async () => {
    client = await conectarDescartavel();
    registrarSql(client);
    const [email, senha] = usuarioSintetico();
    ids.usuario = (await client.query<{ id: string }>("INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Gestão B-25', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id", [email, senha])).rows[0].id;
    await client.query("INSERT INTO plataforma_desenvolvedores (usuario_id, concedido_por, motivo) VALUES ($1, 'Teste B-25', 'Concessão sintética da prova B-25')", [ids.usuario]);
    const e = await empresaFundador(client, ids.usuario);
    ids.empresa = e.empresaId;
    const hoje = await hojeBanco(client);
    // Renovação AVISADA.
    const renovacao = await inserir(client, e, { pdr: somar(hoje, 40), pv: somar(hoje, -325) });
    await client.query("UPDATE assinatura_renovacoes SET estado = 'AVISANDO', aviso_tentado_em = clock_timestamp() WHERE id = $1", [renovacao]);
    await client.query("UPDATE assinatura_renovacoes SET estado = 'AVISADA', aviso_enviado_em = clock_timestamp(), aviso_id_externo = 'email_renovacao_b25' WHERE id = $1", [renovacao]);
    ids.renovacao = renovacao;
    // Aviso ENVIADO.
    const aviso = randomUUID();
    await client.query(`INSERT INTO assinatura_avisos (id, empresa_id, tipo, marco, destinatario_id, mensagem) VALUES ($1::uuid, $2::uuid, 'SUSPENSO', clock_timestamp(), $3::uuid, $4::jsonb)`,
        [aviso, e.empresaId, ids.usuario, JSON.stringify({ para: 'x@avisos.test', assunto: 'a', texto: 't', html: 'h', idempotencia: `kidmais-aviso-assinatura/${aviso}` })]);
    await client.query("UPDATE assinatura_avisos SET estado = 'ENVIANDO', tentado_em = clock_timestamp() WHERE id = $1", [aviso]);
    await client.query("UPDATE assinatura_avisos SET estado = 'ENVIADO', enviado_em = clock_timestamp(), id_externo = 'email_aviso_b25' WHERE id = $1", [aviso]);
    ids.aviso = aviso;
});
test.after(async () => { if (client) await encerrarDescartavel(client); });

for (const cenario of CENARIOS) {
    test(`${cenario.nome}: toda entrada C1 e todo ponto guardado recusam, sem mudança e sem provedor`, async () => {
        await comAmbiente(cenario.env, async () => {
            const antes = await fotografia();
            for (const entrada of entradas()) {
                sqls = []; efeitos.length = 0;
                const { r, avisos } = await capturandoAvisos(() => resultado(entrada.chamar()));
                assert.equal(r, 'COBRANCA_TRAVADA', entrada.nome);
                assert.ok(avisos.some((a) => a.startsWith(`[trava cobrança] recusa em ${entrada.ponto}:`)), `${entrada.nome}: a recusa veio da guarda`);
                assertSoGuarda(entrada.nome);
            }
            assert.deepEqual(await fotografia(), antes, 'nenhuma tabela mudou');
        });
    });

    test(`${cenario.nome}: webhook do Resend, callback e reentrega autenticados, com renovação AVISADA e aviso ENVIADO`, async () => {
        await comAmbiente(cenario.env, async () => {
            const antes = await fotografia();
            for (const externo of ['email_renovacao_b25', 'email_aviso_b25']) {
                for (const repeticao of ['callback', 'reentrega']) {
                    sqls = []; efeitos.length = 0;
                    const { r, avisos } = await capturandoAvisos(() => resend(pedidoResend(bounce(externo), `msg_${externo}`)));
                    assert.equal(r.status, 503, `${externo} ${repeticao}: nunca 2xx`);
                    assert.ok(avisos.some((a) => a.startsWith('[trava cobrança] recusa em webhook Resend:')));
                    assertSoGuarda(`Resend ${externo} ${repeticao}`);
                }
            }
            // Fora do caminho guardado as respostas continuam as de antes.
            assert.equal((await resend(pedidoResend(bounce('email_renovacao_b25'), 'msg_a', 'v1,AAAA'))).status, 401, 'autenticação');
            assert.equal((await resend(pedidoResend('{nao-json', 'msg_b'))).status, 400, 'corpo inválido');
            const ignorado = await resend(pedidoResend({ type: 'email.delivered', data: { email_id: 'email_aviso_b25' } }, 'msg_c'));
            assert.equal(ignorado.status, 200, 'evento que não é de falha');
            assert.deepEqual(await ignorado.json(), { recebido: true, resultado: 'IGNORADO' });
            assert.deepEqual(await fotografia(), antes, 'sem mudança de linha nem auditoria');
        });
    });

    test(`${cenario.nome}: webhook do Asaas recusa com 503, sem INSERT, com token válido e inválido`, async () => {
        await comAmbiente(cenario.env, async () => {
            const antes = await fotografia();
            for (const token of [TOKEN, 'token-errado', null]) {
                sqls = []; efeitos.length = 0;
                const { r, avisos } = await capturandoAvisos(() => asaas(pedidoAsaas(token)));
                assert.equal(r.status, 503, String(token));
                assert.ok(avisos.some((a) => a.startsWith('[trava cobrança] recusa em webhook Asaas:')), 'a recusa veio da guarda, não de L1');
                assertSoGuarda(`Asaas ${String(token)}`);
            }
            assert.deepEqual(await fotografia(), antes, 'sem evento, sem limite, sem auditoria de recusa');
        });
    });
}

test('banco chamado de verdade kidmais_production, sem nenhuma variável de production: recusa antes de tocar tabela', async () => {
    // Criar banco copia arquivos e pode passar do prazo de 30 s do conector numa máquina ocupada; o prazo vale para o resto.
    await client.query('SET statement_timeout = 0');
    await client.query('DROP DATABASE IF EXISTS kidmais_production');
    await client.query('CREATE DATABASE kidmais_production TEMPLATE template0');
    await client.query("SET statement_timeout = '30s'");
    const c = new pg.Client({ host: '127.0.0.1', port: portaDescartavel(), user: 'kidmais_descartavel', database: 'kidmais_production', password: senhaRecusada, application_name: 'kidmais-descartavel' });
    await c.connect();
    registrarSql(c);
    const principal = client;
    try {
        const naTransacao = (async <T>(w: (tx: pg.Client) => Promise<T>) => {
            await c.query('BEGIN');
            try { const r = await w(c); await c.query('COMMIT'); return r; }
            catch (e) { await c.query('ROLLBACK'); throw e; }
        }) as never;
        await comAmbiente({}, async () => {
            const { r } = await capturandoAvisos(() => cobrancaDestravada(c, 'prova do nome', process.env));
            assert.equal(r, false);
            // O banco está vazio: qualquer SQL além da guarda estouraria em tabela inexistente, e a sequência também o mostraria.
            client = c;
            for (const entrada of entradas()) {
                sqls = []; efeitos.length = 0;
                const { r: codigo, avisos } = await capturandoAvisos(() => resultado(entrada.chamar()));
                assert.equal(codigo, 'COBRANCA_TRAVADA', entrada.nome);
                assert.ok(avisos.some((a) => a.endsWith('BANCO_PRODUCTION.')), `${entrada.nome}: motivo`);
                assertSoGuarda(entrada.nome);
            }
            client = principal;
            for (const chamar of [() => resend(pedidoResend(bounce('email_renovacao_b25'), 'msg_nome'), naTransacao), () => asaas(pedidoAsaas(TOKEN), naTransacao)]) {
                sqls = []; efeitos.length = 0;
                assert.equal((await capturandoAvisos(chamar)).r.status, 503);
                assertSoGuarda('webhook no banco de nome real');
            }
            const q = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'");
            assert.equal(q.rows[0].n, 0);
        });
    }
    finally {
        client = principal;
        await c.end();
        await client.query('SET statement_timeout = 0');
        await client.query('DROP DATABASE IF EXISTS kidmais_production');
        await client.query("SET statement_timeout = '30s'");
    }
});

/**
 * Resultado de domínio de cada entrada no caminho aberto, com a fixture desta suíte. Cada valor foi conferido contra o código:
 * ver a tabela no pacote de revisão. Mudança aqui é mudança do que a prova afirma.
 */
const ESPERADO_ABERTO: Record<string, string> = {
    'POST /api/cadastro (rota, antes do after)': 'OK',
    'processamento do pedido de cadastro': 'OK',
    'POST /api/cadastro/empresa': 'OK',
    'operarComercial iniciar-teste': 'CONFLITO',
    'operarComercial estender-teste': 'CONFLITO',
    'operarComercial conceder-excecao': 'OK',
    'operarComercial revogar-excecao': 'NAO_ENCONTRADO',
    'operarComercial registrar-continuidade': 'OK',
    'operarComercial concluir-continuidade': 'CONFLITO',
    'operarComercial arrependimento-registrar': 'DADOS_INVALIDOS',
    'operarComercial arrependimento-comunicar': 'CONFLITO',
    'operarComercial arrependimento-concluir': 'CONFLITO',
    'operarComercial recuperar-vinculo': 'CONFLITO',
    'operarCreditos cortesia': 'CONFLITO',
    'operarCreditos concluir_devolucao': 'NAO_ENCONTRADO',
    'operarCreditos devolucao_atendimento': 'NAO_ENCONTRADO',
    'operarCreditos reprocessar_pedido': 'CONFLITO',
    'operarCreditos resolver_revisao': 'CONFLITO',
    'operarCreditos concluir_cobranca_extra': 'CONFLITO',
    'operarCreditos resolver_bloqueio': 'CONFLITO',
    'POST .../cobranca': 'PROVEDOR_FALSO_ALCANCADO',
    'POST .../cobranca/pendencias': 'CONFLITO',
    'POST /api/admin/assinatura/arrependimento': 'OK',
    'POST /api/admin/assinatura/cancelamento': 'COBRANCA_RESULTADO_INCERTO',
    'POST /api/admin/assinatura/checkout, plano': 'DOCUMENTOS_ATUALIZADOS',
    'POST /api/admin/assinatura/checkout, legado': 'PROVEDOR_FALSO_ALCANCADO',
    'POST /api/admin/assinatura/devolucao': 'PROVEDOR_FALSO_ALCANCADO',
    'POST /api/admin/creditos': 'CONFLITO',
    'POST /api/admin/creditos/devolucao': 'NAO_ENCONTRADO',
};
for (const aberto of ABERTOS) {
    test(`controle, ${aberto.nome}: cada entrada lê o banco, passa da guarda e chega ao resultado de domínio esperado`, async () => {
        await comAmbiente(aberto.env, async () => {
            const divergencias: unknown[] = [];
            for (const entrada of entradas()) {
                await client.query('BEGIN');
                isolado = true; sqls = []; efeitos.length = 0;
                const { r, avisos } = await capturandoAvisos(() => resultado(entrada.chamar()));
                const dominio = sqlDeDominio();
                isolado = false;
                await client.query('ROLLBACK');
                const soGuarda = entrada.ponto === 'POST /api/cadastro';
                if (r !== ESPERADO_ABERTO[entrada.nome]) divergencias.push({ entrada: entrada.nome, obtido: r, esperado: ESPERADO_ABERTO[entrada.nome] });
                if (avisos.some((a) => a.startsWith('[trava cobrança]'))) divergencias.push({ entrada: entrada.nome, log: 'recusa da trava' });
                if (dominio[0] !== LEITURA_BANCO) divergencias.push({ entrada: entrada.nome, primeiroSql: dominio[0] ?? null });
                if (!soGuarda && dominio.length < 2) divergencias.push({ entrada: entrada.nome, semPassoSeguinte: true });
            }
            assert.deepEqual(divergencias, []);
        });
    });
}

test('leituras fora da guarda, em production: simular_corte e pendências', async () => {
    await comAmbiente(CENARIOS[1].env, async () => {
        const antes = await fotografia();
        const creditos = req('lib/desenvolvedor/creditos.ts');
        const painel = req('lib/desenvolvedor/cobranca.ts');
        const f = (fn: Fn, ...a: unknown[]) => (fn as unknown as (...x: unknown[]) => Promise<unknown>)(...a);
        sqls = []; efeitos.length = 0;
        const simular = await capturandoAvisos(() => f(creditos.operarCreditos, sessao(), { acao: 'simular_corte', empresaId: ids.empresa }, ctx(), depsPainel()));
        const s = simular.r as unknown as { elegivel: boolean; motivo: string | null; jaCortada: boolean };
        assert.deepEqual([s.elegivel, s.motivo, s.jaCortada], [true, null, false], 'simular_corte: conteúdo');
        assert.deepEqual(simular.avisos.filter((a) => a.startsWith('[trava cobrança]')), []);
        assert.ok(!sqls.includes(LEITURA_BANCO), 'simular_corte: não passa pela guarda');
        assert.deepEqual(efeitos, [], 'simular_corte: efeito');
        sqls = []; efeitos.length = 0;
        const pendencias = await capturandoAvisos(() => f(painel.pendenciasCobrancaEmpresa, sessao(), ids.empresa, depsPainel()));
        assert.deepEqual(pendencias.r, [], 'pendências: a fixture não tem pendência aberta');
        assert.deepEqual(pendencias.avisos.filter((a) => a.startsWith('[trava cobrança]')), []);
        assert.ok(!sqls.includes(LEITURA_BANCO), 'pendências: não passa pela guarda');
        assert.ok(sqls.some((q) => q.includes('FROM cobranca_eventos')), 'pendências: chegou à consulta');
        assert.deepEqual(efeitos, [], 'pendências: efeito');
        assert.deepEqual(await fotografia(), antes);
    });
});

test('controle do Resend: fora de production a mesma falha volta a registrar (renovação e aviso)', async () => {
    await comAmbiente(ABERTOS[0].env, async () => {
        const r1 = await resend(pedidoResend(bounce('email_renovacao_b25'), 'msg_ctrl_1'));
        assert.equal(r1.status, 200);
        assert.equal((await r1.json() as { resultado: string }).resultado, 'REVISAO_REGISTRADA');
        assert.equal((await client.query<{ estado: string }>('SELECT estado FROM assinatura_renovacoes WHERE id = $1', [ids.renovacao])).rows[0].estado, 'REVISAO');
        const r2 = await resend(pedidoResend(bounce('email_aviso_b25'), 'msg_ctrl_2'));
        assert.equal(r2.status, 200);
        assert.equal((await client.query<{ estado: string }>('SELECT estado FROM assinatura_avisos WHERE id = $1', [ids.aviso])).rows[0].estado, 'DEVOLVIDO');
    });
});

function rotaCadastro(espiaAfter: (f: () => unknown) => void) {
    return carregarModulo('app/api/cadastro/route.ts', {
        'db/postgres': { db: () => client, withTransaction },
        'next/server': { after: espiaAfter, NextResponse: { json: (b: unknown, i?: ResponseInit) => Response.json(b, i) } },
        'lib/http/admin-crm-api': { verificarOrigem: () => ({}) },
    }, new Map()) as unknown as { POST: (r: unknown) => Promise<Response> };
}
const pedidoRota = () => Object.assign(new Request('http://teste.local/api/cadastro', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nome: 'Pessoa', email: `r${randomBytes(3).toString('hex')}@example.test`, senha: 'senha-forte-123', confirmacao: 'senha-forte-123',
        termosVersao: versaoVigente('TERMOS_USO').versao, privacidadeVersao: versaoVigente('PRIVACIDADE').versao, aceiteTermos: true, aceitePrivacidade: true }) }), { cookies: { get: () => undefined } });

test('rota POST /api/cadastro: em production recusa antes do after(); em execução local responde 202 e agenda uma vez', async () => {
    let agendados = 0;
    const rota = rotaCadastro(() => { agendados += 1; });
    await comAmbiente(CENARIOS[1].env, async () => {
        const antes = await fotografia();
        sqls = []; efeitos.length = 0;
        const { r, avisos } = await capturandoAvisos(() => rota.POST(pedidoRota()));
        assert.equal(r.status, 503, 'rota: status na recusa');
        assert.equal((await r.json() as { codigo?: string }).codigo, 'COBRANCA_TRAVADA', 'rota: código');
        assert.ok(avisos.some((a) => a.startsWith('[trava cobrança] recusa em POST /api/cadastro:')), 'rota: a recusa veio da guarda');
        assert.equal(agendados, 0, 'rota: after na recusa');
        assertSoGuarda('rota');
        assert.deepEqual(await fotografia(), antes);
    });
    await comAmbiente({}, async () => {
        const r = await rota.POST(pedidoRota());
        assert.equal(r.status, 202, 'rota: caminho aberto');
        assert.equal(agendados, 1, 'rota: after no caminho aberto');
    });
});
