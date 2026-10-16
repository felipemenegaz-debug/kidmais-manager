/**
 * Explicação das automações em linguagem de quem opera o buffet (UX de 15/10/2026). Só APRESENTAÇÃO: descreve
 * fielmente os valores configurados e o comportamento do motor (gatilhos em alvos.ts, janela em janela.ts, frequência e
 * revalidação em motor.ts, elegibilidade em preferencias.ts); não muda nenhuma regra de negócio.
 */
import type { AcaoRegra, TipoRegra } from "./regras.ts";

type RegraExplicavel = {
  tipo: TipoRegra; acao: AcaoRegra; esperaDias: number; janelaInicio: string; janelaFim: string; fuso: string; fimDeSemana: boolean;
  limiteFrequenciaDias: number; maxTentativas: number;
};

const dias = (n: number) => `${n} dia${n === 1 ? "" : "s"}`;

/** Rótulo do prazo de cada regra (o mesmo número tem sentidos diferentes por tipo). */
export const ROTULO_PRAZO: Record<TipoRegra, string> = {
  PROPOSTA_PARADA: "Dias sem movimentação na negociação",
  POS_FESTA: "Dias depois da festa",
  RECOMPRA: "Dias antes de completar um ano da última festa",
  DATAS_VAGAS: "",
};

/** “Quando acontecer”: o gatilho com o prazo aplicado. */
export function quandoAcontece(r: Pick<RegraExplicavel, "tipo" | "esperaDias">) {
  switch (r.tipo) {
    case "PROPOSTA_PARADA": return `Quando uma negociação em andamento (aguardando aprovação, aprovada ou aguardando contrato) ficar ${dias(r.esperaDias)} sem movimentação, com a festa ainda no futuro e sem contrato assinado ou cancelado`;
    case "POS_FESTA": return r.esperaDias === 0
      ? "No dia de uma festa com contrato assinado (festas dos últimos 14 dias entram, para nenhuma ficar de fora)"
      : `Quando fizer ${dias(r.esperaDias)} de uma festa com contrato assinado (festas dos últimos 14 dias entram, para nenhuma ficar de fora)`;
    case "RECOMPRA": return `${r.esperaDias} dias antes de completar um ano da última festa com contrato assinado do cliente, se ele não tiver outra festa marcada (uma vez por ano)`;
    case "DATAS_VAGAS": return "Quando houver datas com horários livres na agenda dos próximos dias";
  }
}

/** “Fazer”: a ação. */
export function oQueFaz(acao: AcaoRegra) {
  if (acao === "TAREFA_INTERNA") return "criar uma tarefa para a equipe";
  if (acao === "MENSAGEM_WHATSAPP") return "enviar uma mensagem de WhatsApp para o número autorizado do cliente";
  return "mostrar a sugestão para a equipe revisar";
}

/** Janela e dias permitidos (vale para tarefa e mensagem: o agendamento cai no próximo horário permitido). */
export function horarioPermitido(r: Pick<RegraExplicavel, "janelaInicio" | "janelaFim" | "fuso" | "fimDeSemana">) {
  const diasSemana = r.fimDeSemana ? "todos os dias" : "de segunda a sexta";
  const fuso = r.fuso === "America/Sao_Paulo" ? "horário de Brasília" : `fuso ${r.fuso}`;
  return `entre ${r.janelaInicio} e ${r.janelaFim} (${fuso}), ${diasSemana}`;
}

/** Frase-resumo fiel à configuração. */
export function resumoRegra(r: RegraExplicavel) {
  if (r.tipo === "DATAS_VAGAS" || r.acao === "SUGESTAO") {
    return "Mostra datas com horários livres para a equipe revisar e divulgar em uma campanha. Nada é enviado, reservado ou descontado automaticamente.";
  }
  const base = `${quandoAcontece(r)}, ${oQueFaz(r.acao)}, ${horarioPermitido(r)}.`;
  if (r.acao !== "MENSAGEM_WHATSAPP") return base;
  return `${base} No máximo uma mensagem automática por cliente a cada ${dias(r.limiteFrequenciaDias)} (somando todas as regras); até ${r.maxTentativas} tentativa${r.maxTentativas === 1 ? "" : "s"} se o provedor estiver temporariamente indisponível.`;
}

/** Situações das execuções (histórico). “Aceita” não é “entregue”: só o provedor confirma entrega. */
export const ROTULO_ESTADO: Record<string, string> = {
  AGENDADA: "Agendada", PROCESSANDO: "Processando", ENVIANDO: "Enviando", TAREFA_CRIADA: "Tarefa criada",
  ACEITA: "Mensagem aceita pelo transporte simulado (não é confirmação de entrega)", ENTREGUE: "Entregue (confirmado pelo provedor)",
  FALHOU: "Falhou", INCERTA: "Resultado incerto (conferir antes de repetir)", SUPRIMIDA: "Não enviada (impedimento)", CANCELADA: "Cancelada",
};

