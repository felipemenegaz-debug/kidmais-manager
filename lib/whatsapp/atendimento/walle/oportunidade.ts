import { createHash } from 'node:crypto';
import type { DbExecutor } from '../../../db/contracts.ts';
import type { MotivoPassagem, ResultadoWallE, TipoIntencao } from './tipos.ts';

/**
 * Wall-e fatia 1a (LOCAL 23/11/2026; D-WA-2 e D-WA-3 de Felipe; desenho em orquestracao/loop/walle-funil-1a-20261123).
 * Conversa com pedido de festa NOVA vira (ou atualiza) um cartão em "Novo contato" do funil (marketing_contatos, canal
 * WHATSAPP), com o vínculo na 132 (whatsapp_atendimento_oportunidades).
 *
 * - O modelo só classifica: a qualificação lê códigos e entidades validados, nunca grava texto do cliente no cartão.
 * - A resposta só grava a MARCA (oportunidade_pendente_em) sob um savepoint; o cartão é gravado depois, ao fim do lote do
 *   worker, em transação própria por conversa. Falha na captura nunca impede nem atrasa a resposta, e a marca é a fila de
 *   recuperação (o próximo lote tenta de novo, sem depender de nova mensagem).
 * - Um cartão ABERTO por telefone (empresa e ambiente), sob trava consultiva; cartão novo só depois de o anterior fechar.
 * - Nenhuma atribuição, evento de histórico, autorização de contato ou automação de Marketing é criada (1b).
 * Dependências mínimas (só tipos e node:crypto): as provas em PG montam este módulo dentro do worker e da privacidade.
 */

/** Intenções que, sozinhas, já são pedido de festa nova. */
const INTENCOES_PEDIDO: readonly TipoIntencao[] = ['PRECOS', 'DISPONIBILIDADE', 'PACOTES', 'CONTRATAR'];
/** Intenções que afastam o cartão: contrato já existente, pedido de parar ou fora do assunto. */
const INTENCOES_BLOQUEIAM: readonly TipoIntencao[] = ['CONTRATO_PROPRIO', 'PARAR', 'EXTERNO'];
/** Passagens que não são pedido de festa nova (suporte a contrato, pagamento, reclamação, instrução, parar). */
const PASSAGENS_BLOQUEIAM: readonly MotivoPassagem[] = ['CONTRATO_PROPRIO', 'PAGAMENTO', 'RECLAMACAO', 'INSTRUCAO_SUSPEITA', 'PARAR_A_CONFIRMAR', 'BLOQUEADO_A_PEDIDO'];
/** Estados de negociação que ainda estão no funil (os mesmos de lib/oportunidades/consultas.ts). */
export const FECHAMENTO_ABERTO = ['RASCUNHO', 'AGUARDANDO_APROVACAO', 'APROVADO', 'AGUARDANDO_CONTRATO', 'CONTRATO_ASSINADO', 'AGUARDANDO_PAGAMENTO'] as const;
export const NOME_ANONIMIZADO = 'Contato anonimizado';
export const TELEFONE_ANONIMIZADO = '0000000000';

/** D-WA-2: só pedido de festa NOVA (data, convidados, orçamento ou visita) qualifica. Função pura, sem banco. */
export function qualificaPedidoFesta(resultado: Pick<ResultadoWallE, 'contexto' | 'passagem' | 'parar' | 'silencio'>): boolean {
  if (resultado.parar || resultado.silencio) return false;
  const e = resultado.contexto?.ultimoEntendimento;
  if (!e) return false;
  if (e.parar || e.sinais?.pagamento || e.sinais?.pagamentoAcao || e.sinais?.reclamacao || e.sinais?.instrucao) return false;
  const tipos = (e.intencoes ?? []).map(i => i.tipo);
  if (tipos.some(t => INTENCOES_BLOQUEIAM.includes(t))) return false;
  const motivos = [resultado.passagem?.motivo, ...(resultado.passagem?.motivos ?? [])].filter(Boolean) as MotivoPassagem[];
  if (motivos.some(m => PASSAGENS_BLOQUEIAM.includes(m))) return false;
  if (tipos.some(t => INTENCOES_PEDIDO.includes(t))) return true;
  if ((e.intencoes ?? []).some(i => i.consultaComum === 'ORCAMENTO_INFORMADO' || i.consultaComum === 'VISITA_MARCADA')) return true;
  return !!e.entidades?.data || (typeof e.entidades?.convidados === 'number' && e.entidades.convidados > 0);
}

/**
 * Nome do cartão: o nome de perfil do WhatsApp higienizado (rótulo NÃO verificado na tela): controles, formatação
 * invisível e espaços extras fora, até 120 caracteres. Sem nome útil (ausente ou com menos de 2 caracteres):
 * "WhatsApp final NNNN".
 */
