import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../../comercial/postgres-descartavel.ts";
import {
  ambienteAssinatura, carregar, catalogoNativo, catalogoNoTurno, cenario, cpfValido, decisoes, dia, executor, id, importacao, integrar, PARCIAL, poolNaTransacao, validarAgora,
  type Cenario, type Servico,
} from "../../../scripts/integracao-importados-test-support.ts";
import { importacaoPj } from "../../importacao-contrato/apoio-entrega-a.test.ts";
import { executarImportacao, ImportacaoError, type ServicosImportacao } from "../../importacao-contrato/motor.ts";
import { montarPlano } from "../../importacao-contrato/plano.ts";
import { dadosDaImportacao, planejar, type PortaImportacao } from "./acao.ts";

/**
 * Entrega B (112) — importação de contrato antigo com contratante PJ, no PostgreSQL DESCARTÁVEL, pelos serviços reais:
 * - 112: o plano (busca no CRM + 112 conferida na transação) libera a PJ; o motor cria o cliente PJ (CNPJ, razão social,
 *   representante, sem CPF); o CPF do representante, mesmo cadastrado como PF na empresa, não é procurado nem vinculado;
 *   a segunda importação acha o cliente pelo CNPJ e vincula; vínculo forjado com cliente PF é recusado pelo motor antes
 *   de gravar;
 * - 112: a conclusão integrada de um contrato PJ grava o snapshot com tipo, CNPJ e representante (CPF vazio); a conferência
 *   salva contato no cadastro sem tocar no CNPJ e no representante; cadastro com CPF num cliente PJ fica bloqueado;
 * - 109 (código novo sem a 112): o plano recusa a PJ com MIGRACAO_PENDENTE sem consultar CNPJ; a integração PF segue e o
 *   cliente lido não ganha chave de PJ.
 * Cada teste termina em ROLLBACK.
 */
const opt = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL === "kidmais_pacotes_v1_descartavel";
let a: Client;
let com112 = false;
const CNPJ = "11222333000181";
const REPRESENTANTE = "52998224725";
const ctx = (c: Cenario) => ({ usuarioId: c.usuario, origem: "CRM_INTERNO" as const, requestId: randomUUID(), ip: null, userAgent: "importacao-pj" });

async function emTx(corpo: () => Promise<void>) {
  await a.query("BEGIN");
  const restaurarPool = poolNaTransacao(a);
  const restaurarAmbiente = ambienteAssinatura();
  try { await corpo(); } finally { await a.query("ROLLBACK"); restaurarAmbiente(); restaurarPool(); }
}
const clientes = () => carregar<typeof import("../../clientes/services/index.ts")>("lib/clientes/services/index.ts");
const repoClientes = () => carregar<typeof import("../../clientes/repositories/cliente.repository.ts")>("lib/clientes/repositories/cliente.repository.ts");

/** Porta como a composição da rota: análise do CRM e 112 conferida na mesma transação. Registra o que foi procurado. */
function porta(procurados: unknown[]): PortaImportacao {
  const usada: Pick<PortaImportacao, "analisarCliente" | "pessoaJuridicaDisponivel"> = {
    analisarCliente: (tx, empresaId, dados) => { procurados.push(dados); return clientes().analisarCadastroCliente(dados, empresaId, {}, tx); },
    pessoaJuridicaDisponivel: (tx) => repoClientes().migration112Aplicada(tx),
  };
  return usada as unknown as PortaImportacao;
}
function servicos(c: Cenario, gravados: string[]): ServicosImportacao {
  return {
    async cadastrarCliente(tx, empresaId, dados) {
      gravados.push("cadastrar");
      return { clienteId: (await clientes().cadastrarClienteInterno({ ...dados, empresaId }, ctx(c), tx)).cliente.id };
    },
    async conferirCliente(tx, empresaId, clienteId) {
      gravados.push("conferir");
      const { cliente } = await clientes().obterClienteBase(clienteId, empresaId, tx);
      return { tipoPessoa: cliente.tipoPessoa, cnpj: cliente.cnpj };
    },
    async atualizarImportacao() { gravados.push("atualizar"); return true; },
  };
}
const entrada = (c: Cenario) => ({ empresaId: c.empresa, usuarioId: c.usuario, requestId: randomUUID(), importacao: importacaoPj(), agora: new Date().toISOString() });
const linhaCliente = async (clienteId: string) => (await a.query(
  `SELECT nome_completo, cpf, rg, email, whatsapp, to_jsonb(c) ->> 'tipo_pessoa' tipo, to_jsonb(c) ->> 'cnpj' cnpj, to_jsonb(c) ->> 'razao_social' razao,
          to_jsonb(c) ->> 'representante_nome' rep, to_jsonb(c) ->> 'representante_cpf' rep_cpf FROM clientes c WHERE id = $1::uuid`, [clienteId])).rows[0];

