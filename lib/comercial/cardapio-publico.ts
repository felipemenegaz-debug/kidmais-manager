import type { DbExecutor } from "../db/contracts.ts";
import { CODIGO_EMPRESA_PUBLICA, confirmarEmpresaPublica } from "../http/empresas-publicas.ts";
import { lerEstadoComercial } from "../assinatura/estado.ts";
import { ITEM_DE_ESCOLHA_SQL } from "./itens-de-escolha.ts";
import { catalogoBuffetPorEmpresa } from "./catalogo-buffet-estrutura.ts";

export type CategoriaCardapio = { codigo: string; nome: string; itens: string[] };

type EscopoCardapio = { empresaId: string; motivo?: never } | { empresaId?: never; motivo: string };

export async function escopoCardapioPublico(tx: DbExecutor, codigo: string): Promise<EscopoCardapio> {
  if (!CODIGO_EMPRESA_PUBLICA.test(codigo)) return { motivo: "Confira o código do endereço público da empresa." };
  const { rows } = await tx.query<{ id: string }>(
    "SELECT id::text AS id FROM public.empresas WHERE codigo = $1 AND status = 'ATIVA'", [codigo]);
  const empresa = rows[0];
  if (!empresa) return { motivo: "O endereço público exige uma empresa ativa." };
  if ((await lerEstadoComercial(tx, empresa.id)).acesso.nivel === "BLOQUEADO")
    return { motivo: "O acesso comercial da empresa está bloqueado. Confira a assinatura." };
  if (!await catalogoBuffetPorEmpresa(tx))
    return { motivo: "O catálogo por empresa precisa estar disponível para compartilhar o cardápio." };
  confirmarEmpresaPublica(codigo, empresa.id);
  return { empresaId: empresa.id };
}

export async function lerCardapioPublico(tx: DbExecutor, empresaId: string): Promise<CategoriaCardapio[]> {
  const resultado = await tx.query<{ codigo: string; nome: string; item: string }>(`
    SELECT DISTINCT c.codigo, c.nome, i.nome AS item, c.ordem_exibicao, i.ordem_exibicao AS ordem_item
      FROM pacotes p
      JOIN pacote_buffet_categorias r ON r.pacote_id = p.id AND r.ativo
      JOIN buffet_categorias c ON c.id = r.categoria_id AND c.ativo AND c.empresa_id = p.empresa_id
      JOIN buffet_itens i ON i.categoria_id = c.id AND i.ativo AND i.empresa_id = p.empresa_id
     WHERE p.empresa_id = $1::uuid AND p.ativo AND p.vigente AND p.arquivado_em IS NULL
       AND ${ITEM_DE_ESCOLHA_SQL}
     ORDER BY c.ordem_exibicao, c.nome, c.codigo, ordem_item, item`, [empresaId]);

  const categorias = new Map<string, { categoria: CategoriaCardapio; nomes: Set<string> }>();
  for (const linha of resultado.rows) {
    const codigo = linha.codigo.toLowerCase();
    let grupo = categorias.get(codigo);
    if (!grupo) {
      grupo = { categoria: { codigo, nome: linha.nome, itens: [] }, nomes: new Set() };
      categorias.set(codigo, grupo);
    }
    const item = linha.item.trim().replace(/\s+/g, " ");
    const chave = item.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("pt-BR");
    if (item && !grupo.nomes.has(chave)) {
      grupo.nomes.add(chave);
      grupo.categoria.itens.push(item);
    }
  }
  return Array.from(categorias.values(), ({ categoria }) => categoria).filter(c => c.itens.length > 0);
}
