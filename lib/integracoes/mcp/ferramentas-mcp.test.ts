import assert from "node:assert/strict";
import test from "node:test";
import { reaisDe } from "../../financeiro/calculos.ts";
import { SEM_PORTAS, type ContextoFerramenta } from "../../inteligencia/ferramentas.ts";
import { montarAgenda } from "../../inteligencia/leituras/agenda-do-dia.ts";
import { montarAnaliseRecebiveis } from "../../inteligencia/leituras/analisar-recebiveis.ts";
import { chaveProibida } from "../../inteligencia/registro-ferramentas.ts";
import {
  ErroCanalMcp, ITENS_AUDITORIA_MAX, LIMITE_AGENDA_PERIODO, consultaLiberadaNoAmbiente, dataBrasiliaDoInstante, dtoRecebiveis, executarFerramentaMcp,
  type DependenciasFerramentasMcp, type EventoFerramenta, type NomeFerramentaMcp, type PrincipalMcp,
} from "./ferramentas.ts";
import { A, AGORA, B, DISPONIBILIDADE, ENV_OK, FESTAS, HOJE, PENDENTES, RECEBIVEIS, UA, UB, deps, mundo, principalA, rec, type Mundo } from "./apoio-mcp.test.ts";

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
  { nome: "prazo esgotado", codigo: "INDISPONIVEL", ajustar: (m) => {
    const lento = <T>(): Promise<T> => { m.leituras.push("lento"); return new Promise<T>(() => undefined); };
    return { extra: { recebiveis: lento, agenda: lento, agendaPeriodo: lento, disponibilidade: lento, contratosPendentes: lento } };
  } },
  // Revisão P2-6: a espera acontece ANTES da leitura (trava do tenant/concessão): o prazo cobre a transação inteira.
  { nome: "transação presa antes da leitura", codigo: "INDISPONIVEL", ajustar: () => ({ extra: { withTenantTransaction: () => new Promise<never>(() => undefined) } }) },
  { nome: "saída fora do schema", codigo: "INDISPONIVEL", ajustar: (m) => ({ extra: {
    async agenda() { m.leituras.push("x"); return [{ ...FESTAS[A][0], horaInicio: "<script>" }]; },
    async recebiveis() { m.leituras.push("x"); return [rec({ saldoCentavos: 1.5 })]; },
    async agendaPeriodo() { m.leituras.push("x"); return [{ ...FESTAS[A][0], horaInicio: "<script>" }]; },
    async disponibilidade(_t, e, i) { m.leituras.push("x"); const d = DISPONIBILIDADE[A](i); d[0].periodos[0].horarioInicioPadrao = "<script>"; return { configurada: true, alcance: "EMPRESA", dias: d }; },
    async contratosPendentes() { m.leituras.push("x"); return { total: 1, contratos: [{ ...PENDENTES[A].contratos[0], criadoEm: "ontem à tarde" }] }; },
  } }) },
];

/** Argumentos válidos de cada ferramenta de dados (as da etapa 0a exigem período). */
const ARGS: Record<string, Record<string, unknown>> = {
  kidmais_consultar_agenda: {},
  kidmais_consultar_recebiveis_resumo: {},
  kidmais_consultar_agenda_periodo: { inicio: HOJE, fim: "2026-11-30" },
  kidmais_consultar_datas_livres: { inicio: HOJE, fim: "2026-11-30", convidados: 80 },
  kidmais_consultar_contratos_pendentes: {},
};
const DE_DADOS = Object.keys(ARGS) as (keyof typeof ARGS & NomeFerramentaMcp)[];

