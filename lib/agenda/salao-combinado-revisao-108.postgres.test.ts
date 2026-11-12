import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import {
  ambienteAssinatura, assinarComoCliente, carregar, catalogoNativo, cenario, congelarEAssinarKidmais, cpfValido, dia, executor, id,
  poolNaTransacao, validarAgora, type Cenario,
} from "../../scripts/integracao-importados-test-support.ts";
import { lerRegraCapacidadeAgenda, listarFechamentosConfirmadosPorPeriodo } from "../disponibilidade/repositories/disponibilidade.repository.ts";
import { ocupacaoImpedeCandidato } from "../disponibilidade/services/availability.service.ts";
import { criarSalaoCombinado } from "./configuracao-unidade.ts";

/**
 * 108 (salões combinados rebaseados) × S-E (contrato V3 fixa o salão) × 104 (hash v2 da revisão com o salão), no
 * PostgreSQL DESCARTÁVEL modelo 108 (cadeia até a 106 + 107 + 108), contratos NATIVOS pelos serviços reais (emissão →
 * assinatura Kidmais → aceite do cliente) e troca do salão do destino pelo caminho do painel (trocarSalaoDaFesta →
 * definirSalaoDestinoRevisao):
 * - simples A → combinado A+B: hash_versao 2, conteudo_hash = kidmais_hash_revisao_operacional, o hash muda com o salão e
 *   a revisão soma 1; o documento da revisão traz A+B; assinar e aplicar leva a festa a A+B (paridade SQL × Core e D5);
 * - o inverso, combinado A+B → simples C, com as mesmas conferências;
 * - pendência V3 conhecida (vault, "Implementacao 107 108 saloes combinados 20261028"): a assinatura do cliente exige o
 *   salão da BASE (formalizacao.ts, daBase); se ele deixou de servir (aqui: o pacote passou a permitir só o combinado),
 *   a revisão é recusada mesmo com o destino válido. O teste fixa o comportamento ATUAL, não o desejado.
 */
let a: Client;
type Operar = Parameters<typeof congelarEAssinarKidmais>[1];
type Nativo = Awaited<ReturnType<typeof catalogoNativo>>;
const ctxOp = () => ({ requestId: randomUUID(), ip: null, userAgent: "saloes-108-revisao" });
const TURNO = { inicioMinutos: 10 * 60, fimMinutos: 22 * 60 };
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function recusa(promessa: Promise<unknown>, trecho: RegExp) {
  await assert.rejects(promessa, (e: unknown) => {
    assert.match(msg(e), trecho);
    return true;
  });
}
/** Recusa por SQL direto sem deixar efeito (ponto de salvamento na transação do teste). */
async function recusaSql(sql: string, valores: unknown[], trecho: RegExp) {
  await a.query("SAVEPOINT r");
  await recusa(a.query(sql, valores), trecho);
  await a.query("ROLLBACK TO SAVEPOINT r");
}

async function configurar(c: Cenario) {
  await a.query(`INSERT INTO agenda_escopo_config (empresa_id, modo, capacidade_tipo, limite_festas_dia, intervalo_minimo_minutos, configurado_por)
                 VALUES ($1::uuid, 'FIXO', 'POR_SALAO', NULL, 0, $2::uuid)`, [c.empresa, c.usuario]);
}
async function modeloContrato(c: Cenario) {
  const conteudo = {
    titulo: "Contrato Salões 108", contratada: { nome: "Buffet Salões 108 Ltda", documento: "11.222.333/0001-81", endereco: "Rua Teste, 108", representante: "Pessoa Teste" },
    preambulo: [], clausulas: [{ titulo: "Objeto", texto: "Festa em {{festa.data}} para {{contratante.nome}}." }], observacoes: [], cidadeAssinatura: "Cidade Teste",
  };
  await a.query(`INSERT INTO modelos_contrato_empresa (empresa_id, versao, conteudo, conteudo_sha256, aprovado_por) VALUES ($1::uuid, 1, $2::jsonb, $3, $4::uuid)`,
    [c.empresa, JSON.stringify(conteudo), "a".repeat(64), c.usuario]);
}

