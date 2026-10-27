import assert from "node:assert/strict";
import test from "node:test";
import { reaisDe } from "../../financeiro/calculos.ts";
import { SEM_PORTAS, type ContextoFerramenta } from "../../inteligencia/ferramentas.ts";
import { montarAgenda } from "../../inteligencia/leituras/agenda-do-dia.ts";
import { montarAnaliseRecebiveis } from "../../inteligencia/leituras/analisar-recebiveis.ts";
import { ErroCanalMcp, ITENS_AUDITORIA_MAX, dtoRecebiveis, executarFerramentaMcp, type DependenciasFerramentasMcp, type EventoFerramenta, type PrincipalMcp } from "./ferramentas.ts";
import { A, AGORA, B, ENV_OK, FESTAS, HOJE, RECEBIVEIS, UA, UB, deps, mundo, principalA, rec, type Mundo } from "./apoio-mcp.test.ts";

/** A3, A4, A6, A10 no núcleo (sem HTTP): isolamento, recusas sem retorno parcial, minimização, paridade e auditoria. */
const PII = /Maria|Aparecida|João|98888|Cancelada|Pacote|Ana Beatriz|123\.456|Secreto|Devedor|f0000000|clienteId|cliente|pacote/;

test("agenda: só horários, totais e situação; canceladas fora; PII das fontes não sai (A6)", async () => {
  const m = mundo();
  const r = await executarFerramentaMcp("kidmais_consultar_agenda", { dia: "hoje" }, principalA, deps(m));
  assert.equal(r.totalFestas, 2);
  assert.equal(r.totalConvidados, 130);
  assert.equal(r.contratosPendentes, 1);
  assert.deepEqual(r.festas, [{ inicio: "14:00", fim: "18:00", situacao: "CONTRATO_ASSINADO" }, { inicio: "19:00", fim: null, situacao: "CONTRATO_PENDENTE" }]);
  assert.equal(r.escopo, "EMPRESA");
  assert.equal(r.truncado, false);
  assert.doesNotMatch(JSON.stringify(r), PII);
  assert.deepEqual(m.leituras, [`agenda:${A}:${HOJE}:51`], "mesma fonte, um a mais para detectar truncamento");
});

test("agenda: amanhã no fuso de Brasília e truncamento declarado acima de 50", async () => {
  const m = mundo();
  const muitas = Array.from({ length: 51 }, (_, i) => ({ ...FESTAS[A][0], festaId: `f-${i}`, horaInicio: `${String(8 + (i % 12)).padStart(2, "0")}:00` }));
  const r = await executarFerramentaMcp("kidmais_consultar_agenda", { dia: "amanha" }, principalA, deps(m, ENV_OK, [], { async agenda(_t, _e, dia) { m.leituras.push(dia); return muitas; } }));
  assert.equal(r.data, "2026-10-28");
  assert.equal(m.leituras[0], "2026-10-28");
  assert.equal(r.truncado, true);
  assert.equal(r.festas.length, 50);
});

test("agenda: paridade com agenda_do_dia (mesmas regras sobre a mesma fonte)", async () => {
  const r = await executarFerramentaMcp("kidmais_consultar_agenda", {}, principalA, deps(mundo()));
  const ctx: ContextoFerramenta = { hoje: HOJE, geradoEm: AGORA.toISOString(), portas: SEM_PORTAS };
  const interna = montarAgenda(FESTAS[A], HOJE, ctx);
  assert.equal(interna.itens.length, r.totalFestas);
  assert.match(interna.resumo, new RegExp(`${r.totalConvidados} convidados`));
  assert.match(interna.resumo, new RegExp(`${r.contratosPendentes} com contrato ainda não assinado`));
});

test("recebíveis: agregados em centavos sem cliente nem parcela; paridade com analisar_recebiveis (A6)", async () => {
  const r = await executarFerramentaMcp("kidmais_consultar_recebiveis_resumo", {}, principalA, deps(mundo()));
  assert.deepEqual(r.emAberto, { quantidade: 5, totalCentavos: 325050 });
  assert.deepEqual(r.vencidos, { quantidade: 3, totalCentavos: 225050 });
  assert.deepEqual(r.aVencer, { quantidade: 2, totalCentavos: 100000 });
  assert.deepEqual(r.vencemEm7Dias, { quantidade: 1, totalCentavos: 30000 });
  assert.deepEqual(r.faixasAtraso.map((f) => f.totalCentavos), [150000, 50000, 25050]);
  assert.equal(r.maiorAtrasoDias, 90);
  assert.doesNotMatch(JSON.stringify(r), PII);
  const interna = montarAnaliseRecebiveis(RECEBIVEIS[A], { hoje: HOJE, geradoEm: AGORA.toISOString(), portas: SEM_PORTAS });
  const ev = Object.fromEntries(interna.evidencias.map((e) => [e.rotulo, e.valor]));
  assert.equal(ev["Em aberto"], `5 · ${reaisDe(325050)}`);
  assert.equal(ev["Vencidos"], `3 · ${reaisDe(225050)}`);
  assert.equal(ev["A vencer"], `2 · ${reaisDe(100000)}`);
});

