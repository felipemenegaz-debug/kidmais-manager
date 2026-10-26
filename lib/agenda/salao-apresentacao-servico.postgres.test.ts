import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import sharp from "sharp";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import type { DbExecutor } from "../db/contracts.ts";
import { cenario, cod, id, type Cenario } from "../../scripts/integracao-importados-test-support.ts";
import { normalizarWebp } from "../imagens/normalizar-webp.ts";
import { lerAgendaEscopo, salvarAgendaEscopo } from "./configuracao-unidade.ts";
import {
  adicionarFoto, apresentacaoInstalada, confirmarDeclaracao, copiarFotoDoSite, lerApresentacao, lerOrigemDoSite, removerFoto, reordenarFotos,
  salvarApresentacao, SalaoApresentacaoError, traduzirErroSalao, type CamposInformados,
} from "./salao-apresentacao.ts";
import { itensDosPacotesDoSalao } from "./salao-pacotes.ts";
import { criarServicosComuns } from "../comercial/servicos-comuns.ts";
import { adicionaisDoPacoteNoTenant } from "../comercial/adicionais-tenant.ts";
import { listarCodigosInclusos } from "../comercial/composicao.ts";

/**
 * Serviços da apresentação do salão (102) e dos serviços comuns (103) no PostgreSQL DESCARTÁVEL (modelo 103: inventário
 * sem a 098, com 099/100/102/103). Plano rev. 4 + ressalvas do parecer 8 (25/10/2026):
 *   * versão esperada (409), itens com identidade imutável, fotos (inclusão com compactação, reordenação completa,
 *     ordem 32000), declaração só com o resto pronto e na versão vista;
 *   * ciclos com a agenda REAL (salvarAgendaEscopo): omissão preserva conteúdo e anula a declaração; reativação do
 *     mesmo id preserva e exige nova declaração; recriação com o mesmo nome é outro id, vazio; capacidade abaixo de
 *     sentados recusada e traduzida; as duas ordens de corrida entre agenda e confirmação;
 *   * cópia do site: mesma empresa e unidade, imagem removida recusada, remoção concorrente espera o FOR SHARE;
 *   * itens dos pacotes do salão (garantidos x opções; elegibilidade; 0/1/N) e serviços comuns (idempotência, corrida,
 *     renomeado/inativo/conflito, sem tabela de preço).
 */
let a: Client;
let tx: DbExecutor;

const executor = (db: Client): DbExecutor => ({
  async query<Row extends object>(text: string, values?: readonly unknown[]) {
    const r = await db.query(text, values as unknown[]);
    return { rows: r.rows as Row[], rowCount: r.rowCount };
  },
});

const ctx = (c: Cenario) => ({ empresaId: c.empresa, usuarioId: c.usuario, requestId: crypto.randomUUID() });
const NEUTRO: CamposInformados = {
  convidadosMinimo: null, convidadosSentados: null, areaM2: null, idadeMin: null, idadeMax: null, frase: null,
  outraFestaSimultanea: null, exclusivos: [], fotosReferencia: null,
};

async function emTransacao<T>(fn: () => Promise<T>, db: Client = a): Promise<T> {
  await db.query("BEGIN");
  try {
    const r = await fn();
    await db.query("COMMIT");
    return r;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  }
}

async function erroCodigo(promessa: Promise<unknown>) {
  try {
    await promessa;
    return "ok";
  } catch (e) {
    return e instanceof SalaoApresentacaoError ? e.code : `${(e as { code?: string }).code ?? (e as Error).message}`;
  }
}

async function salao(c: Cenario, capacidade: number | null = 100, nome = `Salão ${randomBytes(3).toString("hex")}`) {
  return id(a, `INSERT INTO agenda_saloes (empresa_id, nome, capacidade_convidados) VALUES ($1::uuid, $2, $3) RETURNING id`, [c.empresa, nome, capacidade]);
}

let imagemBase: Awaited<ReturnType<typeof normalizarWebp>>;
async function imagem() {
  // Bytes distintos a cada chamada (o hash da foto muda), sempre um WebP real normalizado.
  const cor = { r: randomBytes(1)[0], g: randomBytes(1)[0], b: randomBytes(1)[0] };
  return normalizarWebp(await sharp({ create: { width: 40, height: 30, channels: 3, background: cor } }).png().toBuffer());
}

async function versao(c: Cenario, s: string) {
  return (await lerApresentacao(tx, c.empresa, s)).conteudoVersao;
}

test.before(async () => {
  a = await conectarDescartavel();
  tx = executor(a);
  imagemBase = await imagem();
});
test.after(async () => { if (a) await encerrarDescartavel(a); });

test("instalação completa no modelo 103", async () => {
  assert.equal(await apresentacaoInstalada(tx), "COMPLETA");
});

