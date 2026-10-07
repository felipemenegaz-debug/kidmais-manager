import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { Client } from "pg";
import { hashToken } from "../lib/autenticacao/senha.ts";
import type { DbExecutor } from "../lib/db/contracts.ts";

/**
 * Apoio de teste (como os demais scripts/*-test-support): cenários SINTÉTICOS das suítes PostgreSQL da integração (061) e da agenda por empresa/unidade (062). Só é usado
 * por `*.postgres.test.ts`, que rodam apenas no cluster descartável com opt-in (nunca staging/produção nem o banco
 * local `kidmais_manager`). Nada aqui conecta sozinho: recebe o Client já aberto pela suíte.
 */
export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exigir = createRequire(import.meta.url);
const extensoes = exigir.extensions as unknown as Record<string, (module: { _compile(code: string, filename: string): void }, filename: string) => void>;
extensoes[".ts"] = (module, filename) => {
  const output = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  }).outputText.replace(/require\("@\/([^"\n]+)"\)/g, (_texto, caminho: string) => `require(${JSON.stringify(resolve(root, caminho))})`);
  module._compile(output, filename);
};
/** Carrega um módulo do repositório pelo caminho a partir da raiz (CommonJS, com o alias `@/`). */
export const carregar = <T>(relativo: string) => exigir(resolve(root, relativo)) as T;
export const ler = (f: string) => readFileSync(resolve(root, f), "utf8");
export const cod = () => `i2${randomBytes(3).toString("hex")}`;
export const id = async (db: Client, sql: string, v: unknown[]) => (await db.query<{ id: string }>(sql, v)).rows[0].id;
export const executor = (db: Client): DbExecutor => ({ query: async (sql, values = []) => { const r = await db.query(sql, [...values]); return { rows: r.rows, rowCount: r.rowCount }; } }) as DbExecutor;
export const dia = (deslocamento: number) => new Date(Date.now() + deslocamento * 86_400_000).toISOString().slice(0, 10);

/**
 * Dispara AGORA as verificações diferidas pendentes (como no commit) e devolve cada restrição ao seu modo padrão:
 * as INITIALLY DEFERRED voltam a diferidas e as INITIALLY IMMEDIATE seguem imediatas. Sem isso, um
 * `SET CONSTRAINTS ALL IMMEDIATE` valeria para o resto da transação e anteciparia guardas de sequências
 * multi-comando (ledger 015, vínculo da 061) que no produto rodam cada uma na própria transação.
 */
export async function validarAgora(db: Client) {
  await db.query("SET CONSTRAINTS ALL IMMEDIATE");
  const diferidas = (await db.query<{ nome: string }>(
    `SELECT DISTINCT quote_ident(n.nspname) || '.' || quote_ident(c.conname) AS nome
       FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE c.condeferrable AND c.condeferred AND n.nspname = 'public' ORDER BY 1`,
  )).rows.map((r) => r.nome);
  // Nome compartilhado com uma restrição INITIALLY IMMEDIATE mudaria o modo dela: recusa em vez de aproximar.
  const ambiguas = (await db.query(
    `SELECT c.conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = 'public' AND c.condeferrable GROUP BY c.conname HAVING bool_or(c.condeferred) AND bool_or(NOT c.condeferred)`,
  )).rows;
  if (ambiguas.length) throw new Error(`validarAgora: nomes de restrição ambíguos ${JSON.stringify(ambiguas)}`);
  if (diferidas.length) await db.query(`SET CONSTRAINTS ${diferidas.join(", ")} DEFERRED`);
}

