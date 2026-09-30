import { z } from "zod";
import { buscarCategoriasBuffet, buscarItensBuffet } from "../../comercial/catalogo-leitura.ts";
import type { EntidadeRef, RespostaLeitura } from "../contratos.ts";
import type { Ferramenta } from "../ferramentas.ts";
import { montarDestino } from "../rotas-navegacao.ts";
import { PAPEIS_ADMIN, ausencia, fato, montarResposta, plural } from "./comum.ts";

/**
 * Buscas estruturadas (AI V1.1, PR 4), somente leitura:
 * - `buscar_clientes`: pelo NOME, no tenant comprovado (`buscarClientesCrm`). Termo só com letras: a IA não busca
 *   por CPF, telefone ou e-mail, e o resultado traz só id, nome e status.
 * - `buscar_catalogo`: itens/categorias ativos do catálogo do Buffet (global hoje), por nome ou categoria.
 * Termos são literais de busca (escapados no Core), nunca SQL. Nenhuma escrita.
 */
const FONTE_CLIENTES = "crm.clientes";
const FONTE_CATALOGO = "buffet.catalogo";

const nomePessoa = z.string().trim().min(3).max(60).regex(/^[\p{L}][\p{L} .'-]*$/u, "só letras");
const entradaClientes = z.object({ termo: nomePessoa, limite: z.number().int().min(1).max(10).optional() }).strict();

export const buscarClientes: Ferramenta<RespostaLeitura> = {
  nome: "clientes.buscar",
  capacidade: "buscar_clientes",
  classe: "READ",
  grupo: "READ",
  entrada: entradaClientes,
  papeis: PAPEIS_ADMIN,
  descricao: "Busca clientes da empresa pelo nome.",
  preparar(bruto) {
    const { termo, limite } = entradaClientes.parse(bruto);
    return async (tx, tenant, contexto) => {
      const porta = contexto.portas.clientes?.buscar;
      const encontrados = porta ? await porta(tx, tenant.empresaComprovada, termo, limite ?? 5) : [];
      if (!encontrados.length) {
        return montarResposta("buscar_clientes", contexto, {
          estado: "sem_dados",
          resumo: "Nenhum cliente encontrado com esse nome.",
          fatos: [ausencia(porta ? "A busca não encontrou clientes com esse nome." : "Busca de clientes indisponível para a IA.", FONTE_CLIENTES)],
          fontes: [FONTE_CLIENTES],
          entidades: [],
        });
      }
      const entidades: EntidadeRef[] = encontrados.map((c) => ({ tipo: "CLIENTE", id: c.id, rotulo: c.nomeCompleto.slice(0, 120), tela: "cliente" }));
      return montarResposta("buscar_clientes", contexto, {
        estado: "informativo",
        resumo: encontrados.length === 1 ? `Encontrei 1 cliente: ${encontrados[0].nomeCompleto}.` : `Encontrei ${encontrados.length} ${plural(encontrados.length, "cliente", "clientes")} com esse nome.`,
        fatos: encontrados.map((c) => fato(`${c.nomeCompleto} (${c.status === "ATIVO" ? "ativo" : "inativo"}).`, FONTE_CLIENTES)),
        itens: encontrados.map((c, i) => ({ id: `cliente_${i}`, prioridade: "baixa" as const, titulo: c.nomeCompleto.slice(0, 140), detalhe: "Cliente", destino: montarDestino("cliente", c.id) })),
        fontes: [FONTE_CLIENTES],
        entidades,
      });
    };
  },
};

const termoCatalogo = z.string().trim().min(2).max(60).regex(/^[\p{L}\p{N}][\p{L}\p{N} .'-]*$/u, "termo inválido");
const entradaCatalogo = z.object({
  tipo: z.enum(["ITEM", "CATEGORIA"]).optional(),
  termo: termoCatalogo.optional(),
  categoria: termoCatalogo.optional(),
  limite: z.number().int().min(1).max(30).optional(),
}).strict();

export const buscarCatalogo: Ferramenta<RespostaLeitura> = {
  nome: "buffet.catalogo.buscar",
  capacidade: "buscar_catalogo",
  classe: "READ",
  grupo: "READ",
  entrada: entradaCatalogo,
  papeis: PAPEIS_ADMIN,
  descricao: "Itens e categorias do catálogo do Buffet (somente leitura).",
  preparar(bruto) {
    const e = entradaCatalogo.parse(bruto);
    const tipo = e.tipo ?? (e.termo ? "ITEM" : e.categoria ? "ITEM" : "CATEGORIA");
    const limite = e.limite ?? 20;
    return async (tx, _tenant, contexto) => {
      const destino = montarDestino("catalogo");
      if (tipo === "CATEGORIA") {
        const categorias = await buscarCategoriasBuffet(tx, { termo: e.termo ?? null, categoria: e.categoria ?? null, limite });
        return montarResposta("buscar_catalogo", contexto, {
          estado: categorias.length ? "informativo" : "sem_dados",
          resumo: categorias.length ? `${categorias.length} ${plural(categorias.length, "categoria", "categorias")} no catálogo do Buffet: ${categorias.map((c) => c.nome).join(", ")}.`.slice(0, 2000) : "Nenhuma categoria encontrada no catálogo do Buffet.",
          fatos: categorias.length ? categorias.map((c) => fato(`Categoria: ${c.nome}.`, FONTE_CATALOGO)) : [ausencia("Nenhuma categoria ativa com esse nome.", FONTE_CATALOGO)],
          itens: categorias.map((c, i) => ({ id: `categoria_${i}`, prioridade: "baixa" as const, titulo: c.nome.slice(0, 140), detalhe: "Categoria do Buffet", destino })),
          fontes: [FONTE_CATALOGO],
          entidades: categorias.map((c) => ({ tipo: "CATEGORIA" as const, id: c.id, rotulo: c.nome.slice(0, 120), tela: "catalogo" as const })),
        });
      }
      const itens = await buscarItensBuffet(tx, { termo: e.termo ?? null, categoria: e.categoria ?? null, limite });
      const onde = (i: { categoria: string | null }) => (i.categoria ? `categoria ${i.categoria}` : "sem categoria");
      return montarResposta("buscar_catalogo", contexto, {
        estado: itens.length ? "informativo" : "sem_dados",
        resumo: itens.length
          ? itens.length === 1 ? `${itens[0].nome} está na ${onde(itens[0])}.` : `${itens.length} ${plural(itens.length, "item", "itens")} encontrados no catálogo do Buffet.`
          : e.termo ? "Esse item não está no catálogo do Buffet." : "Nenhum item encontrado no catálogo do Buffet.",
        fatos: itens.length ? itens.map((i) => fato(`${i.nome} (${onde(i)}).`, FONTE_CATALOGO)) : [ausencia("Nenhum item ativo com esse nome.", FONTE_CATALOGO)],
        itens: itens.map((i, n) => ({ id: `item_${n}`, prioridade: "baixa" as const, titulo: i.nome.slice(0, 140), detalhe: onde(i), destino })),
        fontes: [FONTE_CATALOGO],
        entidades: itens.map((i) => ({ tipo: "ITEM" as const, id: i.id, rotulo: i.nome.slice(0, 120), tela: "catalogo" as const, ...(i.categoriaId ? { relacoes: { categoria: i.categoriaId } } : {}) })),
      });
    };
  },
};
