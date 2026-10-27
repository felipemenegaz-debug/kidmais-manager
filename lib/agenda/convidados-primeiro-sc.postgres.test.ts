import test from "node:test";
import assert from "node:assert/strict";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import type { DbExecutor } from "../db/contracts.ts";
import { catalogoNativo, catalogoNoTurno, cenario, dia, id, type Cenario } from "../../scripts/integracao-importados-test-support.ts";
import { consultarDisponibilidadeData, consultarDisponibilidadePeriodo, revalidarHorarioSelecionado } from "../disponibilidade/services/availability.service.ts";
import { escolherSalao } from "./salao-festa.ts";
import { carregarComBanco, executor, porTransacao } from "../marketing/harness-postgres.ts";
import * as cotacaoPublicaReal from "../comercial/cotacao-publica.ts";
import * as escopoReal from "../disponibilidade/escopo.ts";

/**
 * S-C (convidados primeiro) no PostgreSQL DESCARTÁVEL (modelo 097: 093/094 aplicadas): dois salões (50 e 120), festa de
 * 80 convidados. A disponibilidade conta só salão livre que comporta e diz o motivo (OK / OCUPADO / CAPACIDADE); a
 * revalidação da cotação e do envio recusa com SEM_SALAO_PARA_CONVIDADOS sem gravar; a escolha do salão na reserva
 * prefere o que comporta (o preferido/atual continua vencendo; sem nenhum que comporte, o primeiro livre — limite
 * declarado). Sem convidados, tudo como antes. Outra empresa não entra na conta.
 */
let a: Client;
let tx: DbExecutor;

async function horario(c: Cenario, codigo: string) {
  return id(a, `INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, tolerancia_inicio_minutos, passo_inicio_minutos,
                ordem_exibicao, empresa_id, capacidade) VALUES ($1, $1, '15:00', '19:00', 0, 30, 1, $2::uuid, 1) RETURNING id`, [codigo, c.empresa]);
}

async function porSalao(c: Cenario) {
  await a.query(`INSERT INTO agenda_escopo_config (empresa_id, modo, capacidade_tipo, limite_festas_dia, intervalo_minimo_minutos, configurado_por)
                 VALUES ($1::uuid, 'FIXO', 'POR_SALAO', NULL, 0, $2::uuid)`, [c.empresa, c.usuario]);
  const pequeno = await id(a, `INSERT INTO agenda_saloes (empresa_id, nome, ordem, capacidade_convidados) VALUES ($1::uuid, 'Pequeno', 1, 50) RETURNING id`, [c.empresa]);
  const grande = await id(a, `INSERT INTO agenda_saloes (empresa_id, nome, ordem, capacidade_convidados) VALUES ($1::uuid, 'Grande', 2, 120) RETURNING id`, [c.empresa]);
  return { pequeno, grande, tarde: await horario(c, "TARDE_SC") };
}

