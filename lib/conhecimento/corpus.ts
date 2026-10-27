import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Corpus de conhecimento do canal MCP (RAG textual inicial, sem vetor e sem inferência). docs/MCP_ASSINATURAS_V1.md.
 *
 * Fonte aprovada → manifesto versionado → fragmentos por seção → índice textual → recuperação → citação.
 * - Só entra o que o MANIFESTO lista. O manifesto declara id, versão, vigência, situação e ACL de cada documento;
 *   nada é inferido do nome do arquivo. Arquivo fora do padrão, ausente ou com hash diferente invalida o corpus inteiro.
 * - Sem uploader/editor: o corpus é arquivo do repositório, revisado como código.
 * - Só APROVADO e vigente aparece. PENDENTE_APROVACAO, SUSPENSO e REVOGADO nunca aparecem em busca nem em trecho.
 * - Conteúdo é DADO: nunca altera permissões, escopo ou o comportamento das ferramentas.
 */
export const SITUACOES = ["APROVADO", "PENDENTE_APROVACAO", "SUSPENSO", "REVOGADO"] as const;
export type SituacaoDocumento = (typeof SITUACOES)[number];

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const data = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const aclSchema = z.discriminatedUnion("tipo", [
  z.object({ tipo: z.literal("PLATAFORMA") }).strict(),
  z.object({ tipo: z.literal("EMPRESA"), empresaId: uuid }).strict(),
  z.object({ tipo: z.literal("UNIDADE"), empresaId: uuid, estabelecimentoId: uuid }).strict(),
]);
export type AclDocumento = z.infer<typeof aclSchema>;

const entradaManifesto = z.object({
  arquivo: z.string().regex(/^[a-z0-9][a-z0-9-]{0,80}\.md$/),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  titulo: z.string().min(1).max(160),
  versao: z.number().int().min(1).max(100_000),
  vigenteDesde: data,
  vigenteAte: data.nullable(),
  situacao: z.enum(SITUACOES),
  acl: aclSchema,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export const manifestoSchema = z.object({
  versao: z.literal(1),
  documentos: z.array(entradaManifesto).max(500),
}).strict();
export type ManifestoCorpus = z.infer<typeof manifestoSchema>;

export type SecaoDocumento = { indice: number; titulo: string; texto: string };
export type DocumentoConhecimento = Omit<z.infer<typeof entradaManifesto>, "arquivo" | "sha256"> & { secoes: readonly SecaoDocumento[] };
export type Corpus = { documentos: readonly DocumentoConhecimento[] };

export class CorpusInvalido extends Error {
  constructor(motivo: string) {
    super(`Corpus de conhecimento inválido: ${motivo}`);
    this.name = "CorpusInvalido";
  }
}

const LIMITE_ARQUIVO = 200_000;
const LIMITE_SECAO = 8_000;

/** Fragmentação por seção "## ". O texto antes da primeira seção vira a seção "Introdução". */
export function segmentar(markdown: string): SecaoDocumento[] {
  const linhas = markdown.replace(/\r\n?/g, "\n").split("\n");
  const secoes: SecaoDocumento[] = [];
  let titulo = "Introdução";
  let corpo: string[] = [];
  const fechar = () => {
    const texto = corpo.join("\n").replace(/^# .*$/m, "").trim();
    if (texto) secoes.push({ indice: secoes.length, titulo, texto: texto.slice(0, LIMITE_SECAO) });
  };
  for (const linha of linhas) {
    const m = /^##\s+(.+?)\s*$/.exec(linha);
    if (m) {
      fechar();
      titulo = m[1].slice(0, 160);
      corpo = [];
    } else {
      corpo.push(linha);
    }
  }
  fechar();
  return secoes;
}

/**
 * Monta o corpus a partir do manifesto e de um leitor de arquivo restrito ao diretório do corpus (a rota injeta um que
 * só lê `data/conhecimento/<arquivo>`). Hash conferido arquivo a arquivo; qualquer divergência falha fechado.
 */
export function montarCorpus(manifestoBruto: unknown, lerArquivo: (arquivo: string) => string | null): Corpus {
  const parsed = manifestoSchema.safeParse(manifestoBruto);
  if (!parsed.success) throw new CorpusInvalido("manifesto fora do schema");
  const ids = new Set<string>();
  const documentos: DocumentoConhecimento[] = [];
  for (const entrada of parsed.data.documentos) {
    if (ids.has(entrada.id)) throw new CorpusInvalido(`id duplicado ${entrada.id}`);
    ids.add(entrada.id);
    if (entrada.vigenteAte !== null && entrada.vigenteAte < entrada.vigenteDesde) throw new CorpusInvalido(`vigência invertida em ${entrada.id}`);
    const conteudo = lerArquivo(entrada.arquivo);
    if (conteudo === null || conteudo.length > LIMITE_ARQUIVO) throw new CorpusInvalido(`arquivo ausente ou grande demais em ${entrada.id}`);
    const sha = createHash("sha256").update(conteudo, "utf8").digest("hex");
    if (sha !== entrada.sha256) throw new CorpusInvalido(`hash divergente em ${entrada.id}`);
    documentos.push({
      id: entrada.id, titulo: entrada.titulo, versao: entrada.versao, vigenteDesde: entrada.vigenteDesde, vigenteAte: entrada.vigenteAte,
      situacao: entrada.situacao, acl: entrada.acl, secoes: segmentar(conteudo),
    });
  }
  return { documentos };
}

/** Quem consulta: sempre a empresa da concessão. Unidade só quando provada (o MVP não prova unidade ⇒ null). */
export type EscopoLeitor = { empresaId: string; estabelecimentoId: string | null };

export function visivel(doc: DocumentoConhecimento, leitor: EscopoLeitor, hoje: string): boolean {
  if (doc.situacao !== "APROVADO") return false;
  if (doc.vigenteDesde > hoje) return false;
  if (doc.vigenteAte !== null && doc.vigenteAte < hoje) return false;
  const acl = doc.acl;
  if (acl.tipo === "PLATAFORMA") return true;
  if (acl.tipo === "EMPRESA") return acl.empresaId === leitor.empresaId;
  return acl.empresaId === leitor.empresaId && leitor.estabelecimentoId !== null && acl.estabelecimentoId === leitor.estabelecimentoId;
}
