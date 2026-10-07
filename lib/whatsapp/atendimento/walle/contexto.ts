import { INTENCOES, TEMAS_CONTRATO, type CampoPendente, type ContextoWallE, type Entendimento, type TemaContrato, type TipoIntencao } from './tipos.ts';

/**
 * Memória do Wall-e na conversa: só dados citados pelo próprio cliente (revalidados) e o que o Wall-e já enviou.
 * Correção: o valor novo substitui o anterior e fica registrado ("na verdade serão 80 convidados" troca 60 por 80).
 * Limites: tamanho fixo (sem crescer sem fim) e nenhum dado pessoal além do que o cliente informou para a festa.
 */
const LIMITE_CORRECOES = 10, LIMITE_ENVIADOS = 30, LIMITE_REFERENCIAS = 10, LIMITE_ASSUNTOS = 8;
const SEM_ASSUNTO: readonly TipoIntencao[] = ['SAUDACAO', 'CONFIRMACAO', 'OUTRO'];
type Campo = 'data' | 'turno' | 'convidados' | 'pacote' | 'unidade' | 'tema';

/** Contexto lido do banco: aceita só as chaves conhecidas, com os tipos esperados (o resto é ignorado). */
export function lerContexto(bruto: unknown): ContextoWallE {
  const c = (bruto && typeof bruto === 'object' ? bruto : {}) as Record<string, unknown>;
  const texto = (v: unknown, max = 80) => (typeof v === 'string' && v.length <= max ? v : null);
  const enviados = Array.isArray(c.enviados) ? c.enviados.filter((e): e is NonNullable<ContextoWallE['enviados']>[number] =>
    !!e && typeof e === 'object' && typeof (e as { prontaId?: unknown }).prontaId === 'string' && Number.isInteger((e as { versao?: unknown }).versao)).slice(-LIMITE_ENVIADOS) : [];
  const pendente = c.pendente && typeof c.pendente === 'object' && Array.isArray((c.pendente as { campos?: unknown }).campos) ? c.pendente as ContextoWallE['pendente'] : null;
  return {
    data: texto(c.data, 10), turno: texto(c.turno, 40), convidados: Number.isInteger(c.convidados) ? (c.convidados as number) : null,
    pacote: texto(c.pacote, 60), unidade: texto(c.unidade, 40), tema: texto(c.tema, 60),
    dataConfirmada: texto(c.dataConfirmada, 10),
    mes: Number.isInteger(c.mes) && (c.mes as number) >= 1 && (c.mes as number) <= 12 ? (c.mes as number) : null,
    referencias: Array.isArray(c.referencias) ? c.referencias.filter((r): r is string => typeof r === 'string').slice(-LIMITE_REFERENCIAS) : [],
    enviados, pendente,
    assuntos: Array.isArray(c.assuntos) ? c.assuntos.filter((a): a is TipoIntencao => typeof a === 'string' && (INTENCOES as readonly string[]).includes(a)).slice(-LIMITE_ASSUNTOS) : [],
    clausulas: Array.isArray(c.clausulas) ? c.clausulas.filter((t): t is TemaContrato => typeof t === 'string' && t !== 'GERAL' && (TEMAS_CONTRATO as readonly string[]).includes(t)).slice(0, 3) : [],
    correcoes: Array.isArray(c.correcoes) ? (c.correcoes as ContextoWallE['correcoes'])!.slice(-LIMITE_CORRECOES) : [],
    ultimoEntendimento: (c.ultimoEntendimento as ContextoWallE['ultimoEntendimento']) ?? null,
  };
}

