import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { DbExecutor } from "../db/contracts";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import { exportarPacoteCompleto, type Transacao } from "./servico.ts";
import { provarTenantParaExportacao, empresasSuspensasExportaveis } from "./guarda.ts";
import { ENTIDADES, FORA_DO_ESCOPO, SEGREDO } from "./entidades.ts";
import { lerZip } from "./zip.ts";
import type { Client } from "pg";
import { abrir, lido, cod, id, lerCsv, montarEmpresaCom, opt, RETRATO, SENHA_FALSA, sessaoDe, sha, transacaoAninhada, transacaoDo, type CriarIdentidade } from "./fixture.postgres.test-apoio.ts";

/** Identidade sintética da suíte (senha em formato válido que não autentica). */
const criarIdentidade: CriarIdentidade = (db, email, nome) =>
  id(db, `INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, $2, $3, 'ADMINISTRATIVO', true) RETURNING id`, [email, nome, SENHA_FALSA]);
const montarEmpresa = (db: Client, letra: string) => montarEmpresaCom(db, letra, criarIdentidade);


/**
 * Exportação verificável no PostgreSQL descartável, modelo 090 (inventário inteiro até a 090 dos créditos de IA; a 089 da devolução incluída). Só pelo
 * check:v1:postgres com KIDMAIS_POSTGRES_DESCARTAVEL; dados sintéticos de DUAS empresas. Prova:
 *   1. completude: toda tabela do schema está no inventário ou em FORA_DO_ESCOPO; colunas exportadas = retrato;
 *   2. pacote: ZIP legível, SHA-256 de cada arquivo = manifesto = SHA256SUMS, linhas do CSV = manifesto = contagem
 *      independente (JOINs escritos à parte), PDFs idênticos aos do banco, pasta temporária apagada por limpar();
 *   3. isolamento: nenhuma marca, id ou segredo da empresa B no pacote da A (e vice-versa);
 *   4. guarda: Equipe, outra empresa, desativada, vínculo suspenso e sessão em outra empresa recusados; suspensa
 *      exportável só pela Gestão; troca de vínculo ou de situação no meio = nada entregue, nada auditado;
 *   5. auditoria só com contagens e hashes; limites recusam o pacote inteiro.
 * Os cenários adversariais da revisão independente estão em exportacao-adversarial.postgres.test.ts.
 */
test("exportação: completude do inventário e retrato das colunas no schema 090", { timeout: 120_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  try {
    const tabelas = (await c.query<{ t: string }>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`)).rows.map((r) => r.t);
    const noInventario = new Set(ENTIDADES.map((e) => e.tabela));
    const semDecisao = tabelas.filter((t) => !noInventario.has(t) && !Object.hasOwn(FORA_DO_ESCOPO, t));
    assert.deepEqual(semDecisao, [], "tabela nova precisa entrar no inventário ou em FORA_DO_ESCOPO com motivo");
    for (const e of ENTIDADES) assert.ok(tabelas.includes(e.tabela), `${e.tabela} existe no schema 090`);

    // Pacote de uma empresa vazia: o manifesto traz as colunas efetivamente exportadas de cada tabela.
    await c.query("BEGIN");
    const vazia = await id(c, `INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Vazia', 'PROVISIONAMENTO') RETURNING id`, [cod()]);
    await c.query("COMMIT");
    const { gerarPacote } = await import("./pacote.ts");
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const p = await gerarPacote(c as unknown as DbExecutor, vazia);
    const pZip = readFileSync(p.zipCaminho);
    await p.limpar();
    assert.equal(lerZip(pZip).has("MANIFESTO.json"), true);
    await c.query("COMMIT");
    const colunas = Object.fromEntries(p.manifesto.arquivos.filter((a) => a.tipo === "csv").map((a) => [a.tabela as string, a.colunas as string[]]));
    for (const lista of Object.values(colunas)) for (const col of lista) assert.doesNotMatch(col.replace(/__(bytes|sha256|arquivo)$/, ""), SEGREDO, `coluna de segredo exportada: ${col}`);
    if (process.env.KIDMAIS_EXPORTACAO_ATUALIZAR_RETRATO === "1") writeFileSync(RETRATO, `${JSON.stringify(colunas, null, 2)}\n`);
    assert.deepEqual(colunas, JSON.parse(readFileSync(RETRATO, "utf8")), "colunas exportadas mudaram: revise segredos e atualize o retrato");
    assert.deepEqual(p.manifesto.entidadesAusentes, []);

    // Fluxo real das três fases com transações de verdade (SET TRANSACTION como primeiro comando da leitura): uma
    // empresa só com a Gestão. A fase de leitura é READ ONLY: qualquer escrita nela falharia.
    const transacao = transacaoDo(c);
    const gestao = await transacao(async () => {
      await c.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [vazia]);
      const u = await id(c, `INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Gestão Vazia', $2, 'ADMINISTRATIVO', true) RETURNING id`, [`${cod()}@example.test`, SENHA_FALSA]);
      const m = await id(c, `INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', now(), 'REPRESENTANTE_AUTORIZADO') RETURNING id`, [vazia, u]);
      await c.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
      return u;
    });
    const real = await lido(exportarPacoteCompleto(sessaoDe(gestao), vazia, { requestId: randomUUID() }, { transacao }));
    const { manifesto } = abrir(real);
    assert.equal(manifesto.empresa.id, vazia);
    assert.equal(manifesto.totais.linhas, 3, "empresa, usuário e vínculo");
    assert.equal(Number((await c.query(`SELECT count(*) AS n FROM auditoria WHERE acao = 'EXPORTACAO_DADOS' AND entidade_id = $1::uuid`, [vazia])).rows[0].n), 1);
    // Escrita na fase de leitura é recusada pelo próprio PostgreSQL.
    await c.query("BEGIN");
    await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    await assert.rejects(c.query(`UPDATE empresas SET nome = nome WHERE id = $1::uuid`, [vazia]), /read-only/);
    await c.query("ROLLBACK");
  } finally {
    await encerrarDescartavel(c);
  }
});

