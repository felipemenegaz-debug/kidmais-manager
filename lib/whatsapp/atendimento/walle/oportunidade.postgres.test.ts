import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { conectarDescartavel } from "../../../comercial/postgres-descartavel.ts";
import { carregarComponente } from "../../../../components/admin/teste-componente.ts";
import * as atribuicao from "../../../marketing/atribuicao.ts";
import { carregarComBanco, comercial, executor, fechamento } from "../../../marketing/harness-postgres.ts";
import { travarConfiguracaoAgenda } from "../../../agenda/trava-configuracao.ts";
import * as modeloOportunidades from "../../../oportunidades/modelo.ts";
import { carregarAtendimento, cod, withTransaction } from "../harness-postgres.ts";
import type { ConteudoSaida } from "../transporte.ts";
import type { PortaWallE } from "../worker.ts";
import { NOME_ANONIMIZADO, RESUMO_ANONIMIZADO, TELEFONE_ANONIMIZADO, capturarOportunidade, capturarOportunidadesPendentes } from "./oportunidade.ts";
import * as ambienteOportunidades from "../../../oportunidades/ambiente.ts";
import type { Entendimento, ResultadoWallE, TipoIntencao } from "./tipos.ts";

/**
 * Wall-e fatia 1a (132, LOCAL 23/11/2026; D-WA-2 e D-WA-3 de Felipe): conversa com pedido de festa nova vira cartão em
 * "Novo contato" do funil; exclusão a pedido do titular anonimiza o cartão sem negociação. Worker, recepção, privacidade
 * e listagens REAIS no PostgreSQL descartável (modelo 131 + 132), só pelo check:v1:postgres com opt-in. Dados e contatos
 * sintéticos; a porta do Wall-e devolve o entendimento validado (o modelo só classifica); transporte simulado (sem rede).
 *
 *  F0 sem a 132: a resposta sai igual e nada quebra (marca no savepoint, captura vê a coluna ausente);
 *  F1 pedido de festa cria um cartão (nome do perfil higienizado, data e convidados), sem cliente;
 *  F2 reentrega do mesmo evento e nova captura não duplicam;
 *  F3 segunda mensagem atualiza o cartão aberto (convidados), sem cartão novo;
 *  F4 cartão fechado (perda) + novo pedido = cartão novo, com outra chave;
 *  F5 saudação, suporte a contrato, PARAR e nao_contatar não criam cartão;
 *  F6 duas empresas e dois ambientes isolados (o lote de staging não captura a marca de production);
 *  F7 concorrência: duas capturas simultâneas do mesmo número (com e sem 55) = um cartão;
 *  F8 falha simulada da gravação: a resposta sai, a marca fica e o lote seguinte recupera;
 *  F9 nenhuma automação de Marketing (atribuição, autorização, nenhuma outra tabela marketing_ além do contato);
 *  F10 exclusão a pedido sem negociação anonimiza (nome e telefone somem; DELETE segue proibido pela 085);
 *  F11 exclusão de já convertido (cliente vinculado) preserva cartão e cliente; decisão da empresa só solta o vínculo;
 *  F12 cliente vinculado só com correspondência ÚNICA (dois clientes com o número = sem cliente);
 *  F13 funil e tela de atendimento: canal WhatsApp e origem Wall-e no cartão, anonimizado fora, indicador na conversa;
 *      r2: colunas, conversões e perdas do mês cortadas por ambiente (cartão do Wall-e do outro ambiente fora).
 *  r2 (revisão Astra r1): F7 outra variante reusa o cartão; F8/F15 falha adiada pela espera, 10 ruins não travam a boa;
 *  F10 totais na resposta e observação das ações apagada; F11 cliente por telefone NÃO é conversão (anonimiza e solta o
 *  cliente), negociação no cartão preserva; F14 PARAR na outra variante; F16 a 132 só solta a conversa do vínculo;
 *  F17 exclusão pela outra variante alcança cartão de conversa nula; F18 "Ver conversa" fora das 100; F19 chave durável
 *  depois do down e da reaplicação da 132.
 *  r3 (revisão Astra r2): F0 down só com a tabela vazia, F19 down recusado com vínculo; F14 sem_automatico preservado
 *  bloqueia; F15 adiamento só da marca vista (marca nova fica); F20 exclusão com a conversa irmã viva solta o vínculo,
 *  descarta a marca da irmã e troca o resumo guardado; F21 Origens dos contatos por ambiente (lista e detalhe); F22 site
 *  e registro manual completam o cartão aberto do Wall-e; F23 origem com texto da equipe = revisar.
 */
const DOWN = "database/rollback/20261123_132_walle_oportunidades_down.sql";
const ler = (f: string) => readFileSync(f, "utf8");
const M132 = ["database/checks/20261123_132_precheck.sql", "database/migrations/20261123_132_walle_oportunidades.sql", "database/checks/20261123_132_postcheck.sql"].map(ler);
const SENHA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;
const hoje = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }).format(new Date());
const somarDias = (iso: string, d: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + d * 86400000).toISOString().slice(0, 10);
const DATA = somarDias(hoje, 90);
const vazio = { data: null, turno: null, convidados: null, pacotes: [], unidade: null, tema: null };
function cpfValido() {
  const d = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  for (const peso of [10, 11]) { const r = d.reduce((soma, x, i) => soma + x * (peso - i), 0) * 10 % 11; d.push(r === 10 ? 0 : r); }
  return d.join("");
}