/** Motivos que o backend registra (impedimentos e cancelamentos); nada além disso é inventado na tela. */
export const ROTULO_MOTIVO: Record<string, string> = {
  SEM_AUTORIZACAO: "cliente sem autorização confirmada para mensagens",
  SEM_AUTORIZACAO_DESTINO: "a autorização é de um número que não está no cadastro atual",
  DESCADASTRADO: "cliente pediu para não receber mensagens (descadastro)",
  SEM_TELEFONE: "cliente sem telefone no cadastro",
  NAO_CONTATAR_ATENDIMENTO: "pediu para não ser contatado no atendimento",
  CLIENTE_INATIVO: "cliente inativo",
  LIMITE_FREQUENCIA: "já recebeu mensagem automática dentro do limite de frequência",
  ALVO_NAO_ELEGIVEL: "a situação mudou e a condição deixou de valer",
  REGRA_INATIVA: "regra pausada", REGRA_PAUSADA: "regra pausada", INTERRUPCAO_DA_EMPRESA: "interrupção geral (Parar tudo)",
  ACAO_ALTERADA: "a ação da regra mudou", TEXTO_ALTERADO_SEM_REVISAO: "o texto mudou e precisa de nova revisão",
  MODELO_NAO_REVISADO: "texto sem revisão humana", RETORNO: "falha informada pelo provedor", EMPRESA_INAPTA: "empresa sem acesso ao Marketing no momento",
};

/** Motivo legível; o prefixo `EMPRESA_INAPTA: <detalhe>` do motor vira o rótulo geral + detalhe técnico. */
export function motivoLegivel(m: string | null) {
  if (!m) return "";
  const [codigo, ...resto] = m.split(":");
  const rotulo = ROTULO_MOTIVO[codigo.trim()];
  return rotulo ? (resto.length ? `${rotulo} (${resto.join(":").trim()})` : rotulo) : m;
}

/** Quem pode receber mensagem (regra real de elegivelParaMensagem), em linguagem simples. */
export const QUEM_RECEBE = [
  "Só recebe quem tem autorização CONFIRMADA para um número que ainda está no cadastro (WhatsApp primeiro, depois telefone).",
  "Autorização pendente (ex.: número novo vindo do site) ou revogada não vale; a equipe confirma na seção Preferências.",
  "Quem pediu descadastro, pediu “não contatar” no atendimento, está inativo ou sem telefone não recebe.",
  "Tudo é conferido de novo no momento do envio: se algo mudou, a mensagem não sai e o motivo fica no histórico.",
];

/** Dados FICTÍCIOS da prévia da mensagem (identificados como tal na tela). */
export const EXEMPLO_FICTICIO = { nome: "Ana Exemplo", buffet: "Seu Buffet", dataFesta: "2027-03-20" };

type RegraSalva = { status: "RASCUNHO" | "ATIVA" | "PAUSADA" | "NAO_CONFIGURADA"; acao: AcaoRegra; templateRevisadoEm: string | null };

/**
 * Retorno de "salvar regra" a partir da regra DEVOLVIDA pelo servidor (não do estado anterior da tela). `salvarRegra`
 * pausa uma regra ativa de mensagem quando o texto/modelo muda ou quando a ação vira mensagem sem texto revisado, e
 * cancela o que estava agendado; prazo, horários e tarefa mantêm a regra ativa.
 */
export function retornoAoSalvarRegra(antes: Pick<RegraSalva, "status">, salva: RegraSalva): { tipo: "ok" | "alerta"; texto: string } {
  const precisaRevisao = salva.acao === "MENSAGEM_WHATSAPP" && !salva.templateRevisadoEm;
  if (salva.status === "ATIVA") return { tipo: "ok", texto: "Regra salva e continua ativa. O que já estava agendado é conferido de novo com a regra atual antes de agir." };
  if (salva.status === "PAUSADA" && antes.status === "ATIVA") {
    return { tipo: "alerta", texto: "Regra salva e PAUSADA: o texto da mensagem precisa de uma nova revisão. As mensagens que estavam agendadas foram canceladas. Revise o texto e ative de novo." };
  }
  if (salva.status === "PAUSADA") return { tipo: "ok", texto: precisaRevisao ? "Regra salva; continua pausada. Revise o texto antes de ativar." : "Regra salva; continua pausada." };
  return { tipo: "ok", texto: precisaRevisao ? "Regra salva como rascunho (não está ativa). Revise o texto antes de ativar." : "Regra salva como rascunho (não está ativa)." };
}
