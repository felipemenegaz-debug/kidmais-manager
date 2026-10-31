import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import type { DbExecutor } from "../db/contracts.ts";
import { cliente, cod, comercial, empresa, fechamento, porTransacao, vincular } from "../marketing/harness-postgres.ts";
import { assinarToken, hashDoToken, type AnelChaves } from "./token.ts";

/**
 * Apoio das suítes PostgreSQL da pesquisa de satisfação (110, PS-1). NÃO abre conexão: recebe o cliente da suíte, que
 * conectou pelo conector descartável. Fixtures 100% sintéticas e COMMITADAS (domínios .test, telefones 551198887xxxx).
 */
export type CriarEnvio = (tx: DbExecutor, anel: AnelChaves, e: { empresaId: string; execucaoId: string; canais: string[]; agendadaPara: Date; maxTentativas: number }) =>
  Promise<{ criado: boolean; envioId?: string; motivo?: string }>;

/**
 * Contrato ASSINADO mínimo do fechamento. A formalização real (documento revisado, aprovação comercial, liberação,
 * sessão administrativa, OTP consumido, Festa) é validada no COMMIT pelos gatilhos de contratos e nenhuma suíte a
 * commita por fora do domínio; a pesquisa só LÊ contratos.status e fechamentos.status. Por isso só ESTE INSERT roda com
 * session_replication_role = replica (precedente: lib/agenda/aplicador-100.postgres.test.ts), numa transação própria;
 * nada da 110 é gravado assim. As entradas reais de cancelamento (Festa e operarContrato) travam fechamento → contrato;
 * a prova com elas está em satisfacao-cancelamento.postgres.test.ts.
 */
export async function contratoAssinadoMinimo(db: Client, fechamentoId: string) {
  await db.query("SET LOCAL session_replication_role = replica");
  try {
    return (await db.query<{ id: string }>(`INSERT INTO contratos (fechamento_id, status, assinado_em, versao_atual) VALUES ($1::uuid, 'ASSINADO', now(), 1) RETURNING id::text AS id`, [fechamentoId])).rows[0].id;
  } finally {
    await db.query("SET LOCAL session_replication_role = origin");
  }
}

/**
 * Empresas A e B, a gestão de A, as regras (pesquisa e Mensagem simples) e os construtores de festa/envio. A identidade
 * (usuarios_administrativos) é criada pela PRÓPRIA suíte (guarda F1: no código da aplicação, só
 * lib/autenticacao/usuarios.ts cria identidade).
 */