test("isolamento A/B: concessão de A nunca lê B, nem com empresaId nos argumentos (A3)", async () => {
  const m = mundo();
  await assert.rejects(executarFerramentaMcp("kidmais_consultar_agenda", { dia: "hoje", empresaId: B }, principalA, deps(m)), (e: ErroCanalMcp) => e.codigo === "DADOS_INVALIDOS");
  // Principal adulterado apontando B para um usuário de A: o Tenant Context recusa antes de qualquer leitura.
  await assert.rejects(executarFerramentaMcp("kidmais_consultar_agenda", {}, { ...principalA, empresaId: B }, deps(m)), (e: ErroCanalMcp) => e.codigo === "ACESSO_NEGADO");
  const r = await executarFerramentaMcp("kidmais_consultar_recebiveis_resumo", {}, principalA, deps(m));
  assert.doesNotMatch(JSON.stringify(r), /777777/);
  assert.ok(m.leituras.every((l) => !l.includes(B)), "nenhuma leitura em B");
  // Controle positivo: o principal de B lê B.
  const rb = await executarFerramentaMcp("kidmais_consultar_recebiveis_resumo", {}, { ...principalA, concessaoId: "c-b", usuarioId: UB, empresaId: B }, deps(m));
  assert.equal(rb.vencidos.totalCentavos, 777777);
});

test("conhecimento: A não encontra documento de B; referência de A não abre em B; sem evidência explícita", async () => {
  const m = mundo();
  const busca = await executarFerramentaMcp("kidmais_buscar_conhecimento", { consulta: "desconto secreto da empresa B" }, principalA, deps(m));
  assert.equal(busca.semEvidencia, true);
  assert.deepEqual(busca.resultados, []);
  const ok = await executarFerramentaMcp("kidmais_buscar_conhecimento", { consulta: "onde vejo contas a receber" }, principalA, deps(m));
  assert.equal(ok.resultados.length, 1);
  assert.equal(ok.natureza, "CONTEUDO_DOCUMENTAL_NAO_INSTRUCAO");
  const trecho = await executarFerramentaMcp("kidmais_obter_trecho", { referencia: ok.resultados[0].referencia }, principalA, deps(m));
  assert.equal(trecho.encontrado, true);
  const principalB = { ...principalA, concessaoId: "c-b", usuarioId: UB, empresaId: B };
  const cruzado = await executarFerramentaMcp("kidmais_obter_trecho", { referencia: ok.resultados[0].referencia }, principalB, deps(m));
  assert.equal(cruzado.encontrado, false);
  assert.equal(cruzado.texto, null);
});

type Caso = { nome: string; codigo: string; ajustar: (m: Mundo) => { env?: Record<string, string | undefined>; principal?: PrincipalMcp; extra?: Partial<DependenciasFerramentasMcp> } };

