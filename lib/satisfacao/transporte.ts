import { randomUUID } from "node:crypto";
import type { DbExecutor } from "../db/contracts.ts";
import { mascararEmail } from "../acessos/validacao.ts";
import { MarketingError } from "../marketing/erros.ts";
import { FalhaTransporte } from "../marketing/automacoes/transporte.ts";
import { mascararTelefone } from "../marketing/automacoes/modelo.ts";
import { MARCADOR_LINK } from "./fragmento.ts";

/**
 * Transportes da pesquisa de satisfação (plano R9). Neste goal só existem os SIMULADOS, que gravam numa caixa de saída
 * local e nunca abrem rede. Selecionar outro transporte recusa, sem fallback, e o e-mail nunca é inferido de RESEND_API_KEY.
 *
 * Cada mensagem chega com duas versões do texto: `texto` (com o link, só para um transporte real) e `textoGravavel` (com
 * o marcador "[link da pesquisa]" no lugar do link). As caixas de saída gravam só a versão gravável: o token não é
 * gravado em lugar nenhum. Classificação de erro igual à do Marketing (RECUSADO, TEMPORARIO, DESCONHECIDO).
 *
 * Ganchos de simulação:
 *   WhatsApp — número final 0000 = recusado; 1111 = temporário; 9999 = desconhecido (os mesmos do Marketing);
 *   e-mail   — domínio recusado.test, temporario.test e incerto.test.
 */
export type MensagemWhatsappPesquisa = {
  empresaId: string; execucaoId: string; entregaId: string; idempotencia: string; telefone: string; templateProvedor: string; texto: string; textoGravavel: string;
};
export type MensagemEmailPesquisa = {
  empresaId: string; entregaId: string; idempotencia: string; nomeRemetente: string; replyTo: string | null; para: string; assunto: string;
  html: string; texto: string; textoGravavel: string;
};

export interface TransportesPesquisa {
  readonly nome: "SIMULADO";
  enviarWhatsapp(m: MensagemWhatsappPesquisa): Promise<{ provedorMensagemId: string }>;
  enviarEmail(m: MensagemEmailPesquisa): Promise<{ provedorMensagemId: string }>;
}

/** Defesa final: um texto gravável nunca leva o link (só o marcador). */
function semLink(textoGravavel: string, texto: string) {
  const token = /#([A-Za-z0-9_-]{72})/.exec(texto)?.[1];
  if (/\/p\/satisfacao#/.test(textoGravavel) || (token && textoGravavel.includes(token))) {
    throw new FalhaTransporte("RECUSADO", "Conteúdo gravável com o link da pesquisa.");
  }
  return textoGravavel;
}

export function transportesSimulados(conexao: () => DbExecutor): TransportesPesquisa {
  return {
    nome: "SIMULADO",
    async enviarWhatsapp(m) {
      if (!/^[a-z0-9_]{3,64}$/.test(m.templateProvedor)) throw new FalhaTransporte("RECUSADO", "Modelo do provedor ausente ou inválido.");
      if (!/^\d{10,15}$/.test(m.telefone)) throw new FalhaTransporte("RECUSADO", "Número inválido.");
      if (m.telefone.endsWith("0000")) throw new FalhaTransporte("RECUSADO", "Simulação: número recusado pelo provedor.");
      if (m.telefone.endsWith("1111")) throw new FalhaTransporte("TEMPORARIO", "Simulação: provedor indisponível (nada foi enviado).");
      if (m.telefone.endsWith("9999")) throw new FalhaTransporte("DESCONHECIDO", "Simulação: tempo esgotado sem confirmação.");
      const texto = semLink(m.textoGravavel, m.texto);
      // Mesma caixa de saída do Marketing; execucao_id é a execução que criou a pesquisa (o envio guarda o vínculo).
      const r = await conexao().query<{ provedor_mensagem_id: string }>(
        `INSERT INTO marketing_transporte_simulado (empresa_id, execucao_id, idempotencia, provedor_mensagem_id, destinatario_mascarado, template_provedor, texto)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)
         ON CONFLICT (idempotencia) DO UPDATE SET atualizado_em = marketing_transporte_simulado.atualizado_em
         RETURNING provedor_mensagem_id`,
        [m.empresaId, m.execucaoId, m.idempotencia, `sim_${randomUUID()}`, mascararTelefone(m.telefone), m.templateProvedor, texto.slice(0, 1200)]);
      return { provedorMensagemId: r.rows[0].provedor_mensagem_id };
    },
    async enviarEmail(m) {
      if (!emailValido(m.para)) throw new FalhaTransporte("RECUSADO", "Endereço de e-mail inválido.");
      const dominio = m.para.split("@")[1]!.toLowerCase();
      if (dominio === "recusado.test") throw new FalhaTransporte("RECUSADO", "Simulação: endereço recusado pelo provedor.");
      if (dominio === "temporario.test") throw new FalhaTransporte("TEMPORARIO", "Simulação: provedor indisponível (nada foi enviado).");
      if (dominio === "incerto.test") throw new FalhaTransporte("DESCONHECIDO", "Simulação: tempo esgotado sem confirmação.");
      const texto = semLink(m.textoGravavel, `${m.texto}\n${m.html}`);
      const r = await conexao().query<{ provedor_mensagem_id: string }>(
        `INSERT INTO satisfacao_email_simulado (empresa_id, entrega_id, idempotencia, provedor_mensagem_id, para_mascarado, assunto, texto)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)
         ON CONFLICT (idempotencia) DO UPDATE SET aceito_em = satisfacao_email_simulado.aceito_em
         RETURNING provedor_mensagem_id`,
        [m.empresaId, m.entregaId, m.idempotencia, `sim_${randomUUID()}`, mascararEmail(m.para), m.assunto.slice(0, 200), texto.slice(0, 4000)]);
      return { provedorMensagemId: r.rows[0].provedor_mensagem_id };
    },
  };
}

/** E-mail aceito para a pesquisa: um endereço simples, sem espaços nem quebras (o mesmo critério do despacho). */
export function emailValido(email: string | null | undefined): email is string {
  return typeof email === "string" && email.length <= 254 && /^[^\s@<>()",;:]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(email);
}

/**
 * Seleção explícita: WhatsApp segue MARKETING_TRANSPORTE e o e-mail, SATISFACAO_EMAIL_TRANSPORTE; os dois só aceitam
 * "simulado" (o padrão). Qualquer outro valor recusa — não há adaptador real neste goal.
 */
export function transportesDoAmbiente(conexao: () => DbExecutor, env: { [nome: string]: string | undefined } = process.env): TransportesPesquisa {
  const whatsapp = (env.MARKETING_TRANSPORTE ?? "simulado").trim().toLowerCase();
  const email = (env.SATISFACAO_EMAIL_TRANSPORTE ?? "simulado").trim().toLowerCase();
  if (whatsapp !== "simulado" || email !== "simulado") throw new MarketingError("TRANSPORTE_NAO_CONFIGURADO", "Transporte real da pesquisa não está disponível neste ambiente.", 503);
  return transportesSimulados(conexao);
}

export { MARCADOR_LINK };