export async function existe(db: Client, tabela: string) {
  return (await db.query<{ ok: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${tabela}`])).rows[0]?.ok === true;
}

/** 055a–d com os scripts reais (pré-requisito da 061); idempotente no banco de trabalho. */
export async function instalar055(db: Client) {
  for (const [l, nome] of [["a", "uso"], ["b", "operacoes"], ["c", "documentos"], ["d", "importacoes"]]) {
    const tabela = { a: "ia_orcamento_reservas", b: "ia_operacoes", c: "ia_documentos", d: "ia_importacoes" }[l]!;
    if (!await existe(db, tabela)) {
      await db.query(ler(`database/migrations/20260928_055${l}_inteligencia_${nome}.sql`));
      await db.query(ler(`database/checks/20260928_055${l}_postcheck.sql`));
    }
  }
}

/** 061 com precheck, migration e postcheck reais; reaplicar é recusado. */
export async function instalar061(db: Client) {
  await db.query(ler("database/checks/20261002_061_precheck.sql"));
  await db.query(ler("database/migrations/20261002_061_contratos_importados_integracao.sql"));
  await db.query(ler("database/checks/20261002_061_postcheck.sql"));
  await assert.rejects(db.query(ler("database/migrations/20261002_061_contratos_importados_integracao.sql")), /061 já aplicada/);
  await db.query("ROLLBACK");
}

/** 062 com precheck, migration e postcheck reais; reaplicar é recusado. */
export async function instalar062(db: Client) {
  await db.query(ler("database/checks/20261002_062_precheck.sql"));
  await db.query(ler("database/migrations/20261002_062_agenda_empresa_unidade.sql"));
  await db.query(ler("database/checks/20261002_062_postcheck.sql"));
  await assert.rejects(db.query(ler("database/migrations/20261002_062_agenda_empresa_unidade.sql")), /062 já aplicada/);
  await db.query("ROLLBACK");
}

/**
 * Empresa ativa, usuário com membership ADMINISTRATIVO e sessão (recebimento exige sessão viva), pacote com preço e
 * `unidades` unidades (a 043 cria toda unidade SUSPENSO; a agenda usa a unidade não desativada).
 */
export async function cenario(db: Client, unidades = 1) {
  const empresa = await id(db, `INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Empresa 061', 'PROVISIONAMENTO') RETURNING id`, [cod()]);
  await db.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [empresa]);
  const usuario = await id(db, `INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Operador 061', $2, 'ADMINISTRATIVO', true) RETURNING id`,
    [`${cod()}@example.test`, `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`]);
  const membership = await id(db, `INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), 'ADMINISTRATIVO') RETURNING id`, [empresa, usuario]);
  await db.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [membership]);
  const token = randomBytes(32).toString("base64url");
  await db.query(`INSERT INTO sessoes_administrativas (usuario_id, token_hash, csrf_hash, autenticado_em, ultima_atividade_em, expira_em)
     VALUES ($1::uuid, $2, $3, clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '8 hours')`, [usuario, hashToken(token), hashToken(randomBytes(32).toString("base64url"))]);
  const pacote = await id(db, `INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente) VALUES ($1::uuid, $2, 'Festa 061', 1, true, true) RETURNING id`, [empresa, cod().toUpperCase()]);
  const tabela = await id(db, `INSERT INTO tabelas_preco (codigo, nome, vigencia_inicio, ativa, empresa_id) VALUES ($1, 'Tabela 061', '2020-01-01', false, $2::uuid) RETURNING id`, [cod(), empresa]);
  await db.query(`INSERT INTO precos_pacote (tabela_preco_id, pacote_id, convidados_min, tipo_calculo, valor, categoria_horario) VALUES ($1::uuid, $2::uuid, 1, 'FIXO', 100, 'PADRAO')`, [tabela, pacote]);
  const agendaCodigo = cod().toUpperCase();
  await db.query(`INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, ordem_exibicao) VALUES ($1, 'Agenda 061', '10:00', '22:00', 99)`, [agendaCodigo]);
  const lista: string[] = [];
  for (let i = 0; i < unidades; i++) {
    lista.push(await id(db, `INSERT INTO estabelecimentos (empresa_id, codigo, nome, status) VALUES ($1::uuid, $2, $3, 'SUSPENSO') RETURNING id`, [empresa, `u-${cod()}`, `Unidade ${i + 1}`]));
  }
  return { empresa, usuario, membership, token, pacote, agendaCodigo, unidade: lista[0] ?? null, unidades: lista,
    tenant: { empresaComprovada: empresa, membershipId: membership, usuarioId: usuario, papelAtual: "ADMINISTRATIVO" } };
}

export type Cenario = Awaited<ReturnType<typeof cenario>>;

/** Representante autorizado SINTÉTICO (Gestão, 056) com membership ATIVA na empresa do cenário: operador da agenda por unidade. */
export async function representante(db: Client, c: { empresa: string }) {
  const usuario = await id(db, `INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Representante 062', $2, 'ADMINISTRATIVO', true) RETURNING id`,
    [`${cod()}@example.test`, `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`]);
  const membership = await id(db, `INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO') RETURNING id`, [c.empresa, usuario]);
  await db.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [membership]);
  return { empresaComprovada: c.empresa, membershipId: membership, usuarioId: usuario, papelAtual: "REPRESENTANTE_AUTORIZADO" };
}

