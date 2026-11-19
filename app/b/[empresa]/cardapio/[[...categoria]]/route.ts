import type { NextRequest } from "next/server";
import { CODIGO_CATEGORIA_PUBLICA } from "@/lib/comercial/caminho-cardapio";
import { db } from "@/lib/db/postgres";
import { limitarPublico } from "@/lib/http/limite-publico";
import { escopoCardapioPublico, lerCardapioPublico } from "@/lib/comercial/cardapio-publico";
import { cardapioIndisponivel, cardapioLimitado, renderizarCardapio } from "@/lib/comercial/cardapio-html";
import { nomePublicoDaEmpresa } from "@/lib/perfil/nome-publico";
import { contatoPublicoDaEmpresa } from "@/lib/perfil/contato-publico";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest, { params }: { params: Promise<{ empresa: string; categoria?: string[] }> }) {
  const { empresa, categoria } = await params;
  // Só a empresa do caminho escolhe o contador. A resposta final não inclui estado de navegação ou IDs do servidor.
  const nextUrl = new URL(request.url);
  nextUrl.searchParams.set("empresa", empresa);
  const limite = await limitarPublico({ headers: request.headers, nextUrl }, "LEITURA");
  if (limite) return cardapioLimitado(limite.headers.get("Retry-After"));
  if (categoria && (categoria.length > 1 || categoria.some(codigo => !CODIGO_CATEGORIA_PUBLICA.test(codigo)))) return cardapioIndisponivel();
  const tx = db();
  const { empresaId: id } = await escopoCardapioPublico(tx, empresa);
  if (!id) return cardapioIndisponivel();
  const [nome, contato, categorias] = await Promise.all([
    nomePublicoDaEmpresa(tx, id), contatoPublicoDaEmpresa(tx, id), lerCardapioPublico(tx, id),
  ]);
  return nome ? renderizarCardapio(nome, contato, categorias, categoria?.[0]) : cardapioIndisponivel();
}
