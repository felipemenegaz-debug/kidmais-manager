import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { erroAcesso } from './erros.ts';

/**
 * Porta de envio de e-mail dos convites e da recuperação de senha.
 *
 * Provedores (EMAIL_PROVIDER):
 *   - `desativado` (padrão): nada é enviado; convite e recuperação respondem "envio não configurado".
 *   - `arquivo`: SOMENTE local/teste. Grava a mensagem como JSON em EMAIL_ARQUIVO_DIR e nunca envia.
 *     Recusado em deploy reconhecido (RENDER=true ou KIDMAIS_DEPLOY_ENV staging/production) e com NODE_ENV=production.
 *   - `resend`: envio real pela API HTTP do Resend (RESEND_API_KEY, EMAIL_REMETENTE). Decisão D1 pendente.
 *
 * Nunca registra corpo, link ou token em log; o erro devolvido é genérico.
 */
export type MensagemEmail = { para: string; assunto: string; texto: string; html: string; idempotencia?: string };
export type ResultadoEnvio = { provedor: 'arquivo' | 'resend'; idExterno: string | null };
export type AmbienteEmail = {
    EMAIL_PROVIDER?: string;
    EMAIL_ARQUIVO_DIR?: string;
    EMAIL_REMETENTE?: string;
    RESEND_API_KEY?: string;
    NODE_ENV?: string;
    RENDER?: string;
    KIDMAIS_DEPLOY_ENV?: string;
};
export type EnviarEmail = (mensagem: MensagemEmail) => Promise<ResultadoEnvio>;

function ambienteAtual(): AmbienteEmail {
    return {
        EMAIL_PROVIDER: process.env.EMAIL_PROVIDER,
        EMAIL_ARQUIVO_DIR: process.env.EMAIL_ARQUIVO_DIR,
        EMAIL_REMETENTE: process.env.EMAIL_REMETENTE,
        RESEND_API_KEY: process.env.RESEND_API_KEY,
        NODE_ENV: process.env.NODE_ENV,
        RENDER: process.env.RENDER,
        KIDMAIS_DEPLOY_ENV: process.env.KIDMAIS_DEPLOY_ENV,
    };
}

function deployReconhecido(env: AmbienteEmail) {
    return env.RENDER === 'true' || env.KIDMAIS_DEPLOY_ENV === 'staging' || env.KIDMAIS_DEPLOY_ENV === 'production';
}

export type SituacaoEmail = { configurado: boolean; provedor: 'desativado' | 'arquivo' | 'resend'; motivo: string | null };

