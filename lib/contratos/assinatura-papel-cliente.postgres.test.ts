import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import {
  ambienteAssinatura, assinarComoCliente, carregar, catalogoNativo, cenario, congelarEAssinarKidmais, cpfValido, dia, executor, id, poolNaTransacao, validarAgora,
  type Cenario,
} from "../../scripts/integracao-importados-test-support.ts";
import { travarConfiguracaoAgenda } from "../agenda/trava-configuracao.ts";

/**
 * 124 — assinatura do cliente em PAPEL (plano r3 + r3.1) no PostgreSQL DESCARTÁVEL com a 124 aplicada. Contrato nativo
 * real (gerado, assinado pelo buffet e liberado ao cliente pelo caminho do Admin); a Gestão registra a data declarada e,
 * opcionalmente, a cópia. Cobre o caminho feliz com e sem cópia, a festa formalizada, o template preenchido, a data civil,
 * a idempotência, a recusa da assinatura digital depois do papel (leitura continua), tenant/Gestão, datas fora do
 * intervalo, as 14 combinações parciais da cópia, o limite de tamanho, a imutabilidade e os invariantes do COMMIT.
 * Cada teste termina em ROLLBACK; o gatilho diferido da 124 é disparado com validarAgora (como no COMMIT).
 */
const opt = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL === "kidmais_pacotes_v1_descartavel";
let a: Client;
let com124 = false;
type Operar = Parameters<typeof congelarEAssinarKidmais>[1];
const MODELO = {
  titulo: "Contrato", contratada: { nome: "Buffet Teste Ltda", documento: "12.345.678/0001-90", endereco: "Rua Teste, 2", representante: "Pessoa Teste" },
  preambulo: [], observacoes: [], cidadeAssinatura: "Cidade Teste",
  clausulas: [{ titulo: "Objeto", texto: "Festa em {{festa.data}} das {{festa.inicio}} às {{festa.fim}} ({{festa.pacote}}), {{festa.convidados}} convidados, {{valor.total}}, {{pagamento.condicao}}. {{contratante.tipo_documento}} {{contratante.documento}}." }],
};
const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from("conteudo sintetico do contrato assinado\n%%EOF\n")]);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const servico = () => carregar<typeof import("./services/assinatura-papel-cliente.service.ts")>("lib/contratos/services/assinatura-papel-cliente.service.ts");
const publico = () => carregar<typeof import("./services/contrato-publico.service.ts")>("lib/contratos/services/contrato-publico.service.ts");
const ctx = () => ({ requestId: randomUUID(), ip: null, userAgent: "pg-124" });

async function emTx(corpo: () => Promise<void>) {
  await a.query("BEGIN");
  const restaurarPool = poolNaTransacao(a);
  const restaurarAmbiente = ambienteAssinatura();
  try { await corpo(); } finally { await a.query("ROLLBACK"); restaurarAmbiente(); restaurarPool(); }
}
/** Recusa isolada em SAVEPOINT: o efeito (e os gatilhos diferidos enfileirados) somem com o rollback parcial. */
async function recusa<T>(p: () => Promise<T>, f: (e: unknown) => boolean, rotulo?: string) {
  await a.query("SAVEPOINT recusa");
  try { await assert.rejects(p(), f, rotulo); } finally { await a.query("ROLLBACK TO SAVEPOINT recusa"); }
}
/**
 * Recusa com o estado conferido ANTES da limpeza do harness (Astra r2): o oráculo roda na mesma transação, depois da
 * recusa e antes do ROLLBACK TO SAVEPOINT. Se o serviço não desfizer o próprio trabalho, a consulta falha com 25P02
 * (transação abortada) ou as contagens mudam; a limpeza do helper não mascara a ausência de rollback.
 */
async function recusaConferindo<T>(p: () => Promise<T>, f: (e: unknown) => boolean, conferir: () => Promise<void>, rotulo?: string) {
  await a.query("SAVEPOINT recusa_conferida");
  try {
    let erro: unknown = null, ok = false;
    try { await p(); ok = true; } catch (e) { erro = e; }
    assert.equal(ok, false, `${rotulo ?? "recusa"}: era esperada uma recusa`);
    assert.ok(f(erro), `${rotulo ?? "recusa"}: recusa diferente da esperada`);
    await conferir();
  } finally { await a.query("ROLLBACK TO SAVEPOINT recusa_conferida"); }
}
const codigo = (c: string, status?: number) => (e: unknown) => {
  const x = e as { code?: string; httpStatus?: number };
  if (x.code !== c || (status !== undefined && x.httpStatus !== status)) { console.error("recusa inesperada", x.code, x.httpStatus, (e as Error).message); return false; }
  return true;
};
const pgRecusa = (re: RegExp) => (e: unknown) => (e as { code?: string }).code === "23514" && re.test((e as Error).message);
const hojeSp = async () => (await a.query<{ d: string }>("SELECT (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS d")).rows[0].d;
const somar = (d: string, dias: number) => new Date(Date.parse(`${d}T12:00:00Z`) + dias * 86_400_000).toISOString().slice(0, 10);

type Aguardando = { c: Cenario; nativo: Awaited<ReturnType<typeof catalogoNativo>>; contratoId: string; versaoId: string; cpf: string };

