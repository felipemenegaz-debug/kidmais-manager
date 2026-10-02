import { z } from "zod";
import type { DbExecutor } from "../../db/contracts.ts";
import { HORIZONTE_RECORRENCIA_MESES, reaisDe } from "../../financeiro/calculos.ts";
import { normalizar, extrairPrecoCentavos } from "../texto-pt.ts";
import { ErroCampo } from "./human-gate.ts";
import { dataReal } from "./contratacao.ts";
import type { FerramentaAcao } from "./tipos.ts";

const schema = z.object({
  descricao: z.string().trim().min(2).max(200),
  valorCentavos: z.number().int().positive().max(100000000),
  vencimento: z.string().refine(dataReal),
  diaMensal: z.number().int().min(1).max(31).optional(),
  recorrente: z.boolean(),
  categoria: z.string().trim().min(1).max(100),
  categoriaId: z.string().uuid().optional(),
}).strict();
type Payload = z.infer<typeof schema>;
export type PortaContaPagar = {
  categorias(tx: DbExecutor, empresaId: string): Promise<Array<{ id: string; nome: string }>>;
  criar(tx: DbExecutor, empresaId: string, usuarioId: string, input: { descricao: string; valor: number; vencimento: string; categoriaId: string; recorrente: boolean; chave: string }): Promise<string>;
};

export function extrairContaPagar(texto: string, perguntado: string | null): Record<string, unknown> {
  const n = normalizar(texto);
  const p: Record<string, unknown> = {};
  const valor = /(?:r\$\s*)(-?\d[\d.,]*)|(?<![\d.,])(-?\d[\d.,]*)\s*(?:reais|rais|real)\b/.exec(n);
  const numero = valor?.[1] ?? valor?.[2] ?? (perguntado === "valorCentavos" ? n : null);
  if (numero) {
    const v = extrairPrecoCentavos(numero.replace(/^-/, ""), true);
    if (typeof v === "number") p.valorCentavos = numero.startsWith("-") ? -v : v;
  }
  const descricao = /\b(?:referente (?:a|ao)|descri[cç][aã]o\s*:|do|da)\s+(.+?)(?=\s+(?:r\$|\d[\d.,]*\s*(?:reais|rais|real)\b)|$)/iu.exec(texto);
  if (descricao) p.descricao = descricao[1].trim().replace(/[.!]+$/, "");
  else if (perguntado === "descricao" && !/^(sim|nao)$/.test(n)) p.descricao = texto.trim();
  const data = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(n);
  const iso = /\b\d{4}-\d{2}-\d{2}\b/.exec(n);
  if (data) p.vencimento = `${data[3]}-${data[2].padStart(2, "0")}-${data[1].padStart(2, "0")}`;
  else if (iso) p.vencimento = iso[0];
  const mensal = /\b(?:todo[s]? (?:os )?mes(?:es)?|mensal\w*|recorrente)\b/.test(n);
  if (/\b(?:sem recorrencia|nao recorrente|unica|avulsa)\b/.test(n)) p.recorrente = false;
  else if (mensal) p.recorrente = true;
  else if (!perguntado) p.recorrente = false;
  const dia = /\bdia\s+(\d{1,2})\b/.exec(n);
  if (dia) p.diaMensal = Number(dia[1]);
  const categoria = /\bcategoria\s*:?\s*([^,;.!]+)/iu.exec(texto);
  if (categoria) p.categoria = categoria[1].trim();
  else if (perguntado === "categoria" && !/^(sim|nao)$/.test(n)) p.categoria = texto.trim();
  return p;
}

