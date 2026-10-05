import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { conectarDescartavel, semTransacaoExplicita } from "../../comercial/postgres-descartavel.ts";
import { carregarAtendimento, cod } from "./harness-postgres.ts";

/**
 * Coexistência das migrations 060 (atendimento), 063 (painel), 064 (mensagens prontas) e 065 (nome de perfil) no
 * PostgreSQL descartável (modelo "063" da árvore mesclada: 055…063, com a 060). Só pelo check:v1:postgres, com opt-in
 * e autorização explícita do Felipe. Dados sintéticos; nenhuma rede.
 *
 *  K1 painel primeiro: 063 (+060) → 064 → 065; os quatro postchecks oficiais passam;
 *  K2 atendimento primeiro: a 063 sai (banco sem uso do painel) e volta com 060/064/065 presentes — precheck,
 *     migration e postcheck da 063 ok; 060/064/065 intactas enquanto ela esteve fora;
 *  K4 dados dos dois lados (conversa com nome de perfil, mensagem pronta, sessão com empresa ativa): postchecks ok;
 *  K3 rollback cruzado: 065 e 064 saem (com descarte explícito) sem tocar a 063 nem a sessão com empresa ativa;
 *     voltam com postcheck; a 063 com uso recusa o próprio rollback (preserva os dados do painel).
 */
const ler = (f: string) => readFileSync(f, "utf8");
const POST060 = ler("database/checks/20261001_060_postcheck.sql");
const PRE063 = ler("database/checks/20261004_063_precheck.sql");
const UP063 = ler("database/migrations/20261004_063_painel_desenvolvedor.sql");
const POST063 = ler("database/checks/20261004_063_postcheck.sql");
const DOWN063 = ler("database/rollback/20261004_063_painel_desenvolvedor_down.sql");
const UP064 = ler("database/migrations/20261004_064_whatsapp_mensagens_prontas.sql");
const POST064 = ler("database/checks/20261004_064_postcheck.sql");
const DOWN064 = ler("database/rollback/20261004_064_whatsapp_mensagens_prontas_down.sql");
const POS_DOWN064 = ler("database/checks/20261004_064_rollback_postcheck.sql");
const UP065 = ler("database/migrations/20261004_065_whatsapp_nome_perfil.sql");
const POST065 = ler("database/checks/20261004_065_postcheck.sql");
const DOWN065 = ler("database/rollback/20261004_065_whatsapp_nome_perfil_down.sql");
const POS_DOWN065 = ler("database/checks/20261004_065_rollback_postcheck.sql");
const SENHA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;

test("coexistência 060/063/064/065: as duas ordens, dados dos dois lados e rollback cruzado", { timeout: 300_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  const c = await conectarDescartavel();
  const quatro = async (rotulo: string) => { for (const [n, sql] of [["060", POST060], ["063", POST063], ["064", POST064], ["065", POST065]] as const) await assert.doesNotReject(c.query(sql), `${rotulo}: postcheck ${n}`); };
  try {
    // K1 — painel primeiro.
    await c.query(POST060); await c.query(POST063);
    await c.query(UP064); await c.query(POST064);
    await c.query(UP065); await c.query(POST065);
    await quatro("K1");

    // K2 — atendimento primeiro: a 063 sai (sem uso) e volta com 060/064/065 presentes.
    await c.query(DOWN063);
    assert.equal((await c.query("SELECT to_regclass('public.convites_acesso') AS t")).rows[0].t, null, "K2: 063 fora");
    await c.query(POST060); await c.query(POST064); await c.query(POST065);
    await c.query(PRE063); await c.query(UP063); await c.query(POST063);
    await quatro("K2");

    // K4 — dados dos dois lados.
    const id = async (sql: string, v: unknown[]) => (await c.query<{ id: string }>(sql, v)).rows[0].id;
    const A = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Empresa sintética (coexistência)', 'PROVISIONAMENTO') RETURNING id`, [cod("cx")]);
    await c.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [A]);
    const u = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness coexistência', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id`, [`${cod("u")}@example.test`, SENHA]);
    const m = await id(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO') RETURNING id`, [A, u]);
    await c.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
    const s = await id(`INSERT INTO sessoes_administrativas (usuario_id, token_hash, csrf_hash, autenticado_em, ultima_atividade_em, expira_em, empresa_ativa_id)
      VALUES ($1::uuid, $2, $3, clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '1 hour', $4::uuid) RETURNING id`, [u, randomBytes(32).toString("hex"), randomBytes(32).toString("hex"), A]);
    const sessao = { usuario_id: u, papel: "REPRESENTANTE_AUTORIZADO", id: s, empresa_ativa_id: A };
    const { servico } = carregarAtendimento(A);
    await servico.salvarConfiguracao(sessao as never, { ativo: false, nome: "Empresa sintética", perguntas: [] });
    await servico.receberEntrada({ id: cod("evt-"), app: "KidmaisManager", source: "5561900000401", texto: "Olá", timestamp: Date.now() - 60_000, nomePerfil: "Perfil coexistência" });
    await c.query(`INSERT INTO whatsapp_atendimento_mensagens_prontas (empresa_id, ambiente, titulo, categoria, tipo, texto, criada_por, atualizada_por) VALUES ($1, 'staging', 'Coexistência', 'Teste', 'TEXTO', 'texto', $2, $2)`, [A, u]);
    const linha = (await servico.listarAtendimento(sessao as never)).conversas.find((x) => x.contato === "5561900000401")!;
    assert.equal(linha.nome_perfil, "Perfil coexistência", "K4: tela com a empresa ativa = piloto e nome de perfil");
    await quatro("K4");

    // K3 — rollback cruzado de 065 e 064, com descarte explícito; 063 e a sessão com empresa ativa intactas.
    await c.query(DOWN065.replace("SET LOCAL statement_timeout = '60s';", "SET LOCAL statement_timeout = '60s';\nSET LOCAL kidmais.rollback_065_descartar_nomes = 'sim';"));
    await c.query(POS_DOWN065);
    await c.query("BEGIN"); await c.query("SET LOCAL kidmais.rollback_064_descartar_prontas = 'sim'");
    await c.query(semTransacaoExplicita(DOWN064)); await c.query("COMMIT");
    await c.query(POS_DOWN064);
    await c.query(POST060); await c.query(POST063);
    assert.equal((await c.query("SELECT empresa_ativa_id::text AS e FROM sessoes_administrativas WHERE id = $1::uuid", [s])).rows[0].e, A, "K3: sessão com empresa ativa intacta");
    assert.equal((await servico.listarAtendimento(sessao as never)).conversas.length, 1, "K3: tela segue sem a 064/065 (sem cache)");
    await c.query(UP064); await c.query(POST064); await c.query(UP065); await c.query(POST065);
    await quatro("K3 reaplicadas");

    // A 063 em uso recusa o próprio rollback: os dados do painel ficam.
    await assert.rejects(c.query(DOWN063), /Rollback 063/); await c.query("ROLLBACK").catch(() => {});
    await quatro("fim");
    assert.equal(Number((await c.query("SELECT count(*) AS n FROM whatsapp_atendimento_mensagens WHERE direcao='SAIDA'")).rows[0].n), 0, "nenhuma saída");
  } finally {
    await c.end();
  }
});