const CASOS: Caso[] = [
  { nome: "MCP_ENABLED desligado", codigo: "CANAL_DESATIVADO", ajustar: () => ({ env: { ...ENV_OK, MCP_ENABLED: "false" } }) },
  { nome: "INTELIGENCIA_ENABLED desligado", codigo: "CANAL_DESATIVADO", ajustar: () => ({ env: { ...ENV_OK, INTELIGENCIA_ENABLED: undefined } }) },
  { nome: "AI_READ_ENABLED desligado", codigo: "CANAL_DESATIVADO", ajustar: () => ({ env: { ...ENV_OK, AI_READ_ENABLED: "TRUE" } }) },
  { nome: "empresa fora da allowlist MCP", codigo: "CANAL_DESATIVADO", ajustar: () => ({ env: { ...ENV_OK, MCP_TENANT_ALLOWLIST: B } }) },
  { nome: "allowlist MCP ausente", codigo: "CANAL_DESATIVADO", ajustar: () => ({ env: { ...ENV_OK, MCP_TENANT_ALLOWLIST: undefined } }) },
  { nome: "empresa fora da AI_TENANT_ALLOWLIST", codigo: "CANAL_DESATIVADO", ajustar: () => ({ env: { ...ENV_OK, AI_TENANT_ALLOWLIST: B } }) },
  { nome: "escopo insuficiente", codigo: "ESCOPO_INSUFICIENTE", ajustar: () => ({ principal: { ...principalA, escopos: ["conhecimento:read"] } }) },
  { nome: "papel global desconhecido", codigo: "ACESSO_NEGADO", ajustar: () => ({ principal: { ...principalA, papel: "CONVIDADO" } }) },
  { nome: "papel da membership removido", codigo: "ACESSO_NEGADO", ajustar: (m) => { m.membros.set(UA, [{ empresa: A, papel: "VISITANTE", ativa: true }]); return {}; } },
  { nome: "membership inativa", codigo: "ACESSO_NEGADO", ajustar: (m) => { m.membros.set(UA, [{ empresa: A, papel: "ADMINISTRATIVO", ativa: false }]); return {}; } },
  { nome: "usuário inativo", codigo: "ACESSO_NEGADO", ajustar: (m) => { m.usuariosAtivos.delete(UA); return {}; } },
  { nome: "empresa bloqueada (status)", codigo: "ACESSO_NEGADO", ajustar: (m) => { m.empresasAtivas.delete(A); return {}; } },
  { nome: "concessão revogada", codigo: "ACESSO_NEGADO", ajustar: (m) => { m.revogadas.add("c-a"); return {}; } },
  { nome: "assinatura bloqueada", codigo: "ASSINATURA_NECESSARIA", ajustar: (m) => { m.bloqueadas.add(A); return {}; } },
  { nome: "prazo esgotado", codigo: "INDISPONIVEL", ajustar: (m) => ({ extra: { async recebiveis() { m.leituras.push("lento"); return new Promise(() => undefined); }, async agenda() { m.leituras.push("lento"); return new Promise(() => undefined); } } }) },
  // Revisão P2-6: a espera acontece ANTES da leitura (trava do tenant/concessão): o prazo cobre a transação inteira.
  { nome: "transação presa antes da leitura", codigo: "INDISPONIVEL", ajustar: () => ({ extra: { withTenantTransaction: () => new Promise<never>(() => undefined) } }) },
  { nome: "saída fora do schema", codigo: "INDISPONIVEL", ajustar: (m) => ({ extra: { async agenda() { m.leituras.push("x"); return [{ ...FESTAS[A][0], horaInicio: "<script>" }]; }, async recebiveis() { m.leituras.push("x"); return [rec({ saldoCentavos: 1.5 })]; } } }) },
];

for (const caso of CASOS) {
  test(`recusa sem retorno parcial (A4): ${caso.nome}`, { timeout: 15_000 }, async () => {
    for (const nome of ["kidmais_consultar_agenda", "kidmais_consultar_recebiveis_resumo"] as const) {
      const m = mundo();
      const { env, principal, extra } = caso.ajustar(m);
      const eventos: EventoFerramenta[] = [];
      let dados: unknown = null;
      await assert.rejects(
        (async () => { dados = await executarFerramentaMcp(nome, {}, principal ?? principalA, deps(m, env ?? ENV_OK, eventos, extra)); })(),
        (e: unknown) => e instanceof ErroCanalMcp && e.codigo === caso.codigo,
      );
      assert.equal(dados, null);
      if (!["prazo esgotado", "saída fora do schema"].includes(caso.nome)) assert.deepEqual(m.leituras, [], "fonte de negócio não foi lida");
      assert.equal(eventos.length, 1);
      assert.equal(eventos[0].codigo, caso.codigo);
    }
  });
}

test("prazo esgotado: a recusa chega dentro do prazo do manifesto (≤ 5 s), sem esperar a fonte", { timeout: 10_000 }, async () => {
  const inicio = Date.now();
  await assert.rejects(executarFerramentaMcp("kidmais_consultar_agenda", {}, principalA, deps(mundo(), ENV_OK, [], { agenda: () => new Promise(() => undefined) })));
  assert.ok(Date.now() - inicio < 6000);
});