test.before(async () => {
  if (!opt()) return;
  process.env.FESTA_ENABLED = "true";
  process.env.CONTRACT_IMPORT_INTEGRATION_ENABLED = "true";
  a = await conectarDescartavel();
  com112 = (await a.query("SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.clientes'::regclass AND attname = 'tipo_pessoa' AND NOT attisdropped) AS ok")).rows[0].ok;
});
test.after(async () => { if (a) await encerrarDescartavel(a); });

test("112: plano libera a PJ; motor cria o cliente PJ; representante PF da empresa não é procurado; 2ª importação vincula pelo CNPJ; vínculo forjado com PF recusado", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (!com112) return t.skip("modelo sem a 112");
  await emTx(async () => {
    const c = await cenario(a, 0);
    const tx = executor(a);
    // O representante também é cliente PF desta empresa (outro telefone): o CPF dele nunca entra na busca da PJ.
    const pf = await id(a, `INSERT INTO clientes (nome_completo, cpf, empresa_id, telefone, whatsapp) VALUES ('Carla Dias', $1, $2::uuid, '11977776666', '11977776666') RETURNING id`, [REPRESENTANTE, c.empresa]);
    const procurados: Array<Record<string, unknown>> = [];
    const dados = dadosDaImportacao(importacaoPj());
    const plano = await planejar(tx, c.empresa, porta(procurados), dados);
    assert.deepEqual([plano.pronto, plano.tipoPessoa, plano.recusa, plano.match.estado, plano.cnpj], [true, "PJ", null, "NOVO_CLIENTE", CNPJ], JSON.stringify(plano.bloqueios));
    assert.deepEqual([procurados[0].cpf, procurados[0].cnpj], [null, CNPJ]);

    const gravados: string[] = [];
    const criado = await executarImportacao(tx, { ...entrada(c), plano }, servicos(c, gravados));
    assert.equal(criado.clienteAcao, "CRIAR");
    assert.deepEqual({ ...await linhaCliente(criado.clienteId) }, {
      nome_completo: "Escola Pequeno Saber Ltda", cpf: null, rg: null, email: null, whatsapp: "62998765432", tipo: "PJ", cnpj: CNPJ, razao: "Escola Pequeno Saber Ltda", rep: "Carla Dias", rep_cpf: REPRESENTANTE,
    });

    // Segunda importação do mesmo CNPJ: cliente existente pelo CNPJ, vínculo conferido no banco.
    const segundo = await planejar(tx, c.empresa, porta([]), dados);
    assert.deepEqual([segundo.match.estado, segundo.match.clienteId, segundo.match.motivo], ["CLIENTE_EXISTENTE", criado.clienteId, "Cliente encontrado pelo CNPJ."]);
    gravados.length = 0;
    const vinculado = await executarImportacao(tx, { ...entrada(c), plano: segundo }, servicos(c, gravados));
    assert.deepEqual([vinculado.clienteAcao, vinculado.clienteId, gravados], ["VINCULAR", criado.clienteId, ["conferir", "atualizar"]]);

    // Vínculo forjado (plano PJ apontando para o cliente PF do representante): o motor relê e recusa antes de gravar.
    const forjado = montarPlano(dados.extracao, dados.revisados, { estado: "CLIENTE_EXISTENTE", clienteId: pf, candidatos: [], motivo: "forjado" }, null, { pessoaJuridica: true });
    gravados.length = 0;
    await a.query("SAVEPOINT forjado");
    await assert.rejects(executarImportacao(tx, { ...entrada(c), plano: forjado }, servicos(c, gravados)), (e) => e instanceof ImportacaoError && e.code === "TIPO_PESSOA_DIVERGENTE");
    await a.query("ROLLBACK TO SAVEPOINT forjado");
    assert.deepEqual(gravados, ["conferir"]);
    assert.equal((await linhaCliente(pf)).tipo, "PF");
  });
});

