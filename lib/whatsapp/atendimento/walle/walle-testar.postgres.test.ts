import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { carregarComponente } from "../../../../components/admin/teste-componente.ts";
import { conectarDescartavel } from "../../../comercial/postgres-descartavel.ts";
import { criarPacoteAdmin } from "../../../comercial/pacotes-admin.ts";
import { salvarPacoteComercial } from "../../../comercial/pacote-comercial.ts";
import type { DbExecutor } from "../../../db/contracts.ts";
import { carregarAtendimento, cod, db, withTransaction } from "../harness-postgres.ts";
import * as core from "../core.ts";
import * as motivoFalha from "../motivo-falha.ts";
import * as multiempresa from "../multiempresa.ts";
import * as prontasLink from "../prontas-link.ts";
import * as contexto from "./contexto.ts";
import * as entendimento from "./entendimento.ts";
import * as fontes from "./fontes-postgres.ts";
import * as linkDisponibilidade from "./link-disponibilidade.ts";
import * as resolver from "./resolver.ts";
import * as tipos from "./tipos.ts";

/**
 * Fatia 10a ("Testar o Wall-e") no PostgreSQL descartável (só pelo check:v1:postgres, com opt-in). Dados sintéticos;
 * porta REAL do Wall-e em modo sem efeito, com fontes reais (pacotes e preços pelos serviços do domínio, agenda,
 * biblioteca, respostas aprovadas); testarWallE com o serviço REAL de autorização e configuração. Nenhuma rede.
 *
 *  T1 o banco inteiro fica igual: assinatura (md5) de TODAS as tabelas do schema public antes e depois de vários testes
 *     (preço + agenda, resposta aprovada, material da biblioteca, pedido de atendente, PARAR, entendimento pelo modelo);
 *     nenhuma conversa, mensagem, contato, oportunidade ou aviso criado;
 *  T2 a transação de leitura do modo sem efeito recusa escrita (o banco garante, não só o código);
 *  T3 as respostas vêm das fontes da empresa, com o rótulo da fonte; PARAR bloqueia antes do Wall-e;
 *  T4 quem não tem acesso ao Atendimento (outra empresa sem vínculo) é recusado antes de qualquer leitura.
 */
const ler = (f: string) => readFileSync(f, "utf8");
const MIGRATIONS = [
  ["database/migrations/20261001_060_whatsapp_atendimento.sql", "database/checks/20261001_060_postcheck.sql"],
  ["database/migrations/20261011_080_whatsapp_mensagens_prontas.sql", "database/checks/20261011_080_postcheck.sql"],
  ["database/migrations/20261011_081_whatsapp_prontas_midia.sql", "database/checks/20261011_081_postcheck.sql"],
  ["database/migrations/20261011_082_wall_e_atendimento.sql", "database/checks/20261011_082_postcheck.sql"],
].map(([up, post]) => [ler(up), ler(post)]);
const SENHA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;
const PDF = Buffer.from("%PDF-1.4\n% tabela de preços sintética\n%%EOF\n");
const somarDias = (iso: string, d: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + d * 86400000).toISOString().slice(0, 10);
const hoje = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }).format(new Date());
const dataBr = (iso: string) => iso.split("-").reverse().join("/");

