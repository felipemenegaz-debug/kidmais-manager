import type { DbExecutor } from "../../db/contracts.ts";
import { MarketingError } from "../erros.ts";

/**
 * Contrato do provedor de domínio (verificação de DNS + certificado/hospedagem). Neste goal SÓ existe o SIMULADO:
 * ele consulta a tabela marketing_dns_simulado (o "DNS" de mentira) e "emite" certificado sem rede. Nenhuma chamada
 * externa, nenhuma credencial. A homologação de um provedor real (ex.: domínios personalizados do Render) é fase futura
 * e precisa de adaptador próprio, autorização e testes de contrato contra a documentação vigente.
 */
export type ResultadoVerificacao = {
  ok: boolean;
  txt: boolean;
  apontamento: boolean;
  detalhe: string;
  simulado: boolean;
  verificadoEm: string;
};

export interface ProvedorDominio {
  readonly nome: "SIMULADO";
  readonly simulado: true;
  verificar(host: string, esperado: { txtNome: string; txtValor: string; tipo: "A" | "CNAME"; valor: string }): Promise<ResultadoVerificacao>;
  provisionar(host: string): Promise<{ ok: boolean; detalhe: string }>;
  liberar(host: string): Promise<void>;
}

export function provedorSimulado(tx: DbExecutor, agora: () => Date = () => new Date()): ProvedorDominio {
  return {
    nome: "SIMULADO",
    simulado: true,
    async verificar(host, esperado) {
      const r = await tx.query<{ tipo: string; nome: string; valor: string }>(
        `SELECT tipo, nome, valor FROM marketing_dns_simulado WHERE host = $1`, [host]);
      const txt = r.rows.some((l) => l.tipo === "TXT" && l.nome === esperado.txtNome && l.valor === esperado.txtValor);
      const apontamento = r.rows.some((l) => l.tipo === esperado.tipo && l.nome === host && l.valor === esperado.valor);
      return {
        ok: txt && apontamento, txt, apontamento, simulado: true, verificadoEm: agora().toISOString(),
        detalhe: txt && apontamento ? "DNS simulado conferido." : !txt ? "Registro TXT de verificação não encontrado (simulado)." : "Apontamento não encontrado (simulado).",
      };
    },
    async provisionar() {
      return { ok: true, detalhe: "Certificado HTTPS SIMULADO (nenhum certificado real foi emitido)." };
    },
    async liberar() {
      // Nada a liberar no provedor simulado.
    },
  };
}

/** Escolha do provedor por ambiente. Só "simulado" existe; qualquer outro valor recusa (fail-closed, sem rede). */
export function provedorDoAmbiente(tx: DbExecutor, env: { [nome: string]: string | undefined; MARKETING_DOMINIO_PROVEDOR?: string } = process.env): ProvedorDominio {
  const nome = (env.MARKETING_DOMINIO_PROVEDOR ?? "simulado").trim().toLowerCase();
  if (nome !== "simulado") {
    throw new MarketingError("MARKETING_PROVEDOR_DOMINIO_INDISPONIVEL", "Provedor de domínio real não está disponível neste ambiente.", 503);
  }
  return provedorSimulado(tx);
}