/** Contrato nativo V1 assinado pelo buffet e liberado ao cliente (AGUARDANDO_CLIENTE); festa daqui a `diasAteFesta`. */
async function aguardandoCliente(diasAteFesta = 130): Promise<Aguardando> {
  const c = await cenario(a, 0);
  const nativo = await catalogoNativo(a, c);
  await a.query(`INSERT INTO modelos_contrato_empresa (empresa_id, versao, conteudo, conteudo_sha256, aprovado_por) VALUES ($1::uuid, 1, $2::jsonb, $3, $4::uuid)`,
    [c.empresa, JSON.stringify(MODELO), "a".repeat(64), c.usuario]);
  const cpf = cpfValido();
  const clienteId = await id(a,
    `INSERT INTO clientes (nome_completo, cpf, empresa_id, email, telefone, whatsapp, cep, logradouro, numero, bairro, cidade, uf)
     VALUES ('Cliente Papel Sintético', $1, $2::uuid, $3, '11999998888', '11999998888', '01001000', 'Rua Sintética', '1', 'Centro', 'São Paulo', 'SP') RETURNING id`,
    [cpf, c.empresa, `${randomUUID()}@example.invalid`]);
  const aniversariante = await id(a, `INSERT INTO aniversariantes (cliente_id, nome) VALUES ($1::uuid, 'Aniversariante') RETURNING id`, [clienteId]);
  await travarConfiguracaoAgenda(executor(a), c.empresa, { modo: "COMPARTILHADA", linha: "KEY_SHARE" });
  const fechamento = await id(a, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
        categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, aniversariante_id, status)
      SELECT $1::date, '10:00', '22:00', $2::uuid, $3::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', 30, 30, 100, 100, 100, 'ATENDIMENTO_KIDMAIS', $5::uuid, $6::uuid, 'AGUARDANDO_CONTRATO'
        FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $4::uuid LIMIT 1 RETURNING fechamentos.id`,
    [dia(diasAteFesta), nativo.turno, c.empresa, c.pacote, clienteId, aniversariante]);
  const contratos = carregar<typeof import("./services/contrato.service.ts")>("lib/contratos/services/contrato.service.ts");
  const gerado = await contratos.gerarContrato({ fechamentoId: fechamento } as never, { usuarioId: c.usuario, origem: "SISTEMA", executor: executor(a) } as never) as { contrato: { id: string }; versao: { id: string } };
  const adm = carregar<typeof import("./services/administrativo.service.ts")>("lib/contratos/services/administrativo.service.ts");
  await congelarEAssinarKidmais(a, adm.operarContrato as unknown as Operar, gerado.versao.id, c.empresa, c.token, nativo.tokenRepresentante);
  await validarAgora(a);
  return { c, nativo, contratoId: gerado.contrato.id, versaoId: gerado.versao.id, cpf };
}

const registrar = (x: Aguardando, dados: { dataDeclarada: string; observacao?: string; chaveIdempotencia?: string }, arquivo: { bytes: Buffer; tipo: string } | null = null,
  token = x.nativo.tokenRepresentante, empresa: string | null = x.c.empresa) =>
  servico().registrarAssinaturaPapelCliente(x.versaoId, { chaveIdempotencia: randomUUID(), ...dados }, arquivo, token, ctx(), empresa);

/** INSERT direto (SQL) de uma linha de papel com a Gestão real do cenário; `extra` sobrepõe colunas. */
async function inserirDireto(x: Aguardando, extra: Record<string, unknown> = {}) {
  const linha: Record<string, unknown> = {
    empresa_id: x.c.empresa, contrato_id: x.contratoId, contrato_versao_id: x.versaoId, data_declarada: await hojeSp(),
    registrado_por_usuario_id: x.nativo.representante.usuarioId, membership_id: x.nativo.representante.membershipId,
    chave_idempotencia: randomUUID(), payload_hash: "b".repeat(64), ...extra,
  };
  const cols = Object.keys(linha);
  return a.query(`INSERT INTO contrato_assinaturas_papel (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")}) RETURNING id`, cols.map((k) => linha[k]));
}

test.before(async () => {
  if (!opt()) return;
  process.env.FESTA_ENABLED = "true";
  a = await conectarDescartavel();
  com124 = (await a.query("SELECT to_regclass('public.contrato_assinaturas_papel') IS NOT NULL AS ok")).rows[0].ok;
});
test.after(async () => { if (a) await encerrarDescartavel(a); });

test("124: o módulo Festa segue disponível (manifesto da 019 com o conjunto 124)", { skip: !opt(), timeout: 60_000 }, async (t) => {
  if (!com124) return t.skip("modelo sem a 124");
  const ambiente = carregar<typeof import("../festas/ambiente.ts")>("lib/festas/ambiente.ts");
  await emTx(async () => { await ambiente.validarAmbienteFesta(executor(a)); });
});

test("124: Gestão registra com cópia — versão ASSINADA/PAPEL_CLIENTE com template, data civil, festa formalizada, leitura pública só com a data", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (!com124) return t.skip("modelo sem a 124");
  await emTx(async () => {
    const x = await aguardandoCliente();
    const template = (await a.query("SELECT documento_template_versao FROM contrato_versoes WHERE id = $1::uuid", [x.versaoId])).rows[0].documento_template_versao;
    assert.equal(template, null, "PAP-R3-1: a V1 emitida pelo caminho normal começa sem template");
    const hoje = await hojeSp();
    const chave = randomUUID();
    const r = await registrar(x, { dataDeclarada: hoje, observacao: "Assinado na recepção", chaveIdempotencia: chave }, { bytes: PDF, tipo: "application/pdf" });
    await validarAgora(a);
    assert.equal(r.reutilizado, false);
    assert.equal(r.dataDeclarada, hoje);

    const v = (await a.query(`SELECT v.status, v.aceite_metodo, v.documento_template_versao, v.documento_pdf_hash,
        v.assinado_em = public.kidmais124_instante_civil($2::date) AS meio_dia, d.template_versao AS doc_template, d.pdf_hash AS doc_hash
        FROM contrato_versoes v JOIN contrato_edicoes e ON e.contrato_versao_id = v.id JOIN contrato_documentos d ON d.id = e.documento_revisado_id
       WHERE v.id = $1::uuid`, [x.versaoId, hoje])).rows[0];
    assert.equal(v.status, "ASSINADA");
    assert.equal(v.aceite_metodo, "PAPEL_CLIENTE");
    assert.ok(v.documento_template_versao, "template preenchido no UPDATE próprio");
    assert.equal(v.documento_template_versao, v.doc_template);
    assert.equal(v.documento_pdf_hash, v.doc_hash);
    assert.equal(v.meio_dia, true, "assinado_em = meio-dia SP da data declarada");
    const estados = (await a.query(`SELECT c.status AS contrato, fe.status AS fechamento, e.estado AS edicao, cf.versao_vigente_id::text AS vigente, cf.versao_em_preparacao_id AS preparo
        FROM contratos c JOIN fechamentos fe ON fe.id = c.fechamento_id JOIN contrato_fluxos cf ON cf.contrato_id = c.id
        JOIN contrato_edicoes e ON e.contrato_versao_id = $2::uuid WHERE c.id = $1::uuid`, [x.contratoId, x.versaoId])).rows[0];
    assert.deepEqual(estados, { contrato: "ASSINADO", fechamento: "CONTRATO_ASSINADO", edicao: "CONCLUIDA", vigente: x.versaoId, preparo: null });
    assert.equal((await a.query("SELECT count(*)::int AS n FROM festas WHERE contrato_id = $1::uuid AND invalidada_em IS NULL", [x.contratoId])).rows[0].n, 1, "festa formalizada");
    assert.equal((await a.query("SELECT public.kidmais019_formalizacao($1::uuid, $2::uuid) AS ok", [x.contratoId, x.versaoId])).rows[0].ok, true);
    assert.equal((await a.query("SELECT count(*)::int AS n FROM contrato_assinaturas WHERE contrato_versao_id = $1::uuid AND parte = 'CLIENTE'", [x.versaoId])).rows[0].n, 0);

    const linha = (await a.query(`SELECT arquivo_sha256, arquivo_tamanho, arquivo_tipo, registrado_em IS NOT NULL AS registrado, observacao FROM contrato_assinaturas_papel WHERE contrato_versao_id = $1::uuid`, [x.versaoId])).rows[0];
    assert.deepEqual(linha, { arquivo_sha256: sha(PDF), arquivo_tamanho: PDF.length, arquivo_tipo: "application/pdf", registrado: true, observacao: "Assinado na recepção" });

    // Histórico e auditoria do registro.
    assert.equal((await a.query("SELECT count(*)::int AS n FROM auditoria WHERE acao = 'CONTRATO_ASSINADO_PAPEL_CLIENTE' AND entidade_id = $1::uuid", [x.versaoId])).rows[0].n, 1);

    // Leitura administrativa (Gestão) com os bytes; sem Gestão = 403; outra empresa = 404.
    const adm = await servico().lerAssinaturaPapelAdmin(x.versaoId, x.nativo.tokenRepresentante, x.c.empresa, true) as { arquivo: Buffer; sha256: string; temArquivo: boolean };
    assert.equal(adm.temArquivo, true);
    assert.equal(sha(Buffer.from(adm.arquivo)), adm.sha256);
    await recusa(() => servico().lerAssinaturaPapelAdmin(x.versaoId, x.c.token, x.c.empresa, true), codigo("PAPEL_NAO_AUTORIZADO", 403));
    const b = await cenario(a, 0);
    const nativoB = await catalogoNativo(a, b);
    await recusa(() => servico().lerAssinaturaPapelAdmin(x.versaoId, nativoB.tokenRepresentante, b.empresa, true), codigo("ASSINATURA_PAPEL_NAO_ENCONTRADA", 404));

    // DTO público: só a data, nunca bytes, sha, tamanho, tipo, observação ou autor.
    const dto = await publico().assinaturaPapelClientePublica({ id: x.versaoId, aceiteMetodo: "PAPEL_CLIENTE" });
    assert.deepEqual(dto, { data: hoje });
    const serial = JSON.stringify(dto);
    for (const proibido of [sha(PDF), "Assinado na recepção", "application/pdf", String(PDF.length)]) assert.ok(!serial.includes(proibido), proibido);

    // Idempotência: mesma chave e mesmo conteúdo reaproveita; mesma chave com outro conteúdo = 409; chave nova = já assinado.
    const repetido = await registrar(x, { dataDeclarada: hoje, observacao: "Assinado na recepção", chaveIdempotencia: chave }, { bytes: PDF, tipo: "application/pdf" });
    assert.equal(repetido.reutilizado, true);
    assert.equal(repetido.assinaturaPapelId, r.assinaturaPapelId);
    await recusa(() => registrar(x, { dataDeclarada: hoje, observacao: "outra", chaveIdempotencia: chave }), codigo("CHAVE_IDEMPOTENCIA_REUTILIZADA", 409));
    await recusa(() => registrar(x, { dataDeclarada: hoje }), codigo("CONTRATO_JA_ASSINADO", 409));
    assert.equal((await a.query("SELECT count(*)::int AS n FROM festas WHERE contrato_id = $1::uuid", [x.contratoId])).rows[0].n, 1, "uma festa só");

    // Imutabilidade: UPDATE, DELETE e TRUNCATE recusados.
    await recusa(() => a.query("UPDATE contrato_assinaturas_papel SET observacao = 'x' WHERE contrato_versao_id = $1::uuid", [x.versaoId]), pgRecusa(/imutável/));
    await recusa(() => a.query("DELETE FROM contrato_assinaturas_papel WHERE contrato_versao_id = $1::uuid", [x.versaoId]), pgRecusa(/imutável/));
    await recusa(() => a.query("TRUNCATE contrato_assinaturas_papel"), pgRecusa(/imutável/));
  });
});

test("124: sem cópia passa; o cliente que ainda tinha o link lê o contrato com a data e recebe 409 ao tentar assinar (OTP intacto)", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (!com124) return t.skip("modelo sem a 124");
  await emTx(async () => {
    const x = await aguardandoCliente();
    const pub = publico();
    // O cliente abre o link e confirma o código ANTES do registro em papel.
    const acesso = await pub.consultarAcessoContrato({ contratoId: x.contratoId, cpf: x.cpf }) as { canais: Array<{ canal: string }> };
    let cod = "";
    const emissor = async (y: { codigo: string }) => { cod = y.codigo; };
    const desafio = await pub.iniciarDesafioContrato({ contratoId: x.contratoId, cpf: x.cpf, canal: acesso.canais[0].canal } as never, emissor as never) as { validacaoId: string; acessoToken: string };
    const identidade = carregar<{ criarIdentityServiceComAmbiente: (s: (y: { codigo: string }) => Promise<void>) => { confirmarCodigo: (i: { validacaoId: string; codigo: string }) => Promise<{ provaToken: string }> } }>("lib/identidade/services/index.ts");
    const prova = await identidade.criarIdentityServiceComAmbiente(emissor).confirmarCodigo({ validacaoId: desafio.validacaoId, codigo: cod });
    const entrada = { contratoId: x.contratoId, acessoToken: desafio.acessoToken, provaToken: prova.provaToken };
    const antes = await pub.obterContextoContratoPublico(entrada);

    const hoje = await hojeSp();
    await registrar(x, { dataDeclarada: hoje });
    await validarAgora(a);
    assert.equal((await a.query("SELECT arquivo IS NULL AND arquivo_sha256 IS NULL AS sem FROM contrato_assinaturas_papel WHERE contrato_versao_id = $1::uuid", [x.versaoId])).rows[0].sem, true);

    const depois = await pub.obterContextoContratoPublico(entrada) as unknown as { assinatura: { tipo: string; texto: string }; assinaturaPapelCliente: { data: string } | null; aceitePermitido: boolean };
    assert.equal(depois.assinatura.tipo, "PAPEL_CLIENTE");
    assert.deepEqual(depois.assinaturaPapelCliente, { data: hoje });
    assert.equal(depois.aceitePermitido, false);
    const validacao = (await a.query("SELECT status FROM validacoes_identidade_cliente WHERE id = $1::uuid", [desafio.validacaoId])).rows[0].status;
    await recusa(() => pub.assinarContratoPublico({ ...entrada, versaoId: antes.versao.id, snapshotHash: antes.versao.snapshotHash, documentoPdfHash: antes.versao.documentoPdfHash } as never,
      (async () => { throw new Error("nenhum OTP externo"); }) as never, { requestId: randomUUID() }), codigo("CONTRATO_JA_ASSINADO", 409));
    assert.equal((await a.query("SELECT status FROM validacoes_identidade_cliente WHERE id = $1::uuid", [desafio.validacaoId])).rows[0].status, validacao, "a prova não é consumida");
    assert.equal((await a.query("SELECT count(*)::int AS n FROM contrato_assinaturas WHERE contrato_versao_id = $1::uuid AND parte = 'CLIENTE'", [x.versaoId])).rows[0].n, 0);
  });
});

