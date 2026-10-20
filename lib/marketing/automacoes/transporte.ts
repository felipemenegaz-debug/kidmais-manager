import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { DbExecutor } from "../../db/contracts.ts";
import { MarketingError } from "../erros.ts";
import { mascararTelefone } from "./modelo.ts";

/**
 * Transporte de mensagens do Marketing. Contrato pequeno e explícito; neste goal SÓ existe o SIMULADO, que grava a
 * mensagem numa caixa de saída local (marketing_transporte_simulado) e nunca abre rede. Não há adaptador real: selecionar
 * outro transporte recusa (TRANSPORTE_NAO_CONFIGURADO), sem fallback.
 *
 * Classificação de erro (o processador decide pelo tipo):
 *   RECUSADO     o provedor recusou e NADA saiu (número/modelo inválido) → FALHOU sem nova tentativa automática;
 *   TEMPORARIO   o provedor confirmou que NADA saiu (limite, indisponível) → nova tentativa com espera, até o máximo;
 *   DESCONHECIDO não se sabe se saiu (tempo esgotado) → INCERTA, nunca reenviada sozinha.
 * Ganchos de simulação por número sintético: final 0000 = recusado; 1111 = temporário; 9999 = desconhecido.
 */
export type ErroTransporte = "RECUSADO" | "TEMPORARIO" | "DESCONHECIDO";
export class FalhaTransporte extends Error {
  readonly tipo: ErroTransporte;
  constructor(tipo: ErroTransporte, mensagem: string) { super(mensagem); this.name = "FalhaTransporte"; this.tipo = tipo; }
}

export type MensagemSaida = { empresaId: string; execucaoId: string; idempotencia: string; telefone: string; templateProvedor: string; texto: string };

export interface TransporteMarketing {
  readonly nome: "SIMULADO";
  readonly simulado: true;
  enviar(m: MensagemSaida): Promise<{ provedorMensagemId: string }>;
}

/** Simulado: idempotente pela chave (mesma chave → mesmo id, sem segunda gravação). Usa conexão própria, fora da transação. */
export function transporteSimulado(conexao: () => DbExecutor): TransporteMarketing {
  return {
    nome: "SIMULADO",
    simulado: true,
    async enviar(m) {
      if (!/^[a-z0-9_]{3,64}$/.test(m.templateProvedor)) throw new FalhaTransporte("RECUSADO", "Modelo do provedor ausente ou inválido.");
      if (!/^\d{10,15}$/.test(m.telefone)) throw new FalhaTransporte("RECUSADO", "Número inválido.");
      if (m.telefone.endsWith("0000")) throw new FalhaTransporte("RECUSADO", "Simulação: número recusado pelo provedor.");
      if (m.telefone.endsWith("1111")) throw new FalhaTransporte("TEMPORARIO", "Simulação: provedor indisponível (nada foi enviado).");
      if (m.telefone.endsWith("9999")) throw new FalhaTransporte("DESCONHECIDO", "Simulação: tempo esgotado sem confirmação.");
      const db = conexao();
      const novo = `sim_${randomUUID()}`;
      const r = await db.query<{ provedor_mensagem_id: string }>(
        `INSERT INTO marketing_transporte_simulado (empresa_id, execucao_id, idempotencia, provedor_mensagem_id, destinatario_mascarado, template_provedor, texto)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)
         ON CONFLICT (idempotencia) DO UPDATE SET atualizado_em = marketing_transporte_simulado.atualizado_em
         RETURNING provedor_mensagem_id`,
        [m.empresaId, m.execucaoId, m.idempotencia, novo, mascararTelefone(m.telefone), m.templateProvedor, m.texto]);
      return { provedorMensagemId: r.rows[0].provedor_mensagem_id };
    },
  };
}

export function transporteDoAmbiente(conexao: () => DbExecutor, env: { [nome: string]: string | undefined } = process.env): TransporteMarketing {
  const nome = (env.MARKETING_TRANSPORTE ?? "simulado").trim().toLowerCase();
  if (nome !== "simulado") throw new MarketingError("TRANSPORTE_NAO_CONFIGURADO", "Transporte real de mensagens não está disponível neste ambiente.", 503);
  return transporteSimulado(conexao);
}

/** Processamento só com MARKETING_AUTOMACOES_ENABLED=true (interruptor global; desligado por padrão). */
export function automacoesHabilitadas(env: { [nome: string]: string | undefined } = process.env) {
  return env.MARKETING_AUTOMACOES_ENABLED?.trim() === "true";
}

/** Assinatura do retorno de status do provedor simulado: HMAC-SHA256 hex do corpo com o segredo local. */
export function assinarRetorno(segredo: string, corpo: string) {
  return createHmac("sha256", segredo).update(corpo).digest("hex");
}

export function assinaturaConfere(segredo: string | undefined, corpo: string, recebida: string | null) {
  if (!segredo || segredo.length < 16 || !recebida || !/^[a-f0-9]{64}$/.test(recebida)) return false;
  const esperada = Buffer.from(assinarRetorno(segredo, corpo), "hex");
  const veio = Buffer.from(recebida, "hex");
  return esperada.length === veio.length && timingSafeEqual(esperada, veio);
}
