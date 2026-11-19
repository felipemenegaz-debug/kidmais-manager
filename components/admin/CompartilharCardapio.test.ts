import assert from "node:assert/strict";
import test from "node:test";
import { Children, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { carregarModulo } from "../../lib/acessos/teste-carregador.ts";

function encontrar(arvore: ReactNode, tipo: string, rotulo?: string) {
  const fila = Children.toArray(arvore);
  while (fila.length) {
    const atual = fila.shift();
    if (!isValidElement<{ children?: ReactNode; onClick?: () => void; onChange?: (e: object) => void; value?: string }>(atual)) continue;
    if (atual.type === tipo && (!rotulo || atual.props.children === rotulo)) return atual.props;
    fila.push(...Children.toArray(atual.props.children));
  }
  assert.fail(`Elemento ausente: ${tipo} ${rotulo ?? ""}`);
}

test("aviso de cardápio vazio e cópia manual quando o navegador recusa, inclusive para categoria", async () => {
  const completo = { nome: "Cardápio completo", caminho: "/b/abc/cardapio", link: "https://buffet.test/b/abc/cardapio" };
  const doces = { nome: "Doces", caminho: completo.caminho + "/doces", link: completo.link + "/doces" };
  const opcoes = { completo, emPreparacao: true, categorias: [] as typeof completo[] };
  let indisponivel = "";
  let bloqueado = false;
  const slots: unknown[] = [];
  let cursor = 0;
  const modulo = carregarModulo("components/admin/CompartilharCardapio.tsx", {
    react: { useState: (inicial: unknown) => {
      const i = cursor++; if (!(i in slots)) slots[i] = inicial;
      return [slots[i], (v: unknown) => { slots[i] = v; }];
    } },
    "workspace.module.css": {},
    "lib/http/admin-fetch": { adminFetch: async (url: string) => {
      assert.equal(url, "/api/admin/configuracoes/catalogo?compartilhar=1");
      if (bloqueado) return Response.json({ codigo: "ASSINATURA_NECESSARIA", erro: "Acesse Assinatura para regularizar." }, { status: 402 });
      return Response.json({ data: indisponivel ? { motivo: indisponivel } : opcoes });
    } },
  });
  const render = () => { cursor = 0; return (modulo.default as () => ReactNode)(); };
  const click = async (botao: string) => {
    encontrar(render(), "button", botao).onClick!(); await new Promise(resolve => setImmediate(resolve));
  };
  const navegador = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const escritos: string[] = [];
  try {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (link: string) => {
      escritos.push(link); throw Error("NotAllowedError");
    } } } });
    await click("Compartilhar cardápio");
    assert.match(renderToStaticMarkup(render()), /em preparação/);
    await click("Copiar link");
    assert.equal(encontrar(render(), "input").value, completo.link);
    await click("Compartilhar cardápio");
    opcoes.categorias.push(doces);
    opcoes.emPreparacao = false;
    await click("Compartilhar cardápio");
    encontrar(render(), "select").onChange!({ target: { value: doces.caminho } });
    assert.doesNotMatch(renderToStaticMarkup(render()), /manualmente/);
    await click("Copiar link");
    assert.equal(encontrar(render(), "input").value, doces.link);
    assert.deepEqual(escritos, [completo.link, doces.link]);
    await click("Compartilhar cardápio");
    indisponivel = "Preencha o nome público no Perfil da empresa antes de compartilhar.";
    await click("Compartilhar cardápio");
    const recusado = renderToStaticMarkup(render());
    assert.match(recusado, /Preencha o nome público no Perfil da empresa/);
    assert.doesNotMatch(recusado, /Copiar link|Abrir cardápio|https:\/\//);
    await click("Compartilhar cardápio");
    bloqueado = true;
    await click("Compartilhar cardápio");
    const bloqueio = renderToStaticMarkup(render());
    assert.match(bloqueio, /Acesse Assinatura para regularizar/);
    assert.doesNotMatch(bloqueio, /Copiar link|Abrir cardápio/);
  } finally {
    if (navegador) Object.defineProperty(globalThis, "navigator", navegador);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});