export type Evento = { data: string; inicio: string; fim: string };

/** Importação CONFIRMADA (IMPORTADA) com original real e o snapshot como o motor grava. */
export async function importacao(db: Client, c: Cenario, evento: Evento, apenasRascunho = false) {
  const cliente = apenasRascunho ? randomUUID() : await id(db, `INSERT INTO clientes (nome_completo, empresa_id, telefone, whatsapp, cpf) VALUES ('Cliente 061', $1::uuid, '11999990000', '11999990000', $2) RETURNING id`, [c.empresa, cpfValido()]);
  const documento = await id(db, `INSERT INTO ia_documentos (empresa_id, tipo, status, enviado_por) VALUES ($1::uuid, 'CONTRATO_HISTORICO', 'RECEBIDO', $2::uuid) RETURNING id`, [c.empresa, c.usuario]);
  const pdf = Buffer.from(`%PDF-1.4\n% contrato em papel ${randomUUID()}\n%%EOF\n`);
  const sha = createHash("sha256").update(pdf).digest("hex");
  const original = await id(db, `INSERT INTO ia_documento_originais (documento_id, empresa_id, versao, nome_original, content_type, tamanho_bytes, sha256, conteudo, enviado_por)
     VALUES ($1::uuid, $2::uuid, 1, 'contrato.pdf', 'application/pdf', $3, $4, $5, $6::uuid) RETURNING id`, [documento, c.empresa, pdf.length, sha, pdf, c.usuario]);
  const extracao = await id(db, `INSERT INTO ia_extracoes (documento_id, empresa_id, original_id, metodo, schema_versao, status, resultado, correlation_id, iniciado_em, concluido_em)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'DETERMINISTICO', 1, 'SUCESSO', '{}'::jsonb, 'h061', now(), now()) RETURNING id`, [documento, c.empresa, original]);
  const imp = await id(db, `INSERT INTO ia_importacoes (documento_id, empresa_id, extracao_id, status, versao, dados, criado_por) VALUES ($1::uuid, $2::uuid, $3::uuid, 'EM_REVISAO', 1, '{}'::jsonb, $4::uuid) RETURNING id`,
    [documento, c.empresa, extracao, c.usuario]);
  const snapshot = {
    evento: { data: evento.data, horario: { inicio: evento.inicio, fim: evento.fim }, duracaoMinutos: 240, aniversariante: "Lia", idade: 6, convidados: 50, tema: "Circo" },
    pacote: { nome: "Festa de 2019", duracaoMinutos: 240, quantidade: 50, itens: "Buffet completo" },
    buffet: { itens: null, observacoes: null, restricoes: null },
    valores: { preco: 500000, adicionais: 0, total: 500000 },
    pagamentosPrevistos: { condicao: "30% de entrada", entrada: { valor: 150000, vencimento: dia(-60) }, parcelas: [{ numero: 1, valor: 350000, vencimento: dia(30) }], natureza: "PREVISTO" as const },
    observacoes: null,
  };
  if (!apenasRascunho) await db.query(`UPDATE ia_importacoes SET status = 'IMPORTADA', versao = 2, cliente_id = $2::uuid, resultado = $3::jsonb WHERE id = $1::uuid`,
    [imp, cliente, JSON.stringify({ clienteId: cliente, clienteAcao: "CRIAR", contratoHistorico: snapshot, pendencias: [], importadoEm: new Date().toISOString(), importadoPor: c.usuario })]);
  return { id: imp, cliente, sha, documento, extracao, snapshot };
}

/**
 * Sem unidade por padrão: unidade só com habilitação explícita (D6 = opção A). Os cenários sintéticos repetem o mesmo
 * valor e aniversariante em várias importações da empresa, então, por padrão, a decisão "é outro contrato" vem
 * tomada (com motivo); o caminho sem decisão é provado à parte, com `duplicidade: null`.
 */
