import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Client } from "pg";
import type { DbExecutor } from "../db/contracts";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import { exportarPacoteCompleto, type Transacao } from "./servico.ts";
import { provarTenantParaExportacao } from "./guarda.ts";
import { ENTIDADES } from "./entidades.ts";
import { gerarPacote, PREFIXO_TEMPORARIO } from "./pacote.ts";
import { lerZip } from "./zip.ts";
import { abrir, cod, id, lerCsv, lido, montarEmpresaCom, opt, SENHA_FALSA, sessaoDe, sha, transacaoAninhada, type CriarIdentidade } from "./fixture.postgres.test-apoio.ts";

/** Identidade sintética da suíte (senha em formato válido que não autentica). */
const criarIdentidade: CriarIdentidade = (db, email, nome) =>
  id(db, `INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, $2, $3, 'ADMINISTRATIVO', true) RETURNING id`, [email, nome, SENHA_FALSA]);
const montarEmpresa = (db: Client, letra: string) => montarEmpresaCom(db, letra, criarIdentidade);


/**
 * Exportação — cenários adversariais da revisão independente de 21/10/2026 (roteiros/adversarial-cauda.ts do revisor,
 * incorporados à suíte do produto; P2-4) e as provas das correções da rodada 2:
 *   1. 3 empresas com dados cruzados, pessoa com vários vínculos, linhas globais/legadas (empresa nula), perfis: nenhuma
 *      linha, UUID, FK ou marca de outra empresa em nenhuma das 143 entidades;
 *   2. guarda adversarial (sessão viva noutra empresa, usuário inativo, papel, PROVISIONAMENTO, SUSPENSA→DESATIVADA no
 *      meio) e P3-4 (Gestão na empresa ativa baixa a suspensa pelo POST, sem trocar de empresa);
 *   3. fotografia REPEATABLE READ com escrita concorrente real;
 *   4. cada filtro do inventário segue uma FK real do catálogo (roteiros/cadeias-fk.mts do revisor);
 *   5. tabela pública não classificada recusa a exportação (P2-3), sem pacote nem temporário;
 *   6. limite por empresa/pessoa e auditoria das recusas da guarda sem dados pessoais (P3-2, P3-5).
 * Só pelo check:v1:postgres com KIDMAIS_POSTGRES_DESCARTAVEL; modelo 095 (inclui a 089 da devolução e a 095 dos créditos); dados sintéticos.
 */


const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Tenta um INSERT num SAVEPOINT; devolve o id (ou null) e registra o que não entrou (constraint do schema). */
async function tentar(db: Client, rotulo: string, sql: string, v: unknown[], log: string[]): Promise<string | null> {
  await db.query("SAVEPOINT tentar");
  try {
    const r = await db.query<{ id?: string }>(sql, v);
    await db.query("RELEASE SAVEPOINT tentar");
    log.push(`ok  ${rotulo}`);
    return r.rows[0]?.id ?? "ok";
  } catch (erro) {
    await db.query("ROLLBACK TO SAVEPOINT tentar");
    log.push(`NAO ${rotulo}: ${(erro as Error).message.slice(0, 140)}`);
    return null;
  }
}

/** Mapa id → empresa de toda linha (de qualquer tabela) que tenha id + empresa_id: prova independente de posse. */
async function donosPorId(db: Client): Promise<Map<string, string>> {
  const tabelas = (await db.query<{ t: string }>(`SELECT c.table_name AS t FROM information_schema.columns c
      JOIN information_schema.tables x ON x.table_schema = c.table_schema AND x.table_name = c.table_name AND x.table_type = 'BASE TABLE'
     WHERE c.table_schema = 'public' AND c.column_name = 'empresa_id'
       AND EXISTS (SELECT 1 FROM information_schema.columns i WHERE i.table_schema = 'public' AND i.table_name = c.table_name AND i.column_name = 'id' AND i.data_type = 'uuid')
       AND c.table_name NOT LIKE 'perfil\\_%'`)).rows.map((r) => r.t);
  const mapa = new Map<string, string>();
  for (const t of tabelas) {
    for (const r of (await db.query<{ id: string; e: string | null }>(`SELECT id::text AS id, empresa_id::text AS e FROM "${t}"`)).rows) mapa.set(r.id, r.e ?? "GLOBAL");
  }
  for (const r of (await db.query<{ id: string }>(`SELECT id::text AS id FROM empresas`)).rows) mapa.set(r.id, r.id);
  return mapa;
}

/** FKs de coluna única, do catálogo: (tabela, coluna) → (tabela alvo, coluna alvo). */
async function fks(db: Client) {
  return (await db.query<{ t: string; c: string; ft: string; fc: string }>(`SELECT cl.relname AS t, a.attname AS c, fcl.relname AS ft, fa.attname AS fc
      FROM pg_constraint k JOIN pg_class cl ON cl.oid = k.conrelid JOIN pg_class fcl ON fcl.oid = k.confrelid
      JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
      JOIN pg_attribute fa ON fa.attrelid = k.confrelid AND fa.attnum = k.confkey[1]
     WHERE k.contype = 'f' AND array_length(k.conkey, 1) = 1`)).rows;
}