test("124: recusas do serviço — sem Gestão 403, outra empresa 404, data antes da liberação e no futuro 422, cancelado; nada gravado", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (!com124) return t.skip("modelo sem a 124");
  await emTx(async () => {
    const x = await aguardandoCliente();
    const hoje = await hojeSp();
    await recusa(() => registrar(x, { dataDeclarada: hoje }, null, x.c.token), codigo("PAPEL_NAO_AUTORIZADO", 403));
    const b = await cenario(a, 0);
    const nativoB = await catalogoNativo(a, b);
    await recusa(() => registrar(x, { dataDeclarada: hoje }, null, nativoB.tokenRepresentante, b.empresa), codigo("CONTRATO_NAO_ENCONTRADO", 404));
    await recusa(() => registrar(x, { dataDeclarada: somar(hoje, -1) }), codigo("DATA_DECLARADA_INVALIDA", 422));
    await recusa(() => registrar(x, { dataDeclarada: somar(hoje, 1) }), codigo("DATA_DECLARADA_INVALIDA", 422));
    // Cópia: tipo declarado diferente do conteúdo, vazia e acima de 25 MB recusam antes do banco.
    await recusa(() => registrar(x, { dataDeclarada: hoje }, { bytes: PDF, tipo: "image/png" }), (e) => (e as { httpStatus?: number }).httpStatus === 422 || (e as { httpStatus?: number }).httpStatus === 400);
    await recusa(() => registrar(x, { dataDeclarada: hoje }, { bytes: Buffer.alloc(0), tipo: "application/pdf" }), (e) => [400, 422].includes((e as { httpStatus?: number }).httpStatus ?? 0));
    const grande = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(26214400 - 8)]);
    await recusa(() => registrar(x, { dataDeclarada: hoje }, { bytes: grande, tipo: "application/pdf" }), (e) => [400, 413, 422].includes((e as { httpStatus?: number }).httpStatus ?? 0));
    assert.equal((await a.query("SELECT count(*)::int AS n FROM contrato_assinaturas_papel WHERE contrato_versao_id = $1::uuid", [x.versaoId])).rows[0].n, 0);
    assert.equal((await a.query("SELECT status FROM contrato_versoes WHERE id = $1::uuid", [x.versaoId])).rows[0].status, "ATIVA");
  });
});

test("124: banco — 14 combinações parciais da cópia recusam, as 4 completas/ausentes passam; 25 MB passa e +1 byte recusa; sha divergente recusa", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (!com124) return t.skip("modelo sem a 124");
  await emTx(async () => {
    const x = await aguardandoCliente();
    const campos = { arquivo: PDF, arquivo_tipo: "application/pdf", arquivo_tamanho: PDF.length, arquivo_sha256: sha(PDF) } as Record<string, unknown>;
    const nomes = Object.keys(campos);
    let parciais = 0;
    for (let m = 0; m < 16; m++) {
      const extra = Object.fromEntries(nomes.filter((_, i) => m & (1 << i)).map((n) => [n, campos[n]]));
      const qtd = Object.keys(extra).length;
      if (qtd === 0 || qtd === 4) {
        await a.query("SAVEPOINT combinacao");
        await inserirDireto(x, extra);
        await a.query("ROLLBACK TO SAVEPOINT combinacao");
      } else {
        parciais++;
        await recusa(() => inserirDireto(x, extra), (e) => (e as { code?: string }).code === "23514", `combinação ${JSON.stringify(Object.keys(extra))}`);
      }
    }
    assert.equal(parciais, 14);
    const limite = Buffer.alloc(26214400, 1);
    await a.query("SAVEPOINT limite");
    await inserirDireto(x, { arquivo: limite, arquivo_tipo: "application/pdf", arquivo_tamanho: limite.length, arquivo_sha256: sha(limite) });
    await a.query("ROLLBACK TO SAVEPOINT limite");
    const acima = Buffer.alloc(26214401, 1);
    await recusa(() => inserirDireto(x, { arquivo: acima, arquivo_tipo: "application/pdf", arquivo_tamanho: acima.length, arquivo_sha256: sha(acima) }), (e) => (e as { code?: string }).code === "23514");
    await recusa(() => inserirDireto(x, { ...campos, arquivo_sha256: "c".repeat(64) }), pgRecusa(/sha256 do arquivo divergente/));
    await recusa(() => inserirDireto(x, { ...campos, arquivo_tamanho: PDF.length + 1 }), (e) => (e as { code?: string }).code === "23514");
    // Futuro (relógio do banco) e Gestão de outra empresa / sem Gestão recusam no BEFORE INSERT.
    await recusa(() => inserirDireto(x, { data_declarada: dia(2) }), pgRecusa(/data declarada no futuro/));
    await recusa(() => inserirDireto(x, { registrado_por_usuario_id: x.c.usuario, membership_id: x.c.membership }), pgRecusa(/Gestão ativa/));
    const b = await cenario(a, 0);
    const nativoB = await catalogoNativo(a, b);
    await recusa(() => inserirDireto(x, { registrado_por_usuario_id: nativoB.representante.usuarioId, membership_id: nativoB.representante.membershipId }), pgRecusa(/Gestão ativa/));
  });
});

test("124: invariantes do COMMIT — linha sem PAPEL_CLIENTE recusa; PAPEL_CLIENTE sem linha recusa; papel + CLIENTE recusa", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (!com124) return t.skip("modelo sem a 124");
  await emTx(async () => {
    const x = await aguardandoCliente();
    // Linha de papel sem a versão marcada: o gatilho diferido recusa no COMMIT.
    await recusa(async () => { await inserirDireto(x); await validarAgora(a); }, (e) => ["23514", "P0001"].includes((e as { code?: string }).code ?? ""), "linha sem método");
    // Método PAPEL_CLIENTE sem linha.
    await recusa(async () => {
      await a.query(`UPDATE contrato_versoes v SET status = 'ASSINADA', aceite_metodo = 'PAPEL_CLIENTE', assinado_em = clock_timestamp(),
          documento_template_versao = d.template_versao, documento_pdf_hash = d.pdf_hash
        FROM contrato_edicoes e JOIN contrato_documentos d ON d.id = e.documento_revisado_id WHERE e.contrato_versao_id = v.id AND v.id = $1::uuid`, [x.versaoId]);
      await validarAgora(a);
    }, (e) => ["23514", "P0001"].includes((e as { code?: string }).code ?? ""), "método sem linha");
    // Depois do papel válido, a assinatura digital do cliente pelo fluxo público é recusada.
    await registrar(x, { dataDeclarada: await hojeSp() });
    await validarAgora(a);
    await recusa(() => assinarComoCliente(x.contratoId, x.cpf), (e) => (e as { code?: string; httpStatus?: number }).httpStatus === 409 || /ASSINADO|ASSINADA/.test(String((e as { code?: string }).code)));
    // Troca do método depois do papel: recusada no COMMIT.
    await recusa(async () => { await a.query("UPDATE contrato_versoes SET aceite_metodo = 'OTP' WHERE id = $1::uuid", [x.versaoId]); await validarAgora(a); },
      (e) => ["23514", "P0001"].includes((e as { code?: string }).code ?? ""), "troca de método");
  });
});

test("124: OTP concluído antes; linha de papel e método PAPEL_CLIENTE direto no banco recusam no COMMIT (papel + CLIENTE)", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (!com124) return t.skip("modelo sem a 124");
  await emTx(async () => {
    const x = await aguardandoCliente();
    await assinarComoCliente(x.contratoId, x.cpf);
    await validarAgora(a);
    // O gatilho da linha CLIENTE já rodou; agora só os eventos do papel e da versão chegam ao gatilho diferido. A versão
    // assinada é imutável (recusa antes); a guarda papel + CLIENTE do gatilho da 124 é a segunda linha de defesa.
    await recusa(async () => {
      await inserirDireto(x);
      await a.query(`UPDATE contrato_versoes SET aceite_metodo = 'PAPEL_CLIENTE', assinado_em = public.kidmais124_instante_civil($2::date) WHERE id = $1::uuid`,
        [x.versaoId, await hojeSp()]);
      await validarAgora(a);
    }, (e) => /Versão assinada é imutável|não recebe assinatura digital/.test((e as Error).message), "papel depois do OTP, direto no banco");
  });
});

test("124: OTP nativo preservado — o cliente assina eletronicamente e a festa nasce; registrar papel depois = 409", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (!com124) return t.skip("modelo sem a 124");
  await emTx(async () => {
    const x = await aguardandoCliente();
    await assinarComoCliente(x.contratoId, x.cpf);
    await validarAgora(a);
    assert.equal((await a.query("SELECT aceite_metodo FROM contrato_versoes WHERE id = $1::uuid", [x.versaoId])).rows[0].aceite_metodo, "OTP");
    assert.equal((await a.query("SELECT count(*)::int AS n FROM festas WHERE contrato_id = $1::uuid AND invalidada_em IS NULL", [x.contratoId])).rows[0].n, 1);
    const hojeR = await hojeSp();
    await recusa(() => registrar(x, { dataDeclarada: hojeR }), codigo("CONTRATO_JA_ASSINADO", 409));
  });
});

