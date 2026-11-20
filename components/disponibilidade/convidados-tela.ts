/**
 * S-C (convidados primeiro): regras da tela pública de disponibilidade, sem React, para os testes de cliente.
 * O servidor só manda contagens e motivos (nunca ids ou nomes de salão); aqui viram os textos do calendário e dos períodos.
 */
import type { CapacidadeConvidadosPublica, DisponibilidadeDataPublica } from "../../lib/disponibilidade/services/models.ts";
import type { ContatoPublico } from "../../lib/fechamentos/marca-publica.ts";

export type EstadoDia = "NEUTRO" | "MINIMO" | "DISPONIVEL" | "PARCIAL" | "INDISPONIVEL" | "SEM_SALAO" | "SEM_PACOTE";

/** Menor cobrança possível no dia, somente quando todo período vendável exige mínimo. */
export function minimoDoDia(dia?: DisponibilidadeDataPublica) {
  const livres = dia?.periodos.filter(p => p.status === "DISPONIVEL") ?? [];
  if (!livres.length || livres.some(p => p.minimoFaturavel == null)) return null;
  return Math.min(...livres.map(p => p.minimoFaturavel!));
}

export function legendaMinimo(dias: DisponibilidadeDataPublica[], convidados: number | null) {
  const minimos = new Set(dias.map(minimoDoDia).filter(n => n !== null));
  if (!minimos.size || !convidados) return null;
  return minimos.size === 1 ? `Mínimo de ${[...minimos][0]} convidados` : `Cobrança mínima acima de ${convidados} convidados`;
}

/** Dia do calendário: sem salão para N (motivo CAPACIDADE) tem estado próprio, diferente de ocupado. */
export function estadoDoDia(info: DisponibilidadeDataPublica | undefined): EstadoDia {
  if (!info) return "NEUTRO";
  const disponiveis = info.periodos.filter((p) => p.status === "DISPONIVEL").length;
  if (disponiveis === 0 && info.periodos.some(p => p.motivoComercial)) return "SEM_PACOTE";
  if (disponiveis === 0) return info.motivoDia?.motivo === "CAPACIDADE" ? "SEM_SALAO" : "INDISPONIVEL";
  if (minimoDoDia(info) !== null) return "MINIMO";
  return disponiveis < info.periodos.length ? "PARCIAL" : "DISPONIVEL";
}

/** Texto do período ou do horário; null = sem capacidade por salão (texto de antes). */
export function textoCapacidade(capacidade: CapacidadeConvidadosPublica | undefined, convidados: number | null) {
  if (!capacidade || !convidados) return null;
  if (capacidade.motivo === "CAPACIDADE") return `Sem salão para ${convidados}`;
  if (capacidade.motivo === "OCUPADO") return "Indisponível";
  return capacidade.opcoes === 1 ? "Só 1 opção de salão" : `${capacidade.opcoes} opções de salão`;
}

/**
 * Datas próximas com espaço: até `limite` dias já carregados (mês na tela), a partir de hoje, com algum período
 * disponível, do mais perto ao mais longe da data escolhida. Sem consulta extra.
 */
export function datasProximas(porData: Record<string, DisponibilidadeDataPublica>, selecionada: string, hoje: string, limite = 3, periodos?: readonly string[], semMinimo = false) {
  const alvo = Date.parse(`${selecionada}T12:00:00Z`);
  return Object.values(porData)
    .filter((d) => d.data >= hoje && d.data !== selecionada && d.periodos.some((p) => p.status === "DISPONIVEL" && (!semMinimo || p.minimoFaturavel == null) && (!periodos || periodos.includes(p.codigo))))
    .map((d) => ({ data: d.data, distancia: Math.abs(Date.parse(`${d.data}T12:00:00Z`) - alvo) }))
    .sort((a, b) => a.distancia - b.distancia || a.data.localeCompare(b.data))
    .slice(0, limite)
    .map((d) => d.data)
    .sort();
}

/** Só anuncia um padrão semanal se cada dia da semana repetir o mesmo resultado no intervalo. */
export function resumoSemanal(dias: DisponibilidadeDataPublica[], convidados: number | null) {
  if (!convidados || dias.length < 14) return null;
  const semana = new Map<number,string>();
  for (const dia of dias) {
    const nomes = dia.periodos.filter(p => p.status === "DISPONIVEL").map(p => p.nome);
    if (nomes.length > 1) return null;
    const turno = nomes[0] ?? "";
    const indice = new Date(dia.data + "T12:00:00Z").getUTCDay();
    if (semana.has(indice) && semana.get(indice) !== turno) return null;
    semana.set(indice,turno);
  }
  if (semana.size !== 7 || semana.get(0) || semana.get(6)) return null;
  const nome = semana.get(1);
  if (!nome || ![2,3,4,5].every(d => semana.get(d) === nome)) return null;
  return `Para ${convidados} convidados, há disponibilidade de segunda a sexta no período ${nome}, neste intervalo.`;
}

/** Usa uma ocorrência realmente vendável, sem prometer recorrência fora da vigência. */
export function exemploDeAtendimento(dia: DisponibilidadeDataPublica | undefined, convidados: number | null, codigos?: string[]) {
  const periodo = dia?.periodos.find(p => p.status === "DISPONIVEL" && (!codigos || codigos.includes(p.codigo)));
  if (!dia || !periodo || !convidados) return null;
  const data = new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })
    .format(new Date(dia.data + "T12:00:00Z"));
  return `Para ${convidados} convidados, temos disponibilidade em ${data} (${periodo.nome}).`;
}

export function whatsappComMensagem(endereco: string, mensagem?: string) {
  if (!URL.canParse(endereco)) return null;
  const url = new URL(endereco);
  if (!["https:", "http:"].includes(url.protocol)) return null;
  if (mensagem) url.searchParams.set("text", mensagem);
  return url.href;
}

/** "Falar com o buffet": o primeiro contato publicado da empresa (WhatsApp, telefone, e-mail, site); null = sem link. */
export function linkContatoBuffet(contato: ContatoPublico | null | undefined) {
  if (!contato) return null;
  if (contato.whatsapp) return contato.whatsapp.url;
  if (contato.telefone) return contato.telefone.url;
  if (contato.email) return `mailto:${contato.email}`;
  return contato.site?.url ?? null;
}

/** `convidados` da URL do /fechamento (vindo da disponibilidade): inteiro de 1 a 150 (teto do pedido online), senão null. */
export function convidadosDaUrl(valor: string | null | undefined) {
  if (!valor || !/^\d{1,3}$/.test(valor.trim())) return null;
  const n = Number(valor.trim());
  return n >= 1 && n <= 150 ? n : null;
}

/** P3-R2: último dia do mês seguinte ao (ano, mesZero); a faixa mês visível + seguinte tem no máximo 62 dias. */
export function fimDoMesSeguinte(ano: number, mesZero: number) {
  const fim = new Date(Date.UTC(ano, mesZero + 2, 0));
  return { ano: fim.getUTCFullYear(), mes: fim.getUTCMonth(), dia: fim.getUTCDate() };
}

/** Dias do mês visível (o mapa também traz o mês seguinte, só para as sugestões). */
export function doMes(porData: Record<string, DisponibilidadeDataPublica>, ano: number, mesZero: number) {
  const prefixo = `${ano}-${String(mesZero + 1).padStart(2, "0")}-`;
  return Object.values(porData).filter((d) => d.data.startsWith(prefixo));
}
