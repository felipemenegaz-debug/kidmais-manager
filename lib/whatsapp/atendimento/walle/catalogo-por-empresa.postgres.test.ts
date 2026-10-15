import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { conectarDescartavel } from "../../../comercial/postgres-descartavel.ts";
import { criarPacoteAdmin } from "../../../comercial/pacotes-admin.ts";
import { salvarPacoteComercial } from "../../../comercial/pacote-comercial.ts";
import type { DbExecutor } from "../../../db/contracts.ts";
import { cod } from "../harness-postgres.ts";
import { catalogosWallE, fontesPostgres } from "./fontes-postgres.ts";

/**
 * Integração com o staging b5a6a86 (11/10/2026): a 078 do staging deu a cada empresa o próprio catálogo do buffet
 * (buffet_categorias/buffet_itens com empresa_id). O Wall-e lê o buffet pelo pacote da empresa (fontes-postgres.ts), sem
 * filtro direto por empresa no catálogo. Esta suíte prova, no schema integrado (modelo "082": 078 + atendimento), que:
 *
 *  K1 duas empresas com o MESMO código de pacote e categorias/itens próprios: catalogosWallE e a composição de cada uma
 *     só trazem os itens dela (nem os da outra, nem os do catálogo legado da Kidmais);
 *  K2 o serviço comercial recusa ligar ao pacote de A uma categoria do catálogo de B (e o gatilho da 078 também, por SQL
 *     direto), então o caminho do Wall-e não alcança o catálogo de outra empresa;
 *  K3 item inativo ou categoria inativa da própria empresa não aparece.
 *
 * PostgreSQL descartável, só pelo check:v1:postgres com opt-in. Dados sintéticos; nenhuma rede, nenhum modelo.
 */
const SENHA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;
const hoje = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }).format(new Date());
const CONFIG = { perguntas: [] } as never;