test("Testar o Wall-e: mesma porta, fontes reais, zero escrita no banco", { timeout: 300_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  const c = await conectarDescartavel();
  const ex = c as unknown as DbExecutor;
  try {
    for (const [up, post] of MIGRATIONS) { await c.query(up); await c.query(post); }
    const id = async (sql: string, v: unknown[]) => (await c.query<{ id: string }>(sql, v)).rows[0].id;
    async function empresaComRepresentante(nome: string) {
      const e = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id`, [cod("wt"), nome]);
      await c.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [e]);
      const u = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness Testar Wall-e', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id`, [`${cod("u")}@example.test`, SENHA]);
      const m = await id(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO') RETURNING id`, [e, u]);
      await c.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
      return { empresa: e, usuario: u, sessao: { usuario_id: u, papel: "REPRESENTANTE_AUTORIZADO" } as never };
    }
    const A = await empresaComRepresentante("Buffet sintético Testar");
    const { servico, biblioteca } = carregarAtendimento(A.empresa);

    // Fontes reais da empresa A: pacotes com tabela publicada, agenda com data bloqueada, PDF autorizado e uma FAQ.
    const turnos = (await c.query<{ id: string }>("SELECT id FROM configuracao_agenda WHERE ativo ORDER BY horario_inicio_padrao")).rows;
    const categorias = (await c.query<{ id: string }>("SELECT id FROM buffet_categorias WHERE ativo ORDER BY ordem_exibicao LIMIT 2")).rows;
    const ctx = { empresaId: A.empresa, usuarioId: A.usuario, requestId: randomUUID(), motivo: "Criação administrativa" };
    await c.query("BEGIN");
    for (const p of [{ codigo: "ESSENCIAL", nome: "Essencial", min: 30, max: 60, valor: "5200.00" }, { codigo: "COMPLETA", nome: "Completa", min: 50, max: 100, valor: "7800.00" }]) {
      const criado = await criarPacoteAdmin(ex, { empresaId: A.empresa, codigo: p.codigo, nome: p.nome, descricao: null, duracaoMinutos: 240, convidadosMinimos: p.min, convidadosMaximos: p.max }, ctx);
      await salvarPacoteComercial(ex, { id: criado.id, nome: p.nome, descricao: null, duracaoMinutos: 240, convidadosMinimos: p.min, convidadosMaximos: p.max,
        disponibilidade: [1, 2, 3, 4, 5, 6, 7].flatMap((dia) => turnos.map((x) => ({ dia, horarioId: x.id }))),
        faixas: [{ convidadosMin: p.min, convidadosMax: p.max, valor: p.valor }], categorias: categorias.map((x) => ({ categoriaId: x.id, escolhas: 3 })) }, ctx);
    }
    await c.query("COMMIT");
    const ocupada = somarDias(hoje, 40);
    await c.query("INSERT INTO bloqueios_agenda (data, dia_inteiro, motivo, ativo) VALUES ($1::date, true, 'Festa sintética (harness Testar)', true)", [ocupada]);
    const arquivo = await biblioteca.salvarArquivo(A.sessao, { nome: "tabela-precos.pdf", bytes: PDF, tipoEsperado: "DOCUMENTO" });
    await biblioteca.salvarPronta(A.sessao, { categoria: "Comercial", link: null, atalho: null, titulo: "Tabela de preços", tipo: "DOCUMENTO", texto: "Tabela de preços (sintética)", arquivoId: arquivo.id, estado: "PUBLICADA", envioAutomatico: true, finalidade: "PRECOS" });
    // Atendimento e Wall-e DESLIGADOS: o teste serve para conferir antes de ligar.
    await servico.salvarConfiguracao(A.sessao, { ativo: false, nome: "Buffet sintético", perguntas: [{ id: "faq_bolo", pergunta: "Posso levar bolo de fora?", resposta: "Pode sim, com nota fiscal da confeitaria." }], wallE: { ativo: false } });

    // Porta REAL (walle/porta.ts) com as transações do harness (uma conexão por transação, como o pool).
    const proibido = async () => { throw new Error("cadastro procurado no teste"); };
    let modeloLigado = false; const chamadasModelo: string[] = [];
    const porta = carregarComponente("lib/whatsapp/atendimento/walle/porta.ts", {
      "../../../db/postgres.ts": { db, withTransaction },
      // Sem efeito: nenhum cadastro é procurado pelo telefone (falha se for).
      "../../../clientes/repositories/cliente.repository": { buscarClientesPorContatoExato: proibido }, "../../../fechamentos/contratacoes.ts": { listarContratacoes: proibido },
      "../core.ts": core, "../multiempresa.ts": multiempresa,
      "../configuracao.ts": { entendimentoSoRegras: () => !modeloLigado, modoEntendimento: () => ({ modo: modeloLigado ? "MODELO" : "REGRAS" }) },
      "../motivo-falha.ts": motivoFalha, "../prontas-link.ts": prontasLink, "./contexto.ts": contexto, "./entendimento.ts": entendimento,
      "./fontes-postgres.ts": fontes, "./link-disponibilidade.ts": linkDisponibilidade, "./resolver.ts": resolver,
    }).modulo as typeof import("./porta.ts");
    // Modelo simulado (sem rede): classifica preço; o resto é revalidado pelas regras, como na fila.
    const entender = async (_e: string, texto: string) => { chamadasModelo.push(texto); return { intencoes: [{ tipo: "PRECOS", trecho: texto.slice(0, 20), perguntaId: null, tema: null }], data: null, turno: null, convidados: 40, pacotes: [], unidade: null, tema: null, reenviar: false, alergia: false } as never; };
    const portaTeste = porta.criarPortaWallE(entender, { semEfeito: true, direitoModelo: async () => true });
    const teste = carregarComponente("lib/whatsapp/atendimento/walle/teste.ts", {
      "../core.ts": core, "../configuracao.ts": { ambienteAtendimento: () => "staging" }, "../motivo-falha.ts": motivoFalha, "../service.ts": servico, "./tipos.ts": tipos,
    }).modulo as typeof import("./teste.ts");

    // Assinatura de TODAS as tabelas do schema public (conteúdo inteiro, não só contagem).
    async function assinatura() {
      const tabelas = (await c.query<{ t: string }>("SELECT quote_ident(table_name) AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1")).rows.map((r) => r.t);
      const out: Record<string, string> = {};
      for (const t of tabelas) out[t] = (await c.query<{ h: string }>(`SELECT count(*) || ':' || md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM public.${t} x`)).rows[0].h;
      return out;
    }
    const antes = await assinatura();
    assert.ok(Object.keys(antes).length > 20, "assinatura cobre o schema");

    // T3 — preço + agenda da data bloqueada, pelas regras.
    const r1 = await teste.testarWallE(A.sessao, `Quanto custa para 40 convidados? Tem vaga dia ${dataBr(ocupada)} à noite?`, portaTeste);
    assert.ok(["RESPONDE", "RESPONDE_E_PASSA"].includes(r1.desfecho), `T3 preço: ${JSON.stringify(r1)}`);
    assert.equal(r1.entendidoPor, "REGRAS");
    const fontes1 = r1.respostas.flatMap((x) => x.fontes);
    assert.ok(fontes1.some((f) => f === `Agenda de ${dataBr(ocupada)}`), `T3: fonte da agenda ${JSON.stringify(fontes1)}`);
    assert.ok(r1.respostas.some((x) => x.anexo?.titulo === "Tabela de preços") || fontes1.some((f) => /^Pacote |^Tabela de preços/.test(f)), `T3: preço de fonte oficial ${JSON.stringify(r1)}`);
    // Resposta aprovada.
    const r2 = await teste.testarWallE(A.sessao, "Posso levar bolo de fora?", portaTeste);
    assert.ok(r2.respostas.some((x) => x.texto?.includes("nota fiscal da confeitaria") && x.fontes.includes("Resposta aprovada: “Posso levar bolo de fora?”")), `T3 FAQ: ${JSON.stringify(r2)}`);
    // Pedido de atendente: passa para a equipe, com motivo.
    const r3 = await teste.testarWallE(A.sessao, "Quero falar com uma pessoa da equipe", portaTeste);
    assert.ok(r3.motivos.includes(tipos.NOME_MOTIVO.PEDIDO_CLIENTE), `T3 atendente: ${JSON.stringify(r3)}`);
    // PARAR: bloqueio na recepção, sem chamar a porta.
    const r4 = await teste.testarWallE(A.sessao, "PARAR", portaTeste);
    assert.equal(r4.desfecho, "BLOQUEIA_NA_RECEPCAO");
    // Modelo (simulado) com direito: entende pelo modelo, revalidado; o resto segue igual e nada é gravado.
    modeloLigado = true;
    const r5 = await teste.testarWallE(A.sessao, "Qual o valor para 40 convidados?", portaTeste);
    assert.equal(r5.entendidoPor, "MODELO", `T3 modelo: ${JSON.stringify(r5)}`);
    assert.deepEqual(chamadasModelo, ["Qual o valor para 40 convidados?"]);
    modeloLigado = false;

    // T1 — nada mudou em nenhuma tabela.
    const depois = await assinatura();
    const mudaram = Object.keys(antes).filter((k) => antes[k] !== depois[k]);
    assert.deepEqual(mudaram, [], `T1: tabelas alteradas pelo teste: ${mudaram.join(", ")}`);
    for (const tabela of ["whatsapp_atendimento_conversas", "whatsapp_atendimento_mensagens"]) {
      assert.equal(Number((await c.query(`SELECT count(*) AS n FROM ${tabela} WHERE empresa_id = $1`, [A.empresa])).rows[0].n), 0, `T1: nada em ${tabela}`);
    }

    // T2 — a transação de leitura recusa escrita; nada é gravado.
    await assert.rejects(porta.lerSemEfeito((tx) => tx.query("UPDATE empresas SET nome = nome || ' (escrita proibida)' WHERE id = $1", [A.empresa])), /read-only|somente leitura/i);
    assert.equal(Number((await c.query("SELECT count(*) AS n FROM empresas WHERE nome LIKE '%(escrita proibida)'")).rows[0].n), 0, "T2: nada gravado");
    // E o que foi lido sai (a transação desfeita não perde a leitura).
    assert.equal(await porta.lerSemEfeito(async (tx) => Number((await tx.query("SELECT 1 AS um")).rows[0].um)), 1);

    // T4 — sem vínculo com a empresa: recusado antes de ler configuração ou chamar a porta.
    const u = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Sem vínculo', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id`, [`${cod("s")}@example.test`, SENHA]);
    let chamou = false;
    await assert.rejects(teste.testarWallE({ usuario_id: u, papel: "REPRESENTANTE_AUTORIZADO" } as never, "Quanto custa?", { responder: async () => { chamou = true; throw new Error("não devia"); } }));
    assert.equal(chamou, false, "T4: porta não chamada");
  } finally {
    await c.end();
  }
});