test("salvar: campos e itens, versão esperada 409, identidade do item, destaques e mês das fotos", async () => {
  const c = await cenario(a, 0);
  const s = await salao(c);
  const v0 = await versao(c, s);
  const r = await emTransacao(() => salvarApresentacao(tx, ctx(c), s, v0, {
    ...NEUTRO, convidadosSentados: 90, convidadosMinimo: 50, areaM2: 260, frase: "  Mais   espaço para correr ", outraFestaSimultanea: true,
    exclusivos: ["ENTRADA", "BRINQUEDOS", "BANHEIROS"], fotosReferencia: "2026-03",
  }, [
    { grupo: "BRINCADEIRAS", codigo: "BRINQUEDAO", detalhe: "3 andares", destaque: true },
    { grupo: "BRINCADEIRAS", proprio: "Tirolesa", destaque: true },
    { grupo: "CONFORTO", codigo: "AR_TODOS_AMBIENTES", destaque: true },
  ]));
  assert.equal(r.campos.frase, "Mais espaço para correr");
  assert.equal(r.campos.fotosReferencia, "2026-03");
  assert.deepEqual(r.idadeSugerida, { min: 4, max: 12 });
  assert.match(r.fraseConvivencia ?? "", /outro salão pode receber outra festa/);
  assert.equal(r.itens.length, 3);
  // Versão desatualizada: 409, nada gravado.
  assert.equal(await erroCodigo(emTransacao(() => salvarApresentacao(tx, ctx(c), s, v0, NEUTRO, []))), "SALAO_MUDOU");
  // Trocar o código de um item existente é recusado; remover e criar funciona.
  const brinquedao = r.itens.find((i) => i.codigo === "BRINQUEDAO")!;
  assert.equal(await erroCodigo(emTransacao(() => salvarApresentacao(tx, ctx(c), s, r.conteudoVersao, r.campos as CamposInformados,
    [{ id: brinquedao.id, grupo: "BRINCADEIRAS", codigo: "CAMA_ELASTICA", destaque: true }]))), "DADOS_INVALIDOS");
  // Troca de destaque dentro do teto no mesmo lote (tira um e põe outro): a ordem das operações não estoura o limite.
  const atual = await lerApresentacao(tx, c.empresa, s);
  const itens = atual.itens.map((i) => ({ id: i.id, grupo: i.grupo, codigo: i.codigo, proprio: i.proprio, detalhe: i.detalhe, destaque: i.codigo !== "BRINQUEDAO" }));
  const r2 = await emTransacao(() => salvarApresentacao(tx, ctx(c), s, atual.conteudoVersao, atual.campos as CamposInformados, [
    ...itens, { grupo: "ESPACO", codigo: "PISO_UNICO", destaque: true },
  ]));
  assert.equal(r2.itens.filter((i) => i.destaque).length, 3 + 0);
  // Mês futuro recusado; mais de 4 destaques recusado antes do banco.
  assert.equal(await erroCodigo(emTransacao(() => salvarApresentacao(tx, ctx(c), s, r2.conteudoVersao, { ...(r2.campos as CamposInformados), fotosReferencia: "2999-01" }, []))), "DADOS_INVALIDOS");
  assert.equal(await erroCodigo(emTransacao(() => salvarApresentacao(tx, ctx(c), s, r2.conteudoVersao, r2.campos as CamposInformados,
    ["BRINQUEDAO", "CAMA_ELASTICA", "PISCINA_BOLINHAS", "ESCORREGADOR", "CAMPINHO"].map((codigo) => ({ grupo: "BRINCADEIRAS" as const, codigo, destaque: true }))))), "DADOS_INVALIDOS");
  // Sentados acima da capacidade: CHECK traduzido.
  assert.equal(await erroCodigo(emTransacao(() => salvarApresentacao(tx, ctx(c), s, r2.conteudoVersao, { ...(r2.campos as CamposInformados), convidadosSentados: 101 }, []))), "DADOS_INVALIDOS");
  // Salão de outra empresa: 404 igual.
  const outra = await cenario(a, 0);
  assert.equal(await erroCodigo(emTransacao(() => salvarApresentacao(tx, ctx(outra), s, r2.conteudoVersao, NEUTRO, []))), "SALAO_NAO_ENCONTRADO");
});

test("fotos: inclusão compacta quando n+1 está ocupado, ordem 32000, reordenação completa e lista divergente 409", async () => {
  const c = await cenario(a, 0);
  const s = await salao(c);
  let r = await emTransacao(async () => adicionarFoto(tx, ctx(c), s, await versao(c, s), await imagem(), "Salão montado"));
  r = await emTransacao(async () => adicionarFoto(tx, ctx(c), s, r.conteudoVersao, await imagem(), "Brinquedão"));
  // Uma foto na ordem 32000 (SQL direto) e outra em 2: a próxima inclusão compacta antes.
  const { conteudo, sha256 } = await imagem();
  await a.query(`INSERT INTO agenda_salao_fotos (empresa_id, salao_id, conteudo, mime, bytes, largura, altura, sha256, legenda, ordem, origem, criado_por)
                 VALUES ($1::uuid, $2::uuid, $3, 'image/webp', $4, 40, 30, $5, 'Entrada', 32000, 'UPLOAD', $6::uuid)`, [c.empresa, s, conteudo, conteudo.length, sha256, c.usuario]);
  await a.query(`UPDATE agenda_salao_fotos SET ordem = 4 WHERE salao_id = $1::uuid AND legenda = 'Brinquedão'`, [s]);
  r = await lerApresentacao(tx, c.empresa, s);
  assert.deepEqual(r.fotos.map((f) => f.ordem), [1, 4, 32000]); // n+1 = 4 ocupado: a inclusão compacta antes
  r = await emTransacao(async () => adicionarFoto(tx, ctx(c), s, r.conteudoVersao, await imagem(), "Fraldário"));
  assert.deepEqual(r.fotos.map((f) => [f.legenda, f.ordem]), [["Salão montado", 1], ["Brinquedão", 2], ["Entrada", 3], ["Fraldário", 4]]);
  // Reordenação completa (inclusive com uma foto que estava em 32000) e lista incompleta/repetida/alheia.
  const ids = r.fotos.map((f) => f.id);
  r = await emTransacao(() => reordenarFotos(tx, ctx(c), s, r.conteudoVersao, [ids[3], ids[0], ids[2], ids[1]]));
  assert.deepEqual(r.fotos.map((f) => f.legenda), ["Fraldário", "Salão montado", "Entrada", "Brinquedão"]);
  for (const lista of [ids.slice(0, 3), [ids[0], ids[0], ids[1], ids[2]], [...ids.slice(0, 3), crypto.randomUUID()]]) {
    assert.equal(await erroCodigo(emTransacao(() => reordenarFotos(tx, ctx(c), s, r.conteudoVersao, lista))), "SALAO_MUDOU");
  }
  // Remoção deixa buraco; a versão final vem da leitura (pode subir mais de 1 num lote).
  const v = r.conteudoVersao;
  r = await emTransacao(() => removerFoto(tx, ctx(c), s, v, r.fotos[0].id));
  assert.equal(r.fotos.length, 3);
  assert.ok(r.conteudoVersao > v);
});

