import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { criarEnviarEmail, type MensagemEmail } from '../acessos/email.ts';
import { criarClienteAsaas, ASAAS_SANDBOX_URL, type ConfiguracaoAsaas } from './asaas.ts';

const config: ConfiguracaoAsaas = { ambiente:'sandbox', baseUrl:ASAAS_SANDBOX_URL, apiKey:'$aact_hmlg_sintetica', webhookToken:'x'.repeat(40) };
const mensagem: MensagemEmail = { para:'gestor@example.invalid', assunto:'Aviso sintético', texto:'Texto sintético', html:'<p>Texto sintético</p>', idempotencia:'kidmais-renovacao/sintetica' };

test('adapter atualiza valor futuro sem reprificar pendentes; suspensão nunca reativa', async () => {
    const requests: { url:string; method:string | undefined; body: unknown }[] = [];
    const c = criarClienteAsaas(config,{ fetch:async (url,init) => {
        const body = JSON.parse(init.body as string); requests.push({ url,method:init.method,body });
        return Response.json({ id:'sub_1', value:197, status:body.status ?? 'ACTIVE', nextDueDate:'2027-10-09' });
    } });
    assert.equal((await c.atualizarValorAssinatura('sub_1',19700)).valorCentavos,19700);
    await c.suspenderGeracao('sub_1');
    assert.deepEqual(requests.map(x => x.body),[{ value:197, updatePendingPayments:false },{ status:'INACTIVE', updatePendingPayments:false }]);
    assert.ok(requests.every(x => x.method === 'PUT' && x.url === `${ASAAS_SANDBOX_URL}/subscriptions/sub_1`));
});

test('adapter de parcela preserva vencimento e forma, recusa paga e valor fracionário', async () => {
    const requests: unknown[] = [];
    const c = criarClienteAsaas(config,{ fetch:async (_url,init) => {
        const body = JSON.parse(init.body as string); requests.push(body);
        return Response.json({ id:'pay_2',status:'PENDING',dueDate:body.dueDate,value:body.value,billingType:body.billingType,customer:'cus_1',subscription:'sub_1' });
    } });
    const p = { id:'pay_2',status:'PENDING',dueDate:'2027-10-09',paymentDate:null,invoiceUrl:null,deleted:false,billingType:'PIX' };
    const r = await c.atualizarValorCobranca(p,19700);
    assert.equal(r.clienteId,'cus_1'); assert.equal(r.assinaturaId,'sub_1'); assert.equal(r.valorCentavos,19700);
    assert.deepEqual(requests,[{ value:197,dueDate:'2027-10-09',billingType:'PIX' }]);
    await assert.rejects(c.atualizarValorCobranca({ ...p,status:'RECEIVED' },19700));
    await assert.rejects(c.atualizarValorCobranca(p,19700.1));
    assert.equal(requests.length,1);
});

test('lista truncada falha em vez de omitir parcelas; nenhuma mutação após leitura incompleta', async () => {
    const c = criarClienteAsaas(config,{ fetch:async () => Response.json({ data:[],hasMore:true }) });
    await assert.rejects(c.listarCobrancasDaAssinatura('sub_1'),/RESPOSTA_INVALIDA/);
});

test('Resend recebe idempotência estável no header e corpo idêntico; fetch é inteiramente mockado', async () => {
    const requests: RequestInit[] = [];
    const enviar = criarEnviarEmail({ EMAIL_PROVIDER:'resend',RESEND_API_KEY:'sintetica',EMAIL_REMETENTE:'avisos@example.invalid' },async (_url,init) => {
        requests.push(init!); return Response.json({ id:'email_sintetico' });
    });
    await enviar(mensagem); await enviar(mensagem);
    assert.equal(new Headers(requests[0].headers).get('Idempotency-Key'),mensagem.idempotencia);
    assert.equal(requests[0].body,requests[1].body);
    assert.equal((JSON.parse(requests[0].body as string) as { to:string[] }).to[0],mensagem.para);
    await assert.rejects(enviar({ ...mensagem,idempotencia:'../\r\nheader' }));
    assert.equal(requests.length,2);
});

test('e-mail em arquivo produz uma evidência por chave e recusa reuso com outro conteúdo', async () => {
    const raiz = path.resolve(tmpdir());
    const dir = await mkdtemp(path.join(raiz,'kidmais-renovacao-email-'));
    try {
        const enviar = criarEnviarEmail({ EMAIL_PROVIDER:'arquivo',EMAIL_ARQUIVO_DIR:dir,NODE_ENV:'test' });
        const a = await enviar(mensagem), b = await enviar(mensagem);
        assert.equal(a.idExterno,b.idExterno);
        const arquivos = await readdir(dir); assert.equal(arquivos.length,1);
        assert.equal(JSON.parse(await readFile(path.join(dir,arquivos[0]),'utf8')).para,mensagem.para);
        await assert.rejects(enviar({ ...mensagem,texto:'Outro conteúdo' }),/conteúdo diferente/);
    } finally {
        const alvo = path.resolve(dir);
        if (!alvo.startsWith(`${raiz}${path.sep}kidmais-renovacao-email-`)) throw new Error('Diretório temporário inesperado.');
        await rm(alvo,{ recursive:true,force:true });
    }
});
