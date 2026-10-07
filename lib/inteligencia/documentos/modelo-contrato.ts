import type { ArquivoValidado } from "../../importacao-contrato/arquivo.ts";
import { INSTRUCAO_LEITURA_CONTRATO, LEITURA_CONTRATO_JSON_SCHEMA, leituraContratoSchema, type LeituraContrato } from "../../contratos/modelo-empresa/leitura.ts";
import type { AlvoRoteamento, RoteadorModelos } from "../modelos/roteador.ts";
import { contarPaginas } from "./tabela-precos.ts";
import { validarLeitura } from "./validar-leitura.ts";

/**
 * Leitura do contrato em PDF da loja pelo modelo com visão: devolve o TEXTO do contrato com {{campos}} da lista
 * fechada no lugar dos dados de cada festa. É rascunho para revisão humana; o modelo não publica nem gera contrato.
 * Mesmo canal e gate da extração de documentos (AI_DOCUMENT_EXTERNAL_PROVIDER_ALLOWED).
 */
export type LeituraContratoResultado = { ok: true; leitura: LeituraContrato; modelo: string; provedor: string } | { ok: false; aviso: string };

export async function lerContratoComModelo(entrada: {
  roteador: RoteadorModelos | null;
  envioExterno: boolean;
  alvo: AlvoRoteamento;
  arquivo: ArquivoValidado;
}): Promise<LeituraContratoResultado> {
  const { roteador, envioExterno, alvo, arquivo } = entrada;
  if (!envioExterno) return { ok: false, aviso: "ENVIO_EXTERNO_NAO_AUTORIZADO" };
  if (!roteador || !roteador.disponivelPara("EXTRACAO_CONTRATO", true)) return { ok: false, aviso: "SEM_MODELO_COM_VISAO" };
  const r = await roteador.executar({
    workload: "EXTRACAO_CONTRATO",
    mensagens: [
      { papel: "system", conteudo: INSTRUCAO_LEITURA_CONTRATO },
      { papel: "user", conteudo: "Transforme o contrato do PDF anexo no modelo pedido." },
    ],
    arquivos: [{ mime: "application/pdf", nome: arquivo.nomeSeguro, base64: Buffer.from(arquivo.bytes).toString("base64"), paginas: contarPaginas(arquivo.bytes) }],
    esquema: { nome: "modelo_contrato", schema: LEITURA_CONTRATO_JSON_SCHEMA as unknown as Record<string, unknown> },
    maxTokensSaida: 32000,
    prazoMs: 150_000,
    validar: (texto) => validarLeitura(leituraContratoSchema, texto, "modelo de contrato"),
  }, alvo);
  if (!r.ok) return { ok: false, aviso: `MODELO_${r.causa}` };
  return { ok: true, leitura: r.valor, modelo: r.modelo, provedor: r.provedor };
}