/** Situação do envio sem expor valores de configuração. */
export function situacaoEmail(env: AmbienteEmail = ambienteAtual()): SituacaoEmail {
    const provedor = (env.EMAIL_PROVIDER ?? 'desativado').trim().toLowerCase();
    if (provedor === 'arquivo') {
        if (deployReconhecido(env) || env.NODE_ENV === 'production')
            return { configurado: false, provedor: 'arquivo', motivo: 'O provedor de arquivo só é aceito em ambiente local de teste.' };
        if (!env.EMAIL_ARQUIVO_DIR || !path.isAbsolute(env.EMAIL_ARQUIVO_DIR))
            return { configurado: false, provedor: 'arquivo', motivo: 'Defina EMAIL_ARQUIVO_DIR com um caminho absoluto.' };
        return { configurado: true, provedor: 'arquivo', motivo: null };
    }
    if (provedor === 'resend') {
        if (!env.RESEND_API_KEY || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$|<[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>$/.test(env.EMAIL_REMETENTE ?? ''))
            return { configurado: false, provedor: 'resend', motivo: 'Envio real sem remetente ou credencial configurados.' };
        return { configurado: true, provedor: 'resend', motivo: null };
    }
    return { configurado: false, provedor: 'desativado', motivo: 'O envio de e-mail não está configurado neste ambiente.' };
}

const naoConfigurado = (motivo: string | null) => erroAcesso('EMAIL_NAO_CONFIGURADO', motivo ?? 'O envio de e-mail não está configurado neste ambiente.', 503);

export function criarEnviarEmail(env: AmbienteEmail = ambienteAtual(), fetcher: typeof fetch = fetch): EnviarEmail {
    return async (mensagem) => {
        if (mensagem.idempotencia !== undefined && !/^[A-Za-z0-9_:/-]{1,200}$/.test(mensagem.idempotencia))
            throw new Error('Chave de envio inválida.');
        const situacao = situacaoEmail(env);
        if (!situacao.configurado)
            throw naoConfigurado(situacao.motivo);
        if (situacao.provedor === 'arquivo') {
            const dir = env.EMAIL_ARQUIVO_DIR!;
            await mkdir(dir, { recursive: true });
            const id = mensagem.idempotencia ? createHash('sha256').update(mensagem.idempotencia).digest('hex') : randomUUID();
            const destino = path.join(dir, mensagem.idempotencia ? `${id}.json` : `${Date.now()}-${id}.json`);
            try {
                await writeFile(destino, JSON.stringify({ ...mensagem, criadoEm: new Date().toISOString() }, null, 2), { encoding: 'utf8', flag: 'wx' });
            } catch (error) {
                if (!mensagem.idempotencia || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                const anterior = JSON.parse(await readFile(destino, 'utf8')) as MensagemEmail;
                for (const campo of ['para','assunto','texto','html','idempotencia'] as const)
                    if (anterior[campo] !== mensagem[campo]) throw new Error('Chave de envio reutilizada com conteúdo diferente.');
            }
            return { provedor: 'arquivo', idExterno: id };
        }
        let resposta: Response;
        try {
            resposta = await fetcher('https://api.resend.com/emails', {
                method: 'POST',
                headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json',
                    ...(mensagem.idempotencia ? { 'Idempotency-Key': mensagem.idempotencia } : {}) },
                body: JSON.stringify({ from: env.EMAIL_REMETENTE, to: [mensagem.para], subject: mensagem.assunto, text: mensagem.texto, html: mensagem.html }),
                signal: AbortSignal.timeout(10_000),
            });
        }
        catch {
            throw erroAcesso('EMAIL_FALHOU', 'O provedor de e-mail não respondeu. Nada foi enviado.', 502);
        }
        if (!resposta.ok) {
            console.warn(`[acessos] envio de e-mail recusado pelo provedor (HTTP ${resposta.status}).`);
            throw erroAcesso('EMAIL_FALHOU', 'O provedor de e-mail recusou o envio. Nada foi enviado.', 502);
        }
        const corpo = await resposta.json().catch(() => null) as { id?: unknown } | null;
        return { provedor: 'resend', idExterno: typeof corpo?.id === 'string' ? corpo.id.slice(0, 120) : null };
    };
}

/** Origem pública dos links (a mesma origem administrativa segura usada pelo login). */
export function origemPublica(env: { ADMIN_AUTH_ORIGIN?: string; NODE_ENV?: string } = { ADMIN_AUTH_ORIGIN: process.env.ADMIN_AUTH_ORIGIN, NODE_ENV: process.env.NODE_ENV }) {
    const configurada = env.ADMIN_AUTH_ORIGIN || (env.NODE_ENV !== 'production' ? 'http://localhost:3000' : '');
    if (!configurada)
        throw erroAcesso('EMAIL_NAO_CONFIGURADO', 'Origem administrativa não configurada para gerar o link.', 503);
    return new URL(configurada).origin;
}

/** O token vai no fragmento (#): não aparece em log de servidor, proxy nem Referer. */
export function linkComToken(caminho: '/acesso/convite' | '/acesso/redefinir', token: string, origem = origemPublica()) {
    return `${origem}${caminho}#t=${token}`;
}

function escapar(texto: string) {
    return texto.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function corpo(paragrafos: string[], link: string, botao: string) {
    const texto = `${paragrafos.join('\n\n')}\n\n${link}\n\nSe você não esperava esta mensagem, ignore-a.`;
    const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#111">${paragrafos.map((p) => `<p>${escapar(p)}</p>`).join('')}`
        + `<p><a href="${escapar(link)}" style="display:inline-block;padding:12px 20px;border-radius:10px;background:#7C3AED;color:#fff;text-decoration:none">${escapar(botao)}</a></p>`
        + `<p style="color:#555;font-size:13px">Se você não esperava esta mensagem, ignore-a.</p></div>`;
    return { texto, html };
}

export function mensagemConvite(input: { para: string; empresa: string; papel: string; link: string; validadeDias: number }): MensagemEmail {
    const { texto, html } = corpo([
        `Você foi convidado para acessar ${input.empresa} no Kidmais Manager como ${input.papel}.`,
        `O convite vale por ${input.validadeDias} dias e só pode ser usado uma vez.`,
    ], input.link, 'Aceitar convite');
    return { para: input.para, assunto: `Convite para acessar ${input.empresa} no Kidmais Manager`, texto, html };
}

export function mensagemRecuperacao(input: { para: string; link: string; validadeMinutos: number }): MensagemEmail {
    const { texto, html } = corpo([
        'Recebemos um pedido para redefinir a senha da sua conta no Kidmais Manager.',
        `O link vale por ${input.validadeMinutos} minutos e só pode ser usado uma vez. Ninguém da equipe Kidmais vê ou escolhe a sua senha.`,
    ], input.link, 'Definir nova senha');
    return { para: input.para, assunto: 'Redefinição de senha do Kidmais Manager', texto, html };
}