test("112: conclusão integrada de contrato PJ — snapshot com CNPJ e representante; conferência salva contato sem tocar no CNPJ; CPF num cliente PJ bloqueia", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (!com112) return t.skip("modelo sem a 112");
  await emTx(async () => {
    const c = await cenario(a, 0);
    await catalogoNativo(a, c);
    const s = carregar<Servico>("lib/contratos/integracao-importados/servico.ts");
    const { coreNativo } = carregar<typeof import("../../contratos/integracao-importados/composicao.ts")>("lib/contratos/integracao-importados/composicao.ts");
    const ev = { data: dia(60), inicio: "14:00", fim: "18:00" };
    // Rascunho do apoio e conclusão como o motor grava, já com o cliente PJ (importação encerrada é imutável).
    const imp = await importacao(a, c, ev, true);
    const pj = await id(a, `INSERT INTO clientes (nome_completo, razao_social, tipo_pessoa, cnpj, nome_fantasia, representante_nome, representante_cpf, empresa_id, telefone, whatsapp)
       VALUES ('Escola Pequeno Saber Ltda', 'Escola Pequeno Saber Ltda', 'PJ', $1, 'Pequeno Saber', 'Carla Dias', $2, $3::uuid, '62998765432', '62998765432') RETURNING id`, [CNPJ, REPRESENTANTE, c.empresa]);
    await a.query(`UPDATE ia_importacoes SET status = 'IMPORTADA', versao = 2, cliente_id = $2::uuid, resultado = $3::jsonb WHERE id = $1::uuid`,
      [imp.id, pj, JSON.stringify({ clienteId: pj, clienteAcao: "CRIAR", contratoHistorico: imp.snapshot, pendencias: [], importadoEm: new Date().toISOString(), importadoPor: c.usuario })]);
    const tx = executor(a);

    const opcoes = await s.opcoesIntegracao(tx, c.tenant as never, imp.id, dia(0));
    assert.deepEqual(opcoes.cliente?.pessoaJuridica, { cnpj: "11.222.333/0001-81", nomeFantasia: "Pequeno Saber", representante: "Carla Dias" });
    assert.deepEqual([opcoes.cliente?.cadastro?.cpf, opcoes.cliente?.cadastro?.rg], ["", ""]);

    const base = decisoes(c, ev, PARCIAL());
    const cadastro = { nomeCompleto: "Escola Pequeno Saber Ltda", cpf: "", rg: "", whatsapp: "62998765432", email: "secretaria@example.invalid",
      cep: "", logradouro: "", numero: "", complemento: "", bairro: "", cidade: "", uf: "" };
    const comCpf = await s.simularIntegracao(tx, c.tenant as never, imp.id, { ...base, cadastro: { ...cadastro, cpf: REPRESENTANTE } }, dia(0));
    assert.ok(!comCpf.integrada && !comCpf.pronto);
    assert.ok(!comCpf.integrada && comCpf.bloqueios.some((b) => b.startsWith("Complete os dados do contratante: razão social")), JSON.stringify(comCpf));

    const r = await integrar(s, coreNativo, a, c, imp.id, { ...base, cadastro } as typeof base);
    await validarAgora(a);
    const contratante = (await a.query(`SELECT v.snapshot -> 'contratante' c FROM contrato_versoes v WHERE v.contrato_id = $1::uuid ORDER BY v.numero_versao LIMIT 1`, [r.contratoId])).rows[0].c;
    assert.deepEqual([contratante.tipoPessoa, contratante.cnpj, contratante.cpf, contratante.razaoSocial, contratante.nomeFantasia, contratante.representante],
      ["PJ", CNPJ, "", "Escola Pequeno Saber Ltda", "Pequeno Saber", { nome: "Carla Dias", cpf: REPRESENTANTE }]);
    const depois = await linhaCliente(pj);
    assert.deepEqual([depois.tipo, depois.cnpj, depois.cpf, depois.rep, depois.rep_cpf, depois.email], ["PJ", CNPJ, null, "Carla Dias", REPRESENTANTE, "secretaria@example.invalid"]);
  });
});

