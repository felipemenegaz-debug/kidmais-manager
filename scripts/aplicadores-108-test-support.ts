import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Client } from "pg";
import {
  ambienteAssinatura, carregar, catalogoNativo, catalogoNoTurno, cenario, comSalaoEscolhido, completarCliente, decisoes, dia, executor, id, importacao, integrar,
  PARCIAL, poolNaTransacao, root, validarAgora, type Cenario, type Servico,
} from "./integracao-importados-test-support.ts";

/**
 * Apoio de teste (plano E4, E4-6): as conferências históricas (092–094, 100 e 098) no modelo 108 do PostgreSQL
 * DESCARTÁVEL. Só é usado por `*.postgres.test.ts` com opt-in; recebe o Client já aberto pela suíte e nunca conecta
 * sozinho. Três peças:
 *   - medirF2: o esperado de F2 ainda é A_MEDIR_NO_CLUSTER (database/checks/20261029_108_retratos_esperados.json). O teste
 *     mede o retrato restrito no modelo 108 LIMPO (antes de qualquer avaria) com a sessão do retrato (READ ONLY,
 *     search_path = pg_catalog) e devolve o env do override SÓ DE TESTE KIDMAIS_RETRATOS_108_TESTE (JSON no formato do
 *     arquivo de esperados), que só um aplicador criado com aceitaRetratosTeste: true aceita (aplicadorDeTeste; o de
 *     staging recusa RETRATOS_DE_TESTE_RECUSADOS). Mesmo contrato do aplicador 107/108;
 *   - dadosLegitimos108: uso legítimo da 108 pelos serviços reais — empresa POR_SALAO com salões A e B, o combinado A+B
 *     (criarSalaoCombinado), uma festa importada (ocupação) e uma revisão operacional aberta que remarca a festa (hold do
 *     destino), tudo commitado;
 *   - AVARIAS_108: adulterações que mantêm os nomes (corpo do marcador, metadado de função, gatilho desligado), cada uma
 *     com o desfazer exato e o motivo esperado da prova única "108 íntegra" (sqlProva108Integra).
 */
type Retrato108 = { ARQUIVO_ESPERADOS: string; sqlRetrato108(o?: { raiz?: string }): string };
export const ENV_RETRATOS_108 = "KIDMAIS_RETRATOS_108_TESTE";

/** O modelo é o 108 (marcador da 108 presente). */
export const modelo108 = async (c: Client) =>
  (await c.query<{ ok: boolean }>("SELECT to_regprocedure('public.kidmais108_instalada()') IS NOT NULL AS ok")).rows[0].ok;

/** Mede o retrato de F2 no estado atual (deve ser o 108 limpo). Devolve o hash e as variáveis do override de teste. */
export async function medirF2(c: Client) {
  const r = carregar<Retrato108>("scripts/migration-108-retrato.cjs");
  await c.query("BEGIN TRANSACTION READ ONLY");
  let linha: { hash_108: string; search_path: string; versao_pg: number };
  try {
    await c.query("SET LOCAL search_path = pg_catalog");
    linha = (await c.query<typeof linha>(r.sqlRetrato108({ raiz: root }))).rows[0];
  } finally { await c.query("ROLLBACK"); }
  assert.match(linha.hash_108, /^[0-9a-f]{64}$/); assert.equal(linha.search_path, "pg_catalog");
  assert.equal(Math.floor(Number(linha.versao_pg) / 10000), 18, "retrato da 108 só no PostgreSQL 18");
  const esperados = JSON.parse(readFileSync(resolve(root, r.ARQUIVO_ESPERADOS), "utf8")) as Record<string, unknown>;
  esperados.F2 = { canonico: linha.hash_108 };
  return { hash: linha.hash_108, env: { [ENV_RETRATOS_108]: JSON.stringify(esperados) } };
}