/** Salões simples A, B (40) e C (60) e o combinado "Salão inteiro" = A+B (200), pelo cadastro do Core (lock do escopo). */
async function saloes(c: Cenario) {
  const s = (nome: string, ordem: number, capacidade: number) =>
    id(a, `INSERT INTO agenda_saloes (empresa_id, nome, ordem, ativo, capacidade_convidados) VALUES ($1::uuid, $2, $3, true, $4) RETURNING id`, [c.empresa, nome, ordem, capacidade]);
  const A = await s("Salão A", 1, 40), B = await s("Salão B", 2, 40), C = await s("Salão C", 3, 60);
  const { id: AB } = await criarSalaoCombinado(executor(a), { empresaId: c.empresa, usuarioId: c.usuario, requestId: randomUUID() },
    { estabelecimentoId: null, nome: "Salão inteiro", capacidadeConvidados: 200, membros: [B, A] });
  return { A, B, C, AB };
}
const pacoteSo = async (c: Cenario, ...permitidos: string[]) => {
  await a.query(`DELETE FROM pacote_saloes WHERE pacote_id = $1::uuid`, [c.pacote]);
  for (const s of permitidos) await a.query(`INSERT INTO pacote_saloes (pacote_id, salao_id) VALUES ($1::uuid, $2::uuid)`, [c.pacote, s]);
};