export function nomeDoCartao(perfil: unknown, telefone: string): string {
  const limpo = typeof perfil === 'string' ? perfil.normalize('NFC').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim() : '';
  const cortado = [...limpo].slice(0, 120).join('').trim();
  return [...cortado].length >= 2 ? cortado : `WhatsApp final ${telefone.replace(/\D/g, '').slice(-4)}`;
}

/** Telefone com e sem o DDI 55 (a mesma regra de lib/marketing/contatos.ts variantesTelefone; paridade em teste). */
export function variantesDoTelefone(digitos: string): string[] {
  const v = new Set([digitos]);
  if (/^55\d{10,11}$/.test(digitos)) v.add(digitos.slice(2));
  if (/^\d{10,11}$/.test(digitos)) v.add(`55${digitos}`);
  return [...v];
}
/** Forma única do número para a trava (com e sem 55 caem na mesma trava). */
function telefoneCanonico(digitos: string) {
  return /^55\d{10,11}$/.test(digitos) ? digitos.slice(2) : digitos;
}
/** Chave de idempotência do cartão: n-ésimo cartão do Wall-e desta conversa (reentrega e corrida não duplicam). */
export function chaveDoCartao(empresa: string, ambiente: string, conversa: string, n: number) {
  return `wa${createHash('sha256').update(`${empresa}|${ambiente}|${conversa}|${n}`).digest('hex').slice(0, 40)}`;
}

/** Marca de pendência gravada na transação da resposta, sob savepoint: qualquer falha volta ao savepoint e a resposta segue. */
export async function marcarPendente(tx: DbExecutor, conversaId: string): Promise<boolean> {
  await tx.query('SAVEPOINT walle_oportunidade');
  try {
    await tx.query('UPDATE whatsapp_atendimento_conversas SET oportunidade_pendente_em=clock_timestamp() WHERE id=$1', [conversaId]);
    await tx.query('RELEASE SAVEPOINT walle_oportunidade');
    return true;
  } catch {
    await tx.query('ROLLBACK TO SAVEPOINT walle_oportunidade');
    await tx.query('RELEASE SAVEPOINT walle_oportunidade');
    return false;
  }
}

export type ResultadoCaptura = 'CRIADO' | 'ATUALIZADO' | 'SEM_MUDANCA' | 'JA_ABERTO' | 'IGNORADO' | 'SEM_PENDENCIA';
type ConversaCaptura = { id: string; empresa_id: string; ambiente: string; contato: string; nao_contatar: boolean; contexto: Record<string, unknown> | null;
  interesse: { data?: unknown; convidados?: unknown } | null; nome_perfil?: string | null; oportunidade_pendente_em: string | null };