export function decisoes(c: Cenario, evento: Evento, financeiro: unknown, unidade: string | null = null,
  duplicidade: { motivo: string } | null = { motivo: "Cenário sintético: contratos distintos" }) {
  return {
    situacaoContrato: "VIGENTE", estabelecimentoId: unidade, pacoteReferenciaId: c.pacote,
    evento: { data: evento.data, horarioInicio: evento.inicio, horarioFim: evento.fim, convidados: 50 },
    valorContratadoCentavos: 500000, motivos: {}, financeiro,
    outroContratoConfirmado: duplicidade !== null, motivoOutroContrato: duplicidade?.motivo ?? "", conferenciaDeclarada: true,
  };
}

/** Contexto da sessão do cenário com autenticação recente (senha confirmada agora), como a rota monta. */
export const ctxIntegracao = (c: Cenario, autenticadoEm = new Date().toISOString()) =>
  ({ usuarioId: c.usuario, token: c.token, requestId: randomUUID(), ip: null, userAgent: "h061", autenticadoEm });
export const PARCIAL = () => ({ situacao: "PARCIALMENTE_PAGO", parcelas: [
  { valorCentavos: 150000, vencimento: dia(-60), recebimento: { data: dia(-58), forma: "PIX" } },
  { valorCentavos: 350000, vencimento: dia(30), recebimento: null },
] });

export type Servico = typeof import("../lib/contratos/integracao-importados/servico.ts");

export async function integrar(s: Servico, core: unknown, db: Client, c: Cenario, imp: string, d: ReturnType<typeof decisoes>, chave = randomUUID()) {
  const tx = executor(db);
  const sim = await s.simularIntegracao(tx, c.tenant as never, imp, d, dia(0));
  if (sim.integrada || !sim.pronto) throw new Error(`simulação não pronta: ${JSON.stringify(sim)}`);
  return s.confirmarIntegracao(tx, c.tenant as never, ctxIntegracao(c), imp, { decisoes: d, resumoHash: sim.resumoHash, chave }, dia(0), core as never);
}

/* ───────────────────────── Fluxos NATIVOS (revisão, assinaturas, financeiro) — cenários [R5] ─────────────────────────
 * Reproduzem a sequência dos scripts de integração nativos (festa-019, contrato-revisao-inicial, alteracao-financeira),
 * dentro da transação do teste: o pool global é trocado por um adaptador que transforma BEGIN/COMMIT/ROLLBACK dos
 * serviços em SAVEPOINT; as verificações diferidas rodam com `validarAgora` e o ROLLBACK final desfaz tudo.
 * Sem WhatsApp: o código do desafio é capturado pelo emissor injetado. Sem PDF de modelo externo: pacote COMPLETA. */

/** CPF sintético com dígitos verificadores válidos. */
export function cpfValido() {
  const d = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  for (const peso of [10, 11]) { const r = d.reduce((soma, x, i) => soma + x * (peso - i), 0) * 10 % 11; d.push(r === 10 ? 0 : r); }
  return d.join("");
}

/** Pool global apontando para a conexão do teste (BEGIN/COMMIT/ROLLBACK dos serviços viram SAVEPOINT). Devolve a restauração. */
export function poolNaTransacao(db: Client) {
  const g = globalThis as { __kidmaisPgPool?: unknown };
  const anterior = g.__kidmaisPgPool;
  const troca: Record<string, string> = { BEGIN: "SAVEPOINT operacao_nativa", COMMIT: "RELEASE SAVEPOINT operacao_nativa", ROLLBACK: "ROLLBACK TO SAVEPOINT operacao_nativa" };
  g.__kidmaisPgPool = {
    query: (sql: string, v?: unknown[]) => db.query(sql, v),
    connect: async () => ({ query: (sql: string, v?: unknown[]) => db.query(troca[sql] ?? sql, v), release() {} }),
  };
  return () => { g.__kidmaisPgPool = anterior; };
}

/** Ambiente dos fluxos nativos de assinatura (o mesmo dos scripts de integração). Devolve a restauração. */
export function ambienteAssinatura() {
  const nomes = ["FESTA_ENABLED", "CONTRATO_ACEITE_DEV_ENABLED", "IDENTIDADE_OTP_PEPPER", "IDENTIDADE_OTP_PROVIDER"] as const;
  const antes = Object.fromEntries(nomes.map((n) => [n, process.env[n]]));
  process.env.FESTA_ENABLED = "true";
  process.env.CONTRATO_ACEITE_DEV_ENABLED = "true";
  process.env.IDENTIDADE_OTP_PEPPER = randomBytes(32).toString("hex");
  delete process.env.IDENTIDADE_OTP_PROVIDER;
  return () => { for (const n of nomes) { if (antes[n] === undefined) delete process.env[n]; else process.env[n] = antes[n]; } };
}

