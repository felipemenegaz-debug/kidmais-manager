import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Client } from "pg";
import type { SessaoParaTenant } from "../../saas/provar-tenant.ts";
import { conectarDescartavel, encerrarDescartavel, semTransacaoExplicita } from "../../comercial/postgres-descartavel.ts";
import { carregarAtendimento, cod, noPrazo } from "./harness-postgres.ts";
import type { ConteudoSaida } from "./transporte.ts";

/**
 * Migration 081 (fotos e vídeos nas mensagens prontas e na resposta do atendente; atalhos de salgados, bolos, endereço
 * e localização) no PostgreSQL descartável. Só roda pelo check:v1:postgres, com KIDMAIS_POSTGRES_DESCARTAVEL, no
 * cluster descartável e com autorização explícita do Felipe (docs/OPERACAO_AGENTES.md). Dados sintéticos; URLs .test
 * (nunca resolvidas); Gupshup e modelo são portas simuladas: nenhuma chamada de rede.
 * Serviço, biblioteca e worker REAIS, numa conexão por transação.
 *
 * Roteiro:
 *  0. ordem: 081 sem a 060 e sem a 080 é recusada;
 *  1. só 060 + 080: biblioteca e envio de mídia indisponíveis (mensagem clara), texto segue funcionando;
 *  2. aplicação da 081 + postcheck; reaplicação recusada; regras do banco nas prontas (URL por tipo, https, legenda);
 *  3. cadastro pela biblioteca: foto, vídeo e os atalhos novos; recusas do formulário (extensão, IP, URL em texto);
 *     regras do banco nas mensagens (só saída, par, legenda, origem obrigatória com a mídia);
 *  4. isolamento: foto de outra empresa e de outro ambiente invisíveis, sem rascunho e sem envio; a FK composta recusa
 *     origem de outra empresa mesmo por SQL direto;
 *  5. rascunho de foto: legenda + mídia + versão para conferência; nada gravado;
 *  6. envio: URL da pronta (lida no servidor) na versão da prévia, origem gravada; legenda opcional e limitada; pronta
 *     de texto recusada; arquivada depois da prévia recusada; mudança DEPOIS do pedido não altera o que foi pedido;
 *  7. worker com transporte simulado: foto e vídeo saem uma vez cada, com o conteúdo da linha; modelo não é chamado;
 *  8. PARAR e janela de 24 h: mídia na fila é cancelada antes do provedor; novo envio recusado;
 *  8b. ENTRE A PRÉVIA E O ENVIO: pronta editada → envio recusado, nada gravado; nova prévia → envio com a mídia nova;
 *     edição EM ANDAMENTO durante o envio: o envio espera a edição terminar e é recusado (não troca a mídia);
 *  9. rollback: a FK impede apagar pronta referenciada; o down da 080 recusa com a 081 (guarda explícita); down da 081 recusa
 *     com mídia na fila (mesmo com as decisões), sem a decisão sobre mídias enviadas e sem a decisão sobre as prontas;
 *     com as duas, remove só a 081 (prontas de mídia e favoritas delas; atalhos novos vazios); pós-rollback; o
 *     atendimento segue (sem cache); reaplicável.
 */
const ler = (f: string) => readFileSync(f, "utf8");
const UP060 = ler("database/migrations/20261001_060_whatsapp_atendimento.sql");
const POST060 = ler("database/checks/20261001_060_postcheck.sql");
const DOWN060 = ler("database/rollback/20261001_060_whatsapp_atendimento_down.sql");
const UP080 = ler("database/migrations/20261011_080_whatsapp_mensagens_prontas.sql");
const POST080 = ler("database/checks/20261011_080_postcheck.sql");
const DOWN080 = ler("database/rollback/20261011_080_whatsapp_mensagens_prontas_down.sql");
const UP = ler("database/migrations/20261011_081_whatsapp_prontas_midia.sql");
const POST = ler("database/checks/20261011_081_postcheck.sql");
const DOWN = ler("database/rollback/20261011_081_whatsapp_prontas_midia_down.sql");
const POS_DOWN = ler("database/checks/20261011_081_rollback_postcheck.sql");
const comDecisoes = (sql: string, ...chaves: string[]) => sql.replace("SET LOCAL statement_timeout = '60s';", ["SET LOCAL statement_timeout = '60s';", ...chaves.map((k) => `SET LOCAL ${k} = 'sim';`)].join("\n"));
const MIDIAS = "kidmais.rollback_081_descartar_midias", PRONTAS = "kidmais.rollback_081_descartar_prontas_midia";

