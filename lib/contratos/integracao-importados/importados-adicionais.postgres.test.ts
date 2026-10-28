import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../../comercial/postgres-descartavel.ts";
import {
  ambienteAssinatura, assinarComoCliente, carregar, catalogoNativo, cenario, completarCliente, congelarEAssinarKidmais, decisoes, dia, executor, id,
  importacao, integrar, PARCIAL, poolNaTransacao, validarAgora, type Cenario, type Servico,
} from "../../../scripts/integracao-importados-test-support.ts";

/**
 * Plano "importados com adicionais" (rev. 2, D1/D2 de 28/10/2026) no PostgreSQL DESCARTÁVEL (modelo 106: hash v1 em
 * POR_HORARIO e v2 em POR_SALAO), pelos serviços reais e com COMMIT:
 * - A: importação nova com "Adicionais" no documento → fechamento com o valor inteiro como pacote (adicionais 0); a versão
 *   conferida guarda a composição do documento; a nova versão abre (V1 em POR_HORARIO e V3 em POR_SALAO);
 * - B: importado LEGADO (fechamento no formato anterior: adicionais > 0 sem itens) → a revisão nasce normalizada, com
 *   tabela/valor final iguais, conteudo_hash = função do banco; controles da guarda da 014 SEPARADOS (soma inválida com
 *   hash correto; hash inválido com soma correta; SQLSTATE e diagnóstico exatos); ciclo cancelar → criar de novo →
 *   aplicar (assinaturas) → fechamento coerente → segunda revisão SEM normalização dupla; financeiro (obrigação, planos,
 *   parcelas, vencimentos, recebimentos, saldo, pendências) e documento antigo (snapshot, documentos, assinaturas) iguais;
 * - B V3 (POR_SALAO, hash v2, centavos): revisão normalizada; fonte_base_hash sobre o fechamento ORIGINAL (provado pela
 *   guarda "Fechamento vigente mudou"); edição cadastral preserva o preço; revisão comercial (negociado/aprovado em
 *   centavos) com a aprovação vinculada ao número e ao hash finais; cancelar preserva financeiro e documento;
 * - estados financeiros não conferido (sem obrigação: retrato bruto vazio) e quitado: o ciclo preserva financeiro e documento;
 * - misto e diferença negativa (itens que somam menos ou mais que o valor) → REVISAO_IMPORTADO_INCONSISTENTE antes de gravar.
 */
let a: Client;
type Operar = (versaoId: string, input: Record<string, unknown>, token: string, ctx: Record<string, unknown>, empresa: string) => Promise<unknown>;
const ctxOp = () => ({ requestId: randomUUID(), ip: null, userAgent: "importados-adicionais" });
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const COM_ADICIONAIS = { preco: 450000, adicionais: 50000, total: 500000 };
/** Adicionais com centavos não inteiros (R$ 123,45 de R$ 5.000,00). */
const COM_CENTAVOS = { preco: 487655, adicionais: 12345, total: 500000 };
/** Recusa da guarda com SQLSTATE e diagnóstico exatos (não aceita outro 23514). */
const recusaGuarda = (diagnostico: string) => (e: unknown) => {
  assert.equal((e as { code?: string }).code, "23514", `SQLSTATE de ${msg(e)}`);
  assert.equal(msg(e), diagnostico);
  return true;
};

async function comCommit<T>(corpo: () => Promise<T>) {
  await a.query("BEGIN");
  const restaurarPool = poolNaTransacao(a);
  const restaurarAmbiente = ambienteAssinatura();
  try {
    const r = await corpo();
    await a.query("COMMIT");
    return r;
  } catch (e) {
    await a.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    restaurarAmbiente();
    restaurarPool();
  }
}

/** Transação que sempre volta (controles negativos). */
async function semGravar(corpo: () => Promise<void>) {
  await a.query("BEGIN");
  try { await corpo(); } finally { await a.query("ROLLBACK"); }
}

async function empresa(tipo: "POR_HORARIO" | "POR_SALAO") {
  const c = await cenario(a, 0);
  const nativo = await catalogoNativo(a, c);
  const conteudo = { titulo: "Contrato importados com adicionais", contratada: { nome: "Buffet Adicionais Ltda", documento: "11.222.333/0001-81", endereco: "Rua Teste, 1", representante: "Pessoa Teste" },
    preambulo: [], clausulas: [{ titulo: "Objeto", texto: "Festa em {{festa.data}} para {{contratante.nome}}." }], observacoes: [], cidadeAssinatura: "Cidade Teste" };
  await a.query(`INSERT INTO modelos_contrato_empresa (empresa_id, versao, conteudo, conteudo_sha256, aprovado_por) VALUES ($1::uuid, 1, $2::jsonb, $3, $4::uuid)`,
    [c.empresa, JSON.stringify(conteudo), "a".repeat(64), c.usuario]);
  await a.query(`INSERT INTO agenda_escopo_config (empresa_id, modo, capacidade_tipo, limite_festas_dia, intervalo_minimo_minutos, configurado_por) VALUES ($1::uuid, 'FIXO', $2, NULL, 0, $3::uuid)`,
    [c.empresa, tipo, c.usuario]);
  const salao = tipo === "POR_SALAO" ? await id(a, `INSERT INTO agenda_saloes (empresa_id, nome, ordem, ativo) VALUES ($1::uuid, 'Salão A', 1, true) RETURNING id`, [c.empresa]) : undefined;
  return { c, nativo, salao };
}