test("124: agenda recusa a formalização (bloqueio no dia) → 409 FORMALIZACAO_AGENDA_RECUSADA e nada gravado", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (!com124) return t.skip("modelo sem a 124");
  await emTx(async () => {
    const x = await aguardandoCliente();
    // Bloqueio de dia inteiro gravado com as guardas do bloqueio desligadas (dado legado em conflito): a formalização,
    // que confere a agenda no registro, precisa recusar com 409 e desfazer tudo.
    const data = (await a.query("SELECT fe.data_evento::text AS d FROM contratos c JOIN fechamentos fe ON fe.id = c.fechamento_id WHERE c.id = $1::uuid", [x.contratoId])).rows[0].d;
    await a.query("ALTER TABLE bloqueios_agenda DISABLE TRIGGER USER");
    await a.query("INSERT INTO bloqueios_agenda (data, dia_inteiro, motivo, empresa_id) VALUES ($1::date, true, 'Teste 124', $2::uuid)", [data, x.c.empresa]);
    await a.query("ALTER TABLE bloqueios_agenda ENABLE TRIGGER USER");
    const hojeR = await hojeSp();
    const antes = await contagens(x);
    await recusaConferindo(() => registrar(x, { dataDeclarada: hojeR }), codigo("FORMALIZACAO_AGENDA_RECUSADA", 409), async () => {
      assert.deepEqual(await contagens(x), antes, "rollback integral, conferido antes da limpeza do harness");
      assert.equal((await a.query("SELECT count(*)::int AS n FROM contrato_assinaturas_papel WHERE contrato_versao_id = $1::uuid", [x.versaoId])).rows[0].n, 0);
      assert.equal((await a.query("SELECT status FROM contrato_versoes WHERE id = $1::uuid", [x.versaoId])).rows[0].status, "ATIVA");
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Tempo (PAP-4 e PAP-R3-3): limites civis em America/Sao_Paulo e relógio factual do registro.
// ---------------------------------------------------------------------------------------------------------------------

/** Move a liberação da edição para `quando` (expressão SQL timestamptz); o restante do estado fica como o Admin deixou. */
async function liberarEm(x: Aguardando, quando: string) {
  await a.query(`UPDATE contrato_edicoes SET liberado_em = ${quando} WHERE contrato_versao_id = $1::uuid`, [x.versaoId]);
  return (await a.query<{ sp: string; utc: string }>(
    `SELECT (liberado_em AT TIME ZONE 'America/Sao_Paulo')::date::text AS sp, (liberado_em AT TIME ZONE 'UTC')::date::text AS utc
       FROM contrato_edicoes WHERE contrato_versao_id = $1::uuid`, [x.versaoId])).rows[0];
}

/**
 * Pool da transação de teste com um defeito proposital no serviço: `sql` reescreve o texto enviado e `linhas` adultera o
 * resultado lido. Serve para provar que o banco recusa sozinho (o serviço não é a única guarda). Devolve a restauração.
 */
function servicoAdulterado(defeito: { sql?: (s: string) => string; linhas?: (s: string, rows: Record<string, unknown>[]) => Record<string, unknown>[] }) {
  const g = globalThis as { __kidmaisPgPool?: unknown };
  const anterior = g.__kidmaisPgPool;
  const troca: Record<string, string> = { BEGIN: "SAVEPOINT operacao_nativa", COMMIT: "RELEASE SAVEPOINT operacao_nativa", ROLLBACK: "ROLLBACK TO SAVEPOINT operacao_nativa" };
  const consultar = async (sql: string, v?: unknown[]) => {
    const r = await a.query(defeito.sql ? defeito.sql(sql) : sql, v);
    return defeito.linhas ? { ...r, rows: defeito.linhas(sql, r.rows) } : r;
  };
  g.__kidmaisPgPool = { query: consultar, connect: async () => ({ query: (sql: string, v?: unknown[]) => consultar(troca[sql] ?? sql, v), release() {} }) };
  return () => { g.__kidmaisPgPool = anterior; };
}

test("124: tempo — liberado às 22h SP (01h UTC do dia seguinte): o dia da liberação passa e a véspera recusa, no serviço e no banco", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (!com124) return t.skip("modelo sem a 124");
  await emTx(async () => {
    const hoje = await hojeSp();
    const x = await aguardandoCliente();
    const lib = await liberarEm(x, `((current_date - 1) + time '22:00') AT TIME ZONE 'America/Sao_Paulo'`);
    // O dia civil da liberação vem de SP; em UTC a mesma liberação já é o dia seguinte.
    const diaLib = (await a.query<{ d: string }>(`SELECT (((current_date - 1) + time '22:00') AT TIME ZONE 'America/Sao_Paulo' AT TIME ZONE 'America/Sao_Paulo')::date::text AS d`)).rows[0].d;
    assert.equal(lib.sp, diaLib);
    assert.equal(lib.utc, somar(diaLib, 1), "em UTC a liberação cai no dia seguinte");
    // Serviço: véspera da liberação recusa (422) sem gravar; o dia da liberação passa.
    await recusa(() => registrar(x, { dataDeclarada: somar(lib.sp, -1) }), codigo("DATA_DECLARADA_INVALIDA", 422));
    if (lib.sp <= hoje) {
      await a.query("SAVEPOINT dia_lib");
      const r = await registrar(x, { dataDeclarada: lib.sp });
      await validarAgora(a);
      assert.equal(r.dataDeclarada, lib.sp);
      await a.query("ROLLBACK TO SAVEPOINT dia_lib");
    }

    // Banco (segunda guarda): o serviço é adulterado para pular o piso (liberação lida como 2000-01-01) ou para gravar
    // assinado_em fora do meio-dia SP. O gatilho diferido da 124 recusa no COMMIT mesmo assim.
    await recusa(async () => {
      const desfazer = servicoAdulterado({ linhas: (sql, rows) => (/ AS liberado/.test(sql) ? rows.map((r) => ({ ...r, liberado: "2000-01-01" })) : rows) });
      try { await registrar(x, { dataDeclarada: somar(lib.sp, -1) }); } finally { desfazer(); }
      await validarAgora(a);
    }, (e) => /fora da liberação/.test((e as Error).message), "véspera da liberação (banco)");
    await recusa(async () => {
      const desfazer = servicoAdulterado({ sql: (sql) => sql.replace("assinado_em=public.kidmais124_instante_civil($2::date)", "assinado_em=public.kidmais124_instante_civil($2::date)+interval '1 hour'") });
      try { await registrar(x, { dataDeclarada: lib.sp }); } finally { desfazer(); }
      await validarAgora(a);
    }, (e) => /fora da liberação/.test((e as Error).message), "assinado_em fora do meio-dia SP");
  });
});

test("124: tempo — registro 5 semanas depois da liberação passa; a data é a mesma na versão, no contrato e no link do cliente", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (!com124) return t.skip("modelo sem a 124");
  await emTx(async () => {
    const x = await aguardandoCliente();
    const lib = await liberarEm(x, `clock_timestamp() - interval '36 days'`);
    const data = somar(lib.sp, 2);
    await registrar(x, { dataDeclarada: data });
    await validarAgora(a);
    const r = (await a.query<{ versao: string; contrato: string; sp: string }>(
      `SELECT (v.assinado_em AT TIME ZONE 'America/Sao_Paulo')::date::text AS versao, (c.assinado_em AT TIME ZONE 'America/Sao_Paulo')::date::text AS contrato,
              (v.assinado_em AT TIME ZONE 'America/Sao_Paulo')::time::text AS sp
         FROM contrato_versoes v JOIN contratos c ON c.id = v.contrato_id WHERE v.id = $1::uuid`, [x.versaoId])).rows[0];
    assert.deepEqual(r, { versao: data, contrato: data, sp: "12:00:00" });
    assert.deepEqual(await publico().assinaturaPapelClientePublica({ id: x.versaoId, aceiteMetodo: "PAPEL_CLIENTE" }), { data });
  });
});

test("124: relógio do registro (PAP-R3-3) — registrado_em é o clock_timestamp() do INSERT, não o início da transação", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (!com124) return t.skip("modelo sem a 124");
  await emTx(async () => {
    const x = await aguardandoCliente();
    await a.query("SELECT pg_sleep(1.2)");
    // Valor enviado é ignorado: o gatilho grava o relógio real uma vez.
    const linha = (await inserirDireto(x, { registrado_em: "2000-01-01T00:00:00Z" })).rows[0] as { id: string };
    const d = (await a.query<{ atraso: number; passado: boolean }>(
      `SELECT extract(epoch FROM registrado_em - now())::float8 AS atraso, registrado_em < '2001-01-01' AS passado FROM contrato_assinaturas_papel WHERE id = $1::uuid`, [linha.id])).rows[0];
    assert.equal(d.passado, false, "o valor do cliente não é aceito");
    assert.ok(d.atraso >= 1, `registrado_em precisa ser posterior ao início da transação (atraso ${d.atraso}s)`);
    // Conversão civil na virada do dia: 01:30 UTC ainda é o dia anterior em SP; 03:00 UTC já é o dia seguinte.
    const civil = (await a.query<{ antes: string; depois: string; meio: string }>(
      `SELECT ('2026-11-15 01:30:00+00'::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date::text AS antes,
              ('2026-11-15 03:00:00+00'::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date::text AS depois,
              public.kidmais124_instante_civil('2026-11-14')::text AS meio`)).rows[0];
    assert.deepEqual({ antes: civil.antes, depois: civil.depois }, { antes: "2026-11-14", depois: "2026-11-15" });
    assert.equal((await a.query<{ ok: boolean }>(`SELECT public.kidmais124_instante_civil('2026-11-14') = '2026-11-14 15:00:00+00'::timestamptz AS ok`)).rows[0].ok, true, civil.meio);
  });
});

// ───────────────────────── Concorrência com COMMIT real (PAP-5) ─────────────────────────
// Duas conexões reais (READ COMMITTED) executam o serviço; a principal, em autocommit, observa pg_blocking_pids.
// O cenário é COMMITADO antes (fica no descartável, que é recriado do modelo a cada rodada).

type Portao = { chegou: Promise<void>; avisar: () => void; liberar: () => void; liberado: Promise<void> };
function portao(): Portao {
  let avisar!: () => void; let liberar!: () => void;
  const chegou = new Promise<void>((r) => { avisar = r; });
  const liberado = new Promise<void>((r) => { liberar = r; });
  return { chegou, avisar, liberar, liberado };
}
type Rota = { cliente: Client; noCommit?: Portao; falharDepois?: (sql: string, v?: unknown[]) => boolean; falharNoCommit?: boolean };

/** Pool roteado: cada connect() consome a próxima rota (BEGIN/COMMIT reais); sem rota, a conexão principal em autocommit. */
function poolRoteado() {
  const g = globalThis as { __kidmaisPgPool?: unknown };
  const anterior = g.__kidmaisPgPool;
  const fila: Rota[] = [];
  g.__kidmaisPgPool = {
    query: (sql: string, v?: unknown[]) => a.query(sql, v),
    connect: async () => {
      const r = fila.shift() ?? { cliente: a };
      return {
        query: async (sql: string, v?: unknown[]) => {
          if (sql === "COMMIT" && r.falharNoCommit) throw new Error("falha injetada antes do COMMIT");
          if (sql === "COMMIT" && r.noCommit) { r.noCommit.avisar(); await r.noCommit.liberado; }
          const res = await r.cliente.query(sql, v);
          if (r.falharDepois?.(sql, v)) throw new Error("falha injetada");
          return res;
        },
        release() {},
      };
    },
  };
  return { rota: (r: Rota) => { fila.push(r); }, restaurar: () => { g.__kidmaisPgPool = anterior; } };
}

let b: Client | undefined; let c3: Client | undefined;
async function conexoesExtras() {
  b ??= await conectarDescartavel({ travar: false });
  c3 ??= await conectarDescartavel({ travar: false });
  return { b, c3 };
}
test.after(async () => { for (const c of [b, c3]) if (c) await encerrarDescartavel(c); });
const pidDe = async (c: Client) => Number((await c.query<{ p: number }>("SELECT pg_backend_pid() AS p")).rows[0].p);
async function esperaPor(alvo: number, por: number) {
  for (let i = 0; i < 400; i++) {
    const bl = (await a.query<{ b: number[] }>("SELECT pg_blocking_pids($1) AS b", [alvo])).rows[0].b.map(Number);
    if (bl.includes(por)) return bl;
    await new Promise((fim) => setTimeout(fim, 25));
  }
  throw new Error(`pid ${alvo} não ficou esperando ${por}`);
}

/** Cenário AGUARDANDO_CLIENTE commitado (a conexão principal volta ao autocommit). */
async function aguardandoCommitado(): Promise<Aguardando> {
  await a.query("BEGIN");
  const restaurar = poolNaTransacao(a);
  try { const x = await aguardandoCliente(); await a.query("COMMIT"); return x; }
  catch (e) { await a.query("ROLLBACK"); throw e; } finally { restaurar(); }
}

/** O cliente abre o link e confirma o código (commitado); devolve o passo final (assinar) para rodar depois. */
async function clientePronto(x: Aguardando) {
  const pub = publico();
  const acesso = await pub.consultarAcessoContrato({ contratoId: x.contratoId, cpf: x.cpf }) as { canais: Array<{ canal: string }> };
  let cod = "";
  const emissor = async (y: { codigo: string }) => { cod = y.codigo; };
  const desafio = await pub.iniciarDesafioContrato({ contratoId: x.contratoId, cpf: x.cpf, canal: acesso.canais[0].canal } as never, emissor as never) as { validacaoId: string; acessoToken: string };
  const identidade = carregar<{ criarIdentityServiceComAmbiente: (s: (y: { codigo: string }) => Promise<void>) => { confirmarCodigo: (i: { validacaoId: string; codigo: string }) => Promise<{ provaToken: string }> } }>("lib/identidade/services/index.ts");
  const prova = await identidade.criarIdentityServiceComAmbiente(emissor).confirmarCodigo({ validacaoId: desafio.validacaoId, codigo: cod });
  const entrada = { contratoId: x.contratoId, acessoToken: desafio.acessoToken, provaToken: prova.provaToken };
  const ctxPub = await pub.obterContextoContratoPublico(entrada);
  return {
    validacaoId: desafio.validacaoId,
    assinar: () => pub.assinarContratoPublico({ ...entrada, versaoId: ctxPub.versao.id, snapshotHash: ctxPub.versao.snapshotHash, documentoPdfHash: ctxPub.versao.documentoPdfHash } as never,
      (async () => { throw new Error("nenhum OTP externo"); }) as never, { requestId: randomUUID() }),
  };
}
const contagens = async (x: Aguardando) => (await a.query<Record<string, number | string>>(`SELECT
    (SELECT count(*)::int FROM contrato_assinaturas_papel WHERE contrato_versao_id = $1::uuid) AS papel,
    (SELECT count(*)::int FROM contrato_assinaturas WHERE contrato_versao_id = $1::uuid AND parte = 'CLIENTE') AS digital,
    (SELECT count(*)::int FROM festas WHERE contrato_id = $2::uuid) AS festas,
    (SELECT count(*)::int FROM auditoria WHERE acao = 'CONTRATO_ASSINADO_PAPEL_CLIENTE' AND entidade_id = $1::uuid) AS auditoria,
    (SELECT count(*)::int FROM eventos_historico_cliente WHERE tipo_evento = 'CONTRATO_ASSINADO_PAPEL_CLIENTE' AND entidade_id = $2::uuid) AS historico,
    (SELECT status FROM contrato_versoes WHERE id = $1::uuid) AS versao,
    (SELECT status FROM contratos WHERE id = $2::uuid) AS contrato,
    (SELECT f.status FROM fechamentos f JOIN contratos c ON c.fechamento_id = f.id WHERE c.id = $2::uuid) AS fechamento`, [x.versaoId, x.contratoId])).rows[0];
const ASSINADO_PAPEL = { papel: 1, digital: 0, festas: 1, auditoria: 1, historico: 1, versao: "ASSINADA", contrato: "ASSINADO", fechamento: "CONTRATO_ASSINADO" };

test("124: concorrência (COMMIT real) — papel primeiro: o OTP do cliente espera os locks e recebe 409; a prova não é consumida", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (!com124) return t.skip("modelo sem a 124");
  const { b: cb, c3: cc } = await conexoesExtras();
  const restaurarAmbiente = ambienteAssinatura();
  const pool = poolRoteado();
  try {
    const x = await aguardandoCommitado();
    const cliente = await clientePronto(x);
    const validacao = (await a.query("SELECT status FROM validacoes_identidade_cliente WHERE id = $1::uuid", [cliente.validacaoId])).rows[0].status;
    const p = portao();
    pool.rota({ cliente: cb, noCommit: p });
    const papel = registrar(x, { dataDeclarada: await hojeSp() });
    await p.chegou; // o papel gravou tudo e segura os locks antes do COMMIT
    pool.rota({ cliente: cc });
    const digital = cliente.assinar().then(() => "assinou", (e) => e);
    await esperaPor(await pidDe(cc), await pidDe(cb));
    p.liberar();
    assert.equal((await papel).reutilizado, false);
    assert.ok(codigo("CONTRATO_JA_ASSINADO", 409)(await digital), "o OTP recebe 409 depois do COMMIT do papel");
    assert.deepEqual(await contagens(x), ASSINADO_PAPEL);
    assert.equal((await a.query("SELECT aceite_metodo FROM contrato_versoes WHERE id = $1::uuid", [x.versaoId])).rows[0].aceite_metodo, "PAPEL_CLIENTE");
    assert.equal((await a.query("SELECT status FROM validacoes_identidade_cliente WHERE id = $1::uuid", [cliente.validacaoId])).rows[0].status, validacao, "a prova não é consumida");
  } finally { pool.restaurar(); restaurarAmbiente(); }
});

test("124: concorrência (COMMIT real) — OTP primeiro: o papel espera e recebe 409; nenhuma linha de papel", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (!com124) return t.skip("modelo sem a 124");
  const { b: cb, c3: cc } = await conexoesExtras();
  const restaurarAmbiente = ambienteAssinatura();
  const pool = poolRoteado();
  try {
    const x = await aguardandoCommitado();
    const cliente = await clientePronto(x);
    const p = portao();
    pool.rota({ cliente: cb, noCommit: p });
    const digital = cliente.assinar();
    await p.chegou;
    pool.rota({ cliente: cc });
    const papel = registrar(x, { dataDeclarada: await hojeSp() }).then(() => "registrou", (e) => e);
    await esperaPor(await pidDe(cc), await pidDe(cb));
    p.liberar();
    await digital;
    assert.ok(codigo("CONTRATO_JA_ASSINADO", 409)(await papel), "o papel recebe 409 depois do COMMIT do OTP");
    const n = await contagens(x);
    assert.deepEqual([n.papel, n.digital, n.festas, n.auditoria, n.historico], [0, 1, 1, 0, 0]);
    assert.equal((await a.query("SELECT aceite_metodo FROM contrato_versoes WHERE id = $1::uuid", [x.versaoId])).rows[0].aceite_metodo, "OTP");
  } finally { pool.restaurar(); restaurarAmbiente(); }
});