test("exportação: pacote verificável, contagens independentes, PDFs, isolamento A×B, sem segredos e auditoria", { timeout: 300_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  const transacao = transacaoAninhada(c);
  try {
    await c.query("BEGIN");
    const A = await montarEmpresa(c, "A"), B = await montarEmpresa(c, "B");
    const auditoriasAntes = Number((await c.query(`SELECT count(*) AS n FROM auditoria WHERE acao = 'EXPORTACAO_DADOS'`)).rows[0].n);
    const rA = await lido(exportarPacoteCompleto(sessaoDe(A.gestao), A.empresa, { requestId: randomUUID() }, { transacao }));
    const rB = await lido(exportarPacoteCompleto(sessaoDe(B.gestao), null, { requestId: randomUUID() }, { transacao }));
    assert.equal(rA.suspensa, false);

    for (const [r, eu, outra] of [[rA, A, B], [rB, B, A]] as const) {
      const { arquivos, manifesto } = abrir(r);
      assert.equal(manifesto.formato, "kidmais-exportacao");
      assert.equal(manifesto.versaoFormato, 1);
      assert.equal(manifesto.empresa.id, eu.empresa);
      // Cada arquivo do manifesto: presente, mesmo tamanho, mesmo SHA-256; CSV com as linhas declaradas.
      const listados = new Set(["MANIFESTO.json", "SHA256SUMS.txt"]);
      for (const a of manifesto.arquivos) {
        const b = arquivos.get(a.caminho);
        assert.ok(b, `${a.caminho} no ZIP`);
        listados.add(a.caminho);
        assert.equal(b.length, a.bytes, a.caminho);
        assert.equal(sha(b), a.sha256, a.caminho);
        if (a.tipo === "csv") {
          const linhas = lerCsv(b.toString("utf8"));
          assert.equal(b.subarray(0, 3).toString("hex"), "efbbbf", "BOM UTF-8");
          assert.deepEqual(linhas[0], a.colunas);
          assert.equal(linhas.length - 1, a.linhas, `${a.caminho}: linhas`);
        }
      }
      assert.deepEqual([...arquivos.keys()].sort(), [...listados].sort(), "nada no ZIP fora do manifesto");
      // SHA256SUMS.txt: formato do sha256sum, cobre tudo (inclusive o MANIFESTO) e confere.
      const somas = arquivos.get("SHA256SUMS.txt")!.toString("utf8").trim().split("\n").map((l) => l.split("  "));
      assert.equal(somas.length, manifesto.arquivos.length + 1);
      for (const [h, caminho] of somas) assert.equal(sha(arquivos.get(caminho)!), h, caminho);

      // Contagens independentes (JOINs escritos à parte do inventário).
      const linhasDe = (arquivo: string) => manifesto.arquivos.find((a) => a.entidade === arquivo)?.linhas;
      const conta = async (sql: string) => Number((await c.query(sql, [eu.empresa])).rows[0].n);
      const esperadas: Record<string, string> = {
        "clientes/clientes": `SELECT count(*) AS n FROM clientes WHERE empresa_id = $1`,
        "clientes/aniversariantes": `SELECT count(*) AS n FROM aniversariantes a JOIN clientes c ON c.id = a.cliente_id WHERE c.empresa_id = $1`,
        "clientes/responsaveis_adicionais": `SELECT count(*) AS n FROM responsaveis_adicionais r JOIN clientes c ON c.id = r.cliente_id WHERE c.empresa_id = $1`,
        "contratos/contratos": `SELECT count(*) AS n FROM contratos ct JOIN fechamentos f ON f.id = ct.fechamento_id WHERE f.empresa_id = $1`,
        "contratos/contrato_versoes": `SELECT count(*) AS n FROM contrato_versoes v JOIN contratos ct ON ct.id = v.contrato_id JOIN fechamentos f ON f.id = ct.fechamento_id WHERE f.empresa_id = $1`,
        "contratos/contrato_documentos": `SELECT count(*) AS n FROM contrato_documentos d JOIN contrato_versoes v ON v.id = d.contrato_versao_id JOIN contratos ct ON ct.id = v.contrato_id JOIN fechamentos f ON f.id = ct.fechamento_id WHERE f.empresa_id = $1`,
        "contratos/contrato_assinaturas": `SELECT count(*) AS n FROM contrato_assinaturas s JOIN contrato_versoes v ON v.id = s.contrato_versao_id JOIN contratos ct ON ct.id = v.contrato_id JOIN fechamentos f ON f.id = ct.fechamento_id WHERE f.empresa_id = $1`,
        "festas/festas": `SELECT count(*) AS n FROM festas fe JOIN contratos ct ON ct.id = fe.contrato_id JOIN fechamentos f ON f.id = ct.fechamento_id WHERE f.empresa_id = $1`,
        "festas/tarefas": `SELECT count(*) AS n FROM festa_tarefas x JOIN festas fe ON fe.id = x.festa_id JOIN contratos ct ON ct.id = fe.contrato_id JOIN fechamentos f ON f.id = ct.fechamento_id WHERE f.empresa_id = $1`,
        "financeiro/parcelas": `SELECT count(*) AS n FROM pagamento_parcelas pp JOIN pagamento_planos pl ON pl.id = pp.plano_id JOIN pagamentos p ON p.id = pl.pagamento_id JOIN contrato_versoes v ON v.id = p.contrato_versao_id JOIN contratos ct ON ct.id = v.contrato_id JOIN fechamentos f ON f.id = ct.fechamento_id WHERE f.empresa_id = $1`,
        "financeiro/contas_pagar": `SELECT count(*) AS n FROM financeiro_contas_pagar WHERE empresa_id = $1`,
        "agenda/bloqueios": `SELECT count(*) AS n FROM bloqueios_agenda WHERE empresa_id = $1`,
        "convites/convites": `SELECT count(*) AS n FROM convites WHERE empresa_id = $1`,
        "convites/familias": `SELECT count(*) AS n FROM convite_familias WHERE empresa_id = $1`,
        "convites/respostas": `SELECT count(*) AS n FROM convite_respostas r JOIN convites cn ON cn.id = r.convite_id WHERE cn.empresa_id = $1`,
        "marketing/contatos": `SELECT count(*) AS n FROM marketing_contatos WHERE empresa_id = $1`,
        "whatsapp/mensagens": `SELECT count(*) AS n FROM whatsapp_atendimento_mensagens WHERE empresa_id = $1`,
        "empresa/vinculos": `SELECT count(*) AS n FROM memberships WHERE empresa_id = $1`,
        "empresa/usuarios": `SELECT count(DISTINCT usuario_id) AS n FROM memberships WHERE empresa_id = $1`,
      };
      for (const [arquivo, sql] of Object.entries(esperadas)) {
        const n = await conta(sql);
        assert.ok(n > 0, `${arquivo}: fixture com dados`);
        assert.equal(linhasDe(arquivo), n, `${arquivo}: manifesto × contagem independente`);
      }
      assert.equal(linhasDe("clientes/clientes"), 2);
      assert.equal(linhasDe("financeiro/parcelas"), 2);

      // PDF do contrato: o arquivo do pacote é byte a byte o do banco, e o CSV aponta para ele.
      const caminhoPdf = `arquivos/contratos/${eu.documento}.pdf`;
      assert.ok(arquivos.get(caminhoPdf)?.equals(eu.pdf), "PDF idêntico");
      assert.equal(manifesto.totais.pdfs, 2, "contrato e comprovante");
      const docs = lerCsv(arquivos.get("dados/contratos/contrato_documentos.csv")!.toString("utf8"));
      const linhaDoc = docs.find((l) => l[docs[0].indexOf("id")] === eu.documento)!;
      assert.equal(linhaDoc[docs[0].indexOf("conteudo_pdf__arquivo")], caminhoPdf);
      assert.equal(linhaDoc[docs[0].indexOf("conteudo_pdf__sha256")], sha(eu.pdf));
      assert.ok(!docs[0].includes("conteudo_pdf"), "bytes do PDF não vão para o CSV");

      // Isolamento e segredos: nada da outra empresa e nenhum segredo, em nenhum arquivo.
      const tudo = [...arquivos.values()].map((b) => b.toString("utf8")).join("\n");
      assert.ok(tudo.includes(eu.marca), "a própria marca está no pacote");
      assert.ok(!tudo.includes(outra.marca), "marca da outra empresa vazou");
      assert.ok(!tudo.includes(outra.empresa), "id da outra empresa vazou");
      for (const s of [...eu.segredos, ...outra.segredos]) assert.ok(!tudo.includes(s), "segredo no pacote");
      // Nomes de coluna de segredo só aparecem no MANIFESTO, na lista de colunas excluídas (com o motivo), nunca nos dados.
      const dados = [...arquivos].filter(([k]) => k.startsWith("dados/")).map(([, b]) => b.toString("utf8")).join(" ");
      for (const nome of ["senha_hash", "publico_token", "token_prova_hash", "codigo_hash", "editor_hash", "token_hash"]) assert.ok(!dados.includes(nome), nome);
      const excluidas = manifesto.arquivos.flatMap((a) => (a.colunasExcluidas ?? []).map((x) => `${a.tabela}.${x.coluna}`));
      for (const x of ["usuarios_administrativos.senha_hash", "convites.publico_token", "validacoes_identidade_cliente.token_prova_hash", "convite_familias.token_hash"]) assert.ok(excluidas.includes(x), x);
      // Fórmula neutralizada no texto; número negativo/valor preservado; quebra de linha e ; entre aspas.
      const clientes = arquivos.get("dados/clientes/clientes.csv")!.toString("utf8");
      assert.ok(clientes.includes(`"'=HYPERLINK(""x"") ${eu.marca}"`), "fórmula neutralizada");
      assert.ok(clientes.includes("'+55 observação"), "texto iniciado por + neutralizado");
      const contas = lerCsv(arquivos.get("dados/financeiro/contas_pagar.csv")!.toString("utf8"));
      assert.equal(contas[1][contas[0].indexOf("valor")], "123.45");
    }
    // Ids disjuntos entre os pacotes (todas as colunas id).
    const ids = (r: typeof rA) => {
      const s = new Set<string>();
      for (const [caminho, b] of lerZip(r.zip)) {
        if (!caminho.endsWith(".csv")) continue;
        const l = lerCsv(b.toString("utf8"));
        const i = l[0].indexOf("id");
        if (i >= 0) for (const linha of l.slice(1)) s.add(`${caminho}:${linha[i]}`);
      }
      return s;
    };
    const idsA = ids(rA), idsB = ids(rB);
    assert.ok(idsA.size > 10);
    for (const x of idsA) assert.ok(!idsB.has(x), `id repetido entre empresas: ${x}`);

    // Auditoria: uma por exportação, só contagens e hashes.
    const aud = (await c.query<{ usuario_id: string; entidade_id: string; dados_depois: Record<string, unknown>; ip: string | null; user_agent: string | null }>(
      `SELECT usuario_id::text, entidade_id::text, dados_depois, ip::text, user_agent FROM auditoria WHERE acao = 'EXPORTACAO_DADOS' ORDER BY criado_em, id`)).rows;
    assert.equal(aud.length, auditoriasAntes + 2);
    const ultimaA = aud.find((a) => a.entidade_id === A.empresa)!;
    assert.equal(ultimaA.usuario_id, A.gestao);
    assert.equal(ultimaA.ip, null); assert.equal(ultimaA.user_agent, null);
    assert.equal(ultimaA.dados_depois.manifestoSha256, rA.manifestoSha256);
    assert.equal(ultimaA.dados_depois.zipSha256, rA.zipSha256);
    assert.deepEqual(Object.keys(ultimaA.dados_depois).sort(), ["arquivos", "bytes", "empresaId", "empresaSuspensa", "entidadesAusentes", "formato", "geradoEm", "linhas", "manifestoSha256", "pdfs", "resultado", "tipo", "versaoFormato", "zipSha256"]);
    assert.ok(!JSON.stringify(aud).includes(A.marca), "auditoria sem conteúdo");

    // Limites: o pacote inteiro é recusado (nada parcial, nada auditado).
    await assert.rejects(exportarPacoteCompleto(sessaoDe(A.gestao), A.empresa, {}, { transacao, limites: { linhasPorArquivo: 1, bytesTotal: 1e9, tempoMs: 60_000 } }), /EXPORTACAO_GRANDE_DEMAIS|limite/);
    await assert.rejects(exportarPacoteCompleto(sessaoDe(A.gestao), A.empresa, {}, { transacao, limites: { linhasPorArquivo: 1000, bytesTotal: 2000, tempoMs: 60_000 } }), /limite/);
    let tique = 0;
    await assert.rejects(exportarPacoteCompleto(sessaoDe(A.gestao), A.empresa, {}, { transacao, relogio: () => (tique += 200_000) }), /tempo limite/);
    assert.equal(Number((await c.query(`SELECT count(*) AS n FROM auditoria WHERE acao = 'EXPORTACAO_DADOS'`)).rows[0].n), auditoriasAntes + 2);
  } finally {
    await encerrarDescartavel(c);
  }
});

