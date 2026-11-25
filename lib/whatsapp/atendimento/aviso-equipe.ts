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
 * Um aviso por passagem (Astra r2, P2): a marca `contexto.avisoEquipe` (082, sem migration nova) nasce PENDENTE no
 * MESMO UPDATE que põe a conversa na fila (contextoNaFila, em todos os caminhos, inclusive a recuperação de trabalhos
 * interrompidos), com os motivos da passagem gravada naquele momento. O despachante só olha a marca: não há janela de
 * tempo, então nem uma entrada reentregue antiga perde o motivo, nem uma nova tentativa perto de 24 h se perde. A fila
 * de antes da fatia não tem marca e não dispara e-mails. Nova mensagem com a conversa ainda esperando não gera outra.
 *
 * Tentativas por destinatário (Astra r2, P2): até MAX_TENTATIVAS cada um, com a MESMA chave de idempotência; quem ainda
 * não foi tentado vai primeiro, então um destinatário que sempre falha não impede os outros.
 *
 * Destinatários (Astra r1, P1): os e-mails cadastrados na configuração, filtrados por usuário ativo com membership ATIVA
 * de empresa ATIVA e papel com acesso ao atendimento — na reserva E de novo imediatamente antes de CADA envio, junto com
 * a conversa ainda na fila com a mesma marca. Quem perdeu o acesso, ou conversa assumida no meio, para o envio.
 *
 * Nunca lança para o lote: falha vira código no log (sem e-mail, link ou conteúdo).
 */
export const PAPEIS_AVISO = ['ADMINISTRATIVO', 'REPRESENTANTE_AUTORIZADO'] as const;
/** Tentativas por destinatário (não por passagem). */
export const MAX_TENTATIVAS = 3;
/** Nova tentativa do mesmo destinatário (falha do provedor ou queda no meio do envio) só depois deste intervalo. */
export const REPETIR_APOS_MINUTOS = 10;

/** Tentativas de um destinatário (pelo hash curto): quantas e quando foi a última. */
export type DestinoAviso = { n: number; em: string };
export type MarcaAviso = {
  chave: string;
  /**
   * PENDENTE: gravada na passagem, ainda sem envio. PARCIAL: o prazo do lote acabou no meio; o próximo lote continua sem
   * esperar. FALHOU: algum destinatário ainda tem tentativa; volta depois de REPETIR_APOS_MINUTOS. ESGOTADO: sobrou só
   * quem esgotou as tentativas. ENVIADO e SEM_DESTINATARIO são finais.
   */
  estado: 'PENDENTE' | 'ENVIANDO' | 'ENVIADO' | 'FALHOU' | 'PARCIAL' | 'ESGOTADO' | 'SEM_DESTINATARIO';
  em: string;
  /** Motivos gravados na passagem (contextoNaFila); fixos depois do primeiro envio. */
  motivos: MotivoPassagem[];
  /** Tentativas por destinatário (hash curto: nunca o e-mail em claro). */
  destinos: Record<string, DestinoAviso>;
  /** Destinatários já atendidos (enviado ou sem acesso no envio), pelo hash curto. */
  feitos: string[];
};

const motivosSql = (passagem: string | null) => passagem
  ? `(CASE WHEN jsonb_typeof((${passagem})->'motivos')='array' THEN (${passagem})->'motivos' ELSE '[]'::jsonb END)`
  : "'[]'::jsonb";

/**
 * Expressão SQL de `contexto` para um UPDATE de `whatsapp_atendimento_conversas` que pode pôr a conversa na fila da
 * equipe (só com a 082: a marca vive em `contexto`). As referências a `estado` e `contexto` são os valores de ANTES do
 * UPDATE (regra do SET no PostgreSQL), então:
 *  - entrou na fila agora (estado novo AGUARDANDO_HUMANO, antigo não): marca PENDENTE nova, com chave nova e os motivos
 *    da passagem gravada no mesmo UPDATE (sem passagem: sem motivo, o e-mail usa o texto genérico);
 *  - já estava na fila e a passagem foi regravada antes do primeiro envio (marca ainda PENDENTE): só os motivos mudam;
 *  - qualquer outro caso: `base`.
 * `base` é o contexto que o UPDATE já gravaria (padrão: o atual); `novo` (estado novo) e `passagem` são expressões SQL.
 * Parâmetros posicionais com padrão literal: a guarda estática de SQL (scripts/guarda-salao-estatica.cjs) resolve cada
 * chamada até os literais (um objeto de opções com propriedade ausente ela não resolve).
 */