test("124: concorrência (COMMIT real) — dois registros com a mesma chave: um grava, o outro espera e reutiliza; chave com outros dados = 409", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (!com124) return t.skip("modelo sem a 124");
  const { b: cb, c3: cc } = await conexoesExtras();
  const restaurarAmbiente = ambienteAssinatura();
  const pool = poolRoteado();
  try {
    const x = await aguardandoCommitado();
    const hoje = await hojeSp();
    const chave = randomUUID();
    const p = portao();
    pool.rota({ cliente: cb, noCommit: p });
    const primeiro = registrar(x, { dataDeclarada: hoje, chaveIdempotencia: chave, observacao: "via assinada" });
    await p.chegou;
    pool.rota({ cliente: cc });
    const segundo = registrar(x, { dataDeclarada: hoje, chaveIdempotencia: chave, observacao: "via assinada" });
    await esperaPor(await pidDe(cc), await pidDe(cb));
    p.liberar();
    const r1 = await primeiro; const r2 = await segundo;
    assert.equal(r1.reutilizado, false); assert.equal(r2.reutilizado, true);
    assert.equal(r2.assinaturaPapelId, r1.assinaturaPapelId);
    assert.deepEqual(await contagens(x), ASSINADO_PAPEL);
    await assert.rejects(registrar(x, { dataDeclarada: hoje, chaveIdempotencia: chave, observacao: "outra observação" }), codigo("CHAVE_IDEMPOTENCIA_REUTILIZADA", 409));
    await assert.rejects(registrar(x, { dataDeclarada: hoje }), codigo("CONTRATO_JA_ASSINADO", 409), "chave nova depois de assinado");
    assert.deepEqual(await contagens(x), ASSINADO_PAPEL);
  } finally { pool.restaurar(); restaurarAmbiente(); }
});

test("124: atomicidade (COMMIT real) — falha depois de cada passo do registro desfaz tudo; o registro seguinte passa", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (!com124) return t.skip("modelo sem a 124");
  const { b: cb } = await conexoesExtras();
  const restaurarAmbiente = ambienteAssinatura();
  const pool = poolRoteado();
  try {
    const x = await aguardandoCommitado();
    const hoje = await hojeSp();
    const inicial = await contagens(x);
    const comPapel = (v?: unknown[]) => JSON.stringify(v ?? []).includes("CONTRATO_ASSINADO_PAPEL_CLIENTE");
    const passos: Array<[string, (s: string, v?: unknown[]) => boolean]> = [
      ["INSERT papel", (s) => s.includes("INSERT INTO contrato_assinaturas_papel")],
      ["UPDATE versão ASSINADA", (s) => s.includes("UPDATE contrato_versoes SET status='ASSINADA'")],
      ["UPDATE edição CONCLUIDA", (s) => s.includes("UPDATE contrato_edicoes SET estado='CONCLUIDA'")],
      ["UPDATE fluxo", (s) => s.startsWith("UPDATE contrato_fluxos")],
      ["UPDATE contrato ASSINADO", (s) => s.startsWith("UPDATE contratos SET status='ASSINADO'")],
      ["UPDATE fechamento", (s) => /UPDATE fechamentos/.test(s)],
      ["INSERT festa", (s) => s.includes("INSERT INTO public.festas")],
      ["INSERT festa_eventos", (s) => s.includes("INSERT INTO public.festa_eventos")],
      ["histórico do papel", (s, v) => /eventos_historico_cliente/.test(s) && comPapel(v)],
      ["auditoria do papel", (s, v) => /auditoria/.test(s) && comPapel(v)],
    ];
    const injetada = (e: unknown) => /falha injetada/.test(`${(e as Error)?.message} ${(e as { cause?: Error })?.cause?.message}`);
    for (const [rotulo, casa] of passos) {
      let casou = false;
      pool.rota({ cliente: cb, falharDepois: (s, v) => (casa(s, v) ? (casou = true) : false) });
      await assert.rejects(registrar(x, { dataDeclarada: hoje }), injetada, rotulo);
      assert.ok(casou, `o passo "${rotulo}" foi executado antes da falha`);
      assert.deepEqual(await contagens(x), inicial, `nada sobra depois da falha em "${rotulo}"`);
    }
    pool.rota({ cliente: cb, falharNoCommit: true });
    await assert.rejects(registrar(x, { dataDeclarada: hoje }), injetada, "falha no lugar do COMMIT");
    assert.deepEqual(await contagens(x), inicial, "nada sobra quando o COMMIT não acontece");
    assert.equal((await cb.query("SELECT pg_current_xact_id_if_assigned() IS NULL AS livre")).rows[0].livre, true, "a conexão terminou a transação");
    pool.rota({ cliente: cb });
    assert.equal((await registrar(x, { dataDeclarada: hoje })).reutilizado, false);
    assert.deepEqual(await contagens(x), ASSINADO_PAPEL);
  } finally { pool.restaurar(); restaurarAmbiente(); }
});