/**
 * Importa e integra (código atual: A). `legado` devolve o fechamento ao formato anterior à correção (pacote = total −
 * adicionais do documento, adicionais sem itens).
 */
async function importado(c: Cenario, data: string, salao: string | undefined, legado: boolean, valores = COM_ADICIONAIS, fin: unknown = PARCIAL()) {
  const s = carregar<Servico>("lib/contratos/integracao-importados/servico.ts");
  const { coreNativo } = carregar<typeof import("./composicao.ts")>("lib/contratos/integracao-importados/composicao.ts");
  const ev = { data, inicio: "10:00", fim: "22:00" };
  const imp = await importacao(a, c, ev, false, valores);
  const cpf = await completarCliente(a, imp.cliente);
  const r = await integrar(s, coreNativo, a, c, imp.id, decisoes(c, ev, fin, null, undefined, salao));
  await validarAgora(a);
  const festa = (await a.query<{ f: string }>(`SELECT fechamento_id::text f FROM contratos WHERE id = $1::uuid`, [r.contratoId])).rows[0]!.f;
  if (legado) {
    const delta = (valores.adicionais ?? 0) / 100;
    await a.query("SET LOCAL session_replication_role = replica");
    await a.query(`UPDATE fechamentos SET valor_pacote_base = valor_pacote_base - $2::numeric, valor_pacote_aplicado = valor_pacote_aplicado - $2::numeric, valor_adicionais = $2::numeric WHERE id = $1::uuid`,
      [festa, delta.toFixed(2)]);
    await a.query("SET LOCAL session_replication_role = origin");
  }
  return { contrato: r.contratoId, festa, cpf };
}

const valores = async (db: Client, tabela: "fechamentos" | "fechamento_revisoes", idLinha: string) => (await db.query<{ base: string; aplicado: string; adicionais: string; tabela: string; desconto: string }>(
  `SELECT valor_pacote_base::text base, valor_pacote_aplicado::text aplicado, valor_adicionais::text adicionais, valor_tabela::text tabela, valor_desconto_pacote::text desconto FROM ${tabela} WHERE id = $1::uuid`, [idLinha])).rows[0]!;
const fmt = (base: string, adicionais: string, tabela: string) => ({ base, aplicado: base, adicionais, tabela, desconto: "0.00" });

/**
 * P2-3: retrato financeiro (com obrigação) pela leitura de domínio (a mesma da alteração financeira): obrigação, planos, parcelas e
 * vencimentos, cronograma e itens, recebimentos/estornos/devoluções/reservas, posição, saldo, pendências e tratamentos.
 * Sem carimbos de atualização.
 */
async function financeiro(db: Client, contrato: string) {
  const repo = carregar<typeof import("../../pagamentos/repositories/alteracao-financeira.repository.ts")>("lib/pagamentos/repositories/alteracao-financeira.repository.ts");
  const core = carregar<typeof import("../../pagamentos/services/alteracao-financeira-core.ts")>("lib/pagamentos/services/alteracao-financeira-core.ts");
  const p = await repo.lerPosicaoFinanceira(executor(db), contrato);
  const saldo = core.posicaoEconomica(p.valorVigente, 0n, p.posicao.recebido, p.posicao.estornado, p.posicao.devolvido, p.posicao.reservado).saldo;
  return JSON.parse(JSON.stringify(repo.serializarFinanceiro({
    obrigacao: p.pagamento, planos: p.planos, parcelas: p.parcelas, cronograma: p.cronograma, itens: p.itens, recebimentos: p.recebimentos, estornos: p.estornos,
    devolucoes: p.devolucoes, reservas: p.reservas, ajustes: p.ajustes, futuro: p.futuro, posicao: p.posicao, valorVigente: p.valorVigente, saldo,
    pendencias: p.pendencias, tratamentos: p.tratamentos,
  })), (k, x) => (k === "atualizado_em" || k === "atualizadoEm" ? undefined : x)) as Record<string, unknown>;
}
/**
 * P2-3 (rodada 3): retrato BRUTO do financeiro do contrato, válido também SEM obrigação (não conferido): linha inteira
 * (md5, sem atualizado_em) de pagamentos, planos, parcelas, recebimentos, cronogramas e itens, pendências financeiras e
 * conferência da importação. Sem obrigação, todas as famílias ficam vazias e têm de continuar vazias.
 */