/** Junta o entendimento desta mensagem à memória: valores novos vencem; mudança vira correção registrada. */
export function mesclarContexto(anterior: ContextoWallE, entendimento: Entendimento, agora: string): ContextoWallE {
  const c: ContextoWallE = { ...anterior, correcoes: [...(anterior.correcoes ?? [])], referencias: [...(anterior.referencias ?? [])] };
  const e = entendimento.entidades;
  const novos: Partial<Record<Campo, unknown>> = {
    data: e.data, turno: e.turno, convidados: e.convidados, unidade: e.unidade, tema: e.tema,
    // Um único pacote citado vira o pacote de interesse; vários citados são comparação (não trocam o escolhido).
    pacote: e.pacotes.length === 1 && !entendimento.comparar ? e.pacotes[0] : null,
  };
  // Rodada 27: festa já contratada (dele ou de outra pessoa): o que ela cita ("trocar o tema pra Wandinha", a data dela)
  // é da festa contratada, com a equipe — não altera o contexto comercial da conversa.
  const daFestaContratada = entendimento.intencoes.some((i) => i.tipo === 'CONTRATO_PROPRIO');
  for (const [campo, valor] of (daFestaContratada ? [] : Object.entries(novos)) as [Campo, unknown][]) {
    if (valor === null || valor === undefined) continue;
    const antes = (c as Record<string, unknown>)[campo] ?? null;
    if (antes !== null && antes !== valor) c.correcoes!.push({ campo, de: antes, para: valor, em: agora });
    (c as Record<string, unknown>)[campo] = valor;
  }
  c.correcoes = c.correcoes!.slice(-LIMITE_CORRECOES);
  // Rodada 25: o mês citado sem dia fica para o "dia N" seguinte; uma data completa o substitui.
  if (daFestaContratada) { /* mês da festa contratada também não entra */ }
  else if (entendimento.mesCitado) c.mes = entendimento.mesCitado;
  else if (e.data) c.mes = null;
  // Rodada 26: data sem ano é PROPOSTA (próxima ocorrência). Para a contratação ela vale só confirmada: o ano escrito na
  // mensagem, ou a resposta à data completa proposta ("sim", ou a mesma data de novo).
  const proposta = anterior.pendente?.confirmarData ?? null;
  if (e.data && entendimento.anoCitado) c.dataConfirmada = e.data;
  else if (proposta && proposta === c.data && (e.data === proposta || (!e.data && (entendimento.concorda || entendimento.intencoes.some((i) => i.tipo === 'CONFIRMACAO'))))) c.dataConfirmada = proposta;
  const assuntos = [...(anterior.assuntos ?? [])];
  for (const i of entendimento.intencoes) if (!SEM_ASSUNTO.includes(i.tipo)) { const k = assuntos.indexOf(i.tipo); if (k >= 0) assuntos.splice(k, 1); assuntos.push(i.tipo); }
  c.assuntos = assuntos.slice(-LIMITE_ASSUNTOS);
  // Só os códigos das cláusulas desta mensagem (a próxima pode ser o complemento delas); a mensagem sem cláusula zera.
  c.clausulas = [...new Set(entendimento.intencoes.filter((i) => i.tipo === 'CONTRATO' && i.tema && i.tema !== 'GERAL').map((i) => i.tema as TemaContrato))].slice(0, 3);
  c.ultimoEntendimento = entendimento;
  return c;
}

export function registrarEnviado(c: ContextoWallE, item: { prontaId: string; versao: number; finalidade: string }, agora: string): ContextoWallE {
  return { ...c, enviados: [...(c.enviados ?? []), { ...item, em: agora }].slice(-LIMITE_ENVIADOS) };
}
/** Já enviado NESTA versão (versão nova do material conta como material novo). */
export function jaEnviado(c: ContextoWallE, prontaId: string, versao: number) {
  return (c.enviados ?? []).some((e) => e.prontaId === prontaId && e.versao === versao);
}
/** `opcional`: convite depois de uma resposta completa; a conversa não fica esperando esse dado. */
export function comPendente(c: ContextoWallE, campos: CampoPendente[], para: TipoIntencao, opcional = false): ContextoWallE {
  return { ...c, pendente: campos.length ? { campos: [...new Set(campos)], para, ...(opcional ? { opcional: true } : {}) } : null };
}