test("declaração: recusada com pendências e com versão vista desatualizada; confirmada com tudo pronto", async () => {
  const c = await cenario(a, 0);
  const s = await salao(c, 120);
  let r = await lerApresentacao(tx, c.empresa, s);
  assert.equal(await erroCodigo(emTransacao(() => confirmarDeclaracao(tx, ctx(c), s, r.conteudoVersao))), "SALAO_INCOMPLETO");
  for (let i = 0; i < 6; i++) r = await emTransacao(async () => adicionarFoto(tx, ctx(c), s, r.conteudoVersao, await imagem(), `Ambiente ${i + 1}`));
  r = await emTransacao(() => salvarApresentacao(tx, ctx(c), s, r.conteudoVersao, { ...NEUTRO, fotosReferencia: "2026-03", outraFestaSimultanea: false }, []));
  assert.deepEqual(r.publicavel.pendencias.map((p) => p.codigo), ["SEM_DECLARACAO"]);
  assert.equal(await erroCodigo(emTransacao(() => confirmarDeclaracao(tx, ctx(c), s, r.conteudoVersao - 1))), "SALAO_MUDOU");
  r = await emTransacao(() => confirmarDeclaracao(tx, ctx(c), s, r.conteudoVersao));
  assert.equal(r.publicavel.ok, true);
  assert.notEqual(r.declaracao, null);
});

const horarioDaEmpresa = new Map<string, string>();
/**
 * Agenda REAL (salvarAgendaEscopo): o mesmo horário é reenviado com o id, como a tela faz. Desde a #239 o save exige a
 * versão vista (versaoAgenda): sem concorrência aqui, lida na mesma transação logo antes.
 */
async function agenda(c: Cenario, saloes: { id?: string; nome: string; capacidadeConvidados: number | null }[]) {
  const versaoEsperada = (await lerAgendaEscopo(tx, c.empresa, null)).versaoAgenda;
  const r = await salvarAgendaEscopo(tx, {
    versaoEsperada, estabelecimentoId: null, modo: "FIXO", capacidadeTipo: "POR_HORARIO", limiteFestasDia: null, intervaloMinimoMinutos: 0, saloes,
    horarios: [{ id: horarioDaEmpresa.get(c.empresa), nome: "Tarde", inicio: "14:00", fim: "18:00", dias: [1, 2, 3, 4, 5, 6, 7], capacidade: 1, saloes: [] }],
  }, ctx(c), "CONFIGURACOES");
  const proprio = r.horarios.find((h) => !h.herdado && h.nome === "Tarde");
  if (proprio) horarioDaEmpresa.set(c.empresa, proprio.id);
  return r;
}

test("agenda real × apresentação: omissão, reativação do mesmo id, recriação com o mesmo nome e capacidade abaixo de sentados", async () => {
  const c = await cenario(a, 0);
  const inicial = await emTransacao(() => agenda(c, [{ nome: "Salão Aventura", capacidadeConvidados: 120 }]));
  const s = inicial.saloes[0].id;
  let r = await lerApresentacao(tx, c.empresa, s);
  for (let i = 0; i < 6; i++) r = await emTransacao(async () => adicionarFoto(tx, ctx(c), s, r.conteudoVersao, await imagem(), `Ambiente ${i + 1}`));
  r = await emTransacao(() => salvarApresentacao(tx, ctx(c), s, r.conteudoVersao, { ...NEUTRO, convidadosSentados: 90, fotosReferencia: "2026-03", outraFestaSimultanea: false },
    [{ grupo: "CONFORTO", codigo: "WIFI", destaque: false }]));
  r = await emTransacao(() => confirmarDeclaracao(tx, ctx(c), s, r.conteudoVersao));
  assert.equal(r.publicavel.ok, true);
  // Capacidade abaixo de sentados pela agenda: recusada inteira e traduzida (sem perda silenciosa).
  const erro = await emTransacao(() => agenda(c, [{ id: s, nome: "Salão Aventura", capacidadeConvidados: 80 }])).catch((e) => traduzirErroSalao(e));
  assert.ok(erro instanceof SalaoApresentacaoError && /sentados/.test(erro.message));
  assert.equal((await lerApresentacao(tx, c.empresa, s)).salao.capacidadeConvidados, 120);
  // Mudança de capacidade pela agenda anula a declaração (o salão sai do ar até nova confirmação).
  await emTransacao(() => agenda(c, [{ id: s, nome: "Salão Aventura", capacidadeConvidados: 110 }]));
  assert.deepEqual((await lerApresentacao(tx, c.empresa, s)).publicavel.pendencias.map((p) => p.codigo), ["SEM_DECLARACAO"]);
  r = await lerApresentacao(tx, c.empresa, s);
  r = await emTransacao(() => confirmarDeclaracao(tx, ctx(c), s, r.conteudoVersao));
  // Aba ANTIGA da agenda (parecer do Astra 26/10, P3-1): outra gravação mudou a agenda depois da leitura; a omissão
  // enviada com a versão velha é recusada pela #239 (AGENDA_MUDOU) e o salão continua ativo, com a declaração.
  const velha = (await lerAgendaEscopo(tx, c.empresa, null)).versaoAgenda;
  await a.query(`UPDATE agenda_escopo_config SET intervalo_minimo_minutos = 30 WHERE empresa_id = $1::uuid`, [c.empresa]);
  assert.equal(await erroCodigo(emTransacao(() => salvarAgendaEscopo(tx, {
    versaoEsperada: velha, estabelecimentoId: null, modo: "FIXO", capacidadeTipo: "POR_HORARIO", limiteFestasDia: null, intervaloMinimoMinutos: 0, saloes: [],
    horarios: [{ id: horarioDaEmpresa.get(c.empresa), nome: "Tarde", inicio: "14:00", fim: "18:00", dias: [1, 2, 3, 4, 5, 6, 7], capacidade: 1, saloes: [] }],
  }, ctx(c), "CONFIGURACOES"))), "AGENDA_MUDOU");
  r = await lerApresentacao(tx, c.empresa, s);
  assert.deepEqual([r.salao.ativo, r.declaracao !== null], [true, true], "aba antiga não desativou nem anulou nada");
  await a.query(`UPDATE agenda_escopo_config SET intervalo_minimo_minutos = 0 WHERE empresa_id = $1::uuid`, [c.empresa]);
  // Omissão numa gravação ATUAL da agenda (versão lida agora): o salão é desativado, o conteúdo fica no id e a declaração cai.
  await emTransacao(() => agenda(c, []));
  r = await lerApresentacao(tx, c.empresa, s);
  assert.equal(r.salao.ativo, false);
  assert.equal(r.fotos.length, 6);
  assert.equal(r.itens.length, 1);
  assert.equal(r.declaracao, null);
  // Recriar com o mesmo nome pela agenda: OUTRO id, sem conteúdo nem declaração.
  const recriado = await emTransacao(() => agenda(c, [{ nome: "Salão Aventura", capacidadeConvidados: 110 }]));
  const novo = recriado.saloes.find((x) => x.nome === "Salão Aventura")!.id;
  assert.notEqual(novo, s);
  const n = await lerApresentacao(tx, c.empresa, novo);
  assert.deepEqual([n.fotos.length, n.itens.length, n.declaracao], [0, 0, null]);
  // Reativar o mesmo id (SQL; a tela da agenda não oferece): conteúdo preservado, nova declaração exigida.
  await emTransacao(() => agenda(c, [])); // tira o recriado
  await a.query(`UPDATE agenda_saloes SET ativo = true WHERE id = $1::uuid`, [s]);
  r = await lerApresentacao(tx, c.empresa, s);
  assert.deepEqual([r.salao.ativo, r.fotos.length, r.itens.length], [true, 6, 1]);
  assert.deepEqual(r.publicavel.pendencias.map((p) => p.codigo), ["SEM_DECLARACAO"]);
});