const linhasFinanceiras = async (db: Client, contrato: string) => (await db.query<{ j: Record<string, string[]> }>(
  `WITH p AS (SELECT x.* FROM pagamentos x JOIN contrato_versoes v ON v.id = x.contrato_versao_id WHERE v.contrato_id = $1::uuid),
        pl AS (SELECT x.* FROM pagamento_planos x WHERE x.pagamento_id IN (SELECT id FROM p)),
        pp AS (SELECT x.* FROM pagamento_parcelas x WHERE x.plano_id IN (SELECT id FROM pl))
   SELECT jsonb_build_object(
     'obrigacao', (SELECT COALESCE(jsonb_agg(md5((to_jsonb(x) - 'atualizado_em')::text) ORDER BY x.id), '[]'::jsonb) FROM p x),
     'planos', (SELECT COALESCE(jsonb_agg(md5((to_jsonb(x) - 'atualizado_em')::text) ORDER BY x.id), '[]'::jsonb) FROM pl x),
     'parcelas', (SELECT COALESCE(jsonb_agg(md5((to_jsonb(x) - 'atualizado_em')::text) ORDER BY x.id), '[]'::jsonb) FROM pp x),
     'recebimentos', (SELECT COALESCE(jsonb_agg(md5((to_jsonb(x) - 'atualizado_em')::text) ORDER BY x.id), '[]'::jsonb) FROM pagamento_recebimentos x WHERE x.pagamento_id IN (SELECT id FROM p)),
     'cronogramas', (SELECT COALESCE(jsonb_agg(md5((to_jsonb(x) - 'atualizado_em')::text) ORDER BY x.id), '[]'::jsonb) FROM pagamento_cronogramas x WHERE x.plano_id IN (SELECT id FROM pl)),
     'cronogramaItens', (SELECT COALESCE(jsonb_agg(md5((to_jsonb(x) - 'atualizado_em')::text) ORDER BY x.id), '[]'::jsonb) FROM pagamento_cronograma_itens x WHERE x.parcela_id IN (SELECT id FROM pp)),
     'pendencias', (SELECT COALESCE(jsonb_agg(md5((to_jsonb(x) - 'atualizado_em')::text) ORDER BY x.id), '[]'::jsonb) FROM contrato_pendencias_financeiras x WHERE x.contrato_id = $1::uuid),
     'conferencia', (SELECT COALESCE(jsonb_agg(md5((to_jsonb(x) - 'atualizado_em')::text) ORDER BY x.id), '[]'::jsonb) FROM contrato_importacao_financeiro x WHERE x.contrato_importacao_id IN (SELECT i.id FROM contrato_importacoes i WHERE i.contrato_id = $1::uuid))) j`, [contrato])).rows[0]!.j;
/** P2-3: documento antigo = snapshot + hash + referências (documentos e assinaturas da versão, linha inteira). */
// Versão importada (061) não tem documento gerado nem assinatura digital: a referência é o vínculo contrato_importacoes e
// o original em papel (ia_documento_originais). As três famílias entram; ao menos uma tem de existir.
const documento = async (db: Client, versao: string) => (await db.query<{ numero: number; snapshot: unknown; hash: string; documentos: string[]; assinaturas: string[]; importacao: string[] }>(
  `SELECT v.numero_versao numero, v.snapshot, v.snapshot_hash hash,
          (SELECT COALESCE(jsonb_agg(md5((to_jsonb(d) - 'atualizado_em')::text) ORDER BY d.id), '[]'::jsonb) FROM contrato_documentos d WHERE d.contrato_versao_id = v.id) documentos,
          (SELECT COALESCE(jsonb_agg(md5((to_jsonb(s) - 'atualizado_em')::text) ORDER BY s.id), '[]'::jsonb) FROM contrato_assinaturas s WHERE s.contrato_versao_id = v.id) assinaturas,
          (SELECT COALESCE(jsonb_agg(md5((to_jsonb(i) - 'atualizado_em')::text) || ':' || md5((to_jsonb(o) - 'atualizado_em')::text) ORDER BY i.id), '[]'::jsonb)
             FROM contrato_importacoes i JOIN ia_documento_originais o ON o.id = i.documento_original_id WHERE i.contrato_versao_id = v.id) importacao
     FROM contrato_versoes v WHERE v.id = $1::uuid`, [versao])).rows[0]!;
const vigente = async (db: Client, contrato: string) => (await db.query<{ v: string }>(`SELECT versao_vigente_id::text v FROM contrato_fluxos WHERE contrato_id = $1::uuid`, [contrato])).rows[0]!.v;
const emPreparacao = async (db: Client, contrato: string) => (await db.query<{ v: string | null }>(`SELECT versao_em_preparacao_id::text v FROM contrato_fluxos WHERE contrato_id = $1::uuid`, [contrato])).rows[0]!.v;
const revisaoDe = async (db: Client, versao: string) => (await db.query<{ id: string; estado: string; hash_ok: boolean; v: number | null; revisao: number; hash: string }>(
  `SELECT id::text, estado, conteudo_hash = kidmais_hash_revisao_operacional(id) hash_ok, (to_jsonb(r)->>'hash_versao')::int v, revisao, conteudo_hash hash
     FROM fechamento_revisoes r WHERE contrato_versao_id = $1::uuid`, [versao])).rows[0]!;