test("REVISÃO: 3 empresas com dados cruzados — nenhuma linha, id, FK ou marca de outra empresa (todas as 143 entidades)", { timeout: 300_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente"); return; }
  const c = await conectarDescartavel();
  const transacao = transacaoAninhada(c);
  const log: string[] = [];
  try {
    await c.query("BEGIN");
    const A = await montarEmpresa(c, "A"), B = await montarEmpresa(c, "B"), C = await montarEmpresa(c, "C");
    const GLOBAL = `MARCA-GLOBAL-${randomBytes(4).toString("hex")}`;
    // Pessoa multi-empresa: Gestão em A, Equipe em B, Gestão em C (vínculo depois revogado).
    const U = await id(c, `INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, $2, $3, 'ADMINISTRATIVO', true) RETURNING id`, [`${cod()}@example.test`, "Pessoa Multi", SENHA_FALSA]);
    const mem: Record<string, string> = {};
    for (const [e, papel] of [[A.empresa, "REPRESENTANTE_AUTORIZADO"], [B.empresa, "ADMINISTRATIVO"], [C.empresa, "REPRESENTANTE_AUTORIZADO"]] as const) {
      mem[e] = await id(c, `INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', now(), $3) RETURNING id`, [e, U, papel]);
      await c.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [mem[e]]);
    }
    const hashDoc = "a".repeat(64);
    const docGlobal = randomBytes(6).toString("hex").toUpperCase() + "00";
    const docs: Record<string, string> = { [B.empresa]: randomBytes(6).toString("hex").toUpperCase() + "11", [C.empresa]: randomBytes(6).toString("hex").toUpperCase() + "22" };
    // Rastros da pessoa multi-empresa em B e C, e rastros globais (empresa nula).
    for (const [e, m] of [[B.empresa, B.marca], [C.empresa, C.marca]] as const) {
      await tentar(c, `aceite U em ${m}`, `INSERT INTO aceites_documentos_legais (usuario_id, empresa_id, documento, versao, hash_conteudo, origem, ip, user_agent) VALUES ($1::uuid, $2::uuid, 'TERMOS_USO', '2026-10-21', $3, 'CADASTRO', '203.0.113.9', $4) RETURNING id`, [U, e, hashDoc, `UA-${m}`], log);
      await tentar(c, `solicitação de U para ${m}`, `INSERT INTO solicitacoes_acesso_empresa (usuario_id, documento, empresa_id) VALUES ($1::uuid, $2, $3::uuid) RETURNING id`, [U, docs[e], e], log);
      await tentar(c, `convite de acesso em ${m} para o e-mail da Gestão de A`, `INSERT INTO convites_acesso (empresa_id, email, nome_sugerido, papel, token_hash, expira_em, criado_por) VALUES ($1::uuid, (SELECT email FROM usuarios_administrativos WHERE id = $2::uuid), $3, 'ADMINISTRATIVO', $4, now() + interval '1 day', $5::uuid) RETURNING id`, [e, A.gestao, `Convite ${m}`, sha(m), e === B.empresa ? B.gestao : C.gestao], log);
      await tentar(c, `representação de U em ${m}`, `INSERT INTO empresa_representacoes (empresa_id, usuario_id, qualificacao, descricao_evidencia) VALUES ($1::uuid, $2::uuid, 'PROCURADOR', $3) RETURNING id`, [e, U, `Rep ${m}`], log);
      const est = await tentar(c, `estabelecimento em ${m}`, `INSERT INTO estabelecimentos (empresa_id, codigo, nome, status) VALUES ($1::uuid, $2, $3, 'SUSPENSO') RETURNING id`, [e, cod(), `Unidade ${m}`], log);
      if (est) await tentar(c, `vínculo-estabelecimento de U em ${m}`, `INSERT INTO membership_estabelecimentos (empresa_id, estabelecimento_id, membership_id, status, vigente_desde) VALUES ($1::uuid, $2::uuid, $3::uuid, 'ATIVA', now()) RETURNING id`, [e, est, mem[e]], log);
      // Mesmo telefone/contato do lead de A, noutra empresa.
      await tentar(c, `lead em ${m} com o telefone de A`, `INSERT INTO marketing_contatos (empresa_id, canal_atendimento, nome, chave_idempotencia, vinculo_cliente, telefone) VALUES ($1::uuid, 'WHATSAPP', $2, $3, 'SEM_CLIENTE', '11999990000') RETURNING id`, [e, `Lead2 ${m}`, randomBytes(12).toString("hex")], log);
    }
    await tentar(c, "aceite global de U (empresa nula)", `INSERT INTO aceites_documentos_legais (usuario_id, empresa_id, documento, versao, hash_conteudo, origem, user_agent) VALUES ($1::uuid, NULL, 'TERMOS_USO', '2026-10-21', $2, 'CADASTRO', $3) RETURNING id`, [U, hashDoc, `UA ${GLOBAL}`], log);
    await tentar(c, "solicitação sem empresa", `INSERT INTO solicitacoes_acesso_empresa (usuario_id, documento, empresa_id) VALUES ($1::uuid, $2, NULL) RETURNING id`, [U, docGlobal], log);
    await tentar(c, "bloqueio global", `INSERT INTO bloqueios_agenda (data, motivo, empresa_id, dia_inteiro) VALUES ('2026-12-25', $1, NULL, true) RETURNING id`, [GLOBAL], log);
    await tentar(c, "buffet_categoria global", `INSERT INTO buffet_categorias (codigo, nome, empresa_id) VALUES ($1, $2, NULL) RETURNING id`, [cod(), GLOBAL], log);
    await tentar(c, "cliente legado (empresa nula)", `INSERT INTO clientes (nome_completo, empresa_id) VALUES ($1, NULL) RETURNING id`, [`Cliente ${GLOBAL}`], log);
    await tentar(c, "pacote legado (empresa nula)", `INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente) VALUES (NULL, $1, $2, 1, true, true) RETURNING id`, [cod().toUpperCase(), `Pacote ${GLOBAL}`], log);
    await tentar(c, "agenda legada (empresa nula)", `INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, ordem_exibicao, empresa_id) VALUES ($1, $2, '10:00', '18:00', 9, NULL) RETURNING id`, [cod(), `Agenda ${GLOBAL}`], log);
    await tentar(c, "tabela de preço legada (empresa nula)", `INSERT INTO tabelas_preco (codigo, nome, vigencia_inicio, ativa, empresa_id) VALUES ($1, $2, '2026-01-01', false, NULL) RETURNING id`, [cod(), `Tabela ${GLOBAL}`], log);
    // Perfis: um por empresa (id = empresa) e um órfão.
    for (const f of [A, B, C]) {
      const cdg = (await c.query<{ codigo: string }>(`SELECT codigo FROM empresas WHERE id = $1::uuid`, [f.empresa])).rows[0].codigo;
      await tentar(c, `perfil de ${f.marca}`, `INSERT INTO perfil_empresas (id, codigo, nome_comercial) VALUES ($1::uuid, $2, $3) RETURNING id`, [f.empresa, cdg, `Perfil ${f.marca}`], log);
      await tentar(c, `perfil_unidade de ${f.marca}`, `INSERT INTO perfil_unidades (empresa_id, codigo, nome, telefone) VALUES ($1::uuid, $2, $3, '1133334444') RETURNING id`, [f.empresa, cod(), `UnidadePerfil ${f.marca}`], log);
    }
    await tentar(c, "perfil órfão", `INSERT INTO perfil_empresas (codigo, nome_comercial) VALUES ($1, $2) RETURNING id`, [cod(), `Perfil ${GLOBAL}`], log);
    console.log(log.join("\n"));
    for (const nome of ["@SUM(1+1)", "-2+3", "\tTAB=1", " =espaço antes", "＝FULLWIDTH", "linha1\r\nlinha2;\"aspas\""]) await c.query(`INSERT INTO clientes (nome_completo, empresa_id, observacoes) VALUES ($1, $2::uuid, 'teste csv')`, [nome, A.empresa]);

    const exportar = (sessao: Parameters<typeof exportarPacoteCompleto>[0], empresa: string | null) => exportarPacoteCompleto(sessao, empresa, { requestId: randomUUID() }, { transacao });
    const pacotes = {
      A: await lido(exportar(sessaoDe(A.gestao), A.empresa)),
      AporU: await lido(exportar(sessaoDe(U), A.empresa)),
      B: await lido(exportar(sessaoDe(B.gestao), B.empresa)),
      C: await lido(exportar(sessaoDe(C.gestao), C.empresa)),
    };
    if (process.env.REVISAO_ZIP_A) writeFileSync(process.env.REVISAO_ZIP_A, pacotes.A.zip);
    // A Equipe de B (U) não exporta B; U em C exporta C (Gestão ativa).
    await assert.rejects(exportar(sessaoDe(U), B.empresa), /PAPEL_NAO_AUTORIZADO|Gestão/);
    // U sem empresa pedida e com 2 vínculos de Gestão: nada é escolhido por ele.
    await assert.rejects(exportar(sessaoDe(U), null), /não comprova/);

    const donos = await donosPorId(c);
    const chaves = await fks(c);
    const temEmpresaId = new Set((await c.query<{ t: string }>(`SELECT table_name AS t FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'empresa_id'`)).rows.map((r) => r.t));
    const relatorio: string[] = [];
    for (const [rotulo, r] of Object.entries(pacotes)) {
      const eu = rotulo.startsWith("A") ? A : rotulo === "B" ? B : C;
      const outras = [A, B, C].filter((x) => x !== eu);
      const { arquivos, manifesto } = abrir(r);
      const tudo = [...arquivos.values()].map((b) => b.toString("utf8")).join("\n");
      // (1) marcas e ids das outras empresas, e marcas globais/legadas.
      for (const o of outras) {
        assert.ok(!tudo.includes(o.marca), `${rotulo}: marca de outra empresa`);
        assert.ok(!tudo.includes(o.empresa), `${rotulo}: id de outra empresa`);
        assert.ok(!tudo.includes(o.gestao), `${rotulo}: id da Gestão de outra empresa`);
      }
      assert.ok(!tudo.includes(GLOBAL), `${rotulo}: linha global/legada (empresa nula) no pacote`);
      assert.ok(!tudo.includes(docGlobal), `${rotulo}: solicitação sem empresa`);
      for (const [e2, d] of Object.entries(docs)) if (e2 !== eu.empresa) assert.ok(!tudo.includes(d), `${rotulo}: solicitação de acesso de outra empresa`);
      assert.ok(!tudo.includes("203.0.113.9") && !tudo.includes("UA-MARCA"), `${rotulo}: IP/navegador de aceite`);
      // (2) todo UUID do pacote que é id de linha com dono conhecido pertence a esta empresa.
      const estranhos = new Set<string>();
      for (const u of tudo.match(UUID_RE) ?? []) {
        const dono = donos.get(u.toLowerCase());
        if (dono && dono !== eu.empresa && dono !== "GLOBAL") estranhos.add(`${u}→${dono}`);
      }
      assert.deepEqual([...estranhos], [], `${rotulo}: UUID de linha de outra empresa no pacote`);
      // (3) por CSV: coluna empresa_id = esta empresa; cada FK de coluna única aponta para linha desta empresa.
      let fkConferidas = 0;
      for (const a of manifesto.arquivos.filter((x) => x.tipo === "csv")) {
        const linhas = lerCsv(arquivos.get(a.caminho)!.toString("utf8"));
        const cab = linhas[0];
        const corpo = linhas.slice(1);
        if (cab.includes("empresa_id") && !a.tabela!.startsWith("perfil_")) {
          const i = cab.indexOf("empresa_id");
          for (const l of corpo) assert.equal(l[i], eu.empresa, `${rotulo} ${a.caminho}: empresa_id`);
        }
        for (const k of chaves.filter((x) => x.t === a.tabela)) {
          const i = cab.indexOf(k.c);
          if (i < 0) continue;
          for (const l of corpo) {
            const v = l[i];
            if (!v) continue;
            let dono: string | null | undefined;
            if (k.ft === "empresas") dono = v;
            else if (temEmpresaId.has(k.ft) && !k.ft.startsWith("perfil_")) dono = (await c.query<{ e: string | null }>(`SELECT empresa_id::text AS e FROM "${k.ft}" WHERE "${k.fc}"::text = $1`, [v])).rows[0]?.e;
            else continue;
            fkConferidas++;
            if (dono !== null && dono !== undefined && dono !== eu.empresa) assert.fail(`${rotulo} ${a.tabela}.${k.c} → ${k.ft}: ${dono}`);
          }
        }
      }
      relatorio.push(`${rotulo}: ${manifesto.totais.arquivos} arquivos, ${manifesto.totais.linhas} linhas, ${fkConferidas} FKs conferidas, ${(tudo.match(UUID_RE) ?? []).length} UUIDs conferidos`);
      // (4) pessoa multi-empresa: só os vínculos desta empresa.
      const vinc = lerCsv(arquivos.get("dados/empresa/vinculos.csv")!.toString("utf8"));
      const ids = vinc.slice(1).map((l) => l[vinc[0].indexOf("id")]);
      for (const [e, m] of Object.entries(mem)) assert.equal(ids.includes(m), e === eu.empresa, `${rotulo}: vínculo ${e === eu.empresa ? "próprio ausente" : "de outra empresa presente"}`);
    }
    // Perfil: cada empresa leva só o próprio.
    const pA = lerCsv(lerZip(pacotes.A.zip).get("dados/empresa/perfil_empresa.csv")!.toString("utf8"));
    assert.equal(pA.length - 1, 1, "A: um perfil");
    assert.equal(pA[1][pA[0].indexOf("id")], A.empresa);
    // A exportação de A pela pessoa multi-empresa é o mesmo conteúdo da exportação pela Gestão de A (só muda a auditoria).
    const semData = (r: typeof pacotes.A) => { const m = abrir(r).manifesto; return JSON.stringify(m.arquivos.filter((x) => x.caminho !== "LEIA-ME.txt").map((x) => [x.caminho, x.sha256])); };
    assert.equal(semData(pacotes.AporU), semData(pacotes.A));
    console.log(relatorio.join("\n"));
  } finally {
    await encerrarDescartavel(c);
  }
});