test("Wall-e 1a: pedido de festa vira cartão no funil, sem duplicar, isolado, recuperável; exclusão anonimiza", { timeout: 300_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  const c = await conectarDescartavel();
  const q = <T = Record<string, unknown>>(sql: string, v: unknown[] = []) => c.query(sql, v) as unknown as Promise<{ rows: T[] }>;
  try {
    const id = async (sql: string, v: unknown[]) => (await q<{ id: string }>(sql, v)).rows[0].id;
    async function empresaComRepresentante(nome: string) {
      const e = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id`, [cod("wf"), nome]);
      await q(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [e]);
      const u = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness funil', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id`, [`${cod("u")}@example.test`, SENHA]);
      const m = await id(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO') RETURNING id`, [e, u]);
      await q(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
      return { empresa: e, usuario: u, sessao: { usuario_id: u, papel: "REPRESENTANTE_AUTORIZADO", autenticado_em: new Date().toISOString() } as never };
    }
    const A = await empresaComRepresentante("Buffet sintético funil A");
    const B = await empresaComRepresentante("Buffet sintético funil B");
    const aStg = carregarAtendimento(A.empresa, "staging");
    const aPrd = carregarAtendimento(A.empresa, "production");
    const bStg = carregarAtendimento(B.empresa, "staging");
    for (const [s, sessao] of [[aStg, A.sessao], [aPrd, A.sessao], [bStg, B.sessao]] as const)
      await s.servico.salvarConfiguracao(sessao, { ativo: true, nome: "Buffet sintético", perguntas: [], wallE: { ativo: true } });

    // A porta do Wall-e devolve só o entendimento validado (códigos e entidades) e a memória: o roteiro por texto é sintético.
    type Roteiro = { tipos: TipoIntencao[]; convidados?: number | null; data?: string | null; passagem?: ResultadoWallE["passagem"] };
    const roteiro = new Map<string, Roteiro>();
    const entendimento = (r: Roteiro): Entendimento => ({ intencoes: r.tipos.map((tipo) => ({ tipo, trecho: "x" })), entidades: { ...vazio, data: r.data ?? null, convidados: r.convidados ?? null }, reenviar: false, alergia: false, origem: "REGRAS" });
    const chamadas = { wallE: 0 };
    const porta: PortaWallE = { async responder(e) {
      chamadas.wallE++;
      const r = roteiro.get(e.texto) ?? { tipos: ["OUTRO"] };
      const anterior = (e.contexto ?? {}) as { data?: string | null; convidados?: number | null };
      const contexto = { data: r.data ?? anterior.data ?? null, convidados: r.convidados ?? anterior.convidados ?? null, ultimoEntendimento: entendimento(r) };
      return { saidas: [{ texto: "Resposta sintética do Wall-e", anexo: null, fontes: [] }], contexto: contexto as never, passagem: r.passagem ?? null };
    } };
    const envios: { contato: string; conteudo: ConteudoSaida }[] = [];
    const deps = { interpretar: async () => ({ intencao: "OUTRO" as const, perguntaId: null, data: null, convidados: null }),
      enviar: async (contato: string, conteudo: ConteudoSaida) => { envios.push({ contato, conteudo }); return cod("gs-"); }, wallE: porta };
    const receber = (s: typeof aStg, contato: string, texto: string, nomePerfil: string | null = null, evento = cod("evt-")) =>
      s.servico.receberEntrada({ id: evento, app: "KidmaisManager", source: contato, texto, timestamp: Date.now(), nomePerfil });
    const processar = (s: typeof aStg) => s.worker.processarLote(deps, { maxTarefas: 20 });
    const conversa = async (empresa: string, ambiente: string, contato: string) =>
      (await q<Record<string, unknown> & { id: string }>("SELECT * FROM whatsapp_atendimento_conversas WHERE empresa_id=$1 AND ambiente=$2 AND contato=$3", [empresa, ambiente, contato])).rows[0];
    const cartoes = async (empresa: string, telefones: string[]) => (await q<{ id: string; nome: string; telefone: string; data: string | null; convidados: number | null; status: string; cliente_id: string | null; vinculo_cliente: string; chave_idempotencia: string; canal_atendimento: string; ambiente: string | null; conversa_id: string | null; anonimizado_em: string | null }>(
      `SELECT k.id::text, k.nome, k.telefone, k.data_desejada::text AS data, k.convidados, k.status, k.cliente_id::text, k.vinculo_cliente, k.chave_idempotencia, k.canal_atendimento,
         o.ambiente, o.conversa_id::text, o.anonimizado_em::text
       FROM marketing_contatos k LEFT JOIN whatsapp_atendimento_oportunidades o ON o.contato_id=k.id WHERE k.empresa_id=$1 AND k.telefone = ANY($2::text[]) ORDER BY k.recebido_em, k.id`, [empresa, telefones])).rows;
    const enviados = (contato: string) => envios.filter((x) => x.contato === contato).length;
    const FESTA = "quero fazer a festa do meu filho, quanto fica para 60 crianças?";
    roteiro.set(FESTA, { tipos: ["PRECOS"], convidados: 60, data: DATA });

    // F0 — sem a 132: a resposta sai igual e nada quebra.
    const f0 = "5561900008000";
    await receber(aStg, f0, FESTA, "Antes da 132");
    await processar(aStg);
    assert.equal(enviados(f0), 1, "F0: resposta enviada sem a 132");
    assert.equal((await q("SELECT 1 FROM marketing_contatos WHERE empresa_id=$1", [A.empresa])).rows.length, 0, "F0: nenhum cartão sem a 132");

    for (const sql of M132) await q(sql);
    // r3 — com a tabela de vínculos vazia, o down com a confirmação desfaz a 132; reaplicada em seguida.
    await q("SET kidmais.rollback_132 = 'descartar-vinculos'");
    await q(ler(DOWN));
    await q("RESET kidmais.rollback_132");
    assert.equal((await q<{ ok: boolean }>("SELECT to_regclass('public.whatsapp_atendimento_oportunidades') IS NULL AS ok")).rows[0].ok, true, "F0: down com a tabela vazia");
    for (const sql of M132) await q(sql);
    // Fotografia das tabelas de Marketing (exceto o próprio contato) para provar que nenhuma automação roda (F9).
    // marketing_saidas_contato fica de fora: a 127 (guarda, não automação) registra a saída quando a conversa passa a
    // nao_contatar (PARAR do F5); conferida à parte, só com origem ATENDIMENTO_WHATSAPP.
    const tabelasMarketing = (await q<{ t: string }>("SELECT tablename AS t FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'marketing\\_%' AND tablename NOT IN ('marketing_contatos', 'marketing_saidas_contato') ORDER BY 1")).rows.map((r) => r.t);
    assert.ok(tabelasMarketing.includes("marketing_atribuicoes"), "F9: a 085 está no modelo");
    const fotografia = async () => Object.fromEntries(await Promise.all(tabelasMarketing.map(async (t) => [t, Number((await q<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n)] as const)));
    const antesMarketing = await fotografia();

    // F1 — pedido de festa cria um cartão (nome do perfil higienizado), sem cliente.
    const f1 = "5561900008001";
    await receber(aStg, f1, FESTA, "  Ana\u0000  Souza​ ");
    await processar(aStg);
    assert.equal(enviados(f1), 1, "F1: resposta enviada");
    const cv1 = await conversa(A.empresa, "staging", f1);
    assert.equal(cv1.oportunidade_pendente_em, null, "F1: marca limpa pela captura");
    let k1 = await cartoes(A.empresa, [f1, f1.slice(2)]);
    assert.equal(k1.length, 1, "F1: um cartão");
    assert.deepEqual([k1[0].nome, k1[0].telefone, k1[0].data, k1[0].convidados, k1[0].status, k1[0].canal_atendimento, k1[0].vinculo_cliente, k1[0].cliente_id, k1[0].ambiente, k1[0].conversa_id],
      ["Ana Souza", f1, DATA, 60, "NOVO", "WHATSAPP", "SEM_CLIENTE", null, "staging", cv1.id], "F1: cartão em Novo contato com os dados do pedido");
    assert.match(k1[0].chave_idempotencia, /^wa[0-9a-f]{40}$/);

    // F2 — reentrega do mesmo evento não duplica; nova marca na mesma conversa também não.
    const evento = cod("evt-");
    await receber(aStg, f1, "tem data livre em março?", null, evento);
    await receber(aStg, f1, "tem data livre em março?", null, evento);
    roteiro.set("tem data livre em março?", { tipos: ["DISPONIBILIDADE"] });
    await processar(aStg);
    assert.equal(enviados(f1), 2, "F2: reentrega respondida uma vez só");
    await q("UPDATE whatsapp_atendimento_conversas SET oportunidade_pendente_em=clock_timestamp() WHERE id=$1", [cv1.id]);
    const r2 = await capturarOportunidadesPendentes(withTransaction, "staging");
    assert.deepEqual([r2.resultados, r2.falhas], [["SEM_MUDANCA"], []], "F2: captura repetida sem mudança");
    assert.equal((await cartoes(A.empresa, [f1])).length, 1, "F2: continua um cartão");

    // F3 — segunda mensagem atualiza o cartão aberto (convidados), sem cartão novo.
    roteiro.set("na verdade vão ser 80 convidados", { tipos: ["PACOTES"], convidados: 80 });
    await receber(aStg, f1, "na verdade vão ser 80 convidados");
    await processar(aStg);
    k1 = await cartoes(A.empresa, [f1]);
    assert.deepEqual([k1.length, k1[0].convidados, k1[0].data, k1[0].nome], [1, 80, DATA, "Ana Souza"], "F3: mesmo cartão atualizado");

    // F4 — cartão fechado (perda) + novo pedido = cartão novo, com outra chave.
    await q("UPDATE marketing_contatos SET status='DESCARTADO', perda_motivo='Preço', perdida_em=clock_timestamp() WHERE id=$1", [k1[0].id]);
    roteiro.set("voltei, quero orçar de novo", { tipos: ["CONTRATAR"] });
    await receber(aStg, f1, "voltei, quero orçar de novo");
    await processar(aStg);
    const k4 = await cartoes(A.empresa, [f1]);
    assert.equal(k4.length, 2, "F4: cartão novo depois do fechado");
    assert.deepEqual([k4[0].status, k4[1].status, k4[1].conversa_id], ["DESCARTADO", "NOVO", cv1.id], "F4: o fechado fica, o novo nasce em Novo contato");
    assert.notEqual(k4[0].chave_idempotencia, k4[1].chave_idempotencia, "F4: chave do 2º cartão da conversa");

    // F5 — saudação, suporte a contrato, PARAR e nao_contatar não criam cartão.
    roteiro.set("oi, boa tarde", { tipos: ["SAUDACAO"] });
    roteiro.set("preciso da segunda via do meu contrato", { tipos: ["CONTRATO_PROPRIO"], passagem: { motivo: "CONTRATO_PROPRIO", motivos: ["CONTRATO_PROPRIO"], em: new Date().toISOString(), coletado: { data: null, turno: null, convidados: null, pacote: null, unidade: null, tema: null }, enviados: [], pendentes: [], ultimaMensagem: "" } as never });
    const f5 = { saudacao: "5561900008051", suporte: "5561900008052", parar: "5561900008053", naoContatar: "5561900008054" };
    await receber(aStg, f5.saudacao, "oi, boa tarde");
    await receber(aStg, f5.suporte, "preciso da segunda via do meu contrato");
    await receber(aStg, f5.parar, "não quero receber mais nada de vocês");
    await processar(aStg);
    for (const [rotulo, n] of Object.entries(f5).slice(0, 3)) {
      const cv = await conversa(A.empresa, "staging", n);
      assert.equal(cv.oportunidade_pendente_em, null, `F5 ${rotulo}: sem marca`);
      assert.equal((await cartoes(A.empresa, [n])).length, 0, `F5 ${rotulo}: sem cartão`);
    }
    assert.equal((await conversa(A.empresa, "staging", f5.parar)).nao_contatar, true, "F5: PARAR bloqueou");
    // nao_contatar com marca (pedido de parar depois da resposta, antes da captura): descartada, sem cartão.
    await receber(aStg, f5.naoContatar, FESTA);
    await processar(aStg);
    const cvN = await conversa(A.empresa, "staging", f5.naoContatar);
    const kN = await cartoes(A.empresa, [f5.naoContatar]);
    assert.equal(kN.length, 1, "F5: festa normal criou o cartão (controle do cenário)");
    await q("UPDATE marketing_contatos SET status='DESCARTADO', perda_motivo='Parou de responder', perdida_em=clock_timestamp() WHERE id=$1", [kN[0].id]);
    await q("UPDATE whatsapp_atendimento_conversas SET nao_contatar=true, oportunidade_pendente_em=clock_timestamp() WHERE id=$1", [cvN.id]);
    assert.equal(await withTransaction((tx) => capturarOportunidade(tx, cvN.id)), "IGNORADO", "F5: nao_contatar ignorado");
    assert.equal((await cartoes(A.empresa, [f5.naoContatar])).length, 1, "F5: nao_contatar não criou cartão novo");
    assert.equal((await conversa(A.empresa, "staging", f5.naoContatar)).oportunidade_pendente_em, null, "F5: marca descartada");

    // F6 — duas empresas e dois ambientes isolados.
    const f6 = "5561900008006";
    await receber(aStg, f6, FESTA, "Cliente A staging");
    await receber(bStg, f6, FESTA, "Cliente B staging");
    await receber(aPrd, f6, FESTA, "Cliente A production");
    await processar(aStg);
    await processar(bStg);
    assert.deepEqual((await cartoes(A.empresa, [f6])).map((k) => k.ambiente), ["staging"], "F6: o lote de staging não cria cartão de production");
    await processar(aPrd);
    const cvPrd = await conversa(A.empresa, "production", f6);
    assert.equal(cvPrd.oportunidade_pendente_em, null, "F6: production capturou no seu lote");
    const kA6 = await cartoes(A.empresa, [f6]), kB6 = await cartoes(B.empresa, [f6]);
    assert.deepEqual(kA6.map((k) => [k.ambiente, k.nome]).sort(), [["production", "Cliente A production"], ["staging", "Cliente A staging"]], "F6: A tem um cartão por ambiente");
    assert.deepEqual(kB6.map((k) => [k.ambiente, k.nome]), [["staging", "Cliente B staging"]], "F6: B tem o seu");
    // Marca de production não é capturada pelo lote de staging.
    await q("UPDATE whatsapp_atendimento_conversas SET oportunidade_pendente_em=clock_timestamp() WHERE id=$1", [cvPrd.id]);
    await processar(aStg);
    assert.notEqual((await conversa(A.empresa, "production", f6)).oportunidade_pendente_em, null, "F6: staging não toca a marca de production");
    await processar(aPrd);
    assert.equal((await conversa(A.empresa, "production", f6)).oportunidade_pendente_em, null);
    assert.equal((await cartoes(A.empresa, [f6])).length, 2, "F6: sem duplicar");
    // O vínculo recusa conversa de outra empresa (gatilho da 132).
    await assert.rejects(q("INSERT INTO whatsapp_atendimento_oportunidades(contato_id,empresa_id,ambiente,conversa_id) VALUES($1,$2,'staging',$3)", [kB6[0].id, B.empresa, cv1.id]), /132/, "F6: conversa de outra empresa recusada");

    // F7 — concorrência: duas conversas do mesmo número (com e sem 55) capturadas ao mesmo tempo = um cartão.
    const f7 = "5561900008007";
    await receber(aStg, f7, "oi");
    roteiro.set("oi", { tipos: ["SAUDACAO"] });
    await processar(aStg);
    const cv7 = await conversa(A.empresa, "staging", f7);
    const cv7b = await id(`INSERT INTO whatsapp_atendimento_conversas (empresa_id, ambiente, contato) VALUES ($1, 'staging', $2) RETURNING id::text`, [A.empresa, f7.slice(2)]);
    await q("UPDATE whatsapp_atendimento_conversas SET oportunidade_pendente_em=clock_timestamp() WHERE id = ANY($1::uuid[])", [[cv7.id, cv7b]]);
    const corrida = await Promise.all([withTransaction((tx) => capturarOportunidade(tx, cv7.id)), withTransaction((tx) => capturarOportunidade(tx, cv7b))]);
    assert.deepEqual(corrida.filter((r) => r === "CRIADO").length, 1, `F7: um cartão criado (${corrida.join(",")})`);
    assert.equal((await cartoes(A.empresa, [f7, f7.slice(2)])).length, 1, "F7: um cartão para o número");
    // Dois lotes ao mesmo tempo sobre a mesma marca: SKIP LOCKED, sem duplicar.
    await q("UPDATE whatsapp_atendimento_conversas SET oportunidade_pendente_em=clock_timestamp() WHERE id=$1", [cv7.id]);
    await Promise.all([capturarOportunidadesPendentes(withTransaction, "staging"), capturarOportunidadesPendentes(withTransaction, "staging")]);
    assert.equal((await cartoes(A.empresa, [f7, f7.slice(2)])).length, 1, "F7: lotes simultâneos não duplicam");
    // r2 — a conversa da OUTRA variante (sem 55) que pede festa de novo reusa o cartão aberto do número (sem cartão novo).
    await q("UPDATE whatsapp_atendimento_conversas SET oportunidade_pendente_em=clock_timestamp() WHERE id=$1", [cv7b]);
    assert.ok(["SEM_MUDANCA", "ATUALIZADO", "JA_ABERTO"].includes(await withTransaction((tx) => capturarOportunidade(tx, cv7b))), "F7: outra variante reusa o cartão");
    assert.equal((await cartoes(A.empresa, [f7, f7.slice(2)])).length, 1, "F7: continua um cartão para o número");

    // F14 (r2) — PARAR na OUTRA variante do número bloqueia o cartão desta conversa.
    const f14 = "5561900008300";
    await id(`INSERT INTO whatsapp_atendimento_conversas (empresa_id, ambiente, contato, nao_contatar) VALUES ($1, 'staging', $2, true) RETURNING id::text`, [A.empresa, f14.slice(2)]);
    const cv14 = await id(`INSERT INTO whatsapp_atendimento_conversas (empresa_id, ambiente, contato, oportunidade_pendente_em) VALUES ($1, 'staging', $2, clock_timestamp()) RETURNING id::text`, [A.empresa, f14]);
    assert.equal(await withTransaction((tx) => capturarOportunidade(tx, cv14)), "IGNORADO", "F14: nao_contatar na variante sem 55 bloqueia");
    assert.equal((await cartoes(A.empresa, [f14, f14.slice(2)])).length, 0, "F14: sem cartão");
    // r3 — sem_automatico preservado da exclusão (controle por contato, 082) na outra variante também bloqueia.
    const f14b = "5561900008301";
    await q("INSERT INTO whatsapp_atendimento_controles_contato (empresa_id, ambiente, contato, sem_automatico) VALUES ($1, 'staging', $2, true)", [A.empresa, f14b.slice(2)]);
    const cv14b = await id(`INSERT INTO whatsapp_atendimento_conversas (empresa_id, ambiente, contato, oportunidade_pendente_em) VALUES ($1, 'staging', $2, clock_timestamp()) RETURNING id::text`, [A.empresa, f14b]);
    assert.equal(await withTransaction((tx) => capturarOportunidade(tx, cv14b)), "IGNORADO", "F14: sem_automatico preservado bloqueia (r3)");
    assert.equal((await cartoes(A.empresa, [f14b, f14b.slice(2)])).length, 0, "F14: sem cartão com sem_automatico");

    // F15 (r2) — fila: 10 conversas que falham sempre não impedem a 11ª; a que falha é adiada (espera) e não volta no lote.
    await q(`CREATE OR REPLACE FUNCTION harness_falha_fila() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.telefone LIKE '556190000820%' THEN RAISE EXCEPTION 'falha fila' USING ERRCODE = 'XX002'; END IF; RETURN NEW; END $$`);
    await q("CREATE TRIGGER harness_falha_fila BEFORE INSERT ON marketing_contatos FOR EACH ROW EXECUTE FUNCTION harness_falha_fila()");
    const ruins = await Promise.all(Array.from({ length: 10 }, (_, i) => id(`INSERT INTO whatsapp_atendimento_conversas (empresa_id, ambiente, contato, oportunidade_pendente_em) VALUES ($1, 'staging', $2, clock_timestamp() - interval '1 hour') RETURNING id::text`, [A.empresa, `556190000820${i}`])));
    const boa = await id(`INSERT INTO whatsapp_atendimento_conversas (empresa_id, ambiente, contato, oportunidade_pendente_em) VALUES ($1, 'staging', '5561900008210', clock_timestamp()) RETURNING id::text`, [A.empresa]);
    const lote1 = await capturarOportunidadesPendentes(withTransaction, "staging");
    assert.deepEqual([lote1.adiadas, lote1.falhas.length, lote1.falhas.every((f) => f === "SQLSTATE_XX002")], [10, 10, true], "F15: as 10 que falham são adiadas, com o código");
    const adiadas = (await q<{ n: number }>("SELECT count(*)::int AS n FROM whatsapp_atendimento_conversas WHERE id = ANY($1::uuid[]) AND oportunidade_pendente_em > clock_timestamp() + interval '4 minutes'", [ruins])).rows[0].n;
    assert.equal(adiadas, 10, "F15: marca adiada pela espera");
    const lote2 = await capturarOportunidadesPendentes(withTransaction, "staging");
    assert.deepEqual([lote2.capturas, lote2.falhas], [1, []], "F15: o lote seguinte captura a boa (as adiadas ainda não venceram)");
    assert.equal((await conversa(A.empresa, "staging", "5561900008210")).oportunidade_pendente_em, null);
    assert.equal(boa.length, 36);
    await q("DROP TRIGGER harness_falha_fila ON marketing_contatos");
    await q("DROP FUNCTION harness_falha_fila()");
    await q("UPDATE whatsapp_atendimento_conversas SET oportunidade_pendente_em=NULL WHERE id = ANY($1::uuid[])", [ruins]);
    // r3 — marca nova gravada enquanto a captura falhava não é empurrada pela espera; `adiadas` só conta linha real.
    const f15b = "5561900008220";
    await q(`CREATE OR REPLACE FUNCTION harness_falha_lenta() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.telefone = '${f15b}' THEN PERFORM pg_sleep(0.8); RAISE EXCEPTION 'falha lenta' USING ERRCODE = 'XX003'; END IF; RETURN NEW; END $$`);
    await q("CREATE TRIGGER harness_falha_lenta BEFORE INSERT ON marketing_contatos FOR EACH ROW EXECUTE FUNCTION harness_falha_lenta()");
    const cv15b = await id(`INSERT INTO whatsapp_atendimento_conversas (empresa_id, ambiente, contato, oportunidade_pendente_em) VALUES ($1, 'staging', $2, clock_timestamp() - interval '1 minute') RETURNING id::text`, [A.empresa, f15b]);
    const loteLento = capturarOportunidadesPendentes(withTransaction, "staging");
    await new Promise((r) => setTimeout(r, 300));
    // Mensagem nova no meio da falha: espera a trava da conversa e grava a marca nova antes do adiamento.
    await q("UPDATE whatsapp_atendimento_conversas SET oportunidade_pendente_em=clock_timestamp() WHERE id=$1", [cv15b]);
    const l15b = await loteLento;
    assert.deepEqual([l15b.adiadas, l15b.falhas], [0, ["SQLSTATE_XX003"]], "F15: marca nova não adiada (r3)");
    assert.equal((await q("SELECT 1 FROM whatsapp_atendimento_conversas WHERE id=$1 AND oportunidade_pendente_em <= clock_timestamp()", [cv15b])).rows.length, 1, "F15: a marca nova ficou como veio");
    await q("DROP TRIGGER harness_falha_lenta ON marketing_contatos");
    await q("DROP FUNCTION harness_falha_lenta()");
    await q("UPDATE whatsapp_atendimento_conversas SET oportunidade_pendente_em=NULL WHERE id=$1", [cv15b]);

    // F8 — falha simulada da gravação do cartão: a resposta sai, a marca fica e o lote seguinte recupera.
    const f8 = "5561900008008";
    await q(`CREATE OR REPLACE FUNCTION harness_falha_cartao() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.telefone = '${f8}' THEN RAISE EXCEPTION 'falha simulada' USING ERRCODE = 'XX001'; END IF; RETURN NEW; END $$`);
    await q("CREATE TRIGGER harness_falha_cartao BEFORE INSERT ON marketing_contatos FOR EACH ROW EXECUTE FUNCTION harness_falha_cartao()");
    const avisos: string[] = [];
    const avisoOriginal = console.warn;
    console.warn = (...a: unknown[]) => { avisos.push(a.map(String).join(" ")); };
    try {
      await receber(aStg, f8, FESTA, "Falha simulada");
      const lote = await processar(aStg);
      assert.ok(lote.tarefas >= 1, "F8: o lote processou a mensagem");
    } finally { console.warn = avisoOriginal; }
    assert.equal(enviados(f8), 1, "F8: a resposta saiu apesar da falha do cartão");
    const cv8 = await conversa(A.empresa, "staging", f8);
    assert.notEqual(cv8.oportunidade_pendente_em, null, "F8: a marca ficou para a recuperação");
    assert.equal((await q("SELECT 1 FROM whatsapp_atendimento_conversas WHERE id=$1 AND oportunidade_pendente_em > clock_timestamp() + interval '4 minutes'", [cv8.id])).rows.length, 1, "F8: adiada pela espera (r2)");
    assert.equal((await cartoes(A.empresa, [f8])).length, 0, "F8: nenhum cartão parcial");
    assert.ok(avisos.some((a) => a.includes("SQLSTATE_XX001")) && !avisos.some((a) => a.includes("falha simulada")), "F8: registro só com o código, sem a mensagem");
    await q("DROP TRIGGER harness_falha_cartao ON marketing_contatos");
    await q("DROP FUNCTION harness_falha_cartao()");
    await q("UPDATE whatsapp_atendimento_conversas SET oportunidade_pendente_em=clock_timestamp() WHERE id=$1", [cv8.id]); // a espera venceu
    await processar(aStg); // sem tarefa nova: a captura roda no fim do lote mesmo assim
    assert.equal((await conversa(A.empresa, "staging", f8)).oportunidade_pendente_em, null, "F8: recuperada no lote seguinte");
    assert.equal((await cartoes(A.empresa, [f8])).length, 1, "F8: cartão gravado na recuperação");
    assert.equal(enviados(f8), 1, "F8: a recuperação não reenvia nada");

    // F12 — cliente vinculado só com correspondência ÚNICA (com e sem 55); dois clientes = sem cliente.
    const f12u = "5561900008121", f12d = "5561900008122";
    const unico = await id("INSERT INTO clientes (nome_completo, empresa_id, telefone, whatsapp, cpf) VALUES ('Cliente único', $1, $2, $2, $3) RETURNING id::text", [A.empresa, f12u.slice(2), cpfValido()]);
    for (const nome of ["Cliente duplo 1", "Cliente duplo 2"]) await q("INSERT INTO clientes (nome_completo, empresa_id, telefone, whatsapp, cpf) VALUES ($1, $2, $3, $3, $4)", [nome, A.empresa, f12d, cpfValido()]);
    const clientesAntes = Number((await q<{ n: number }>("SELECT count(*)::int AS n FROM clientes WHERE empresa_id=$1", [A.empresa])).rows[0].n);
    await receber(aStg, f12u, FESTA);
    await receber(aStg, f12d, FESTA);
    await processar(aStg);
    const [ku] = await cartoes(A.empresa, [f12u]);
    const [kd] = await cartoes(A.empresa, [f12d]);
    assert.deepEqual([ku.cliente_id, ku.vinculo_cliente], [unico, "EXISTENTE_CONTATO"], "F12: correspondência única vincula");
    assert.deepEqual([kd.cliente_id, kd.vinculo_cliente], [null, "SEM_CLIENTE"], "F12: dois clientes = sem cliente");
    assert.equal(Number((await q<{ n: number }>("SELECT count(*)::int AS n FROM clientes WHERE empresa_id=$1", [A.empresa])).rows[0].n), clientesAntes, "F12: nenhum cliente criado");

    // F9 — nenhuma automação de Marketing em todo o percurso.
    assert.deepEqual(await fotografia(), antesMarketing, "F9: nenhuma tabela de Marketing além do contato mudou");
    assert.deepEqual((await q<{ origem: string }>("SELECT DISTINCT origem FROM marketing_saidas_contato")).rows.map((r) => r.origem), ["ATENDIMENTO_WHATSAPP"], "F9: saídas só da guarda do atendimento (127)");

    // F13 — funil e tela de atendimento (antes das exclusões).
    const consultas = carregarComponente("lib/oportunidades/consultas.ts", {
      "../marketing/atribuicao.ts": atribuicao, "./modelo.ts": modeloOportunidades, "./service.ts": { exigirSchema: async () => undefined }, "./ambiente.ts": ambienteOportunidades,
    }).modulo as typeof import("../../../oportunidades/consultas.ts");
    const funil = await withTransaction((tx) => consultas.listarOportunidades(tx, A.empresa, null, "staging"));
    // r2 — funil por ambiente: o cartão do Wall-e de production não aparece em staging, e vice-versa; sem ambiente, nenhum.
    const nomes = (l: { nome: string; origemWalle?: boolean }[]) => l.filter((o) => o.origemWalle).map((o) => o.nome);
    assert.ok(nomes(funil).includes("Cliente A staging") && !nomes(funil).includes("Cliente A production"), "F13: staging só com os seus cartões do Wall-e");
    const funilPrd = await withTransaction((tx) => consultas.listarOportunidades(tx, A.empresa, null, "production"));
    assert.deepEqual(nomes(funilPrd), ["Cliente A production"], "F13: production só com o seu");
    assert.deepEqual(nomes(await withTransaction((tx) => consultas.listarOportunidades(tx, A.empresa, null, null))), [], "F13: ambiente desconhecido não mostra cartão do Wall-e");
    const relStg = await withTransaction((tx) => consultas.relatorioFunil(tx, A.empresa, hoje, hoje, null, "staging"));
    const relPrd = await withTransaction((tx) => consultas.relatorioFunil(tx, A.empresa, hoje, hoje, null, "production"));
    const totalA = Number((await q<{ n: number }>("SELECT count(*)::int AS n FROM marketing_contatos WHERE empresa_id=$1", [A.empresa])).rows[0].n);
    assert.deepEqual([relPrd.conversoes[0].base, relStg.conversoes[0].base + relPrd.conversoes[0].base], [1, totalA], "F13: indicadores do funil cortados por ambiente");
    const perdidasStg = (await withTransaction((tx) => consultas.contadoresMes(tx, A.empresa, hoje, null, "staging"))).perdidas;
    const perdidasPrd = (await withTransaction((tx) => consultas.contadoresMes(tx, A.empresa, hoje, null, "production"))).perdidas;
    assert.deepEqual([perdidasStg > 0, perdidasPrd], [true, 0], "F13: perdas do mês cortadas por ambiente");
    const noFunil = funil.find((o) => o.nome === "Ana Souza");
    assert.ok(noFunil, "F13: cartão do Wall-e no funil");
    assert.deepEqual([noFunil.canal, noFunil.origemWalle, noFunil.conversaId], ["WHATSAPP", true, cv1.id], "F13: canal e origem Wall-e");
    assert.equal(noFunil.href, `/admin/atendimento?conversa=${cv1.id}`, "F13: link para a conversa");
    const lista = await aStg.servico.listarAtendimento(A.sessao) as unknown as { conversas?: { id: string; funil?: boolean }[] } | { id: string; funil?: boolean }[];
    const conversasLista = Array.isArray(lista) ? lista : lista.conversas ?? [];
    assert.equal(conversasLista.find((x) => x.id === cv1.id)?.funil, true, "F13: indicador na conversa com cartão aberto");
    const idSaudacao = (await conversa(A.empresa, "staging", f5.saudacao)).id;
    assert.equal(conversasLista.find((x) => x.id === idSaudacao)?.funil, false, "F13: saudação sem indicador");

    // F10 — exclusão a pedido do titular sem negociação: anonimiza; DELETE segue proibido.
    // r2 — a observação da ação do funil (pode trazer nome) sai com a anonimização.
    const acao = await id("INSERT INTO oportunidades_acoes(empresa_id,contato_id,responsavel_id,tipo,data,criada_por,observacao) VALUES($1,$2,$3,'Ligar',current_date,$3,'Ligar para a Ana Souza') RETURNING id::text", [A.empresa, k4[1].id, A.usuario]);
    const ex = await aStg.privacidade.excluirConversaAPedido(A.sessao, { conversaId: cv1.id, motivo: "PEDIDO_DO_TITULAR" });
    assert.equal((ex as { estado: string }).estado, "EXCLUIDA", "F10: conversa excluída");
    assert.deepEqual((ex as { funil?: unknown }).funil, { anonimizados: 2, preservados: 0, revisar: 0 }, "F10: totais do funil na resposta (r2)");
    assert.equal((await q<{ observacao: string | null }>("SELECT observacao FROM oportunidades_acoes WHERE id=$1", [acao])).rows[0].observacao, null, "F10: observação da ação apagada (r2)");
    const k10 = (await q<{ nome: string; telefone: string; email: string | null; mensagem: string | null; data_desejada: string | null; convidados: number | null; perda_observacao: string | null; status: string; anonimizado_em: string | null; conversa_id: string | null }>(
      `SELECT k.nome, k.telefone, k.email, k.mensagem, k.data_desejada, k.convidados, k.perda_observacao, k.status, o.anonimizado_em::text, o.conversa_id::text
       FROM marketing_contatos k JOIN whatsapp_atendimento_oportunidades o ON o.contato_id=k.id WHERE k.id = ANY($1::uuid[]) ORDER BY k.recebido_em`, [k4.map((k) => k.id)])).rows;
    assert.equal(k10.length, 2, "F10: os dois cartões da conversa continuam (sem DELETE)");
    for (const k of k10) {
      assert.deepEqual([k.nome, k.telefone, k.email, k.mensagem, k.data_desejada, k.convidados, k.perda_observacao, k.conversa_id], [NOME_ANONIMIZADO, TELEFONE_ANONIMIZADO, null, null, null, null, null, null], "F10: dados pessoais fora");
      assert.notEqual(k.anonimizado_em, null, "F10: vínculo marcado como anonimizado");
    }
    assert.deepEqual(k10.map((k) => k.status), ["DESCARTADO", "NOVO"], "F10: status e contagem preservados");
    assert.equal((await cartoes(A.empresa, [f1, f1.slice(2)])).length, 0, "F10: o telefone sumiu do funil");
    assert.equal((await withTransaction((tx) => consultas.listarOportunidades(tx, A.empresa))).some((o) => o.nome === NOME_ANONIMIZADO), false, "F10: anonimizado fora das colunas");
    await assert.rejects(q("DELETE FROM marketing_contatos WHERE id=$1", [k4[0].id]), /085: contato captado não é apagado/, "F10: DELETE continua proibido (085)");
    await assert.rejects(q("DELETE FROM whatsapp_atendimento_oportunidades WHERE contato_id=$1", [k4[0].id]), /132/, "F10: vínculo sem DELETE");
    await assert.rejects(q("UPDATE whatsapp_atendimento_oportunidades SET anonimizado_em=NULL WHERE contato_id=$1", [k4[0].id]), /132/, "F10: anonimização sem volta");

    // F11 (r2) — cliente vinculado por telefone NÃO é conversão: sem negociação, anonimiza e solta o cliente; o cadastro fica.
    const cvU = await conversa(A.empresa, "staging", f12u);
    const ex11 = await aStg.privacidade.excluirConversaAPedido(A.sessao, { conversaId: cvU.id, motivo: "PEDIDO_DO_TITULAR" });
    assert.deepEqual([(ex11 as { estado: string }).estado, (ex11 as { funil?: unknown }).funil], ["EXCLUIDA", { anonimizados: 1, preservados: 0, revisar: 0 }]);
    const [k11] = (await q<{ nome: string; telefone: string; cliente_id: string | null; vinculo_cliente: string }>("SELECT nome, telefone, cliente_id::text, vinculo_cliente FROM marketing_contatos WHERE id=$1", [ku.id])).rows;
    assert.deepEqual([k11.nome, k11.telefone, k11.cliente_id, k11.vinculo_cliente], [NOME_ANONIMIZADO, TELEFONE_ANONIMIZADO, null, "SEM_CLIENTE"], "F11: anonimizado e cliente desvinculado");
    assert.equal((await q("SELECT 1 FROM clientes WHERE id=$1 AND status='ATIVO'", [unico])).rows.length, 1, "F11: cadastro do cliente preservado");
    assert.equal((await conversa(A.empresa, "staging", f12u)), undefined, "F11: conversa apagada");
    // Convertido DE FATO (negociação no cartão): Guarda dos clientes, cartão intacto; só a conversa sai.
    const f11c = "5561900008131";
    const clienteC = await id("INSERT INTO clientes (nome_completo, empresa_id, telefone, whatsapp, cpf) VALUES ('Cliente convertido', $1, $2, $2, $3) RETURNING id::text", [A.empresa, f11c, cpfValido()]);
    await receber(aStg, f11c, FESTA, "Convertido");
    await processar(aStg);
    const [kc] = await cartoes(A.empresa, [f11c]);
    assert.equal(kc.cliente_id, clienteC, "F11: cartão com o cliente único");
    // Negociação sintética na ordem das entradas reais: a trava da configuração da agenda antes das datas (114).
    await q("BEGIN");
    await travarConfiguracaoAgenda(executor(c as never), A.empresa, { modo: "COMPARTILHADA", linha: "KEY_SHARE" });
    const negociacao = await fechamento(c as never, A.empresa, await comercial(c as never, A.empresa), clienteC, { data: DATA });
    await q("UPDATE marketing_contatos SET fechamento_id=$2 WHERE id=$1", [kc.id, negociacao]);
    await q("COMMIT");
    const ex11c = await aStg.privacidade.excluirConversaAPedido(A.sessao, { conversaId: (await conversa(A.empresa, "staging", f11c)).id, motivo: "PEDIDO_DO_TITULAR" });
    assert.deepEqual((ex11c as { funil?: unknown }).funil, { anonimizados: 0, preservados: 1, revisar: 0 }, "F11: convertido contado como preservado");
    const [kc2] = await cartoes(A.empresa, [f11c]);
    assert.deepEqual([kc2.nome, kc2.telefone, kc2.cliente_id, kc2.anonimizado_em, kc2.conversa_id], ["Convertido", f11c, clienteC, null, null], "F11: convertido intacto; só a conversa saiu");
    // Decisão da empresa: só a conversa sai; o cartão fica com o vínculo solto.
    const cvD = await conversa(A.empresa, "staging", f12d);
    await aStg.privacidade.excluirConversaAPedido(A.sessao, { conversaId: cvD.id, motivo: "DECISAO_DA_EMPRESA" });
    const [k11d] = await cartoes(A.empresa, [f12d]);
    assert.deepEqual([k11d.telefone, k11d.anonimizado_em, k11d.conversa_id], [f12d, null, null], "F11: decisão da empresa não anonimiza");
    // r2 — a 132 só deixa SOLTAR a conversa do vínculo: nem trocar por outra, nem religar a que ficou nula.
    const outra = await id(`INSERT INTO whatsapp_atendimento_conversas (empresa_id, ambiente, contato) VALUES ($1, 'staging', '5561900008400') RETURNING id::text`, [A.empresa]);
    await assert.rejects(q("UPDATE whatsapp_atendimento_oportunidades SET conversa_id=$2 WHERE contato_id=$1", [k11d.id, outra]), /132/, "F16: vínculo solto não religa");
    const kAtivo = (await cartoes(A.empresa, [f6])).find((k) => k.ambiente === "staging")!;
    await assert.rejects(q("UPDATE whatsapp_atendimento_oportunidades SET conversa_id=$2 WHERE contato_id=$1", [kAtivo.id, outra]), /132/, "F16: conversa do vínculo não é trocada");
    // r2 — o titular volta por OUTRA conversa (com 55 trocado) e pede exclusão: o cartão de vínculo solto (conversa nula)
    // do mesmo número também é anonimizado.
    const cvVolta = await id(`INSERT INTO whatsapp_atendimento_conversas (empresa_id, ambiente, contato) VALUES ($1, 'staging', $2) RETURNING id::text`, [A.empresa, f12d.slice(2)]);
    const exD = await aStg.privacidade.excluirConversaAPedido(A.sessao, { conversaId: cvVolta, motivo: "PEDIDO_DO_TITULAR" });
    assert.deepEqual((exD as { funil?: unknown }).funil, { anonimizados: 1, preservados: 0, revisar: 0 }, "F17: alcança o cartão da outra variante, de conversa nula");
    assert.equal((await q<{ telefone: string }>("SELECT telefone FROM marketing_contatos WHERE id=$1", [k11d.id])).rows[0].telefone, TELEFONE_ANONIMIZADO, "F17: anonimizado");
    // A exclusão em A não tocou B.
    assert.deepEqual((await cartoes(B.empresa, [f6])).map((k) => k.nome), ["Cliente B staging"], "F11: B intacta");
    assert.deepEqual(await fotografia(), antesMarketing, "F9: exclusões também sem automação de Marketing");

    // F20 (r3) — exclusão pela variante sem 55 com a conversa irmã (com 55) viva e marcada: o vínculo solta a conversa,
    // a marca da irmã é descartada (a captura seguinte não recria) e o resumo guardado que cita o cartão é trocado.
    const f20 = "5561900008500";
    await receber(aStg, f20, FESTA, "Bia Irmã");
    await processar(aStg);
    const cv20 = await conversa(A.empresa, "staging", f20);
    const [k20] = await cartoes(A.empresa, [f20]);
    assert.equal(k20.conversa_id, cv20.id, "F20: cartão ligado à conversa com 55");
    const acao20 = await id("INSERT INTO oportunidades_acoes(empresa_id,contato_id,responsavel_id,tipo,data,criada_por,observacao) VALUES($1,$2,$3,'Ligar',current_date,$3,'Retornar para a Bia') RETURNING id::text", [A.empresa, k20.id, A.usuario]);
    const textoResumo = "Bom dia. Ligar hoje: Bia Irmã";
    for (const [dia, estado] of [["current_date", "PENDENTE"], ["current_date - 1", "ENVIADO"]] as const)
      await q(`INSERT INTO oportunidades_resumos(empresa_id,usuario_id,dia,mensagem,estado) VALUES($1,$2,${dia},$3::jsonb,$4)`, [A.empresa, A.usuario,
        JSON.stringify({ mensagem: { para: "equipe@example.test", assunto: "Resumo", texto: textoResumo, html: "<p>" + textoResumo + "</p>", idempotencia: cod("r") }, acoes: [acao20] }), estado]);
    await q("UPDATE whatsapp_atendimento_conversas SET oportunidade_pendente_em=clock_timestamp() WHERE id=$1", [cv20.id]);
    const cv20b = await id(`INSERT INTO whatsapp_atendimento_conversas (empresa_id, ambiente, contato) VALUES ($1, 'staging', $2) RETURNING id::text`, [A.empresa, f20.slice(2)]);
    const ex20 = await aStg.privacidade.excluirConversaAPedido(A.sessao, { conversaId: cv20b, motivo: "PEDIDO_DO_TITULAR" });
    assert.deepEqual((ex20 as { funil?: unknown }).funil, { anonimizados: 1, preservados: 0, revisar: 0 }, "F20: totais");
    const [v20] = (await q<{ conversa_id: string | null; anonimizado_em: string | null }>("SELECT conversa_id::text, anonimizado_em::text FROM whatsapp_atendimento_oportunidades WHERE contato_id=$1", [k20.id])).rows;
    assert.deepEqual([v20.conversa_id, v20.anonimizado_em !== null], [null, true], "F20: vínculo solto da conversa irmã ainda viva");
    assert.equal((await conversa(A.empresa, "staging", f20)).oportunidade_pendente_em, null, "F20: marca da irmã descartada");
    await capturarOportunidadesPendentes(withTransaction, "staging");
    assert.equal((await q("SELECT 1 FROM whatsapp_atendimento_oportunidades WHERE conversa_id=$1", [cv20.id])).rows.length, 0, "F20: nenhum cartão recriado");
    assert.equal((await cartoes(A.empresa, [f20, f20.slice(2)])).length, 0, "F20: o telefone sumiu do funil");
    const resumos20 = (await q<{ estado: string; texto: string; html: string }>("SELECT estado, mensagem->'mensagem'->>'texto' AS texto, mensagem->'mensagem'->>'html' AS html FROM oportunidades_resumos WHERE empresa_id=$1 AND mensagem->'acoes' ? $2 ORDER BY dia", [A.empresa, acao20])).rows;
    assert.deepEqual(resumos20.map((r) => [r.estado, r.texto, r.html]), [["ENVIADO", RESUMO_ANONIMIZADO, RESUMO_ANONIMIZADO], ["OBSOLETO", RESUMO_ANONIMIZADO, RESUMO_ANONIMIZADO]], "F20: resumo trocado; o pendente não sai");

    // F21–F23 (r3) — Origens dos contatos e entradas do site e manual, com o ambiente deste deploy.
    const ambienteAntes = process.env.KIDMAIS_DEPLOY_ENV;
    process.env.KIDMAIS_DEPLOY_ENV = "staging";
    try {
      const cacheMarketing = new Map();
      const semSavepoint = { "db/postgres": { db: () => executor(c as never), withTransaction: async (w: (tx: unknown) => unknown) => w(executor(c as never)) } };
      const contatos = carregarComBanco("lib/marketing/contatos.ts", c as never, () => null, semSavepoint, cacheMarketing) as unknown as typeof import("../../../marketing/contatos.ts");
      const sites = carregarComBanco("lib/marketing/site/servico.ts", c as never, () => null, semSavepoint, cacheMarketing) as unknown as typeof import("../../../marketing/site/servico.ts");
      const txc = executor(c as never);
      const kA = await cartoes(A.empresa, [f6]);
      const kStg = kA.find((k) => k.ambiente === "staging")!, kPrd = kA.find((k) => k.ambiente === "production")!;
      const listaStg = await contatos.listarContatos(txc, A.empresa, {});
      assert.deepEqual([listaStg.some((k) => k.id === kStg.id), listaStg.some((k) => k.id === kPrd.id)], [true, false], "F21: Origens em staging sem o cartão do Wall-e de production");
      await assert.rejects(contatos.detalheContato(txc, A.empresa, kPrd.id), /não encontrado/i, "F21: detalhe do cartão de production recusado em staging");
      const listaPrd = await contatos.listarContatos(txc, A.empresa, {}, "production");
      assert.deepEqual([listaPrd.some((k) => k.id === kStg.id), listaPrd.some((k) => k.id === kPrd.id)], [false, true], "F21: e o inverso em production");

      // F22 — o pedido do site depois do Wall-e completa o cartão aberto (sem 2º cartão); repetição não duplica nada.
      const f22 = "5561900008600";
      await receber(aStg, f22, FESTA, "Caio WhatsApp");
      await processar(aStg);
      const [k22] = await cartoes(A.empresa, [f22]);
      await q("BEGIN"); // criarSite usa SAVEPOINT próprio
      const site = (await sites.criarSite(txc, A.empresa, A.usuario, null, cod("r3-site-"))).id;
      await q("COMMIT");
      const escopo = { siteId: site, empresaId: A.empresa, estabelecimentoId: null };
      const entrada = { nome: "Caio pelo site", telefone: f22.slice(2), email: "caio@example.test", dataDesejada: null, convidados: null, mensagem: "quero visitar", chave: cod("pedido-site-r3-") };
      const captura = { codigoCampanha: null, utm: {}, descartados: [] } as never;
      const s1 = await contatos.capturarContatoPublico(txc, escopo, entrada, captura);
      const s2 = await contatos.capturarContatoPublico(txc, escopo, entrada, captura);
      const s3 = await contatos.capturarContatoPublico(txc, escopo, { ...entrada, chave: cod("pedido-site-r3-") }, captura);
      assert.deepEqual([s1, s2, s3], [{ contatoId: k22.id, repetido: false }, { contatoId: k22.id, repetido: true }, { contatoId: k22.id, repetido: true }], "F22: site completa o cartão do Wall-e");
      const k22b = (await q<{ n: number; nome: string; email: string; mensagem: string; data: string; convidados: number; canal: string }>(
        "SELECT count(*) OVER ()::int AS n, nome, email, mensagem, data_desejada::text AS data, convidados, canal_atendimento AS canal FROM marketing_contatos WHERE empresa_id=$1 AND telefone = ANY($2::text[])", [A.empresa, [f22, f22.slice(2)]])).rows;
      assert.deepEqual(k22b.map((k) => [k.n, k.nome, k.email, k.mensagem, k.data, k.convidados, k.canal]), [[1, "Caio pelo site", "caio@example.test", "quero visitar", DATA, 60, "WHATSAPP"]], "F22: um cartão, dados somados");
      assert.equal((await q("SELECT 1 FROM marketing_atribuicoes WHERE empresa_id=$1 AND alvo_tipo='CONTATO' AND alvo_id=$2", [A.empresa, k22.id])).rows.length, 1, "F22: uma origem, a do site");

      // F22/F23 — o registro manual depois do Wall-e também completa o cartão; a origem informada leva texto da equipe,
      // e a exclusão a pedido do titular anonimiza o cartão e o conta em revisar (a 085 não deixa apagar a origem).
      const f23 = "5561900008601";
      await receber(aStg, f23, FESTA, "Duda WhatsApp");
      await processar(aStg);
      const [k23] = await cartoes(A.empresa, [f23]);
      const m1 = await contatos.executarAcaoContato(txc, A.empresa, A.usuario, contatos.esquemaAcaoContato.parse({ acao: "registrar", nome: "Duda manual", telefone: f23, canal: "WHATSAPP", origemCodigo: "INSTAGRAM", detalhe: "Indicação da Duda Souza", chave: cod("contato-manual-r3-") }));
      assert.deepEqual(m1, { id: k23.id, repetido: false }, "F22: manual completa o cartão do Wall-e");
      const k23b = await cartoes(A.empresa, [f23, f23.slice(2)]);
      assert.deepEqual([k23b.length, k23b[0].nome, k23b[0].status], [1, "Duda manual", "EM_ATENDIMENTO"], "F22: um cartão, em atendimento");
      const ex23 = await aStg.privacidade.excluirConversaAPedido(A.sessao, { conversaId: (await conversa(A.empresa, "staging", f23)).id, motivo: "PEDIDO_DO_TITULAR" });
      assert.deepEqual((ex23 as { funil?: unknown }).funil, { anonimizados: 0, preservados: 0, revisar: 1 }, "F23: origem com texto da equipe = revisar");
      assert.equal((await q<{ telefone: string }>("SELECT telefone FROM marketing_contatos WHERE id=$1", [k23.id])).rows[0].telefone, TELEFONE_ANONIMIZADO, "F23: anonimizado mesmo assim");
    } finally {
      if (ambienteAntes === undefined) delete process.env.KIDMAIS_DEPLOY_ENV; else process.env.KIDMAIS_DEPLOY_ENV = ambienteAntes;
    }

    // F18 (r2) — "Ver conversa" do funil abre a conversa mesmo fora das 100 mais recentes.
    await q(`INSERT INTO whatsapp_atendimento_conversas (empresa_id, ambiente, contato, atualizada_em)
      SELECT $1, 'staging', '55619100' || lpad(i::text, 5, '0'), clock_timestamp() + make_interval(mins => i) FROM generate_series(1, 100) i`, [A.empresa]);
    const antiga = (await conversa(A.empresa, "staging", f6)).id;
    const semPedido = (await aStg.servico.listarAtendimento(A.sessao)).conversas;
    assert.deepEqual([semPedido.length, semPedido.some((x) => x.id === antiga)], [100, false], "F18: fora das 100 mais recentes");
    const comPedido = (await aStg.servico.listarAtendimento(A.sessao, antiga)).conversas;
    assert.deepEqual([comPedido.length, comPedido.some((x) => x.id === antiga)], [100, true], "F18: a conversa pedida entra");
    const datas = comPedido.map((x) => new Date(x.atualizada_em as never).getTime());
    assert.deepEqual(datas, [...datas].sort((a, b) => b - a), "F18: a ordem da tela segue a de antes");
    // id fora do formato: a rota (app/api/admin/atendimento) já devolve 400 antes do serviço (z.uuid).

    // F19 (r3) — com vínculo gravado, o down é recusado MESMO com a confirmação (correção para frente); nada muda. A chave
    // do cartão segue durável: marca nova da mesma conversa não colide com a do cartão anterior (instante, não contagem).
    const vinculosAntes = (await q<{ n: number }>("SELECT count(*)::int AS n FROM whatsapp_atendimento_oportunidades")).rows[0].n;
    await q("SET kidmais.rollback_132 = 'descartar-vinculos'");
    await assert.rejects(q(ler(DOWN)), /já há vínculo do Wall-e gravado/, "F19: down recusado com vínculo");
    await q("ROLLBACK");
    await q("RESET kidmais.rollback_132");
    assert.equal((await q<{ n: number }>("SELECT count(*)::int AS n FROM whatsapp_atendimento_oportunidades")).rows[0].n, vinculosAntes, "F19: vínculos intactos");
    assert.equal((await q("SELECT 1 FROM pg_attribute WHERE attrelid='whatsapp_atendimento_conversas'::regclass AND attname='oportunidade_pendente_em' AND NOT attisdropped")).rows.length, 1, "F19: coluna intacta");
    const cvA6 = await conversa(A.empresa, "staging", f6);
    await q("UPDATE marketing_contatos SET status='DESCARTADO', perda_motivo='Preço', perdida_em=clock_timestamp() WHERE empresa_id=$1 AND telefone=$2 AND status IN ('NOVO','EM_ATENDIMENTO')", [A.empresa, f6]);
    await q("UPDATE whatsapp_atendimento_conversas SET oportunidade_pendente_em=clock_timestamp() WHERE id=$1", [cvA6.id]);
    assert.equal(await withTransaction((tx) => capturarOportunidade(tx, cvA6.id)), "CRIADO", "F19: cartão novo na mesma conversa, sem colisão");
    const k19 = await cartoes(A.empresa, [f6]);
    assert.equal(new Set(k19.map((k) => k.chave_idempotencia)).size, k19.length, "F19: chaves distintas");
  } finally {
    await c.end();
  }
});