test("agenda × confirmação EM SEQUÊNCIA, nas duas ordens (a concorrência real está no teste seguinte)", async () => {
  const c = await cenario(a, 0);
  const inicial = await emTransacao(() => agenda(c, [{ nome: "Salão Encantado", capacidadeConvidados: 60 }]));
  const s = inicial.saloes[0].id;
  let r = await lerApresentacao(tx, c.empresa, s);
  for (let i = 0; i < 6; i++) r = await emTransacao(async () => adicionarFoto(tx, ctx(c), s, r.conteudoVersao, await imagem(), `Ambiente ${i + 1}`));
  r = await emTransacao(() => salvarApresentacao(tx, ctx(c), s, r.conteudoVersao, { ...NEUTRO, fotosReferencia: "2026-03", outraFestaSimultanea: true }, []));
  const vista = r.conteudoVersao;
  // Agenda primeiro → confirmação da prévia antiga recebe 409.
  await emTransacao(() => agenda(c, [{ id: s, nome: "Salão Encantado", capacidadeConvidados: 70 }]));
  assert.equal(await erroCodigo(emTransacao(() => confirmarDeclaracao(tx, ctx(c), s, vista))), "SALAO_MUDOU");
  // Confirmação primeiro → mudança posterior da agenda limpa a declaração.
  r = await lerApresentacao(tx, c.empresa, s);
  await emTransacao(() => confirmarDeclaracao(tx, ctx(c), s, r.conteudoVersao));
  await emTransacao(() => agenda(c, [{ id: s, nome: "Salão Encantado II", capacidadeConvidados: 70 }]));
  assert.equal((await lerApresentacao(tx, c.empresa, s)).declaracao, null);
});

/** Espera observada no servidor por uma TERCEIRA conexão: PID bloqueador correto e o evento esperado. */
async function esperaObservada(obs: Client, esperando: number, segurando: number, eventos: string[], limiteMs = 6000) {
  let ultimo: unknown = null;
  for (const fim = Date.now() + limiteMs; Date.now() < fim;) {
    const r = await obs.query<{ bloqueado: boolean; tipo: string | null; evento: string | null }>(
      `SELECT $2::int = ANY (pg_blocking_pids($1::int)) AS bloqueado, wait_event_type AS tipo, wait_event AS evento FROM pg_stat_activity WHERE pid = $1::int`,
      [esperando, segurando]);
    ultimo = r.rows[0];
    if (r.rows[0]?.bloqueado && r.rows[0].tipo === "Lock" && eventos.includes(String(r.rows[0].evento))) return r.rows[0].evento;
    await new Promise((fim2) => setTimeout(fim2, 20));
  }
  throw new Error(`espera não observada (${eventos.join("/")}) de ${esperando} por ${segurando}: ${JSON.stringify(ultimo)}`);
}

