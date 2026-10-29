import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import type { DbExecutor } from "../db/contracts.ts";
import { catalogoNativo, catalogoNoTurno, cenario, dia, executor, id, type Cenario } from "../../scripts/integracao-importados-test-support.ts";
import { normalizarWebp } from "../imagens/normalizar-webp.ts";
import { adicionarFoto, confirmarDeclaracao, salvarApresentacao, type CamposInformados } from "./salao-apresentacao.ts";
import { fotoPublica, listarSaloesPublicos, nomeDoSalaoPublico, SalaoPublicoIndisponivel, saloesProntosPublicos } from "./salao-publico.ts";
import { estadoCombinados } from "./estado-combinados.ts";
import { lerRegraCapacidadeAgenda } from "../disponibilidade/repositories/disponibilidade.repository.ts";
import { consultarDisponibilidadeData } from "../disponibilidade/services/availability.service.ts";

/**
 * Retomada 098 (rev. 2.1, P2-R2-2; parecer do Astra de 29/10, P1-1 e P2-2) no PostgreSQL DESCARTÁVEL, modelo 107 (sem a
 * 108), com SALOES_PUBLICOS ligada e a lista pública em uso:
 *   * TRANSIÇÃO: antes da 108 (sem a coluna) a lista mostra os simples; a 108 é aplicada com a lista em uso e ela continua
 *     igual; um combinado criado e PRONTO pelas regras da 102 (conteúdo próprio, D-R3) não aparece (lista, foto, nome);
 *   * regra de capacidade: candidato sem combinado por padrão; com `incluirCombinados` (painel), com; conjuntos mantidos;
 *   * disponibilidade: pacote cujo único salão é o combinado não fica DISPONÍVEL para o cliente, e fica para o painel;
 *   * PARCIAL (P1-1): a lista pública continua sem o combinado, e a regra, a disponibilidade e a lista com situação
 *     RECUSAM (nunca devolvem o combinado como candidato nem tiram os conjuntos das ocupações);
 *   * RECUPERAÇÃO: desfeita a avaria, tudo volta como antes.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arquivo = (p: string) => readFileSync(resolve(root, p), "utf8");
let a: Client;
let tx: DbExecutor;
const LIGADO = { SALOES_PUBLICOS: "true" };
const ctx = (c: Cenario) => ({ empresaId: c.empresa, usuarioId: c.usuario, requestId: crypto.randomUUID() });

async function emTransacao<T>(fn: () => Promise<T>): Promise<T> {
  await a.query("BEGIN");
  try { const r = await fn(); await a.query("COMMIT"); return r; } catch (e) { await a.query("ROLLBACK"); throw e; }
}
async function imagem() {
  const cor = { r: randomBytes(1)[0]!, g: randomBytes(1)[0]!, b: randomBytes(1)[0]! };
  return normalizarWebp(await sharp({ create: { width: 40, height: 30, channels: 3, background: cor } }).png().toBuffer());
}
/** Deixa um salão (simples ou combinado) PRONTO pelos serviços reais da 102: campos, 6 fotos, mês e declaração. */
async function publicar(c: Cenario, s: string, nome: string) {
  const v0 = (await a.query<{ v: number }>(`SELECT conteudo_versao AS v FROM agenda_saloes WHERE id = $1`, [s])).rows[0]!.v;
  const campos: CamposInformados = { convidadosMinimo: null, convidadosSentados: null, areaM2: 100, idadeMin: 3, idadeMax: 10, frase: `Salão ${nome}`,
    outraFestaSimultanea: true, exclusivos: ["ENTRADA"], fotosReferencia: "2026-09" };
  let r = await emTransacao(() => salvarApresentacao(tx, ctx(c), s, v0, campos, []));
  let foto: string | null = null;
  for (let i = 0; i < 6; i++) {
    r = await emTransacao(async () => adicionarFoto(tx, ctx(c), s, r.conteudoVersao, await imagem(), `Ambiente ${i + 1}`));
  }
  foto = (await a.query<{ id: string }>(`SELECT id::text FROM agenda_salao_fotos WHERE salao_id = $1::uuid AND removida_em IS NULL LIMIT 1`, [s])).rows[0]!.id;
  await emTransacao(() => confirmarDeclaracao(tx, ctx(c), s, r.conteudoVersao));
  return foto;
}

test.before(async () => { a = await conectarDescartavel(); tx = executor(a); });
test.after(async () => { if (a) await encerrarDescartavel(a); });