export function contextoNaFila(base = 'contexto', novo = "'AGUARDANDO_HUMANO'", passagem: string | null = null) {
  const cheio = `COALESCE((${base}),'{}'::jsonb)`, motivos = motivosSql(passagem);
  return `CASE WHEN (${novo})='AGUARDANDO_HUMANO' AND estado IS DISTINCT FROM 'AGUARDANDO_HUMANO' THEN (${cheio})||jsonb_build_object('avisoEquipe',jsonb_build_object('chave',gen_random_uuid()::text,'estado','PENDENTE','em',clock_timestamp(),'motivos',${motivos},'destinos','{}'::jsonb,'feitos','[]'::jsonb))`
    + (passagem ? ` WHEN (${passagem}) IS NOT NULL AND (${novo})='AGUARDANDO_HUMANO' AND contexto->'avisoEquipe'->>'estado'='PENDENTE' THEN jsonb_set(${cheio},'{avisoEquipe,motivos}',${motivos})` : '')
    + ` ELSE ${base} END`;
}
/** `,contexto=…` para acrescentar ao SET de um UPDATE que pode pôr a conversa na fila; vazio sem a 082. */
export function marcaNaFila(com082: boolean, novo = "'AGUARDANDO_HUMANO'", passagem: string | null = null) {
  return com082 ? `,contexto=${contextoNaFila('contexto', novo, passagem)}` : '';
}

