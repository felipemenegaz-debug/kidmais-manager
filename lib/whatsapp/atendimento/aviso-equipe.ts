import { createHash, randomUUID } from 'node:crypto';
import type { DbExecutor } from '../../db/contracts.ts';
import type { MensagemEmail, EnviarEmail } from '../../acessos/email.ts';
import { configuracaoSchema } from './core.ts';
import { MOTIVOS_PASSAGEM, NOME_MOTIVO, type MotivoPassagem } from './walle/tipos.ts';

/**
 * Wall-e, fatia 8 (25/11/2026; D-WA-8: só e-mail, nada de WhatsApp para a equipe): quando uma conversa passa para a
 * equipe (AGUARDANDO_HUMANO), um e-mail curto avisa as pessoas autorizadas da empresa, com o motivo e o link
 * autenticado da conversa no painel.
 *
 * Privacidade: o e-mail NUNCA leva texto do cliente — nem a última mensagem (`passagem.ultimaMensagem`), nem o que foi
 * coletado, nem nome ou telefone do contato. Só o nome da empresa, os motivos (rótulos fixos de NOME_MOTIVO) e o link,
 * que pede login.
 *
 * Um aviso por passagem: a marca `contexto.avisoEquipe` (082, sem migration nova) é gravada ANTES do envio, sob a trava
 * da conversa (SKIP LOCKED), e só sai quando a conversa deixa a fila da equipe (limparAvisoEquipe: equipe assume,
 * devolve, encerra; pedido de parar que encerra). Nova mensagem do cliente com a conversa ainda esperando não gera outro
 * e-mail. Falha do provedor: até MAX_TENTATIVAS, com a MESMA chave de idempotência (o provedor descarta a repetição).
 *
 * Destinatários: os e-mails cadastrados na configuração, filtrados A CADA ENVIO por usuário ativo com membership ATIVA
 * de empresa ATIVA e papel com acesso ao atendimento. Quem perdeu o acesso deixa de receber sem ninguém editar a lista.
 *
 * Nunca lança para o lote: falha vira código no log (sem e-mail, link ou conteúdo).
 */
export const PAPEIS_AVISO = ['ADMINISTRATIVO', 'REPRESENTANTE_AUTORIZADO'] as const;
/** Só conversas com mensagem do cliente nas últimas 24 h (a janela em que a equipe ainda pode responder no WhatsApp). */
export const JANELA_AVISO_HORAS = 24;
export const MAX_TENTATIVAS = 3;
/** Nova tentativa (falha do provedor ou queda no meio do envio) só depois deste intervalo. */
export const REPETIR_APOS_MINUTOS = 10;
/** O motivo gravado pelo Wall-e só entra no e-mail se for desta passagem (gravado há pouco); senão, texto genérico. */
export const MOTIVO_RECENTE_MINUTOS = 30;

export type MarcaAviso = { chave: string; estado: 'ENVIANDO' | 'ENVIADO' | 'FALHOU' | 'SEM_DESTINATARIO'; em: string; tentativas: number };

/** Remove a marca do aviso quando a conversa sai da fila da equipe (só com a 082: a marca vive em `contexto`). */
export async function limparAvisoEquipe(tx: DbExecutor, conversaId: string) {
  await tx.query("UPDATE whatsapp_atendimento_conversas SET contexto=contexto-'avisoEquipe' WHERE id=$1 AND contexto ? 'avisoEquipe'", [conversaId]);
}

/** E-mails da lista que pertencem a pessoas autorizadas da empresa agora (minúsculas, ordem estável). */
export async function destinatariosAutorizados(tx: DbExecutor, empresaId: string, emails: string[]) {
  if (!emails.length) return [];
  const r = await tx.query<{ email: string }>(`SELECT DISTINCT lower(u.email) AS email
      FROM usuarios_administrativos u
      JOIN memberships m ON m.usuario_id = u.id
      JOIN empresas e ON e.id = m.empresa_id
     WHERE m.empresa_id = $1::uuid AND m.status = 'ATIVA' AND e.status = 'ATIVA' AND u.ativo
       AND m.papel = ANY($3::text[]) AND lower(u.email) = ANY($2::text[])
     ORDER BY 1`, [empresaId, emails.map((e) => e.toLowerCase()), [...PAPEIS_AVISO]]);
  return r.rows.map((x) => x.email);
}

const escapar = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/** Chave de idempotência por destinatário (sem o e-mail em claro): cabe no formato aceito pela porta de e-mail. */
export function chaveDoAviso(empresaId: string, conversaId: string, chave: string, para: string) {
  return `walle-aviso/${empresaId}/${conversaId}/${chave}/${createHash('sha256').update(para).digest('hex').slice(0, 16)}`;
}

