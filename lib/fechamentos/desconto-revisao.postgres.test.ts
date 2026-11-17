import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import { regrasPagamentoInstaladas } from "../comercial/regras-pagamento.ts";
import { travarConfiguracaoAgenda } from "../agenda/trava-configuracao.ts";
import {
  ambienteAssinatura, assinarComoCliente, carregar, catalogoNativo, cenario, congelarEAssinarKidmais, cpfValido, dia, executor, id,
  poolNaTransacao, validarAgora, type Cenario,
} from "../../scripts/integracao-importados-test-support.ts";

/**
 * Astra r1 da D1 (16/11/2026) — o percentual de desconto da forma de pagamento vale no momento em que a condição nasce,
 * no PostgreSQL DESCARTÁVEL (modelo com a 077), pelos serviços reais. A configuração da empresa muda ENTRE a criação e a
 * revisão em todos os casos:
 * - edição administrativa (antes da assinatura): mesma forma mantém o percentual gravado e a aprovação calcula com ele
 *   (R$ 4.000 a 7% = R$ 3.720, não 3.600 do legado); condição antiga sem o campo continua legada; forma nova usa a regra vigente;
 * - revisão operacional (contrato assinado → nova versão): os mesmos três casos;
 * - fechamento público: percentual exibido diferente da regra vigente → 409 REGRAS_PAGAMENTO_MUDARAM com as regras atuais
 *   e nada gravado; exibido igual grava; sem o campo (outros chamadores) segue a regra vigente.
 * Astra r2: fechamento anterior à condição (condicao_pagamento nula, migration 012) com a mesma forma registrada mantém a
 * base integral nas duas revisões (0% explícito); o 409 é provado pela transação do próprio serviço, sem rollback manual.
 * Cada teste termina em ROLLBACK.
 */
let a: Client;
type Operar = Parameters<typeof congelarEAssinarKidmais>[1];
type Nativo = Awaited<ReturnType<typeof catalogoNativo>>;
type Condicao = { forma: string; descontoPercentual?: number; valores?: { descontoFormaPagamentoPercentual: number; valorFinalContrato: number } };
const ctxOp = () => ({ requestId: randomUUID(), ip: null, userAgent: "desconto-revisao" });
const endereco = `'11999998888', '11999998888', '01001000', 'Rua Sintética', '1', 'Centro', 'São Paulo', 'SP'`;

async function emTx(corpo: (c: Cenario, nativo: Nativo) => Promise<void>) {
  await a.query("BEGIN");
  const restaurarPool = poolNaTransacao(a);
  const restaurarAmbiente = ambienteAssinatura();
  try {
    const c = await cenario(a, 0);
    const nativo = await catalogoNativo(a, c);
    await modeloContrato(c);
    await corpo(c, nativo);
  } finally {
    await a.query("ROLLBACK");
    restaurarAmbiente();
    restaurarPool();
  }
}

async function modeloContrato(c: Cenario) {
  const conteudo = { titulo: "Contrato (TESTE)", contratada: { nome: "Buffet Teste Ltda", documento: "11.222.333/0001-81", endereco: "Rua Teste, 1", representante: "Pessoa Teste" },
    preambulo: [], clausulas: [{ titulo: "Objeto", texto: "Festa em {{festa.data}} para {{contratante.nome}}, {{valor.total}}, {{pagamento.condicao}}." }], observacoes: [], cidadeAssinatura: "Cidade Teste" };
  await a.query(`INSERT INTO modelos_contrato_empresa (empresa_id, versao, conteudo, conteudo_sha256, aprovado_por) VALUES ($1::uuid, 1, $2::jsonb, $3, $4::uuid)`,
    [c.empresa, JSON.stringify(conteudo), "a".repeat(64), c.usuario]);
}

/** Regra da empresa (077), como a tela de Descontos grava. */
async function regra(c: Cenario, avista: number, parcelado: number) {
  await a.query(`INSERT INTO empresa_regras_pagamento (empresa_id, pix_avista_percentual, pix_parcelado_percentual, cartao_rotulo, desconto_dia_util, motivo)
                 VALUES ($1::uuid, $2, $3, 'Cartão de crédito', false, 'Teste do desconto na revisão')
                 ON CONFLICT (empresa_id) DO UPDATE SET pix_avista_percentual = EXCLUDED.pix_avista_percentual,
                   pix_parcelado_percentual = EXCLUDED.pix_parcelado_percentual, atualizado_em = clock_timestamp()`, [c.empresa, avista, parcelado]);
}

