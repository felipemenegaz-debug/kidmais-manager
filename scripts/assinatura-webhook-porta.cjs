/* eslint-disable @typescript-eslint/no-require-imports */
// Porta de entrada exclusiva para homologação. Nunca apontar o túnel para o Next.
const http = require('node:http');
const { createHash, timingSafeEqual } = require('node:crypto');
const ROTA = '/api/integracoes/asaas/webhook';
const LIMITE = 64 * 1024;

function criarPorta({ token, destino = 'http://127.0.0.1:3195', encaminhar = fetch }) {
    if (typeof token !== 'string' || token.length < 32 || token.length > 255)
        throw Error('TOKEN_INVALIDO');
    // Destino fechado: não aceita URLs fornecidas pelo callback ou outros serviços locais.
    if (destino !== 'http://127.0.0.1:3195') throw Error('DESTINO_INVALIDO');
    const hash = v => createHash('sha256').update(v).digest();
    const esperado = hash(token);
    const servidor = http.createServer(async (req, res) => {
        const responder = status => {
            if (!res.headersSent) res.writeHead(status, { 'Cache-Control': 'no-store', Connection: 'close' });
            res.end();
        };
        if (req.url !== ROTA) return responder(404);
        if (req.method !== 'POST') return responder(405);
        const recebido = req.headers['asaas-access-token'];
        if (typeof recebido !== 'string' || recebido.length > 1024 || !timingSafeEqual(hash(recebido), esperado))
            return responder(401);
        if ((req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json')
            return responder(415);
        const tamanho = req.headers['content-length'];
        if (tamanho && (!/^\d+$/.test(tamanho) || Number(tamanho) > LIMITE)) return responder(413);
        const partes = [];
        let total = 0;
        let expirou = false;
        const timer = setTimeout(() => { expirou = true; responder(408); req.destroy(); }, 3000);
        try {
            for await (const parte of req) {
                total += parte.length;
                if (total > LIMITE) return responder(413);
                partes.push(parte);
            }
            clearTimeout(timer);
            if (expirou) return;
            const corpo = Buffer.concat(partes);
            try { JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(corpo)); }
            catch { return responder(400); }
            // Somente estes headers seguem ao app; cookies, origem e IP declarados são descartados.
            const resposta = await encaminhar(destino + ROTA, {
                method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
                headers: { 'content-type': 'application/json', 'asaas-access-token': token }, body: corpo,
            });
            await resposta.body?.cancel();
            // Apenas 200 confirma persistência. Não transformar redirecionamento/erro em sucesso.
            responder(resposta.status === 200 ? 200 : 503);
        } catch { if (!expirou) responder(503); }
        finally { clearTimeout(timer); }
    });
    servidor.headersTimeout = 5000;
    servidor.requestTimeout = 5000;
    servidor.maxHeadersCount = 30;
    servidor.maxConnections = 20;
    return servidor;
}

module.exports = { criarPorta, ROTA };
if (require.main === module) {
    if (process.env.ASAAS_AMBIENTE !== 'sandbox' || process.env.KIDMAIS_WEBHOOK_HOMOLOGACAO !== 'autorizada') {
        console.error('Exige sandbox e autorização de homologação.'); process.exitCode = 1;
    } else {
        try {
            const servidor = criarPorta({ token: process.env.ASAAS_WEBHOOK_TOKEN });
            servidor.on('error', () => { console.error('Porta de homologação indisponível.'); process.exitCode = 1; });
            servidor.listen(3196, '127.0.0.1', () => console.log('Entrada isolada pronta em 127.0.0.1:3196.'));
            const parar = () => { servidor.close(); servidor.closeAllConnections(); };
            process.once('SIGINT', parar); process.once('SIGTERM', parar);
        } catch { console.error('Configuração inválida; nenhuma porta aberta.'); process.exitCode = 1; }
    }
}
