import { z } from "zod";
import type { MotivoRecusaAcao } from "./acoes.ts";

/**
 * Regras puras da rota de ações da família (F3), sem Next nem banco: o corpo aceito (zod estrito, uma ação por vez)
 * e a mensagem de cada recusa. Testadas em acoes.test.ts.
 */
export const corpoAcaoFamilia = z.discriminatedUnion("acao", [
  z.object({ acao: z.literal("AVISAR_PAGAMENTO"), parcela: z.string().uuid(), observacao: z.string().max(280).nullish() }).strict(),
  z.object({ acao: z.literal("PENDENCIA_FEITA"), pendencia: z.string().uuid() }).strict(),
  z.object({
    acao: z.literal("CONVIDAR_SEGUNDO"),
    nome: z.string().trim().min(1).max(120),
    whatsapp: z.string().max(40),
    documento: z.string().max(20).nullish(),
  }).strict(),
  z.object({ acao: z.literal("LINK_SEGUNDO") }).strict(),
  z.object({ acao: z.literal("REMOVER_SEGUNDO") }).strict(),
]);

export const MENSAGENS_ACAO: Record<MotivoRecusaAcao, readonly [string, number]> = {
  NAO_ENCONTRADO: ["Não encontramos este item. Atualize a página.", 404],
  PARCELA_SEM_SALDO: ["Esta parcela já está paga.", 409],
  AVISO_JA_ENVIADO: ["Você já avisou o buffet sobre esta parcela. Aguarde a conferência.", 409],
  PENDENCIA_INDISPONIVEL: ["Este item já foi encerrado pelo buffet.", 409],
  PENDENCIA_JA_FEITA: ["Você já marcou este item como feito.", 409],
  SO_CONTRATANTE: ["Só quem contratou a festa pode convidar ou remover pessoas.", 403],
  SEGUNDO_JA_CADASTRADO: ["Já existe um segundo responsável. Remova o atual antes de convidar outro.", 409],
  SEGUNDO_AUSENTE: ["Não há segundo responsável nesta festa.", 409],
  DADOS_INVALIDOS: ["Confira os dados informados.", 400],
};