const snapshotComercial = async (db: Client, versao: string) => (await db.query<{ c: Record<string, number> }>(`SELECT snapshot->'comercial' c FROM contrato_versoes WHERE id = $1::uuid`, [versao])).rows[0]!.c;
const edicao = async (v: string) => (await a.query<{ revisao: number }>(`SELECT revisao FROM contrato_edicoes WHERE contrato_versao_id = $1::uuid`, [v])).rows[0]!.revisao;

/** Dispara os gatilhos diferidos da revisão sem mudar nada (UPDATE sem efeito com os gatilhos ligados). */
async function conferirRevisao(revisaoId: string) {
  await a.query(`UPDATE fechamento_revisoes SET motivo = motivo WHERE id = $1::uuid`, [revisaoId]);
  await a.query("SET CONSTRAINTS ALL IMMEDIATE");
}

/**
 * P2-1: controles da guarda "Hash/soma da preparação inválidos" (014/016) ISOLADOS:
 * 0) sem adulteração, o mesmo disparo passa (o mecanismo do controle não recusa por si);
 * 1) soma inválida com hash CORRETO: valores do formato antigo e conteudo_hash recalculado pela função → recusa;
 * 2) hash inválido com soma CORRETA: só o conteudo_hash adulterado → recusa.
 */
async function controlesDaGuarda(revisaoId: string, legado: { base: string; adicionais: string }) {
  const diag = "Hash/soma da preparação inválidos";
  await semGravar(async () => { await conferirRevisao(revisaoId); });
  await semGravar(async () => {
    await a.query("SET LOCAL session_replication_role = replica");
    await a.query(`UPDATE fechamento_revisoes SET valor_pacote_base = $2::numeric, valor_pacote_aplicado = $2::numeric, valor_adicionais = $3::numeric WHERE id = $1::uuid`,
      [revisaoId, legado.base, legado.adicionais]);
    await a.query(`UPDATE fechamento_revisoes SET conteudo_hash = kidmais_hash_revisao_operacional(id) WHERE id = $1::uuid`, [revisaoId]);
    const x = (await a.query<{ hash_ok: boolean; soma_ok: boolean }>(`SELECT conteudo_hash = kidmais_hash_revisao_operacional(id) hash_ok,
        valor_adicionais = (SELECT COALESCE(sum(valor_total), 0) FROM fechamento_revisao_adicionais WHERE fechamento_revisao_id = r.id) soma_ok FROM fechamento_revisoes r WHERE id = $1::uuid`, [revisaoId])).rows[0]!;
    assert.deepEqual(x, { hash_ok: true, soma_ok: false }, "controle 1 isola a soma");
    await a.query("SET LOCAL session_replication_role = origin");
    await assert.rejects(conferirRevisao(revisaoId), recusaGuarda(diag));
  });
  await semGravar(async () => {
    await a.query("SET LOCAL session_replication_role = replica");
    await a.query(`UPDATE fechamento_revisoes SET conteudo_hash = repeat('0', 64) WHERE id = $1::uuid`, [revisaoId]);
    const x = (await a.query<{ hash_ok: boolean; soma_ok: boolean }>(`SELECT conteudo_hash = kidmais_hash_revisao_operacional(id) hash_ok,
        valor_adicionais = (SELECT COALESCE(sum(valor_total), 0) FROM fechamento_revisao_adicionais WHERE fechamento_revisao_id = r.id) soma_ok FROM fechamento_revisoes r WHERE id = $1::uuid`, [revisaoId])).rows[0]!;
    assert.deepEqual(x, { hash_ok: false, soma_ok: true }, "controle 2 isola o hash");
    await a.query("SET LOCAL session_replication_role = origin");
    await assert.rejects(conferirRevisao(revisaoId), recusaGuarda(diag));
  });
}

test.before(async () => {
  process.env.FESTA_ENABLED = "true";
  process.env.CONTRACT_IMPORT_INTEGRATION_ENABLED = "true";
  a = await conectarDescartavel();
});
test.after(async () => { if (a) await encerrarDescartavel(a); });

test("A (V1 em POR_HORARIO e V3 em POR_SALAO): fechamento com pacote integral, documento com a composição, nova versão abre", { timeout: 300_000 }, async () => {
  const adm = carregar<typeof import("../services/administrativo.service.ts")>("lib/contratos/services/administrativo.service.ts");
  const operar = adm.operarContrato as unknown as Operar;
  for (const [tipo, data] of [["POR_HORARIO", dia(90)], ["POR_SALAO", dia(91)]] as const) {
    const r = await comCommit(async () => {
      const { c, salao } = await empresa(tipo);
      const x = await importado(c, data, salao, false);
      return { c, ...x };
    });
    const obs = await conectarDescartavel({ travar: false });
    try {
      assert.deepEqual(await valores(obs, "fechamentos", r.festa), fmt("5000.00", "0.00", "5000.00"), tipo);
      const v1 = await vigente(obs, r.contrato);
      const doc = await snapshotComercial(obs, v1);
      assert.deepEqual([doc.valorPacoteBase, doc.valorPacoteAplicado, doc.valorDescontoPacote, doc.valorAdicionais, doc.valorTabela], [4500, 4500, 0, 500, 5000], `${tipo}: documento com a composição`);
    } finally { await encerrarDescartavel(obs, false); }
    await comCommit(async () => {
      await operar(await vigente(a, r.contrato), { acao: "nova_versao", tipo: "NOVA_VERSAO", motivo: "Teste adicionais A", chaveCriacao: randomUUID() }, r.c.token, ctxOp(), r.c.empresa);
      await validarAgora(a);
    });
    const rev = await revisaoDe(a, (await emPreparacao(a, r.contrato))!);
    assert.equal(rev.hash_ok, true, `${tipo}: conteudo_hash = função`);
    assert.equal(rev.v, tipo === "POR_SALAO" ? 2 : 1, `${tipo}: hash v1/v2`);
    assert.deepEqual(await valores(a, "fechamento_revisoes", rev.id), fmt("5000.00", "0.00", "5000.00"));
  }
});