/**
 * Mensagem do aviso. Recebe só o que pode ir: nome da empresa, motivos e link. Não há parâmetro para texto do cliente.
 */
export function mensagemAvisoEquipe(dados: { para: string; empresaNome: string; motivos: MotivoPassagem[]; link: string; idempotencia: string }): MensagemEmail {
  const motivos = dados.motivos.length ? dados.motivos.map((m) => NOME_MOTIVO[m]) : ['A conversa aguarda a equipe.'];
  const texto = [
    `iA.Fest · ${dados.empresaNome}`,
    '',
    'Uma conversa do Atendimento WhatsApp passou para a equipe e aguarda resposta.',
    '',
    `Motivo${motivos.length > 1 ? 's' : ''}:`,
    ...motivos.map((m) => `- ${m}`),
    '',
    `Abrir a conversa (pede login no painel): ${dados.link}`,
    '',
    'Por privacidade, este e-mail não traz mensagens nem dados do cliente.',
  ].join('\n');
  const html = `<div style="font-family:Arial,sans-serif;color:#151B2E;line-height:1.5">
<p><strong>iA.Fest · ${escapar(dados.empresaNome)}</strong></p>
<p>Uma conversa do Atendimento WhatsApp passou para a equipe e aguarda resposta.</p>
<p>Motivo${motivos.length > 1 ? 's' : ''}:</p><ul>${motivos.map((m) => `<li>${escapar(m)}</li>`).join('')}</ul>
<p><a href="${escapar(dados.link)}" style="display:inline-block;background:#7C3AED;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Abrir a conversa</a></p>
<p style="color:#555;font-size:13px">O link pede login no painel. Por privacidade, este e-mail não traz mensagens nem dados do cliente.</p>
</div>`;
  return { para: dados.para, assunto: `iA.Fest · ${dados.empresaNome}: conversa do WhatsApp aguardando a equipe`, texto, html, idempotencia: dados.idempotencia };
}

/** Motivos da passagem gravada pelo Wall-e, só se ela é desta passagem (recente); valores fora da lista são ignorados. */
export function motivosRecentes(passagem: unknown, agora: Date): MotivoPassagem[] {
  const p = passagem && typeof passagem === 'object' ? passagem as { motivos?: unknown; em?: unknown } : null;
  if (!p || typeof p.em !== 'string' || !Array.isArray(p.motivos)) return [];
  const em = Date.parse(p.em);
  if (!Number.isFinite(em) || agora.getTime() - em > MOTIVO_RECENTE_MINUTOS * 60_000 || em - agora.getTime() > 60_000) return [];
  return [...new Set(p.motivos.filter((m): m is MotivoPassagem => typeof m === 'string' && (MOTIVOS_PASSAGEM as readonly string[]).includes(m)))];
}

type Transacao = <T>(trabalho: (tx: DbExecutor) => Promise<T>) => Promise<T>;
type Reservado = { conversaId: string; empresaId: string; chave: string; para: string[]; empresaNome: string; motivos: MotivoPassagem[] };

/**
 * Varre a fila da equipe e envia os avisos pendentes (até `limite` conversas por chamada). Chamado pelo worker depois do
 * lote; `origem` é a origem pública do painel (o link leva a /admin/atendimento?conversa=<id>, que pede login).
 */
