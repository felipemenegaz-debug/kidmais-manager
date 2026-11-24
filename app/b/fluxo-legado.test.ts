import assert from "node:assert/strict";
import test from "node:test";
import type { ReactElement } from "react";
import { carregarModulo } from "../../lib/acessos/teste-carregador.ts";
import { modoEmpresaPublicaLegada } from "../../lib/comercial/empresa-publica-legada.ts";

const RAIZ = "app/b/[empresa]";
const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CODIGO = "kidmais";
const OUTRO = "outro-buffet";
const ROTAS = ["", "disponibilidade", "fechamento", "orcamento", "saloes"];

type Props = {
  params: Promise<{ empresa: string }>;
  searchParams: Promise<Record<string, string | string[]>>;
};
type Pagina = {
  default: (props: Props) => Promise<ReactElement>;
  generateMetadata: (props: Props) => Promise<unknown>;
};

function props(empresa: string, busca: Record<string, string | string[]> = {}): Props {
  return { params: Promise.resolve({ empresa }), searchParams: Promise.resolve(busca) };
}

function carregar(rota: string, status = "ATIVA") {
  const consultasNormais: string[] = [];
  const arquivo = rota ? `${RAIZ}/${rota}/page.tsx` : `${RAIZ}/page.tsx`;
  const pagina = carregarModulo(arquivo, {
    "next/navigation": {
      notFound: () => { throw new Error("404"); },
      redirect: (destino: string) => { throw new Error(`redirect:${destino}`); },
    },
    "next/link": "Link",
    "components/disponibilidade/DisponibilidadePublica": "DisponibilidadePublica",
    "components/disponibilidade/DisponibilidadePublica.module.css": {},
    "components/fechamento/FechamentoWizard": "FechamentoWizard",
    "components/fechamento/FestaDecoracao": "FestaDecoracao",
    "components/fechamento/ContatoEmpresa": "ContatoEmpresa",
    "components/fechamento/MarcaPublica": {
      MarcaPublicaProvider: "MarcaPublicaProvider",
      MarcaPublicaCabecalho: "MarcaPublicaCabecalho",
    },
    "components/saloes/ConhecaSaloes": "ConhecaSaloes",
    "pagina-buffet.module.css": {},
    "lib/db/postgres": { db: () => ({}) },
    "lib/comercial/empresa-publica-legada": {
      modoEmpresaPublicaLegada: (codigo: string) => modoEmpresaPublicaLegada(codigo, {
        AGENDA_PUBLICA_EMPRESA_CODIGO: CODIGO, AGENDA_PUBLICA_EMPRESA_ID: ID,
      }, async () => ({ id: ID, status })),
    },
    "lib/comercial/cotacao-publica": {
      escopoCotacaoPublica: (_db: unknown, codigo: string) => {
        consultasNormais.push(codigo);
        return { empresaId: ID };
      },
    },
    "lib/comercial/regras-pagamento": { lerRegrasPagamento: () => null, REGRAS_LEGADAS: {} },
    "lib/convites/logo-buffet": { marcaDoBuffet: async () => ({ logoDataUrl: "logo-outro-buffet" }) },
    "lib/perfil/nome-publico": { nomePublicoDaEmpresa: () => "Outro Buffet" },
    "lib/perfil/contato-publico": { contatoPublicoDaEmpresa: () => null },
  }) as Pagina;
  return { pagina, consultasNormais };
}

test("o legado abre as telas globais só com a base, herda os metadados e recusa salões", async () => {
  for (const rota of ROTAS) {
    const { pagina, consultasNormais } = carregar(rota);
    const entrada = props(CODIGO);
    assert.deepEqual(await pagina.generateMetadata(entrada), {});
    if (rota === "") {
      await assert.rejects(pagina.default(entrada), { message: "redirect:/b/kidmais/disponibilidade" });
    } else if (rota === "saloes") {
      await assert.rejects(pagina.default(entrada), { message: "404" });
    } else {
      const tela = await pagina.default(entrada);
      assert.equal(tela.type, rota === "disponibilidade" ? "DisponibilidadePublica" : "FechamentoWizard");
      assert.deepEqual(tela.props, { base: CODIGO });
    }
    assert.deepEqual(consultasNormais, []);
  }
});

test("fechamento e orçamento do legado reconhecem o atalho do painel pelo primeiro valor", async () => {
  for (const rota of ["fechamento", "orcamento"]) {
    const { pagina } = carregar(rota);
    await assert.rejects(pagina.default(props(CODIGO, { contexto: ["ADMIN", "PUBLICO"] })), { message: "redirect:/clientes?acao=fechamento" });
    await assert.rejects(pagina.default(props(CODIGO, { origem: "ATENDIMENTO_KIDMAIS" })), { message: "redirect:/clientes?acao=fechamento" });
    const tela = await pagina.default(props(CODIGO, { contexto: ["PUBLICO", "ADMIN"], origem: ["SITE", "ATENDIMENTO_KIDMAIS"] }));
    assert.equal(tela.type, "FechamentoWizard");
  }
});

test("o código reservado recusado retorna 404 e as outras empresas seguem a guarda e os metadados atuais", async () => {
  for (const rota of ROTAS) {
    const { pagina, consultasNormais } = carregar(rota, "INATIVA");
    await assert.rejects(pagina.default(props(CODIGO, { contexto: "ADMIN" })), { message: "404" });
    await assert.rejects(pagina.generateMetadata(props(CODIGO)), { message: "404" });
    assert.deepEqual(consultasNormais, []);

    const entrada = props(OUTRO, { contexto: "ADMIN" });
    assert.deepEqual(await pagina.generateMetadata(entrada), {
      title: "Orçamento da festa",
      description: "Consulte datas disponíveis e envie o pedido da sua festa.",
      robots: { index: false, follow: false },
      icons: { icon: [{ url: "/icone-orcamento.svg", type: "image/svg+xml" }] },
    });
    const tela = await pagina.default(entrada);
    assert.equal(tela.type, "MarcaPublicaProvider");
    assert.deepEqual(consultasNormais, [OUTRO]);
  }
});