test("REVISÃO: guarda adversarial — sessão viva noutra empresa, usuário inativo, papel/vínculo, PROVISIONAMENTO, DESATIVADA no meio", { timeout: 300_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente"); return; }
  const c = await conectarDescartavel();
  const transacao = transacaoAninhada(c);
  const prova = (sessao: Parameters<typeof provarTenantParaExportacao>[1], empresa: string | null) => transacao((tx) => provarTenantParaExportacao(tx, sessao, empresa));
  const auditorias = async () => Number((await c.query(`SELECT count(*) AS n FROM auditoria WHERE acao = 'EXPORTACAO_DADOS'`)).rows[0].n);
  try {
    await c.query("BEGIN");
    const A = await montarEmpresa(c, "A"), B = await montarEmpresa(c, "B");
    // Pessoa U: Gestão em A (ativa) e Gestão em B; B é suspensa.
    const U = await id(c, `INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'U', $2, 'ADMINISTRATIVO', true) RETURNING id`, [`${cod()}@example.test`, SENHA_FALSA]);
    for (const e of [A.empresa, B.empresa]) {
      const m = await id(c, `INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', now(), 'REPRESENTANTE_AUTORIZADO') RETURNING id`, [e, U]);
      await c.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
    }
    await transacao(async () => c.query(`UPDATE empresas SET status = 'SUSPENSA' WHERE id = $1::uuid`, [B.empresa]));
    // Sessão VIVA de U selecionada em A (não revogada: A continua ativa).
    const sessaoA = await transacao(async () => id(c, `INSERT INTO sessoes_administrativas (usuario_id, token_hash, csrf_hash, autenticado_em, ultima_atividade_em, expira_em, empresa_ativa_id)
      VALUES ($1::uuid, $2, $3, now(), now(), now() + interval '8 hours', $4::uuid) RETURNING id`, [U, sha(randomUUID()), sha(randomUUID()), A.empresa]));
    await assert.rejects(prova(sessaoDe(U, { id: sessaoA, empresa_ativa_id: A.empresa }), B.empresa), /não comprova/, "sessão viva em A não leva a suspensa B por parâmetro");
    // P3-4: no pedido explícito do pacote completo (POST com CSRF), a mesma sessão viva em A baixa a suspensa B sem
    // sair e entrar; a sessão continua em A e uma empresa ATIVA continua exigindo a seleção.
    const viaPost = { permitirSelecaoNoutraEmpresa: true };
    const emA = sessaoDe(U, { id: sessaoA, empresa_ativa_id: A.empresa });
    assert.equal((await transacao((tx) => provarTenantParaExportacao(tx, emA, B.empresa, viaPost))).suspensa, true);
    const daSuspensa = await lido(exportarPacoteCompleto(emA, B.empresa, { requestId: randomUUID() }, { transacao }, viaPost));
    assert.equal(abrir(daSuspensa).manifesto.empresa.id, B.empresa);
    assert.equal((await c.query<{ e: string }>(`SELECT empresa_ativa_id::text AS e FROM sessoes_administrativas WHERE id = $1::uuid AND revogado_em IS NULL`, [sessaoA])).rows[0]?.e, A.empresa, "sessão continua em A");
    const C2 = await montarEmpresa(c, "C2");
    const mC2 = await id(c, `INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', now(), 'REPRESENTANTE_AUTORIZADO') RETURNING id`, [C2.empresa, U]);
    await c.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [mC2]);
    await assert.rejects(transacao((tx) => provarTenantParaExportacao(tx, emA, C2.empresa, viaPost)), /não comprova/, "outra empresa ATIVA continua exigindo a seleção");
    // Sessão sem empresa selecionada: leva B (suspensa) explicitamente.
    const sessaoNula = await transacao(async () => id(c, `INSERT INTO sessoes_administrativas (usuario_id, token_hash, csrf_hash, autenticado_em, ultima_atividade_em, expira_em, empresa_ativa_id)
      VALUES ($1::uuid, $2, $3, now(), now(), now() + interval '8 hours', NULL) RETURNING id`, [U, sha(randomUUID()), sha(randomUUID())]));
    assert.equal((await prova(sessaoDe(U, { id: sessaoNula, empresa_ativa_id: null }), B.empresa)).suspensa, true);
    // Mesma sessão, mas o banco diz que ela foi selecionada em A depois (contexto mudou): recusa.
    await transacao(async () => c.query(`UPDATE sessoes_administrativas SET empresa_ativa_id = $2::uuid WHERE id = $1::uuid`, [sessaoNula, A.empresa]));
    await assert.rejects(prova(sessaoDe(U, { id: sessaoNula, empresa_ativa_id: null }), B.empresa), /não comprova/);
    // Sessão revogada / expirada.
    await transacao(async () => c.query(`UPDATE sessoes_administrativas SET empresa_ativa_id = NULL, revogado_em = now() WHERE id = $1::uuid`, [sessaoNula]));
    await assert.rejects(prova(sessaoDe(U, { id: sessaoNula, empresa_ativa_id: null }), B.empresa), /não comprova/, "sessão revogada");
    // UUID em maiúsculas/espaços: mesma empresa (normalizado), sem abrir outra.
    assert.equal((await prova(sessaoDe(U), ` ${B.empresa.toUpperCase()} `)).empresaComprovada, B.empresa);
    // Usuário inativo.
    await transacao(async () => c.query(`UPDATE usuarios_administrativos SET ativo = false WHERE id = $1::uuid`, [U]));
    await assert.rejects(prova(sessaoDe(U), B.empresa), /não comprova/, "usuário inativo");
    await transacao(async () => c.query(`UPDATE usuarios_administrativos SET ativo = true WHERE id = $1::uuid`, [U]));
    // Papel trocado para Equipe na suspensa.
    await transacao(async () => c.query(`UPDATE memberships SET papel = 'ADMINISTRATIVO' WHERE usuario_id = $1::uuid AND empresa_id = $2::uuid`, [U, B.empresa]));
    await assert.rejects(prova(sessaoDe(U), B.empresa), /PAPEL_NAO_AUTORIZADO|Gestão/);
    await transacao(async () => c.query(`UPDATE memberships SET papel = 'REPRESENTANTE_AUTORIZADO' WHERE usuario_id = $1::uuid AND empresa_id = $2::uuid`, [U, B.empresa]));
    // Vínculo REVOGADO.
    const antesStatus = (await c.query<{ s: string }>(`SELECT status AS s FROM memberships WHERE usuario_id = $1::uuid AND empresa_id = $2::uuid`, [U, B.empresa])).rows[0].s;
    await transacao(async () => c.query(`UPDATE memberships SET status = 'REVOGADA', revogado_em = now() WHERE usuario_id = $1::uuid AND empresa_id = $2::uuid`, [U, B.empresa])).catch(() => undefined);
    const depois = (await c.query<{ s: string }>(`SELECT status AS s FROM memberships WHERE usuario_id = $1::uuid AND empresa_id = $2::uuid`, [U, B.empresa])).rows[0].s;
    if (depois !== antesStatus) {
      await assert.rejects(prova(sessaoDe(U), B.empresa), /não comprova/, "vínculo revogado");
      console.log("vínculo REVOGADA testado");
    } else console.log("REVOGADA não aceita pelo schema; coberto pelo teste do autor (SUSPENSA)");
    // PROVISIONAMENTO não é exceção.
    const P = await id(c, `INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Prov', 'PROVISIONAMENTO') RETURNING id`, [cod()]);
    const mp = await id(c, `INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', now(), 'REPRESENTANTE_AUTORIZADO') RETURNING id`, [P, A.gestao]);
    await c.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [mp]).catch(() => undefined);
    await assert.rejects(prova(sessaoDe(A.gestao), P), /não comprova/, "PROVISIONAMENTO");
    // B suspensa passa a DESATIVADA entre a leitura e a auditoria: nada entregue, nada auditado.
    const antes = await auditorias();
    const B2 = await montarEmpresa(c, "B2");
    await transacao(async () => c.query(`UPDATE empresas SET status = 'SUSPENSA' WHERE id = $1::uuid`, [B2.empresa]));
    const comMudanca = (sql: string, params: unknown[]): Transacao => { let n = 0; return async (work) => { if (++n === 3) await c.query(sql, params); return transacao(work); }; };
    await assert.rejects(exportarPacoteCompleto(sessaoDe(B2.gestao), B2.empresa, {}, { transacao: comMudanca(`UPDATE empresas SET status = 'DESATIVADA' WHERE id = $1::uuid`, [B2.empresa]) }), /não comprova/);
    // Papel da Gestão trocado para Equipe entre a leitura e a auditoria.
    const B3 = await montarEmpresa(c, "B3");
    await transacao(async () => c.query(`UPDATE empresas SET status = 'SUSPENSA' WHERE id = $1::uuid`, [B3.empresa]));
    await assert.rejects(exportarPacoteCompleto(sessaoDe(B3.gestao), B3.empresa, {}, { transacao: comMudanca(`UPDATE memberships SET papel = 'ADMINISTRATIVO' WHERE usuario_id = $1::uuid`, [B3.gestao]) }), /PAPEL_NAO_AUTORIZADO|Gestão|não comprova/);
    // Empresa ativa: papel trocado no meio.
    const A4 = await montarEmpresa(c, "A4");
    await assert.rejects(exportarPacoteCompleto(sessaoDe(A4.gestao), A4.empresa, {}, { transacao: comMudanca(`UPDATE memberships SET papel = 'ADMINISTRATIVO' WHERE usuario_id = $1::uuid`, [A4.gestao]) }), /PAPEL_NAO_AUTORIZADO|Gestão|não comprova/);
    assert.equal(await auditorias(), antes, "nenhuma auditoria nas recusas");
  } finally {
    await encerrarDescartavel(c);
  }
});