export function criarAcaoContaPagar(porta: PortaContaPagar): FerramentaAcao<Payload> {
  return {
    nome: "financeiro.criar_conta_pagar", capacidade: "criar_conta_pagar", classe: "CONFIRM", grupo: "ADMIN_ACTIONS",
    papeis: ["ADMINISTRATIVO", "REPRESENTANTE_AUTORIZADO"], titulo: "Nova conta a pagar",
    descricao: "Cadastrar conta a pagar, inclusive mensal (12 ocorrências), somente após revisão e confirmação.",
    campos: [
      { id: "descricao", rotulo: "Descrição", obrigatorio: true, perguntar: true, pergunta: "Qual é a descrição da conta?" },
      { id: "valorCentavos", rotulo: "Valor", obrigatorio: true, perguntar: true, pergunta: "Qual é o valor em reais?" },
      { id: "vencimento", rotulo: "Primeiro vencimento", obrigatorio: true, perguntar: true, pergunta: "Qual é o primeiro vencimento? Informe dia, mês e ano (DD/MM/AAAA)." },
      { id: "categoria", rotulo: "Categoria", obrigatorio: true, perguntar: true, pergunta: "Qual é a categoria da despesa? Ex.: Fornecedores, Marketing ou Outros." },
    ],
    extrair: extrairContaPagar,
    faltando: (p) => ["descricao", "valorCentavos", "vencimento", "categoria"].filter((k) => p[k] == null || p[k] === ""),
    validar(p) {
      const r = schema.safeParse(p);
      if (!r.success) throw new ErroCampo([...new Set(r.error.issues.map((i) => String(i.path[0])))], "Confira os dados da conta a pagar.");
      if (r.data.recorrente && r.data.diaMensal && Number(r.data.vencimento.slice(8)) !== r.data.diaMensal) throw new ErroCampo(["vencimento"], `O primeiro vencimento deve ser no dia ${r.data.diaMensal}.`);
      return r.data;
    },
    async verificar(tx, tenant, p) {
      const categorias = await porta.categorias(tx, tenant.empresaComprovada);
      const c = categorias.find((c) => normalizar(c.nome) === normalizar(p.categoria));
      if (!c) throw new ErroCampo(["categoria"], `Escolha uma categoria desta empresa: ${categorias.map((c) => c.nome).join(", ") || "cadastre uma categoria na tela Contas a pagar"}.`);
      return { payload: { ...p, categoria: c.nome, categoriaId: c.id }, avisos: p.recorrente ? [`Serão criadas ${HORIZONTE_RECORRENCIA_MESES} contas mensais a partir do primeiro vencimento. Nenhum pagamento será registrado.`] : [] };
    },
    apresentar: (p) => [
      { id: "descricao", rotulo: "Descrição", valor: typeof p.descricao === "string" ? p.descricao : null, obrigatorio: true },
      { id: "valorCentavos", rotulo: "Valor", valor: typeof p.valorCentavos === "number" ? reaisDe(p.valorCentavos) : null, obrigatorio: true },
      { id: "vencimento", rotulo: "Primeiro vencimento", valor: typeof p.vencimento === "string" ? p.vencimento : null, obrigatorio: true },
      { id: "categoria", rotulo: "Categoria", valor: typeof p.categoria === "string" ? p.categoria : null, obrigatorio: true },
      { id: "recorrente", rotulo: "Recorrência", valor: p.recorrente ? `Mensal — ${HORIZONTE_RECORRENCIA_MESES} ocorrências` : "Conta única", obrigatorio: false },
    ],
    async executar(tx, tenant, p, ctx) {
      if (!p.categoriaId) throw new ErroCampo(["categoria"], "Escolha a categoria da conta.");
      const id = await porta.criar(tx, tenant.empresaComprovada, ctx.usuarioId, { descricao: p.descricao, valor: p.valorCentavos / 100, vencimento: p.vencimento, categoriaId: p.categoriaId, recorrente: p.recorrente, chave: ctx.operacaoId });
      return { entidadeId: id, mensagem: p.recorrente ? "Conta a pagar mensal cadastrada com 12 ocorrências." : "Conta a pagar cadastrada.", destino: "/admin/financeiro/contas-pagar" };
    },
  };
}
