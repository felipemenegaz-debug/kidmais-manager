import { NextResponse } from "next/server";
import { db } from "../db/postgres.ts";
import { codigoEmpresaDoPedido, escopoCotacaoPublica } from "../comercial/cotacao-publica.ts";
import { escopoDaEmpresa, type EscopoAgenda } from "../disponibilidade/escopo.ts";
import { limitarPublico } from "../http/limite-publico.ts";
import { convidadosDaConsulta } from "../fechamentos/convidados-consulta.ts";
import { fotoPublica, listarSaloesPublicos, SalaoPublicoIndisponivel } from "./salao-publico.ts";

/**
 * S-D (D2/D3/R-D3): rotas públicas dos salões. Toda recusa de escopo ou de publicação é o MESMO 404 `no-store`, antes
 * de qualquer dado ou byte (inclusive o 304 das fotos). Parâmetro malformado da consulta = 400 (não revela nada).
 */
type Pedido = { nextUrl: URL; headers: { get(nome: string): string | null } };

const NAO_ENCONTRADO = () => new NextResponse("Não encontrado.", { status: 404, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Escopo da empresa do endereço (/b/<código>) com a unidade, como a cotação; qualquer recusa = null. */
async function escopoPublico(pedido: Pedido): Promise<EscopoAgenda | null> {
  try {
    const escopo = await escopoCotacaoPublica(db, codigoEmpresaDoPedido(pedido.nextUrl));
    const unidade = await escopoDaEmpresa(db(), escopo.empresaId, escopo.estabelecimentoId, { exigirUnidade: true });
    return { empresaId: escopo.empresaId, estabelecimentoId: unidade.estabelecimentoId };
  } catch {
    return null;
  }
}

export async function respostaListaSaloes(pedido: Pedido) {
  const limite = await limitarPublico(pedido as never, "LEITURA");
  if (limite) return limite;
  const p = pedido.nextUrl.searchParams;
  const consulta = {
    data: p.get("data") ?? "", configuracaoId: p.get("configuracaoId") ?? "", inicio: p.get("inicio") ?? "", fim: p.get("fim") ?? "",
    convidados: convidadosDaConsulta(p.get("convidados")),
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(consulta.data) || !UUID.test(consulta.configuracaoId) || !HORA.test(consulta.inicio) || !HORA.test(consulta.fim)
      || !consulta.convidados) {
    return NextResponse.json({ ok: false, erro: "Consulta inválida.", codigo: "PARAMETROS_INVALIDOS" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const escopo = await escopoPublico(pedido);
  if (!escopo) return NAO_ENCONTRADO();
  try {
    // E2b (P2-E2b-2): o catálogo efetivo do endereço decide se o combinado tem pacote (o mesmo da etapa de pacotes).
    const enderecoDaEmpresa = codigoEmpresaDoPedido(pedido.nextUrl) !== null;
    const r = await listarSaloesPublicos(db(), escopo, { ...consulta, convidados: consulta.convidados }, undefined, { enderecoDaEmpresa });
    return NextResponse.json({ ok: true, data: r }, { headers: { "Cache-Control": "no-store" } });
  } catch (erro) {
    if (erro instanceof SalaoPublicoIndisponivel) return NAO_ENCONTRADO();
    throw erro;
  }
}

/**
 * Foto pública (R-D3): `public, max-age=0, must-revalidate` + ETag — toda exibição revalida e o 304 só sai depois das
 * mesmas verificações (salão que deixou de estar pronto, foto removida ou flag desligada = 404 na próxima requisição).
 */
export async function respostaFotoSalao(pedido: Pedido, salaoIdBruto: string, fotoIdBruto: string) {
  const limite = await limitarPublico(pedido as never, "LEITURA");
  if (limite) return limite;
  if (!UUID.test(salaoIdBruto) || !UUID.test(fotoIdBruto)) return NAO_ENCONTRADO();
  const escopo = await escopoPublico(pedido);
  if (!escopo) return NAO_ENCONTRADO();
  let foto: { conteudo: Buffer; sha256: string };
  try {
    foto = await fotoPublica(db(), escopo, salaoIdBruto.toLowerCase(), fotoIdBruto.toLowerCase());
  } catch (erro) {
    if (erro instanceof SalaoPublicoIndisponivel) return NAO_ENCONTRADO();
    throw erro;
  }
  const etag = `"${foto.sha256}"`;
  const cabecalhos = {
    "Cache-Control": "public, max-age=0, must-revalidate", ETag: etag, "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  };
  if (pedido.headers.get("if-none-match") === etag) return new NextResponse(null, { status: 304, headers: cabecalhos });
  return new NextResponse(new Uint8Array(foto.conteudo), { headers: { ...cabecalhos, "Content-Type": "image/webp" } });
}
