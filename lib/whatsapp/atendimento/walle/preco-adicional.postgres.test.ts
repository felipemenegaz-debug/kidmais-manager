import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { conectarDescartavel } from "../../../comercial/postgres-descartavel.ts";
import { criarPacoteAdmin } from "../../../comercial/pacotes-admin.ts";
import { salvarPacoteComercial } from "../../../comercial/pacote-comercial.ts";
import { gravarPrecoAdicional, lerPrecosCorrentes, publicarTabelaSucessora, substituirPrecosAdicionalNaTabela } from "../../../comercial/pacote-precos.ts";
import type { DbExecutor } from "../../../db/contracts.ts";
import { cod } from "../harness-postgres.ts";
import { entenderPorRegras } from "./entendimento.ts";
import { catalogosWallE, fontesPostgres } from "./fontes-postgres.ts";
import { resolverWallE } from "./resolver.ts";

/**
 * Teste manual de 12/10/2026 ("A decoração está inclusa? Quanto custa uma segunda mesa temática?"): o Wall-e lê a
 * modalidade (pacote_adicionais) e o preço do adicional na tabela VIGENTE (precos_adicional), pelos mesmos serviços da
 * tela de preços. Esta suíte prova, no schema integrado (modelo "082"):
 *
 *  A1 a composição traz o id do adicional incluso (mesa principal) e do adicional à parte (segunda mesa);
 *  A2 valor único: o da tabela vigente; trocado o valor, a leitura segue a nova tabela publicada;
 *  A3 faixas por número de convidados: sem o número, PRECISA_CONVIDADOS; com ele, a faixa certa;
 *  A4 adicional sem preço cadastrado: SEM_PRECO (nada é suposto);
 *  A5 o adicional de outra empresa não tem preço pelas fontes desta (isolamento);
 *  A6 conversa pelo resolver: sem pacote escolhido, decoração inclusa em todos e o valor da segunda mesa, com a fonte da
 *     tabela vigente; nenhuma passagem à equipe.
 *
 * PostgreSQL descartável, só pelo check:v1:postgres com opt-in. Dados sintéticos; nenhuma rede, nenhum modelo.
 */
const SENHA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;
const hoje = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }).format(new Date());
const CONFIG = { ativo: true, nome: "Buffet sintético", perguntas: [], limites: { respostasPor24h: 20 } } as never;