test("124: down recusa quando já há assinatura em papel registrada (dentro da transação; nada muda)", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (!com124) return t.skip("modelo sem a 124");
  const { readFileSync } = await import("node:fs");
  const down = readFileSync("database/rollback/20261115_124_assinatura_papel_cliente_down.sql", "utf8").replace(/^BEGIN;\s*$/m, "").replace(/^COMMIT;\s*$/m, "");
  await emTx(async () => {
    const x = await aguardandoCliente();
    await registrar(x, { dataDeclarada: await hojeSp() });
    await validarAgora(a);
    await recusa(() => a.query(down), (e) => /124: rollback recusado; já há assinatura em papel do cliente registrada/.test((e as Error).message), "down com papel");
    assert.equal((await a.query("SELECT count(*)::int AS n FROM contrato_assinaturas_papel WHERE contrato_versao_id = $1::uuid", [x.versaoId])).rows[0].n, 1);
  });
});

// ───────────────────────── Rodada 2 (Astra r1: P2-1, P2-2, P3-3) ─────────────────────────

const adm = () => carregar<typeof import("./services/administrativo.service.ts")>("lib/contratos/services/administrativo.service.ts");
const operar = (versaoId: string, input: Record<string, unknown>, token: string, empresa: string) =>
  (adm().operarContrato as unknown as Operar)(versaoId, input, token, { requestId: randomUUID(), ip: null, userAgent: "pg-124-r2" }, empresa);
const POSTCHECK_124 = "database/checks/20261115_124_postcheck.sql";

/** O postcheck da 124, como o aplicador roda (sem o BEGIN/ROLLBACK de fora), dentro de um SAVEPOINT da transação de teste. */
async function postcheck124() {
  const { readFileSync } = await import("node:fs");
  const sql = readFileSync(POSTCHECK_124, "utf8").replace(/^BEGIN TRANSACTION READ ONLY;\s*$/m, "").replace(/^ROLLBACK;\s*$/m, "");
  await a.query("SAVEPOINT postcheck");
  try { await a.query(sql); } finally { await a.query("ROLLBACK TO SAVEPOINT postcheck"); }
}
/** Gestão que pode cancelar a contratação (FESTA_CORRIGIR), como no 062. */
const gestaoCorrigir = (x: Aguardando, capacidade = "FESTA_CORRIGIR") => a.query(
  "INSERT INTO festa_membership_capacidades (empresa_id, membership_id, capacidade, concedido_por, motivo) VALUES ($1::uuid, $2::uuid, $4, $3::uuid, 'Gestão sintética 124')",
  [x.c.empresa, x.nativo.representante.membershipId, x.nativo.representante.usuarioId, capacidade]);
const recusaPostcheck = (e: unknown) => /124 postcheck: versão PAPEL_CLIENTE sem registro, ou registro fora da regra/.test((e as Error).message);
const nadaGravado = async (x: Aguardando) => {
  assert.equal((await a.query("SELECT count(*)::int AS n FROM contrato_assinaturas_papel WHERE contrato_id = $1::uuid", [x.contratoId])).rows[0].n, 0);
  assert.equal((await a.query("SELECT count(*)::int AS n FROM festas WHERE contrato_id = $1::uuid", [x.contratoId])).rows[0].n, 0);
  assert.equal((await a.query("SELECT count(*)::int AS n FROM auditoria WHERE acao = 'CONTRATO_ASSINADO_PAPEL_CLIENTE' AND entidade_id = $1::uuid", [x.versaoId])).rows[0].n, 0);
};

test("124 r2: cancelamento REAL depois do papel — contrato CANCELADO, registro preservado e o postcheck passa; evidência adulterada o postcheck recusa", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (!com124) return t.skip("modelo sem a 124");
  await emTx(async () => {
    const x = await aguardandoCliente();
    await registrar(x, { dataDeclarada: await hojeSp() });
    await validarAgora(a);
    await postcheck124();
    await gestaoCorrigir(x);
    // Contratação assinada pelas duas partes: o cancelamento é pelo fluxo da Festa (operarContrato orienta para ele).
    await recusa(() => operar(x.versaoId, { acao: "cancelar_contratacao", motivo: "Cliente desistiu (sintético 124)", perda: { motivo: "Desistiu da festa" } }, x.nativo.tokenRepresentante, x.c.empresa),
      codigo("DADOS_CONTRATUAIS_INCONSISTENTES", 409), "contrato pede o fluxo da Festa");
    const festa = (await a.query<{ id: string; revisao: number }>("SELECT id::text, revisao FROM festas WHERE contrato_id = $1::uuid", [x.contratoId])).rows[0];
    await carregar<typeof import("../festas/service.ts")>("lib/festas/service.ts").comandarFesta(festa.id,
      { acao: "cancelar_contratacao", chave: randomUUID(), revisao: festa.revisao, versaoId: x.versaoId, motivo: "Cliente desistiu (sintético 124)" },
      { token: x.nativo.tokenRepresentante, requestId: randomUUID(), userAgent: null, empresaSolicitada: x.c.empresa });
    await validarAgora(a);
    const depois = (await a.query(`SELECT c.status AS contrato, v.status AS versao, v.aceite_metodo AS metodo,
        (SELECT count(*)::int FROM contrato_assinaturas_papel p WHERE p.contrato_versao_id = v.id) AS papel
        FROM contratos c JOIN contrato_versoes v ON v.contrato_id = c.id WHERE v.id = $1::uuid`, [x.versaoId])).rows[0];
    assert.deepEqual(depois, { contrato: "CANCELADO", versao: "ASSINADA", metodo: "PAPEL_CLIENTE", papel: 1 }, "cancelamento real; a evidência fica");
    await postcheck124();
    // Oráculo de não vacuidade: com a evidência adulterada (data antes da liberação, por fora dos gatilhos), o mesmo postcheck recusa.
    await a.query("SAVEPOINT adulterar");
    await a.query("SET LOCAL session_replication_role = replica");
    await a.query("UPDATE contrato_assinaturas_papel SET data_declarada = data_declarada - 400 WHERE contrato_versao_id = $1::uuid", [x.versaoId]);
    await a.query("SET LOCAL session_replication_role = origin");
    await assert.rejects(postcheck124(), recusaPostcheck, "postcheck recusa a evidência adulterada");
    await a.query("ROLLBACK TO SAVEPOINT adulterar");
    await postcheck124();
  });
});

test("124 r2: cancelamento REAL antes do papel — registro recusado (409) e nada gravado", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (!com124) return t.skip("modelo sem a 124");
  await emTx(async () => {
    const x = await aguardandoCliente();
    await gestaoCorrigir(x);
    await operar(x.versaoId, { acao: "cancelar_contratacao", motivo: "Cliente desistiu (sintético 124)", perda: { motivo: "Desistiu da festa" } }, x.nativo.tokenRepresentante, x.c.empresa);
    await validarAgora(a);
    assert.equal((await a.query("SELECT status FROM contratos WHERE id = $1::uuid", [x.contratoId])).rows[0].status, "CANCELADO");
    const hoje = await hojeSp();
    await recusa(() => registrar(x, { dataDeclarada: hoje }), codigo("STATUS_CONTRATO_NAO_PERMITE_ASSINATURA", 409));
    await nadaGravado(x);
    await postcheck124();
  });
});

test("124 r2: sucessão por V2 — papel na V1, nova versão; papel na V2 recusado (preparo e liberada); V2 assinada por OTP; V1 com a evidência; postcheck passa", { skip: !opt(), timeout: 600_000 }, async (t) => {
  if (!com124) return t.skip("modelo sem a 124");
  await emTx(async () => {
    const x = await aguardandoCliente();
    const hoje = await hojeSp();
    await registrar(x, { dataDeclarada: hoje });
    await validarAgora(a);
    await operar(x.versaoId, { acao: "nova_versao", tipo: "NOVA_VERSAO", motivo: "Ajuste depois do papel (124)", chaveCriacao: randomUUID() }, x.c.token, x.c.empresa);
    await validarAgora(a);
    const v2 = (await a.query<{ id: string }>("SELECT versao_em_preparacao_id::text AS id FROM contrato_fluxos WHERE contrato_id = $1::uuid", [x.contratoId])).rows[0].id;
    assert.ok(v2 && v2 !== x.versaoId, "V2 em preparação");
    const naV2 = { ...x, versaoId: v2 };
    const naoV2 = (e: unknown) => ["CONTRATO_JA_ASSINADO", "STATUS_CONTRATO_NAO_PERMITE_ASSINATURA"].includes((e as { code?: string }).code ?? "") && (e as { httpStatus?: number }).httpStatus === 409;
    await recusa(() => registrar(naV2, { dataDeclarada: hoje }), naoV2, "V2 em preparação");
    await congelarEAssinarKidmais(a, adm().operarContrato as unknown as Operar, v2, x.c.empresa, x.c.token, x.nativo.tokenRepresentante);
    await validarAgora(a);
    assert.equal((await a.query("SELECT estado FROM contrato_edicoes WHERE contrato_versao_id = $1::uuid", [v2])).rows[0].estado, "AGUARDANDO_CLIENTE");
    await recusa(() => registrar(naV2, { dataDeclarada: hoje }), naoV2, "V2 liberada ao cliente: papel só na V1");
    assert.equal((await a.query("SELECT count(*)::int AS n FROM contrato_assinaturas_papel WHERE contrato_versao_id = $1::uuid", [v2])).rows[0].n, 0);
    // Banco (segunda guarda): linha de papel direto na V2 recusa no COMMIT.
    await recusa(async () => { await inserirDireto(naV2); await validarAgora(a); }, (e) => ["23514", "P0001"].includes((e as { code?: string }).code ?? ""), "linha de papel na V2 (banco)");
    await assinarComoCliente(x.contratoId, x.cpf);
    await validarAgora(a);
    const r = (await a.query(`SELECT cf.versao_vigente_id::text AS vigente, v2.status AS v2, v2.aceite_metodo AS m2, v1.status AS v1, v1.aceite_metodo AS m1,
        (SELECT count(*)::int FROM contrato_assinaturas_papel p WHERE p.contrato_versao_id = v1.id) AS papel_v1
        FROM contrato_fluxos cf JOIN contrato_versoes v1 ON v1.id = $2::uuid JOIN contrato_versoes v2 ON v2.id = $3::uuid WHERE cf.contrato_id = $1::uuid`, [x.contratoId, x.versaoId, v2])).rows[0];
    assert.deepEqual(r, { vigente: v2, v2: "ASSINADA", m2: "OTP", v1: "ASSINADA", m1: "PAPEL_CLIENTE", papel_v1: 1 });
    await postcheck124();
  });
});