test("auditoria sanitizada: só ids, códigos e contagens (A10)", async () => {
  const eventos: EventoFerramenta[] = [];
  const m = mundo();
  await executarFerramentaMcp("kidmais_consultar_agenda", {}, principalA, deps(m, ENV_OK, eventos));
  await executarFerramentaMcp("kidmais_buscar_conhecimento", { consulta: "Maria Aparecida contas a receber token kma_SEGREDO" }, principalA, deps(m, ENV_OK, eventos));
  await assert.rejects(executarFerramentaMcp("kidmais_consultar_agenda", {}, { ...principalA, escopos: [] }, deps(m, ENV_OK, eventos)));
  assert.equal(eventos.length, 3);
  for (const e of eventos) {
    assert.deepEqual(Object.keys(e).sort(), ["capacidade", "clientId", "codigo", "concessaoId", "duracaoMs", "empresaId", "itens", "resultado", "usuarioId"]);
    assert.doesNotMatch(JSON.stringify(e), /Maria|SEGREDO|kma_|Pacote|receber token/);
  }
  assert.deepEqual(eventos.map((e) => e.resultado), ["OK", "SEM_DADOS", "NEGADO"]);
});

// ---------------------------------------------------------------- rodada 2 da revisão (achado 7)

test("achado 7: volume acima do teto é recusado no banco ANTES de materializar a lista; auditoria registra a recusa", async () => {
  const m = mundo();
  const eventos: EventoFerramenta[] = [];
  let contados = 0;
  const d = deps(m, ENV_OK, eventos, { async contarRecebiveis(_t, _e, teto) { contados += 1; assert.equal(teto, 5000); return teto + 1; } });
  await assert.rejects(executarFerramentaMcp("kidmais_consultar_recebiveis_resumo", {}, principalA, d), (e: ErroCanalMcp) => e.codigo === "VOLUME_ACIMA_DO_LIMITE");
  assert.equal(contados, 1);
  assert.equal(m.leituras.filter((l) => l.startsWith("recebiveis")).length, 0, "lista nunca carregada");
  assert.equal(eventos.at(-1)?.codigo, "VOLUME_ACIMA_DO_LIMITE");
  const exato = deps(mundo(), ENV_OK, [], { async contarRecebiveis() { return 5000; } });
  assert.equal((await executarFerramentaMcp("kidmais_consultar_recebiveis_resumo", {}, principalA, exato)).contrato, "kidmais.mcp.recebiveis.v1", "no teto ainda responde");
});

test("achado 7: DTO em uma passada é igual à versão por listas e não estoura com listas enormes; itens auditados respeitam o CHECK", async () => {
  // Referência: a implementação anterior (listas intermediárias), só para comparar resultados.
  const ref = (lista: readonly ReturnType<typeof rec>[]) => {
    const abertos = lista.filter((r) => ["A receber", "Parcialmente pago", "Vencido"].includes(r.status));
    const venc = abertos.filter((r) => r.status === "Vencido");
    const m = (l: typeof lista) => ({ quantidade: l.length, totalCentavos: l.reduce((s, r) => s + r.saldoCentavos, 0) });
    return { emAberto: m(abertos), vencidos: m(venc), faixa60: m(venc.filter((r) => r.diasAtraso > 60)), maior: venc.length ? venc.reduce((x, r) => Math.max(x, r.diasAtraso), 0) : null };
  };
  const status = ["A receber", "Parcialmente pago", "Vencido", "Pago", "Cancelado"] as const;
  let semente = 7;
  const aleatorio = () => (semente = (semente * 1103515245 + 12345) % 2147483648) / 2147483648;
  const lista = Array.from({ length: 200_000 }, (_, i) => {
    const s = status[Math.floor(aleatorio() * status.length)];
    return rec({ id: String(i), status: s, saldoCentavos: Math.floor(aleatorio() * 100000), diasAtraso: s === "Vencido" ? Math.floor(aleatorio() * 120) : 0, vencimento: "2026-11-01" });
  });
  const dto = dtoRecebiveis(lista, HOJE);
  const r = ref(lista);
  assert.deepEqual(dto.emAberto, r.emAberto);
  assert.deepEqual(dto.vencidos, r.vencidos);
  assert.deepEqual({ quantidade: dto.faixasAtraso[2].quantidade, totalCentavos: dto.faixasAtraso[2].totalCentavos }, r.faixa60);
  assert.equal(dto.maiorAtrasoDias, r.maior);
  assert.ok(dto.emAberto.quantidade > ITENS_AUDITORIA_MAX);

  const eventos: EventoFerramenta[] = [];
  const d = deps(mundo(), ENV_OK, eventos, { async contarRecebiveis() { return 10; }, async recebiveis() { return lista; } });
  await executarFerramentaMcp("kidmais_consultar_recebiveis_resumo", {}, principalA, d);
  assert.equal(eventos.at(-1)?.itens, ITENS_AUDITORIA_MAX, "contagem auditada limitada ao CHECK (itens ≤ 10000)");
});