/**
 * Catálogo do cenário apto aos fluxos nativos: pacote com modelo oficial (COMPLETA), tabela publicada como o caminho real
 * (só `publicada_em`; a 035 exige tabela inativa na publicação) e regra de
 * categoria de horário para todos os dias no turno do cenário. Representante autorizado com sessão (senha "agora") e a
 * capacidade de assinar pela empresa.
 */
export async function catalogoNativo(db: Client, c: Cenario) {
  await db.query(`UPDATE pacotes SET codigo = 'COMPLETA' WHERE id = $1::uuid`, [c.pacote]);
  // Escopo comercial declarado (047) igual ao único preço do cenário: pacote, PADRAO, a partir de 1 convidado.
  const tabela = (await db.query<{ id: string }>(`SELECT id FROM tabelas_preco WHERE empresa_id = $1::uuid AND publicada_em IS NULL`, [c.empresa])).rows[0].id;
  const escopo = await id(db, `INSERT INTO tabela_preco_escopos (tabela_preco_id, pacote_id, categoria_horario, cobertura_continua) VALUES ($1::uuid, $2::uuid, 'PADRAO', true) RETURNING id`, [tabela, c.pacote]);
  await db.query(`INSERT INTO tabela_preco_escopo_faixas (escopo_id, convidados_min, convidados_max) VALUES ($1::uuid, 1, NULL)`, [escopo]);
  await db.query(`UPDATE tabelas_preco SET publicada_em = clock_timestamp() WHERE id = $1::uuid`, [tabela]);
  const turno = (await db.query<{ id: string }>(`SELECT id FROM configuracao_agenda WHERE codigo = $1`, [c.agendaCodigo])).rows[0].id;
  await catalogoNoTurno(db, c, turno);
  const rep = await representante(db, c);
  const token = randomBytes(32).toString("base64url");
  await db.query(`INSERT INTO sessoes_administrativas (usuario_id, token_hash, csrf_hash, autenticado_em, ultima_atividade_em, expira_em)
     VALUES ($1::uuid, $2, $3, clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '8 hours')`, [rep.usuarioId, hashToken(token), hashToken(randomBytes(32).toString("base64url"))]);
  await db.query(`INSERT INTO empresa_membership_capacidades (empresa_id, membership_id, capacidade, concedido_por, motivo) VALUES ($1::uuid, $2::uuid, 'CONTRATO_ASSINAR_EMPRESA', $3::uuid, 'Cenário R5')`,
    [c.empresa, rep.membershipId, rep.usuarioId]);
  return { turno, representante: rep, tokenRepresentante: token };
}

/**
 * Categoria de horário e elegibilidade comercial do pacote do cenário em um turno, todos os dias (o que o cadastro
 * grava). A categoria PADRAO entra como a regra MAIS RECENTE do turno: os turnos semeados (TURNO_1/TURNO_2, 006) têm
 * domingo/sábado NOBRE desde 2026-09-07, e o cenário só tem preço PADRAO — sem isso o dia da semana decidiria o teste.
 */
export async function catalogoNoTurno(db: Client, c: Cenario, turno: string) {
  for (let dia = 1; dia <= 7; dia++) {
    const inicio = (await db.query<{ d: string }>(`SELECT greatest(DATE '2020-01-01', max(vigencia_inicio) + 1)::text d FROM regras_categoria_horario WHERE dia_semana = $1 AND configuracao_agenda_id = $2::uuid`,
      [dia, turno])).rows[0].d;
    // Nova vigência como o cadastro faz: a regra aberta anterior termina na véspera (vigências não se sobrepõem, 006).
    await db.query(`UPDATE regras_categoria_horario SET vigencia_fim = $3::date - 1 WHERE dia_semana = $1 AND configuracao_agenda_id = $2::uuid AND ativo
      AND vigencia_inicio < $3::date AND (vigencia_fim IS NULL OR vigencia_fim >= $3::date)`, [dia, turno, inicio]);
    await db.query(`INSERT INTO regras_categoria_horario (dia_semana, configuracao_agenda_id, categoria_horario, vigencia_inicio) VALUES ($1, $2::uuid, 'PADRAO', $3::date)
      ON CONFLICT (dia_semana, configuracao_agenda_id, vigencia_inicio) DO UPDATE SET ativo = true, vigencia_fim = NULL`, [dia, turno, inicio]);
    await db.query(`INSERT INTO regras_disponibilidade_pacote (pacote_id, dia_semana, configuracao_agenda_id, estado, vigencia_inicio) VALUES ($1::uuid, $2, $3::uuid, 'DISPONIVEL', '2020-01-01')
      ON CONFLICT (pacote_id, dia_semana, configuracao_agenda_id, vigencia_inicio) DO NOTHING`, [c.pacote, dia, turno]);
  }
}

