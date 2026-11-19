import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import AreaFamilia from "@/components/area-familia/AreaFamilia";
import { MarcaPublicaProvider } from "@/components/fechamento/MarcaPublica";
import { fonteTexto, fonteTitulo } from "@/components/site/fonte";
import { empresaDaArea, lerSessao } from "@/lib/area-familia/acesso";
import { areaFamiliaLigada } from "@/lib/area-familia/http";
import { lerMinhaFesta } from "@/lib/area-familia/leitura";
import { CODIGO_EMPRESA_AREA, nomeCookieArea } from "@/lib/area-familia/tokens";
import { REGRAS_LEGADAS } from "@/lib/comercial/regras-pagamento";
import { marcaDoBuffet } from "@/lib/convites/logo-buffet";
import { db, withTransaction } from "@/lib/db/postgres";
import { hojeBrasilia } from "@/lib/financeiro/calculos";
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
 * público; não depende do orçamento online. Com sessão válida (F2): as abas de leitura, com os dados lidos aqui, no
 * servidor, a partir da sessão (festa, contrato e versão vigente nunca vêm da URL).
 */
export default async function MinhaFestaPage({ params }: { params: Promise<{ empresa: string }> }) {
  const { empresa } = await params;
  if (!areaFamiliaLigada() || !CODIGO_EMPRESA_AREA.test(empresa)) notFound();
  const empresaId = await empresaDaArea(db(), empresa).catch(() => null);
  if (!empresaId) notFound();
  const nome = await nomePublicoDaEmpresa(db(), empresaId).catch(() => null);
  if (!nome) notFound();
  const contato = await contatoPublicoDaEmpresa(db(), empresaId).catch(() => null);
  // Visual iA.Fest: logo do buffet no topo (o mesmo dos convites); sem logo, só o nome.
  const logo = await marcaDoBuffet(db(), empresaId).then((m) => m.logoDataUrl).catch(() => null);
  const token = (await cookies()).get(nomeCookieArea(empresa))?.value;
  const primeira = await lerSessao(db(), empresa, token).catch(() => null);
  // Revalida a sessão dentro da transação da leitura (mesma regra das APIs): logout ou revogação entre as duas leituras
  // não entrega dados; a página volta para a entrada.
  const lido = primeira
    ? await withTransaction(async (tx) => {
      const atual = await lerSessao(tx, empresa, token);
      if (!atual || atual.sessaoId !== primeira.sessaoId) return { sessao: null, dados: null };
      return { sessao: atual, dados: await lerMinhaFesta(tx, atual, hojeBrasilia()) };
    }).catch((error) => {
      console.error("[Kidmais Área da família] falha ao ler a festa", error instanceof Error ? error.name : "erro");
      return { sessao: null, dados: null };
    })
    : { sessao: null, dados: null };
  const { sessao, dados } = lido;
  return (
    <MarcaPublicaProvider nome={nome} pagamento={{ ...REGRAS_LEGADAS }} contato={contato}>
      <div className={`${fonteTitulo.variable} ${fonteTexto.variable}`}>
        <AreaFamilia empresa={empresa} sessao={sessao ? { papel: sessao.papel, primeiroNome: sessao.primeiroNome } : null} dados={dados} logo={logo} />
      </div>
    </MarcaPublicaProvider>
  );
}