test("concorrência REAL agenda × confirmação (duas conexões, espera observada no advisory), nas duas ordens", async () => {
  const c = await cenario(a, 0);
  const inicial = await emTransacao(() => agenda(c, [{ nome: "Salão Concorrido", capacidadeConvidados: 60 }]));
  const s = inicial.saloes[0].id;
  let r = await lerApresentacao(tx, c.empresa, s);
  for (let i = 0; i < 6; i++) r = await emTransacao(async () => adicionarFoto(tx, ctx(c), s, r.conteudoVersao, await imagem(), `Ambiente ${i + 1}`));
  r = await emTransacao(() => salvarApresentacao(tx, ctx(c), s, r.conteudoVersao, { ...NEUTRO, fotosReferencia: "2026-03", outraFestaSimultanea: true }, []));
  const b = await conectarDescartavel({ travar: false });
  const obs = await conectarDescartavel({ travar: false });
  const pid = async (cl: Client) => (await cl.query<{ p: number }>("SELECT pg_backend_pid() AS p")).rows[0]!.p;
  const [pa, pb] = [await pid(a), await pid(b)];
  const entrada = (versaoEsperada: string, nome: string, capacidade: number) => ({
    versaoEsperada, estabelecimentoId: null, modo: "FIXO" as const, capacidadeTipo: "POR_HORARIO" as const, limiteFestasDia: null, intervaloMinimoMinutos: 0,
    saloes: [{ id: s, nome, capacidadeConvidados: capacidade }],
    horarios: [{ id: horarioDaEmpresa.get(c.empresa), nome: "Tarde", inicio: "14:00", fim: "18:00", dias: [1, 2, 3, 4, 5, 6, 7], capacidade: 1, saloes: [] }],
  });
  try {
    // 1) AGENDA primeiro: segura o advisory (pausada depois da comparação, no corte); a confirmação da prévia espera no
    //    advisory e, depois do COMMIT da agenda, recebe SALAO_MUDOU (a versão subiu pelo gatilho do pai).
    const vista = r.conteudoVersao;
    let liberar!: () => void;
    let pausou!: () => void;
    const solto = new Promise<void>((fim) => { liberar = fim; });
    const pausado = new Promise<void>((fim) => { pausou = fim; });
    const versaoAgenda1 = (await lerAgendaEscopo(tx, c.empresa, null)).versaoAgenda;
    await a.query("BEGIN");
    const salvando = salvarAgendaEscopo(tx, entrada(versaoAgenda1, "Salão Concorrido", 70), ctx(c), "CONFIGURACOES", {
      lerCorte: async (t2: DbExecutor) => { pausou(); await solto; return (await t2.query<{ d: string }>("SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d")).rows[0]!.d; },
    });
    await pausado;
    await b.query("BEGIN");
    const confirmando = erroCodigo(confirmarDeclaracao(executor(b), ctx(c), s, vista));
    assert.equal(await esperaObservada(obs, pb, pa, ["advisory"]), "advisory");
    liberar();
    await salvando;
    await a.query("COMMIT");
    assert.equal(await confirmando, "SALAO_MUDOU");
    await b.query("ROLLBACK");
    // 2) CONFIRMAÇÃO primeiro: segura o advisory e o salão (sem COMMIT); a agenda espera no advisory; depois do COMMIT da
    //    confirmação, a agenda grava e o gatilho anula a declaração recém-confirmada.
    r = await lerApresentacao(tx, c.empresa, s);
    await b.query("BEGIN");
    await confirmarDeclaracao(executor(b), ctx(c), s, r.conteudoVersao);
    const versaoAgenda2 = (await lerAgendaEscopo(executor(obs), c.empresa, null)).versaoAgenda;
    await a.query("BEGIN");
    const salvando2 = salvarAgendaEscopo(tx, entrada(versaoAgenda2, "Salão Concorrido II", 70), ctx(c), "CONFIGURACOES").then(() => "ok", (e: unknown) => e);
    assert.equal(await esperaObservada(obs, pa, pb, ["advisory"]), "advisory");
    await b.query("COMMIT");
    assert.equal(await salvando2, "ok");
    await a.query("COMMIT");
    const depois = await lerApresentacao(tx, c.empresa, s);
    assert.deepEqual([depois.salao.nome, depois.declaracao], ["Salão Concorrido II", null]);
  } finally {
    await a.query("ROLLBACK").catch(() => undefined);
    await encerrarDescartavel(b, false);
    await encerrarDescartavel(obs, false);
  }
});

async function siteComImagem(c: Cenario, unidade: string | null) {
  const site = await id(a, `INSERT INTO marketing_sites (empresa_id, estabelecimento_id, slug, rascunho, criado_por, atualizado_por)
                            VALUES ($1::uuid, $2::uuid, $3, '{}'::jsonb, $4::uuid, $4::uuid) RETURNING id`, [c.empresa, unidade, `s-${cod()}`, c.usuario]);
  const img = await imagem();
  const imagemId = await id(a, `INSERT INTO marketing_site_imagens (empresa_id, site_id, conteudo, mime, bytes, largura, altura, sha256, descricao, criado_por)
                                VALUES ($1::uuid, $2::uuid, $3, 'image/webp', $4, $5, $6, $7, 'Salão', $8::uuid) RETURNING id`,
    [c.empresa, site, img.conteudo, img.conteudo.length, img.largura, img.altura, img.sha256, c.usuario]);
  return { site, imagemId };
}