test("124 r2: revisão inicial pendente, contrato importado e revisão operacional recusam o papel (409) sem gravar nada", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (!com124) return t.skip("modelo sem a 124");
  await emTx(async () => {
    const x = await aguardandoCliente();
    const hoje = await hojeSp();
    // revisaoInicial na edição (estado que o fluxo de importação deixa): o serviço recusa.
    await a.query("SAVEPOINT revisao");
    await a.query("SET LOCAL session_replication_role = replica");
    await a.query(`UPDATE contrato_edicoes SET dados_fonte = dados_fonte || '{"revisaoInicial":{"origem":"teste-124"}}'::jsonb WHERE contrato_versao_id = $1::uuid`, [x.versaoId]);
    await a.query("SET LOCAL session_replication_role = origin");
    await recusa(() => registrar(x, { dataDeclarada: hoje }), codigo("STATUS_CONTRATO_NAO_PERMITE_ASSINATURA", 409), "revisão inicial");
    await nadaGravado(x);
    await a.query("ROLLBACK TO SAVEPOINT revisao");
    // Vínculos REAIS (Astra r2): linhas de verdade em contrato_importacoes e fechamento_revisoes apontando para este
    // contrato/versão, gravadas com as guardas desligadas (os pais ia_importacoes/ia_documento_originais e a versão da
    // revisão exigiriam o fluxo inteiro; os EXISTS do serviço e do gatilho só olham contrato_id/contrato_versao_id/versao_base_id).
    // Para cada vínculo: (a) o serviço recusa com 409 e nada é gravado; (b) com o EXISTS do serviço neutralizado
    // (regressão simulada), a guarda do gatilho diferido da 124 recusa no COMMIT.
    const fe = (await a.query<{ id: string; cliente: string }>(
      "SELECT f.id::text, f.cliente_id::text AS cliente FROM contratos c JOIN fechamentos f ON f.id = c.fechamento_id WHERE c.id = $1::uuid", [x.contratoId])).rows[0];
    const vinculos: Array<{ rotulo: string; criar: () => Promise<unknown>; campo: "importada" | "revisao" }> = [
      { rotulo: "contrato importado", campo: "importada", criar: () => a.query(
        `INSERT INTO contrato_importacoes (empresa_id, importacao_id, cliente_id, fechamento_id, contrato_id, contrato_versao_id, documento_original_id,
            documento_sha256, situacao_contrato, financeiro_declarado, agenda_a_partir_de, data_evento, horario_inicio, horario_fim, decisoes, declaracao,
            chave_idempotencia, payload_hash, conferido_por, conferido_papel, conferido_em, request_id)
         SELECT $1::uuid, gen_random_uuid(), $2::uuid, $3::uuid, $4::uuid, $5::uuid, gen_random_uuid(), repeat('c', 64), 'VIGENTE', 'NAO_CONFERIDO',
                CURRENT_DATE, f.data_evento, f.horario_inicio, f.horario_fim, '{}'::jsonb, 'Importação sintética do teste 124 (vínculo real)',
                gen_random_uuid(), repeat('d', 64), $6::uuid, 'REPRESENTANTE_AUTORIZADO', now(), gen_random_uuid()
           FROM fechamentos f WHERE f.id = $3::uuid`,
        [x.c.empresa, fe.cliente, fe.id, x.contratoId, x.versaoId, x.nativo.representante.usuarioId]) },
      ...(["versao_base_id", "contrato_versao_id"] as const).map((coluna) => ({ rotulo: `revisão operacional (${coluna} = V1)`, campo: "revisao" as const, criar: () => a.query(
        `INSERT INTO fechamento_revisoes (fechamento_id, contrato_id, contrato_versao_id, versao_base_id, motivo, chave_criacao, fonte_base_hash, conteudo_hash,
            criado_por_usuario_id, atualizado_por_usuario_id, cliente_id, data_evento, horario_inicio, horario_fim, configuracao_agenda_id, pacote_id,
            tabela_preco_id, preco_pacote_id, categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base,
            valor_pacote_aplicado, valor_tabela)
         SELECT f.id, $2::uuid, ${coluna === "contrato_versao_id" ? "$3::uuid, gen_random_uuid()" : "gen_random_uuid(), $3::uuid"}, 'Revisão sintética 124', gen_random_uuid(),
                repeat('e', 64), repeat('f', 64), $4::uuid, $4::uuid, f.cliente_id, f.data_evento, f.horario_inicio, f.horario_fim, f.configuracao_agenda_id,
                f.pacote_id, f.tabela_preco_id, f.preco_pacote_id, f.categoria_horario, f.categoria_preco_aplicada, f.convidados, f.convidados_faturados,
                f.valor_pacote_base, f.valor_pacote_aplicado, f.valor_pacote_aplicado
           FROM fechamentos f WHERE f.id = $1::uuid`,
        [fe.id, x.contratoId, x.versaoId, x.c.usuario]) })),
    ];
    for (const v of vinculos) {
      await a.query("SAVEPOINT vinculo");
      await a.query("SET LOCAL session_replication_role = replica");
      await v.criar();
      await a.query("SET LOCAL session_replication_role = origin");
      const antes = await contagens(x);
      await recusaConferindo(() => registrar(x, { dataDeclarada: hoje }), codigo("STATUS_CONTRATO_NAO_PERMITE_ASSINATURA", 409), async () => {
        await nadaGravado(x);
        assert.deepEqual(await contagens(x), antes, `${v.rotulo}: nada muda`);
      }, v.rotulo);
      const desfazer = servicoAdulterado({ linhas: (sql, rows) => (/AS importada/.test(sql) ? rows.map((r) => ({ ...r, [v.campo]: false })) : rows) });
      try {
        await recusa(async () => { await registrar(x, { dataDeclarada: hoje }); await validarAgora(a); },
          pgRecusa(/Assinatura do cliente em papel exige a V1 inicial nativa concluída com o registro/), `${v.rotulo}: guarda do banco`);
      } finally { desfazer(); }
      await nadaGravado(x);
      await a.query("ROLLBACK TO SAVEPOINT vinculo");
    }
    // Controle: sem vínculo, o mesmo registro passa (os vínculos é que recusavam).
    await registrar(x, { dataDeclarada: hoje });
    await validarAgora(a);
    assert.equal((await a.query("SELECT aceite_metodo FROM contrato_versoes WHERE id = $1::uuid", [x.versaoId])).rows[0].aceite_metodo, "PAPEL_CLIENTE");
  });
});

test("124 r2: festa no passado (11/10/2026) no próprio turno — registro hoje formaliza; estado documental KIDMAIS_PAPEL_CLIENTE; elegível à formalização", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (!com124) return t.skip("modelo sem a 124");
  const hojeUtc = new Date().toISOString().slice(0, 10);
  const deslocamento = Math.round((Date.parse("2026-10-11T12:00:00Z") - Date.parse(`${hojeUtc}T12:00:00Z`)) / 86_400_000);
  if (deslocamento >= 0) return t.skip("o relógio ainda não passou de 11/10/2026");
  await emTx(async () => {
    const x = await aguardandoCliente(deslocamento);
    const fe = (await a.query<{ id: string; data: string; turno: string }>(
      "SELECT fe.id::text, fe.data_evento::text AS data, fe.configuracao_agenda_id::text AS turno FROM contratos c JOIN fechamentos fe ON fe.id = c.fechamento_id WHERE c.id = $1::uuid", [x.contratoId])).rows[0];
    assert.equal(fe.data, "2026-10-11");
    assert.equal(fe.turno, x.nativo.turno, "o turno próprio do cenário");
    const r = await registrar(x, { dataDeclarada: await hojeSp() });
    await validarAgora(a);
    assert.equal(r.reutilizado, false);
    assert.deepEqual(await contagens(x), ASSINADO_PAPEL);
    const est = await carregar<typeof import("../agenda/estado-documental.ts")>("lib/agenda/estado-documental.ts").estadoDocumental(executor(a), { fechamentoId: fe.id });
    assert.equal(est.contrato, "COM_CONTRATO");
    if (est.contrato === "COM_CONTRATO") { assert.equal(est.versao?.assinatura, "KIDMAIS_PAPEL_CLIENTE"); assert.equal(est.versao?.papel, "VIGENTE"); }
    const { sqlFormalizacaoElegivel } = carregar<typeof import("../festas/repository.ts")>("lib/festas/repository.ts");
    const elegivel = (await a.query(`SELECT count(*)::int AS n FROM contratos c JOIN contrato_fluxos cf ON cf.contrato_id=c.id JOIN contrato_versoes v ON v.id=cf.versao_vigente_id
        JOIN contrato_edicoes e ON e.contrato_versao_id=v.id WHERE c.id = $1::uuid AND ${await sqlFormalizacaoElegivel(executor(a))}`, [x.contratoId])).rows[0].n;
    assert.equal(elegivel, 1, "o predicado de formalização com a 124 aceita o ramo do papel");
    assert.equal((await a.query("SELECT public.kidmais019_formalizacao($1::uuid, $2::uuid) AS ok", [x.contratoId, x.versaoId])).rows[0].ok, true);
    await postcheck124();
  });
});

test("124 r2: agenda — outro fechamento CONFIRMADO (ocupa) no mesmo turno e dia (conflito real) → 409 e rollback integral", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (!com124) return t.skip("modelo sem a 124");
  await emTx(async () => {
    const x = await aguardandoCliente();
    const fe = (await a.query<{ id: string }>("SELECT fechamento_id::text AS id FROM contratos WHERE id = $1::uuid", [x.contratoId])).rows[0].id;
    // Conflito legado: outro fechamento CONFIRMADO (kidmais019_ocupa) no mesmo turno/dia, gravado com as guardas desligadas.
    await a.query("SET LOCAL session_replication_role = replica");
    await a.query(`INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
        categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, aniversariante_id, status)
      SELECT data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
        categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, aniversariante_id, 'CONFIRMADO'
        FROM fechamentos WHERE id = $1::uuid`, [fe]);
    await a.query("SET LOCAL session_replication_role = origin");
    const antes = await contagens(x);
    const hoje = await hojeSp();
    await recusaConferindo(() => registrar(x, { dataDeclarada: hoje }), codigo("FORMALIZACAO_AGENDA_RECUSADA", 409), async () => {
      assert.deepEqual(await contagens(x), antes, "rollback integral, conferido antes da limpeza do harness");
      assert.equal((await a.query("SELECT status FROM contrato_versoes WHERE id = $1::uuid", [x.versaoId])).rows[0].status, "ATIVA");
    });
  });
});