test("REVISÃO: fotografia REPEATABLE READ — escrita concorrente confirmada no meio da leitura não entra no pacote", { timeout: 120_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente"); return; }
  const c = await conectarDescartavel();
  const c2 = await conectarDescartavel({ travar: false });
  try {
    await c.query("BEGIN");
    const e = await id(c, `INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'RR', 'PROVISIONAMENTO') RETURNING id`, [cod()]);
    await c.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [e]);
    const u = await id(c, `INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'G', $2, 'ADMINISTRATIVO', true) RETURNING id`, [`${cod()}@example.test`, SENHA_FALSA]);
    const m = await id(c, `INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', now(), 'REPRESENTANTE_AUTORIZADO') RETURNING id`, [e, u]);
    await c.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
    await c.query(`INSERT INTO clientes (nome_completo, empresa_id) VALUES ('Cliente antes', $1::uuid)`, [e]);
    await c.query("COMMIT");
    let injetou = false;
    const transacaoReal: Transacao = async (work) => {
      await c.query("BEGIN");
      const tx = { query: async (sql: string, v?: unknown[]) => {
        // Depois que a fotografia foi tirada (consulta da empresa), outra conexão confirma um cliente novo e apaga um antigo.
        if (!injetou && /FROM "clientes" t/.test(sql)) {
          injetou = true;
          await c2.query(`INSERT INTO clientes (nome_completo, empresa_id) VALUES ('Cliente DEPOIS', $1::uuid)`, [e]);
        }
        return c.query(sql, v);
      } } as unknown as DbExecutor;
      try { const r = await work(tx); await c.query("COMMIT"); return r; } catch (erro) { await c.query("ROLLBACK"); throw erro; }
    };
    const r = await lido(exportarPacoteCompleto(sessaoDe(u), e, { requestId: randomUUID() }, { transacao: transacaoReal }));
    assert.ok(injetou, "escrita concorrente aconteceu no meio da leitura");
    const cl = lerZip(r.zip).get("dados/clientes/clientes.csv")!.toString("utf8");
    assert.ok(cl.includes("Cliente antes"));
    assert.ok(!cl.includes("Cliente DEPOIS"), "linha confirmada depois da fotografia entrou no pacote");
    assert.equal(abrir(r).manifesto.arquivos.find((a) => a.entidade === "clientes/clientes")!.linhas, 1);
    // Sem a fotografia (READ COMMITTED), a mesma injeção apareceria: prova de que o teste distingue.
    await c.query("BEGIN");
    const rc = await gerarPacote(c as unknown as DbExecutor, e);
    await c.query("COMMIT");
    await rc.limpar();
    assert.equal(rc.manifesto.arquivos.find((a) => a.entidade === "clientes/clientes")!.linhas, 2);
    // Arquivo do pacote real para conferência externa (dados sintéticos).
    const destino = process.env.REVISAO_ZIP_DESTINO;
    if (destino) writeFileSync(destino, r.zip);
  } finally {
    await c2.end();
    await encerrarDescartavel(c);
  }
});