export async function baseSintetica(c: Client, anel: AnelChaves, criarEnvio: CriarEnvio, criarIdentidade: (db: Client) => Promise<string>) {
  const emTransacao = porTransacao(c);
  const um = async (sql: string, v: unknown[] = []) => (await c.query(sql, v)).rows[0];
  const { A, B, usuario, baseA, baseB, regraA, regraMsgA } = await emTransacao(async () => {
    const A = await empresa(c, "Buffet Pesquisa A sintético"), B = await empresa(c, "Buffet Pesquisa B sintético");
    const usuario = await criarIdentidade(c);
    await vincular(c, A, usuario, "REPRESENTANTE_AUTORIZADO");
    const baseA = await comercial(c, A), baseB = await comercial(c, B);
    const regraA = (await um(`INSERT INTO marketing_automacao_regras (empresa_id, tipo, acao, espera_dias, canais, criado_por, atualizado_por)
      VALUES ($1::uuid, 'POS_FESTA', 'PESQUISA_SATISFACAO', 1, '{WHATSAPP,EMAIL}', $2::uuid, $2::uuid) RETURNING id::text AS id`, [A, usuario])).id as string;
    const regraMsgA = (await um(`INSERT INTO marketing_automacao_regras (empresa_id, tipo, acao, espera_dias, criado_por, atualizado_por)
      VALUES ($1::uuid, 'PROPOSTA_PARADA', 'MENSAGEM_WHATSAPP', 3, $2::uuid, $2::uuid) RETURNING id::text AS id`, [A, usuario])).id as string;
    return { A, B, usuario, baseA, baseB, regraA, regraMsgA };
  });

  let tel = 0, dia = 0;
  // Cada festa num dia próprio (a agenda recusa ocupação sobreposta no mesmo recurso).
  const dataUnica = () => new Date(Date.UTC(2026, 0, 1) + ++dia * 86_400_000).toISOString().slice(0, 10);

  /** Festa nova; com `clienteId`, do MESMO cliente (outra festa, outro envio); `telefone` fixa o número do cliente novo. */
  async function festa(opcoes: { empresaId?: string; assinado?: boolean; nome?: string; clienteId?: string; telefone?: string } = {}) {
    const e = opcoes.empresaId ?? A;
    const r = await emTransacao(async () => {
      const telefone = opcoes.clienteId
        ? (await um(`SELECT whatsapp FROM clientes WHERE id = $1::uuid`, [opcoes.clienteId])).whatsapp as string
        : opcoes.telefone ?? `55119888${String(70000 + ++tel).padStart(5, "0")}`;
      const cl = opcoes.clienteId ?? await cliente(c, e, opcoes.nome ?? "Mariana Souza Sintética", telefone, `${cod("c")}@pesquisa.test`);
      const f = await fechamento(c, e, e === A ? baseA : baseB, cl, { data: dataUnica(), status: "AGUARDANDO_PAGAMENTO" });
      return { cl, f, telefone };
    });
    // Em transação própria: a validação diferida enfileirada pelo INSERT do fechamento não pode ver o contrato.
    if (opcoes.assinado !== false) await emTransacao(() => contratoAssinadoMinimo(c, r.f));
    return r;
  }
  /** Fechamento a mais do mesmo cliente (sem contrato). */
  const outraFestaDoCliente = (cl: string) => emTransacao(() => fechamento(c, A, baseA, cl, { data: dataUnica(), status: "AGUARDANDO_CONTRATO" }));
  /** Atalho de FIXTURE (não é o protocolo de travas): contrato e fechamento cancelados na mesma transação. As entradas
   *  reais (Festa e operarContrato) são exercitadas em satisfacao-cancelamento.postgres.test.ts. */
  const cancelarFesta = (f: string) => emTransacao(async () => {
    await c.query(`UPDATE contratos SET status = 'CANCELADO', cancelado_em = clock_timestamp() WHERE fechamento_id = $1::uuid`, [f]);
    await c.query(`UPDATE fechamentos SET status = 'CANCELADO' WHERE id = $1::uuid`, [f]);
  });
  async function execucao(e: string, cl: string, f: string, acao = "PESQUISA_SATISFACAO", regra = acao === "PESQUISA_SATISFACAO" ? regraA : regraMsgA) {
    return (await um(`INSERT INTO marketing_automacao_execucoes (empresa_id, regra_id, regra_versao, acao, alvo_tipo, alvo_id, cliente_id, fechamento_id, chave_idempotencia, agendada_para, max_tentativas)
      VALUES ($1::uuid, $2::uuid, 1, $3, 'FECHAMENTO', $4::uuid, $5::uuid, $4::uuid, $6, clock_timestamp(), 3) RETURNING id::text AS id`, [e, regra, acao, f, cl, cod("chave-")])).id as string;
  }
  /** Festa assinada + execução + envio pelo serviço (dois canais). */
  async function envioPronto(opcoes: { nome?: string; clienteId?: string; telefone?: string } = {}) {
    const { cl, f, telefone } = await festa(opcoes);
    const x = await execucao(A, cl, f);
    const r = await emTransacao((tx) => criarEnvio(tx, anel, { empresaId: A, execucaoId: x, canais: ["WHATSAPP", "EMAIL"], agendadaPara: new Date(), maxTentativas: 3 }));
    if (!r.criado) throw new Error(`fixture: envio não criado (${r.motivo})`);
    return { cl, f, x, telefone, envio: r.envioId!, token: assinarToken(anel, r.envioId!, 1, anel.atual) };
  }
  /** Envio gravado direto com criação no passado, em dias (fração aceita: 29.5 = expira em 12 h). */
  async function envioNoPassado(diasAtras: number, opcoes: { clienteId?: string } = {}) {
    const { cl, f } = await festa(opcoes);
    const x = await execucao(A, cl, f);
    const id = randomUUID();
    const token = assinarToken(anel, id, 1, anel.atual);
    await emTransacao(async () => {
      await c.query(`INSERT INTO satisfacao_envios (id, empresa_id, fechamento_id, cliente_id, execucao_id, chave_versao, token_hash, criado_em, expira_em)
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, now() - $8::numeric * interval '1 day', now() - $8::numeric * interval '1 day' + interval '30 days')`,
        [id, A, f, cl, x, anel.atual, hashDoToken(token), diasAtras]);
      for (const canal of ["WHATSAPP", "EMAIL"]) {
        await c.query(`INSERT INTO satisfacao_entregas (empresa_id, envio_id, canal, etapa, agendada_para, max_tentativas) VALUES ($1::uuid, $2::uuid, $3, 'INICIAL', now(), 3)`, [A, id, canal]);
      }
    });
    return { cl, f, x, envio: id, token };
  }
  return { A, B, usuario, regraA, emTransacao, festa, outraFestaDoCliente, cancelarFesta, execucao, envioPronto, envioNoPassado };
}

/**
 * PS-2: regra de pesquisa ATIVA, revisada, com os dois modelos e janela o dia todo (ou a informada). Atalho de FIXTURE
 * (UPDATE direto, commitado); o caminho pelo serviço (salvar, revisar, ativar) é provado nas suítes de regras.
 */
export async function ativarRegraPesquisa(c: Client, regraId: string, extra: { canais?: string[]; janelaInicio?: string; janelaFim?: string; fimDeSemana?: boolean; limiteFrequenciaDias?: number } = {}) {
  await porTransacao(c)(async () => {
    await c.query(
      `UPDATE marketing_automacao_regras SET status = 'ATIVA', ativada_em = now(), pausada_em = NULL, canais = $2::text[], janela_inicio = $3::time, janela_fim = $4::time,
              fim_de_semana = $5, limite_frequencia_dias = $6, max_tentativas = 3,
              template_texto = 'Olá, {{nome}}! Como foi a festa no {{buffet}}? {{link_pesquisa}} Responda PARAR para não receber mais mensagens.',
              template_provedor = 'pesquisa_festa_v1', template_revisado_em = now(),
              template_lembrete_texto = 'Olá, {{nome}}! A pesquisa da festa no {{buffet}} fecha logo: {{link_pesquisa}} Responda PARAR para não receber mais mensagens.',
              template_lembrete_provedor = 'pesquisa_lembrete_v1'
        WHERE id = $1::uuid`,
      [regraId, extra.canais ?? ["WHATSAPP", "EMAIL"], extra.janelaInicio ?? "00:00", extra.janelaFim ?? "23:59", extra.fimDeSemana ?? true, extra.limiteFrequenciaDias ?? 30]);
  });
}
