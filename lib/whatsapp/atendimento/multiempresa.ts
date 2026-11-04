import type { DbExecutor } from '../../db/contracts.ts';
import { planoComercialValido, type PlanoComercialId } from '../../assinatura/planos-comerciais.ts';
import { RECURSOS_POR_PLANO } from '../../assinatura/recursos-plano.ts';

/**
 * Atendimento WhatsApp multiempresa (E-ME1; plano "Plano Atendimento WhatsApp multiempresa 20261104" r6.1, APROVADO pelo
 * Astra; D-ME-1..5 decididas por Felipe em 04/11/2026).
 *
 * Dois modos efetivos:
 *  - PILOTO: só a empresa de WHATSAPP_ATENDIMENTO_EMPRESA_ID opera, exatamente como antes desta entrega.
 *  - MULTI: qualquer empresa com número Meta CONFIGURADO e direito ao recurso (C2 + C4) opera, além da piloto.
 *
 * MULTI exige a chave WHATSAPP_ATENDIMENTO_MULTIEMPRESA exatamente "true" E as duas tabelas da 117 (rodízio e colisões).
 * Qualquer outro caso é PILOTO. O modo só governa caminhos OPERACIONAIS (recepção de mensagem, ações da tela que ligam,
 * respondem ou enfileiram, reserva, persistência e envio do worker). Status, rotinas, privacidade e leitura não dependem
 * dele. A piloto segue as regras atuais em qualquer modo: não ganha C4 nem C2 novos.
 *
 * Este módulo não lê configuração do canal (piloto, ambiente): quem chama passa o que já leu, para que as suítes que
 * simulam a configuração continuem valendo.
 */

export type ChaveMultiempresa = 'MULTI' | 'PILOTO' | 'INVALIDA';
export type ModoEfetivo = 'MULTI' | 'PILOTO';

let avisoChaveInvalida = false;
let avisoSemTabelas = false;

/** Exatamente "true" liga; ausente ou "false" desliga; qualquer outro valor é inválido e desliga (com erro registrado). */
export function chaveMultiempresa(env: NodeJS.ProcessEnv = process.env): ChaveMultiempresa {
  const v = env.WHATSAPP_ATENDIMENTO_MULTIEMPRESA;
  if (v === undefined || v === 'false') return 'PILOTO';
  if (v === 'true') return 'MULTI';
  if (!avisoChaveInvalida) { avisoChaveInvalida = true; console.error('[Atendimento WhatsApp] WHATSAPP_ATENDIMENTO_MULTIEMPRESA inválida: tratada como desligada.'); }
  return 'INVALIDA';
}

/**
 * Catálogo do banco que o atendimento consulta: as duas tabelas da 117 e o schema comercial (074). UMA consulta por
 * transação (P3 da revisão da E-ME1): o executor de cada transação (withTransaction) e de cada db() é um objeto novo, então
 * a memória por executor nunca atravessa transações nem processos. Aplicar a 117 não exige reiniciar.
 */
export type Catalogo = { rodizio: boolean; colisoes: boolean; comercial: boolean };
const catalogos = new WeakMap<object, Promise<Catalogo>>();
export function catalogo(tx: DbExecutor): Promise<Catalogo> {
  let c = catalogos.get(tx);
  if (!c) {
    c = tx.query<{ rodizio: boolean; colisoes: boolean; comercial: boolean }>(`SELECT to_regclass('public.whatsapp_atendimento_rodizio') IS NOT NULL AS rodizio,
      to_regclass('public.whatsapp_atendimento_status_colisoes') IS NOT NULL AS colisoes,
      (to_regclass('public.assinatura_contratacoes') IS NOT NULL AND to_regclass('public.assinatura_isencoes') IS NOT NULL
        AND to_regclass('public.assinatura_fundadores') IS NOT NULL) AS comercial`)
      .then((r) => ({ rodizio: r.rows[0]?.rodizio === true, colisoes: r.rows[0]?.colisoes === true, comercial: r.rows[0]?.comercial === true }));
    // Falha de leitura não fica memorizada: a próxima chamada consulta de novo.
    c.catch(() => catalogos.delete(tx));
    catalogos.set(tx, c);
  }
  return c;
}
/** Tabelas da 117 (do catálogo da transação). */
export async function tabelas117(tx: DbExecutor) {
  const c = await catalogo(tx);
  return { rodizio: c.rodizio, colisoes: c.colisoes };
}