test("FK no catálogo: cada filtro do inventário segue uma FK real (coluna → pai.id) e o empresa_id direto aponta para empresas", { timeout: 120_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente"); return; }
  const c = await conectarDescartavel();
  try {
    const fks = (await c.query<{ t: string; c: string; ft: string; fc: string }>(`SELECT cl.relname AS t, a.attname AS c, fcl.relname AS ft, fa.attname AS fc
      FROM pg_constraint k JOIN pg_class cl ON cl.oid = k.conrelid JOIN pg_class fcl ON fcl.oid = k.confrelid
      CROSS JOIN LATERAL unnest(k.conkey, k.confkey) AS u(ca, cf)
      JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.ca
      JOIN pg_attribute fa ON fa.attrelid = k.confrelid AND fa.attnum = u.cf
      WHERE k.contype = 'f'`)).rows;
    const tem = (tabela: string, col: string, pai: string) => fks.some((f) => f.t === tabela && f.c === col && f.ft === pai && f.fc === "id");
    // FK composta ou por tabela intermediária: coluna → X.col, e X.col → pai(id) (ex.: pagamento_* → pagamento_gestoes
    // (pagamento_id) → pagamentos(id); fechamento_revisoes → contratos(fechamento_id, …) → fechamentos(id)).
    const segue = (tabela: string, col: string, pai: string) => tem(tabela, col, pai)
      || fks.some((f) => f.t === tabela && f.c === col && tem(f.ft, f.fc, pai))
      || (tabela === pai && col === "id"); // o próprio perfil, escolhido pela associação perfil ↔ empresa
    // Sem FK para empresas por construção (gatilho de tenant da 086): filtra pela própria coluna, sem cruzamento.
    const SEM_FK_DECLARADA = new Set(["marketing_contato_preferencias_eventos"]);
    let conferidos = 0;
    const falhas: string[] = [];
    const presentes = new Set((await c.query<{ t: string }>("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public'")).rows.map((r) => r.t));
    let posteriores = 0;
    for (const e of ENTIDADES) {
      // Migration posterior à 089 ausente aqui: a FK é provada na suíte da própria migration.
      if (e.migracao && !presentes.has(e.tabela)) { posteriores++; continue; }
      if (e.onde === "t.id = $1::uuid") { conferidos++; continue; }
      if (e.onde === "t.empresa_id = $1::uuid") {
        if (tem(e.tabela, "empresa_id", "empresas") || fks.some((f) => f.t === e.tabela && f.c === "empresa_id") || SEM_FK_DECLARADA.has(e.tabela)) conferidos++;
        else falhas.push(`${e.tabela}: empresa_id sem FK`);
        continue;
      }
      for (const parte of e.onde.split(/ AND (?=t\.)/)) {
        const m = /^t\.(\w+) IN \(SELECT (\w+)\.(\w+) FROM (\w+) \2 /.exec(parte);
        if (!m) { falhas.push(`${e.tabela}: filtro não reconhecido`); continue; }
        const [, col, , colPai, pai] = m;
        if (colPai === "usuario_id" && pai === "memberships") { conferidos++; continue; } // usuários: pela lista de vínculos da empresa
        if (colPai !== "id") { falhas.push(`${e.tabela}: subconsulta devolve ${pai}.${colPai}`); continue; }
        if (segue(e.tabela, col, pai)) conferidos++; else falhas.push(`${e.tabela}.${col} não é FK para ${pai}(id)`);
      }
    }
    assert.deepEqual(falhas, []);
    assert.ok(conferidos + posteriores >= ENTIDADES.length, `conferidos: ${conferidos}, posteriores: ${posteriores}`);
  } finally {
    await encerrarDescartavel(c);
  }
});

const pastasTemporarias = () => readdirSync(tmpdir()).filter((n) => n.startsWith(PREFIXO_TEMPORARIO));

test("inventário em execução (P2-3): tabela pública não classificada recusa a exportação inteira, sem pacote, temporário nem auditoria", { timeout: 120_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente"); return; }
  const c = await conectarDescartavel();
  const transacao = transacaoAninhada(c);
  try {
    await c.query("BEGIN");
    const A = await montarEmpresa(c, "A");
    const antes = pastasTemporarias().length;
    const auditorias = async () => Number((await c.query(`SELECT count(*) AS n FROM auditoria WHERE acao = 'EXPORTACAO_DADOS'`)).rows[0].n);
    const n0 = await auditorias();
    await c.query("CREATE TABLE public.tabela_nova_sem_decisao (id uuid PRIMARY KEY, empresa_id uuid)");
    const erro = console.error;
    const log: string[] = [];
    console.error = (...a: unknown[]) => { log.push(a.join(" ")); };
    try {
      await assert.rejects(exportarPacoteCompleto(sessaoDe(A.gestao), A.empresa, {}, { transacao }), (e: { code?: string; httpStatus?: number }) => e.code === "EXPORTACAO_INVENTARIO_DESATUALIZADO" && e.httpStatus === 503);
    } finally { console.error = erro; }
    assert.ok(log.some((l) => l.includes("tabela_nova_sem_decisao")));
    assert.equal(await auditorias(), n0);
    assert.equal(pastasTemporarias().length, antes, "nenhum temporário sobra");
    await c.query("DROP TABLE public.tabela_nova_sem_decisao");
    await lido(exportarPacoteCompleto(sessaoDe(A.gestao), A.empresa, {}, { transacao }));
  } finally {
    await encerrarDescartavel(c);
  }
});

test("limite por empresa e pessoa (P3-2) e auditoria das recusas da guarda sem dados pessoais (P3-5)", { timeout: 300_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente"); return; }
  const c = await conectarDescartavel();
  const transacao = transacaoAninhada(c);
  try {
    await c.query("BEGIN");
    const A = await montarEmpresa(c, "A"), B = await montarEmpresa(c, "B");
    const uso = { porEmpresaHora: 1, porPessoaHora: 10 };
    await lido(exportarPacoteCompleto(sessaoDe(A.gestao), A.empresa, {}, { transacao, uso }));
    await assert.rejects(exportarPacoteCompleto(sessaoDe(A.gestao), A.empresa, {}, { transacao, uso }), (e: { code?: string; httpStatus?: number }) => e.code === "EXPORTACAO_LIMITE" && e.httpStatus === 429);
    // Outra empresa não é afetada pelo limite de A; a pessoa tem o próprio limite.
    await lido(exportarPacoteCompleto(sessaoDe(B.gestao), B.empresa, {}, { transacao, uso }));
    await assert.rejects(exportarPacoteCompleto(sessaoDe(B.gestao), B.empresa, {}, { transacao, uso: { porEmpresaHora: 10, porPessoaHora: 1 } }), /limite/);
    // Recusas da guarda: Equipe e pessoa de outra empresa — auditadas com código, sem conteúdo, IP ou navegador.
    const recusas = async () => (await c.query<{ usuario_id: string; entidade_tipo: string; entidade_id: string; dados_depois: Record<string, unknown>; ip: string | null; user_agent: string | null }>(
      `SELECT usuario_id::text, entidade_tipo, entidade_id::text, dados_depois, ip::text, user_agent FROM auditoria WHERE acao = 'EXPORTACAO_RECUSADA' ORDER BY criado_em, id`)).rows;
    const r0 = (await recusas()).length;
    await assert.rejects(exportarPacoteCompleto(sessaoDe(A.equipe), A.empresa, {}, { transacao }), /PAPEL_NAO_AUTORIZADO|Gestão/);
    await assert.rejects(exportarPacoteCompleto(sessaoDe(B.gestao), A.empresa, {}, { transacao }), /não comprova/);
    await assert.rejects(exportarPacoteCompleto(sessaoDe(B.gestao), "nao-e-uuid", {}, { transacao }), /não comprova/);
    const novas = (await recusas()).slice(r0);
    // Mesma transação externa no teste = mesmo criado_em: compara como conjunto.
    assert.deepEqual(novas.map((r) => [r.usuario_id, r.entidade_tipo, r.entidade_id, r.dados_depois.codigo]).sort(), [
      [A.equipe, "EMPRESA", A.empresa, "PAPEL_NAO_AUTORIZADO"],
      [B.gestao, "EMPRESA", A.empresa, "TENANT_NAO_COMPROVADO"],
      [B.gestao, "USUARIO", B.gestao, "TENANT_NAO_COMPROVADO"],
    ].sort());
    for (const r of novas) {
      assert.equal(r.ip, null); assert.equal(r.user_agent, null);
      assert.deepEqual(Object.keys(r.dados_depois).sort(), ["codigo", "empresaInformada", "tipo"]);
    }
    assert.ok(!JSON.stringify(novas).includes(A.marca) && !JSON.stringify(novas).includes("nao-e-uuid"), "sem conteúdo nem o texto pedido");
  } finally {
    await encerrarDescartavel(c);
  }
});