test("transição, E2a, parcial e recuperação do filtro público com SALOES_PUBLICOS ligada", async () => {
  assert.equal((await estadoCombinados(tx)).estado, "AUSENTE", "modelo 107: sem a 108");
  const c = await cenario(a, 0);
  await a.query(`INSERT INTO agenda_escopo_config (empresa_id, modo, capacidade_tipo, limite_festas_dia, intervalo_minimo_minutos, configurado_por)
                 VALUES ($1::uuid, 'FIXO', 'POR_SALAO', NULL, 0, $2::uuid)`, [c.empresa, c.usuario]);
  const tarde = await id(a, `INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, tolerancia_inicio_minutos, passo_inicio_minutos,
                ordem_exibicao, empresa_id, capacidade) VALUES ('TARDE_108', 'Tarde', '15:00', '19:00', 0, 30, 1, $1::uuid, 1) RETURNING id`, [c.empresa]);
  const A = await id(a, `INSERT INTO agenda_saloes (empresa_id, nome, capacidade_convidados, ordem) VALUES ($1::uuid, 'A', 60, 1) RETURNING id`, [c.empresa]);
  const B = await id(a, `INSERT INTO agenda_saloes (empresa_id, nome, capacidade_convidados, ordem) VALUES ($1::uuid, 'B', 60, 2) RETURNING id`, [c.empresa]);
  await publicar(c, A, "A");
  await publicar(c, B, "B");
  await catalogoNativo(a, c);
  await catalogoNoTurno(a, c, tarde);
  const escopo = { empresaId: c.empresa, estabelecimentoId: null };
  const D = dia(60);
  const consulta = { data: D, configuracaoId: tarde, inicio: "15:00", fim: "19:00", convidados: 40 };
  const lista = async () => (await listarSaloesPublicos(tx, escopo, consulta, LIGADO)).saloes.map((s) => s.id);
  assert.deepEqual(await lista(), [A, B], "antes da 108");

  // Transição: a 108 entra com a lista em uso; nada muda para o cliente.
  await a.query(arquivo("database/checks/20261028_108_precheck.sql"));
  await a.query(arquivo("database/migrations/20261028_108_saloes_combinados.sql"));
  await a.query(arquivo("database/checks/20261028_108_postcheck.sql"));
  assert.equal((await estadoCombinados(tx)).estado, "NOVA");
  assert.deepEqual(await lista(), [A, B], "logo depois da 108");

  // E2a: combinado PRONTO (conteúdo próprio) e nada dele aparece ao cliente.
  const AB = await id(a, `INSERT INTO agenda_saloes (empresa_id, nome, capacidade_convidados, ordem, combinado, membros) VALUES ($1::uuid, 'A+B', 120, 3, true, $2::uuid[]) RETURNING id`,
    [c.empresa, [A, B].sort()]);
  const fotoAB = await publicar(c, AB, "A+B");
  assert.deepEqual((await saloesProntosPublicos(tx, escopo, LIGADO)).map((s) => s.id), [A, B], "só os simples");
  assert.deepEqual(await lista(), [A, B], "lista com situação, sem o combinado");
  await assert.rejects(fotoPublica(tx, escopo, AB, fotoAB, LIGADO), SalaoPublicoIndisponivel);
  assert.equal(await nomeDoSalaoPublico(tx, escopo, AB, LIGADO), null);
  assert.equal(await nomeDoSalaoPublico(tx, escopo, A, LIGADO), "A");
  const cliente = await lerRegraCapacidadeAgenda(tx, escopo);
  const painel = await lerRegraCapacidadeAgenda(tx, escopo, { incluirCombinados: true });
  assert.deepEqual([...cliente!.saloesDoEscopo].sort(), [A, B].sort());
  assert.deepEqual([...painel!.saloesDoEscopo].sort(), [A, B, AB].sort());
  assert.deepEqual([...(cliente!.conjuntos?.[AB] ?? [])].sort(), [A, B].sort(), "a ocupação do combinado continua impedindo os membros");
  const horario = async (incluirCombinados: boolean) => (await consultarDisponibilidadeData(D, tx, undefined, escopo, { saloesDoPacote: [AB], convidados: 100, incluirCombinados }))
    .periodos.find((p) => p.configuracaoId === tarde)?.horarios.find((h) => h.inicio === "15:00")?.status ?? "AUSENTE";
  assert.notEqual(await horario(false), "DISPONIVEL", "cliente: sem salão para o pacote do combinado");
  assert.equal(await horario(true), "DISPONIVEL", "painel: o combinado serve");

  // PARCIAL (P1-1): avarias diferentes; a lista sem combinado continua; o que depende de candidatos/conjuntos RECUSA.
  const parcial = /instalação dos salões combinados está incompleta/;
  for (const avaria of ["DROP FUNCTION public.kidmais098_salao_elegivel(uuid)", "ALTER TABLE public.agenda_saloes DISABLE TRIGGER agenda_saloes_098_guarda_trg"]) {
    await a.query("BEGIN");
    try {
      await a.query(avaria);
      assert.deepEqual(await estadoCombinados(tx), { estado: "PARCIAL", coluna: true }, avaria);
      assert.deepEqual((await saloesProntosPublicos(tx, escopo, LIGADO)).map((s) => s.id), [A, B], "portões sem o combinado");
      await assert.rejects(lerRegraCapacidadeAgenda(tx, escopo), parcial);
      await assert.rejects(lerRegraCapacidadeAgenda(tx, escopo, { incluirCombinados: true }), parcial);
      await assert.rejects(consultarDisponibilidadeData(D, tx, undefined, escopo, { convidados: 40 }), parcial);
      await assert.rejects(lista(), parcial);
    } finally { await a.query("ROLLBACK"); }
  }

  // Recuperação: desfeita a avaria, tudo volta como antes.
  assert.equal((await estadoCombinados(tx)).estado, "NOVA");
  assert.deepEqual(await lista(), [A, B]);
  assert.equal(await horario(true), "DISPONIVEL");
});