/** Disponibilidade da marca de colisão: independe do modo (vale também no PILOTO quando a 117 está aplicada). */
export async function colisoesDisponivel(tx: DbExecutor) {
  return (await tabelas117(tx)).colisoes;
}

/** Modo efetivo compartilhado por recepção, tela/API e worker (§2.1). */
export async function modoEfetivo(tx: DbExecutor, env: NodeJS.ProcessEnv = process.env): Promise<ModoEfetivo> {
  if (chaveMultiempresa(env) !== 'MULTI') return 'PILOTO';
  const t = await tabelas117(tx);
  if (t.rodizio && t.colisoes) return 'MULTI';
  if (!avisoSemTabelas) { avisoSemTabelas = true; console.error('[Atendimento WhatsApp] WHATSAPP_ATENDIMENTO_MULTIEMPRESA=true sem a migration 117: modo efetivo PILOTO.'); }
  return 'PILOTO';
}

/** Piloto configurada, ou null (no MULTI a piloto é opcional: só o Gupshup depende dela). */
export function pilotoOpcional(lerPiloto: () => string): string | null {
  try { return lerPiloto(); } catch { return null; }
}

/** Falha de leitura que um novo envio do evento ou uma nova tentativa da tarefa pode resolver. Nunca concede, nunca descarta. */
export class ErroTransitorioAtendimento extends Error {
  readonly motivo: string;
  constructor(motivo: string) { super('ATENDIMENTO_TRANSITORIO'); this.motivo = motivo; }
}
export function eTransitorio(erro: unknown): erro is ErroTransitorioAtendimento {
  return erro instanceof ErroTransitorioAtendimento || (erro instanceof Error && erro.message === 'ATENDIMENTO_TRANSITORIO');
}
/**
 * F7 (revisão da E-ME1): leitura de C1–C4 antes de ENVIANDO. Qualquer falha dela vira transitória: a tarefa volta para a
 * fila (nunca FALHOU nem fallback definitivo por uma indisponibilidade curta). Só para LEITURAS de portão; o envio e o
 * resultado do provedor continuam com o tratamento conservador de sempre.
 */
export async function lerPortao<T>(motivo: string, ler: () => Promise<T>): Promise<T> {
  try { return await ler(); }
  catch (erro) {
    if (erro instanceof ErroTransitorioAtendimento) throw erro;
    throw new ErroTransitorioAtendimento(motivo);
  }
}

/**
 * Planos que incluem o Atendimento WhatsApp (D-ME-1, 04/11/2026). Todos os planos comerciais do catálogo, salvo
 * indicação contrária de Felipe. A franquia de IA do plano (F1) segue separada.
 */
export const PLANOS_ATENDIMENTO_WHATSAPP: readonly PlanoComercialId[] = RECURSOS_POR_PLANO.ATENDIMENTO_WHATSAPP;

export type SituacaoDireito = 'PLANO_INCLUI' | 'PLANO_NAO_INCLUI' | 'ISENCAO' | 'TESTE' | 'LEGADO' | 'SEM_INFORMACAO';
/** D-ME-1: isenção e teste grátis SIM; legado e nenhuma informação NÃO. */
const DIREITO: Record<SituacaoDireito, boolean> = { PLANO_INCLUI: true, PLANO_NAO_INCLUI: false, ISENCAO: true, TESTE: true, LEGADO: false, SEM_INFORMACAO: false };

/**
 * C4 (§2.3), só para empresa não piloto no MULTI. Ordem fixa; a primeira situação que se aplica decide. NÃO reutiliza
 * recursoIncluido, que concede quando planoConfirmado devolve null (sem schema, isenção, teste ou legado juntos).
 *  1. schema comercial (074) ausente → transitório (antes de isenção e contrato);
 *  2. isenção → D-ME-1;
 *  3/4. contrato CONFIRMADA atual: plano inclui → SIM; não inclui → NÃO; plano desconhecido → transitório;
 *  5. teste grátis em curso → D-ME-1;
 *  6. assinatura sem contrato confirmado (legado) → D-ME-1;
 *  7. nada → NÃO.
 * Erro de consulta → transitório.
 */
