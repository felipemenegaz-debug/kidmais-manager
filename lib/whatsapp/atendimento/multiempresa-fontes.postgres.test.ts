import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Client } from "pg";
import { hashToken } from "../../autenticacao/senha.ts";
import { criarPacoteAdmin } from "../../comercial/pacotes-admin.ts";
import { salvarPacoteComercial } from "../../comercial/pacote-comercial.ts";
import { conectarDescartavel } from "../../comercial/postgres-descartavel.ts";
import type { DbExecutor } from "../../db/contracts.ts";
import { criarBloqueioAgenda } from "../../disponibilidade/repositories/disponibilidade.repository.ts";
import type { Interpretacao } from "./core.ts";
import { carregarMultiempresa, cod, fixturesMultiempresa, flags, semGanchos, SENHA } from "./harness-multiempresa.ts";
import type { ConteudoSaida } from "./transporte.ts";
import type { AlvoEnvio, DependenciasWorker } from "./worker.ts";

/**
 * E-ME1 r3 — caso 10 COMPLETO: isolamento das FONTES do Wall-e entre empresas no fluxo multiempresa (PostgreSQL
 * DESCARTÁVEL, modelo 112; a 117 é aplicada pela suíte). A = piloto, B = não piloto (isenta, conectada, ligada, Wall-e
 * ligado). Tudo pelo caminho real: recepção Meta (receberEventosMeta) → rodízio → worker → porta REAL do Wall-e (porta.ts +
 * fontes PostgreSQL, entendimento por regras, sem modelo) → transporte espião. Os dados de A e B são criados pelos serviços
 * do domínio e são DIFERENTES de propósito (mesmo código de pacote COMPLETA nas duas, nomes e valores distintos):
 *
 *  10-P  pacotes: B lista só os pacotes de B (Completa Bravo, Kids Bravo); nada de A (Completa Alfa, Essencial Alfa);
 *  10-B  cardápio: o buffet do Completa de B traz os itens de B (categorias/itens por empresa, 078), nada de A;
 *  10-$  preço/orçamento (com a tabela PDF de cada empresa publicada na biblioteca): a MESMA pergunta ("Completa, dia D à noite, 60 convidados") dá R$ 9.100,00 em B e R$ 7.800,00 em A,
 *        com TABELA_PRECO da própria empresa; o pedido de orçamento também;
 *  10-G  agenda: o dia bloqueado em A está livre em B e o bloqueado em B está ocupado só em B (fonte AGENDA de cada uma);
 *  10-C  contratos: o MESMO número é cliente nas duas, cada uma com a sua contratação liberada: o link seguro que B manda é o
 *        do contrato de B; número que só é cliente de A não recebe link em B (passa à equipe);
 *  10-L  link público de disponibilidade: só A (I-8: a página pública é da empresa configurada no servidor); B nunca;
 *  10-F  fontes registradas nas saídas de B: nenhum id de A (pacotes, tabelas, contrato);
 *  10-M  (mutante documentado) o worker chamando a porta com a empresa errada é pego por estas asserções.
 */
const ler = (f: string) => readFileSync(f, "utf8");
const UP = ler("database/migrations/20261104_117_atendimento_multiempresa.sql");
const POS = ler("database/checks/20261104_117_postcheck.sql");
const SEGREDO = Buffer.alloc(32, 7).toString("base64");
Object.assign(process.env, { WHATSAPP_CREDENTIAL_ENCRYPTION_KEY: SEGREDO, WHATSAPP_CREDENTIAL_KEY_VERSION: "1", META_GRAPH_API_VERSION: "v23.0" });
const CHAVE = "WHATSAPP_ATENDIMENTO_MULTIEMPRESA";
const chave = (v: string | undefined) => { if (v === undefined) delete process.env[CHAVE]; else process.env[CHAVE] = v; };
const PLANO: Interpretacao = { intencao: "INTERESSE", perguntaId: null, data: null, convidados: null } as Interpretacao;
const ORIGEM_AGENDA = "https://agenda.kidmais.example/";
const ORIGEM_CONTRATO = "https://atendimento.kidmais.example";
const hoje = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }).format(new Date());
const somarDias = (iso: string, d: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + d * 86400000).toISOString().slice(0, 10);
const br = (iso: string) => iso.split("-").reverse().join("/");