test("B legado: revisão normalizada; controles isolados de soma e hash; cancelar, criar de novo, aplicar e segunda revisão sem normalização dupla; financeiro e documento preservados", { timeout: 600_000 }, async () => {
  const adm = carregar<typeof import("../services/administrativo.service.ts")>("lib/contratos/services/administrativo.service.ts");
  const operar = adm.operarContrato as unknown as Operar;
  const r = await comCommit(async () => {
    const { c, nativo } = await empresa("POR_HORARIO");
    const x = await importado(c, dia(92), undefined, true);
    return { c, nativo, ...x };
  });
  const LEGADO = fmt("4500.00", "500.00", "5000.00");
  assert.deepEqual(await valores(a, "fechamentos", r.festa), LEGADO, "fixture no formato legado");
  const v1 = await vigente(a, r.contrato);
  const docAntes = await documento(a, v1);
  assert.ok(docAntes.documentos.length + docAntes.assinaturas.length + docAntes.importacao.length > 0, "o documento antigo tem referências a comparar");
  assert.equal(docAntes.importacao.length, 1, "vínculo da importação e original em papel");
  const finAntes = await financeiro(a, r.contrato);
  const abrir = async (motivo: string) => {
    await operar(await vigente(a, r.contrato), { acao: "nova_versao", tipo: "NOVA_VERSAO", motivo, chaveCriacao: randomUUID() }, r.c.token, ctxOp(), r.c.empresa);
    return (await emPreparacao(a, r.contrato))!;
  };
  const preservados = async (etapa: string) => {
    assert.deepEqual(await financeiro(a, r.contrato), finAntes, `${etapa}: obrigação, parcelas, vencimentos, recebimentos, saldo e pendências`);
    assert.deepEqual(await documento(a, v1), docAntes,`${etapa}: snapshot, hash, documentos e assinaturas da versão antiga`);
  };
  // 1) Abre normalizada, com COMMIT; leitura por outra conexão.
  const v2 = await comCommit(async () => { const v = await abrir("Legado: primeira revisão"); await validarAgora(a); return v; });
  const obs = await conectarDescartavel({ travar: false });
  try {
    const rev = await revisaoDe(obs, v2);
    assert.deepEqual(await valores(obs, "fechamento_revisoes", rev.id), fmt("5000.00", "0.00", "5000.00"), "revisão normalizada");
    assert.equal(rev.hash_ok, true);
    assert.equal(rev.v, 1, "hash v1 em POR_HORARIO");
    assert.deepEqual(await valores(obs, "fechamentos", r.festa), LEGADO, "fechamento assinado intocado");
  } finally { await encerrarDescartavel(obs, false); }
  await preservados("criada");
  // Controles negativos isolados (P2-1).
  await controlesDaGuarda((await revisaoDe(a, v2)).id, { base: "4500.00", adicionais: "500.00" });
  // 2) Cancela; cria de novo (repetição): de novo normalizada.
  await comCommit(async () => { await operar(v2, { acao: "cancelar_revisao", revisao: await edicao(v2), motivo: "Teste cancelamento" }, r.c.token, ctxOp(), r.c.empresa); await validarAgora(a); });
  assert.deepEqual(await valores(a, "fechamentos", r.festa), LEGADO);
  await preservados("cancelada");
  const v3 = await comCommit(async () => { const v = await abrir("Legado: repetição"); await validarAgora(a); return v; });
  assert.equal((await valores(a, "fechamento_revisoes", (await revisaoDe(a, v3)).id)).adicionais, "0.00");
  // 3) Aplica (assinaturas): fechamento coerente; financeiro e documento antigo preservados.
  await comCommit(async () => {
    await congelarEAssinarKidmais(a, operar as never, v3, r.c.empresa, r.c.token, r.nativo.tokenRepresentante);
    await assinarComoCliente(r.contrato, r.cpf);
    await validarAgora(a);
  });
  assert.equal((await revisaoDe(a, v3)).estado, "APLICADA");
  assert.deepEqual(await valores(a, "fechamentos", r.festa), fmt("5000.00", "0.00", "5000.00"), "fechamento coerente depois de aplicar");
  await preservados("aplicada");
  // 4) Segunda revisão: nada a normalizar (sem Δ), valores iguais aos do fechamento.
  const v4 = await comCommit(async () => { const v = await abrir("Legado: segunda revisão"); await validarAgora(a); return v; });
  assert.deepEqual(await valores(a, "fechamento_revisoes", (await revisaoDe(a, v4)).id), fmt("5000.00", "0.00", "5000.00"));
});

