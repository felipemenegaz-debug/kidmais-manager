import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import AreaFamilia from "@/components/area-familia/AreaFamilia";
import { MarcaPublicaProvider } from "@/components/fechamento/MarcaPublica";
import { empresaDaArea, lerSessao } from "@/lib/area-familia/acesso";
import { areaFamiliaLigada } from "@/lib/area-familia/http";
import { CODIGO_EMPRESA_AREA, nomeCookieArea } from "@/lib/area-familia/tokens";
import { REGRAS_LEGADAS } from "@/lib/comercial/regras-pagamento";
import { db } from "@/lib/db/postgres";
import { contatoPublicoDaEmpresa } from "@/lib/perfil/contato-publico";
import { nomePublicoDaEmpresa } from "@/lib/perfil/nome-publico";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Minha festa",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
  icons: { icon: [{ url: "/icone-orcamento.svg", type: "image/svg+xml" }] },
};

/**
 * Área "Minha festa" (123, F1). Desligada sem AREA_FAMILIA_ENABLED=true (404). Abre para empresa ATIVA com nome
 * público; não depende do orçamento online. Com sessão válida: tela vazia com a marca do buffet.
 */
export default async function MinhaFestaPage({ params }: { params: Promise<{ empresa: string }> }) {
  const { empresa } = await params;
  if (!areaFamiliaLigada() || !CODIGO_EMPRESA_AREA.test(empresa)) notFound();
  const empresaId = await empresaDaArea(db(), empresa).catch(() => null);
  if (!empresaId) notFound();
  const nome = await nomePublicoDaEmpresa(db(), empresaId).catch(() => null);
  if (!nome) notFound();
  const contato = await contatoPublicoDaEmpresa(db(), empresaId).catch(() => null);
  const token = (await cookies()).get(nomeCookieArea(empresa))?.value;
  const sessao = await lerSessao(db(), empresa, token).catch(() => null);
  return (
    <MarcaPublicaProvider nome={nome} pagamento={{ ...REGRAS_LEGADAS }} contato={contato}>
      <AreaFamilia empresa={empresa} sessao={sessao ? { papel: sessao.papel, primeiroNome: sessao.primeiroNome } : null} />
    </MarcaPublicaProvider>
  );
}