test("112: nova versão de contrato PJ — com modelo legado a alteração comercial e a aprovação da preparação são recusadas antes de gravar; com modelo compatível aprova", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (!com112) return t.skip("modelo sem a 112");
  await emTx(async () => {
    const c = await cenario(a, 0);
    const nativo = await catalogoNativo(a, c);
    const s = carregar<Servico>("lib/contratos/integracao-importados/servico.ts");
    const { coreNativo } = carregar<typeof import("../../contratos/integracao-importados/composicao.ts")>("lib/contratos/integracao-importados/composicao.ts");
    const adm = carregar<typeof import("../../contratos/services/administrativo.service.ts")>("lib/contratos/services/administrativo.service.ts");
    const rs = carregar<typeof import("../../fechamentos/services/revisao-operacional.service.ts")>("lib/fechamentos/services/revisao-operacional.service.ts");
    const operar = adm.operarContrato as unknown as (versaoId: string, input: Record<string, unknown>, token: string, ctx: unknown, empresa: string) => Promise<unknown>;
    const ctxOp = () => ({ requestId: randomUUID(), ip: null, userAgent: "importacao-pj" });
    const ev = { data: dia(64), inicio: "14:00", fim: "18:00" };
    // Contrato PJ vigente, como na conclusão integrada do teste anterior.
    const imp = await importacao(a, c, ev, true);
    const pj = await id(a, `INSERT INTO clientes (nome_completo, razao_social, tipo_pessoa, cnpj, nome_fantasia, representante_nome, representante_cpf, empresa_id, telefone, whatsapp, email, cep, logradouro, numero, bairro, cidade, uf)
       VALUES ('Escola Pequeno Saber Ltda', 'Escola Pequeno Saber Ltda', 'PJ', $1, 'Pequeno Saber', 'Carla Dias', $2, $3::uuid, '62998765432', '62998765432', 'secretaria@example.invalid', '01001000', 'Rua Sintética', '1', 'Centro', 'São Paulo', 'SP') RETURNING id`, [CNPJ, REPRESENTANTE, c.empresa]);
    await a.query(`UPDATE ia_importacoes SET status = 'IMPORTADA', versao = 2, cliente_id = $2::uuid, resultado = $3::jsonb WHERE id = $1::uuid`,
      [imp.id, pj, JSON.stringify({ clienteId: pj, clienteAcao: "CRIAR", contratoHistorico: imp.snapshot, pendencias: [], importadoEm: new Date().toISOString(), importadoPor: c.usuario })]);
    const cadastro = { nomeCompleto: "Escola Pequeno Saber Ltda", cpf: "", rg: "", whatsapp: "62998765432", email: "secretaria@example.invalid",
      cep: "01001000", logradouro: "Rua Sintética", numero: "1", complemento: "", bairro: "Centro", cidade: "São Paulo", uf: "SP" };
    const r = await integrar(s, coreNativo, a, c, imp.id, { ...decisoes(c, ev, PARCIAL()), cadastro } as ReturnType<typeof decisoes>);
    await validarAgora(a);
    const festa = (await a.query<{ id: string; turno: string }>(`SELECT f.id::text id, f.configuracao_agenda_id::text turno FROM contratos k JOIN fechamentos f ON f.id = k.fechamento_id WHERE k.id = $1::uuid`, [r.contratoId])).rows[0];
    if (festa.turno !== nativo.turno) await catalogoNoTurno(a, c, festa.turno);

    // Depois do contrato, a empresa publica um modelo que qualifica o contratante como PF.
    const clausula = (q: string) => ({ titulo: "Contrato", contratada: { nome: "Buffet Ltda", documento: "12.345.678/0001-90", endereco: "Rua Teste, 2", representante: "Pessoa Teste" },
      preambulo: [], observacoes: [], cidadeAssinatura: "Cidade Teste", clausulas: [{ titulo: "Objeto", texto: `Festa em {{festa.data}} ({{festa.pacote}}), {{valor.total}}. ${q}` }] });
    await a.query(`INSERT INTO modelos_contrato_empresa (empresa_id, versao, conteudo, conteudo_sha256, aprovado_por) VALUES ($1::uuid, 1, $2::jsonb, $3, $4::uuid)`,
      [c.empresa, JSON.stringify(clausula("Contratante {{contratante.nome}}, CPF {{contratante.cpf}}.")), "b".repeat(64), c.usuario]);

    const vigente = (await a.query<{ v: string }>(`SELECT versao_vigente_id::text v FROM contrato_fluxos WHERE contrato_id = $1`, [r.contratoId])).rows[0].v;
    await operar(vigente, { acao: "nova_versao", tipo: "NOVA_VERSAO", motivo: "Ajuste comercial", chaveCriacao: randomUUID() }, c.token, ctxOp(), c.empresa);
    const v2 = (await a.query<{ id: string }>(`SELECT versao_em_preparacao_id::text id FROM contrato_fluxos WHERE contrato_id = $1`, [r.contratoId])).rows[0].id;
    const tx = executor(a);
    const edicao = async () => (await a.query<{ revisao: number }>(`SELECT revisao FROM contrato_edicoes WHERE contrato_versao_id = $1`, [v2])).rows[0].revisao;
    const editarComercial = async () => {
      const fonte = (await rs.fontesPreparacao(v2, tx))!;
      const f = fonte.fechamento;
      return operar(v2, { acao: "editar_festa", revisao: await edicao(), motivo: "Ajuste comercial", fonteHash: fonte.fonteHash, pacoteId: f.pacoteId, convidados: f.convidados,
        dataEvento: f.dataEvento, configuracaoAgendaId: f.configuracaoAgendaId, horarioInicio: f.horarioInicio.slice(0, 5), horarioFim: f.horarioFim.slice(0, 5), adicionais: fonte.adicionais,
        idadeAniversarianteEvento: 6, temaFesta: "Formatura", buffetStatus: "PENDENTE", buffetSalgados: "", buffetBebidas: "", buffetDoces: "", buffetBolo: "", buffetOutros: "",
        observacoesEquipe: "PJ", comercial: { confirmarAprovacao: true, forma: "PIX_AVISTA", baseNegociada: null, condicaoPix: null } }, c.token, ctxOp(), c.empresa);
    };
    const preparacao = async () => (await rs.fontesPreparacao(v2, tx))!.revisaoOperacional;
    const aprovacoes = async (revisaoId: string) => (await a.query<{ n: number }>(`SELECT count(*)::int n FROM aprovacoes_negociacao WHERE fechamento_revisao_id = $1::uuid`, [revisaoId])).rows[0].n;
    const antes = await preparacao();
    const incompativel = (e: unknown) => (e as { code?: string }).code === "MODELO_INCOMPATIVEL_PJ" && JSON.stringify((e as { details?: unknown }).details).includes("contratante.cpf");

    // Alteração comercial: recusada antes de gravar (a preparação fica na mesma revisão, sem aprovação).
    await a.query("SAVEPOINT comercial");
    await assert.rejects(editarComercial(), incompativel);
    await a.query("ROLLBACK TO SAVEPOINT comercial");
    const depoisEdicao = await preparacao();
    assert.deepEqual([depoisEdicao.revisao, depoisEdicao.revisao_comercial_aprovada, await aprovacoes(antes.id)], [antes.revisao, antes.revisao_comercial_aprovada, 0]);

    // A própria aprovação da preparação (chamada também pela revisão do documento): recusada sem gravar.
    const consultas: string[] = [];
    const txContado = { query: (sql: string, v?: unknown[]) => { consultas.push(sql); return tx.query(sql, v as never); } } as typeof tx;
    await a.query("SAVEPOINT aprovar");
    await assert.rejects(rs.aprovarPreparacao(txContado, depoisEdicao, { usuarioId: c.usuario, empresaAutorizada: c.empresa, ...ctxOp() }, randomUUID()), incompativel);
    await a.query("ROLLBACK TO SAVEPOINT aprovar");
    assert.equal(consultas.filter((q) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(q)).length, 0, "nenhuma escrita antes da recusa");
    assert.equal(await aprovacoes(antes.id), 0);

    // Modelo compatível publicado: a mesma alteração comercial aprova a preparação.
    await a.query(`UPDATE modelos_contrato_empresa SET situacao = 'SUBSTITUIDO', substituido_em = now() WHERE empresa_id = $1::uuid AND situacao = 'ATIVO'`, [c.empresa]);
    await a.query(`INSERT INTO modelos_contrato_empresa (empresa_id, versao, conteudo, conteudo_sha256, aprovado_por) VALUES ($1::uuid, 2, $2::jsonb, $3, $4::uuid)`,
      [c.empresa, JSON.stringify(clausula("Contratante {{contratante.nome}}, {{contratante.tipo_documento}} {{contratante.documento}}.")), "c".repeat(64), c.usuario]);
    await editarComercial();
    await validarAgora(a);
    const aprovada = await preparacao();
    assert.equal(aprovada.revisao_comercial_aprovada, aprovada.revisao);
    assert.equal(await aprovacoes(aprovada.id), 1);
  });
});

