import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement, type ComponentType, type PropsWithChildren } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { carregarModulo } from "../../lib/acessos/teste-carregador.ts";
import { REGRAS_LEGADAS } from "../../lib/comercial/regras-pagamento.ts";

test("cabeçalho do buffet mostra a logo aplicada e preserva o nome quando ela falta", () => {
  const marca = carregarModulo("components/fechamento/MarcaPublica.tsx", {
    "KidmaisBrand": () => null,
    "MarcaPublica.module.css": {},
  });
  const Provider = marca.MarcaPublicaProvider as ComponentType<PropsWithChildren<{ nome: string; pagamento: typeof REGRAS_LEGADAS }>>;
  const Cabecalho = marca.MarcaPublicaCabecalho as ComponentType<{ logo?: string }>;
  const render = (logo?: string) => renderToStaticMarkup(createElement(Provider,
    { nome: "Buffet Aurora", pagamento: REGRAS_LEGADAS }, createElement(Cabecalho, { logo })));
  const imagem = "data:image/png;base64,AAAA";
  const comLogo = render(imagem);
  assert.ok(comLogo.includes(`src="${imagem}"`));
  assert.match(comLogo, /<strong[^>]*>Buffet Aurora<\/strong>/);
  const semLogo = render();
  assert.doesNotMatch(semLogo, /<img\b/);
  assert.match(semLogo, /<strong[^>]*>Buffet Aurora<\/strong>/);
});

test("todas as telas do assistente reservam a classe do tema público à origem pública", () => {
  const fonte = readFileSync(new URL("./FechamentoWizard.tsx", import.meta.url), "utf8");
  assert.match(fonte, /const classePagina = origemInterna \? styles\.page : `[^\n]*\$\{styles\.publico\}/);
  const paginas = fonte.match(/<main\b[^>]*>/g) ?? [];
  assert.ok(paginas.length > 0);
  for (const pagina of paginas) {
    assert.match(pagina, /className=\{classePagina\}/);
    assert.match(pagina, /data-site-venda=\{origemInterna \? undefined : true\}/);
  }
});