function dataValida(v: unknown) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T12:00:00Z`)) ? v : null; }
function convidadosValidos(v: unknown) { const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,4}$/.test(v) ? Number(v) : NaN; return Number.isInteger(n) && n >= 1 && n <= 5000 ? n : null; }

/**
 * Captura de UMA conversa marcada, na transação de quem chama (uma por conversa). A conversa é travada (SKIP LOCKED:
 * outra captura ou o worker com ela = tenta no próximo lote). Sucesso ou descarte limpam a marca na mesma transação.
 */
export async function capturarOportunidade(tx: DbExecutor, conversaId: string): Promise<ResultadoCaptura> {
  const linha = (await tx.query<{ c: ConversaCaptura }>('SELECT to_jsonb(c) AS c FROM whatsapp_atendimento_conversas c WHERE c.id=$1 AND c.oportunidade_pendente_em IS NOT NULL FOR UPDATE SKIP LOCKED', [conversaId])).rows[0];
  if (!linha) return 'SEM_PENDENCIA';
  const c = linha.c;
  const limpar = () => tx.query('UPDATE whatsapp_atendimento_conversas SET oportunidade_pendente_em=NULL WHERE id=$1', [c.id]);
  const semAutomatico = !!c.contexto && typeof c.contexto.semAutomatico === 'object' && c.contexto.semAutomatico !== null;
  const parar = (await tx.query("SELECT 1 FROM whatsapp_atendimento_controles_contato WHERE empresa_id=$1 AND ambiente=$2 AND contato=$3 AND nao_contatar LIMIT 1", [c.empresa_id, c.ambiente, c.contato])).rows.length > 0;
  // nao_contatar (ou pedido de parar herdado) nunca vira cartão; número fora do formato do funil também não.
  if (c.nao_contatar || semAutomatico || parar || !/^[0-9]{10,15}$/.test(c.contato)) { await limpar(); return 'IGNORADO'; }
  const variantes = variantesDoTelefone(c.contato);
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`walle-oportunidade|${c.empresa_id}|${c.ambiente}|${telefoneCanonico(c.contato)}`]);
  const data = dataValida(c.interesse?.data), convidados = convidadosValidos(c.interesse?.convidados);
  // Cartão aberto de qualquer origem: contato em aberto sem negociação, ou contato com negociação aberta (cartões do Wall-e
  // de outro ambiente e anonimizados não contam).
  const aberto = (await tx.query<{ id: string; walle: boolean; novo_contato: boolean; data: string | null; convidados: number | null }>(
    `SELECT k.id, o.contato_id IS NOT NULL AS walle, (k.fechamento_id IS NULL AND k.status IN ('NOVO','EM_ATENDIMENTO')) AS novo_contato,
       k.data_desejada::text AS data, k.convidados
     FROM marketing_contatos k LEFT JOIN whatsapp_atendimento_oportunidades o ON o.contato_id=k.id
     WHERE k.empresa_id=$1 AND k.telefone = ANY($2::text[]) AND (o.contato_id IS NULL OR (o.ambiente=$3 AND o.anonimizado_em IS NULL))
       AND ((k.fechamento_id IS NULL AND k.status IN ('NOVO','EM_ATENDIMENTO'))
         OR EXISTS (SELECT 1 FROM fechamentos f WHERE f.empresa_id=k.empresa_id AND f.id=k.fechamento_id AND f.status = ANY($4::text[])))
     ORDER BY (o.conversa_id = $5::uuid) DESC NULLS LAST, k.recebido_em DESC, k.id LIMIT 1`, [c.empresa_id, variantes, c.ambiente, FECHAMENTO_ABERTO, c.id])).rows[0];
  if (aberto) {
    // Só o cartão do Wall-e ainda em "Novo contato" é atualizado; cartão do site, manual ou em negociação é da equipe.
    if (aberto.walle && aberto.novo_contato && ((data && data !== aberto.data) || (convidados && convidados !== aberto.convidados))) {
      await tx.query('UPDATE marketing_contatos SET data_desejada=COALESCE($2::date,data_desejada),convidados=COALESCE($3::int,convidados),atualizado_em=clock_timestamp() WHERE id=$1 AND empresa_id=$4',
        [aberto.id, data, convidados, c.empresa_id]);
      await limpar(); return 'ATUALIZADO';
    }
    await limpar(); return aberto.walle && aberto.novo_contato ? 'SEM_MUDANCA' : 'JA_ABERTO';
  }
  // Negociação aberta de cliente com este telefone (sem contato do funil): também é cartão aberto.
  const negociacao = (await tx.query(`SELECT 1 FROM fechamentos f JOIN clientes cl ON cl.empresa_id=f.empresa_id AND cl.id=f.cliente_id
     WHERE f.empresa_id=$1 AND f.status = ANY($3::text[]) AND cl.status <> 'MESCLADO' AND (cl.telefone = ANY($2::text[]) OR cl.whatsapp = ANY($2::text[])) LIMIT 1`,
    [c.empresa_id, variantes, FECHAMENTO_ABERTO])).rows.length > 0;
  if (negociacao) { await limpar(); return 'JA_ABERTO'; }
  // Cliente só com correspondência ÚNICA de cliente ATIVO (nunca cria cadastro).
  const clientes = (await tx.query<{ id: string }>(`SELECT DISTINCT id::text FROM clientes WHERE empresa_id=$1 AND status='ATIVO'
     AND (telefone = ANY($2::text[]) OR whatsapp = ANY($2::text[])) LIMIT 2`, [c.empresa_id, variantes])).rows;
  const clienteId = clientes.length === 1 ? clientes[0].id : null;
  const n = Number((await tx.query<{ n: string }>('SELECT count(*) AS n FROM whatsapp_atendimento_oportunidades WHERE empresa_id=$1 AND ambiente=$2 AND conversa_id=$3', [c.empresa_id, c.ambiente, c.id])).rows[0]?.n ?? 0) + 1;
  const criado = (await tx.query<{ id: string }>(`INSERT INTO marketing_contatos(empresa_id,cliente_id,canal_atendimento,nome,telefone,data_desejada,convidados,chave_idempotencia,vinculo_cliente,status)
     VALUES($1,$2,'WHATSAPP',$3,$4,$5::date,$6::int,$7,$8,'NOVO') ON CONFLICT (empresa_id, chave_idempotencia) DO NOTHING RETURNING id::text`,
    [c.empresa_id, clienteId, nomeDoCartao(c.nome_perfil, c.contato), c.contato, data, convidados, chaveDoCartao(c.empresa_id, c.ambiente, c.id, n), clienteId ? 'EXISTENTE_CONTATO' : 'SEM_CLIENTE'])).rows[0];
  if (!criado) { await limpar(); return 'JA_ABERTO'; }
  await tx.query('INSERT INTO whatsapp_atendimento_oportunidades(contato_id,empresa_id,ambiente,conversa_id) VALUES($1,$2,$3,$4)', [criado.id, c.empresa_id, c.ambiente, c.id]);
  await limpar();
  return 'CRIADO';
}

export type Transacao = <T>(trabalho: (tx: DbExecutor) => Promise<T>) => Promise<T>;
/** Código seguro de uma falha (nunca a mensagem, que pode carregar dado do banco). */
function codigoFalha(erro: unknown) {
  const code = (erro as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? `SQLSTATE_${code}` : 'ERRO_INTERNO';
}

/**
 * Recuperação independente: ao fim de cada lote do worker, até `limite` conversas marcadas do ambiente, uma transação por
 * conversa, com falha isolada (a marca fica e o próximo lote tenta de novo). Sem a 132 (coluna ausente) não faz nada.
 */
export async function capturarOportunidadesPendentes(leitor: DbExecutor, transacao: Transacao, ambiente: string, limite = 10) {
  const saida = { capturas: 0, falhas: [] as string[], resultados: [] as ResultadoCaptura[] };
  let ids: string[];
  try {
    ids = (await leitor.query<{ id: string }>('SELECT id::text FROM whatsapp_atendimento_conversas WHERE oportunidade_pendente_em IS NOT NULL AND ambiente=$1 ORDER BY oportunidade_pendente_em, id LIMIT $2', [ambiente, limite])).rows.map(r => r.id);
  } catch (erro) {
    if ((erro as { code?: string }).code === '42703') return saida; // 132 ainda não aplicada
    saida.falhas.push(codigoFalha(erro)); return saida;
  }
  for (const id of ids) {
    try {
      const r = await transacao(tx => capturarOportunidade(tx, id));
      saida.resultados.push(r);
      if (r !== 'SEM_PENDENCIA') saida.capturas++;
    } catch (erro) { saida.falhas.push(codigoFalha(erro)); }
  }
  return saida;
}

/**
 * D-WA-3, dentro da exclusão a pedido do titular (antes de apagar a conversa): o cartão do Wall-e desta conversa SEM
 * cliente e SEM negociação é anonimizado (nome e telefone trocados por texto neutro, demais dados pessoais nulos) e fica
 * só como número na estatística; DELETE segue proibido pela 085. Cartão com cliente ou negociação (já convertido) fica
 * intacto: segue a Guarda dos clientes. Sem a 132, nada a fazer.
 */
export async function anonimizarOportunidadesDaConversa(tx: DbExecutor, empresa: string, ambiente: string, conversaId: string) {
  if (!(await tx.query<{ ok: boolean }>("SELECT to_regclass('public.whatsapp_atendimento_oportunidades') IS NOT NULL AS ok")).rows[0]?.ok) return { anonimizados: 0, preservados: 0 };
  const vinculos = (await tx.query<{ contato_id: string; convertido: boolean }>(`SELECT o.contato_id::text, (k.cliente_id IS NOT NULL OR k.fechamento_id IS NOT NULL) AS convertido
     FROM whatsapp_atendimento_oportunidades o JOIN marketing_contatos k ON k.id=o.contato_id AND k.empresa_id=o.empresa_id
     WHERE o.empresa_id=$1 AND o.ambiente=$2 AND o.conversa_id=$3 AND o.anonimizado_em IS NULL ORDER BY o.contato_id FOR UPDATE OF o, k`, [empresa, ambiente, conversaId])).rows;
  // perda_observacao chega com a 122; sem ela, o resto da anonimização vale igual.
  const comPerda = (await tx.query<{ ok: boolean }>("SELECT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.marketing_contatos') AND attname='perda_observacao' AND NOT attisdropped) AS ok")).rows[0]?.ok;
  const perda = comPerda ? 'perda_observacao=NULL,' : '';
  let anonimizados = 0;
  for (const v of vinculos) {
    if (v.convertido) continue;
    await tx.query(`UPDATE marketing_contatos SET nome=$3,telefone=$4,email=NULL,mensagem=NULL,data_desejada=NULL,convidados=NULL,${perda}atualizado_em=clock_timestamp()
      WHERE id=$1 AND empresa_id=$2`, [v.contato_id, empresa, NOME_ANONIMIZADO, TELEFONE_ANONIMIZADO]);
    await tx.query('UPDATE whatsapp_atendimento_oportunidades SET anonimizado_em=clock_timestamp() WHERE contato_id=$1', [v.contato_id]);
    anonimizados++;
  }
  return { anonimizados, preservados: vinculos.length - anonimizados };
}