test("B V3 (POR_SALAO, hash v2, centavos): fonte original, edição cadastral preserva o preço, revisão comercial aprovada no hash final, cancelar preserva financeiro e documento", { timeout: 600_000 }, async () => {
  const adm = carregar<typeof import("../services/administrativo.service.ts")>("lib/contratos/services/administrativo.service.ts");
  const rs = carregar<typeof import("../../fechamentos/services/revisao-operacional.service.ts")>("lib/fechamentos/services/revisao-operacional.service.ts");
  const operar = adm.operarContrato as unknown as Operar;
  const r = await comCommit(async () => {
    const { c, nativo, salao } = await empresa("POR_SALAO");
    const x = await importado(c, dia(94), salao, true, COM_CENTAVOS);
    return { c, nativo, ...x };
  });
  const LEGADO = fmt("4876.55", "123.45", "5000.00");
  const NORMALIZADO = fmt("5000.00", "0.00", "5000.00");
  assert.deepEqual(await valores(a, "fechamentos", r.festa), LEGADO, "fixture legada com centavos");
  const v1 = await vigente(a, r.contrato);
  const doc = await snapshotComercial(a, v1);
  assert.deepEqual([doc.valorPacoteBase, doc.valorAdicionais, doc.valorTabela], [4876.55, 123.45, 5000], "documento com a composição em centavos");
  const docAntes = await documento(a, v1);
  const finAntes = await financeiro(a, r.contrato);
  const v2 = await comCommit(async () => {
    await operar(v1, { acao: "nova_versao", tipo: "NOVA_VERSAO", motivo: "Legado V3: revisão", chaveCriacao: randomUUID() }, r.c.token, ctxOp(), r.c.empresa);
    await validarAgora(a);
    return (await emPreparacao(a, r.contrato))!;
  });
  let rev = await revisaoDe(a, v2);
  assert.deepEqual(await valores(a, "fechamento_revisoes", rev.id), NORMALIZADO, "revisão normalizada (centavos)");
  assert.deepEqual([rev.hash_ok, rev.v], [true, 2], "hash v2 = função");
  assert.deepEqual(await valores(a, "fechamentos", r.festa), LEGADO, "fechamento intocado");
  // Fonte original: o mesmo disparo passa com o fechamento legado e é recusado se o fechamento ficasse normalizado.
  await semGravar(async () => {
    await a.query(`UPDATE fechamentos SET tema_festa = tema_festa WHERE id = $1::uuid`, [r.festa]);
    await a.query("SET CONSTRAINTS ALL IMMEDIATE");
  });
  await semGravar(async () => {
    await a.query("SET LOCAL session_replication_role = replica");
    await a.query(`UPDATE fechamentos SET valor_pacote_base = 5000, valor_pacote_aplicado = 5000, valor_adicionais = 0 WHERE id = $1::uuid`, [r.festa]);
    await a.query("SET LOCAL session_replication_role = origin");
    await a.query(`UPDATE fechamentos SET tema_festa = tema_festa WHERE id = $1::uuid`, [r.festa]);
    await assert.rejects(a.query("SET CONSTRAINTS ALL IMMEDIATE"), recusaGuarda("Fechamento vigente mudou durante preparação"));
  });
  await controlesDaGuarda(rev.id, { base: "4876.55", adicionais: "123.45" });
  // Edição cadastral (tema) com o mesmo destino: preço histórico preservado, ainda normalizado, hash v2 recalculado.
  const editar = async (extra: Record<string, unknown>) => {
    const fonte = (await rs.fontesPreparacao(v2, executor(a)))!;
    const f = fonte.fechamento;
    return operar(v2, { acao: "editar_festa", revisao: await edicao(v2), motivo: "Legado V3: edição", fonteHash: fonte.fonteHash, pacoteId: f.pacoteId, convidados: f.convidados,
      dataEvento: f.dataEvento, configuracaoAgendaId: f.configuracaoAgendaId, horarioInicio: f.horarioInicio.slice(0, 5), horarioFim: f.horarioFim.slice(0, 5), adicionais: fonte.adicionais,
      idadeAniversarianteEvento: 6, temaFesta: "Fundo do mar", buffetStatus: "PENDENTE", buffetSalgados: "", buffetBebidas: "", buffetDoces: "", buffetBolo: "", buffetOutros: "",
      observacoesEquipe: "Revisão do legado V3", ...extra }, r.c.token, ctxOp(), r.c.empresa);
  };
  const antesCadastro = rev.revisao;
  await comCommit(async () => { await editar({}); await validarAgora(a); });
  rev = await revisaoDe(a, v2);
  assert.deepEqual(await valores(a, "fechamento_revisoes", rev.id), NORMALIZADO, "edição cadastral preserva o preço");
  assert.deepEqual([rev.hash_ok, rev.v, rev.revisao > antesCadastro], [true, 2, true]);
  assert.equal((await a.query<{ t: string }>(`SELECT tema_festa t FROM fechamento_revisoes WHERE id = $1::uuid`, [rev.id])).rows[0]!.t, "Fundo do mar");
  // Revisão comercial: base negociada com centavos (desconto negociado) e aprovação explícita.
  await comCommit(async () => {
    await editar({ configuracaoAgendaId: r.nativo.turno, comercial: { confirmarAprovacao: true, forma: "PIX_AVISTA", baseNegociada: 87.65, condicaoPix: null } });
    await validarAgora(a);
  });
  rev = await revisaoDe(a, v2);
  const com = (await a.query<{ tabela: string; negociado: string | null; aprovado: string | null; adicionais: string; aplicado: string; aprovada: number | null;
    a_status: string; a_valor: string; a_revisao: string; a_numero: number; a_hash: string }>(
    `SELECT r.valor_tabela::text tabela, r.valor_negociado::text negociado, r.valor_aprovado::text aprovado, r.valor_adicionais::text adicionais, r.valor_pacote_aplicado::text aplicado,
            r.revisao_comercial_aprovada aprovada, n.status a_status, n.valor_aprovado::text a_valor, n.fechamento_revisao_id::text a_revisao, n.fechamento_revisao_numero a_numero,
            n.fechamento_revisao_hash a_hash
       FROM fechamento_revisoes r JOIN aprovacoes_negociacao n ON n.id = r.aprovacao_negociacao_id WHERE r.id = $1::uuid`, [rev.id])).rows[0]!;
  assert.deepEqual([com.negociado, com.aprovado, com.a_status, com.a_valor], ["87.65", "87.65", "APROVADO", "87.65"], "negociado/aprovado em centavos");
  assert.equal(com.adicionais, "0.00", "sem adicionais fantasmas depois da edição comercial");
  assert.equal(Number(com.aplicado) + Number(com.adicionais), Number(com.tabela), "soma coerente");
  assert.deepEqual([com.a_revisao, com.a_numero, com.a_hash, com.aprovada], [rev.id, rev.revisao, rev.hash, rev.revisao], "aprovação no número e no hash finais");
  assert.deepEqual([rev.hash_ok, rev.v], [true, 2]);
  // Cancela: fechamento, financeiro e documento antigo iguais.
  await comCommit(async () => { await operar(v2, { acao: "cancelar_revisao", revisao: await edicao(v2), motivo: "Legado V3: cancelamento" }, r.c.token, ctxOp(), r.c.empresa); await validarAgora(a); });
  assert.deepEqual(await valores(a, "fechamentos", r.festa), LEGADO);
  assert.deepEqual(await financeiro(a, r.contrato), finAntes, "financeiro preservado");
  assert.deepEqual(await documento(a, v1), docAntes, "documento antigo preservado");
});