test("Wall-e: modalidade e preço do adicional de decoração pela tabela vigente", { timeout: 300_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  const c = await conectarDescartavel();
  const ex = c as unknown as DbExecutor;
  try {
    const id = async (sql: string, v: unknown[]) => (await c.query<{ id: string }>(sql, v)).rows[0].id;
    const emTx = async <T>(f: () => Promise<T>) => {
      await c.query("BEGIN");
      try { const r = await f(); await c.query("COMMIT"); return r; } catch (erro) { await c.query("ROLLBACK"); throw erro; }
    };
    async function empresa(nome: string) {
      const e = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id`, [cod("pa"), nome]);
      await c.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [e]);
      const u = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness adicional', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id`, [`${cod("u")}@example.test`, SENHA]);
      const m = await id(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO') RETURNING id`, [e, u]);
      await c.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
      return { empresa: e, usuario: u, ctx: () => ({ empresaId: e, usuarioId: u, requestId: randomUUID(), motivo: "Criação administrativa" }) };
    }
    const turnos = (await c.query<{ id: string }>("SELECT id FROM configuracao_agenda WHERE ativo ORDER BY horario_inicio_padrao")).rows;
    const catDecoracao = (await c.query<{ id: string }>("SELECT id FROM adicional_categorias WHERE codigo = 'DECORACAO'")).rows[0]?.id;
    assert.ok(catDecoracao, "categoria de adicional DECORACAO no modelo");
    async function pacote(dono: Awaited<ReturnType<typeof empresa>>, codigo: string, nome: string) {
      const cat = await id(`INSERT INTO buffet_categorias (empresa_id, codigo, nome, ordem_exibicao, ativo) VALUES ($1::uuid, $2, 'Salgados', 1, true) RETURNING id`, [dono.empresa, cod("CAT_")]);
      await c.query(`INSERT INTO buffet_itens (empresa_id, categoria_id, codigo, nome, ordem_exibicao, ativo) VALUES ($1::uuid, $2::uuid, $3, 'Coxinha', 1, true)`, [dono.empresa, cat, cod("IT_")]);
      return emTx(async () => {
        const dados = { nome, descricao: null, duracaoMinutos: 240, convidadosMinimos: 30, convidadosMaximos: 100 };
        const criado = await criarPacoteAdmin(ex, { empresaId: dono.empresa, codigo, ...dados }, dono.ctx());
        const salvo = await salvarPacoteComercial(ex, { id: criado.id, ...dados,
          disponibilidade: [1, 2, 3, 4, 5, 6, 7].flatMap((dia) => turnos.map((x) => ({ dia, horarioId: x.id }))),
          faixas: [{ convidadosMin: 30, convidadosMax: 100, valor: "5200.00" }], categorias: [{ categoriaId: cat, escolhas: 1 }] }, dono.ctx());
        return salvo.pacote.id as string;
      });
    }
    const adicional = (dono: { empresa: string }, nome: string, unidade = "PACOTE") =>
      id(`INSERT INTO adicionais (empresa_id, codigo, nome, categoria, categoria_id, unidade_cobranca, ordem_exibicao) VALUES ($1::uuid, $2, $3, 'DECORACAO', $4::uuid, $5, 1) RETURNING id`, [dono.empresa, cod("AD_"), nome, catDecoracao, unidade]);
    const vincular = (pacoteId: string, adicionalId: string, modalidade: string) => c.query(`INSERT INTO pacote_adicionais (pacote_id, adicional_id, modalidade) VALUES ($1::uuid, $2::uuid, $3)`, [pacoteId, adicionalId, modalidade]);

    const A = await empresa("Buffet sintético A (adicional)");
    const B = await empresa("Buffet sintético B (adicional)");
    const pacotesA = [await pacote(A, "ESSENCIAL", "Essencial"), await pacote(A, "COMPLETA", "Completa")];
    const pacoteB = await pacote(B, "ESSENCIAL", "Essencial");
    const mesa = await adicional(A, "Mesa temática");
    const mesa2 = await adicional(A, "Segunda mesa temática");
    const painel = await adicional(A, "Painel extra", "UNIDADE");
    const semPreco = await adicional(A, "Totem extra");
    for (const p of pacotesA) { await vincular(p, mesa, "INCLUSO"); await vincular(p, mesa2, "EXTRA"); await vincular(p, painel, "EXTRA"); await vincular(p, semPreco, "EXTRA"); }
    const deB = await adicional(B, "Segunda mesa temática");
    await vincular(pacoteB, deB, "EXTRA");
    await emTx(() => gravarPrecoAdicional(ex, A.empresa, mesa2, "450.00", A.ctx()));
    await emTx(() => publicarTabelaSucessora(ex, A.empresa, A.ctx(), async (tabelaId) => {
      await substituirPrecosAdicionalNaTabela(ex, tabelaId, painel, [{ min: 1, max: 50, valor: 300 }, { min: 51, max: null, valor: 520 }]);
      return { adicionalId: painel };
    }));
    await emTx(() => gravarPrecoAdicional(ex, B.empresa, deB, "999.00", B.ctx()));
    const vigente = async (e: string) => (await lerPrecosCorrentes(ex, e)).tabelaId;
    const fA = fontesPostgres(ex, { empresaId: A.empresa, ambiente: "staging", hoje, linkContratoProprio: async () => null });

    // A1
    const comp = await fA.composicao("ESSENCIAL");
    assert.ok(comp);
    assert.deepEqual(comp.inclusos.map((i) => [i.id, i.nome]), [[mesa, "Mesa temática"]], "A1: incluso com id");
    assert.deepEqual(comp.extras.map((i) => i.id).sort(), [mesa2, painel, semPreco].sort(), "A1: adicionais com id");
    // A2
    const tabela1 = await vigente(A.empresa);
    assert.deepEqual(await fA.precoAdicional!(mesa2, null), { valor: 450, unidade: "PACOTE", faixa: null, tabela: tabela1 }, "A2: valor único da tabela vigente");
    await emTx(() => gravarPrecoAdicional(ex, A.empresa, mesa2, "480.00", A.ctx()));
    const tabela2 = await vigente(A.empresa);
    assert.notEqual(tabela2, tabela1, "A2: nova tabela publicada");
    assert.deepEqual(await fA.precoAdicional!(mesa2, 50), { valor: 480, unidade: "PACOTE", faixa: null, tabela: tabela2 }, "A2: a leitura segue a tabela vigente");
    // A3
    assert.deepEqual(await fA.precoAdicional!(painel, null), { erro: "PRECISA_CONVIDADOS" }, "A3: faixa depende do número");
    assert.deepEqual(await fA.precoAdicional!(painel, 40), { valor: 300, unidade: "UNIDADE", faixa: { min: 1, max: 50 }, tabela: tabela2 }, "A3: 40 convidados");
    assert.deepEqual(await fA.precoAdicional!(painel, 80), { valor: 520, unidade: "UNIDADE", faixa: { min: 51, max: null }, tabela: tabela2 }, "A3: 80 convidados");
    // A4
    assert.deepEqual(await fA.precoAdicional!(semPreco, 50), { erro: "SEM_PRECO" }, "A4: sem preço cadastrado");
    // A5
    assert.deepEqual(await fA.precoAdicional!(deB, 50), { erro: "SEM_PRECO" }, "A5: adicional de outra empresa");
    assert.equal((await fontesPostgres(ex, { empresaId: B.empresa, ambiente: "staging", hoje, linkContratoProprio: async () => null }).precoAdicional!(deB, null) as { valor: number }).valor, 999, "A5: B lê o próprio");
    // A6
    const catalogos = await catalogosWallE(ex, A.empresa, CONFIG, hoje);
    const texto = "A decoração está inclusa? Quanto custa uma segunda mesa temática?";
    const contexto = { convidados: 50, apresentado: true };
    const r = await resolverWallE({ texto, entendimento: entenderPorRegras(texto, catalogos, contexto), contexto, config: CONFIG, catalogos, agora: `${hoje}T12:00:00.000Z` }, fA);
    const saida = r.saidas.map((s) => s.texto ?? "").join("\n");
    assert.match(saida, /Em todos os pacotes, a decoração inclui Mesa temática\./, "A6: inclusa em todos");
    assert.match(saida, /“Segunda mesa temática” é adicional: R\$\s?480,00 pela tabela de preços vigente\./, "A6: valor da tabela vigente");
    assert.doesNotMatch(saida, /Não tenho cadastrado/);
    assert.equal(r.passagem, null, "A6: nada vai à equipe");
    const fontes = r.saidas.flatMap((s) => s.fontes);
    assert.ok(fontes.some((f) => f.tipo === "PRECO_ADICIONAL" && f.id === mesa2 && f.tabela === tabela2), "A6: fonte da tabela vigente");
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    await c.end();
  }
});
