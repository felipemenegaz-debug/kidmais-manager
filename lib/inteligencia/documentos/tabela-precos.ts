import { ZodError } from "zod";
import { validarArquivoEnviado, type ArquivoValidado } from "../../importacao-contrato/arquivo.ts";
import { INSTRUCAO_LEITURA_TABELA, LEITURA_JSON_SCHEMA, leituraSchema, type LeituraTabela } from "../../comercial/importacao-tabela/esquema.ts";
import { PacoteAdminError } from "../../comercial/pacotes-admin.ts";
import type { AlvoRoteamento, RoteadorModelos } from "../modelos/roteador.ts";

/**
 * Leitura da tabela de preços em PDF pelo modelo com visão. O PDF inteiro vai como arquivo (texto e imagem de cada
 * página: funciona com artes exportadas como imagem) e a saída é um JSON fechado, validado de novo aqui. É DADO para
 * revisão humana: nada é gravado e o modelo não recebe tenant, ferramenta nem conexão.
 *
 * Mesmo canal da extração de contratos: só roda com envio externo autorizado (AI_DOCUMENT_EXTERNAL_PROVIDER_ALLOWED).
 */
export type LeituraTabelaResultado =
  | { ok: true; leitura: LeituraTabela; modelo: string; provedor: string }
  | { ok: false; aviso: string };

/** Páginas do PDF (contagem simples de objetos /Page) só para estimar custo. */
export function contarPaginas(bytes: Uint8Array) {
  const texto = Buffer.from(bytes).toString("latin1");
  return Math.max(1, (texto.match(/\/Type\s*\/Page(?![a-z])/g) ?? []).length);
}

export async function lerTabelaComModelo(entrada: {
  roteador: RoteadorModelos | null;
  envioExterno: boolean;
  alvo: AlvoRoteamento;
  arquivo: ArquivoValidado;
}): Promise<LeituraTabelaResultado> {
  const { roteador, envioExterno, alvo, arquivo } = entrada;
  if (!envioExterno) return { ok: false, aviso: "ENVIO_EXTERNO_NAO_AUTORIZADO" };
  if (!roteador || !roteador.disponivelPara("EXTRACAO_CONTRATO", true)) return { ok: false, aviso: "SEM_MODELO_COM_VISAO" };
  const r = await roteador.executar({
    workload: "EXTRACAO_CONTRATO",
    mensagens: [
      { papel: "system", conteudo: INSTRUCAO_LEITURA_TABELA },
      { papel: "user", conteudo: "Leia a tabela de preços do PDF anexo e responda no formato pedido." },
    ],
    arquivos: [{ mime: "application/pdf", nome: arquivo.nomeSeguro, base64: Buffer.from(arquivo.bytes).toString("base64"), paginas: contarPaginas(arquivo.bytes) }],
    esquema: { nome: "tabela_precos", schema: LEITURA_JSON_SCHEMA as unknown as Record<string, unknown> },
    maxTokensSaida: 16000,
    prazoMs: 150_000,
    validar: (texto) => leituraSchema.parse(JSON.parse(texto)),
  }, alvo);
  if (!r.ok) return { ok: false, aviso: `MODELO_${r.causa}` };
  return { ok: true, leitura: r.valor, modelo: r.modelo, provedor: r.provedor };
}

type ArquivoRecebido = { nome: string; tipo: string; bytes: Uint8Array };
type Tenant = { empresaComprovada: string; papelAtual: string };
type Ctx = { empresaId: string; usuarioId: string; requestId: string };

/** Falha do envio (corpo grande, lento, inválido), com status HTTP. */
export class EnvioRecusado extends Error {
  readonly status: number;
  readonly codigo: string;
  constructor(codigo: string, mensagem: string, status: number) {
    super(mensagem);
    this.codigo = codigo;
    this.status = status;
  }
}

/**
 * Envio (ou releitura) da tabela pela tela. Portas injetadas pela rota (composition root): Tenant Context real e os
 * serviços do Core que guardam o PDF e a revisão. Só quem gere a empresa; a empresa não pode mudar entre as etapas.
 */
export async function atenderLeituraTabela<Tx>(
  entrada: { importacaoId: string | null; lerArquivo: () => Promise<ArquivoRecebido> },
  deps: {
    emTenant: <T>(trabalho: (tx: Tx, tenant: Tenant) => Promise<T>) => Promise<T>;
    registrar: (tx: Tx, ctx: Ctx, arquivo: ArquivoValidado) => Promise<string>;
    arquivoDe: (tx: Tx, empresaId: string, id: string) => Promise<ArquivoValidado>;
    gravar: (tx: Tx, ctx: Ctx, id: string, leitura: LeituraTabelaResultado) => Promise<unknown>;
    usuarioId: string;
    requestId: string;
    limiteBytes: number;
    hoje: string;
    roteador: RoteadorModelos | null;
    envioExterno: boolean;
  },
): Promise<{ status: number; corpo: Record<string, unknown> }> {
  const gestao = (t: Tenant) => {
    if (t.papelAtual !== "REPRESENTANTE_AUTORIZADO") throw new PacoteAdminError("PAPEL_NAO_AUTORIZADO", "Apenas o proprietário pode importar a tabela de preços.", 403);
  };
  try {
    const empresaId = await deps.emTenant(async (_tx, t) => { gestao(t); return t.empresaComprovada; });
    const ctx: Ctx = { empresaId, usuarioId: deps.usuarioId, requestId: deps.requestId };
    const mesmaEmpresa = (t: Tenant) => {
      gestao(t);
      if (t.empresaComprovada !== empresaId) throw new PacoteAdminError("EMPRESA_ALTERADA", "A empresa ativa mudou durante a leitura.", 409);
    };
    let id = entrada.importacaoId;
    let arquivo: ArquivoValidado;
    if (id) {
      const existente = id;
      arquivo = await deps.emTenant(async (tx, t) => { mesmaEmpresa(t); return deps.arquivoDe(tx, empresaId, existente); });
    } else {
      const recebido = await entrada.lerArquivo();
      const validado = validarArquivoEnviado({ nome: recebido.nome, tipoDeclarado: recebido.tipo, bytes: recebido.bytes, limiteBytes: deps.limiteBytes });
      if (!validado.ok) return { status: 415, corpo: { ok: false, erro: validado.mensagem, codigo: validado.codigo } };
      const novo = validado.arquivo;
      arquivo = novo;
      id = await deps.emTenant(async (tx, t) => { mesmaEmpresa(t); return deps.registrar(tx, ctx, novo); });
    }
    const leitura = await lerTabelaComModelo({
      roteador: deps.roteador, envioExterno: deps.envioExterno, arquivo,
      alvo: { empresaId, capacidade: "extrair_documento", correlationId: deps.requestId, hoje: deps.hoje },
    });
    const importacao = id;
    const data = await deps.emTenant(async (tx, t) => { mesmaEmpresa(t); return deps.gravar(tx, ctx, importacao, leitura); });
    return { status: 200, corpo: { ok: true, data } };
  } catch (error) {
    if (error instanceof EnvioRecusado) return { status: error.status, corpo: { ok: false, erro: error.message, codigo: error.codigo } };
    if (error instanceof PacoteAdminError) return { status: error.httpStatus, corpo: { ok: false, erro: error.message, codigo: error.code } };
    if (error instanceof ZodError) return { status: 400, corpo: { ok: false, erro: "Dados inválidos.", codigo: "DADOS_INVALIDOS" } };
    throw error;
  }
}
