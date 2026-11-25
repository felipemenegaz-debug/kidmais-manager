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
 * devolve, encerra; pedido de parar que encerra), que também grava `avisoEquipeSaida` (o fim da passagem anterior).
 * Nova mensagem do cliente com a conversa ainda esperando não gera outro e-mail. Falha do provedor: até MAX_TENTATIVAS,
 * com a MESMA chave de idempotência; o progresso fica na marca (destinatários já atendidos não recebem de novo).
 *
 * Destinatários (Astra r1, P1): os e-mails cadastrados na configuração, filtrados por usuário ativo com membership ATIVA
 * de empresa ATIVA e papel com acesso ao atendimento — na reserva E de novo imediatamente antes de CADA envio, junto com
 * a conversa ainda na fila com a mesma marca. Quem perdeu o acesso, ou conversa assumida no meio, para o envio.
 *
 * Nunca lança para o lote: falha vira código no log (sem e-mail, link ou conteúdo).
 */
export const PAPEIS_AVISO = ['ADMINISTRATIVO', 'REPRESENTANTE_AUTORIZADO'] as const;
/**
 * Só conversas que entraram na fila (ou mudaram nela) nas últimas 24 h, pela transição (`atualizada_em`), não pela
 * última mensagem do cliente (Astra r1, P2): uma entrada reentregue antiga que gera passagem agora ainda avisa; a fila
 * velha de antes da fatia não dispara uma rajada de e-mails.
 */
export const JANELA_AVISO_HORAS = 24;
export const MAX_TENTATIVAS = 3;
/** Nova tentativa (falha do provedor ou queda no meio do envio) só depois deste intervalo. */
export const REPETIR_APOS_MINUTOS = 10;

export type MarcaAviso = {
  chave: string;
  /** PARCIAL: o prazo do lote acabou no meio; o próximo lote continua pelos destinatários que faltam, sem esperar. */
  estado: 'ENVIANDO' | 'ENVIADO' | 'FALHOU' | 'PARCIAL' | 'SEM_DESTINATARIO';
  em: string;
  tentativas: number;
  /** Motivos fixados na PRIMEIRA reserva desta passagem e reusados nas novas tentativas. */
  motivos: MotivoPassagem[];
  /** Destinatários já atendidos (enviado ou sem acesso no envio), pelo hash curto: nunca o e-mail em claro. */
  feitos: string[];
};

/**
 * Remove a marca do aviso quando a conversa sai da fila da equipe (só com a 082: a marca vive em `contexto`) e grava o
 * fim da passagem: motivo gravado antes dele é de uma passagem anterior e não entra no próximo aviso.
 */