test("Wall-e no catálogo por empresa (078 do staging): cada empresa só vê o próprio buffet", { timeout: 300_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  const c = await conectarDescartavel();
  const ex = c as unknown as DbExecutor;
  try {
    const porEmpresa = (await c.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND table_name='buffet_categorias' AND column_name='empresa_id'")).rows[0].n;
    assert.equal(porEmpresa, 1, "modelo com a 078 (catálogo por empresa)");
    assert.ok((await c.query("SELECT to_regclass('public.whatsapp_atendimento_arquivos') IS NOT NULL AS e")).rows[0].e, "modelo com o atendimento (082)");
    const id = async (sql: string, v: unknown[]) => (await c.query<{ id: string }>(sql, v)).rows[0].id;
    async function empresa(nome: string) {
      const e = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id`, [cod("ce"), nome]);
      await c.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [e]);
      const u = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness catálogo', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id`, [`${cod("u")}@example.test`, SENHA]);
      const m = await id(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO') RETURNING id`, [e, u]);
      await c.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
      return { empresa: e, usuario: u };
    }
    async function catalogo(empresaId: string, prefixo: string) {
      const cat = await id(`INSERT INTO buffet_categorias (empresa_id, codigo, nome, ordem_exibicao, ativo) VALUES ($1::uuid, $2, $3, 1, true) RETURNING id`, [empresaId, cod("CAT_"), `Salgados ${prefixo}`]);
      const inativa = await id(`INSERT INTO buffet_categorias (empresa_id, codigo, nome, ordem_exibicao, ativo) VALUES ($1::uuid, $2, $3, 2, false) RETURNING id`, [empresaId, cod("CAT_"), `Inativa ${prefixo}`]);
      for (const [nome, ativo, categoria] of [[`Coxinha ${prefixo}`, true, cat], [`Kibe ${prefixo}`, true, cat], [`Item inativo ${prefixo}`, false, cat], [`Item da inativa ${prefixo}`, true, inativa]] as const) {
        await c.query(`INSERT INTO buffet_itens (empresa_id, categoria_id, codigo, nome, ordem_exibicao, ativo) VALUES ($1::uuid, $2::uuid, $3, $4, 1, $5)`, [empresaId, categoria, cod("IT_"), nome, ativo]);
      }
      return { cat, inativa };
    }
    const A = await empresa("Buffet sintético A (catálogo)");
    const B = await empresa("Buffet sintético B (catálogo)");
    const catA = await catalogo(A.empresa, "A");
    const catB = await catalogo(B.empresa, "B");
    const turnos = (await c.query<{ id: string }>("SELECT id FROM configuracao_agenda WHERE ativo ORDER BY horario_inicio_padrao")).rows;
    const legado = (await c.query<{ nome: string }>("SELECT i.nome FROM buffet_itens i JOIN empresas e ON e.id = i.empresa_id WHERE e.codigo = 'kidmais' AND i.ativo LIMIT 50")).rows.map((x) => x.nome);

    async function pacote(dono: { empresa: string; usuario: string }, categorias: string[]) {
      const ctx = { empresaId: dono.empresa, usuarioId: dono.usuario, requestId: randomUUID(), motivo: "Criação administrativa" };
      await c.query("BEGIN");
      try {
        const criado = await criarPacoteAdmin(ex, { empresaId: dono.empresa, codigo: "ESSENCIAL", nome: "Essencial", descricao: null, duracaoMinutos: 240, convidadosMinimos: 30, convidadosMaximos: 60 }, ctx);
        await salvarPacoteComercial(ex, { id: criado.id, nome: "Essencial", descricao: null, duracaoMinutos: 240, convidadosMinimos: 30, convidadosMaximos: 60,
          disponibilidade: [1, 2, 3, 4, 5, 6, 7].flatMap((dia) => turnos.map((x) => ({ dia, horarioId: x.id }))),
          faixas: [{ convidadosMin: 30, convidadosMax: 60, valor: "5200.00" }], categorias: categorias.map((x) => ({ categoriaId: x, escolhas: 2 })) }, ctx);
        await c.query("COMMIT");
      } catch (erro) {
        await c.query("ROLLBACK");
        throw erro;
      }
    }

    // K2 — categoria de B no pacote de A: o serviço recusa; o gatilho da 078 recusa por SQL direto.
    await assert.rejects(pacote(A, [catB.cat]), /categorias do buffet/i, "K2: serviço recusa categoria de outra empresa");
    await pacote(A, [catA.cat, catA.inativa]);
    await pacote(B, [catB.cat]);
    const pacoteA = (await c.query<{ id: string }>("SELECT id FROM pacotes WHERE empresa_id = $1::uuid AND codigo = 'ESSENCIAL' AND arquivado_em IS NULL ORDER BY criado_em DESC LIMIT 1", [A.empresa])).rows[0].id;
    // Fora de transação: a recusa do gatilho não deixa nada para trás.
    await assert.rejects(c.query("INSERT INTO pacote_buffet_categorias (pacote_id, categoria_id, modo_itens, escolhas_min, escolhas_max, ativo) VALUES ($1::uuid, $2::uuid, 'TODOS_ATIVOS', 0, 1, true)", [pacoteA, catB.cat]), "K2: gatilho da 078 recusa por SQL direto");
    assert.equal((await c.query("SELECT count(*)::int AS n FROM pacote_buffet_categorias WHERE pacote_id = $1::uuid AND categoria_id = $2::uuid", [pacoteA, catB.cat])).rows[0].n, 0, "K2: nada gravado");

    // K1/K3 — o Wall-e de cada empresa só vê o próprio buffet.
    for (const [dono, eu, outro] of [[A, "A", "B"], [B, "B", "A"]] as const) {
      const cats = await catalogosWallE(ex, dono.empresa, CONFIG, hoje);
      assert.deepEqual(cats.pacotes.map((p) => p.codigo), ["ESSENCIAL"], `K1 ${eu}: um pacote`);
      assert.deepEqual([...(cats.itensBuffet ?? [])].sort(), [`Coxinha ${eu}`, `Kibe ${eu}`], `K1/K3 ${eu}: só os itens ativos da própria empresa`);
      assert.ok(!(cats.itensBuffet ?? []).some((x) => x.endsWith(` ${outro}`) || legado.includes(x)), `K1 ${eu}: nada de ${outro} nem do legado da Kidmais`);
      const comp = await fontesPostgres(ex, { empresaId: dono.empresa, ambiente: "staging", hoje, linkContratoProprio: async () => null }).composicao("ESSENCIAL");
      assert.ok(comp, `K1 ${eu}: composição`);
      assert.deepEqual(comp.categorias.map((x) => x.nome), [`Salgados ${eu}`], `K3 ${eu}: categoria inativa fora`);
      assert.deepEqual([...comp.categorias[0].itens].sort(), [`Coxinha ${eu}`, `Kibe ${eu}`], `K1 ${eu}: itens da composição`);
    }
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    await c.end();
  }
});