async function recusa(c: Client, sql: string, v: unknown[], motivo: RegExp) {
  await c.query("BEGIN");
  await assert.rejects(c.query(sql, v), motivo);
  await c.query("ROLLBACK");
}
const zod = (e: Error) => e.name === "ZodError";

const SENHA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;
/** Empresas e usuários sintéticos (membership ATIVA), no mesmo padrão das suítes 060/080. */
function fixtures(c: Client) {
  const id = async (sql: string, v: unknown[]) => (await c.query<{ id: string }>(sql, v)).rows[0].id;
  const empresa = async (nome: string) => {
    const e = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id`, [cod("wa"), nome]);
    await c.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [e]);
    return e;
  };
  const usuario = async (papel: string, empresaId: string) => {
    const u = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness 081', $2, $3, true) RETURNING id`, [`${cod("u")}@example.test`, SENHA, papel]);
    const m = await id(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), $3) RETURNING id`, [empresaId, u, papel]);
    await c.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
    return { usuario_id: u, papel } as SessaoParaTenant;
  };
  return { empresa, usuario };
}

test("081: fotos e vídeos — ordem, aplicação, cadastro, isolamento, envio preso à prévia, worker simulado, PARAR/janela e rollback", { timeout: 300_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  const c = await conectarDescartavel();
  try {
    // 0. Ordem.
    assert.equal((await c.query("SELECT to_regclass('public.whatsapp_atendimento_conversas') AS t")).rows[0].t, null, "descartável começa sem a 060");
    await assert.rejects(c.query(UP), /081 exige a 060/); await c.query("ROLLBACK").catch(() => {});
    await c.query(UP060); await c.query(POST060);
    await assert.rejects(c.query(UP), /081 exige a 060 \(atendimento WhatsApp\) e a 080/, "com a 060 e sem a 080 também recusa"); await c.query("ROLLBACK").catch(() => {});
    await c.query(UP080); await c.query(POST080);

    const f = fixtures(c);
    const A = await f.empresa("Empresa sintética A (081)"), B = await f.empresa("Empresa sintética B (081)");
    const repA = await f.usuario("REPRESENTANTE_AUTORIZADO", A), atendA = await f.usuario("ADMINISTRATIVO", A), repB = await f.usuario("REPRESENTANTE_AUTORIZADO", B);
    const { servico, worker, biblioteca } = carregarAtendimento(A);
    await servico.salvarConfiguracao(repA, { ativo: true, nome: "Empresa sintética A", perguntas: [] });
    const conversa = async (contato: string) => (await c.query("SELECT * FROM whatsapp_atendimento_conversas WHERE empresa_id = $1 AND contato = $2", [A, contato])).rows[0];
    const entrar = (contato: string, texto: string) => servico.receberEntrada({ id: cod("evt-"), app: "KidmaisManager", source: contato, texto, timestamp: Date.now() });
    const controlar = async (contato: string, acao: "assumir" | "enviar" | "encerrar", extra: { texto?: string; prontaMidiaId?: string; prontaVersao?: number } = {}) => {
      const cv = await conversa(contato);
      return servico.controlarAtendimento(atendA, { acao, conversaId: cv.id, versao: Number(cv.versao), ...extra });
    };
    // Caminho da tela: a prévia devolve a mídia com a versão vista; o envio leva o id e essa versão.
    const previa = async (contato: string, id: string) => (await biblioteca.prepararRascunho(atendA, { conversaId: (await conversa(contato)).id, id })).midia!;
    const enviarMidia = (contato: string, m: { prontaId: string; versao: number }, texto?: string) => controlar(contato, "enviar", { prontaMidiaId: m.prontaId, prontaVersao: m.versao, ...(texto ? { texto } : {}) });
    const saidas = async (contato: string) => (await c.query("SELECT estado, texto, midia_tipo, midia_url, autor_usuario_id FROM whatsapp_atendimento_mensagens WHERE conversa_id = $1 AND direcao = 'SAIDA' ORDER BY criada_em, id", [(await conversa(contato)).id])).rows;
    const origem = async (contato: string) => (await c.query("SELECT midia_pronta_id, midia_pronta_versao::int AS versao, midia_url FROM whatsapp_atendimento_mensagens WHERE conversa_id = $1 AND direcao = 'SAIDA' ORDER BY criada_em, id", [(await conversa(contato)).id])).rows;
    const contagem = async (sql: string, v: unknown[] = []) => Number((await c.query(sql, v)).rows[0].n);
    const versaoDe = async (id: string) => Number((await c.query("SELECT versao FROM whatsapp_atendimento_mensagens_prontas WHERE id = $1", [id])).rows[0].versao);
    const FOTO = "https://midia.exemplo.test/salgados.jpg", VIDEO = "https://midia.exemplo.test/bolos.mp4";

    // 1. Só 060 + 080: mídia e atalhos novos indisponíveis, com o motivo; texto segue funcionando.
    assert.equal((await biblioteca.listarProntas(repA)).recursos081, false);
    await assert.rejects(biblioteca.salvarPronta(repA, { titulo: "Salgados", categoria: "Cardápio", tipo: "IMAGEM", texto: "Nossos salgados.", link: null, atalho: "SALGADOS", midiaUrl: FOTO }), /ATENDIMENTO_MIDIA_INDISPONIVEL/);
    await assert.rejects(biblioteca.salvarPronta(repA, { titulo: "Endereço", categoria: "Informações", tipo: "TEXTO", texto: "Rua sintética, 1.", link: null, atalho: "ENDERECO" }), /ATENDIMENTO_MIDIA_INDISPONIVEL/, "atalho novo também depende da 081");
    const boasVindas = (await biblioteca.salvarPronta(repA, { titulo: "Boas-vindas", categoria: "Geral", tipo: "TEXTO", texto: "Olá! Como posso ajudar?", link: null, atalho: null })).id;
    await entrar("5561900000601", "Oi"); await controlar("5561900000601", "assumir");
    await assert.rejects(controlar("5561900000601", "enviar", { prontaMidiaId: boasVindas, prontaVersao: 0, texto: "x" }), /ATENDIMENTO_MIDIA_INDISPONIVEL/, "sem a 081 o envio de mídia é recusado");
    assert.deepEqual((await servico.listarAtendimento(atendA, (await conversa("5561900000601")).id)).mensagens.map((m) => [m.direcao, m.midia_tipo, m.midia_url]), [["ENTRADA", null, null]], "sem a 081 a tela lista sem mídia e sem erro");

    // 2. Aplicação + regras do banco nas prontas.
    await c.query(UP); await c.query(POST);
    await assert.rejects(c.query(semTransacaoExplicita(UP)), /081 já aplicada/); await c.query("ROLLBACK").catch(() => {});
    const insP = `INSERT INTO whatsapp_atendimento_mensagens_prontas (empresa_id, ambiente, titulo, categoria, tipo, texto, atalho, midia_url, criada_por, atualizada_por) VALUES ($1, 'staging', $2, 'Teste', $3, $4, $5, $6, $7, $7)`;
    await recusa(c, insP, [A, cod("t"), "IMAGEM", "x", null, null, repA.usuario_id], /whatsapp_prontas_midia_por_tipo/);
    await recusa(c, insP, [A, cod("t"), "TEXTO", "x", null, FOTO, repA.usuario_id], /whatsapp_prontas_midia_por_tipo/);
    await recusa(c, insP, [A, cod("t"), "VIDEO", "x", null, "http://midia.exemplo.test/v.mp4", repA.usuario_id], /whatsapp_prontas_midia_url_formato/);
    await recusa(c, insP, [A, cod("t"), "IMAGEM", "x".repeat(1025), null, FOTO, repA.usuario_id], /whatsapp_prontas_legenda_limite/);
    await recusa(c, insP, [A, cod("t"), "TEXTO", "x", "OUTRO", null, repA.usuario_id], /whatsapp_prontas_atalho/);
    const c601 = (await conversa("5561900000601")).id;

    // 3. Cadastro pela biblioteca (representante): foto, vídeo e os quatro atalhos novos.
    const salvar = (s: SessaoParaTenant, p: Record<string, unknown>) => biblioteca.salvarPronta(s, { categoria: "Cardápio", link: null, atalho: null, midiaUrl: null, ...p });
    const foto = (await salvar(repA, { titulo: "Salgados da casa", tipo: "IMAGEM", texto: "Nossos salgados.", atalho: "SALGADOS", midiaUrl: FOTO })).id;
    const video = (await salvar(repA, { titulo: "Bolos", tipo: "VIDEO", texto: "Conheça nossos bolos.", atalho: "BOLOS", midiaUrl: VIDEO })).id;
    const endereco = (await salvar(repA, { titulo: "Endereço", categoria: "Informações", tipo: "TEXTO", texto: "Rua sintética, 100.", atalho: "ENDERECO" })).id;
    const localizacao = (await salvar(repA, { titulo: "Localização", categoria: "Informações", tipo: "LINK", texto: "Como chegar:", link: "https://mapa.exemplo.test/kidmais", atalho: "LOCALIZACAO" })).id;
    await assert.rejects(salvar(repA, { titulo: "Foto errada", tipo: "IMAGEM", texto: "x", midiaUrl: "https://midia.exemplo.test/video.mp4" }), zod, "extensão de vídeo em foto");
    await assert.rejects(salvar(repA, { titulo: "Foto por IP", tipo: "IMAGEM", texto: "x", midiaUrl: "https://10.0.0.8/foto.jpg" }), zod, "host IP");
    await assert.rejects(salvar(repA, { titulo: "Texto com mídia", tipo: "TEXTO", texto: "x", midiaUrl: FOTO }), zod, "só foto/vídeo levam link de mídia");
    await assert.rejects(salvar(atendA, { titulo: "Do atendente", tipo: "IMAGEM", texto: "x", midiaUrl: FOTO }), /ATENDIMENTO_ACESSO_NEGADO/);
    await assert.rejects(salvar(repA, { titulo: "Outros salgados", tipo: "IMAGEM", texto: "x", atalho: "SALGADOS", midiaUrl: FOTO }), /ATENDIMENTO_PRONTA_ATALHO_EM_USO/);
    let lista = await biblioteca.listarProntas(atendA);
    assert.equal(lista.recursos081, true);
    assert.deepEqual(lista.prontas.map((p) => [p.titulo, p.atalho, p.midia_url]), [["Bolos", "BOLOS", VIDEO], ["Endereço", "ENDERECO", null], ["Localização", "LOCALIZACAO", null], ["Salgados da casa", "SALGADOS", FOTO], ["Boas-vindas", null, null]], "atalhos primeiro; URL da mídia na lista");
    // Regras do banco nas mensagens: só saída, par tipo/URL, legenda, e a origem (pronta + versão) junto com a mídia.
    const insM = `INSERT INTO whatsapp_atendimento_mensagens (conversa_id, empresa_id, ambiente, externa_id, direcao, texto, estado, versao_conversa, autor_usuario_id, midia_tipo, midia_url, midia_pronta_id, midia_pronta_versao) VALUES ($1, $2, 'staging', $3, $4, $5, $6, 1, $7, $8, $9, $10, $11)`;
    await recusa(c, insM, [c601, A, "ext-081", "ENTRADA", "x", "PROCESSADA", null, "IMAGEM", FOTO, foto, 0], /whatsapp_mensagens_midia_so_saida/);
    await recusa(c, insM, [c601, A, null, "SAIDA", "x", "PENDENTE", atendA.usuario_id, "VIDEO", null, video, 0], /whatsapp_mensagens_midia_par/);
    await recusa(c, insM, [c601, A, null, "SAIDA", "x".repeat(1025), "PENDENTE", atendA.usuario_id, "IMAGEM", FOTO, foto, 0], /whatsapp_mensagens_legenda_limite/);
    await recusa(c, insM, [c601, A, null, "SAIDA", "x", "PENDENTE", atendA.usuario_id, "IMAGEM", FOTO, null, null], /whatsapp_mensagens_midia_origem/);
    await recusa(c, insM, [c601, A, null, "SAIDA", "x", "PENDENTE", atendA.usuario_id, null, null, foto, 0], /whatsapp_mensagens_midia_origem/);
    await recusa(c, insM, [c601, A, null, "SAIDA", "x", "PENDENTE", atendA.usuario_id, "IMAGEM", FOTO, foto, -1], /whatsapp_mensagens_midia_pronta_versao/);

    // 4. Isolamento: outra empresa e outro ambiente.
    const insIso = `INSERT INTO whatsapp_atendimento_mensagens_prontas (empresa_id, ambiente, titulo, categoria, tipo, texto, midia_url, criada_por, atualizada_por) VALUES ($1, $2, $3, 'Isolamento', 'IMAGEM', 'x', $4, $5, $5) RETURNING id`;
    const deB = (await c.query<{ id: string }>(insIso, [B, "staging", "Foto de B", "https://midia.exemplo.test/b.jpg", repB.usuario_id])).rows[0].id;
    const deProducao = (await c.query<{ id: string }>(insIso, [A, "production", "Foto de producao", "https://midia.exemplo.test/p.jpg", repA.usuario_id])).rows[0].id;
    lista = await biblioteca.listarProntas(atendA);
    assert.ok(!lista.prontas.some((p) => p.id === deB || p.id === deProducao) && !JSON.stringify(lista).includes("midia.exemplo.test/b.jpg"), "outra empresa e outro ambiente invisíveis");
    await assert.rejects(biblioteca.listarProntas(repB), /ATENDIMENTO_SEM_ACESSO/, "usuário só de B não acessa a biblioteca do piloto A");
    for (const id of [deB, deProducao]) {
      await assert.rejects(biblioteca.prepararRascunho(atendA, { conversaId: c601, id }), /ATENDIMENTO_PRONTA_NAO_ENCONTRADA/);
      await assert.rejects(controlar("5561900000601", "enviar", { prontaMidiaId: id, prontaVersao: 0 }), /ATENDIMENTO_PRONTA_NAO_ENCONTRADA/, "mesmo com a versão certa");
    }
    // A FK composta impede origem de outra empresa/ambiente até por SQL direto.
    await recusa(c, insM, [c601, A, null, "SAIDA", "x", "PENDENTE", atendA.usuario_id, "IMAGEM", "https://midia.exemplo.test/b.jpg", deB, 0], /whatsapp_mensagens_midia_pronta/);
    await recusa(c, insM, [c601, A, null, "SAIDA", "x", "PENDENTE", atendA.usuario_id, "IMAGEM", "https://midia.exemplo.test/p.jpg", deProducao, 0], /whatsapp_mensagens_midia_pronta/);

    // 5. Rascunho de foto: legenda + mídia + versão; nada gravado.
    const antes = await contagem("SELECT count(*) AS n FROM whatsapp_atendimento_mensagens");
    assert.deepEqual(await biblioteca.prepararRascunho(atendA, { conversaId: c601, id: foto }), { titulo: "Salgados da casa", texto: "Nossos salgados.", linkIndividual: null, aviso: null, midia: { tipo: "IMAGEM", url: FOTO, prontaId: foto, versao: 0 } });
    assert.deepEqual(await biblioteca.prepararRascunho(atendA, { conversaId: c601, id: endereco }), { titulo: "Endereço", texto: "Rua sintética, 100.", linkIndividual: null, aviso: null }, "texto não leva mídia");
    assert.equal(await contagem("SELECT count(*) AS n FROM whatsapp_atendimento_mensagens"), antes, "rascunho não grava nem envia");

    // 6. Envio pelo serviço: URL da pronta na versão da prévia, origem gravada, legenda opcional e limitada.
    await assert.rejects(controlar("5561900000601", "enviar", { prontaMidiaId: endereco, prontaVersao: 0, texto: "x" }), /ATENDIMENTO_PRONTA_NAO_ENCONTRADA/, "pronta de texto não é mídia");
    const arquivada = (await salvar(repA, { titulo: "Foto antiga", tipo: "IMAGEM", texto: "x", midiaUrl: "https://midia.exemplo.test/antiga.png" })).id;
    const previaArquivada = await previa("5561900000601", arquivada);
    await biblioteca.arquivarPronta(repA, { id: arquivada, versao: 0 });
    await assert.rejects(enviarMidia("5561900000601", previaArquivada), /ATENDIMENTO_PRONTA_MIDIA_ALTERADA/, "arquivada depois da prévia");
    await assert.rejects(enviarMidia("5561900000601", await previa("5561900000601", foto), "x".repeat(1025)), /ATENDIMENTO_LEGENDA_LONGA/);
    assert.equal(await contagem("SELECT count(*) AS n FROM whatsapp_atendimento_mensagens WHERE direcao = 'SAIDA'"), 0, "recusas não gravam nada");
    await enviarMidia("5561900000601", await previa("5561900000601", foto), "Legenda revisada pelo atendente.");
    await entrar("5561900000602", "Tem bolo?"); await controlar("5561900000602", "assumir");
    await enviarMidia("5561900000602", await previa("5561900000602", video));
    assert.deepEqual(await saidas("5561900000601"), [{ estado: "PENDENTE", texto: "Legenda revisada pelo atendente.", midia_tipo: "IMAGEM", midia_url: FOTO, autor_usuario_id: atendA.usuario_id }]);
    assert.deepEqual(await saidas("5561900000602"), [{ estado: "PENDENTE", texto: null, midia_tipo: "VIDEO", midia_url: VIDEO, autor_usuario_id: atendA.usuario_id }], "vídeo sem legenda");
    assert.deepEqual(await origem("5561900000601"), [{ midia_pronta_id: foto, versao: 0, midia_url: FOTO }], "origem: a pronta e a versão revisada");
    assert.deepEqual((await servico.listarAtendimento(atendA, c601)).mensagens.filter((m) => m.direcao === "SAIDA").map((m) => [m.midia_tipo, m.midia_url, m.humana]), [["IMAGEM", FOTO, true]], "a tela vê o tipo e a URL da saída");
    // A pronta muda DEPOIS do pedido: o que já foi pedido sai como o atendente revisou (cópia na linha da mensagem).
    await salvar(repA, { id: foto, versao: await versaoDe(foto), titulo: "Salgados da casa", tipo: "IMAGEM", texto: "Nossos salgados.", atalho: "SALGADOS", midiaUrl: "https://midia.exemplo.test/salgados-novo.png" });
    assert.deepEqual(await origem("5561900000601"), [{ midia_pronta_id: foto, versao: 0, midia_url: FOTO }]);

    // 7. Worker com transporte simulado: uma saída por mensagem; o modelo não é chamado.
    const envios: { contato: string; conteudo: ConteudoSaida }[] = [];
    let modelo = 0;
    const deps = {
      interpretar: async () => { modelo++; throw new Error("modelo não deve ser chamado"); },
      enviar: async (contato: string, conteudo: ConteudoSaida) => { envios.push({ contato, conteudo }); return cod("gs-"); },
    };
    await worker.processarLote(deps, { maxTarefas: 20 });
    assert.equal(modelo, 0, "entradas de conversas assumidas são canceladas sem modelo");
    assert.deepEqual(envios.map((e) => [e.contato, e.conteudo]).sort(), [
      ["5561900000601", { tipo: "IMAGEM", url: FOTO, legenda: "Legenda revisada pelo atendente." }],
      ["5561900000602", { tipo: "VIDEO", url: VIDEO, legenda: null }],
    ]);
    assert.deepEqual([(await saidas("5561900000601"))[0].estado, (await saidas("5561900000602"))[0].estado], ["SUBMETIDA", "SUBMETIDA"]);
    await worker.processarLote(deps, { maxTarefas: 20 });
    assert.equal(envios.length, 2, "nada é reenviado");

    // 8. PARAR e janela de 24 h com mídia na fila: cancelada antes do provedor; novo envio recusado.
    await entrar("5561900000603", "Oi"); await controlar("5561900000603", "assumir");
    const previa603 = await previa("5561900000603", foto);
    await enviarMidia("5561900000603", previa603);
    await entrar("5561900000603", "PARAR");
    await assert.rejects(enviarMidia("5561900000603", previa603), /ATENDIMENTO_CONTATO_BLOQUEADO/);
    await entrar("5561900000604", "Oi"); await controlar("5561900000604", "assumir");
    const previa604 = await previa("5561900000604", video);
    await enviarMidia("5561900000604", previa604, "Tour");
    await c.query("UPDATE whatsapp_atendimento_conversas SET ultima_entrada_em = clock_timestamp() - interval '25 hours' WHERE empresa_id = $1 AND contato = '5561900000604'", [A]);
    await assert.rejects(enviarMidia("5561900000604", previa604), /ATENDIMENTO_JANELA_EXPIRADA/);
    await worker.processarLote(deps, { maxTarefas: 20 });
    assert.equal(envios.length, 2, "nenhuma mídia sai depois de PARAR ou fora da janela");
    assert.deepEqual([(await saidas("5561900000603"))[0].estado, (await saidas("5561900000604"))[0].estado], ["CANCELADA", "CANCELADA"]);
    assert.equal(modelo, 0);

    // 8b. Entre a prévia e o envio.
    //   a) pronta editada depois da prévia: recusa, nada gravado (sem trocar a mídia); nova prévia → mídia nova.
    await entrar("5561900000606", "Oi"); await controlar("5561900000606", "assumir");
    const vista = await previa("5561900000606", foto);
    assert.equal(vista.url, "https://midia.exemplo.test/salgados-novo.png");
    await salvar(repA, { id: foto, versao: vista.versao, titulo: "Salgados da casa", tipo: "IMAGEM", texto: "Nossos salgados.", atalho: "SALGADOS", midiaUrl: "https://midia.exemplo.test/salgados-v3.jpg" });
    await assert.rejects(enviarMidia("5561900000606", vista, "Legenda vista"), /ATENDIMENTO_PRONTA_MIDIA_ALTERADA/);
    assert.deepEqual(await saidas("5561900000606"), [], "nada gravado: a mídia não foi trocada em silêncio");
    const revista = await previa("5561900000606", foto);
    assert.deepEqual([revista.versao, revista.url], [vista.versao + 1, "https://midia.exemplo.test/salgados-v3.jpg"]);
    await enviarMidia("5561900000606", revista, "Legenda revista");
    assert.deepEqual(await origem("5561900000606"), [{ midia_pronta_id: foto, versao: revista.versao, midia_url: "https://midia.exemplo.test/salgados-v3.jpg" }]);
    //   b) edição EM ANDAMENTO no momento do envio: o envio (FOR SHARE) espera o fim da edição e então recusa.
    await entrar("5561900000607", "Oi"); await controlar("5561900000607", "assumir");
    const vistaVideo = await previa("5561900000607", video);
    await c.query("BEGIN");
    await c.query("UPDATE whatsapp_atendimento_mensagens_prontas SET midia_url = 'https://midia.exemplo.test/bolos-v2.mp4', versao = versao + 1 WHERE id = $1", [video]);
    const envio = enviarMidia("5561900000607", vistaVideo);
    const desfecho = envio.then(() => "envio terminou sem esperar", (e: Error) => `envio recusado sem esperar: ${e.message}`);
    // pg_stat_activity é retrato por transação: esta conexão está dentro da edição, então limpa o retrato a cada leitura.
    const aguardandoTrava = async () => { await c.query("SELECT pg_stat_clear_snapshot()"); return contagem("SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND pid <> pg_backend_pid()"); };
    const esperando = (async () => { while (!(await aguardandoTrava())) await new Promise((r) => setTimeout(r, 25)); return "esperando a edição"; })();
    assert.equal(await noPrazo(Promise.race([esperando, desfecho]), 10_000, "envio durante a edição"), "esperando a edição");
    await c.query("COMMIT");
    await assert.rejects(noPrazo(envio, 10_000, "envio depois da edição"), /ATENDIMENTO_PRONTA_MIDIA_ALTERADA/, "a edição que estava em andamento é vista; nada sai com a mídia antiga nem com a nova");
    assert.deepEqual(await saidas("5561900000607"), []);
    //   O worker envia só o que foi revisto (606, mídia nova); a recusa (607) não deixou nada na fila.
    await worker.processarLote(deps, { maxTarefas: 20 });
    assert.deepEqual(envios.slice(2).map((e) => [e.contato, e.conteudo]), [["5561900000606", { tipo: "IMAGEM", url: "https://midia.exemplo.test/salgados-v3.jpg", legenda: "Legenda revista" }]]);

    // 9. Rollback.
    await entrar("5561900000605", "Oi"); await controlar("5561900000605", "assumir");
    await enviarMidia("5561900000605", await previa("5561900000605", foto));            // fica na fila
    await biblioteca.favoritarPronta(atendA, { id: foto, favorita: true });
    // A FK protege a origem: a pronta referenciada não pode ser apagada; o down da 080 recusa com a 081 (guarda explícita).
    await recusa(c, "DELETE FROM whatsapp_atendimento_mensagens_prontas WHERE id = $1", [video], /whatsapp_mensagens_midia_pronta/);
    await assert.rejects(c.query(comDecisoes(DOWN080, "kidmais.rollback_080_descartar_prontas")), /Rollback da 080 recusado: a 081 ou a 082 ainda estão aplicadas/); await c.query("ROLLBACK").catch(() => {});
    await c.query(POST); await c.query(POST080);
    assert.ok((await c.query("SELECT to_regclass('public.whatsapp_atendimento_mensagens_prontas') AS t")).rows[0].t, "prontas intactas depois da recusa da 080");
    // Down da 081: fila (mesmo com as duas decisões) → mídias enviadas → prontas de mídia.
    await assert.rejects(c.query(DOWN), /na fila de envio/); await c.query("ROLLBACK").catch(() => {});
    await assert.rejects(c.query(comDecisoes(DOWN, MIDIAS, PRONTAS)), /na fila de envio/, "fila bloqueia mesmo com as decisões"); await c.query("ROLLBACK").catch(() => {});
    await controlar("5561900000605", "encerrar");                                          // cancela a saída da fila (caminho real)
    assert.equal((await saidas("5561900000605"))[0].estado, "CANCELADA");
    await assert.rejects(c.query(DOWN), /respostas enviadas com mídia/); await c.query("ROLLBACK").catch(() => {});
    await assert.rejects(c.query(comDecisoes(DOWN, MIDIAS)), /foto\/vídeo ou com os atalhos novos/, "sem a decisão sobre as prontas"); await c.query("ROLLBACK").catch(() => {});
    assert.equal(await contagem("SELECT count(*) AS n FROM whatsapp_atendimento_mensagens_prontas WHERE tipo IN ('IMAGEM', 'VIDEO')"), 5, "recusas não removem nada");
    const conversasAntes = await contagem("SELECT count(*) AS n FROM whatsapp_atendimento_conversas");
    await c.query(comDecisoes(DOWN, MIDIAS, PRONTAS));
    await c.query(POS_DOWN); await c.query(POST080); await c.query(POST060);
    assert.equal(await contagem("SELECT count(*) AS n FROM whatsapp_atendimento_conversas"), conversasAntes, "060 intacta");
    assert.equal(await contagem("SELECT count(*) AS n FROM whatsapp_atendimento_mensagens_prontas_favoritas WHERE mensagem_pronta_id = $1", [foto]), 0, "favoritas das prontas removidas saem junto");
    assert.deepEqual((await c.query("SELECT titulo, tipo, atalho FROM whatsapp_atendimento_mensagens_prontas WHERE empresa_id = $1 AND ambiente = 'staging' ORDER BY titulo", [A])).rows,
      [{ titulo: "Boas-vindas", tipo: "TEXTO", atalho: null }, { titulo: "Endereço", tipo: "TEXTO", atalho: null }, { titulo: "Localização", tipo: "LINK", atalho: null }], "texto/link ficam, sem os atalhos novos");
    assert.equal(await versaoDe(endereco), 1, "atalho tirado pelo down conta como alteração (versão)");
    assert.equal((await c.query("SELECT link FROM whatsapp_atendimento_mensagens_prontas WHERE id = $1", [localizacao])).rows[0].link, "https://mapa.exemplo.test/kidmais", "o link da localização fica");
    assert.deepEqual((await servico.listarAtendimento(atendA, c601)).mensagens.filter((m) => m.direcao === "SAIDA").map((m) => [m.texto, m.midia_tipo, m.midia_url]), [["Legenda revisada pelo atendente.", null, null]], "sem as colunas a tela segue (sem cache); fica a legenda");
    assert.equal((await biblioteca.listarProntas(repA)).recursos081, false);
    await assert.rejects(salvar(repA, { titulo: "Nova foto", tipo: "IMAGEM", texto: "x", midiaUrl: FOTO }), /ATENDIMENTO_MIDIA_INDISPONIVEL/);
    await worker.processarLote(deps, { maxTarefas: 20 });
    assert.equal(envios.length, 3, "nada reenviado depois do rollback");
    // Reaplicável, e limpeza do descartável (081 vazia; agora o down da 080 passa; 060 com descarte explícito).
    await c.query(UP); await c.query(POST);
    await c.query(DOWN); await c.query(POS_DOWN);
    await c.query("BEGIN"); await c.query("SET LOCAL kidmais.rollback_080_descartar_prontas = 'sim'");
    await c.query(semTransacaoExplicita(DOWN080)); await c.query("COMMIT");
    await c.query("BEGIN"); await c.query("SET LOCAL kidmais.rollback_060_descartar_atendimento = 'sim'");
    await c.query(semTransacaoExplicita(DOWN060)); await c.query("COMMIT");
  } finally {
    await encerrarDescartavel(c);
  }
});