export async function limparAvisoEquipe(tx: DbExecutor, conversaId: string) {
  await tx.query("UPDATE whatsapp_atendimento_conversas SET contexto=(COALESCE(contexto,'{}'::jsonb)-'avisoEquipe')||jsonb_build_object('avisoEquipeSaida',to_jsonb(clock_timestamp())) WHERE id=$1", [conversaId]);
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
const resumoDe = (para: string) => createHash('sha256').update(para).digest('hex').slice(0, 16);

/** Chave de idempotência por destinatário (sem o e-mail em claro): cabe no formato aceito pela porta de e-mail. */
export function chaveDoAviso(empresaId: string, conversaId: string, chave: string, para: string) {
  return `walle-aviso/${empresaId}/${conversaId}/${chave}/${resumoDe(para)}`;
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

const validos = (lista: unknown): MotivoPassagem[] => Array.isArray(lista)
  ? [...new Set(lista.filter((m): m is MotivoPassagem => typeof m === 'string' && (MOTIVOS_PASSAGEM as readonly string[]).includes(m)))] : [];

/**
 * Motivos da passagem ATUAL (Astra r1, P2): a passagem gravada vale se é posterior ao fim da passagem anterior
 * (`avisoEquipeSaida`, gravado quando a conversa saiu da fila) e da janela do aviso; sem isso, o e-mail usa o texto
 * genérico. A idade da passagem não decide sozinha: worker atrasado não perde o motivo.
 */
export function motivosDaPassagem(passagem: unknown, saidaAnterior: unknown, agora: Date): MotivoPassagem[] {
  const p = passagem && typeof passagem === 'object' ? passagem as { motivos?: unknown; em?: unknown } : null;
  if (!p || typeof p.em !== 'string') return [];
  const em = Date.parse(p.em);
  if (!Number.isFinite(em) || agora.getTime() - em > JANELA_AVISO_HORAS * 3_600_000 || em - agora.getTime() > 60_000) return [];
  if (saidaAnterior !== undefined && saidaAnterior !== null) {
    const saida = typeof saidaAnterior === 'string' ? Date.parse(saidaAnterior) : NaN;
    // Fim da passagem anterior ilegível: na dúvida, não atribui um motivo que pode ser velho.
    if (!Number.isFinite(saida) || em <= saida) return [];
  }
  return validos(p.motivos);
}

type Transacao = <T>(trabalho: (tx: DbExecutor) => Promise<T>) => Promise<T>;
type Reservado = { conversaId: string; empresaId: string; chave: string; para: string[]; empresaNome: string; marca: MarcaAviso };

/**
 * Varre a fila da equipe e envia os avisos pendentes (até `limite` conversas por chamada). Chamado pelo worker depois do
 * lote; `origem` é a origem pública do painel (o link leva a /admin/atendimento?conversa=<id>, que pede login).
 * `prazo` (instante absoluto em ms, no `relogio`): nenhuma conversa nova e nenhum e-mail novo começa depois dele; o
 * que faltar fica PARCIAL na marca e o próximo lote continua (Astra r1, P2).
 */
export async function avisarPassagensPendentes(transacao: Transacao, ambiente: string, enviar: EnviarEmail, origem: string,
  opcoes: { limite?: number; agora?: () => Date; prazo?: number; relogio?: () => number } = {}) {
  const limite = opcoes.limite ?? 10, agora = opcoes.agora ?? (() => new Date());
  const relogio = opcoes.relogio ?? Date.now, prazo = opcoes.prazo ?? Infinity;
  const saida = { enviados: 0, falhas: [] as string[], semDestinatario: 0, parcial: false };
  const vistas: string[] = [];
  for (let i = 0; i < limite; i++) {
    if (relogio() >= prazo) { saida.parcial = true; break; }
    let reservado: Reservado | null | 'SEM_DESTINATARIO';
    try {
      reservado = await transacao(async (tx) => {
        const c = (await tx.query<{ id: string; empresa_id: string; passagem: unknown; marca: Partial<MarcaAviso> | null; saida: unknown; configuracao: unknown; nome: string }>(
          `SELECT c.id::text, c.empresa_id::text, c.passagem, c.contexto->'avisoEquipe' AS marca, c.contexto->'avisoEquipeSaida' AS saida, cfg.configuracao, e.nome
             FROM whatsapp_atendimento_conversas c
             JOIN whatsapp_atendimento_config cfg ON cfg.empresa_id = c.empresa_id AND cfg.ambiente = c.ambiente
             JOIN empresas e ON e.id = c.empresa_id AND e.status = 'ATIVA'
            WHERE c.ambiente = $1 AND c.estado = 'AGUARDANDO_HUMANO' AND NOT (c.id = ANY($2::uuid[]))
              AND c.atualizada_em > clock_timestamp() - make_interval(hours => $3)
              AND jsonb_typeof(cfg.configuracao->'avisoEquipe'->'emails') = 'array'
              AND jsonb_array_length(cfg.configuracao->'avisoEquipe'->'emails') > 0
              AND (NOT (COALESCE(c.contexto, '{}'::jsonb) ? 'avisoEquipe')
                OR (c.contexto->'avisoEquipe'->>'estado' = 'PARCIAL')
                OR (c.contexto->'avisoEquipe'->>'estado' IN ('ENVIANDO', 'FALHOU')
                    AND COALESCE((c.contexto->'avisoEquipe'->>'tentativas')::int, 0) < $4
                    AND (c.contexto->'avisoEquipe'->>'em')::timestamptz < clock_timestamp() - make_interval(mins => $5)))
            ORDER BY c.atualizada_em, c.id LIMIT 1
            FOR UPDATE OF c SKIP LOCKED`, [ambiente, vistas, JANELA_AVISO_HORAS, MAX_TENTATIVAS, REPETIR_APOS_MINUTOS])).rows[0];
        if (!c) return null;
        vistas.push(c.id);
        const anterior = c.marca && typeof c.marca === 'object' ? c.marca : null;
        const config = configuracaoSchema.safeParse(c.configuracao);
        const feitos = Array.isArray(anterior?.feitos) ? anterior.feitos.filter((f): f is string => typeof f === 'string' && /^[0-9a-f]{16}$/.test(f)) : [];
        const autorizados = config.success ? await destinatariosAutorizados(tx, c.empresa_id, config.data.avisoEquipe?.emails ?? []) : [];
        const para = autorizados.filter((p) => !feitos.includes(resumoDe(p)));
        const chave = typeof anterior?.chave === 'string' && /^[0-9a-f-]{36}$/.test(anterior.chave) ? anterior.chave : randomUUID();
        // Motivos fixados na primeira reserva da passagem; as novas tentativas repetem os mesmos.
        const motivos = anterior ? validos(anterior.motivos) : motivosDaPassagem(c.passagem, c.saida, agora());
        const tentativas = (Number(anterior?.tentativas) || 0) + (anterior?.estado === 'PARCIAL' ? 0 : 1);
        const marca: MarcaAviso = para.length
          ? { chave, estado: 'ENVIANDO', em: agora().toISOString(), tentativas, motivos, feitos }
          : { chave, estado: feitos.length ? 'ENVIADO' : 'SEM_DESTINATARIO', em: agora().toISOString(), tentativas: Number(anterior?.tentativas) || 0, motivos, feitos };
        await tx.query("UPDATE whatsapp_atendimento_conversas SET contexto=COALESCE(contexto,'{}'::jsonb)||jsonb_build_object('avisoEquipe',$2::jsonb) WHERE id=$1", [c.id, JSON.stringify(marca)]);
        if (!para.length) return 'SEM_DESTINATARIO' as const;
        return { conversaId: c.id, empresaId: c.empresa_id, chave, para, empresaNome: c.nome, marca };
      });
    } catch (erro) {
      saida.falhas.push(codigo(erro));
      break;
    }
    if (reservado === null) break;
    if (reservado === 'SEM_DESTINATARIO') { saida.semDestinatario++; continue; }
    const r = reservado;
    const link = `${origem}/admin/atendimento?conversa=${encodeURIComponent(r.conversaId)}`;
    const feitos = [...r.marca.feitos];
    let ok = 0, falhou = false, interrompida = false, cortada = false;
    for (const para of r.para) {
      if (relogio() >= prazo) { cortada = true; break; }
      let pode: 'ENVIAR' | 'SEM_ACESSO' | 'SAIU';
      try {
        pode = await transacao((tx) => conferirAntesDoEnvio(tx, r, para));
      } catch (erro) {
        saida.falhas.push(codigo(erro)); falhou = true; continue;
      }
      if (pode === 'SAIU') { interrompida = true; break; }
      if (pode === 'SEM_ACESSO') { feitos.push(resumoDe(para)); continue; }
      try {
        await enviar(mensagemAvisoEquipe({ para, empresaNome: r.empresaNome, motivos: r.marca.motivos, link, idempotencia: chaveDoAviso(r.empresaId, r.conversaId, r.chave, para) }));
        ok++;
        feitos.push(resumoDe(para));
      } catch (erro) {
        saida.falhas.push(codigo(erro)); falhou = true;
      }
    }
    if (ok) saida.enviados++;
    // Conversa saiu da fila (ou outra passagem começou) no meio: a marca já foi limpa/trocada; nada a gravar.
    if (interrompida) continue;
    if (cortada) saida.parcial = true;
    const estado: MarcaAviso['estado'] = cortada && !falhou ? 'PARCIAL' : falhou ? 'FALHOU' : 'ENVIADO';
    try {
      // Só a marca desta passagem: se a conversa saiu da fila no meio do envio, a marca já foi limpa e nada muda aqui.
      await transacao((tx) => tx.query("UPDATE whatsapp_atendimento_conversas SET contexto=jsonb_set(jsonb_set(contexto,'{avisoEquipe,estado}',to_jsonb($3::text)),'{avisoEquipe,feitos}',$4::jsonb) WHERE id=$1 AND contexto->'avisoEquipe'->>'chave'=$2",
        [r.conversaId, r.chave, estado, JSON.stringify(feitos)]));
    } catch (erro) {
      saida.falhas.push(codigo(erro));
    }
    if (cortada) break;
  }
  return saida;
}

/**
 * Logo antes de cada e-mail (Astra r1, P1): a conversa continua na fila da equipe com a MESMA marca (não foi assumida,
 * devolvida, encerrada nem trocada de passagem) e o destinatário continua na lista E com acesso agora. FOR SHARE segura
 * a conversa contra a troca de estado até o fim desta leitura.
 */
async function conferirAntesDoEnvio(tx: DbExecutor, r: Reservado, para: string): Promise<'ENVIAR' | 'SEM_ACESSO' | 'SAIU'> {
  const c = (await tx.query<{ configuracao: unknown }>(
    `SELECT cfg.configuracao FROM whatsapp_atendimento_conversas c
       JOIN whatsapp_atendimento_config cfg ON cfg.empresa_id = c.empresa_id AND cfg.ambiente = c.ambiente
      WHERE c.id = $1 AND c.estado = 'AGUARDANDO_HUMANO' AND c.contexto->'avisoEquipe'->>'chave' = $2
      FOR SHARE OF c`, [r.conversaId, r.chave])).rows[0];
  if (!c) return 'SAIU';
  const config = configuracaoSchema.safeParse(c.configuracao);
  const lista = config.success ? (config.data.avisoEquipe?.emails ?? []).map((e) => e.toLowerCase()) : [];
  if (!lista.includes(para)) return 'SEM_ACESSO';
  return (await destinatariosAutorizados(tx, r.empresaId, [para])).length ? 'ENVIAR' : 'SEM_ACESSO';
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
/**
 * Selo do menu (Astra r1, P1): a resolução do ambiente e a contagem ficam no MESMO tratamento de erro. Ambiente ausente
 * ou inválido, banco fora ou sem a tabela: 0, e a sessão segue normal.
 */
export async function seloAguardandoEquipe(tx: DbExecutor, empresaId: string, ambiente: () => string) {
  try { return await contarAguardandoEquipe(tx, empresaId, ambiente()); } catch { return 0; }
}