test("cópia do site: mesma empresa e unidade; removida recusada; remoção concorrente espera o FOR SHARE da cópia", async () => {
  const c = await cenario(a, 1);
  const s = await id(a, `INSERT INTO agenda_saloes (empresa_id, estabelecimento_id, nome, capacidade_convidados) VALUES ($1::uuid, $2::uuid, 'Salão da unidade', 80) RETURNING id`, [c.empresa, c.unidade]);
  const daUnidade = await siteComImagem(c, c.unidade);
  const semUnidade = await siteComImagem(c, null);
  const outra = await cenario(a, 0);
  const alheia = await siteComImagem(outra, null);
  // Site sem unidade não vale para salão com unidade; outra empresa nunca.
  assert.equal(await erroCodigo(lerOrigemDoSite(tx, c.empresa, s, semUnidade.imagemId)), "IMAGEM_NAO_ENCONTRADA");
  assert.equal(await erroCodigo(lerOrigemDoSite(tx, c.empresa, s, alheia.imagemId)), "IMAGEM_NAO_ENCONTRADA");
  const origem = await lerOrigemDoSite(tx, c.empresa, s, daUnidade.imagemId);
  const normalizada = await normalizarWebp(origem.conteudo);
  // Remoção concorrente: a cópia segura a origem FOR SHARE; o UPDATE de remoção espera o commit.
  const b = await conectarDescartavel({ travar: false });
  try {
    const pidA = (await a.query<{ p: number }>("SELECT pg_backend_pid() AS p")).rows[0].p;
    const pidB = (await b.query<{ p: number }>("SELECT pg_backend_pid() AS p")).rows[0].p;
    await a.query("BEGIN");
    const r = await copiarFotoDoSite(tx, ctx(c), s, (await lerApresentacao(tx, c.empresa, s)).conteudoVersao, daUnidade.imagemId, origem.sha256, normalizada, "Salão montado");
    const remocao = b.query(`UPDATE marketing_site_imagens SET removida_em = clock_timestamp() WHERE id = $1::uuid`, [daUnidade.imagemId]);
    for (let i = 0; i < 200; i++) {
      const w = await a.query<{ ok: boolean }>(`SELECT $1::int = ANY (pg_blocking_pids($2::int)) AS ok`, [pidA, pidB]);
      if (w.rows[0]?.ok) break;
      if (i === 199) assert.fail("a remoção não esperou a cópia");
      await new Promise((fim) => setTimeout(fim, 25));
    }
    await a.query("COMMIT");
    await remocao;
    assert.equal(r.fotos.length, 1);
    assert.equal((await a.query<{ origem: string; origem_sha256: string }>(`SELECT origem, origem_sha256 FROM agenda_salao_fotos WHERE salao_id = $1::uuid`, [s])).rows[0].origem_sha256, origem.sha256);
  } finally {
    await b.end();
  }
  // Depois da remoção, a mesma origem é recusada (fase 1 e fase 2).
  assert.equal(await erroCodigo(lerOrigemDoSite(tx, c.empresa, s, daUnidade.imagemId)), "IMAGEM_NAO_ENCONTRADA");
  assert.equal(await erroCodigo(emTransacao(async () => copiarFotoDoSite(tx, ctx(c), s, (await lerApresentacao(tx, c.empresa, s)).conteudoVersao,
    daUnidade.imagemId, origem.sha256, normalizada, "De novo"))), "IMAGEM_NAO_ENCONTRADA");
});

test("normalização: origem grande (4000 px) é reduzida com sucesso; bytes inválidos recusados", async () => {
  const grande = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: { r: 10, g: 120, b: 200 } } }).jpeg().toBuffer();
  const n = await normalizarWebp(grande);
  assert.ok(n.largura <= 1600 && n.altura <= 1600 && n.conteudo.length <= 1_500_000);
  assert.equal(n.sha256, createHash("sha256").update(n.conteudo).digest("hex"));
  await assert.rejects(normalizarWebp(randomBytes(500)));
  assert.ok(imagemBase.conteudo.length > 0);
});

async function pacote(c: Cenario, nome: string, extra: { ativo?: boolean; vigente?: boolean; arquivado?: boolean } = {}) {
  return id(a, `INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente, arquivado_em) VALUES ($1::uuid, $2, $3, 1, $4, $5, $6) RETURNING id`,
    [c.empresa, cod().toUpperCase(), nome, extra.ativo ?? true, extra.vigente ?? true, extra.arquivado ? new Date().toISOString() : null]);
}

test("itens dos pacotes do salão: 0/1/N, elegibilidade, INCLUSO x EXTRA e opções separadas", async () => {
  const c = await cenario(a, 0);
  const s = await salao(c);
  assert.deepEqual((await itensDosPacotesDoSalao(tx, c.empresa, s)).pacotes, 0);
  const servicos = await emTransacao(() => criarServicosComuns(tx, ctx(c)));
  const monitores = servicos.find((x) => x.codigo === "SERVICO_MONITORES")!.adicionalId!;
  const animacao = servicos.find((x) => x.codigo === "SERVICO_ANIMACAO")!.adicionalId!;
  const p1 = await pacote(c, "Festa Completa");
  const p2 = await pacote(c, "Festa Essencial");
  const inativo = await pacote(c, "Inativo", { ativo: false });
  const antigo = await pacote(c, "Antigo", { vigente: false });
  const semVinculo = await pacote(c, "Sem vínculo");
  for (const p of [p1, p2, inativo, antigo]) await a.query(`INSERT INTO pacote_saloes (pacote_id, salao_id) VALUES ($1::uuid, $2::uuid)`, [p, s]);
  const vincular = (p: string, adicional: string, modalidade: string) =>
    a.query(`INSERT INTO pacote_adicionais (pacote_id, adicional_id, modalidade) VALUES ($1::uuid, $2::uuid, $3)`, [p, adicional, modalidade]);
  await vincular(p1, monitores, "INCLUSO");
  await vincular(p2, monitores, "INCLUSO");
  await vincular(p1, animacao, "INCLUSO");
  await vincular(p2, animacao, "EXTRA");
  await vincular(inativo, animacao, "INCLUSO");
  await vincular(semVinculo, animacao, "INCLUSO");
  const r = await itensDosPacotesDoSalao(tx, c.empresa, s);
  assert.equal(r.pacotes, 2);
  assert.deepEqual(r.emTodos.map((g) => g.nome), ["Monitores de recreação"]);
  assert.deepEqual(r.garantidos.map((g) => [g.nome, g.pacotes]), [["Monitores de recreação", 2], ["Animação e personagem", 1]]);
  assert.ok(r.garantidos.every((g) => g.chave.startsWith("ADICIONAL:")));
  // Outra empresa não enxerga nada deste salão.
  const outra = await cenario(a, 0);
  assert.equal((await itensDosPacotesDoSalao(tx, outra.empresa, s)).pacotes, 0);
});