/** Dados contratuais completos do cliente (o snapshot nativo e o desafio OTP exigem). Devolve o CPF. */
export async function completarCliente(db: Client, clienteId: string) {
  const cpf = cpfValido();
  await db.query(`UPDATE clientes SET cpf = $2, email = $3, whatsapp = '11999998888', telefone = '11999998888', cep = '01001000', logradouro = 'Rua Sintética',
      numero = '1', bairro = 'Centro', cidade = 'São Paulo', uf = 'SP' WHERE id = $1::uuid`, [clienteId, cpf, `${randomUUID()}@example.invalid`]);
  return cpf;
}

type Operar = (versaoId: string, input: Record<string, unknown>, token: string, ctx: { requestId: string; ip: null; userAgent: string }, empresa?: string) => Promise<Record<string, unknown>>;

/** Congela a versão em preparação como o Admin faz: PDF, revisão, assinatura Kidmais (representante) e liberação ao cliente. */
export async function congelarEAssinarKidmais(db: Client, operar: Operar, versaoId: string, empresa: string, tokenAdmin: string, tokenRepresentante: string) {
  const ctxOp = () => ({ requestId: randomUUID(), ip: null, userAgent: "r5" });
  const revisao = async () => (await db.query<{ revisao: number }>(`SELECT revisao FROM contrato_edicoes WHERE contrato_versao_id = $1`, [versaoId])).rows[0].revisao;
  const pdf = await operar(versaoId, { acao: "gerar_pdf", revisao: await revisao() }, tokenAdmin, ctxOp(), empresa) as { documentoId: string };
  await operar(versaoId, { acao: "revisar", revisao: await revisao(), documentoId: pdf.documentoId }, tokenAdmin, ctxOp(), empresa);
  await operar(versaoId, { acao: "assinar", revisao: await revisao(), documentoId: pdf.documentoId, chaveIdempotencia: randomUUID() }, tokenRepresentante, ctxOp(), empresa);
  await operar(versaoId, { acao: "liberar", revisao: await revisao() }, tokenAdmin, ctxOp(), empresa);
}

/** Assinatura do cliente pelo fluxo público real (acesso por CPF, desafio, prova, contexto, aceite). */
export async function assinarComoCliente(contratoId: string, cpf: string) {
  const publico = carregar<typeof import("../lib/contratos/services/contrato-publico.service.ts")>("lib/contratos/services/contrato-publico.service.ts");
  const identidade = carregar<{ criarIdentityServiceComAmbiente: (s: (x: { codigo: string }) => Promise<void>) => { confirmarCodigo: (i: { validacaoId: string; codigo: string }) => Promise<{ provaToken: string }> } }>("lib/identidade/services/index.ts");
  const acesso = await publico.consultarAcessoContrato({ contratoId, cpf }) as { canais: Array<{ canal: string }> };
  let codigo = "";
  const emissor = async (x: { codigo: string }) => { codigo = x.codigo; };
  const desafio = await publico.iniciarDesafioContrato({ contratoId, cpf, canal: acesso.canais[0].canal } as never, emissor as never) as { validacaoId: string; acessoToken: string };
  const prova = await identidade.criarIdentityServiceComAmbiente(emissor).confirmarCodigo({ validacaoId: desafio.validacaoId, codigo });
  const entrada = { contratoId, acessoToken: desafio.acessoToken, provaToken: prova.provaToken };
  const contexto = await publico.obterContextoContratoPublico(entrada);
  return publico.assinarContratoPublico({ ...entrada, versaoId: contexto.versao.id, snapshotHash: contexto.versao.snapshotHash, documentoPdfHash: contexto.versao.documentoPdfHash } as never,
    (async () => { throw new Error("nenhum OTP externo"); }) as never, { requestId: randomUUID() });
}