test("exportação: guarda — Gestão, Equipe, outra empresa, suspensa, desativada, sessão e mudanças no meio", { timeout: 300_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  const transacao = transacaoAninhada(c);
  const prova = (sessao: Parameters<typeof provarTenantParaExportacao>[1], empresa: string | null) => transacao((tx) => provarTenantParaExportacao(tx, sessao, empresa));
  const auditorias = async () => Number((await c.query(`SELECT count(*) AS n FROM auditoria WHERE acao = 'EXPORTACAO_DADOS'`)).rows[0].n);
  try {
    await c.query("BEGIN");
    const A = await montarEmpresa(c, "A"), B = await montarEmpresa(c, "B");
    // Ativa: Gestão sim; Equipe não; Gestão de B não leva A.
    assert.equal((await prova(sessaoDe(A.gestao), A.empresa)).suspensa, false);
    await assert.rejects(prova(sessaoDe(A.equipe), A.empresa), /PAPEL_NAO_AUTORIZADO|Gestão/);
    await assert.rejects(prova(sessaoDe(B.gestao), A.empresa), /não comprova/);
    await assert.rejects(prova(sessaoDe(A.gestao), "nao-e-uuid"), /não comprova/);
    // Sessão real selecionada em A: B pedida por parâmetro é recusada.
    const sessaoA = await transacao(async () => id(c, `INSERT INTO sessoes_administrativas (usuario_id, token_hash, csrf_hash, autenticado_em, ultima_atividade_em, expira_em, empresa_ativa_id)
      VALUES ($1::uuid, $2, $3, now(), now(), now() + interval '8 hours', $4::uuid) RETURNING id`, [A.gestao, sha(randomUUID()), sha(randomUUID()), A.empresa]));
    const comSessao = sessaoDe(A.gestao, { id: sessaoA, empresa_ativa_id: A.empresa });
    assert.equal((await prova(comSessao, null)).empresaComprovada, A.empresa);

    // Mudança no meio (entre a leitura e a auditoria): vínculo suspenso → nada entregue, nada auditado.
    const antes = await auditorias();
    const comMudanca = (sql: string, params: unknown[]): Transacao => { let n = 0; return async (work) => { if (++n === 3) await c.query(sql, params); return transacao(work); }; };
    await assert.rejects(exportarPacoteCompleto(sessaoDe(A.gestao), A.empresa, {}, { transacao: comMudanca(`UPDATE memberships SET status = 'SUSPENSA' WHERE usuario_id = $1::uuid`, [A.gestao]) }), /não comprova/);
    assert.equal(await auditorias(), antes);
    await transacao(async () => c.query(`UPDATE memberships SET status = 'ATIVA' WHERE usuario_id = $1::uuid`, [A.gestao]));

    // Empresa ativa que é suspensa no meio: a prova final muda de natureza → recusada.
    await assert.rejects(exportarPacoteCompleto(sessaoDe(A.gestao), A.empresa, {}, { transacao: comMudanca(`UPDATE empresas SET status = 'SUSPENSA' WHERE id = $1::uuid`, [A.empresa]) }), /não comprova/);
    assert.equal(await auditorias(), antes);
    // A suspensão revogou a sessão selecionada em A (063): ela não serve mais para nada.
    await assert.rejects(prova(comSessao, A.empresa), /não comprova/);
    await assert.rejects(prova(sessaoDe(A.gestao, { id: sessaoA, empresa_ativa_id: B.empresa }), A.empresa), /não comprova/);

    // Suspensa: só com a empresa pedida explicitamente, só Gestão com vínculo ativo; o resto do sistema continua fechado.
    await assert.rejects(prova(sessaoDe(A.gestao), null), /não comprova/);
    const suspensa = await prova(sessaoDe(A.gestao), A.empresa);
    assert.equal(suspensa.suspensa, true);
    assert.equal(suspensa.empresaComprovada, A.empresa);
    await assert.rejects(prova(sessaoDe(A.equipe), A.empresa), /PAPEL_NAO_AUTORIZADO|Gestão/);
    await assert.rejects(prova(sessaoDe(B.gestao), A.empresa), /não comprova/);
    const { provarTenant } = await import("../saas/provar-tenant.ts");
    await assert.rejects(transacao((tx) => provarTenant(tx, sessaoDe(A.gestao), A.empresa)), /não comprova/, "provarTenant continua recusando a suspensa");
    assert.deepEqual(await empresasSuspensasExportaveis(c as unknown as DbExecutor, A.gestao), [{ id: A.empresa, nome: `Buffet ${A.marca}` }]);
    assert.deepEqual(await empresasSuspensasExportaveis(c as unknown as DbExecutor, A.equipe), []);
    const r = await lido(exportarPacoteCompleto(sessaoDe(A.gestao), A.empresa, {}, { transacao }));
    assert.equal(r.suspensa, true);
    const { manifesto } = abrir(r);
    assert.equal(manifesto.empresa.situacao, "SUSPENSA");
    assert.equal((await c.query(`SELECT dados_depois->>'empresaSuspensa' AS s FROM auditoria WHERE acao = 'EXPORTACAO_DADOS' ORDER BY criado_em DESC, id DESC LIMIT 1`)).rows[0].s, "true");
    // Vínculo da Gestão suspenso: recusa.
    await transacao(async () => c.query(`UPDATE memberships SET status = 'SUSPENSA' WHERE usuario_id = $1::uuid`, [A.gestao]));
    await assert.rejects(prova(sessaoDe(A.gestao), A.empresa), /não comprova/);
    await transacao(async () => c.query(`UPDATE memberships SET status = 'ATIVA' WHERE usuario_id = $1::uuid`, [A.gestao]));
    // Desativada: fim da exceção.
    await transacao(async () => c.query(`UPDATE empresas SET status = 'DESATIVADA' WHERE id = $1::uuid`, [A.empresa]));
    await assert.rejects(prova(sessaoDe(A.gestao), A.empresa), /não comprova/);
    assert.deepEqual(await empresasSuspensasExportaveis(c as unknown as DbExecutor, A.gestao), []);
    // B segue intacta e exportável.
    assert.equal((await lido(exportarPacoteCompleto(sessaoDe(B.gestao), B.empresa, {}, { transacao }))).suspensa, false);
  } finally {
    await encerrarDescartavel(c);
  }
});