/**
 * Contratação sintética liberada ao cliente (AGUARDANDO_CLIENTE), pelas regras do banco — a mesma receita de
 * migration-080.postgres.test.ts, com um turno existente (nada global é criado). Commit próprio.
 */
async function contratacao(c: Client, empresaId: string, clienteId: string, dataEvento: string, turno: { id: string; inicio: string; fim: string }) {
  const id = async (sql: string, v: unknown[]) => (await c.query<{ id: string }>(sql, v)).rows[0].id;
  await c.query("BEGIN");
  try {
    const u = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Assinante E-ME1', $2, 'ADMINISTRATIVO', true) RETURNING id`, [`${cod("ass")}@example.test`, SENHA]);
    const m = await id(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO') RETURNING id`, [empresaId, u]);
    await c.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
    await c.query(`INSERT INTO empresa_membership_capacidades (empresa_id, membership_id, capacidade, concedido_por, motivo) VALUES ($1::uuid, $2::uuid, 'CONTRATO_ASSINAR_EMPRESA', $3::uuid, 'Fixture E-ME1')`, [empresaId, m, u]);
    const pacote = await id(`INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente) VALUES ($1::uuid, $2, 'Festa contratada (fixture)', 9, false, false) RETURNING id`, [empresaId, cod("FX").toUpperCase()]);
    const tabela = await id(`INSERT INTO tabelas_preco (codigo, nome, vigencia_inicio, ativa, empresa_id) VALUES ($1, 'Tabela fixture', '2026-01-01', false, $2::uuid) RETURNING id`, [cod("t"), empresaId]);
    const preco = await id(`INSERT INTO precos_pacote (tabela_preco_id, pacote_id, convidados_min, tipo_calculo, valor, categoria_horario) VALUES ($1::uuid, $2::uuid, 1, 'FIXO', 100, 'PADRAO') RETURNING id`, [tabela, pacote]);
    const fechamento = await id(`INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
        categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status)
      VALUES ($7::date, $8::time, $9::time, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'PADRAO', 'PADRAO', 60, 60, 100, 100, 100, 'ATENDIMENTO_KIDMAIS', $6::uuid, 'AGUARDANDO_PAGAMENTO') RETURNING id`,
      [turno.id, empresaId, pacote, tabela, preco, clienteId, dataEvento, turno.inicio, turno.fim]);
    const contrato = await id(`INSERT INTO contratos (fechamento_id) VALUES ($1::uuid) RETURNING id`, [fechamento]);
    const snapshot = { comercial: { valorFinalContrato: 100 }, evento: { data: dataEvento, convidados: 60 } };
    const hash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
    const pdf = Buffer.from(`%PDF-1.4\n% E-ME1 ${randomUUID()}\n%%EOF\n`);
    const pdfHash = createHash("sha256").update(pdf).digest("hex");
    const versao = await id(`INSERT INTO contrato_versoes (contrato_id, numero_versao, status, snapshot, snapshot_hash, documento_template_versao) VALUES ($1::uuid, 1, 'ATIVA', $2::jsonb, $3, 1) RETURNING id`, [contrato, JSON.stringify(snapshot), hash]);
    const doc = await id(`INSERT INTO contrato_documentos (contrato_versao_id, categoria, revisao, snapshot_hash, template_codigo, template_versao, pdf_hash, tamanho_bytes, conteudo_pdf, gerado_por_usuario_id)
       VALUES ($1::uuid, 'CONTRATO', 1, $2, 'CONTRATO_EME1', 1, $3, $4, $5, $6::uuid) RETURNING id`, [versao, hash, pdfHash, pdf.length, pdf, u]);
    const comprovante = await id(`INSERT INTO contrato_documentos (contrato_versao_id, categoria, revisao, snapshot_hash, template_codigo, template_versao, pdf_hash, tamanho_bytes, conteudo_pdf)
       VALUES ($1::uuid, 'COMPROVANTE_ASSINATURA', 1, $2, 'COMPROVANTE_EME1', 1, $3, $4, $5) RETURNING id`, [versao, hash, pdfHash, pdf.length, pdf]);
    await c.query(`INSERT INTO contrato_edicoes (contrato_versao_id, contrato_id, tipo, estado, dados_fonte, alteracoes, criado_por_usuario_id, atualizado_por_usuario_id,
        documento_revisado_id, revisado_por_usuario_id, revisado_em, revisao_comercial_aprovada, aprovado_comercial_por_usuario_id, aprovado_comercial_em)
       VALUES ($1::uuid, $2::uuid, 'INICIAL', 'EM_ELABORACAO', '{"schemaVersao":1}'::jsonb, '{}'::jsonb, $3::uuid, $3::uuid, $4::uuid, $3::uuid, now(), 1, $3::uuid, now())`, [versao, contrato, u, doc]);
    await c.query(`INSERT INTO contrato_fluxos (contrato_id, versao_em_preparacao_id) VALUES ($1::uuid, $2::uuid)`, [contrato, versao]);
    const sessao = await id(`INSERT INTO sessoes_administrativas (usuario_id, token_hash, csrf_hash, autenticado_em, ultima_atividade_em, expira_em)
       VALUES ($1::uuid, $2, $3, clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '8 hours') RETURNING id`, [u, hashToken(randomBytes(32).toString("base64url")), hashToken(randomBytes(32).toString("base64url"))]);
    await c.query(`INSERT INTO contrato_assinaturas (contrato_versao_id, parte, documento_id, usuario_id, sessao_id, autenticacao_metodo, autenticado_em, identidade_snapshot, snapshot_hash, pdf_hash, metodo, provider, assinado_em, request_id, chave_idempotencia, comprovante_documento_id)
       SELECT $1::uuid, 'KIDMAIS', $2::uuid, $3::uuid, s.id, 'SENHA', s.autenticado_em, jsonb_build_object('usuarioId', $3::text, 'papel', 'REPRESENTANTE_AUTORIZADO', 'nome', 'Assinante E-ME1', 'cargo', null),
              $4, $5, 'SESSAO_REAUTENTICADA', 'INTERNAL', clock_timestamp(), $6::uuid, $7::uuid, $8::uuid
         FROM sessoes_administrativas s WHERE s.id = $9::uuid`, [versao, doc, u, hash, pdfHash, randomUUID(), randomUUID(), comprovante, sessao]);
    await c.query(`UPDATE contrato_edicoes SET estado = 'ASSINADA_KIDMAIS', atualizado_em = clock_timestamp() WHERE contrato_versao_id = $1::uuid`, [versao]);
    await c.query(`UPDATE contrato_edicoes SET estado = 'AGUARDANDO_CLIENTE', liberado_por_usuario_id = $2::uuid, liberado_em = clock_timestamp(), atualizado_em = clock_timestamp() WHERE contrato_versao_id = $1::uuid`, [versao, u]);
    await c.query("COMMIT");
    return contrato;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

test("E-ME1 r3: caso 10 completo — pacotes, preços, orçamento, agenda, contratos e link isolados entre empresas no MULTI", { timeout: 900_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  const c = await conectarDescartavel();
  const q = (sql: string, v: unknown[] = []) => c.query(sql, v);
  const ex = c as unknown as DbExecutor;
  const antes = { agenda: process.env.AGENDA_PUBLICA_EMPRESA_ID, origem: process.env.AGENDA_PUBLICA_ORIGEM, auth: process.env.ADMIN_AUTH_ORIGIN };
  const restaurar = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  try {
    await q(UP); await q(POS);
    chave("true");
    const criarUsuario = async (papel: string) => (await q(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness fontes', $2, $3, true) RETURNING id`, [`${cod("u")}@example.test`, SENHA, papel])).rows[0].id as string;
    const f = fixturesMultiempresa(q, criarUsuario);
    const A = await f.empresa("A piloto"), B = await f.empresa("B");
    flags.piloto = A; flags.kproc = true; flags.regras = true;
    const sA = await f.sessao(A), sB = await f.sessao(B);
    for (const e of [A, B]) await f.conectar(e, sA.usuario_id);
    await f.isentar(B, sA.usuario_id);
    const { servico, worker, meta, biblioteca, portaWallE } = carregarMultiempresa();
    for (const s of [sA, sB]) await servico.salvarConfiguracao(s as never, { ativo: true, nome: "Buffet sintético", perguntas: [], limites: { respostasPor24h: 50 }, wallE: { ativo: true } });
    Object.assign(process.env, { AGENDA_PUBLICA_EMPRESA_ID: A, AGENDA_PUBLICA_ORIGEM: ORIGEM_AGENDA, ADMIN_AUTH_ORIGIN: ORIGEM_CONTRATO });

    // ——— Dados DISTINTOS de A e B pelos serviços do domínio ———
    const turnos = (await q("SELECT id, codigo, horario_inicio_padrao::text AS inicio, horario_fim_padrao::text AS fim FROM configuracao_agenda WHERE ativo ORDER BY horario_inicio_padrao")).rows as { id: string; codigo: string; inicio: string; fim: string }[];
    assert.ok(turnos.length >= 2, "modelo com dois turnos");
    const PACOTES = {
      [A]: [{ codigo: "COMPLETA", nome: "Completa Alfa", min: 50, max: 100, valor: "7800.00" }, { codigo: "ESSENCIAL", nome: "Essencial Alfa", min: 30, max: 60, valor: "5200.00" }],
      [B]: [{ codigo: "COMPLETA", nome: "Completa Bravo", min: 50, max: 100, valor: "9100.00" }, { codigo: "KIDS", nome: "Kids Bravo", min: 20, max: 40, valor: "4300.00" }],
    };
    const idsDe: Record<string, Set<string>> = { [A]: new Set(), [B]: new Set() };
    for (const [e, s] of [[A, sA], [B, sB]] as const) {
      const ctx = { empresaId: e, usuarioId: s.usuario_id, requestId: randomUUID(), motivo: "Criação administrativa (E-ME1 r3)" };
      // Buffet da empresa (078): categoria e item com nomes próprios de cada uma.
      const rotulo = e === A ? "Alfa" : "Bravo";
      const categoria = (await q("INSERT INTO buffet_categorias (empresa_id, codigo, nome, ordem_exibicao, ativo) VALUES ($1::uuid, $2, $3, 1, true) RETURNING id", [e, cod("CAT_"), `Salgados ${rotulo}`])).rows[0].id as string;
      await q("INSERT INTO buffet_itens (empresa_id, categoria_id, codigo, nome, ordem_exibicao, ativo) VALUES ($1::uuid, $2::uuid, $3, $4, 1, true)", [e, categoria, cod("IT_"), e === A ? "Coxinha Alfa" : "Empada Bravo"]);
      await q("BEGIN");
      for (const p of PACOTES[e]) {
        const criado = await criarPacoteAdmin(ex, { empresaId: e, codigo: p.codigo, nome: p.nome, descricao: null, duracaoMinutos: 240, convidadosMinimos: p.min, convidadosMaximos: p.max }, ctx);
        await salvarPacoteComercial(ex, { id: criado.id, nome: p.nome, descricao: null, duracaoMinutos: 240, convidadosMinimos: p.min, convidadosMaximos: p.max,
          disponibilidade: [1, 2, 3, 4, 5, 6, 7].flatMap((dia) => turnos.map((x) => ({ dia, horarioId: x.id }))),
          faixas: [{ convidadosMin: p.min, convidadosMax: p.max, valor: p.valor }], categorias: [{ categoriaId: categoria, escolhas: 1 }] }, ctx);
      }
      await q("COMMIT");
      for (const r of (await q("SELECT id FROM pacotes WHERE empresa_id=$1 UNION ALL SELECT id FROM tabelas_preco WHERE empresa_id=$1", [e])).rows) idsDe[e].add(String(r.id));
    }
    const dA = somarDias(hoje, 41), dB = somarDias(hoje, 43), dPreco = somarDias(hoje, 50);
    await q("BEGIN");
    await criarBloqueioAgenda({ data: dA, diaInteiro: true, motivo: "Festa sintética de A", usuarioId: sA.usuario_id, empresaId: A }, ex);
    await criarBloqueioAgenda({ data: dB, diaInteiro: true, motivo: "Festa sintética de B", usuarioId: sB.usuario_id, empresaId: B }, ex);
    await q("COMMIT");
    // Tabela de preços (pronta PRECOS com PDF próprio) de cada empresa: o Wall-e só calcula com a tabela publicada.
    for (const [e, s, r] of [[A, sA, "A"], [B, sB, "B"]] as const) {
      const arq = await biblioteca.salvarArquivo(s as never, { nome: `tabela-${r}.pdf`, bytes: Buffer.from(`%PDF-1.4
% tabela sintética ${r}
%%EOF
`), tipoEsperado: "DOCUMENTO" });
      const pr = await biblioteca.salvarPronta(s as never, { categoria: "Comercial", link: null, atalho: null, titulo: `Tabela de ${r}`, tipo: "DOCUMENTO", texto: `Tabela de preços da empresa ${r}`, arquivoId: arq.id, estado: "PUBLICADA", envioAutomatico: true, finalidade: "PRECOS" } as never);
      idsDe[e].add(String(pr.id)); idsDe[e].add(String(arq.id));
    }
    let seq = 10;
    const contato = () => `556194${String(seq++).padStart(7, "0")}`;
    const ctContrato = contato(), ctSoA = contato();
    const cliente = async (e: string, tel: string) => (await q("INSERT INTO clientes (nome_completo, empresa_id, telefone) VALUES ($1, $2::uuid, $3) RETURNING id", [`Cliente sintético ${cod("")}`, e, tel])).rows[0].id as string;
    const contratoA = await contratacao(c, A, await cliente(A, ctContrato), "2027-11-14", turnos[0]);
    const contratoB = await contratacao(c, B, await cliente(B, ctContrato), "2027-11-21", turnos[0]);
    await cliente(A, ctSoA);
    idsDe[A].add(contratoA); idsDe[B].add(contratoB);

    // ——— Recepção real → rodízio → worker → porta REAL do Wall-e → transporte espião ———
    const envios: { alvo: AlvoEnvio; conteudo: ConteudoSaida }[] = [];
    const deps: DependenciasWorker = {
      interpretar: async () => PLANO,
      enviar: async (_c, conteudo, alvo) => { envios.push({ alvo, conteudo }); return cod("wamid."); },
      wallE: portaWallE.criarPortaWallE(null),
    };
    const entrada = (e: string, ct: string, texto: string) => ({ phoneNumberId: f.numero(e), wabaId: f.waba(e), id: cod("wamid.in."), contato: ct, texto, timestamp: Date.now(), nomePerfil: "Cliente Sintético" });
    const textoDe = (x: { conteudo: ConteudoSaida }) => (x.conteudo.tipo === "TEXTO" ? x.conteudo.texto : JSON.stringify(x.conteudo));
    const fontesDe = async (e: string, ct: string) => (await q(`SELECT m.fonte FROM whatsapp_atendimento_mensagens m JOIN whatsapp_atendimento_conversas cv ON cv.id=m.conversa_id
      WHERE m.empresa_id=$1 AND cv.contato=$2 AND m.direcao='SAIDA' AND m.fonte IS NOT NULL`, [e, ct])).rows.flatMap((l) => (l.fonte?.fontes ?? []) as Record<string, unknown>[]);
    const perguntar = async (texto: string, quem: string[] = [A, B], ct = contato()) => {
      const n0 = envios.length;
      await meta.receberEventosMeta({ entradas: quem.map((e) => entrada(e, ct, texto)), status: [] }, { automacaoGlobal: true });
      // Processa até a fila esvaziar (no máximo 6 lotes; o lote para no prazo de 30 s ou numa tarefa ADIADA). Os estados
      // de cada lote vão para o diagnóstico: o que se prova é o conteúdo de cada empresa, não quantas voltas o lote deu.
      const lotes: string[] = [];
      for (let i = 0; i < 6; i++) {
        const r = await worker.processarLote(deps, { maxTarefas: 10 });
        lotes.push(`${r.estado}:${r.tarefas}`);
        if (r.estado === "SEM_TAREFA" || r.estado === "DESLIGADO") break;
      }
      if (lotes.length > 2) console.log(`[caso 10] "${texto.slice(0, 40)}": lotes ${lotes.join(",")}`);
      const de = (e: string) => envios.slice(n0).filter((x) => x.alvo.empresaId === e).map(textoDe).join("\n");
      return { a: de(A), b: de(B), fa: await fontesDe(A, ct), fb: await fontesDe(B, ct), ct, lotes };
    };
    const todasFontesB: Record<string, unknown>[] = [];
    const diag = (r: { a: string; b: string; lotes?: string[] }) => ` [lotes ${(r.lotes ?? []).join(",")}] [A: ${r.a.slice(0, 300)}] [B: ${r.b.slice(0, 300)}]`;

    // 10-P pacotes
    const p = await perguntar("Quais pacotes vocês têm?");
    todasFontesB.push(...p.fb);
    assert.match(p.b, /Completa Bravo/, "10-P: B lista o próprio pacote" + diag(p));
    assert.match(p.b, /Kids Bravo/, "10-P: B lista o pacote que só B tem" + diag(p));
    assert.doesNotMatch(p.b, /Alfa/, "10-P: nada dos pacotes de A em B" + diag(p));
    assert.match(p.a, /Completa Alfa/, "10-P: A lista os próprios" + diag(p));
    assert.doesNotMatch(p.a, /Bravo/, "10-P: nada de B em A" + diag(p));

    // 10-B cardápio (buffet da empresa)
    const cb = await perguntar("O que vem no buffet do Completa?");
    todasFontesB.push(...cb.fb);
    assert.match(cb.b, /Empada Bravo/, "10-B: B mostra o buffet de B" + diag(cb));
    assert.doesNotMatch(cb.b, /Coxinha Alfa|Salgados Alfa/, "10-B: nada do buffet de A em B" + diag(cb));
    assert.match(cb.a, /Coxinha Alfa/, "10-B: A mostra o buffet de A" + diag(cb));

    // 10-$ preço e orçamento (mesma pergunta, valores distintos)
    const pr = await perguntar(`Quanto fica o Completa dia ${br(dPreco)} à noite para 60 convidados?`);
    todasFontesB.push(...pr.fb);
    assert.match(pr.b, /R\$\s?9\.100,00/, "10-$: B calcula pela tabela de B" + diag(pr));
    assert.doesNotMatch(pr.b, /7\.800/, "10-$: valor de A nunca aparece em B" + diag(pr));
    assert.ok(pr.b.includes("tabela-B.pdf") && !pr.b.includes("tabela-A.pdf") && !pr.b.includes("empresa A"), "10-$: B manda a PRÓPRIA tabela (PDF), nada da de A" + diag(pr));
    assert.match(pr.a, /R\$\s?7\.800,00/, "10-$: A calcula pela tabela de A" + diag(pr));
    assert.doesNotMatch(pr.a, /9\.100/, "10-$: valor de B nunca aparece em A" + diag(pr));
    const tabelaB = pr.fb.find((x) => x.tipo === "TABELA_PRECO");
    assert.ok(tabelaB && idsDe[B].has(String(tabelaB.id)), "10-$: fonte TABELA_PRECO de B é tabela de B");
    const tabelaA = pr.fa.find((x) => x.tipo === "TABELA_PRECO");
    assert.ok(tabelaA && idsDe[A].has(String(tabelaA.id)) && tabelaA.id !== tabelaB!.id, "10-$: tabelas distintas");
    const orc = await perguntar(`Quero um orçamento do Completa para 60 convidados dia ${br(dPreco)} à noite`);
    todasFontesB.push(...orc.fb);
    assert.match(orc.b, /9\.100,00/, "10-$: orçamento de B pela tabela de B" + diag(orc));
    assert.doesNotMatch(orc.b, /7\.800/, "10-$: orçamento de B sem valor de A" + diag(orc));
    assert.match(orc.a, /7\.800,00/, "10-$: orçamento de A pela tabela de A" + diag(orc));

    // 10-G agenda
    const gA = await perguntar(`Tem vaga dia ${br(dA)} à noite?`);
    const gB = await perguntar(`Tem vaga dia ${br(dB)} à noite?`);
    todasFontesB.push(...gA.fb, ...gB.fb);
    assert.match(gA.a, /já está ocupado/, "10-G: o dia bloqueado em A está ocupado em A" + diag(gA));
    assert.doesNotMatch(gA.b, /já está ocupado/, "10-G: o bloqueio de A não ocupa B" + diag(gA));
    assert.match(gB.b, /já está ocupado/, "10-G: o dia bloqueado em B está ocupado em B" + diag(gB));
    assert.doesNotMatch(gB.a, /já está ocupado/, "10-G: o bloqueio de B não ocupa A" + diag(gB));
    assert.ok(gA.fb.some((x) => x.tipo === "AGENDA" && x.data === dA) && gB.fb.some((x) => x.tipo === "AGENDA" && x.data === dB), "10-G: fonte AGENDA registrada em B");

    // 10-L link público de disponibilidade: só A
    const tudoA = envios.filter((x) => x.alvo.empresaId === A).map(textoDe).join("\n");
    const tudoB = envios.filter((x) => x.alvo.empresaId === B).map(textoDe).join("\n");
    assert.ok(tudoA.includes("agenda.kidmais.example"), "10-L: controle — A recebe o link público");
    assert.ok(!tudoB.includes("agenda.kidmais.example") && !todasFontesB.some((x) => x.tipo === "LINK_DISPONIBILIDADE"), "10-L: B nunca recebe o link público de A");

    // 10-C contratos
    const k = await perguntar("Quero ver meu contrato", [A, B], ctContrato);
    todasFontesB.push(...k.fb);
    assert.ok(k.b.includes(`${ORIGEM_CONTRATO}/contrato/${contratoB.toLowerCase()}`), "10-C: B manda o link do contrato de B" + diag(k));
    assert.ok(!k.b.includes(contratoA.toLowerCase()), "10-C: B nunca manda o contrato de A" + diag(k));
    assert.ok(k.a.includes(`${ORIGEM_CONTRATO}/contrato/${contratoA.toLowerCase()}`) && !k.a.includes(contratoB.toLowerCase()), "10-C: A manda o de A" + diag(k));
    const soA = await perguntar("Quero ver meu contrato", [B], ctSoA);
    todasFontesB.push(...soA.fb);
    assert.ok(!soA.b.includes("/contrato/") && !soA.fb.some((x) => x.tipo === "LINK_CONTRATO"), "10-C: cliente só de A não recebe link em B" + diag(soA));
    assert.equal((await q("SELECT estado FROM whatsapp_atendimento_conversas WHERE empresa_id=$1 AND contato=$2", [B, ctSoA])).rows[0].estado, "AGUARDANDO_HUMANO", "10-C: passa à equipe de B");

    // 10-F fontes de B: nenhum id de A
    const serial = JSON.stringify(todasFontesB);
    for (const idA of idsDe[A]) assert.ok(!serial.includes(idA), `10-F: id de A (${idA}) nas fontes de B`);
    assert.ok(todasFontesB.some((x) => x.tipo === "PACOTE" && idsDe[B].has(String(x.id))) || todasFontesB.some((x) => x.tipo === "TABELA_PRECO"), "10-F: fontes de B presentes");
  } finally {
    semGanchos();
    chave(undefined);
    restaurar("AGENDA_PUBLICA_EMPRESA_ID", antes.agenda); restaurar("AGENDA_PUBLICA_ORIGEM", antes.origem); restaurar("ADMIN_AUTH_ORIGIN", antes.auth);
    await c.end();
  }
});