// Salão inativo: a recusa "O salão deste contrato não está mais disponível" só existe quando o documento V3 fixa o salão
// (salaoExigidoOuRecusa → escolherSalaoDoContrato), caminho comum ao OTP e ao papel (formalizarContratoAssinado), já
// coberto em lib/agenda/salao-contrato-se, saloes-caminhos-098 e capacidade-094. Sem salão no documento, a festa fica
// curinga e quem decide é a revalidação do destino — o conflito real acima prova 409 + rollback integral no papel.

test("124 r2: exportação no modelo 124 — CSV contrato_assinaturas_papel com a linha da empresa, cópia como bytes+SHA-256, sem conteúdo, isolada da outra empresa", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (!com124) return t.skip("modelo sem a 124");
  const { gerarPacote } = await import("../exportacao/pacote.ts");
  const { lerZip } = await import("../exportacao/zip.ts");
  const { lerCsv } = await import("../exportacao/fixture.postgres.test-apoio.ts");
  const { readFileSync } = await import("node:fs");
  await emTx(async () => {
    const x = await aguardandoCliente();
    const y = await aguardandoCliente();
    const hoje = await hojeSp();
    const rx = await registrar(x, { dataDeclarada: hoje, observacao: "Via na recepção" }, { bytes: PDF, tipo: "application/pdf" });
    await registrar(y, { dataDeclarada: hoje, observacao: "Outra empresa" });
    await validarAgora(a);
    const p = await gerarPacote(executor(a), x.c.empresa);
    let zip: Map<string, Buffer>;
    try { zip = lerZip(readFileSync(p.zipCaminho)); } finally { await p.limpar(); }
    const arq = p.manifesto.arquivos.find((f) => f.tabela === "contrato_assinaturas_papel");
    assert.ok(arq, "a tabela da 124 está no manifesto");
    assert.equal(p.manifesto.entidadesAusentes.some((e) => e.tabela === "contrato_assinaturas_papel"), false);
    assert.deepEqual(arq!.colunas, ["id", "empresa_id", "contrato_id", "contrato_versao_id", "data_declarada", "registrado_em", "registrado_por_usuario_id", "membership_id",
      "observacao", "arquivo__bytes", "arquivo__sha256", "arquivo_tipo", "arquivo_tamanho", "arquivo_sha256", "chave_idempotencia", "payload_hash"]);
    assert.equal(arq!.linhas, 1, "só a linha da empresa exportada");
    const conteudo = zip.get(arq!.caminho)!;
    assert.equal(sha(conteudo), arq!.sha256, "SHA-256 do CSV confere com o manifesto");
    const [cab, ...linhas] = lerCsv(conteudo.toString("utf8"));
    assert.equal(linhas.length, 1);
    const l = Object.fromEntries(cab.map((c, i) => [c, linhas[0][i]]));
    assert.equal(l.id, rx.assinaturaPapelId);
    assert.equal(l.empresa_id, x.c.empresa);
    assert.equal(l.contrato_versao_id, x.versaoId);
    assert.equal(l.data_declarada, hoje);
    assert.equal(l.observacao, "Via na recepção");
    assert.equal(l.arquivo__bytes, String(PDF.length));
    assert.equal(l.arquivo__sha256, sha(PDF));
    assert.equal(l.arquivo_sha256, sha(PDF));
    assert.equal(l.arquivo_tipo, "application/pdf");
    const texto = conteudo.toString("latin1");
    assert.ok(!texto.includes("conteudo sintetico do contrato assinado"), "os bytes da cópia não vão para o CSV");
    assert.ok(!texto.includes(y.c.empresa) && !texto.includes("Outra empresa"), "nada da outra empresa");
    assert.ok(![...zip.keys()].some((k) => k.includes("contrato_assinaturas_papel") && k !== arq!.caminho), "a cópia não entra como arquivo do pacote");
  });
});

test("124 r2: relógio sob trava — o registro que espera a trava do contrato grava registrado_em depois da liberação (o teto civil vem dele)", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (!com124) return t.skip("modelo sem a 124");
  const { b: cb, c3: cc } = await conexoesExtras();
  const restaurarAmbiente = ambienteAssinatura();
  const pool = poolRoteado();
  try {
    const x = await aguardandoCommitado();
    const hoje = await hojeSp();
    await cb.query("BEGIN");
    await cb.query("SELECT 1 FROM contratos WHERE id = $1::uuid FOR UPDATE", [x.contratoId]);
    pool.rota({ cliente: cc });
    const papel = registrar(x, { dataDeclarada: hoje });
    const pidCc = await pidDe(cc);
    await esperaPor(pidCc, await pidDe(cb));
    const inicioCc = (await a.query<{ t: string }>("SELECT xact_start::text AS t FROM pg_stat_activity WHERE pid = $1", [pidCc])).rows[0].t;
    await new Promise((fim) => setTimeout(fim, 1200));
    const liberado = (await a.query<{ t: string }>("SELECT clock_timestamp()::text AS t")).rows[0].t;
    await cb.query("COMMIT");
    const r = await papel;
    const d = (await a.query<{ depois: boolean; atraso: number; dia_ok: boolean }>(
      `SELECT p.registrado_em >= $2::timestamptz AS depois, extract(epoch FROM p.registrado_em - $3::timestamptz)::float8 AS atraso,
              p.data_declarada <= (p.registrado_em AT TIME ZONE 'America/Sao_Paulo')::date AS dia_ok
         FROM contrato_assinaturas_papel p WHERE p.id = $1::uuid`, [r.assinaturaPapelId, liberado, inicioCc])).rows[0];
    assert.equal(d.depois, true, "registrado_em é posterior à liberação da trava (não ao início da transação)");
    assert.ok(d.atraso >= 1, `registrado_em ao menos 1 s depois do início da transação do registro (${d.atraso}s)`);
    assert.equal(d.dia_ok, true);
    assert.deepEqual(await contagens(x), ASSINADO_PAPEL);
  } finally { try { await cb.query("ROLLBACK"); } catch { /* já encerrada */ } pool.restaurar(); restaurarAmbiente(); }
});

// ───────────────────────── Modelo ANTERIOR à 124 (P2-1): nada quebra com 42P01 ─────────────────────────

test("124 r2 (modelo sem a 124): OTP formaliza a festa; Festas/elegíveis, painel, resumo e estado documental funcionam; papel = 409 INDISPONIVEL; exportação declara a tabela ausente", { skip: !opt(), timeout: 600_000 }, async (t) => {
  if (com124) return t.skip("modelo com a 124 (este teste é do modelo anterior)");
  const svc = servico();
  const festasSvc = carregar<typeof import("../festas/service.ts")>("lib/festas/service.ts");
  const { gerarPacote } = await import("../exportacao/pacote.ts");
  await emTx(async () => {
    const x = await aguardandoCliente();
    const tx = executor(a);
    const ctxFesta = () => ({ token: x.nativo.tokenRepresentante, requestId: randomUUID(), userAgent: null, empresaSolicitada: x.c.empresa });
    const hoje = await hojeSp();
    await gestaoCorrigir(x, "FESTA_CONSULTAR");
    // Antes da assinatura: listagem de Festas (elegíveis), painel e resumo, leitura administrativa e o registro.
    const lista = await festasSvc.consultarFestas(ctxFesta()) as { elegiveis: unknown[] };
    assert.ok(Array.isArray(lista.elegiveis));
    assert.deepEqual(await svc.assinaturasPapelDoPainel(tx, x.contratoId, x.c.empresa, "REPRESENTANTE_AUTORIZADO"), { podeRegistrar: false, registros: [] });
    assert.deepEqual(await svc.datasPapelClienteDoContrato(tx, x.contratoId), []);
    await recusa(() => registrar(x, { dataDeclarada: hoje }), codigo("ASSINATURA_PAPEL_INDISPONIVEL", 409));
    await recusa(() => svc.lerAssinaturaPapelAdmin(x.versaoId, x.nativo.tokenRepresentante, x.c.empresa, true), codigo("ASSINATURA_PAPEL_NAO_ENCONTRADA", 404));
    // OTP nativo: a festa nasce pela formalização sem a tabela da 124.
    await assinarComoCliente(x.contratoId, x.cpf);
    await validarAgora(a);
    assert.equal((await a.query("SELECT aceite_metodo FROM contrato_versoes WHERE id = $1::uuid", [x.versaoId])).rows[0].aceite_metodo, "OTP");
    assert.equal((await a.query("SELECT count(*)::int AS n FROM festas WHERE contrato_id = $1::uuid AND invalidada_em IS NULL", [x.contratoId])).rows[0].n, 1, "festa formalizada");
    const fe = (await a.query<{ id: string }>("SELECT fechamento_id::text AS id FROM contratos WHERE id = $1::uuid", [x.contratoId])).rows[0].id;
    const est = await carregar<typeof import("../agenda/estado-documental.ts")>("lib/agenda/estado-documental.ts").estadoDocumental(tx, { fechamentoId: fe });
    if (est.contrato === "COM_CONTRATO") assert.equal(est.versao?.assinatura, "NATIVA_DUPLA"); else assert.fail("sem contrato");
    const depois = await festasSvc.consultarFestas(ctxFesta()) as { festas: Array<{ contrato_id?: string }> };
    assert.ok(depois.festas.some((f) => f.contrato_id === x.contratoId), "a festa aparece na listagem");
    assert.deepEqual(await svc.assinaturasPapelDoPainel(tx, x.contratoId, x.c.empresa, "REPRESENTANTE_AUTORIZADO"), { podeRegistrar: false, registros: [] });
    assert.deepEqual(await svc.datasPapelClienteDoContrato(tx, x.contratoId), []);
    assert.equal(await publico().assinaturaPapelClientePublica({ id: x.versaoId, aceiteMetodo: "OTP" }), null);
    // Exportação: a entidade da 124 sai em entidadesAusentes com o motivo.
    const p = await gerarPacote(tx, x.c.empresa);
    await p.limpar();
    const ausente = p.manifesto.entidadesAusentes.find((e) => e.tabela === "contrato_assinaturas_papel");
    assert.ok(ausente && /migration não aplicada/.test(ausente.motivo), "contrato_assinaturas_papel ausente com o motivo");
    assert.equal(p.manifesto.arquivos.some((f) => f.tabela === "contrato_assinaturas_papel"), false);
  });
});