/** Proposta nativa (10:00–22:00, 30 convidados) e o contrato gerado pela emissão real, já assinado pelo buffet; falta o cliente. */
async function emitida(c: Cenario, nativo: Nativo, data: string, convidados = 30) {
  const cpf = cpfValido();
  const cliente = await id(a, `INSERT INTO clientes (nome_completo, empresa_id, cpf, email, telefone, whatsapp, cep, logradouro, numero, bairro, cidade, uf)
      VALUES ('Cliente 108', $1::uuid, $2, $3, '11999998888', '11999998888', '01001000', 'Rua Sintética', '1', 'Centro', 'São Paulo', 'SP') RETURNING id`, [c.empresa, cpf, `${randomUUID()}@example.invalid`]);
  const aniversariante = await id(a, `INSERT INTO aniversariantes (cliente_id, nome) VALUES ($1::uuid, 'Aniversariante 108') RETURNING id`, [cliente]);
  const festa = await id(a, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
        categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, aniversariante_id, status)
      SELECT $1::date, '10:00', '22:00', $2::uuid, $3::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', $7, $7, 100, 100, 100, 'ATENDIMENTO_KIDMAIS', $5::uuid, $6::uuid, 'AGUARDANDO_CONTRATO'
        FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $4::uuid LIMIT 1 RETURNING fechamentos.id`, [data, nativo.turno, c.empresa, c.pacote, cliente, aniversariante, convidados]);
  const contratos = carregar<typeof import("../contratos/services/contrato.service.ts")>("lib/contratos/services/contrato.service.ts");
  const gerado = await contratos.gerarContrato({ fechamentoId: festa } as never, { usuarioId: c.usuario, origem: "SISTEMA", executor: executor(a) } as never) as { contrato: { id: string }; versao: { id: string } };
  const adm = carregar<typeof import("../contratos/services/administrativo.service.ts")>("lib/contratos/services/administrativo.service.ts");
  await congelarEAssinarKidmais(a, adm.operarContrato as unknown as Operar, gerado.versao.id, c.empresa, c.token, nativo.tokenRepresentante);
  return { festa, contrato: gerado.contrato.id, versao: gerado.versao.id, cpf };
}
type Emitida = Awaited<ReturnType<typeof emitida>>;
const snapshotDe = async (versao: string) => (await a.query<{ s: { schemaVersao: number; evento: { salao?: { id: string; nome: string } | null } } }>(
  `SELECT snapshot s FROM contrato_versoes WHERE id = $1::uuid`, [versao])).rows[0].s;
const festaDe = async (f: string) => (await a.query<{ salao: string | null; ocupa: boolean }>(
  `SELECT salao_id::text salao, kidmais019_ocupa(id) ocupa FROM fechamentos WHERE id = $1::uuid`, [f])).rows[0];
const hashDaFuncao = async (revisao: string) => (await a.query<{ h: string }>(`SELECT kidmais_hash_revisao_operacional($1::uuid) h`, [revisao])).rows[0].h;

/** Nova versão do contrato NATIVO assinado (preparação de revisão operacional) pelos serviços reais. */
async function revisaoNativa(c: Cenario, nativo: Nativo, e: Emitida) {
  const adm = carregar<typeof import("../contratos/services/administrativo.service.ts")>("lib/contratos/services/administrativo.service.ts");
  const operar = adm.operarContrato as unknown as Operar;
  const vigente = (await a.query<{ v: string }>(`SELECT versao_vigente_id::text v FROM contrato_fluxos WHERE contrato_id = $1`, [e.contrato])).rows[0].v;
  await operar(vigente, { acao: "nova_versao", tipo: "NOVA_VERSAO", motivo: "Troca de salão 108", chaveCriacao: randomUUID() }, c.token, ctxOp(), c.empresa);
  const v2 = (await a.query<{ id: string }>(`SELECT versao_em_preparacao_id::text id FROM contrato_fluxos WHERE contrato_id = $1`, [e.contrato])).rows[0].id;
  const edicao = async () => (await a.query<{ revisao: number }>(`SELECT revisao FROM contrato_edicoes WHERE contrato_versao_id = $1`, [v2])).rows[0].revisao;
  const salvar = async () => operar(v2, { acao: "salvar", revisao: await edicao(), observacoesDocumentais: "" }, c.token, ctxOp(), c.empresa);
  const preparacao = async () => (await a.query<{ id: string; estado: string; salao: string | null; versao: number | null; revisao: number; hash: string }>(
    `SELECT id::text, estado, salao_id::text salao, (to_jsonb(r)->>'hash_versao')::int versao, revisao, conteudo_hash hash
       FROM fechamento_revisoes r WHERE contrato_versao_id = $1`, [v2])).rows[0];
  const congelar = async () => congelarEAssinarKidmais(a, operar, v2, c.empresa, c.token, nativo.tokenRepresentante);
  const assinarCliente = async () => {
    await assinarComoCliente(e.contrato, e.cpf);
    await validarAgora(a);
  };
  return { v2, salvar, preparacao, congelar, assinarCliente };
}

/** Troca do salão do DESTINO pelo caminho do painel (o mesmo da tela da festa). */
async function trocar(c: Cenario, festa: string, salao: string) {
  const troca = carregar<typeof import("./troca-salao.ts")>("lib/agenda/troca-salao.ts");
  return troca.trocarSalaoDaFesta(executor(a), { empresaId: c.empresa, usuarioId: c.usuario, requestId: randomUUID() }, festa, salao);
}

/** Paridade SQL × Core (visão do painel, com combinados) para cada candidato no horário da festa. */
async function paridade(c: Cenario, nativo: Nativo, data: string) {
  const tx = executor(a);
  const regra = await lerRegraCapacidadeAgenda(tx, { empresaId: c.empresa, estabelecimentoId: null }, { incluirCombinados: true });
  const ocupacoes = await listarFechamentosConfirmadosPorPeriodo(data, data, tx, { empresaId: c.empresa, estabelecimentoId: null });
  return async (rotulo: string, candidato: string, ocupado: boolean) => {
    const sql = (await a.query<{ x: boolean }>(`SELECT kidmais094_conflito_ocupacao($1::uuid, $2::date, '10:00'::time, '22:00'::time, $3::uuid, NULL, $4::uuid, $5::uuid) x`,
      [randomUUID(), data, c.empresa, nativo.turno, candidato])).rows[0].x;
    assert.equal(sql, ocupado, `SQL ${rotulo}`);
    assert.equal(ocupacaoImpedeCandidato(regra, nativo.turno, TURNO, ocupacoes, [candidato]), sql, `Core × SQL ${rotulo}`);
  };
}

async function comCommit<T>(corpo: () => Promise<T>, fim: "COMMIT" | "ROLLBACK" = "COMMIT") {
  await a.query("BEGIN");
  const restaurarPool = poolNaTransacao(a);
  const restaurarAmbiente = ambienteAssinatura();
  try {
    const r = await corpo();
    await a.query(fim);
    return r;
  } catch (error) {
    await a.query("ROLLBACK");
    throw error;
  } finally {
    restaurarAmbiente();
    restaurarPool();
  }
}
async function empresa() {
  const c = await cenario(a, 0);
  const nativo = await catalogoNativo(a, c);
  await modeloContrato(c);
  await configurar(c);
  return { c, nativo, s: await saloes(c) };
}

test.before(async () => {
  process.env.FESTA_ENABLED = "true";
  a = await conectarDescartavel();
});
test.after(async () => { if (a) await encerrarDescartavel(a); });

test("modelo 108: hash_versao instalado (104) e combinados ativos (108)", async () => {
  const r = (await a.query<{ hv: boolean; comb: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.fechamento_revisoes'::regclass AND attname = 'hash_versao' AND NOT attisdropped) hv,
            EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.agenda_saloes'::regclass AND attname = 'membros' AND NOT attisdropped) comb`)).rows[0];
  assert.deepEqual(r, { hv: true, comb: true });
});

