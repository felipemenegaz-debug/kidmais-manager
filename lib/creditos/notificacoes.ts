/**
 * Saída de e-mails dos créditos (095): outbox deduplicado na mesma transação do fato (pagamento confirmado, devolução
 * registrada, aviso interno, lote vencendo). O envio é melhor esforço depois do COMMIT (rota/after ou manutenção) e nunca
 * desfaz o fato: falha de e-mail só reagenda. A 087 (avisos de cobrança) não está integrada neste repositório; o transporte
 * é o mesmo adaptador do app (lib/acessos/email.ts, EMAIL_PROVIDER; `desativado` por padrão = nada sai).
 * O outbox não guarda corpo nem destinatário: o texto é montado no envio a partir de protocolo/tipo, sem dados pessoais.
 */
import type { DbExecutor } from '../db/contracts';
import type { EnviarEmail, MensagemEmail } from '../acessos/email.ts';
import { createHash } from 'node:crypto';
import { canaisSuporte } from '../suporte/canais.ts';

export type TipoNotificacao = 'PAGAMENTO_CONFIRMADO' | 'DEVOLUCAO_REGISTRADA' | 'AVISO_INTERNO_DEVOLUCAO' | 'LOTE_VENCENDO_30' | 'LOTE_VENCENDO_7';

export async function enfileirarNotificacao(tx: DbExecutor, n: { empresaId: string; tipo: TipoNotificacao; dedupe: string; protocolo?: string | null }) {
    await tx.query(`INSERT INTO ia_credito_notificacoes (empresa_id, tipo, dedupe, protocolo) VALUES ($1::uuid, $2, $3, $4) ON CONFLICT (dedupe) DO NOTHING`,
        [n.empresaId, n.tipo, n.dedupe, n.protocolo ?? null]);
}

const ASSUNTO: Record<TipoNotificacao, string> = {
    PAGAMENTO_CONFIRMADO: 'Créditos de IA liberados',
    DEVOLUCAO_REGISTRADA: 'Pedido de devolução de créditos registrado',
    AVISO_INTERNO_DEVOLUCAO: '[Kidmais] Devolução de pacote de créditos para processar',
    LOTE_VENCENDO_30: 'Seus créditos de IA vencem em 30 dias',
    LOTE_VENCENDO_7: 'Seus créditos de IA vencem em 7 dias',
};
const TEXTO: Record<TipoNotificacao, string> = {
    PAGAMENTO_CONFIRMADO: 'O pagamento do pedido foi confirmado pelo Asaas e os créditos já estão disponíveis em Assinatura → Créditos de IA.',
    DEVOLUCAO_REGISTRADA: 'Registramos o seu pedido de devolução. Acompanhe a situação em Assinatura → Créditos de IA.',
    AVISO_INTERNO_DEVOLUCAO: 'Há uma devolução de pacote de créditos registrada. Confira a fila de devoluções (prazo e forma no painel).',
    LOTE_VENCENDO_30: 'Parte dos seus créditos de IA vence em cerca de 30 dias. Confira os vencimentos em Assinatura → Créditos de IA.',
    LOTE_VENCENDO_7: 'Parte dos seus créditos de IA vence em cerca de 7 dias. Confira os vencimentos em Assinatura → Créditos de IA.',
};
/**
 * P2-4 (revisão de 22/10): a chave de idempotência é POR NOTIFICAÇÃO E DESTINATÁRIO (id da notificação + hash do e-mail),
 * nunca por tipo/protocolo: duas pessoas da Gestão, ou avisos sem protocolo de empresas diferentes, não colidem. Uma nova
 * tentativa reenvia a mesma mensagem com a mesma chave, que o transporte trata como repetição (quem já recebeu não recebe de novo).
 */
export function mensagem(tipo: TipoNotificacao, para: string, protocolo: string | null, notificacaoId: string): MensagemEmail {
    const linhas = [TEXTO[tipo], ...(protocolo ? [`Protocolo: ${protocolo}`] : []), 'Dúvidas: contato@demerzellabs.com.br.'];
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const destino = createHash('sha256').update(para.trim().toLowerCase(), 'utf8').digest('hex').slice(0, 16);
    return { para, assunto: ASSUNTO[tipo], texto: linhas.join('\n\n'), html: linhas.map((l) => `<p>${esc(l)}</p>`).join(''), idempotencia: `creditos-${notificacaoId}-${destino}` };
}

type DepsEnvio = { withTransaction: <T>(t: (tx: DbExecutor) => Promise<T>) => Promise<T>; enviarEmail?: EnviarEmail | null; env?: Record<string, string | undefined> };
/**
 * Envia até `limite` notificações vencidas. Destinatários: Gestão ativa da empresa (até 5) ou, no aviso interno, o canal
 * da plataforma (SITE_ATENDIMENTO_EMAIL). Uma transação curta por notificação para marcar o resultado.
 */
export async function drenarNotificacoes(deps: DepsEnvio, limite = 20) {
    const r = { enviadas: 0, falhas: 0, semDestino: 0, naoConfigurado: false };
    if (!deps.enviarEmail) return r;
    const pendentes = await deps.withTransaction(async (tx) => (await tx.query<{ id: string; empresa_id: string; tipo: TipoNotificacao; protocolo: string | null }>(
        `SELECT id, empresa_id, tipo, protocolo FROM ia_credito_notificacoes WHERE situacao IN ('PENDENTE', 'FALHOU') AND proxima_em <= clock_timestamp()
         ORDER BY proxima_em LIMIT $1`, [limite])).rows);
    for (const n of pendentes) {
        const destinos = n.tipo === 'AVISO_INTERNO_DEVOLUCAO'
            ? [canaisSuporte(deps.env ?? process.env).email].filter((x): x is string => Boolean(x))
            : await deps.withTransaction(async (tx) => (await tx.query<{ email: string }>(`SELECT u.email FROM memberships m JOIN usuarios_administrativos u ON u.id = m.usuario_id
                WHERE m.empresa_id = $1::uuid AND m.papel = 'REPRESENTANTE_AUTORIZADO' AND m.status = 'ATIVA' AND u.ativo AND u.email IS NOT NULL ORDER BY m.criado_em LIMIT 5`, [n.empresa_id])).rows.map((x) => x.email));
        let ok = destinos.length > 0;
        if (!ok) r.semDestino += 1;
        for (const para of destinos) {
            try { await deps.enviarEmail(mensagem(n.tipo, para, n.protocolo, n.id)); }
            catch (error) {
                // P3-4: transporte desativado não é falha desta notificação; para a drenagem sem gastar tentativas.
                if ((error as { code?: string }).code === 'EMAIL_NAO_CONFIGURADO') { r.naoConfigurado = true; return r; }
                ok = false;
            }
        }
        await deps.withTransaction((tx) => tx.query(ok
            ? `UPDATE ia_credito_notificacoes SET situacao = 'ENVIADO', enviada_em = clock_timestamp(), tentativas = tentativas + 1 WHERE id = $1::uuid`
            : `UPDATE ia_credito_notificacoes SET situacao = CASE WHEN tentativas + 1 >= 20 THEN 'DESCARTADO' ELSE 'FALHOU' END, tentativas = tentativas + 1,
                 proxima_em = clock_timestamp() + least(interval '1 day', interval '5 minutes' * power(2, tentativas)) WHERE id = $1::uuid`, [n.id]));
        if (ok) r.enviadas += 1; else r.falhas += 1;
    }
    return r;
}