export async function situacaoDireitoAtendimento(tx: DbExecutor, empresaId: string): Promise<SituacaoDireito> {
  try {
    if (!(await catalogo(tx)).comercial) throw new ErroTransitorioAtendimento('SCHEMA_COMERCIAL_INDISPONIVEL');
    if ((await tx.query<{ isenta: boolean }>('SELECT EXISTS (SELECT 1 FROM assinatura_isencoes WHERE empresa_id = $1::uuid) AS isenta', [empresaId])).rows[0]?.isenta === true) return 'ISENCAO';
    const contrato = (await tx.query<{ plano: string }>(`SELECT c.plano FROM empresa_assinaturas a
      JOIN assinatura_contratacoes c ON c.id=a.contratacao_atual_id AND c.empresa_id=a.empresa_id AND c.estado='CONFIRMADA'
      WHERE a.empresa_id=$1::uuid`, [empresaId])).rows[0];
    if (contrato) {
      const plano = contrato.plano.toLowerCase();
      if (!planoComercialValido(plano)) throw new ErroTransitorioAtendimento('PLANO_DESCONHECIDO');
      return PLANOS_ATENDIMENTO_WHATSAPP.includes(plano) ? 'PLANO_INCLUI' : 'PLANO_NAO_INCLUI';
    }
    const assinatura = (await tx.query<{ teste: boolean }>("SELECT situacao='TESTE' AND teste_fim > clock_timestamp() AS teste FROM empresa_assinaturas WHERE empresa_id=$1::uuid", [empresaId])).rows[0];
    if (assinatura?.teste) return 'TESTE';
    if (assinatura) return 'LEGADO';
    return 'SEM_INFORMACAO';
  } catch (erro) {
    if (erro instanceof ErroTransitorioAtendimento) throw erro;
    throw new ErroTransitorioAtendimento('LEITURA_COMERCIAL');
  }
}
export async function direitoAtendimentoWhatsApp(tx: DbExecutor, empresaId: string) {
  return DIREITO[await situacaoDireitoAtendimento(tx, empresaId)];
}

/** C2 de empresa não piloto: conexão Meta CONFIGURADA dela neste ambiente. */
export async function conexaoMetaConfigurada(tx: DbExecutor, empresaId: string, ambiente: string) {
  const ambienteConexao = ambiente === 'production' ? 'PRODUCTION' : 'STAGING';
  return (await tx.query("SELECT 1 FROM whatsapp_conexoes WHERE ambiente=$1 AND empresa_id=$2 AND status='CONFIGURADA'", [ambienteConexao, empresaId])).rows.length > 0;
}

export const ehPilotoDe = (empresaId: string, piloto: string | null) => !!piloto && empresaId.toLowerCase() === piloto.toLowerCase();
/**
 * Escopo operacional de uma empresa: a piloto sempre (com as regras atuais); outra empresa só no MULTI, com C2 e C4.
 * C1 (empresa ATIVA), C3 (configuração ligada) e K-PROC são conferidos por quem chama (o worker reúne tudo em
 * portaoOperacional). Falha de leitura: ErroTransitorioAtendimento.
 */
export async function empresaOperaAtendimento(tx: DbExecutor, empresaId: string, alvo: { piloto: string | null; ambiente: string; env?: NodeJS.ProcessEnv }) {
  if (ehPilotoDe(empresaId, alvo.piloto)) return true;
  try {
    if (await modoEfetivo(tx, alvo.env) !== 'MULTI') return false;
    if (!(await conexaoMetaConfigurada(tx, empresaId, alvo.ambiente))) return false;
  } catch (erro) {
    if (erro instanceof ErroTransitorioAtendimento) throw erro;
    throw new ErroTransitorioAtendimento('LEITURA_HABILITACAO');
  }
  return direitoAtendimentoWhatsApp(tx, empresaId);
}
/**
 * F4 (revisão da E-ME1): escrita de configuração e da biblioteca. A piloto como antes; outra empresa só com o modo
 * efetivo MULTI (chave + as duas tabelas da 117). Configurar DESLIGADO não exige C2 nem C4 (configurar antes de
 * conectar); LIGAR exige também empresaOperaAtendimento (C2 + C4). Leitura e privacidade nunca passam por aqui.
 */
export async function escritaPermitida(tx: DbExecutor, empresaId: string, alvo: { piloto: string | null; env?: NodeJS.ProcessEnv }) {
  if (ehPilotoDe(empresaId, alvo.piloto)) return true;
  return lerPortao('LEITURA_MODO', async () => (await modoEfetivo(tx, alvo.env)) === 'MULTI');
}

// ——— Rodízio (§4) ———

/** Chave da trava consultiva do rodízio, por ambiente. */
export const CHAVE_RODIZIO = (ambiente: string) => `wa-rodizio:${ambiente}`;

/**
 * Empresas candidatas à reserva, na ordem do rodízio: quem nunca foi atendida (sem linha) primeiro, depois `ordem`
 * crescente, desempate por empresa_id. Só empresas com mensagem PENDENTE no ambiente. Deve ser chamada DEPOIS de tomar a
 * trava consultiva do rodízio, na transação de reserva.
 */