test("sem a 112: plano recusa a PJ (MIGRACAO_PENDENTE) sem procurar CNPJ; integração PF segue e o cliente lido não ganha chave de PJ", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (com112) return t.skip("modelo com a 112");
  await emTx(async () => {
    const c = await cenario(a, 0);
    await catalogoNativo(a, c);
    const tx = executor(a);
    const procurados: Array<Record<string, unknown>> = [];
    const plano = await planejar(tx, c.empresa, porta(procurados), dadosDaImportacao(importacaoPj()));
    assert.deepEqual([plano.pronto, plano.tipoPessoa, plano.recusa?.codigo, plano.recusa?.motivo, plano.cnpj], [false, "PJ", "PJ_INDISPONIVEL", "MIGRACAO_PENDENTE", undefined]);
    assert.deepEqual([procurados[0].cpf, procurados[0].cnpj], [null, null]);
    const gravados: string[] = [];
    await assert.rejects(executarImportacao(tx, { ...entrada(c), plano: { ...plano, pronto: true } }, servicos(c, gravados)), (e) => e instanceof ImportacaoError && e.code === "PJ_INDISPONIVEL");
    assert.deepEqual(gravados, []);

    const s = carregar<Servico>("lib/contratos/integracao-importados/servico.ts");
    const { coreNativo } = carregar<typeof import("../../contratos/integracao-importados/composicao.ts")>("lib/contratos/integracao-importados/composicao.ts");
    const ev = { data: dia(61), inicio: "14:00", fim: "18:00" };
    const imp = await importacao(a, c, ev);
    await a.query(`UPDATE clientes SET cpf = $2 WHERE id = $1::uuid`, [imp.cliente, cpfValido()]);
    const opcoes = await s.opcoesIntegracao(tx, c.tenant as never, imp.id, dia(0));
    assert.equal(opcoes.cliente && "pessoaJuridica" in opcoes.cliente, false);
    const r = await integrar(s, coreNativo, a, c, imp.id, decisoes(c, ev, PARCIAL()));
    await validarAgora(a);
    const contratante = (await a.query(`SELECT v.snapshot -> 'contratante' c FROM contrato_versoes v WHERE v.contrato_id = $1::uuid ORDER BY v.numero_versao LIMIT 1`, [r.contratoId])).rows[0].c;
    assert.deepEqual(Object.keys(contratante).filter((k) => ["tipoPessoa", "cnpj", "razaoSocial", "nomeFantasia", "representante"].includes(k)), []);
  });
});