for (const caso of CASOS) {
  test(`recusa sem retorno parcial (A4): ${caso.nome}`, { timeout: 40_000 }, async () => {
    for (const nome of DE_DADOS) {
      const m = mundo();
      const { env, principal, extra } = caso.ajustar(m);
      const eventos: EventoFerramenta[] = [];
      let dados: unknown = null;
      await assert.rejects(
        (async () => { dados = await executarFerramentaMcp(nome, ARGS[nome], principal ?? principalA, deps(m, env ?? ENV_OK, eventos, extra)); })(),
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

// ---------------------------------------------------------------- contexto da resposta: período, fonte, ausência × permissão

test("agenda sem festas: resposta válida com data, fonte e ausência distinta de falta de permissão", async () => {
  const r = await executarFerramentaMcp("kidmais_consultar_agenda", { dia: "hoje" }, principalA, deps(mundo(), ENV_OK, [], { async agenda() { return []; } }));
  assert.equal(r.totalFestas, 0);
  assert.match(r.observacao, new RegExp(r.data));
  assert.match(r.observacao, /Fonte: agenda registrada no iA\.Fest/);
  assert.match(r.observacao, /ausência de registros, não falta de permissão/);
  assert.match(r.observacao, /Não indica disponibilidade/);
});

test("agenda com festas e truncada mantêm período e fonte", async () => {
  const comFestas = await executarFerramentaMcp("kidmais_consultar_agenda", {}, principalA, deps(mundo()));
  assert.match(comFestas.observacao, new RegExp(`Fonte: .* em ${comFestas.data}`));
  assert.doesNotMatch(comFestas.observacao, /ausência/);
  const muitas = Array.from({ length: 51 }, (_, i) => ({ ...FESTAS[A][0], festaId: `f-${i}` }));
  const truncada = await executarFerramentaMcp("kidmais_consultar_agenda", {}, principalA, deps(mundo(), ENV_OK, [], { async agenda() { return muitas; } }));
  assert.match(truncada.observacao, /Lista limitada às primeiras 50/);
  assert.match(truncada.observacao, new RegExp(truncada.data));
});

test("recebíveis zerados: ausência de lançamentos, com data de referência; com valores, sem falar em ausência", async () => {
  const vazio = await executarFerramentaMcp("kidmais_consultar_recebiveis_resumo", {}, principalA, deps(mundo(), ENV_OK, [], { async recebiveis() { return []; }, async contarRecebiveis() { return 0; } }));
  assert.match(vazio.observacao, new RegExp(vazio.dataReferencia));
  assert.match(vazio.observacao, /ausência de lançamentos abertos, não falta de permissão/);
  const cheio = await executarFerramentaMcp("kidmais_consultar_recebiveis_resumo", {}, principalA, deps(mundo()));
  assert.match(cheio.observacao, /Fonte: contas a receber registradas no iA\.Fest/);
  assert.doesNotMatch(cheio.observacao, /ausência/);
});

test("permissão faltando é erro, nunca lista vazia: nada lido da fonte", async () => {
  const m = mundo();
  await assert.rejects(
    executarFerramentaMcp("kidmais_consultar_agenda", {}, { ...principalA, escopos: ["conhecimento:read"] }, deps(m)),
    (e: ErroCanalMcp) => e.codigo === "ESCOPO_INSUFICIENTE" && /falta de permissão, não ausência de dados/.test(e.message) && /deseja manter e as que deseja adicionar: a nova autorização substitui a anterior/.test(e.message),
  );
  assert.deepEqual(m.leituras, []);
});

test("busca sem correspondência: falta de evidência, distinta de falta de permissão", async () => {
  const r = await executarFerramentaMcp("kidmais_buscar_conhecimento", { consulta: "zzzz inexistente qqqq" }, principalA, deps(mundo()));
  assert.equal(r.semEvidencia, true);
  assert.match(r.observacao, /falta evidência documental, não permissão/);
});

// 11º parecer, P2: a tela usa consultaLiberadaNoAmbiente para não oferecer a pergunta pronta que seria recusada. Ela
// precisa dizer "não" em todas as recusas de AMBIENTE da execução, e "sim" quando a execução passa.
test("consultaLiberadaNoAmbiente acompanha as recusas de ambiente da execução", async () => {
  assert.equal(consultaLiberadaNoAmbiente(ENV_OK, "kidmais_buscar_conhecimento", A), true);
  const ambiente = CASOS.filter((c) => c.codigo === "CANAL_DESATIVADO");
  assert.ok(ambiente.length >= 6);
  for (const caso of ambiente) {
    const env = caso.ajustar(mundo()).env;
    assert.ok(env, caso.nome);
    assert.equal(consultaLiberadaNoAmbiente(env as typeof ENV_OK, "kidmais_buscar_conhecimento", A), false, caso.nome);
  }
});

// 12º parecer, P2: o segredo das referências é porta de ambiente da busca; sem ele a tela não oferece a pergunta e a
// execução responde INDISPONIVEL. Controle positivo: com o segredo, as duas liberam.
test("sem MCP_REF_SECRET (ou curto), a liberação da busca e a execução concordam: fechadas", async () => {
  for (const segredo of [undefined, "curto"]) {
    const env = { ...ENV_OK, MCP_REF_SECRET: segredo };
    assert.equal(consultaLiberadaNoAmbiente(env, "kidmais_buscar_conhecimento", A), false);
    assert.equal(consultaLiberadaNoAmbiente(env, "kidmais_obter_trecho", A), false);
    assert.equal(consultaLiberadaNoAmbiente(env, "kidmais_consultar_agenda", A), true, "a agenda não usa o segredo");
    await assert.rejects(executarFerramentaMcp("kidmais_buscar_conhecimento", { consulta: "onde vejo contas a receber" }, principalA, deps(mundo(), env)), (e: ErroCanalMcp) => e.codigo === "INDISPONIVEL");
  }
  assert.equal(consultaLiberadaNoAmbiente(ENV_OK, "kidmais_buscar_conhecimento", A), true);
  await executarFerramentaMcp("kidmais_buscar_conhecimento", { consulta: "onde vejo contas a receber" }, principalA, deps(mundo()));
});

// ---------------------------------------------------------------- etapa 0a: agenda por período, datas livres, contratos pendentes

/** Mesma lista de PII + o texto livre do painel na disponibilidade (nome/código do período, id de configuração). */
const PII_0A = new RegExp(`${PII.source}|Tarde|Noite|COD_|cfg-|segredo|ct-a|ct-b|criadoEm|dataEvento|contratoId|festaId|configuracaoId|nome|codigo`);
const principalB: PrincipalMcp = { ...principalA, concessaoId: "c-b", usuarioId: UB, empresaId: B };

test("0a agenda por período: por dia, sem nomes nem pacote; canceladas fora; totais e dia da semana", async () => {
  const m = mundo();
  const eventos: EventoFerramenta[] = [];
  const r = await executarFerramentaMcp("kidmais_consultar_agenda_periodo", { inicio: HOJE, fim: "2026-11-30" }, principalA, deps(m, ENV_OK, eventos));
  assert.deepEqual(m.leituras, [`agendaPeriodo:${A}:${HOJE}:2026-11-30:${LIMITE_AGENDA_PERIODO + 1}`]);
  assert.equal(r.contrato, "kidmais.mcp.agenda.periodo.v1");
  assert.deepEqual(r.dias, [{
    data: HOJE, diaSemana: "TERCA",
    festas: [{ inicio: "14:00", fim: "18:00", situacao: "CONTRATO_ASSINADO", convidados: 80 }, { inicio: "19:00", fim: null, situacao: "CONTRATO_PENDENTE", convidados: 50 }],
    totalFestas: 2, totalConvidados: 130, contratosPendentes: 1,
  }]);
  assert.equal(r.totalFestas, 2);
  assert.equal(r.truncado, false);
  assert.equal(r.coberturaAte, "2026-11-30");
  assert.match(r.observacao, /não indica disponibilidade/);
  assert.doesNotMatch(JSON.stringify(r), PII_0A);
  assert.equal(chaveProibida(r), null);
  assert.equal(eventos[0].itens, 2);
});

test("0a agenda por período: truncamento nunca corta um dia ao meio e declara até onde vale", async () => {
  const festa = (data: string, i: number) => ({ ...FESTAS[A][0], festaId: `f-${data}-${i}`, data });
  // 149 festas em 01/11 + 2 em 02/11 (151 = limite + 1): o dia 02 sai inteiro, cobertura até 01/11.
  const metade = [...Array.from({ length: 149 }, (_, i) => festa("2026-11-01", i)), festa("2026-11-02", 0), festa("2026-11-02", 1)];
  const r = await executarFerramentaMcp("kidmais_consultar_agenda_periodo", { inicio: HOJE, fim: "2026-11-30" }, principalA, deps(mundo(), ENV_OK, [], { async agendaPeriodo() { return metade; } }));
  assert.equal(r.truncado, true);
  assert.equal(r.coberturaAte, "2026-11-01");
  assert.deepEqual(r.dias.map((d) => d.data), ["2026-11-01"]);
  assert.equal(r.totalFestas, 149);
  assert.match(r.observacao, /até 2026-11-01/);
  // 150 em 01/11 + 1 em 02/11: o excedente é de outro dia, as 150 ficam.
  const exato = [...Array.from({ length: 150 }, (_, i) => festa("2026-11-01", i)), festa("2026-11-02", 0)];
  const r2 = await executarFerramentaMcp("kidmais_consultar_agenda_periodo", { inicio: HOJE, fim: "2026-11-30" }, principalA, deps(mundo(), ENV_OK, [], { async agendaPeriodo() { return exato; } }));
  assert.equal(r2.totalFestas, 150);
  assert.equal(r2.coberturaAte, "2026-11-01");
  // Um único dia com mais de 150: nenhum dia completo, cobertura nula, lista vazia e aviso.
  const umDia = Array.from({ length: 151 }, (_, i) => festa("2026-11-01", i));
  const r3 = await executarFerramentaMcp("kidmais_consultar_agenda_periodo", { inicio: HOJE, fim: "2026-11-30" }, principalA, deps(mundo(), ENV_OK, [], { async agendaPeriodo() { return umDia; } }));
  assert.equal(r3.coberturaAte, null);
  assert.deepEqual(r3.dias, []);
  assert.match(r3.observacao, /nenhum dia completo/);
  assert.match(r3.observacao, /consulte um dia por vez/);
  assert.match(r3.observacao, /limite de 150 festas por consulta impede a leitura completa/);
  assert.ok(r3.observacao.length <= 500);
});

test("0a tetos de período: acima de 62 dias, invertido, data inexistente, fora da janela ou chave extra ⇒ recusa sem ler a fonte", async () => {
  const casos: [NomeFerramentaMcp, Record<string, unknown>, string][] = [
    ["kidmais_consultar_agenda_periodo", { inicio: "2026-11-01", fim: "2027-01-02" }, "PERIODO_INVALIDO"], // 63 dias
    ["kidmais_consultar_agenda_periodo", { inicio: "2026-11-10", fim: "2026-11-01" }, "PERIODO_INVALIDO"],
    ["kidmais_consultar_agenda_periodo", { inicio: "2026-02-30", fim: "2026-03-01" }, "PERIODO_INVALIDO"],
    ["kidmais_consultar_agenda_periodo", { inicio: "2025-10-01", fim: "2025-10-02" }, "PERIODO_INVALIDO"], // > 366 dias atrás
    ["kidmais_consultar_agenda_periodo", { inicio: "2028-11-01", fim: "2028-11-02" }, "PERIODO_INVALIDO"], // > 730 dias à frente
    ["kidmais_consultar_agenda_periodo", { inicio: HOJE }, "DADOS_INVALIDOS"],
    ["kidmais_consultar_agenda_periodo", { inicio: HOJE, fim: HOJE, empresaId: B }, "DADOS_INVALIDOS"],
    ["kidmais_consultar_datas_livres", { inicio: "2026-10-26", fim: "2026-10-30" }, "PERIODO_INVALIDO"], // começa ontem
    ["kidmais_consultar_datas_livres", { inicio: HOJE, fim: "2026-12-28" }, "PERIODO_INVALIDO"], // 63 dias
    ["kidmais_consultar_datas_livres", { inicio: HOJE, fim: HOJE, convidados: 0 }, "DADOS_INVALIDOS"],
    ["kidmais_consultar_datas_livres", { inicio: HOJE, fim: HOJE, convidados: 5001 }, "DADOS_INVALIDOS"],
    ["kidmais_consultar_datas_livres", { inicio: HOJE, fim: HOJE, convidados: 10.5 }, "DADOS_INVALIDOS"],
    ["kidmais_consultar_contratos_pendentes", { limite: 1000 }, "DADOS_INVALIDOS"],
  ];
  for (const [nome, args, codigo] of casos) {
    const m = mundo();
    const eventos: EventoFerramenta[] = [];
    await assert.rejects(executarFerramentaMcp(nome, args, principalA, deps(m, ENV_OK, eventos)), (e: ErroCanalMcp) => e.codigo === codigo && e.resultado === "INVALIDO", `${nome} ${JSON.stringify(args)}`);
    assert.deepEqual(m.leituras, [], `${nome} ${JSON.stringify(args)}: nada lido`);
    assert.equal(eventos[0].codigo, codigo);
  }
  // Limites exatos ainda respondem: 62 dias e a janela de datas livres começando hoje.
  const m = mundo();
  await executarFerramentaMcp("kidmais_consultar_agenda_periodo", { inicio: "2026-11-01", fim: "2027-01-01" }, principalA, deps(m));
  await executarFerramentaMcp("kidmais_consultar_datas_livres", { inicio: HOJE, fim: "2026-12-27" }, principalA, deps(m));
  assert.equal(m.leituras.length, 2);
});

test("0a datas livres: só horários padrão, contagens e motivo; nome/código/id do período não saem", async () => {
  const m = mundo();
  const r = await executarFerramentaMcp("kidmais_consultar_datas_livres", { inicio: HOJE, fim: "2026-10-28" }, principalA, deps(m));
  assert.deepEqual(m.leituras, [`disponibilidade:${A}:${HOJE}:2026-10-28:null`], "sem convidados ⇒ null para a fonte");
  assert.equal(r.convidados, null);
  assert.equal(r.capacidadeConferida, false);
  assert.deepEqual(r.dias[0], {
    data: HOJE, diaSemana: "TERCA", livre: true, motivo: "OK", periodosTruncados: false,
    periodos: [
      { inicioPadrao: "13:00", fimPadrao: "17:00", livre: true, horariosLivres: 2, primeiroInicioLivre: "13:00", ultimoInicioLivre: "13:30", motivo: null },
      { inicioPadrao: "18:00", fimPadrao: "22:00", livre: false, horariosLivres: 0, primeiroInicioLivre: null, ultimoInicioLivre: null, motivo: null },
    ],
  });
  assert.deepEqual({ livre: r.dias[1].livre, motivo: r.dias[1].motivo }, { livre: false, motivo: "OCUPADO" });
  assert.equal(r.diasLivres, 1);
  assert.match(r.observacao, /não reserva/);
  assert.doesNotMatch(JSON.stringify(r), PII_0A);
  assert.equal(chaveProibida(r), null);
});

test("0a datas livres com convidados: CAPACIDADE vem da fonte; horário disponível sem salão que comporte não conta como livre", async () => {
  const dias = DISPONIBILIDADE[A](HOJE).slice(0, 1);
  dias[0].periodos[0].horarios = dias[0].periodos[0].horarios.map((h) => ({ ...h, capacidade: { opcoes: 0, motivo: h.status === "DISPONIVEL" ? "CAPACIDADE" as const : "OCUPADO" as const } }));
  dias[0].periodos[0].capacidade = { opcoes: 0, motivo: "CAPACIDADE" };
  dias[0].motivoDia = { opcoes: 0, motivo: "CAPACIDADE" };
  const m = mundo();
  const r = await executarFerramentaMcp("kidmais_consultar_datas_livres", { inicio: HOJE, fim: HOJE, convidados: 300 }, principalA, deps(m, ENV_OK, [], {
    async disponibilidade(_t, _e, _i, _f, convidados) { m.leituras.push(`conv:${convidados}`); return { configurada: true, alcance: "EMPRESA", dias }; },
  }));
  assert.deepEqual(m.leituras, ["conv:300"]);
  assert.equal(r.capacidadeConferida, true);
  assert.deepEqual({ livre: r.dias[0].livre, motivo: r.dias[0].motivo }, { livre: false, motivo: "CAPACIDADE" });
  assert.equal(r.dias[0].periodos[0].horariosLivres, 0);
  assert.equal(r.dias[0].periodos[0].motivo, "CAPACIDADE");
  assert.match(r.observacao, /300 convidados/);
});

test("0a datas livres: agenda sem horários configurados ⇒ INDISPONIVEL próprio, distinto de permissão e de ausência", async () => {
  const eventos: EventoFerramenta[] = [];
  await assert.rejects(
    executarFerramentaMcp("kidmais_consultar_datas_livres", { inicio: HOJE, fim: HOJE }, principalA, deps(mundo(), ENV_OK, eventos, { async disponibilidade() { return { configurada: false }; } })),
    (e: ErroCanalMcp) => e.codigo === "AGENDA_NAO_CONFIGURADA" && e.resultado === "INDISPONIVEL" && !e.escopo && /não é ausência de festas nem falta de permissão/.test(e.message),
  );
  assert.equal(eventos[0].codigo, "AGENDA_NAO_CONFIGURADA");
  // Cabe no CHECK da auditoria (codigo ~ '^[A-Za-z0-9_:,]{1,80}$', resultado ~ '^[A-Z_]{1,24}$').
  assert.match(eventos[0].codigo, /^[A-Za-z0-9_:,]{1,80}$/);
  assert.match(eventos[0].capacidade, /^[a-z_]{1,64}$/);
});

test("0a contratos pendentes: quantidade e dias, sem cliente, pacote, id nem data de criação", async () => {
  const m = mundo();
  const r = await executarFerramentaMcp("kidmais_consultar_contratos_pendentes", {}, principalA, deps(m));
  assert.deepEqual(m.leituras, [`contratosPendentes:${A}:100:${HOJE}`]);
  assert.equal(r.quantidade, 2);
  assert.equal(r.dataReferencia, HOJE);
  // 20/10 13:00Z ⇒ 20/10 em Brasília (7 dias); 01/10 01:30-03 ⇒ 01/10 (26 dias). Festa em 05/11 (+9) e em 20/10 (−7, já passou).
  assert.deepEqual(r.contratos, [{ diasDesdeCriacao: 7, diasAteFesta: 9 }, { diasDesdeCriacao: 26, diasAteFesta: -7 }]);
  assert.equal(r.truncado, false);
  assert.doesNotMatch(JSON.stringify(r), PII_0A);
  assert.equal(chaveProibida(r), null);
  const vazio = await executarFerramentaMcp("kidmais_consultar_contratos_pendentes", {}, principalA, deps(mundo(), ENV_OK, [], { async contratosPendentes() { return { total: 0, contratos: [] }; } }));
  assert.match(vazio.observacao, /ausência de pendências, não falta de permissão/);
  const muitos = await executarFerramentaMcp("kidmais_consultar_contratos_pendentes", {}, principalA, deps(mundo(), ENV_OK, [], {
    async contratosPendentes() { return { total: 250, contratos: Array.from({ length: 100 }, () => PENDENTES[A].contratos[0]) }; },
  }));
  assert.equal(muitos.quantidade, 250);
  assert.equal(muitos.contratos.length, 100);
  assert.equal(muitos.truncado, true);
});

test("0a fuso: 'hoje' é o de Brasília perto da meia-noite UTC; instantes do banco com qualquer deslocamento", async () => {
  // 28/10 02:30Z ainda é 27/10 em Brasília: datas livres aceita começar em 27/10 e contratos contam a partir de 27/10.
  const madrugada = new Date("2026-10-28T02:30:00Z");
  const m = mundo();
  const r = await executarFerramentaMcp("kidmais_consultar_datas_livres", { inicio: HOJE, fim: HOJE }, principalA, { ...deps(m), agora: () => madrugada });
  assert.equal(r.inicio, HOJE);
  const c = await executarFerramentaMcp("kidmais_consultar_contratos_pendentes", {}, principalA, { ...deps(mundo()), agora: () => madrugada });
  assert.equal(c.dataReferencia, HOJE);
  // 03:00Z de 28/10 já é 28/10 00:00 em Brasília: começar em 27/10 vira passado.
  await assert.rejects(
    executarFerramentaMcp("kidmais_consultar_datas_livres", { inicio: HOJE, fim: HOJE }, principalA, { ...deps(mundo()), agora: () => new Date("2026-10-28T03:00:00Z") }),
    (e: ErroCanalMcp) => e.codigo === "PERIODO_INVALIDO",
  );
  assert.equal(dataBrasiliaDoInstante("2026-10-28 02:59:59.999999+00"), "2026-10-27");
  assert.equal(dataBrasiliaDoInstante("2026-10-28 03:00:00+00"), "2026-10-28");
  assert.equal(dataBrasiliaDoInstante("2026-10-27 23:30:00-03"), "2026-10-27");
  assert.equal(dataBrasiliaDoInstante("2026-10-28T05:00:00+05:30"), "2026-10-27");
  assert.equal(dataBrasiliaDoInstante("2026-10-28T02:00:00Z"), "2026-10-27");
  assert.equal(dataBrasiliaDoInstante("ontem"), null);
});

test("0a isolamento A/B: concessão de A nunca lê B nas três ferramentas; controle positivo em B", async () => {
  const m = mundo();
  for (const nome of ["kidmais_consultar_agenda_periodo", "kidmais_consultar_datas_livres", "kidmais_consultar_contratos_pendentes"] as const) {
    const r = await executarFerramentaMcp(nome, ARGS[nome], principalA, deps(m));
    assert.doesNotMatch(JSON.stringify(r), /999|09:00|-12-01|secreto|Secreto/, nome);
    // Principal adulterado (usuário de A apontando B): o Tenant Context recusa antes de qualquer leitura.
    const antes = m.leituras.length;
    await assert.rejects(executarFerramentaMcp(nome, ARGS[nome], { ...principalA, empresaId: B }, deps(m)), (e: ErroCanalMcp) => e.codigo === "ACESSO_NEGADO", nome);
    assert.equal(m.leituras.length, antes, `${nome}: nada lido na recusa`);
  }
  assert.ok(m.leituras.every((l) => !l.includes(B)), "nenhuma leitura em B");
  const mb = mundo();
  const agendaB = await executarFerramentaMcp("kidmais_consultar_agenda_periodo", ARGS.kidmais_consultar_agenda_periodo, principalB, deps(mb));
  assert.equal(agendaB.totalConvidados, 999);
  const livresB = await executarFerramentaMcp("kidmais_consultar_datas_livres", ARGS.kidmais_consultar_datas_livres, principalB, deps(mb));
  assert.equal(livresB.dias[0].periodos[0].inicioPadrao, "09:00");
  const pendB = await executarFerramentaMcp("kidmais_consultar_contratos_pendentes", {}, principalB, deps(mb));
  assert.equal(pendB.quantidade, 1);
  assert.ok(mb.leituras.every((l) => l.includes(B) && !l.includes(A)));
});

test("0a papéis e escopo: REPRESENTANTE_AUTORIZADO lê; escopo financeiro sozinho não lê; consultaLiberadaNoAmbiente segue a agenda", async () => {
  await executarFerramentaMcp("kidmais_consultar_contratos_pendentes", {}, principalB, deps(mundo()));
  for (const nome of ["kidmais_consultar_agenda_periodo", "kidmais_consultar_datas_livres", "kidmais_consultar_contratos_pendentes"] as const) {
    const m = mundo();
    await assert.rejects(executarFerramentaMcp(nome, ARGS[nome], { ...principalA, escopos: ["financeiro:read", "conhecimento:read"] }, deps(m)), (e: ErroCanalMcp) => e.codigo === "ESCOPO_INSUFICIENTE" && e.escopo === "agenda:read", nome);
    assert.deepEqual(m.leituras, []);
    assert.equal(consultaLiberadaNoAmbiente(ENV_OK, nome, A), true, nome);
    assert.equal(consultaLiberadaNoAmbiente({ ...ENV_OK, MCP_TENANT_ALLOWLIST: B }, nome, A), false, nome);
  }
});

// ---------------------------------------------------------------- revisão r1 (Astra)

test("r1 P2-1 datas livres: hoje só contam inícios depois da hora de Brasília; contagem, extremos e motivo recalculados", async () => {
  // 16:15Z = 13:15 em Brasília: 13:00 já passou, 13:30 ainda não.
  const meio = await executarFerramentaMcp("kidmais_consultar_datas_livres", { inicio: HOJE, fim: "2026-10-28" }, principalA, deps(mundo(), ENV_OK, [], { agora: () => new Date("2026-10-27T16:15:00Z") }));
  assert.equal(meio.hojeAPartirDe, "13:15");
  assert.deepEqual(
    { livres: meio.dias[0].periodos[0].horariosLivres, primeiro: meio.dias[0].periodos[0].primeiroInicioLivre, ultimo: meio.dias[0].periodos[0].ultimoInicioLivre, livre: meio.dias[0].livre },
    { livres: 1, primeiro: "13:30", ultimo: "13:30", livre: true },
  );
  assert.match(meio.observacao, /Hoje \(2026-10-27\) só contam inícios depois das 13:15/);
  // 21:00Z = 18:00 em Brasília: a vaga das 13:30 já passou e o dia deixa de ser livre.
  const noite = await executarFerramentaMcp("kidmais_consultar_datas_livres", { inicio: HOJE, fim: HOJE }, principalA, deps(mundo(), ENV_OK, [], { agora: () => new Date("2026-10-27T21:00:00Z") }));
  assert.deepEqual({ livre: noite.dias[0].livre, motivo: noite.dias[0].motivo, livres: noite.dias[0].periodos[0].horariosLivres, primeiro: noite.dias[0].periodos[0].primeiroInicioLivre }, { livre: false, motivo: "OCUPADO", livres: 0, primeiro: null });
  assert.equal(noite.diasLivres, 0);
  // Exatamente no minuto do início: já não conta.
  const exato = await executarFerramentaMcp("kidmais_consultar_datas_livres", { inicio: HOJE, fim: HOJE }, principalA, deps(mundo(), ENV_OK, [], { agora: () => new Date("2026-10-27T16:30:00Z") }));
  assert.equal(exato.dias[0].periodos[0].horariosLivres, 0);
});

test("r1 P2-1 datas livres: período sem hoje não corta nada e hojeAPartirDe é null", async () => {
  const r = await executarFerramentaMcp("kidmais_consultar_datas_livres", { inicio: "2026-10-29", fim: "2026-10-29" }, principalA, deps(mundo(), ENV_OK, [], { agora: () => new Date("2026-10-27T23:00:00Z") }));
  assert.equal(r.hojeAPartirDe, null);
  assert.equal(r.dias[0].periodos[0].horariosLivres, 2, "13:00 e 13:30 de outro dia continuam livres");
  assert.doesNotMatch(r.observacao, /só contam inícios/);
});

test("r1 P2-1 datas livres com convidados: capacidade OK só em horário passado vira OCUPADO; capacidade conferida continua declarada", async () => {
  const dias = DISPONIBILIDADE[A](HOJE).slice(0, 1);
  dias[0].periodos = [dias[0].periodos[0]];
  dias[0].periodos[0].horarios = dias[0].periodos[0].horarios.map((h) => ({ ...h, capacidade: { opcoes: h.inicio === "13:00" ? 2 : 0, motivo: h.inicio === "13:00" ? "OK" as const : h.status === "DISPONIVEL" ? "CAPACIDADE" as const : "OCUPADO" as const } }));
  dias[0].periodos[0].capacidade = { opcoes: 2, motivo: "OK" };
  dias[0].motivoDia = { opcoes: 2, motivo: "OK" };
  const r = await executarFerramentaMcp("kidmais_consultar_datas_livres", { inicio: HOJE, fim: HOJE, convidados: 80 }, principalA, deps(mundo(), ENV_OK, [], {
    agora: () => new Date("2026-10-27T16:15:00Z"),
    async disponibilidade() { return { configurada: true, alcance: "EMPRESA", dias }; },
  }));
  assert.equal(r.capacidadeConferida, true);
  assert.deepEqual({ livre: r.dias[0].livre, motivo: r.dias[0].motivo, periodo: r.dias[0].periodos[0].motivo, livres: r.dias[0].periodos[0].horariosLivres }, { livre: false, motivo: "CAPACIDADE", periodo: "CAPACIDADE", livres: 0 });
});

test("r1 P2-2 datas livres: alcance da unidade única declarado no escopo e na observação", async () => {
  const r = await executarFerramentaMcp("kidmais_consultar_datas_livres", { inicio: HOJE, fim: HOJE }, principalA, deps(mundo(), ENV_OK, [], {
    async disponibilidade(_t, e, i) { return { configurada: true, alcance: "UNIDADE_UNICA", dias: DISPONIBILIDADE[e](i) }; },
  }));
  assert.equal(r.escopo, "UNIDADE_UNICA");
  assert.match(r.observacao, /da única unidade da empresa com agenda ativa/);
  assert.doesNotMatch(r.observacao, /empresa inteira/);
  const empresa = await executarFerramentaMcp("kidmais_consultar_datas_livres", { inicio: HOJE, fim: HOJE }, principalA, deps(mundo()));
  assert.equal(empresa.escopo, "EMPRESA");
  assert.match(empresa.observacao, /empresa inteira/);
});

test("r1 P2-4 agenda truncada: observação separa dias vazios dos não consultados", async () => {
  const festas = Array.from({ length: LIMITE_AGENDA_PERIODO + 1 }, (_, i) => ({
    festaId: `f${i}`, data: i < 100 ? "2026-11-01" : "2026-11-02", horaInicio: "10:00", horaFim: null, cliente: "x", pacote: "y", convidados: 1, contratoStatus: "ASSINADO",
  }));
  const r = await executarFerramentaMcp("kidmais_consultar_agenda_periodo", { inicio: "2026-11-01", fim: "2026-11-30" }, principalA, deps(mundo(), ENV_OK, [], { async agendaPeriodo() { return festas; } }));
  assert.equal(r.coberturaAte, "2026-11-01");
  assert.match(r.observacao, /até 2026-11-01, dias ausentes não têm festas; depois de 2026-11-01 os dias NÃO foram consultados/);
  assert.match(r.observacao, /Não trate dia fora da cobertura como vazio/);
});

test("r1 P3 contratos pendentes: a fonte recebe a data de referência para ordenar as próximas festas antes do limite", async () => {
  const m = mundo();
  const r = await executarFerramentaMcp("kidmais_consultar_contratos_pendentes", {}, principalA, deps(m, ENV_OK, [], { agora: () => new Date("2026-10-28T02:30:00Z") }));
  assert.deepEqual(m.leituras, [`contratosPendentes:${A}:100:2026-10-27`], "hoje de Brasília, não o dia UTC");
  assert.equal(r.dataReferencia, "2026-10-27");
});
