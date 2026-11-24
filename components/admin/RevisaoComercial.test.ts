import assert from "node:assert/strict";
import { createElement, isValidElement, type ReactNode } from "react";
import test from "node:test";
import { carregarModulo } from "../../lib/acessos/teste-carregador.ts";

const fechamentoId = "11111111-1111-4111-8111-111111111111";
const contratoId = "22222222-2222-4222-8222-222222222222";
const versaoId = "33333333-3333-4333-8333-333333333333";
const urlRevisao = `/api/admin/fechamentos/${fechamentoId}/revisao`;
const urlConsulta = `/api/admin/contratos?fechamentoId=${fechamentoId}`;

type Elemento = { children?: ReactNode; href?: string; onClick?: () => Promise<void> };

function encontrar(no: ReactNode, tag: string, texto: string): Elemento | undefined {
  if (Array.isArray(no)) {
    for (const filho of no) {
      const encontrado = encontrar(filho, tag, texto);
      if (encontrado) return encontrado;
    }
  }
  if (!isValidElement<Elemento>(no)) return;
  if (no.type === tag && no.props.children === texto) return no.props;
  return encontrar(no.props.children, tag, texto);
}

function montar({ gerado = false, id = contratoId, recusa }: { gerado?: boolean; id?: string; recusa?: string } = {}) {
  const estados: unknown[] = [];
  let indice = 0;
  let efeito: (() => unknown) | undefined;
  const dados = {
    fechamento: {
      id: fechamentoId, status: "AGUARDANDO_CONTRATO", dataEvento: "2027-01-01",
      horarioInicio: "14:00", horarioFim: "18:00", condicaoPagamento: { forma: "PIX_AVISTA" },
    },
    aprovacoes: [], recusa,
  };
  const resposta = {
    ok: true,
    data: { contrato: { id: contratoId }, versao: { id: versaoId, contratoId: id, snapshot: { comercial: { valorFinalContrato: 1000 } } } },
  };
  const { default: RevisaoComercial } = carregarModulo("components/admin/RevisaoComercial.tsx", {
    "react": {
      useState(inicial: unknown) {
        const posicao = indice++;
        if (!(posicao in estados)) estados[posicao] = inicial;
        return [estados[posicao], (valor: unknown) => {
          estados[posicao] = typeof valor === "function" ? valor(estados[posicao]) : valor;
        }];
      },
      useRef(current: unknown) {
        const posicao = indice++;
        if (!(posicao in estados)) estados[posicao] = { current };
        return estados[posicao];
      },
      useCallback: (fn: unknown) => fn,
      useLayoutEffect: (executar: () => unknown) => { efeito ??= executar; },
    },
    "react/jsx-runtime": { jsx: createElement, jsxs: createElement },
    "RevisaoComercial.module.css": {},
    "MotivoPerda.module.css": {},
    "http/admin-fetch": {
      async adminFetch(url: string, init: RequestInit) {
        if (url === urlRevisao && !init.method) return Response.json({ ok: true, data: dados });
        if (url === urlConsulta && !init.method) {
          return gerado ? Response.json(resposta) : Response.json({ ok: false }, { status: 404 });
        }
        assert.equal(url, "/api/admin/contratos");
        assert.equal(init.method, "POST");
        assert.deepEqual(JSON.parse(String(init.body)), { fechamentoId });
        return Response.json(resposta, { status: 201 });
      },
    },
  });
  function render() {
    indice = 0;
    return (RevisaoComercial as (props: { fechamentoId: string }) => ReactNode)({ fechamentoId });
  }
  return {
    async carregar() {
      render();
      efeito?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
      return render();
    },
    render,
  };
}

test("Gerar contrato abre o contrato do POST e mantém o resumo", async () => {
  const tela = montar();
  const inicial = await tela.carregar();
  assert.equal(encontrar(inicial, "a", "Abrir contrato para assinar"), undefined);
  const gerar = encontrar(inicial, "button", "Gerar contrato");
  assert.ok(gerar?.onClick);
  await gerar.onClick();
  const resultado = tela.render();
  assert.equal(encontrar(resultado, "a", "Abrir contrato para assinar")?.href, `/admin/contratos?contratoId=${contratoId}`);
  assert.equal(encontrar(resultado, "a", "Abrir Resumo da Contratação")?.href, `/api/admin/contratos/resumo?fechamentoId=${fechamentoId}`);
});

test("ao recarregar, abre o contrato do fechamento consultado", async () => {
  const resultado = await montar({ gerado: true }).carregar();
  assert.equal(encontrar(resultado, "a", "Abrir contrato para assinar")?.href, `/admin/contratos?contratoId=${contratoId}`);
});

test("usa a lista quando existe contrato, mas o ID não é confiável", async () => {
  const resultado = await montar({ gerado: true, id: "id-invalido" }).carregar();
  assert.equal(encontrar(resultado, "a", "Abrir contrato para assinar")?.href, "/admin/contratos");
});

test("usa a lista se a revisão confirma preparação e a consulta não devolve o ID", async () => {
  const resultado = await montar({ recusa: "COM_PREPARACAO" }).carregar();
  assert.equal(encontrar(resultado, "a", "Abrir contrato para assinar")?.href, "/admin/contratos");
});
