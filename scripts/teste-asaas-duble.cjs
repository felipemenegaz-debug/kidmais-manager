/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * SOMENTE TESTE LOCAL (E2E de scripts/assinatura-devolucao-ui.cjs): carregado com `node --require` no `next dev`, troca o
 * fetch global para https://api-sandbox.asaas.com/v3 por um dublê em memória (estado e chamadas num arquivo JSON indicado
 * em KIDMAIS_TESTE_ASAAS_DUBLE). Qualquer outro endereço do Asaas é recusado (nenhuma chamada sai da máquina).
 * Recusado em deploy reconhecido (RENDER, KIDMAIS_DEPLOY_ENV) e com NODE_ENV=production.
 * Cobre só o que o encerramento usa: GET da assinatura e das cobranças, DELETE da assinatura e POST do estorno; e, para os
 * créditos de IA (scripts/creditos-ui.cjs), a cobrança avulsa: POST /payments, GET /payments/{id} e GET /payments?externalReference=.
 */
const fs = require('node:fs');

const arquivo = process.env.KIDMAIS_TESTE_ASAAS_DUBLE;
if (arquivo) {
    if (process.env.RENDER || process.env.KIDMAIS_DEPLOY_ENV || process.env.NODE_ENV === 'production')
        throw new Error('dublê do Asaas recusado fora do teste local');
    const original = globalThis.fetch;
    const BASE = 'https://api-sandbox.asaas.com/v3';
    const responder = (corpo, status = 200) => new Response(corpo === null ? '' : JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } });
    globalThis.fetch = async (entrada, init = {}) => {
        const url = typeof entrada === 'string' ? entrada : entrada instanceof URL ? entrada.href : entrada.url;
        if (!url.startsWith(`${BASE}/`)) {
            if (/asaas\.com/i.test(url)) throw new Error('rede do Asaas bloqueada no teste local');
            return original(entrada, init);
        }
        const estado = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
        const caminho = new URL(url).pathname.slice('/v3'.length);
        const metodo = String(init.method ?? 'GET').toUpperCase();
        estado.chamadas.push(`${metodo} ${caminho}`);
        let m;
        let resposta = responder(null, 404);
        if (metodo === 'GET' && (m = caminho.match(/^\/subscriptions\/([^/]+)\/payments$/)))
            resposta = responder({ data: estado.cobrancas[m[1]] ?? [], hasMore: false });
        else if (metodo === 'GET' && (m = caminho.match(/^\/subscriptions\/([^/]+)$/)) && estado.assinaturas[m[1]])
            resposta = responder({ ...estado.assinaturas[m[1]], ...(estado.assinaturas[m[1]].deleted ? { status: 'INACTIVE' } : {}) });
        else if (metodo === 'DELETE' && estado.perderRemocao)
            resposta = responder({ errors: [] }, 500); // 5xx: resultado incerto para quem chama (nada removido)
        else if (metodo === 'DELETE' && (m = caminho.match(/^\/subscriptions\/([^/]+)$/)) && estado.assinaturas[m[1]]) {
            estado.assinaturas[m[1]].deleted = true;
            resposta = responder({ deleted: true, id: m[1] });
        }
        // Créditos de IA (095): cobrança avulsa (POST /payments), leitura por id e listagem pela referência externa.
        else if (metodo === 'POST' && caminho === '/payments') {
            const corpo = JSON.parse(String(init.body ?? '{}'));
            estado.avulsas = estado.avulsas ?? {};
            estado.postsAvulsa = (estado.postsAvulsa ?? 0) + 1;
            if (estado.recusarAvulsa) resposta = responder({ errors: [{ code: 'invalid_value' }] }, 400);
            else {
                const id = `pay_av_${estado.postsAvulsa}`;
                estado.avulsas[id] = { id, status: 'PENDING', dueDate: corpo.dueDate, value: corpo.value, customer: corpo.customer, billingType: corpo.billingType,
                    externalReference: corpo.externalReference, description: corpo.description, invoiceUrl: `https://sandbox.asaas.com/i/av${estado.postsAvulsa}`, deleted: false };
                resposta = estado.perderAvulsa ? responder({ errors: [] }, 500) : responder(estado.avulsas[id]);
            }
        }
        else if (metodo === 'GET' && caminho === '/payments') {
            const ref = new URL(url).searchParams.get('externalReference');
            resposta = responder({ data: Object.values(estado.avulsas ?? {}).filter((c) => c.externalReference === ref), hasMore: false });
        }
        else if (metodo === 'GET' && (m = caminho.match(/^\/payments\/([^/]+)$/)) && estado.avulsas?.[m[1]])
            resposta = responder(estado.avulsas[m[1]]);
        else if (metodo === 'POST' && (m = caminho.match(/^\/payments\/([^/]+)\/refund$/))) {
            const corpo = JSON.parse(String(init.body ?? '{}'));
            estado.estornos.push({ id: m[1], value: corpo.value, description: corpo.description });
            resposta = responder({ id: m[1], status: 'RECEIVED', refunds: [{ status: 'PENDING', value: corpo.value, description: corpo.description }] });
        }
        fs.writeFileSync(arquivo, JSON.stringify(estado, null, 2));
        return resposta;
    };
}