type Ambiente = { ALVO: unknown; SQL_IDENTIDADE: string; alvo(env: unknown): unknown; identidade(l: unknown, env: unknown): unknown };
/**
 * Aplicador de TESTE com a mesma fábrica e o mesmo ambiente do de staging (trava de alvo e identidade), só com
 * aceitaRetratosTeste: true — o único que aceita KIDMAIS_RETRATOS_108_TESTE. Disco e registro ficam no diretório do teste.
 */
export function aplicadorDeTeste<T>(comum: string, staging: string) {
  const { criarAplicador } = carregar<{ criarAplicador(amb: unknown): T }>(comum);
  const stg = carregar<Ambiente>(staging);
  return criarAplicador({ nome: "teste-postgres", ALVO: stg.ALVO, DIR: "/nao-usado", SQL_IDENTIDADE: stg.SQL_IDENTIDADE, alvo: stg.alvo,
    identidade: (l: unknown, env: unknown) => stg.identidade(l, env), exigirDisco: () => undefined, aceitaRetratosTeste: true });
}

const HORA = { inicio: "10:00", fim: "22:00" };
type Operar = (id: string, acao: Record<string, unknown>, token: string, ctx: unknown, empresa: string) => Promise<unknown>;

/** Dados legítimos da 108 pelos serviços (mesmo caminho das suítes 104/106 e 108): commitados; devolve contagens. */
export async function dadosLegitimos108(a: Client) {
  const nomes = ["CONTRACT_IMPORT_INTEGRATION_ENABLED"] as const;
  const antes = Object.fromEntries(nomes.map((n) => [n, process.env[n]]));
  process.env.CONTRACT_IMPORT_INTEGRATION_ENABLED = "true";
  await a.query("BEGIN");
  const restaurarPool = poolNaTransacao(a);
  const restaurarAmbiente = ambienteAssinatura();
  try {
    const c: Cenario = await cenario(a, 0);
    const nativo = await catalogoNativo(a, c);
    const conteudo = { titulo: "Contrato conferências 108", contratada: { nome: "Buffet Conferências 108 Ltda", documento: "11.222.333/0001-81", endereco: "Rua Teste, 108",
      representante: "Pessoa Teste" }, preambulo: [], clausulas: [{ titulo: "Objeto", texto: "Festa em {{festa.data}} para {{contratante.nome}}." }], observacoes: [],
      cidadeAssinatura: "Cidade Teste" };
    await a.query(`INSERT INTO modelos_contrato_empresa (empresa_id, versao, conteudo, conteudo_sha256, aprovado_por) VALUES ($1::uuid, 1, $2::jsonb, $3, $4::uuid)`,
      [c.empresa, JSON.stringify(conteudo), "c".repeat(64), c.usuario]);
    await a.query(`INSERT INTO agenda_escopo_config (empresa_id, modo, capacidade_tipo, limite_festas_dia, intervalo_minimo_minutos, configurado_por)
                   VALUES ($1::uuid, 'FIXO', 'POR_SALAO', NULL, 0, $2::uuid)`, [c.empresa, c.usuario]);
    const salao = (nome: string, ordem: number) =>
      id(a, `INSERT INTO agenda_saloes (empresa_id, nome, ordem, ativo, capacidade_convidados) VALUES ($1::uuid, $2, $3, true, 60) RETURNING id`, [c.empresa, nome, ordem]);
    const A = await salao("Salão A conferência", 1), B = await salao("Salão B conferência", 2);
    const { criarSalaoCombinado } = carregar<typeof import("../lib/agenda/configuracao-unidade.ts")>("lib/agenda/configuracao-unidade.ts");
    const combinado = await criarSalaoCombinado(executor(a), { empresaId: c.empresa, usuarioId: c.usuario, requestId: randomUUID() } as never,
      { estabelecimentoId: null, nome: "Salão inteiro conferência", capacidadeConvidados: 120, membros: [B, A] });
    // Festa importada (ocupação) e revisão operacional aberta que remarca a festa para outro dia (hold do destino).
    const s = carregar<Servico>("lib/contratos/integracao-importados/servico.ts");
    const { coreNativo } = carregar<typeof import("../lib/contratos/integracao-importados/composicao.ts")>("lib/contratos/integracao-importados/composicao.ts");
    const adm = carregar<typeof import("../lib/contratos/services/administrativo.service.ts")>("lib/contratos/services/administrativo.service.ts");
    const rs = carregar<typeof import("../lib/fechamentos/services/revisao-operacional.service.ts")>("lib/fechamentos/services/revisao-operacional.service.ts");
    const operar = adm.operarContrato as unknown as Operar;
    const ev = { data: dia(120), ...HORA };
    const imp = await importacao(a, c, ev);
    await completarCliente(a, imp.cliente);
    const r = await integrar(s, coreNativo, a, c, imp.id, await comSalaoEscolhido(s, a, c, imp.id, decisoes(c, ev, PARCIAL())));
    await validarAgora(a);
    const festa = (await a.query<{ id: string; cfg: string }>(
      `SELECT f.id::text, f.configuracao_agenda_id::text cfg FROM contratos k JOIN fechamentos f ON f.id = k.fechamento_id WHERE k.id = $1`, [r.contratoId])).rows[0];
    if (festa.cfg !== nativo.turno) await catalogoNoTurno(a, c, festa.cfg);
    const ctxOp = () => ({ requestId: randomUUID(), ip: null, userAgent: "conferencias-108" });
    const vigente = (await a.query<{ v: string }>(`SELECT versao_vigente_id::text v FROM contrato_fluxos WHERE contrato_id = $1`, [r.contratoId])).rows[0].v;
    await operar(vigente, { acao: "nova_versao", tipo: "NOVA_VERSAO", motivo: "Remarcação", chaveCriacao: randomUUID() }, c.token, ctxOp(), c.empresa);
    const v2 = (await a.query<{ id: string }>(`SELECT versao_em_preparacao_id::text id FROM contrato_fluxos WHERE contrato_id = $1`, [r.contratoId])).rows[0].id;
    const revisao = (await a.query<{ revisao: number }>(`SELECT revisao FROM contrato_edicoes WHERE contrato_versao_id = $1`, [v2])).rows[0].revisao;
    const fonte = (await rs.fontesPreparacao(v2, executor(a)))!;
    await operar(v2, { acao: "editar_festa", revisao, motivo: "Remarcação", fonteHash: fonte.fonteHash, pacoteId: c.pacote, convidados: 50,
      dataEvento: dia(121), configuracaoAgendaId: festa.cfg, horarioInicio: HORA.inicio, horarioFim: HORA.fim, adicionais: fonte.adicionais,
      idadeAniversarianteEvento: 6, temaFesta: "Remarcação", buffetStatus: "PENDENTE", buffetSalgados: "", buffetBebidas: "", buffetDoces: "", buffetBolo: "",
      buffetOutros: "", observacoesEquipe: "conferências 108" }, c.token, ctxOp(), c.empresa);
    await validarAgora(a);
    await a.query("COMMIT");
    const n = (await a.query<{ combinados: number; ocupacoes: number; holds: number }>(`SELECT
      (SELECT count(*)::int FROM agenda_saloes WHERE combinado AND id = $1::uuid) AS combinados,
      (SELECT count(*)::int FROM kidmais094_ocupacoes(CURRENT_DATE, 'infinity'::date) WHERE fechamento_id = $2::uuid) AS ocupacoes,
      (SELECT count(*)::int FROM fechamento_revisoes WHERE fechamento_id = $2::uuid AND data_evento IS DISTINCT FROM $3::date) AS holds`,
      [combinado.id, festa.id, ev.data])).rows[0];
    assert.equal(n.combinados, 1, "combinado legítimo"); assert.ok(n.ocupacoes >= 1, "festa ocupa a agenda (o destino em hold, quando reservado, também): " + JSON.stringify(n));
    assert.ok(n.holds >= 1, "revisão aberta com outro dia (hold)");
    return { empresa: c.empresa, combinado: combinado.id, festa: festa.id, ...n };
  } catch (error) { await a.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { restaurarAmbiente(); restaurarPool(); for (const k of nomes) { if (antes[k] === undefined) delete process.env[k]; else process.env[k] = antes[k]; } }
}

/** Adulterações da 108 que mantêm os nomes; `motivo` é o da prova única (sqlProva108Integra). */
export const AVARIAS_108: readonly { nome: string; aplicar: string; desfazer: string; motivo: RegExp }[] = Object.freeze([
  { nome: "corpo do marcador",
    aplicar: "CREATE OR REPLACE FUNCTION public.kidmais108_instalada() RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public, pg_catalog AS $$ SELECT true AND true $$",
    desfazer: "CREATE OR REPLACE FUNCTION public.kidmais108_instalada() RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public, pg_catalog AS $$ SELECT true $$",
    motivo: /MARCADOR_108/ },
  { nome: "metadado de função (volatilidade)", aplicar: "ALTER FUNCTION public.kidmais098_hoje() STABLE", desfazer: "ALTER FUNCTION public.kidmais098_hoje() VOLATILE",
    motivo: /METADADOS kidmais098_hoje\(\)/ },
  { nome: "metadado de função (SECURITY DEFINER)", aplicar: "ALTER FUNCTION public.kidmais108_instalada() SECURITY DEFINER",
    desfazer: "ALTER FUNCTION public.kidmais108_instalada() SECURITY INVOKER", motivo: /METADADOS kidmais108_instalada\(\)/ },
  { nome: "gatilho da 108 desligado", aplicar: "ALTER TABLE agenda_saloes DISABLE TRIGGER agenda_saloes_098_guarda_trg",
    desfazer: "ALTER TABLE agenda_saloes ENABLE TRIGGER agenda_saloes_098_guarda_trg", motivo: /GATILHOS_098/ },
  // Só o retrato F2 pega (a lista de metadados não confere PARALLEL): prova que a condição RETRATO_F2 está ativa.
  { nome: "retrato F2 (função PARALLEL SAFE)", aplicar: "ALTER FUNCTION public.kidmais098_hoje() PARALLEL SAFE",
    desfazer: "ALTER FUNCTION public.kidmais098_hoje() PARALLEL UNSAFE", motivo: /RETRATO_F2/ },
  // P2-1 da revisão da E4: literal com "public." dentro (o retrato antigo removia o prefixo e não via a diferença).
  { nome: "retrato F2 (literal do default com public.)",
    aplicar: "ALTER TABLE fechamento_revisoes ALTER COLUMN estado SET DEFAULT 'public.EM_ELABORACAO'",
    desfazer: "ALTER TABLE fechamento_revisoes ALTER COLUMN estado SET DEFAULT 'EM_ELABORACAO'", motivo: /RETRATO_F2/ },
  // P2-2 da revisão da E4: registro da 107 adulterado SEM DDL (definição diferente da que a 107 grava); o retrato não vê
  // linhas, só a integridade da 107 dentro da prova única.
  { nome: "registro da 107 (definição adulterada)",
    aplicar: "INSERT INTO kidmais107_reparos (ordem, acao, tabela, nome_anterior, nome_novo, definicao) VALUES (1, 'RENOMEAR_INDICE', "
      + "'bloqueios_agenda', 'ix_bloqueios_agenda_data_ativos', 'bloqueios_agenda_data_ativos_idx', 'USING btree (data) WHERE (ativo = false)')",
    desfazer: "DELETE FROM kidmais107_reparos WHERE ordem = 1 AND definicao = 'USING btree (data) WHERE (ativo = false)'",
    motivo: /INTEGRIDADE_107 registro ordem 1 \(bloqueios_agenda_data_ativos_idx\)/ },
]);

/** Instrução de escrita no início de um comando (comentários removidos): DDL ou DML. */
export const ESCRITA = /(^|;)\s*(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE|GRANT|REVOKE|COMMENT|SET\s+ROLE)\b/i;
export const escritasEm = (registro: string[]) =>
  registro.map((sql) => sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "")).filter((sql) => ESCRITA.test(sql));