test("revisão V3: destino simples A → combinado A+B pelo painel; hash v2 muda com o salão; assinar e aplicar leva a festa a A+B", { timeout: 300_000 }, async () => {
  const D = dia(120);
  const r = await comCommit(async () => {
    const { c, nativo, s } = await empresa();
    // Emissão: o pacote só permite A → o contrato V3 fixa A; a assinatura grava A.
    await pacoteSo(c, s.A);
    const e = await emitida(c, nativo, D);
    assert.deepEqual((await snapshotDe(e.versao)).evento.salao, { id: s.A, nome: "Salão A" });
    await assinarComoCliente(e.contrato, e.cpf);
    await validarAgora(a);
    assert.deepEqual(await festaDe(e.festa), { salao: s.A, ocupa: true });
    // O pacote passa a permitir também o salão inteiro (A continua servindo como base).
    await pacoteSo(c, s.A, s.AB);
    const rv = await revisaoNativa(c, nativo, e);
    const antes = await rv.preparacao();
    assert.equal(antes.salao, s.A, "o destino nasce no salão atual, que ainda serve");
    assert.equal(antes.versao, 2, "POR_SALAO com a 104: hash v2");
    assert.equal(antes.hash, await hashDaFuncao(antes.id));
    // Troca pelo painel: A (base) → A+B (destino); o próprio A da festa não conflita com o A+B dela.
    const leitura = await trocar(c, e.festa, s.AB);
    assert.equal(leitura?.contratoFixa?.id, s.A, "o contrato vigente continua fixando A");
    assert.equal(leitura?.trocaEmAndamento?.salao?.id, s.AB);
    const opcaoAB = leitura?.opcoes.find((o) => o.id === s.AB);
    assert.deepEqual([opcaoAB?.combinado, opcaoAB?.membros, opcaoAB?.permitido], [true, ["Salão A", "Salão B"], true]);
    const depois = await rv.preparacao();
    assert.equal(depois.salao, s.AB);
    assert.equal(depois.versao, 2);
    assert.equal(depois.hash, await hashDaFuncao(depois.id), "conteudo_hash = função do banco");
    assert.notEqual(depois.hash, antes.hash, "trocar só o salão muda o hash v2");
    assert.equal(depois.revisao, antes.revisao + 1, "a troca soma 1 à revisão");
    assert.equal((await festaDe(e.festa)).salao, s.A, "A continua vigente até a aplicação");
    // Documento recomposto, assinaturas e aplicação atômica.
    await rv.salvar();
    const doc = await snapshotDe(rv.v2);
    assert.equal(doc.schemaVersao, 3);
    assert.deepEqual(doc.evento.salao, { id: s.AB, nome: "Salão inteiro" }, "o documento da revisão fixa o combinado");
    await rv.congelar();
    await rv.assinarCliente();
    assert.equal((await rv.preparacao()).estado, "APLICADA");
    assert.deepEqual(await festaDe(e.festa), { salao: s.AB, ocupa: true }, "a festa terminou no salão inteiro");
    // Paridade SQL × Core (painel com combinados): A, B e A+B ocupados; C livre.
    const conferir = await paridade(c, nativo, D);
    await conferir("A", s.A, true);
    await conferir("B", s.B, true);
    await conferir("A+B", s.AB, true);
    await conferir("C", s.C, false);
    // D5: um membro do combinado ocupado não se desativa.
    await recusaSql(`UPDATE agenda_saloes SET ativo = false WHERE id = $1::uuid`, [s.B], /festa de hoje em diante/);
    return { festa: e.festa, AB: s.AB };
  });
  const b = await conectarDescartavel({ travar: false });
  try {
    assert.equal((await b.query<{ s: string }>(`SELECT salao_id::text s FROM fechamentos WHERE id = $1`, [r.festa])).rows[0].s, r.AB, "COMMIT com os validadores diferidos");
  } finally { await encerrarDescartavel(b, false); }
});