const condicaoAvista = (percentual: number | null) => ({
  schemaVersao: 1, forma: "PIX_AVISTA", pretendida: null, aprovada: null, revisaoStatus: "DISPENSADA",
  ...(percentual === null ? {} : { descontoPercentual: percentual }),
});

/**
 * Festa aguardando contrato com forma Pix à vista: condição gravada com o percentual, legada sem ele (null) ou, como os
 * fechamentos anteriores à 012, sem condição nenhuma ("sem-condicao"); "sem-forma" = sem condição e sem forma registrada.
 */
type Gravado = number | null | "sem-condicao" | "sem-forma";
async function festa(c: Cenario, nativo: Nativo, data: string, percentual: Gravado) {
  const cpf = cpfValido();
  const cliente = await id(a, `INSERT INTO clientes (nome_completo, empresa_id, cpf, email, telefone, whatsapp, cep, logradouro, numero, bairro, cidade, uf)
      VALUES ('Cliente desconto', $1::uuid, $2, $3, ${endereco}) RETURNING id`, [c.empresa, cpf, `${randomUUID()}@example.invalid`]);
  const aniversariante = await id(a, `INSERT INTO aniversariantes (cliente_id, nome) VALUES ($1::uuid, 'Aniversariante desconto') RETURNING id`, [cliente]);
  // Fixture direta: a 114 exige a trava da configuração da agenda da empresa antes de gravar a ocupação.
  await travarConfiguracaoAgenda(executor(a), c.empresa, { modo: "COMPARTILHADA", linha: "KEY_SHARE" });
  const fechamento = await id(a, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
        categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, aniversariante_id, status,
        forma_pagamento_pretendida, condicao_pagamento)
      SELECT $1::date, '10:00', '22:00', $2::uuid, $3::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', 30, 30, 100, 100, 100, 'ATENDIMENTO_KIDMAIS', $5::uuid, $6::uuid, 'AGUARDANDO_CONTRATO',
        $8, $7::jsonb
        FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $4::uuid LIMIT 1 RETURNING fechamentos.id`,
    [data, nativo.turno, c.empresa, c.pacote, cliente, aniversariante, typeof percentual === "string" ? null : JSON.stringify(condicaoAvista(percentual)), percentual === "sem-forma" ? null : "PIX_AVISTA"]);
  return { fechamento, cpf };
}

const edicao = (c: Cenario, nativo: Nativo, data: string, comercial: object) => ({
  acao: "editar_festa", revisao: 1, motivo: "Ajuste comercial", fonteHash: "a".repeat(64), pacoteId: c.pacote, convidados: 30, dataEvento: data,
  configuracaoAgendaId: nativo.turno, horarioInicio: "10:00", horarioFim: "22:00", adicionais: [], idadeAniversarianteEvento: 6, temaFesta: "Circo",
  buffetStatus: "PENDENTE", buffetSalgados: "", buffetBebidas: "", buffetDoces: "", buffetBolo: "", buffetOutros: "", observacoesEquipe: "", comercial,
});
const AVISTA_4000 = { confirmarAprovacao: true, forma: "PIX_AVISTA", baseNegociada: 4000, condicaoPix: null };
const PARCELADO_4000 = { confirmarAprovacao: true, forma: "PIX_PARCELADO", baseNegociada: 4000, condicaoPix: { quantidadeParcelas: 2 } };

const condicaoDoFechamento = async (fechamento: string) =>
  (await a.query<{ c: Condicao }>(`SELECT condicao_pagamento c FROM fechamentos WHERE id = $1::uuid`, [fechamento])).rows[0].c;
/** Aprovação da forma (na mesma transação o criado_em empata; cada forma tem uma aprovação neste teste). */
const ultimaAprovacao = async (fechamento: string, forma = "PIX_AVISTA") =>
  (await a.query<{ c: Condicao }>(`SELECT condicao_pagamento c FROM aprovacoes_negociacao WHERE fechamento_id = $1::uuid AND condicao_pagamento->>'forma' = $2`, [fechamento, forma])).rows[0].c;

test.before(async () => {
  process.env.FESTA_ENABLED = "true";
  a = await conectarDescartavel();
});
test.after(async () => { if (a) await encerrarDescartavel(a); });

test("edição administrativa: mesma forma mantém o percentual gravado (aprovação 4.000 a 7% = 3.720); legado continua legado; forma nova usa a regra vigente", { timeout: 300_000 }, async (t) => {
  if (!(await regrasPagamentoInstaladas(executor(a)))) return t.skip("modelo sem a 077");
  await emTx(async (c, nativo) => {
    const ed = carregar<typeof import("./services/edicao-administrativa.service.ts")>("lib/fechamentos/services/edicao-administrativa.service.ts");
    const editar = (fechamento: string, data: string, comercial: object) =>
      ed.editarFechamentoAdministrativo(fechamento, edicao(c, nativo, data, comercial) as never, c.usuario, randomUUID(), executor(a));
    await regra(c, 7, 3);
    const D1 = dia(150), D2 = dia(151), D3 = dia(152);
    const gravada = await festa(c, nativo, D1, 7);
    const legada = await festa(c, nativo, D2, null);
    const semCondicao = await festa(c, nativo, D3, "sem-condicao");
    const D4 = dia(153), D5 = dia(154);
    const semCondicaoOutraForma = await festa(c, nativo, D4, "sem-condicao");
    const semForma = await festa(c, nativo, D5, "sem-forma");
    await regra(c, 12, 4); // a empresa muda a tela de Descontos depois que as condições nasceram

    await editar(gravada.fechamento, D1, AVISTA_4000);
    assert.equal((await condicaoDoFechamento(gravada.fechamento)).descontoPercentual, 7, "mesma forma: o percentual gravado fica");
    const aprovada = await ultimaAprovacao(gravada.fechamento);
    assert.equal(aprovada.descontoPercentual, 7);
    assert.deepEqual([aprovada.valores?.descontoFormaPagamentoPercentual, aprovada.valores?.valorFinalContrato], [7, 3720], "aprovação calcula com o percentual da condição");

    await editar(legada.fechamento, D2, AVISTA_4000);
    assert.equal("descontoPercentual" in (await condicaoDoFechamento(legada.fechamento)), false, "legado continua sem o campo");
    const aprovadaLegada = await ultimaAprovacao(legada.fechamento);
    assert.deepEqual([aprovadaLegada.valores?.descontoFormaPagamentoPercentual, aprovadaLegada.valores?.valorFinalContrato], [10, 3600], "legado: 10%");

    await editar(semCondicao.fechamento, D3, AVISTA_4000);
    assert.equal((await condicaoDoFechamento(semCondicao.fechamento)).descontoPercentual, 0, "sem condição anterior, mesma forma: 0% explícito");
    const aprovadaSem = await ultimaAprovacao(semCondicao.fechamento);
    assert.deepEqual([aprovadaSem.valores?.descontoFormaPagamentoPercentual, aprovadaSem.valores?.valorFinalContrato], [0, 4000], "base integral, sem a regra vigente (12%)");

    // Astra r3, P3: condição nula com forma anterior diferente ou nula → percentual vigente da forma escolhida.
    await editar(semCondicaoOutraForma.fechamento, D4, PARCELADO_4000);
    assert.deepEqual([(await condicaoDoFechamento(semCondicaoOutraForma.fechamento)).descontoPercentual,
      (await ultimaAprovacao(semCondicaoOutraForma.fechamento, "PIX_PARCELADO")).valores?.descontoFormaPagamentoPercentual], [4, 4], "sem condição, forma diferente: regra vigente");
    await editar(semForma.fechamento, D5, AVISTA_4000);
    const aprovadaSemForma = await ultimaAprovacao(semForma.fechamento);
    assert.deepEqual([(await condicaoDoFechamento(semForma.fechamento)).descontoPercentual, aprovadaSemForma.valores?.valorFinalContrato], [12, 3520], "sem condição nem forma: regra vigente");

    await editar(gravada.fechamento, D1, PARCELADO_4000);
    const trocada = await condicaoDoFechamento(gravada.fechamento);
    assert.deepEqual([trocada.forma, trocada.descontoPercentual], ["PIX_PARCELADO", 4], "forma nova: regra vigente");
    assert.equal((await ultimaAprovacao(gravada.fechamento, "PIX_PARCELADO")).valores?.descontoFormaPagamentoPercentual, 4);
  });
});

test("revisão operacional (contrato assinado): mesma forma mantém o percentual gravado; legado continua legado; forma nova usa a regra vigente", { timeout: 300_000 }, async (t) => {
  if (!(await regrasPagamentoInstaladas(executor(a)))) return t.skip("modelo sem a 077");
  await emTx(async (c, nativo) => {
    const adm = carregar<typeof import("../contratos/services/administrativo.service.ts")>("lib/contratos/services/administrativo.service.ts");
    const contratos = carregar<typeof import("../contratos/services/contrato.service.ts")>("lib/contratos/services/contrato.service.ts");
    const rs = carregar<typeof import("./services/revisao-operacional.service.ts")>("lib/fechamentos/services/revisao-operacional.service.ts");
    const repo = carregar<typeof import("./repositories/revisao.repository.ts")>("lib/fechamentos/repositories/revisao.repository.ts");
    const operar = adm.operarContrato as unknown as Operar;
    const assinada = async (data: string, percentual: Gravado) => {
      const { fechamento, cpf } = await festa(c, nativo, data, percentual);
      const gerado = await contratos.gerarContrato({ fechamentoId: fechamento } as never, { usuarioId: c.usuario, origem: "SISTEMA", executor: executor(a) } as never) as { contrato: { id: string }; versao: { id: string } };
      await congelarEAssinarKidmais(a, operar, gerado.versao.id, c.empresa, c.token, nativo.tokenRepresentante);
      await assinarComoCliente(gerado.contrato.id, cpf);
      await validarAgora(a);
      const vigente = (await a.query<{ v: string }>(`SELECT versao_vigente_id::text v FROM contrato_fluxos WHERE contrato_id = $1`, [gerado.contrato.id])).rows[0].v;
      await operar(vigente, { acao: "nova_versao", tipo: "NOVA_VERSAO", motivo: "Revisão comercial", chaveCriacao: randomUUID() }, c.token, ctxOp(), c.empresa);
      const v2 = (await a.query<{ id: string }>(`SELECT versao_em_preparacao_id::text id FROM contrato_fluxos WHERE contrato_id = $1`, [gerado.contrato.id])).rows[0].id;
      const editar = async (comercial: object) => {
        const fonte = (await rs.fontesPreparacao(v2, executor(a)))!;
        const revisao = (await a.query<{ revisao: number }>(`SELECT revisao FROM contrato_edicoes WHERE contrato_versao_id = $1`, [v2])).rows[0].revisao;
        await operar(v2, { ...edicao(c, nativo, data, comercial), revisao, fonteHash: fonte.fonteHash, adicionais: fonte.adicionais }, c.token, ctxOp(), c.empresa);
        return (await repo.buscarRevisaoDaVersao(v2, executor(a)))!.operacao.condicaoPagamento as unknown as Condicao;
      };
      return { editar };
    };
    await regra(c, 7, 3);
    const gravada = await assinada(dia(160), 7);
    const legada = await assinada(dia(161), null);
    const semCondicao = await assinada(dia(162), "sem-condicao");
    const semCondicaoOutraForma = await assinada(dia(163), "sem-condicao");
    const semForma = await assinada(dia(164), "sem-forma");
    await regra(c, 12, 4);

    const mesma = await gravada.editar(AVISTA_4000);
    assert.deepEqual([mesma.forma, mesma.descontoPercentual], ["PIX_AVISTA", 7], "mesma forma: o percentual gravado fica");
    const legadaMesma = await legada.editar(AVISTA_4000);
    assert.equal("descontoPercentual" in legadaMesma, false, "legado continua sem o campo");
    const semCondicaoMesma = await semCondicao.editar(AVISTA_4000);
    assert.deepEqual([semCondicaoMesma.forma, semCondicaoMesma.descontoPercentual], ["PIX_AVISTA", 0], "sem condição anterior, mesma forma: 0% explícito (base integral)");
    // Astra r3, P3: condição nula com forma anterior diferente ou nula → percentual vigente da forma escolhida.
    const semCondicaoTrocada = await semCondicaoOutraForma.editar(PARCELADO_4000);
    assert.deepEqual([semCondicaoTrocada.forma, semCondicaoTrocada.descontoPercentual], ["PIX_PARCELADO", 4], "sem condição, forma diferente: regra vigente");
    const semFormaRevista = await semForma.editar(AVISTA_4000);
    assert.deepEqual([semFormaRevista.forma, semFormaRevista.descontoPercentual], ["PIX_AVISTA", 12], "sem condição nem forma: regra vigente");
    const nova = await gravada.editar(PARCELADO_4000);
    assert.deepEqual([nova.forma, nova.descontoPercentual], ["PIX_PARCELADO", 4], "forma nova: regra vigente");
  });
});

test("fechamento público: percentual exibido diferente da regra vigente → 409 com as regras atuais, nada gravado; igual grava; sem o campo segue a vigente", { timeout: 300_000 }, async (t) => {
  if (!(await regrasPagamentoInstaladas(executor(a)))) return t.skip("modelo sem a 077");
  await emTx(async (c, nativo) => {
    const publico = carregar<typeof import("./services/fechamento-publico.service.ts")>("lib/fechamentos/services/fechamento-publico.service.ts");
    const identidade = carregar<typeof import("../identidade/services/index.ts")>("lib/identidade/services/index.ts");
    const cpf = cpfValido();
    const cliente = await id(a, `INSERT INTO clientes (nome_completo, cpf, empresa_id, email, ${"telefone, whatsapp, cep, logradouro, numero, bairro, cidade, uf"})
       VALUES ('Pessoa Física Sintética', $1, $2::uuid, $3, ${endereco}) RETURNING id`, [cpf, c.empresa, `${randomUUID()}@example.invalid`]);
    const prova = async () => {
      let codigo = "";
      const servico = identidade.criarIdentityServiceComAmbiente((async (x: { codigo: string }) => { codigo = x.codigo; }) as never);
      const desafio = await servico.iniciarDesafio({ cpf, canal: "WHATSAPP", escopo: { empresaId: c.empresa, incluirLegadoSemEmpresa: false } } as never, executor(a));
      return (await servico.confirmarCodigo({ validacaoId: desafio.validacaoId, codigo }, executor(a))).provaToken;
    };
    // Sem customDb: a transação é a do próprio serviço (withTransaction pelo pool redirecionado a savepoint), como na rota.
    const criar = async (data: string, exibido: number | undefined) => publico.criarFechamentoPublicoComIdentidade({
      dataEvento: data, horarioInicio: "10:00", horarioFim: "22:00", configuracaoAgendaId: nativo.turno, pacoteId: c.pacote,
      convidados: 30, adicionais: [], valorProposto: 100, formaPagamentoPretendida: "PIX_AVISTA", buffetStatus: "PENDENTE", empresaEsperada: c.empresa,
      ...(exibido === undefined ? {} : { descontoFormaPagamentoExibido: exibido }),
      identidade: { tipo: "CLIENTE_EXISTENTE", provaToken: await prova(), atualizarCadastro: false },
      cliente: { nomeCompleto: "Pessoa Física Sintética", cpf, telefone: "11999998888", whatsapp: "11999998888", email: `${randomUUID()}@example.invalid`,
        cep: "01001000", logradouro: "Rua Sintética", numero: "1", complemento: null, bairro: "Centro", cidade: "São Paulo", uf: "SP" },
      aniversariante: { nome: `Aniversariante ${data}`, temaPadrao: null }, cpfSemRevelarCadastro: true,
    } as never);
    const fechamentosDaEmpresa = async () => Number((await a.query(`SELECT count(*)::int n FROM fechamentos WHERE empresa_id = $1::uuid`, [c.empresa])).rows[0].n);
    const aniversariantes = async () => Number((await a.query(`SELECT count(*)::int n FROM aniversariantes WHERE cliente_id = $1::uuid`, [cliente])).rows[0].n);
    const aprovacoes = async () => Number((await a.query(`SELECT count(*)::int n FROM aprovacoes_negociacao`)).rows[0].n);
    const contagens = async () => [await fechamentosDaEmpresa(), await aniversariantes(), await aprovacoes()];

    await regra(c, 12, 4); // a tela carregou com 7%; a empresa mudou para 12% antes do envio
    const antes = await contagens();
    await assert.rejects(criar(dia(170), 7), (e: { code?: string; httpStatus?: number; details?: { pagamento?: { pixAvistaPercentual?: number }; exibido?: number; vigente?: number } }) => {
      assert.deepEqual([e.code, e.httpStatus, e.details?.exibido, e.details?.vigente, e.details?.pagamento?.pixAvistaPercentual], ["REGRAS_PAGAMENTO_MUDARAM", 409, 7, 12, 12]);
      return true;
    });
    assert.deepEqual(await contagens(), antes, "nada gravado: fechamento, aniversariante e aprovação (sem rollback manual)");

    const confirmado = await criar(dia(170), 12);
    assert.equal(await aniversariantes(), antes[1] + 1, "o envio confirmado grava (a contagem enxerga escrita)");
    assert.equal((await condicaoDoFechamento(confirmado.fechamento.id)).descontoPercentual, 12, "reconfirmado: grava o exibido");
    const semCampo = await criar(dia(171), undefined);
    assert.equal((await condicaoDoFechamento(semCampo.fechamento.id)).descontoPercentual, 12, "sem o campo: regra vigente");
  });
});