test("B legado nos estados financeiros não conferido (sem obrigação) e quitado: criar, cancelar, criar e aplicar preservam financeiro e documento", { timeout: 600_000 }, async () => {
  const adm = carregar<typeof import("../services/administrativo.service.ts")>("lib/contratos/services/administrativo.service.ts");
  const operar = adm.operarContrato as unknown as Operar;
  const QUITADO = { situacao: "PAGO", parcelas: [{ valorCentavos: 500000, vencimento: dia(-210), recebimento: { data: dia(-209), forma: "DINHEIRO" } }] };
  for (const [estado, fin, data] of [["NAO_CONFERIDO", { situacao: "NAO_CONFERIDO" }, dia(96)], ["QUITADO", QUITADO, dia(97)]] as const) {
    const r = await comCommit(async () => {
      const { c, nativo } = await empresa("POR_HORARIO");
      const x = await importado(c, data, undefined, true, COM_ADICIONAIS, fin);
      return { c, nativo, ...x };
    });
    assert.deepEqual(await valores(a, "fechamentos", r.festa), fmt("4500.00", "500.00", "5000.00"), `${estado}: fixture legada`);
    const v1 = await vigente(a, r.contrato);
    const docAntes = await documento(a, v1);
    assert.equal(docAntes.importacao.length, 1, `${estado}: vínculo da importação`);
    const linhasAntes = await linhasFinanceiras(a, r.contrato);
    const status = async () => (await a.query<{ s: string; q: boolean }>(`SELECT p.status s, p.quitado_em IS NOT NULL q FROM pagamentos p JOIN contrato_versoes v ON v.id = p.contrato_versao_id WHERE v.contrato_id = $1::uuid`, [r.contrato])).rows.map((x) => ({ ...x }));
    if (estado === "NAO_CONFERIDO") {
      assert.deepEqual(Object.values(linhasAntes).map((l) => l.length), [0, 0, 0, 0, 0, 0, 0, 0], "não conferido: nenhuma obrigação nem registro financeiro");
    } else {
      assert.deepEqual(await status(), [{ s: "QUITADO", q: true }], "quitado");
      assert.deepEqual([linhasAntes.recebimentos!.length, linhasAntes.conferencia!.length], [1, 1], "quitado: recebimento e conferência");
    }
    const finAntes = estado === "QUITADO" ? await financeiro(a, r.contrato) : null;
    const preservados = async (etapa: string) => {
      assert.deepEqual(await linhasFinanceiras(a, r.contrato), linhasAntes, `${estado} ${etapa}: linhas financeiras`);
      if (finAntes) assert.deepEqual(await financeiro(a, r.contrato), finAntes, `${estado} ${etapa}: posição, saldo e pendências`);
      assert.deepEqual(await documento(a, v1), docAntes, `${estado} ${etapa}: documento antigo`);
    };
    const abrir = (motivo: string) => comCommit(async () => {
      await operar(await vigente(a, r.contrato), { acao: "nova_versao", tipo: "NOVA_VERSAO", motivo, chaveCriacao: randomUUID() }, r.c.token, ctxOp(), r.c.empresa);
      await validarAgora(a);
      return (await emPreparacao(a, r.contrato))!;
    });
    const v2 = await abrir(`${estado}: revisão`);
    assert.deepEqual(await valores(a, "fechamento_revisoes", (await revisaoDe(a, v2)).id), fmt("5000.00", "0.00", "5000.00"), `${estado}: normalizada`);
    await preservados("criada");
    await comCommit(async () => { await operar(v2, { acao: "cancelar_revisao", revisao: await edicao(v2), motivo: "Teste cancelamento" }, r.c.token, ctxOp(), r.c.empresa); await validarAgora(a); });
    await preservados("cancelada");
    const v3 = await abrir(`${estado}: repetição`);
    await comCommit(async () => {
      await congelarEAssinarKidmais(a, operar as never, v3, r.c.empresa, r.c.token, r.nativo.tokenRepresentante);
      await assinarComoCliente(r.contrato, r.cpf);
      await validarAgora(a);
    });
    assert.equal((await revisaoDe(a, v3)).estado, "APLICADA", `${estado}: aplicada`);
    assert.deepEqual(await valores(a, "fechamentos", r.festa), fmt("5000.00", "0.00", "5000.00"), `${estado}: fechamento coerente`);
    await preservados("aplicada");
    if (estado === "QUITADO") assert.deepEqual(await status(), [{ s: "QUITADO", q: true }], "segue quitado");
  }
});