test("revisão V3: o inverso, base no combinado A+B → destino simples C; mesmas conferências do hash v2 e aplicação em C", { timeout: 300_000 }, async () => {
  const D = dia(121);
  const r = await comCommit(async () => {
    const { c, nativo, s } = await empresa();
    // Emissão: o pacote só permite o salão inteiro → o contrato V3 fixa A+B.
    await pacoteSo(c, s.AB);
    const e = await emitida(c, nativo, D);
    assert.deepEqual((await snapshotDe(e.versao)).evento.salao, { id: s.AB, nome: "Salão inteiro" });
    await assinarComoCliente(e.contrato, e.cpf);
    await validarAgora(a);
    assert.deepEqual(await festaDe(e.festa), { salao: s.AB, ocupa: true });
    await pacoteSo(c, s.AB, s.C);
    const rv = await revisaoNativa(c, nativo, e);
    const antes = await rv.preparacao();
    assert.equal(antes.salao, s.AB);
    assert.equal(antes.versao, 2);
    assert.equal(antes.hash, await hashDaFuncao(antes.id));
    const leitura = await trocar(c, e.festa, s.C);
    assert.equal(leitura?.contratoFixa?.id, s.AB);
    assert.equal(leitura?.trocaEmAndamento?.salao?.id, s.C);
    const depois = await rv.preparacao();
    assert.equal(depois.salao, s.C);
    assert.equal(depois.versao, 2);
    assert.equal(depois.hash, await hashDaFuncao(depois.id));
    assert.notEqual(depois.hash, antes.hash, "trocar só o salão muda o hash v2");
    assert.equal(depois.revisao, antes.revisao + 1);
    assert.equal((await festaDe(e.festa)).salao, s.AB, "A+B continua vigente até a aplicação");
    await rv.salvar();
    assert.deepEqual((await snapshotDe(rv.v2)).evento.salao, { id: s.C, nome: "Salão C" });
    await rv.congelar();
    await rv.assinarCliente();
    assert.equal((await rv.preparacao()).estado, "APLICADA");
    assert.deepEqual(await festaDe(e.festa), { salao: s.C, ocupa: true });
    // A+B liberado: A, B e o combinado livres; C ocupado (paridade SQL × Core).
    const conferir = await paridade(c, nativo, D);
    await conferir("A", s.A, false);
    await conferir("B", s.B, false);
    await conferir("A+B", s.AB, false);
    await conferir("C", s.C, true);
    return { festa: e.festa, C: s.C };
  });
  const b = await conectarDescartavel({ travar: false });
  try {
    assert.equal((await b.query<{ s: string }>(`SELECT salao_id::text s FROM fechamentos WHERE id = $1`, [r.festa])).rows[0].s, r.C);
  } finally { await encerrarDescartavel(b, false); }
});

test("pendência V3: o salão da BASE deixou de servir (pacote só com o combinado) → a assinatura do cliente da revisão é recusada", { timeout: 300_000 }, async () => {
  const D = dia(122);
  // Termina em ROLLBACK: o estado intermediário (festa em A com o pacote sem A) só serve para provar a recusa.
  await comCommit(async () => {
    const { c, nativo, s } = await empresa();
    await pacoteSo(c, s.A);
    const e = await emitida(c, nativo, D);
    await assinarComoCliente(e.contrato, e.cpf);
    await validarAgora(a);
    assert.equal((await festaDe(e.festa)).salao, s.A);
    await pacoteSo(c, s.A, s.AB);
    const rv = await revisaoNativa(c, nativo, e);
    await trocar(c, e.festa, s.AB);
    await rv.salvar();
    assert.equal((await snapshotDe(rv.v2)).evento.salao?.id, s.AB);
    await rv.congelar();
    const congelada = await rv.preparacao();
    assert.equal(congelada.estado, "CONGELADA");
    assert.equal(congelada.salao, s.AB);
    // A base (A) deixa de servir: o pacote passa a permitir só o salão inteiro. D5 não deixaria desativar A (festa futura),
    // e a capacidade da base não é reavaliada na assinatura da revisão (capacidade: false), então o caminho viável é o pacote.
    await pacoteSo(c, s.AB);
    // Pendência V3 conhecida (salão base indisponível): comportamento atual = recusa
    // (bloquearAgendaFormalizacao → salaoExigidoOuRecusa daBase → escolherSalaoDoContrato com o exigido A), mesmo com o
    // destino A+B válido. Quando a pendência de produto for decidida, este teste deve mudar junto.
    await recusa(rv.assinarCliente(), /O salão deste contrato não está mais disponível; o buffet vai enviar uma nova versão\./);
    const depois = await rv.preparacao();
    assert.equal(depois.estado, "CONGELADA", "a revisão não foi aplicada");
    assert.equal(depois.salao, s.AB, "o destino não mudou");
    assert.equal(depois.hash, congelada.hash);
    assert.deepEqual(await festaDe(e.festa), { salao: s.A, ocupa: true }, "a festa segue na base, sem salão substituto");
    // Controle positivo: com A permitido de novo, a mesma revisão é assinada e aplicada em A+B.
    await pacoteSo(c, s.A, s.AB);
    await rv.assinarCliente();
    assert.equal((await rv.preparacao()).estado, "APLICADA");
    assert.equal((await festaDe(e.festa)).salao, s.AB);
  }, "ROLLBACK");
});