/** Festa na tarde (15–19); confirmada numa transação (os gatilhos diferidos conferem a agenda no COMMIT). */
async function festa(c: Cenario, data: string, cfg: string, convidados: number, salao: string | null, confirmar: boolean) {
  await a.query("BEGIN");
  try {
    const f = await id(a, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
          categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status, salao_id)
        SELECT $1::date, '15:00', '19:00', $2::uuid, $3::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', $5, $5, 100, 100, 100,
               'ATENDIMENTO_KIDMAIS', NULL, 'AGUARDANDO_CONTRATO', $6::uuid FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $4::uuid RETURNING fechamentos.id`,
      [data, cfg, c.empresa, c.pacote, convidados, salao]);
    if (confirmar) await a.query(`UPDATE fechamentos SET status = 'CONFIRMADO' WHERE id = $1::uuid`, [f]);
    await a.query("COMMIT");
    return f;
  } catch (error) {
    await a.query("ROLLBACK");
    throw error;
  }
}

const escopo = (c: Cenario) => ({ empresaId: c.empresa, estabelecimentoId: null });
const tardeDe = async (c: Cenario, data: string, convidados?: number) =>
  (await consultarDisponibilidadeData(data, tx, undefined, escopo(c), convidados ? { convidados } : undefined));

test.before(async () => {
  a = await conectarDescartavel();
  tx = { async query<Row extends object>(text: string, values?: readonly unknown[]) { const r = await a.query(text, values as unknown[]); return { rows: r.rows as Row[], rowCount: r.rowCount }; } };
});
test.after(async () => { if (a) await encerrarDescartavel(a); });

test("S-C: disponibilidade com 80 convidados — 2 opções, só 1, sem salão (CAPACIDADE) e ocupado (OCUPADO)", async () => {
  const c = await cenario(a, 0);
  const s = await porSalao(c);
  const [livre, grandeOcupado, ambos] = [dia(50), dia(51), dia(52)];
  const p = (r: Awaited<ReturnType<typeof tardeDe>>) => r.periodos.find((x) => x.configuracaoId === s.tarde)!;

  const vazio40 = await tardeDe(c, livre, 40);
  assert.deepEqual(p(vazio40).horarios[0].capacidade, { opcoes: 2, motivo: "OK" }, "40 cabe nos dois");
  const vazio80 = await tardeDe(c, livre, 80);
  assert.deepEqual(p(vazio80).horarios[0].capacidade, { opcoes: 1, motivo: "OK" }, "80 só no grande");
  assert.deepEqual(vazio80.motivoDia, { opcoes: 1, motivo: "OK" });

  await festa(c, grandeOcupado, s.tarde, 100, s.grande, true);
  const sem = await tardeDe(c, grandeOcupado);
  assert.equal(p(sem).status, "DISPONIVEL", "sem convidados: o pequeno livre basta, como antes");
  assert.equal("capacidade" in p(sem), false);
  assert.equal("motivoDia" in sem, false);
  const cap = await tardeDe(c, grandeOcupado, 80);
  assert.equal(p(cap).status, "INDISPONIVEL");
  assert.deepEqual(p(cap).horarios[0].capacidade, { opcoes: 0, motivo: "CAPACIDADE" });
  assert.deepEqual(cap.motivoDia, { opcoes: 0, motivo: "CAPACIDADE" }, "calendário: sem salão para 80, não ocupado");
  assert.equal(p(await tardeDe(c, grandeOcupado, 40)).status, "DISPONIVEL", "40 cabe no pequeno livre");

  await festa(c, ambos, s.tarde, 30, s.pequeno, true);
  await festa(c, ambos, s.tarde, 100, s.grande, true);
  assert.deepEqual((await tardeDe(c, ambos, 80)).motivoDia, { opcoes: 0, motivo: "OCUPADO" });
  assert.deepEqual((await tardeDe(c, livre, 130)).motivoDia, { opcoes: 0, motivo: "CAPACIDADE" }, "nenhum salão comporta 130");

  // NULL comporta: o salão sem capacidade informada volta a contar.
  await a.query(`UPDATE agenda_saloes SET capacidade_convidados = NULL WHERE id = $1::uuid`, [s.pequeno]);
  assert.deepEqual(p(await tardeDe(c, grandeOcupado, 80)).horarios[0].capacidade, { opcoes: 1, motivo: "OK" });
});

test("S-C: calendário de 62 dias com convidados, e outra empresa fora da conta", async () => {
  const c = await cenario(a, 0);
  const s = await porSalao(c);
  const outra = await cenario(a, 0);
  await porSalao(outra);
  const inicio = dia(60);
  const fim = dia(121);
  const dias = await consultarDisponibilidadePeriodo(inicio, fim, tx, undefined, escopo(c), { convidados: 80 });
  assert.equal(dias.length, 62);
  assert.equal(dias.every((d) => d.motivoDia?.motivo === "OK" && d.motivoDia.opcoes === 1), true, "só o Grande desta empresa (os da outra não somam)");
  await festa(outra, inicio, (await a.query<{ id: string }>(`SELECT id::text FROM configuracao_agenda WHERE empresa_id = $1::uuid`, [outra.empresa])).rows[0].id, 100, null, false);
  const deNovo = await consultarDisponibilidadeData(inicio, tx, undefined, escopo(c), { convidados: 80 });
  assert.deepEqual(deNovo.periodos.find((x) => x.configuracaoId === s.tarde)!.horarios[0].capacidade, { opcoes: 1, motivo: "OK" });
});

test("S-C: revalidação com convidados recusa SEM_SALAO_PARA_CONVIDADOS sem gravar; sem convidados, como antes", async () => {
  const c = await cenario(a, 0);
  const s = await porSalao(c);
  const data = dia(70);
  await festa(c, data, s.tarde, 100, s.grande, true);
  const entrada = { data, configuracaoId: s.tarde, inicio: "15:00", fim: "19:00", ajusteMinutos: 0 };
  const contar = async () => (await a.query<{ n: string }>(
    `SELECT (SELECT count(*) FROM fechamentos)::text || '/' || (SELECT count(*) FROM agenda_saloes)::text AS n`)).rows[0].n;
  const antes = await contar();
  await assert.rejects(revalidarHorarioSelecionado({ ...entrada, convidados: 80 }, tx, escopo(c)),
    (e: { code?: string; httpStatus?: number }) => e.code === "SEM_SALAO_PARA_CONVIDADOS" && e.httpStatus === 409);
  assert.equal(await contar(), antes, "nada gravado");
  assert.ok(await revalidarHorarioSelecionado({ ...entrada, convidados: 40 }, tx, escopo(c)), "40 cabe no pequeno");
  assert.ok(await revalidarHorarioSelecionado(entrada, tx, escopo(c)), "sem convidados: regra de antes");
  await festa(c, data, s.tarde, 30, s.pequeno, true);
  await assert.rejects(revalidarHorarioSelecionado({ ...entrada, convidados: 40 }, tx, escopo(c)),
    (e: { code?: string }) => e.code === "HORARIO_NAO_DISPONIVEL", "tudo ocupado: o código de antes");
});

test("S-C: reserva prefere o salão que comporta; o atual continua vencendo; sem nenhum que comporte, o primeiro livre", async () => {
  const c = await cenario(a, 0);
  const s = await porSalao(c);
  const escolher = async (convidados: number, data: string, atual: string | null = null) => {
    const f = await festa(c, data, s.tarde, convidados, atual, false);
    await a.query("BEGIN");
    try {
      const r = await escolherSalao(tx, f);
      await a.query("ROLLBACK");
      return r.salao;
    } catch (error) {
      await a.query("ROLLBACK");
      throw error;
    }
  };
  assert.equal(await escolher(80, dia(80)), s.grande, "80 vai para o grande, mesmo com o pequeno antes na ordem");
  assert.equal(await escolher(10, dia(81)), s.pequeno, "10 cabe no primeiro da ordem");
  assert.equal(await escolher(80, dia(82), s.pequeno), s.pequeno, "o salão atual continua vencendo (não troca em silêncio)");
  assert.equal(await escolher(200, dia(83)), s.pequeno, "nenhum comporta: o primeiro livre (limite declarado da S-C)");
  const d = dia(84);
  await festa(c, d, s.tarde, 100, s.grande, true);
  assert.equal(await escolher(80, d), s.pequeno, "único livre não comporta: cai nele, como antes (a S-D fecha com a preferência)");
});

/**
 * P3-T1 (Astra): os caminhos PÚBLICOS reais no banco — GET /api/disponibilidade, POST /api/fechamentos/cotacao e
 * POST /api/fechamentos — com os módulos de verdade (revalidação, escopo da contratação, preço, envio). Só o escopo do
 * endereço (/b/<código>, flag e situação comercial, fora da S-C) e o limitador de taxa são dublês. A recusa por
 * capacidade não grava nada (fotografia de festas, clientes, aniversariantes, snapshots e auditorias) e o controle
 * positivo (40 convidados) passa da revalidação pela mesma rota.
 */
test("S-C (P3-T1): rotas públicas reais — motivo sem ids, 409 SEM_SALAO_PARA_CONVIDADOS sem gravar e controle positivo", async () => {
  const c = await cenario(a, 0);
  const s = await porSalao(c);
  // Catálogo cotável de verdade (tabela publicada, escopo comercial, categoria do horário): pacote COMPLETA (id V1
  // "completa"), também no horário da S-C — o controle positivo precisa de preço real, não só passar da revalidação.
  await catalogoNativo(a, c);
  await catalogoNoTurno(a, c, s.tarde);
  const data = dia(90);
  await festa(c, data, s.tarde, 100, s.grande, true);
  const extras = {
    "next/server": { NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }) } },
    "http/limite-publico": { limitarPublico: async () => null },
    "comercial/cotacao-publica": { ...cotacaoPublicaReal, codigoEmpresaDoPedido: () => "buffet-sc",
      escopoCotacaoPublica: async () => ({ empresaId: c.empresa, estabelecimentoId: null, porCodigo: true }) },
    "disponibilidade/escopo": { ...escopoReal, escopoDaEmpresa: async () => ({ estabelecimentoId: null }) },
    // P3-T1 (rodada 3): transação REAL por chamada (BEGIN/COMMIT nesta conexão), não SAVEPOINT — a suíte não abre
    // transação externa, e as validações diferidas da criação rodam no COMMIT, como em produção.
    "db/postgres": { db: () => executor(a), withTransaction: porTransacao(a) },
  };
  type Rota = Record<string, (r: unknown) => Promise<{ status: number; body: Record<string, unknown> }>>;
  const cache = new Map();
  const carregar = (arquivo: string) => carregarComBanco(arquivo, a, () => null, extras, cache) as unknown as Rota;
  const disponibilidade = carregar("app/api/disponibilidade/route.ts");
  const cotacao = carregar("app/api/fechamentos/cotacao/route.ts");
  const envio = carregar("app/api/fechamentos/route.ts");
  const url = (caminho: string) => `http://localhost${caminho}`;
  const get = (caminho: string) => disponibilidade.GET({ url: url(caminho), nextUrl: new URL(url(caminho)) });
  const post = (rota: Rota, caminho: string, corpo: unknown) =>
    rota.POST({ url: url(caminho), nextUrl: new URL(url(caminho)), json: async () => corpo, headers: new Headers() });

  const leitura = await get(`/api/disponibilidade?data=${data}&convidados=80`);
  assert.equal(leitura.status, 200);
  const periodo = (leitura.body.data as { periodos: Array<{ configuracaoId: string; horarios: Array<{ capacidade?: unknown }> }> }).periodos.find((p) => p.configuracaoId === s.tarde)!;
  assert.deepEqual(periodo.horarios[0].capacidade, { opcoes: 0, motivo: "CAPACIDADE" });
  const texto = JSON.stringify(leitura.body);
  for (const segredo of [s.pequeno, s.grande, "Pequeno", "Grande"]) assert.equal(texto.includes(segredo), false, `resposta pública sem ${segredo}`);

  // Sem transação aberta na conexão (o harness abre e fecha a sua por chamada).
  assert.equal((await a.query<{ ativa: boolean }>(`SELECT now() <> statement_timestamp() AS ativa`)).rows[0].ativa, false);
  const tabelas = (await a.query<{ t: string }>(`SELECT t FROM unnest(ARRAY['fechamentos','clientes','aniversariantes','fechamento_pacote_snapshots','auditoria','financeiro_auditoria']) t
    WHERE to_regclass('public.' || t) IS NOT NULL`)).rows.map((r) => r.t);
  // P3-T1 (re-revisão): fotografia pelo CONTEÚDO de cada tabela (hash das linhas), não só a contagem — pega UPDATE.
  tabelas.push("agenda_saloes", "configuracao_agenda_saloes", "pacotes");
  const fotografia = async () => Object.fromEntries(await Promise.all(tabelas.map(async (t) =>
    [t, (await a.query<{ h: string }>(`SELECT count(*)::text || ':' || coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '') AS h FROM ${t} x`)).rows[0].h])));
  const antes = await fotografia();
  const pedido = { pacote: "completa", dataFesta: data, configuracaoId: s.tarde, ajusteHorario: "0", horarioInicio: "15:00", horarioFim: "19:00" };
  const recusa = await post(cotacao, "/api/fechamentos/cotacao", { ...pedido, convidados: 80 });
  assert.equal(recusa.status, 409);
  assert.equal(recusa.body.codigo, "SEM_SALAO_PARA_CONVIDADOS");
  const fechamento = {
    ...pedido, identidadeTipo: "NOVO_CLIENTE", statusDisponibilidade: "disponivel", convidadosPagantes: 80, buffetDefinicao: "depois",
    adicionaisSelecionados: [], valorCombinado: "100,00", formaPagamento: "pix_avista", nomeCliente: "Cliente Sintético SC", cpf: "00000000191",
    email: "cliente-sc@buffet.test", whatsapp: "11988880001", telefone: "1133330001", cep: "70000000", logradouro: "Rua Sintética", numero: "1", bairro: "Centro", cidade: "Brasília", uf: "DF",
    nomeAniversariante: "Aniversariante SC", idadeAniversariante: 6,
  };
  const envioRecusado = await post(envio, "/api/fechamentos", fechamento);
  assert.equal(envioRecusado.status, 409, JSON.stringify(envioRecusado.body));
  assert.equal(envioRecusado.body.codigo, "SEM_SALAO_PARA_CONVIDADOS");
  assert.deepEqual(await fotografia(), antes, "nenhuma escrita nas recusas");

  // Controles positivos EXPLÍCITOS pelas mesmas rotas: 40 cabe no pequeno livre.
  const positivo = await post(cotacao, "/api/fechamentos/cotacao", { ...pedido, convidados: 40 });
  assert.equal(positivo.status, 200, JSON.stringify(positivo.body));
  assert.equal(positivo.body.ok, true);
  assert.equal((positivo.body.data as { valor: unknown }).valor != null, true, "cotação com preço");
  assert.deepEqual(await fotografia(), antes, "a cotação não grava");
  const criado = await post(envio, "/api/fechamentos", { ...fechamento, convidadosPagantes: 40 });
  assert.equal(criado.status, 201, JSON.stringify(criado.body));
  const novas = (await a.query<{ convidados: number; data: string }>(
    `SELECT convidados, data_evento::text AS data FROM fechamentos WHERE empresa_id = $1::uuid AND convidados = 40`, [c.empresa])).rows;
  assert.deepEqual(novas, [{ convidados: 40, data }], "a criação positiva gravou exatamente a festa de 40");
  assert.notDeepEqual(await fotografia(), antes, "controle: a fotografia muda quando há escrita");
});