test("misto e diferença negativa: itens que não explicam o valor (a menos ou a mais) → REVISAO_IMPORTADO_INCONSISTENTE, nada gravado", { timeout: 300_000 }, async () => {
  for (const [item, data] of [[200, dia(93)], [700, dia(95)]] as const) await misto(item, data);
});

async function misto(item: number, data: string) {
  const adm = carregar<typeof import("../services/administrativo.service.ts")>("lib/contratos/services/administrativo.service.ts");
  const operar = adm.operarContrato as unknown as Operar;
  const r = await comCommit(async () => {
    const { c } = await empresa("POR_HORARIO");
    const x = await importado(c, data, undefined, true);
    const adicional = (await a.query<{ id: string; preco: string | null }>(
      `SELECT a.id::text, (SELECT pa.id::text FROM precos_adicional pa WHERE pa.adicional_id = a.id LIMIT 1) preco FROM adicionais a LIMIT 1`)).rows[0];
    if (!adicional) return { c, ...x, semAdicional: true };
    await a.query("SET LOCAL session_replication_role = replica");
    await a.query(`INSERT INTO fechamento_adicionais (fechamento_id, adicional_id, preco_adicional_id, nome_aplicado, unidade_cobranca_aplicada, quantidade, valor_unitario_aplicado, valor_total)
                   VALUES ($1::uuid, $2::uuid, $3::uuid, 'Item lançado', 'UNIDADE', 1, $4::numeric, $4::numeric)`, [x.festa, adicional.id, adicional.preco, item]);
    await a.query("SET LOCAL session_replication_role = origin");
    return { c, ...x, semAdicional: false };
  });
  if (r.semAdicional) { assert.fail("o modelo não tem adicional no catálogo para montar o caso misto"); return; }
  const antes = (await a.query<{ n: number }>(`SELECT count(*)::int n FROM fechamento_revisoes WHERE fechamento_id = $1::uuid`, [r.festa])).rows[0]!.n;
  await a.query("BEGIN");
  const restaurarPool = poolNaTransacao(a);
  try {
    await assert.rejects(operar(await vigente(a, r.contrato), { acao: "nova_versao", tipo: "NOVA_VERSAO", motivo: "Misto", chaveCriacao: randomUUID() }, r.c.token, ctxOp(), r.c.empresa),
      (e: unknown) => (e as { code?: string }).code === "REVISAO_IMPORTADO_INCONSISTENTE" && /não correspondem aos itens lançados/.test(msg(e)));
  } finally { await a.query("ROLLBACK"); restaurarPool(); }
  assert.equal((await a.query<{ n: number }>(`SELECT count(*)::int n FROM fechamento_revisoes WHERE fechamento_id = $1::uuid`, [r.festa])).rows[0]!.n, antes, `item ${item}: nada gravado`);
  assert.equal(await emPreparacao(a, r.contrato), null);
}