export async function avisarPassagensPendentes(transacao: Transacao, ambiente: string, enviar: EnviarEmail, origem: string, opcoes: { limite?: number; agora?: () => Date } = {}) {
  const limite = opcoes.limite ?? 10, agora = opcoes.agora ?? (() => new Date());
  const saida = { enviados: 0, falhas: [] as string[], semDestinatario: 0 };
  const vistas: string[] = [];
  for (let i = 0; i < limite; i++) {
    let reservado: Reservado | null | 'SEM_DESTINATARIO';
    try {
      reservado = await transacao(async (tx) => {
        const c = (await tx.query<{ id: string; empresa_id: string; passagem: unknown; marca: MarcaAviso | null; configuracao: unknown; nome: string }>(
          `SELECT c.id::text, c.empresa_id::text, c.passagem, c.contexto->'avisoEquipe' AS marca, cfg.configuracao, e.nome
             FROM whatsapp_atendimento_conversas c
             JOIN whatsapp_atendimento_config cfg ON cfg.empresa_id = c.empresa_id AND cfg.ambiente = c.ambiente
             JOIN empresas e ON e.id = c.empresa_id AND e.status = 'ATIVA'
            WHERE c.ambiente = $1 AND c.estado = 'AGUARDANDO_HUMANO' AND NOT (c.id = ANY($2::uuid[]))
              AND c.ultima_entrada_em > clock_timestamp() - make_interval(hours => $3)
              AND jsonb_typeof(cfg.configuracao->'avisoEquipe'->'emails') = 'array'
              AND jsonb_array_length(cfg.configuracao->'avisoEquipe'->'emails') > 0
              AND (NOT (COALESCE(c.contexto, '{}'::jsonb) ? 'avisoEquipe')
                OR (c.contexto->'avisoEquipe'->>'estado' IN ('ENVIANDO', 'FALHOU')
                    AND COALESCE((c.contexto->'avisoEquipe'->>'tentativas')::int, 0) < $4
                    AND (c.contexto->'avisoEquipe'->>'em')::timestamptz < clock_timestamp() - make_interval(mins => $5)))
            ORDER BY c.ultima_entrada_em, c.id LIMIT 1
            FOR UPDATE OF c SKIP LOCKED`, [ambiente, vistas, JANELA_AVISO_HORAS, MAX_TENTATIVAS, REPETIR_APOS_MINUTOS])).rows[0];
        if (!c) return null;
        vistas.push(c.id);
        const config = configuracaoSchema.safeParse(c.configuracao);
        const para = config.success ? await destinatariosAutorizados(tx, c.empresa_id, config.data.avisoEquipe?.emails ?? []) : [];
        const chave = c.marca?.chave && /^[0-9a-f-]{36}$/.test(c.marca.chave) ? c.marca.chave : randomUUID();
        const marca: MarcaAviso = para.length
          ? { chave, estado: 'ENVIANDO', em: agora().toISOString(), tentativas: (Number(c.marca?.tentativas) || 0) + 1 }
          : { chave, estado: 'SEM_DESTINATARIO', em: agora().toISOString(), tentativas: Number(c.marca?.tentativas) || 0 };
        await tx.query("UPDATE whatsapp_atendimento_conversas SET contexto=COALESCE(contexto,'{}'::jsonb)||jsonb_build_object('avisoEquipe',$2::jsonb) WHERE id=$1", [c.id, JSON.stringify(marca)]);
        if (!para.length) return 'SEM_DESTINATARIO' as const;
        return { conversaId: c.id, empresaId: c.empresa_id, chave, para, empresaNome: c.nome, motivos: motivosRecentes(c.passagem, agora()) };
      });
    } catch (erro) {
      saida.falhas.push(codigo(erro));
      break;
    }
    if (reservado === null) break;
    if (reservado === 'SEM_DESTINATARIO') { saida.semDestinatario++; continue; }
    const r = reservado;
    const link = `${origem}/admin/atendimento?conversa=${encodeURIComponent(r.conversaId)}`;
    let ok = 0;
    for (const para of r.para) {
      try {
        await enviar(mensagemAvisoEquipe({ para, empresaNome: r.empresaNome, motivos: r.motivos, link, idempotencia: chaveDoAviso(r.empresaId, r.conversaId, r.chave, para) }));
        ok++;
      } catch (erro) {
        saida.falhas.push(codigo(erro));
      }
    }
    if (ok) saida.enviados++;
    const estado = ok === r.para.length ? 'ENVIADO' : 'FALHOU';
    try {
      // Só a marca desta passagem: se a conversa saiu da fila no meio do envio, a marca já foi limpa e nada muda aqui.
      await transacao((tx) => tx.query("UPDATE whatsapp_atendimento_conversas SET contexto=jsonb_set(contexto,'{avisoEquipe,estado}',to_jsonb($3::text)) WHERE id=$1 AND contexto->'avisoEquipe'->>'chave'=$2", [r.conversaId, r.chave, estado]));
    } catch (erro) {
      saida.falhas.push(codigo(erro));
    }
  }
  return saida;
}

/** Código curto para o log: nunca mensagem, e-mail, link ou conteúdo. */
function codigo(erro: unknown) {
  const c = erro && typeof erro === 'object' ? (erro as { code?: unknown; codigo?: unknown }).codigo ?? (erro as { code?: unknown }).code : null;
  return typeof c === 'string' && /^[A-Z0-9_]{1,40}$/.test(c) ? c : 'FALHA';
}

/** Selo do menu (fatia 8): conversas da empresa esperando a equipe neste ambiente. Só número, sem conteúdo. */
export async function contarAguardandoEquipe(tx: DbExecutor, empresaId: string, ambiente: string) {
  const r = await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM whatsapp_atendimento_conversas WHERE empresa_id=$1::uuid AND ambiente=$2 AND estado='AGUARDANDO_HUMANO'", [empresaId, ambiente]);
  return r.rows[0]?.n ?? 0;
}