test("INCLUSO sem preço (parecer do Astra 26/10, P3-1): entra na composição e fica fora da oferta paga; EXTRA sem preço não é oferecido; com preço, é; isolamento", async () => {
  const c = await cenario(a, 0);
  const servicos = await emTransacao(() => criarServicosComuns(tx, ctx(c)));
  const idDe = (codigo: string) => servicos.find((x) => x.codigo === codigo)!.adicionalId!;
  const pacoteCodigo = (await a.query<{ codigo: string }>(`SELECT codigo FROM pacotes WHERE id = $1::uuid`, [c.pacote])).rows[0]!.codigo;
  const vincular = (adicional: string, modalidade: string) =>
    a.query(`INSERT INTO pacote_adicionais (pacote_id, adicional_id, modalidade) VALUES ($1::uuid, $2::uuid, $3)`, [c.pacote, adicional, modalidade]);
  await vincular(idDe("SERVICO_MONITORES"), "INCLUSO");
  await vincular(idDe("SERVICO_ANIMACAO"), "EXTRA");
  await vincular(idDe("SERVICO_GERENTE"), "EXTRA");
  // Tabela da empresa (do cenário, inativa como a 035 exige para publicar) publicada com preço SÓ para o gerente; os serviços não ganharam preço na criação.
  const tabela = (await a.query<{ id: string }>(`SELECT tabela_preco_id::text AS id FROM precos_pacote WHERE pacote_id = $1::uuid LIMIT 1`, [c.pacote])).rows[0]!.id;
  await a.query(`INSERT INTO precos_adicional (tabela_preco_id, adicional_id, convidados_min, convidados_max, valor) VALUES ($1::uuid, $2::uuid, 1, NULL, 300)`, [tabela, idDe("SERVICO_GERENTE")]);
  // Publicação exige o escopo declarado (047): o pacote do cenário, PADRAO, na faixa do preço do cenário (1 a sem limite).
  const escopo = (await a.query<{ id: string }>(`INSERT INTO tabela_preco_escopos (tabela_preco_id, pacote_id, categoria_horario, cobertura_continua) VALUES ($1::uuid, $2::uuid, 'PADRAO', false) RETURNING id::text AS id`, [tabela, c.pacote])).rows[0]!.id;
  await a.query(`INSERT INTO tabela_preco_escopo_faixas (escopo_id, convidados_min, convidados_max) VALUES ($1::uuid, 1, NULL)`, [escopo]);
  await a.query(`UPDATE tabelas_preco SET publicada_em = clock_timestamp() WHERE id = $1::uuid`, [tabela]);
  assert.equal((await a.query(`SELECT 1 FROM precos_adicional WHERE adicional_id = ANY($1::uuid[])`, [[idDe("SERVICO_MONITORES"), idDe("SERVICO_ANIMACAO")]])).rowCount, 0, "sem preço");
  // Composição (a mesma regra INCLUSO + ativo da fotografia do pacote, sem preço): o incluso entra.
  assert.deepEqual(await listarCodigosInclusos(tx, c.pacote, c.empresa), ["SERVICO_MONITORES"]);
  // Oferta paga: o incluso não aparece; o EXTRA sem preço não é oferecido; o EXTRA com preço é.
  const data = (await a.query<{ d: string }>(`SELECT to_char(CURRENT_DATE + 20, 'YYYY-MM-DD') AS d`)).rows[0]!.d;
  const oferta = (await adicionaisDoPacoteNoTenant(tx, { empresaId: c.empresa, pacoteCodigo, data, convidados: 50 })).map((o) => o.codigo);
  assert.ok(oferta.includes("SERVICO_GERENTE"), oferta.join(","));
  assert.ok(!oferta.includes("SERVICO_MONITORES") && !oferta.includes("SERVICO_ANIMACAO"), oferta.join(","));
  // Isolamento: outra empresa não vê a composição deste pacote.
  const outra = await cenario(a, 0);
  assert.deepEqual(await listarCodigosInclusos(tx, c.pacote, outra.empresa), []);
});

test("serviços comuns: idempotente, só na empresa, renomeado preservado, inativo não reativado, conflito de categoria", async () => {
  const c = await cenario(a, 0);
  const primeira = await emTransacao(() => criarServicosComuns(tx, ctx(c)));
  assert.deepEqual(primeira.map((x) => x.situacao), ["CRIADO", "CRIADO", "CRIADO", "CRIADO"]);
  await a.query(`UPDATE adicionais SET nome = 'Monitores (2 por festa)' WHERE empresa_id = $1::uuid AND codigo = 'SERVICO_MONITORES'`, [c.empresa]);
  await a.query(`UPDATE adicionais SET ativo = false WHERE empresa_id = $1::uuid AND codigo = 'SERVICO_GERENTE'`, [c.empresa]);
  const segunda = await emTransacao(() => criarServicosComuns(tx, ctx(c)));
  assert.deepEqual(Object.fromEntries(segunda.map((x) => [x.codigo, x.situacao])),
    { SERVICO_ANIMACAO: "JA_EXISTIA", SERVICO_GERENTE: "INATIVO", SERVICO_MONITORES: "JA_EXISTIA", SERVICO_RECREACAO: "JA_EXISTIA" });
  assert.equal(segunda.find((x) => x.codigo === "SERVICO_MONITORES")!.nome, "Monitores (2 por festa)");
  assert.equal((await a.query<{ ativo: boolean }>(`SELECT ativo FROM adicionais WHERE empresa_id = $1::uuid AND codigo = 'SERVICO_GERENTE'`, [c.empresa])).rows[0].ativo, false);
  assert.equal((await a.query<{ n: number }>(`SELECT count(*)::int AS n FROM adicionais WHERE empresa_id = $1::uuid AND categoria = 'SERVICOS'`, [c.empresa])).rows[0].n, 4);
  // Código ocupado por outra categoria (inclusive inativo): conflito, nada tocado.
  const d = await cenario(a, 0);
  const extra = (await a.query<{ id: string }>(`SELECT id::text FROM adicional_categorias WHERE codigo = 'EXTRA'`)).rows[0].id;
  await a.query(`INSERT INTO adicionais (empresa_id, codigo, nome, categoria, categoria_id, unidade_cobranca, ordem_exibicao, ativo)
                 VALUES ($1::uuid, 'SERVICO_RECREACAO', 'Recreação antiga', 'EXTRA', $2::uuid, 'PACOTE', 1, false)`, [d.empresa, extra]);
  const terceira = await emTransacao(() => criarServicosComuns(tx, ctx(d)));
  assert.equal(terceira.find((x) => x.codigo === "SERVICO_RECREACAO")!.situacao, "CONFLITO");
  assert.equal((await a.query<{ nome: string }>(`SELECT nome FROM adicionais WHERE empresa_id = $1::uuid AND codigo = 'SERVICO_RECREACAO'`, [d.empresa])).rows[0].nome, "Recreação antiga");
  // A empresa c não ganhou nada da d e vice-versa (só a própria empresa).
  assert.equal((await a.query<{ n: number }>(`SELECT count(*)::int AS n FROM adicionais WHERE empresa_id = $1::uuid AND categoria = 'SERVICOS'`, [d.empresa])).rows[0].n, 3);
});