/** Remove a marca do aviso quando a conversa sai da fila da equipe (só com a 082: a marca vive em `contexto`). */
export async function limparAvisoEquipe(tx: DbExecutor, conversaId: string) {
  await tx.query("UPDATE whatsapp_atendimento_conversas SET contexto=COALESCE(contexto,'{}'::jsonb)-'avisoEquipe' WHERE id=$1", [conversaId]);
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
const ehResumo = (f: unknown): f is string => typeof f === 'string' && /^[0-9a-f]{16}$/.test(f);
function destinosDe(valor: unknown): Record<string, DestinoAviso> {
  if (!valor || typeof valor !== 'object' || Array.isArray(valor)) return {};
  const saida: Record<string, DestinoAviso> = {};
  for (const [k, v] of Object.entries(valor as Record<string, unknown>)) {
    const d = v && typeof v === 'object' ? v as { n?: unknown; em?: unknown } : null;
    if (ehResumo(k) && d && Number.isInteger(d.n) && Number(d.n) >= 0 && typeof d.em === 'string' && Number.isFinite(Date.parse(d.em))) saida[k] = { n: Number(d.n), em: d.em };
  }
  return saida;
}

type Transacao = <T>(trabalho: (tx: DbExecutor) => Promise<T>) => Promise<T>;
type Reservado = { conversaId: string; empresaId: string; chave: string; para: string[]; empresaNome: string; motivos: MotivoPassagem[]; feitos: string[]; pendentes: string[] };
type Opcoes = { limite?: number; agora?: () => Date; prazo?: number; relogio?: () => number };

/**
 * Quem recebe nesta rodada e o estado da marca se ninguém puder receber agora. Pendentes: autorizados ainda não feitos.
 * Prontos: pendentes com tentativa sobrando e sem tentativa recente; os menos tentados primeiro (depois, ordem do e-mail).
 */
export function planoDoAviso(autorizados: string[], feitos: string[], destinos: Record<string, DestinoAviso>, agora: Date) {
  const pendentes = autorizados.filter((p) => !feitos.includes(resumoDe(p)));
  const restantes = pendentes.filter((p) => (destinos[resumoDe(p)]?.n ?? 0) < MAX_TENTATIVAS);
  const tentou = (p: string) => destinos[resumoDe(p)]?.n ?? 0;
  const prontos = restantes
    .filter((p) => { const d = destinos[resumoDe(p)]; return !d || d.n === 0 || agora.getTime() - Date.parse(d.em) >= REPETIR_APOS_MINUTOS * 60_000; })
    .sort((a, b) => tentou(a) - tentou(b) || a.localeCompare(b));
  const semEnvio: MarcaAviso['estado'] = restantes.length ? 'FALHOU' : pendentes.length ? 'ESGOTADO' : !autorizados.length && !feitos.length ? 'SEM_DESTINATARIO' : 'ENVIADO';
  return { pendentes, prontos, semEnvio };
}

/**
 * Varre a fila da equipe e envia os avisos pendentes (até `limite` conversas por chamada). Chamado pelo worker depois do
 * lote; `origem` é a origem pública do painel (o link leva a /admin/atendimento?conversa=<id>, que pede login).
 * Seleção só pela marca gravada na passagem (sem janela de tempo): PENDENTE e PARCIAL na hora; ENVIANDO (queda no meio)
 * e FALHOU depois de REPETIR_APOS_MINUTOS. Sem e-mails configurados: SEM_DESTINATARIO.
 * `prazo` (instante absoluto em ms, no `relogio`): nenhuma conversa nova e nenhum e-mail novo começa depois dele, e ele
 * é conferido de novo DEPOIS da revalidação, imediatamente antes de chamar o provedor (Astra r2, P2); o que faltar fica
 * PARCIAL na marca e o próximo lote continua.
 */
export async function avisarPassagensPendentes(transacao: Transacao, ambiente: string, enviar: EnviarEmail, origem: string, opcoes: Opcoes = {}) {
  const limite = opcoes.limite ?? 10, agora = opcoes.agora ?? (() => new Date());
  const relogio = opcoes.relogio ?? Date.now, prazo = opcoes.prazo ?? Infinity;
  const saida = { enviados: 0, falhas: [] as string[], semDestinatario: 0, parcial: false };
  const vistas: string[] = [];
  for (let i = 0; i < limite; i++) {
    if (relogio() >= prazo) { saida.parcial = true; break; }
    let reservado: Reservado | null | 'SEM_ENVIO';
    try {
      reservado = await transacao(async (tx) => {
        const c = (await tx.query<{ id: string; empresa_id: string; marca: Partial<MarcaAviso> | null; configuracao: unknown; nome: string }>(
          `SELECT c.id::text, c.empresa_id::text, c.contexto->'avisoEquipe' AS marca, cfg.configuracao, e.nome
             FROM whatsapp_atendimento_conversas c
             JOIN empresas e ON e.id = c.empresa_id AND e.status = 'ATIVA'
             LEFT JOIN whatsapp_atendimento_config cfg ON cfg.empresa_id = c.empresa_id AND cfg.ambiente = c.ambiente
            WHERE c.ambiente = $1 AND c.estado = 'AGUARDANDO_HUMANO' AND NOT (c.id = ANY($2::uuid[]))
              AND jsonb_typeof(c.contexto->'avisoEquipe') = 'object'
              AND (c.contexto->'avisoEquipe'->>'estado' IN ('PENDENTE', 'PARCIAL')
                OR (c.contexto->'avisoEquipe'->>'estado' IN ('ENVIANDO', 'FALHOU')
                    AND (c.contexto->'avisoEquipe'->>'em')::timestamptz < clock_timestamp() - make_interval(mins => $3)))
            ORDER BY c.atualizada_em, c.id LIMIT 1
            FOR UPDATE OF c SKIP LOCKED`, [ambiente, vistas, REPETIR_APOS_MINUTOS])).rows[0];
        if (!c) return null;
        vistas.push(c.id);
        const marca = c.marca ?? {};
        const config = configuracaoSchema.safeParse(c.configuracao);
        const feitos = Array.isArray(marca.feitos) ? marca.feitos.filter(ehResumo) : [];
        const destinos = destinosDe(marca.destinos);
        const autorizados = config.success ? await destinatariosAutorizados(tx, c.empresa_id, config.data.avisoEquipe?.emails ?? []) : [];
        const plano = planoDoAviso(autorizados, feitos, destinos, agora());
        const chave = typeof marca.chave === 'string' && /^[0-9a-f-]{36}$/.test(marca.chave) ? marca.chave : randomUUID();
        const motivos = validos(marca.motivos);
        const nova: MarcaAviso = { chave, estado: plano.prontos.length ? 'ENVIANDO' : plano.semEnvio, em: agora().toISOString(), motivos, destinos, feitos };
        await tx.query("UPDATE whatsapp_atendimento_conversas SET contexto=COALESCE(contexto,'{}'::jsonb)||jsonb_build_object('avisoEquipe',$2::jsonb) WHERE id=$1", [c.id, JSON.stringify(nova)]);
        if (!plano.prontos.length) return 'SEM_ENVIO' as const;
        return { conversaId: c.id, empresaId: c.empresa_id, chave, para: plano.prontos, empresaNome: c.nome, motivos, feitos, pendentes: plano.pendentes };
      });
    } catch (erro) {
      saida.falhas.push(codigo(erro));
      break;
    }
    if (reservado === null) break;
    if (reservado === 'SEM_ENVIO') { saida.semDestinatario++; continue; }
    const r = reservado;
    const link = `${origem}/admin/atendimento?conversa=${encodeURIComponent(r.conversaId)}`;
    const feitos = [...r.feitos];
    let ok = 0, interrompida = false, cortada = false;
    for (const para of r.para) {
      if (relogio() >= prazo) { cortada = true; break; }
      let pode: 'ENVIAR' | 'SEM_ACESSO' | 'SAIU' | 'PRAZO';
      try {
        pode = await transacao((tx) => conferirAntesDoEnvio(tx, r, para, () => relogio() < prazo, agora));
      } catch (erro) {
        saida.falhas.push(codigo(erro)); continue;
      }
      if (pode === 'SAIU') { interrompida = true; break; }
      if (pode === 'PRAZO') { cortada = true; break; }
      if (pode === 'SEM_ACESSO') { feitos.push(resumoDe(para)); continue; }
      try {
        await enviar(mensagemAvisoEquipe({ para, empresaNome: r.empresaNome, motivos: r.motivos, link, idempotencia: chaveDoAviso(r.empresaId, r.conversaId, r.chave, para) }));
        ok++;
        feitos.push(resumoDe(para));
      } catch (erro) {
        saida.falhas.push(codigo(erro));
      }
    }
    if (ok) saida.enviados++;
    // Conversa saiu da fila (ou outra passagem começou) no meio: a marca já foi limpa/trocada; nada a gravar.
    if (interrompida) continue;
    if (cortada) saida.parcial = true;
    const faltam = r.pendentes.some((p) => !feitos.includes(resumoDe(p)));
    const estado: MarcaAviso['estado'] = cortada ? 'PARCIAL' : faltam ? 'FALHOU' : 'ENVIADO';
    try {
      // Só a marca desta passagem (mesma chave); as tentativas por destinatário já foram gravadas antes de cada envio.
      await transacao((tx) => tx.query("UPDATE whatsapp_atendimento_conversas SET contexto=jsonb_set(jsonb_set(contexto,'{avisoEquipe,estado}',to_jsonb($3::text)),'{avisoEquipe,feitos}',$4::jsonb) WHERE id=$1 AND contexto->'avisoEquipe'->>'chave'=$2",
        [r.conversaId, r.chave, estado, JSON.stringify([...new Set(feitos)])]));
    } catch (erro) {
      saida.falhas.push(codigo(erro));
    }
    if (cortada) break;
  }
  return saida;
}

/**
 * Logo antes de cada e-mail (Astra r1, P1): a conversa continua na fila da equipe com a MESMA marca (não foi assumida,
 * devolvida, encerrada nem trocada de passagem) e o destinatário continua na lista E com acesso agora. Depois disso, o
 * prazo do lote é conferido de novo (Astra r2, P2: a revalidação também gasta tempo); dentro dele, a tentativa deste
 * destinatário é gravada na marca (FOR UPDATE: duas rodadas não contam a mesma) e o envio começa logo após o COMMIT.
 */
async function conferirAntesDoEnvio(tx: DbExecutor, r: Reservado, para: string, dentroDoPrazo: () => boolean, agora: () => Date): Promise<'ENVIAR' | 'SEM_ACESSO' | 'SAIU' | 'PRAZO'> {
  const c = (await tx.query<{ configuracao: unknown; destino: unknown }>(
    `SELECT cfg.configuracao, c.contexto->'avisoEquipe'->'destinos'->$3 AS destino FROM whatsapp_atendimento_conversas c
       LEFT JOIN whatsapp_atendimento_config cfg ON cfg.empresa_id = c.empresa_id AND cfg.ambiente = c.ambiente
      WHERE c.id = $1 AND c.estado = 'AGUARDANDO_HUMANO' AND c.contexto->'avisoEquipe'->>'chave' = $2
      FOR UPDATE OF c`, [r.conversaId, r.chave, resumoDe(para)])).rows[0];
  if (!c) return 'SAIU';
  const config = configuracaoSchema.safeParse(c.configuracao);
  const lista = config.success ? (config.data.avisoEquipe?.emails ?? []).map((e) => e.toLowerCase()) : [];
  if (!lista.includes(para)) return 'SEM_ACESSO';
  if (!(await destinatariosAutorizados(tx, r.empresaId, [para])).length) return 'SEM_ACESSO';
  if (!dentroDoPrazo()) return 'PRAZO';
  const n = (destinosDe({ [resumoDe(para)]: c.destino })[resumoDe(para)]?.n ?? 0) + 1;
  await tx.query("UPDATE whatsapp_atendimento_conversas SET contexto=jsonb_set(contexto,ARRAY['avisoEquipe','destinos',$2::text],$3::jsonb) WHERE id=$1",
    [r.conversaId, resumoDe(para), JSON.stringify({ n, em: agora().toISOString() })]);
  return 'ENVIAR';
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