export async function empresasNaOrdemDoRodizio(tx: DbExecutor, ambiente: string) {
  return (await tx.query<{ empresa_id: string }>(`SELECT p.empresa_id FROM (SELECT DISTINCT empresa_id FROM whatsapp_atendimento_mensagens WHERE ambiente=$1 AND estado='PENDENTE') p
    LEFT JOIN whatsapp_atendimento_rodizio r ON r.empresa_id=p.empresa_id AND r.ambiente=$1
    ORDER BY r.ordem ASC NULLS FIRST, p.empresa_id`, [ambiente])).rows.map((r) => r.empresa_id);
}
/** Grava a vez da empresa atendida: a maior `ordem` do ambiente + 1. Só a reserva, sob a trava do rodízio, chama. */
export async function registrarVezDoRodizio(tx: DbExecutor, empresaId: string, ambiente: string) {
  await tx.query(`INSERT INTO whatsapp_atendimento_rodizio(empresa_id,ambiente,ordem)
    VALUES($1,$2,(SELECT COALESCE(max(ordem),0)+1 FROM whatsapp_atendimento_rodizio WHERE ambiente=$2))
    ON CONFLICT(empresa_id,ambiente) DO UPDATE SET ordem=EXCLUDED.ordem,atualizado_em=clock_timestamp()`, [empresaId, ambiente]);
}

// ——— Status: trava por identificador e colisões (§5) ———

/** Trava por identificador do provedor: callback e gravação do identificador pelo worker se serializam. */
export async function travarProvedor(tx: DbExecutor, ambiente: string, provedorId: string) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`wa-prov:${ambiente}:${provedorId}`]);
}
let anomalias = 0;
export function contadorAnomaliasStatus() { return anomalias; }
function anomalia(motivo: 'COLISAO_DETECTADA' | 'MARCA_VIGENTE') {
  anomalias++;
  // Só o motivo: identificador, empresa e contato não vão para o log.
  console.warn('[Atendimento WhatsApp] status não aplicado: %s', motivo);
}
/**
 * Conferência de unicidade sob a trava por identificador. Devolve true quando o status PODE ser aplicado (nenhuma marca
 * vigente e no máximo uma saída com o identificador no ambiente). Detectada a duplicação, grava a marca (se a 117
 * estiver aplicada) e devolve false.
 */
export async function identificadorUnico(tx: DbExecutor, ambiente: string, provedorId: string) {
  const colisoes = await colisoesDisponivel(tx);
  if (colisoes && (await tx.query('SELECT 1 FROM whatsapp_atendimento_status_colisoes WHERE ambiente=$1 AND provedor_id=$2', [ambiente, provedorId])).rows.length) { anomalia('MARCA_VIGENTE'); return false; }
  const n = Number((await tx.query<{ n: string }>("SELECT count(*) AS n FROM whatsapp_atendimento_mensagens WHERE ambiente=$1 AND provedor_id=$2 AND direcao='SAIDA'", [ambiente, provedorId])).rows[0]?.n ?? 0);
  if (n <= 1) return true;
  if (colisoes) await tx.query('INSERT INTO whatsapp_atendimento_status_colisoes(ambiente,provedor_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [ambiente, provedorId]);
  anomalia('COLISAO_DETECTADA');
  return false;
}
/** Saídas com o identificador no ambiente, em todas as empresas (somente leitura). */
export async function saidasDoIdentificador(tx: DbExecutor, ambiente: string, provedorId: string) {
  return (await tx.query<{ id: string; empresa_id: string }>("SELECT id,empresa_id FROM whatsapp_atendimento_mensagens WHERE ambiente=$1 AND provedor_id=$2 AND direcao='SAIDA' LIMIT 3", [ambiente, provedorId])).rows;
}
/** Retenção das marcas de colisão: 30 dias, em lotes. Só com a 117. */
export const RETENCAO_COLISOES_DIAS = 30;
export async function limparColisoesExpiradas(tx: DbExecutor) {
  if (!(await colisoesDisponivel(tx))) return;
  await tx.query(`DELETE FROM whatsapp_atendimento_status_colisoes WHERE ctid IN (SELECT ctid FROM whatsapp_atendimento_status_colisoes
    WHERE detectada_em < clock_timestamp()-make_interval(days => $1) LIMIT 1000)`, [RETENCAO_COLISOES_DIAS]);
}