test("serviços comuns: dois cliques simultâneos — o segundo espera o índice parcial e classifica pelo vencedor", async () => {
  const c = await cenario(a, 0);
  const b = await conectarDescartavel({ travar: false });
  try {
    const pidA = (await a.query<{ p: number }>("SELECT pg_backend_pid() AS p")).rows[0].p;
    const pidB = (await b.query<{ p: number }>("SELECT pg_backend_pid() AS p")).rows[0].p;
    await a.query("BEGIN");
    const primeira = await criarServicosComuns(tx, ctx(c));
    await b.query("BEGIN");
    const segunda = criarServicosComuns(executor(b), ctx(c));
    for (let i = 0; i < 200; i++) {
      const w = await a.query<{ ok: boolean }>(`SELECT $1::int = ANY (pg_blocking_pids($2::int)) AS ok`, [pidA, pidB]);
      if (w.rows[0]?.ok) break;
      if (i === 199) assert.fail("o segundo clique não esperou o primeiro");
      await new Promise((fim) => setTimeout(fim, 25));
    }
    await a.query("COMMIT");
    const r2 = await segunda;
    await b.query("COMMIT");
    assert.deepEqual(primeira.map((x) => x.situacao), ["CRIADO", "CRIADO", "CRIADO", "CRIADO"]);
    assert.deepEqual(r2.map((x) => x.situacao), ["JA_EXISTIA", "JA_EXISTIA", "JA_EXISTIA", "JA_EXISTIA"]);
    assert.equal((await a.query<{ n: number }>(`SELECT count(*)::int AS n FROM adicionais WHERE empresa_id = $1::uuid AND categoria = 'SERVICOS'`, [c.empresa])).rows[0].n, 4);
  } finally {
    await b.end();
  }
});

test("exportação: dicionário do catálogo só com os códigos da empresa; fotos sem bytes; nada da outra empresa", async () => {
  const { gerarPacote } = await import("../exportacao/pacote.ts");
  const { lerZip } = await import("../exportacao/zip.ts");
  const { lerCsv } = await import("../exportacao/fixture.postgres.test-apoio.ts");
  const { readFileSync } = await import("node:fs");
  const A = await cenario(a, 0);
  const B = await cenario(a, 0);
  const vazia = await cenario(a, 0);
  const sa = await salao(A, 100, "Salão da A");
  const sb = await salao(B, 100, "Salão da B");
  for (const [c, s, codigos] of [[A, sa, ["WIFI"]], [B, sb, ["WIFI", "SINUCA"]]] as const) {
    await emTransacao(async () => salvarApresentacao(tx, ctx(c), s, await versao(c, s), NEUTRO,
      codigos.map((codigo) => ({ grupo: codigo === "WIFI" ? "CONFORTO" as const : "ADULTOS" as const, codigo, destaque: false }))));
  }
  await emTransacao(async () => adicionarFoto(tx, ctx(A), sa, await versao(A, sa), await imagem(), "Salão montado"));
  const pacote = async (empresa: string) => {
    await a.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      const p = await gerarPacote(tx, empresa);
      const zip = lerZip(readFileSync(p.zipCaminho));
      await p.limpar();
      return { p, zip };
    } finally {
      await a.query("COMMIT");
    }
  };
  const csv = (zip: Map<string, Buffer>, nome: string) => lerCsv(zip.get(`dados/agenda/${nome}.csv`)!.toString("utf8"));
  const pa = await pacote(A.empresa);
  assert.deepEqual(csv(pa.zip, "agenda_salao_itens_catalogo").slice(1).map((l) => l[0]), ["WIFI"]);
  const fotosA = csv(pa.zip, "agenda_salao_fotos");
  assert.ok(fotosA[0].includes("conteudo__sha256") && !fotosA[0].includes("conteudo"));
  assert.equal(fotosA.length, 2);
  const textoA = [...pa.zip.values()].map((b) => b.toString("utf8")).join("\n");
  assert.ok(!textoA.includes(sb) && !textoA.includes("SINUCA") && !textoA.includes(B.empresa));
  const pb = await pacote(B.empresa);
  assert.deepEqual(csv(pb.zip, "agenda_salao_itens_catalogo").slice(1).map((l) => l[0]).sort(), ["SINUCA", "WIFI"]);
  assert.equal(csv(pb.zip, "agenda_salao_fotos").length, 1);
  const pv = await pacote(vazia.empresa);
  assert.equal(csv(pv.zip, "agenda_salao_itens_catalogo").length, 1); // só o cabeçalho
});
