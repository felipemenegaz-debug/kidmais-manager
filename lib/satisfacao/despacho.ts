import { randomUUID } from "node:crypto";
import type { DbExecutor } from "../db/contracts.ts";
import { origemPublica } from "../acessos/email.ts";
import { mascararEmail } from "../acessos/validacao.ts";
import { nomePublicoDaEmpresa } from "../perfil/nome-publico.ts";
import { contatoPublicoDaEmpresa } from "../perfil/contato-publico.ts";
import { empresaApta } from "../marketing/automacoes/aptidao.ts";
import { frequenciaExcedida } from "../marketing/automacoes/frequencia.ts";
import { dentroDaJanela, proximoHorarioPermitido, type Janela } from "../marketing/automacoes/janela.ts";
import { mascararTelefone, primeiroNome, renderizarModelo } from "../marketing/automacoes/modelo.ts";
import { elegivelParaMensagem, lerDescadastro } from "../marketing/automacoes/preferencias.ts";
import { COLUNAS, mapearRegra, type Regra } from "../marketing/automacoes/regras.ts";
import { automacoesHabilitadas, FalhaTransporte } from "../marketing/automacoes/transporte.ts";
import { linkDoEnvio } from "./envios.ts";
import { linkDaPesquisa, MARCADOR_LINK } from "./fragmento.ts";
import { lerAnel, type AnelChaves } from "./token.ts";
import { comRepeticao, travarPais, TravaOcupada, type Repeticao } from "./travas.ts";
import { emailValido, transportesDoAmbiente, type TransportesPesquisa } from "./transporte.ts";

/**
 * Despacho das entregas da pesquisa (plano R3/R4/R6/R9, PS-2). Uma entrega = um canal × uma etapa (INICIAL ou LEMBRETE).
 * Protocolo igual ao do motor do Marketing: a entrega vai a ENVIANDO (com posse e início da tentativa) e isso é
 * CONFIRMADO antes da rede; resposta → ACEITA; sem resposta → INCERTA (nunca reenviada sozinha); recusa → FALHOU;
 * indisponibilidade confirmada → PENDENTE com espera, até o máximo de tentativas.
 *
 * Ordem de travas comum às três transações do despacho (preparar, concluir, recuperar posse): trava por cliente →
 * cliente FOR SHARE → envio FOR UPDATE → entrega FOR UPDATE (→ pais NOWAIT, só no preparo). O cliente FOR SHARE segura,
 * até ENVIANDO ser confirmado, o cadastro lido na revalidação: a revogação de autorização e o descadastro
 * (alterarPreferencia: cliente FOR UPDATE → entregas) e a edição do cadastro esperam o despacho, ou o despacho espera
 * por eles e relê o que confirmaram (Astra PS-2 P2-1). O relógio é lido em cada tentativa DEPOIS das travas (P2-2).
 *
 * Toda tentativa REVALIDA: envio ATIVO e dentro do prazo, festa e contrato, regra ATIVA com a mesma ação e o canal, aptidão da
 * empresa, janela, descadastro, saída das pesquisas e o consentimento DO CANAL (WhatsApp: elegivelParaMensagem —
 * autorização confirmada do destino atual e PARAR do atendimento; e-mail: cliente ativo com e-mail válido) e, na
 * INICIAL, a frequência (fora o próprio envio). Assim um PARAR, um descadastro ou uma saída posteriores à criação da
 * pesquisa — ou mesmo anteriores, com a entrega criada depois — bloqueiam o envio no momento de enviar.
 */
export type ContextoPesquisa = {
  /** SATISFACAO_PESQUISA_ENABLED e MARKETING_AUTOMACOES_ENABLED ligadas. */
  habilitada: boolean;
  anel: AnelChaves | null;
  origem: string | null;
  transportes: TransportesPesquisa;
  repeticao?: Repeticao;
  /** Relógio de cada tentativa (padrão: o do processo). Lido depois das travas, nunca o instante do início do ciclo. */
  relogio?: () => Date;
};

export function contextoPesquisaDoAmbiente(conexao: () => DbExecutor, env: { [nome: string]: string | undefined } = process.env): ContextoPesquisa {
  let origem: string | null = null;
  try { origem = origemPublica({ ADMIN_AUTH_ORIGIN: env.ADMIN_AUTH_ORIGIN, NODE_ENV: env.NODE_ENV }) || null; } catch { origem = null; }
  return {
    // Mesmo critério de pesquisaLigada (http.ts), sem importar next/server no worker.
    habilitada: env.SATISFACAO_PESQUISA_ENABLED === "true" && automacoesHabilitadas(env),
    anel: lerAnel(env),
    origem,
    transportes: transportesDoAmbiente(conexao, env),
  };
}

type Banco = { transacao<T>(work: (tx: DbExecutor) => Promise<T>): Promise<T> };

type EnvioTravado = {
  id: string; empresa_id: string; fechamento_id: string; cliente_id: string; execucao_id: string; estado: string; motivo_revogacao: string | null;
  vencido: boolean; prazo_esgotado: boolean; contato_em: string | null; expira_em: string;
};
type EntregaTravada = {
  id: string; empresa_id: string; envio_id: string; canal: "WHATSAPP" | "EMAIL"; etapa: "INICIAL" | "LEMBRETE"; estado: string; tentativas: number; max_tentativas: number;
  agendada_ms: string; proxima_ms: string | null; segundo_canal_fora: boolean;
};

/** Trava por cliente e o cliente FOR SHARE: o começo comum das transações do despacho. */
async function travarCliente(tx: DbExecutor, empresaId: string, clienteId: string, marcador: string) {
  await tx.query(`/* satisfacao:${marcador} */ SELECT pg_advisory_xact_lock(hashtext('marketing:' || $1 || ':' || $2))`, [empresaId, clienteId]);
  await tx.query(`/* satisfacao:travar-cliente */ SELECT 1 FROM clientes WHERE id = $1::uuid AND empresa_id = $2::uuid FOR SHARE`, [clienteId, empresaId]);
}

type Preparo =
  | { tipo: "PRONTA"; estado: string }
  | {
    tipo: "ENVIAR"; entrega: EntregaTravada; envio: EnvioTravado; regra: Regra; posse: string; tentativa: number;
    whatsapp?: { telefone: string; templateProvedor: string; texto: string; textoGravavel: string };
    email?: { para: string; nomeRemetente: string; replyTo: string | null; assunto: string; html: string; texto: string; textoGravavel: string };
  };

const ESTADOS_DO_ENVIO: Record<string, { estado: "CANCELADA" | "SUPRIMIDA"; motivo: string }> = {
  RESPONDIDO: { estado: "CANCELADA", motivo: "PESQUISA_RESPONDIDA" },
  EXPIRADO: { estado: "SUPRIMIDA", motivo: "PRAZO_ESGOTADO" },
};

function janelaDe(r: Regra): Janela { return { inicio: r.janelaInicio, fim: r.janelaFim, fuso: r.fuso, fimDeSemana: r.fimDeSemana }; }

async function encerrar(tx: DbExecutor, entregaId: string, estado: "SUPRIMIDA" | "CANCELADA", motivo: string): Promise<Preparo> {
  await tx.query(`UPDATE satisfacao_entregas SET estado = $2, motivo = $3, concluida_em = clock_timestamp(), proxima_tentativa_em = NULL WHERE id = $1::uuid`,
    [entregaId, estado, motivo.slice(0, 300)]);
  return { tipo: "PRONTA", estado };
}

async function adiar(tx: DbExecutor, entregaId: string, motivo: string, minutos = 15): Promise<Preparo> {
  await tx.query(`UPDATE satisfacao_entregas SET proxima_tentativa_em = clock_timestamp() + make_interval(mins => $3::int), motivo = $2 WHERE id = $1::uuid`,
    [entregaId, motivo.slice(0, 300), minutos]);
  return { tipo: "PRONTA", estado: "ADIADA" };
}

/** Envio que deixou de valer: o estado do envio muda e TODAS as entregas pendentes dele terminam com o mesmo motivo. */
async function encerrarEnvio(tx: DbExecutor, envioId: string, como: "EXPIRADO" | "REVOGADO", motivo: string) {
  if (como === "EXPIRADO") await tx.query(`UPDATE satisfacao_envios SET estado = 'EXPIRADO', expirado_em = clock_timestamp() WHERE id = $1::uuid AND estado = 'ATIVO'`, [envioId]);
  else await tx.query(`UPDATE satisfacao_envios SET estado = 'REVOGADO', revogado_em = clock_timestamp(), motivo_revogacao = $2 WHERE id = $1::uuid AND estado = 'ATIVO'`, [envioId, motivo]);
  await tx.query(`UPDATE satisfacao_entregas SET estado = 'CANCELADA', motivo = $2, concluida_em = clock_timestamp() WHERE envio_id = $1::uuid AND estado = 'PENDENTE'`,
    [envioId, como === "EXPIRADO" ? "EXPIRADO" : motivo]);
}

function escaparHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * E-mail da pesquisa (texto do sistema, não o modelo da regra): assunto fixo, 11 links pré-marcados (#token.n0 … .n10) e
 * o link sem nota. Duas versões: a real (com os links, só para o transporte) e a gravável (marcador no lugar dos links).
 */
export function montarEmail(v: { nome: string; buffet: string; dataFesta: string | null; etapa: "INICIAL" | "LEMBRETE"; link: (nota?: number) => string }) {
  const data = v.dataFesta ? ` em ${v.dataFesta.split("-").reverse().join("/")}` : "";
  const abertura = v.etapa === "LEMBRETE"
    ? `Olá, ${primeiroNome(v.nome)}! Ainda dá tempo de contar como foi a festa no ${v.buffet}${data}.`
    : `Olá, ${primeiroNome(v.nome)}! Obrigado por comemorar com o ${v.buffet}${data}. Queremos saber como foi: são poucas perguntas.`;
  const pergunta = `De 0 a 10, quanto você indicaria o ${v.buffet} a um amigo?`;
  const rodape = "Se preferir não receber mais pesquisas, use a opção no fim da página da pesquisa.";
  const texto = (link: (nota?: number) => string) => [abertura, "", pergunta, link(), "", rodape].join("\n");
  const html = (link: (nota?: number) => string) => [
    `<p>${escaparHtml(abertura)}</p>`,
    `<p>${escaparHtml(pergunta)}</p>`,
    `<p>${Array.from({ length: 11 }, (_, n) => `<a href="${escaparHtml(link(n))}">${n}</a>`).join(" ")}</p>`,
    `<p><a href="${escaparHtml(link())}">Abrir a pesquisa</a></p>`,
    `<p style="color:#666;font-size:12px">${escaparHtml(rodape)}</p>`,
  ].join("\n");
  return {
    assunto: `Como foi a festa no ${v.buffet}?`.slice(0, 200),
    texto: texto(v.link),
    html: html(v.link),
    textoGravavel: texto(() => MARCADOR_LINK),
  };
}

/** Fase 1: revalida tudo e, se puder enviar, confirma ENVIANDO antes da rede. Repetida inteira em 55P03 (pais NOWAIT). */
async function preparar(tx: DbExecutor, ctx: ContextoPesquisa, entregaId: string, relogio: () => Date): Promise<Preparo> {
  const dono = (await tx.query<{ empresa_id: string; cliente_id: string; envio_id: string }>(
    `SELECT d.empresa_id::text, e.cliente_id::text, d.envio_id::text FROM satisfacao_entregas d JOIN satisfacao_envios e ON e.id = d.envio_id WHERE d.id = $1::uuid`,
    [entregaId])).rows[0];
  if (!dono) return { tipo: "PRONTA", estado: "IGNORADA" };
  // Ordem de travas (cabeçalho): trava por cliente → cliente FOR SHARE → envio FOR UPDATE → entrega → pais NOWAIT.
  await travarCliente(tx, dono.empresa_id, dono.cliente_id, "preparar");
  const envio = (await tx.query<EnvioTravado>(
    `/* satisfacao:travar-envio */ SELECT id::text, empresa_id::text, fechamento_id::text, cliente_id::text, execucao_id::text, estado, motivo_revogacao,
            expira_em <= clock_timestamp() AS vencido, clock_timestamp() > expira_em - interval '24 hours' AS prazo_esgotado, contato_em::text, expira_em::text
       FROM satisfacao_envios WHERE id = $1::uuid FOR UPDATE`, [dono.envio_id])).rows[0]!;
  const entrega = (await tx.query<EntregaTravada>(
    `SELECT d.id::text, d.empresa_id::text, d.envio_id::text, d.canal, d.etapa, d.estado, d.tentativas, d.max_tentativas,
            (extract(epoch FROM d.agendada_para) * 1000)::bigint::text AS agendada_ms, (extract(epoch FROM d.proxima_tentativa_em) * 1000)::bigint::text AS proxima_ms,
            d.etapa = 'INICIAL' AND e.contato_em IS NOT NULL AND clock_timestamp() > e.contato_em + interval '48 hours' AS segundo_canal_fora
       FROM satisfacao_entregas d JOIN satisfacao_envios e ON e.id = d.envio_id WHERE d.id = $1::uuid FOR UPDATE OF d`, [entregaId])).rows[0]!;
  // O instante desta tentativa: lido depois das esperas pelas travas (e de novo a cada repetição).
  const agora = relogio();
  const devida = Number(entrega.agendada_ms) <= agora.getTime() && (entrega.proxima_ms === null || Number(entrega.proxima_ms) <= agora.getTime());
  // Outro worker já pegou, concluiu ou adiou: nada a fazer.
  if (entrega.estado !== "PENDENTE" || !devida) return { tipo: "PRONTA", estado: "IGNORADA" };

  // 1. Envio: só ATIVO e dentro da validade.
  if (envio.estado === "REVOGADO") return encerrar(tx, entrega.id, "CANCELADA", envio.motivo_revogacao ?? "REVOGADO");
  if (envio.estado !== "ATIVO") { const f = ESTADOS_DO_ENVIO[envio.estado]!; return encerrar(tx, entrega.id, f.estado, f.motivo); }
  if (envio.vencido) { await encerrarEnvio(tx, envio.id, "EXPIRADO", "EXPIRADO"); return { tipo: "PRONTA", estado: "CANCELADA" }; }
  // 2. Festa e contrato (pais NOWAIT: 55P03 sobe e a transação inteira é repetida).
  const festa = await travarPais(tx, envio.fechamento_id);
  if (!festa.valida) { await encerrarEnvio(tx, envio.id, "REVOGADO", festa.motivo!); return { tipo: "PRONTA", estado: "CANCELADA" }; }
  // 3. Regra da execução que criou a pesquisa: ATIVA, ainda com a pesquisa e com este canal.
  const regraLinha = (await tx.query<Parameters<typeof mapearRegra>[0]>(
    `SELECT ${COLUNAS} FROM marketing_automacao_regras WHERE id = (SELECT regra_id FROM marketing_automacao_execucoes WHERE id = $1::uuid) AND empresa_id = $2::uuid`,
    [envio.execucao_id, envio.empresa_id])).rows[0];
  const regra = regraLinha ? mapearRegra(regraLinha) : null;
  if (!regra || regra.status !== "ATIVA") return encerrar(tx, entrega.id, "SUPRIMIDA", "REGRA_PAUSADA");
  if (regra.acao !== "PESQUISA_SATISFACAO") return encerrar(tx, entrega.id, "SUPRIMIDA", "ACAO_ALTERADA");
  if (!regra.canais.includes(entrega.canal)) return encerrar(tx, entrega.id, "SUPRIMIDA", "CANAL_REMOVIDO");
  // 4. Aptidão comercial da empresa agora (leitura que falhou: adia sem consumir tentativa).
  const aptidao = await empresaApta(tx, envio.empresa_id);
  if (!aptidao.apta && aptidao.definitivo) return encerrar(tx, entrega.id, "SUPRIMIDA", `EMPRESA_INAPTA: ${aptidao.motivo}`);
  if (!aptidao.apta) return adiar(tx, entrega.id, aptidao.motivo);
  // 5. Prazos: nada sai a menos de 24 h do fim do link; o segundo canal da INICIAL só até 48 h depois do contato.
  if (envio.prazo_esgotado) return encerrar(tx, entrega.id, "SUPRIMIDA", "PRAZO_ESGOTADO");
  if (entrega.segundo_canal_fora) return encerrar(tx, entrega.id, "SUPRIMIDA", "SEGUNDO_CANAL_FORA_DO_PRAZO");
  // 6. Janela da regra: fora dela, a entrega vai para a próxima abertura — ou é suprimida se isso passar do prazo.
  if (!dentroDaJanela(agora, janelaDe(regra))) {
    const proxima = proximoHorarioPermitido(agora, janelaDe(regra));
    if (proxima.getTime() > new Date(envio.expira_em).getTime() - 24 * 3600_000) return encerrar(tx, entrega.id, "SUPRIMIDA", "PRAZO_ESGOTADO");
    await tx.query(`UPDATE satisfacao_entregas SET agendada_para = $2::timestamptz, proxima_tentativa_em = NULL WHERE id = $1::uuid`, [entrega.id, proxima.toISOString()]);
    return { tipo: "PRONTA", estado: "REAGENDADA" };
  }
  // 7. Consentimento: descadastro e saída das pesquisas valem para os dois canais; depois, o de cada canal.
  if ((await lerDescadastro(tx, envio.empresa_id, envio.cliente_id)).descadastradoEm) return encerrar(tx, entrega.id, "SUPRIMIDA", "DESCADASTRADO");
  const saida = await tx.query(`SELECT 1 FROM satisfacao_saidas WHERE empresa_id = $1::uuid AND cliente_id = $2::uuid`, [envio.empresa_id, envio.cliente_id]);
  if (saida.rows.length > 0) return encerrar(tx, entrega.id, "SUPRIMIDA", "SAIDA_PESQUISAS");
  const cliente = (await tx.query<{ nome_completo: string; email: string | null; status: string; data_festa: string | null }>(
    `SELECT c.nome_completo, c.email, c.status, f.data_evento::text AS data_festa
       FROM clientes c JOIN fechamentos f ON f.id = $3::uuid WHERE c.id = $1::uuid AND c.empresa_id = $2::uuid`,
    [envio.cliente_id, envio.empresa_id, envio.fechamento_id])).rows[0];
  if (!cliente || cliente.status !== "ATIVO") return encerrar(tx, entrega.id, "SUPRIMIDA", "CLIENTE_INATIVO");
  let telefone: string | null = null;
  if (entrega.canal === "WHATSAPP") {
    const elegivel = await elegivelParaMensagem(tx, envio.empresa_id, envio.cliente_id);
    if (!elegivel.ok) return encerrar(tx, entrega.id, "SUPRIMIDA", elegivel.motivo);
    telefone = elegivel.telefone;
  } else if (!emailValido(cliente.email?.trim())) {
    return encerrar(tx, entrega.id, "SUPRIMIDA", "SEM_EMAIL");
  }
  // 8. Frequência só na INICIAL (o lembrete único do mesmo envio é a exceção do plano R6); o próprio envio não conta.
  if (entrega.etapa === "INICIAL" && (await frequenciaExcedida(tx, envio.empresa_id, envio.cliente_id, regra.limiteFrequenciaDias, null, envio.id))) {
    return encerrar(tx, entrega.id, "SUPRIMIDA", "LIMITE_FREQUENCIA");
  }
  // 9. Modelo do WhatsApp revisado (texto e modelo do provedor da etapa).
  const textoModelo = entrega.etapa === "INICIAL" ? regra.templateTexto : regra.templateLembreteTexto;
  const provedor = entrega.etapa === "INICIAL" ? regra.templateProvedor : regra.templateLembreteProvedor;
  if (entrega.canal === "WHATSAPP" && (!regra.templateRevisadoEm || !textoModelo || !provedor)) return encerrar(tx, entrega.id, "SUPRIMIDA", "MODELO_NAO_REVISADO");
  // 10. Link: sem segredo ou origem a entrega espera (não consome tentativa nem é suprimida).
  if (!ctx.anel || !ctx.origem) return adiar(tx, entrega.id, "LINK_NAO_CONFIGURADO");
  const link = await linkDoEnvio(tx, ctx.anel, envio.id);
  if (!link) return encerrar(tx, entrega.id, "CANCELADA", "ENVIO_INDISPONIVEL");
  const origem = ctx.origem;
  const linkCom = (nota?: number) => linkDaPesquisa(origem, link.token, nota);

  const buffet = (await nomePublicoDaEmpresa(tx, envio.empresa_id)) ?? "buffet";
  const valores = { nome: cliente.nome_completo, buffet, dataFesta: cliente.data_festa };
  const posse = randomUUID();
  const tentativa = entrega.tentativas + 1;
  let preparo: Extract<Preparo, { tipo: "ENVIAR" }>;
  let gravavel: string;
  let destinatario: string;
  if (entrega.canal === "WHATSAPP") {
    const texto = renderizarModelo(textoModelo!, { ...valores, linkPesquisa: linkCom() });
    gravavel = renderizarModelo(textoModelo!, { ...valores, linkPesquisa: MARCADOR_LINK });
    destinatario = mascararTelefone(telefone);
    preparo = { tipo: "ENVIAR", entrega, envio, regra, posse, tentativa, whatsapp: { telefone: telefone!, templateProvedor: provedor!, texto, textoGravavel: gravavel } };
  } else {
    const para = cliente.email!.trim();
    const m = montarEmail({ ...valores, etapa: entrega.etapa, link: linkCom });
    const contato = await contatoPublicoDaEmpresa(tx, envio.empresa_id);
    gravavel = m.textoGravavel;
    destinatario = mascararEmail(para);
    preparo = {
      tipo: "ENVIAR", entrega, envio, regra, posse, tentativa,
      email: { para, nomeRemetente: buffet, replyTo: emailValido(contato?.email) ? contato!.email! : null, assunto: m.assunto, html: m.html, texto: m.texto, textoGravavel: gravavel },
    };
  }
  // ENVIANDO confirmado ANTES da rede (o gatilho da 110 reconfere envio ATIVO e os prazos com o relógio do banco).
  await tx.query(
    `UPDATE satisfacao_entregas SET estado = 'ENVIANDO', posse_token = $2::uuid, posse_ate = clock_timestamp() + interval '5 minutes',
            tentativa_iniciada_em = clock_timestamp(), destinatario_mascarado = $3, conteudo = $4, motivo = NULL, proxima_tentativa_em = NULL
      WHERE id = $1::uuid`,
    [entrega.id, posse, destinatario, gravavel.slice(0, 4000)]);
  return preparo;
}

type Resultado = { ok: true; provedorMensagemId: string } | { ok: false; tipo: "RECUSADO" | "TEMPORARIO" | "DESCONHECIDO"; mensagem: string };

/** Fase 2: resultado do transporte, com a mesma ordem de travas; posse perdida (recuperada como INCERTA) não muda nada. */
async function concluirTentativa(tx: DbExecutor, p: Extract<Preparo, { tipo: "ENVIAR" }>, resultado: Resultado, relogio: () => Date): Promise<string> {
  await travarCliente(tx, p.envio.empresa_id, p.envio.cliente_id, "concluir");
  const envio = (await tx.query<{ estado: string }>(`SELECT estado FROM satisfacao_envios WHERE id = $1::uuid FOR UPDATE`, [p.envio.id])).rows[0]!;
  const linha = (await tx.query<{ estado: string; posse_token: string | null; tentativas: number; max_tentativas: number }>(
    `SELECT estado, posse_token::text, tentativas, max_tentativas FROM satisfacao_entregas WHERE id = $1::uuid FOR UPDATE`, [p.entrega.id])).rows[0];
  if (!linha || linha.estado !== "ENVIANDO" || linha.posse_token !== p.posse) return "POSSE_PERDIDA";
  const tentativas = linha.tentativas + 1;
  if (resultado.ok) {
    await tx.query(`UPDATE satisfacao_entregas SET estado = 'ACEITA', provedor_mensagem_id = $2, tentativas = $3, posse_token = NULL, posse_ate = NULL, motivo = NULL
      WHERE id = $1::uuid`, [p.entrega.id, resultado.provedorMensagemId, tentativas]);
    // Lembrete (plano R6): um por canal, só no canal cuja INICIAL foi aceita, no MESMO horário para os dois canais — 3 dias
    // depois do PRIMEIRO aceite, na próxima abertura da janela. O aceite é o instante desta conclusão (relógio lido aqui,
    // depois das travas), não o do preparo nem o do ciclo; o segundo canal herda o horário do primeiro lembrete.
    // UNIQUE (envio, canal, etapa) + DO NOTHING: repetição não duplica.
    if (p.entrega.etapa === "INICIAL" && envio.estado === "ATIVO") {
      const aceite = relogio();
      const calculado = proximoHorarioPermitido(new Date(aceite.getTime() + 3 * 24 * 3600_000), janelaDe(p.regra));
      await tx.query(
        `INSERT INTO satisfacao_entregas (empresa_id, envio_id, canal, etapa, agendada_para, max_tentativas)
         SELECT d.empresa_id, d.envio_id, d.canal, 'LEMBRETE',
                COALESCE((SELECT min(l.agendada_para) FROM satisfacao_entregas l WHERE l.envio_id = d.envio_id AND l.etapa = 'LEMBRETE'), $2::timestamptz), d.max_tentativas
           FROM satisfacao_entregas d WHERE d.id = $1::uuid
         ON CONFLICT (envio_id, canal, etapa) DO NOTHING`,
        [p.entrega.id, calculado.toISOString()]);
    }
    return "ACEITA";
  }
  if (resultado.tipo === "TEMPORARIO" && tentativas < linha.max_tentativas) {
    const espera = Math.min(3600, 60 * 2 ** (tentativas - 1));
    await tx.query(`UPDATE satisfacao_entregas SET estado = 'PENDENTE', tentativas = $2, proxima_tentativa_em = clock_timestamp() + make_interval(secs => $3::int),
      posse_token = NULL, posse_ate = NULL, motivo = $4 WHERE id = $1::uuid`, [p.entrega.id, tentativas, espera, `TEMPORARIO: ${resultado.mensagem}`.slice(0, 300)]);
    return "PENDENTE";
  }
  const estado = resultado.tipo === "DESCONHECIDO" ? "INCERTA" : "FALHOU";
  await tx.query(`UPDATE satisfacao_entregas SET estado = $2, tentativas = $3, posse_token = NULL, posse_ate = NULL, motivo = $4 WHERE id = $1::uuid`,
    [p.entrega.id, estado, tentativas, `${resultado.tipo}: ${resultado.mensagem}`.slice(0, 300)]);
  return estado;
}

/**
 * Uma tentativa de uma entrega. `agora` fixa o relógio (testes); sem ele, vale ctx.relogio ou o relógio do processo,
 * lido em cada transação depois das travas.
 */
export async function despacharEntrega(banco: Banco, ctx: ContextoPesquisa, entregaId: string, agora?: Date): Promise<string> {
  const relogio = agora ? () => agora : (ctx.relogio ?? (() => new Date()));
  let preparo: Preparo;
  try {
    preparo = await comRepeticao(() => banco.transacao((tx) => preparar(tx, ctx, entregaId, relogio)), ctx.repeticao);
  } catch (error) {
    // Pais ocupados em todas as tentativas: a entrega continua PENDENTE, sem consumir tentativa (próximo ciclo).
    if (error instanceof TravaOcupada) return "AGUARDANDO_TRAVA";
    throw error;
  }
  if (preparo.tipo === "PRONTA") return preparo.estado;
  const p = preparo;
  let resultado: Resultado;
  try {
    const idempotencia = `satisfacao:${p.entrega.id}:${p.tentativa}`;
    const r = p.whatsapp
      ? await ctx.transportes.enviarWhatsapp({ empresaId: p.envio.empresa_id, execucaoId: p.envio.execucao_id, entregaId: p.entrega.id, idempotencia, ...p.whatsapp })
      : await ctx.transportes.enviarEmail({ empresaId: p.envio.empresa_id, entregaId: p.entrega.id, idempotencia, ...p.email! });
    resultado = { ok: true, provedorMensagemId: r.provedorMensagemId };
  } catch (error) {
    resultado = error instanceof FalhaTransporte ? { ok: false, tipo: error.tipo, mensagem: error.message } : { ok: false, tipo: "DESCONHECIDO", mensagem: "Falha sem classificação." };
  }
  // Só a transação da conclusão é repetida (40P01 uma vez); o transporte nunca. Se ainda falhar, a entrega fica ENVIANDO
  // e a recuperação de posse a leva a INCERTA (sem reenvio).
  return comRepeticao(() => banco.transacao((tx) => concluirTentativa(tx, p, resultado, relogio)), ctx.repeticao);
}

/**
 * Posse vencida durante o envio: INCERTA (não se sabe se saiu), nunca reenviada sozinha. O marco de contato é gravado pelo
 * gatilho (que atualiza o envio). Uma entrega por transação, na ordem comum (trava por cliente → cliente → envio →
 * entrega), reconferindo ENVIANDO e a posse vencida sob as travas: nunca entrega → envio, que formava ciclo de espera
 * com a conclusão (Astra PS-2 P2-3).
 */
export async function recuperarPossesEntregas(banco: Banco, agora: Date, empresaId: string | null, repeticao?: Repeticao) {
  const vencidas = await banco.transacao(async (tx) => (await tx.query<{ id: string; empresa_id: string; cliente_id: string; envio_id: string }>(
    `SELECT d.id::text, d.empresa_id::text, e.cliente_id::text, d.envio_id::text FROM satisfacao_entregas d JOIN satisfacao_envios e ON e.id = d.envio_id
      WHERE d.estado = 'ENVIANDO' AND d.posse_ate < $1::timestamptz AND ($2::uuid IS NULL OR d.empresa_id = $2::uuid) ORDER BY d.id`,
    [agora.toISOString(), empresaId])).rows);
  let n = 0;
  for (const v of vencidas) {
    n += await comRepeticao(() => banco.transacao(async (tx) => {
      await travarCliente(tx, v.empresa_id, v.cliente_id, "recuperar-posse");
      await tx.query(`/* satisfacao:recuperar-envio */ SELECT 1 FROM satisfacao_envios WHERE id = $1::uuid FOR UPDATE`, [v.envio_id]);
      const r = await tx.query(
        `UPDATE satisfacao_entregas SET estado = 'INCERTA', motivo = 'POSSE_VENCIDA_DURANTE_ENVIO', posse_token = NULL, posse_ate = NULL
          WHERE id = $1::uuid AND estado = 'ENVIANDO' AND posse_ate < $2::timestamptz`, [v.id, agora.toISOString()]);
      return r.rowCount ?? 0;
    }), repeticao);
  }
  return n;
}

/**
 * Ciclo das entregas: recupera posses vencidas e despacha as PENDENTE devidas (iniciais e lembretes, sem a janela de 14
 * dias da seleção do motor). A seleção não trava nada; cada entrega é decidida na própria transação, sob as travas.
 */
export async function executarEntregas(banco: Banco, ctx: ContextoPesquisa, agora: Date, opcoes: { empresaId?: string | null; limite?: number } = {}) {
  const empresaId = opcoes.empresaId ?? null;
  if (!ctx.habilitada) return { desligada: true, incertas: 0, processadas: 0, resultados: {} as Record<string, number> };
  const instalada = await banco.transacao(async (tx) => (await tx.query<{ ok: boolean }>(`SELECT to_regclass('public.satisfacao_entregas') IS NOT NULL AS ok`)).rows[0]?.ok === true);
  if (!instalada) return { desligada: true, incertas: 0, processadas: 0, resultados: {} as Record<string, number> };
  // `agora` (início do ciclo) só escolhe o que recuperar e o que tentar; cada tentativa lê o próprio relógio (P2-2).
  const incertas = await recuperarPossesEntregas(banco, agora, empresaId, ctx.repeticao);
  const candidatas = await banco.transacao(async (tx) => (await tx.query<{ id: string }>(
    `SELECT id::text FROM satisfacao_entregas
      WHERE estado = 'PENDENTE' AND agendada_para <= $1::timestamptz AND (proxima_tentativa_em IS NULL OR proxima_tentativa_em <= $1::timestamptz)
        AND ($2::uuid IS NULL OR empresa_id = $2::uuid)
      ORDER BY agendada_para, id LIMIT $3`, [agora.toISOString(), empresaId, opcoes.limite ?? 50])).rows.map((x) => x.id));
  const resultados: Record<string, number> = {};
  for (const id of candidatas) {
    const estado = await despacharEntrega(banco, ctx, id);
    resultados[estado] = (resultados[estado] ?? 0) + 1;
  }
  return { desligada: false, incertas, processadas: candidatas.length, resultados };
}

/** Retorno do provedor para uma entrega de WhatsApp da pesquisa: ACEITA → ENTREGUE | FALHOU (repetição e atraso ignorados). */
export async function aplicarRetornoEntrega(tx: DbExecutor, provedorMensagemId: string, status: "ENTREGUE" | "FALHOU", detalhe: string | null) {
  const instalada = (await tx.query<{ ok: boolean }>(`SELECT to_regclass('public.satisfacao_entregas') IS NOT NULL AS ok`)).rows[0]?.ok === true;
  if (!instalada) return "DESCONHECIDA";
  const d = (await tx.query<{ id: string; estado: string }>(
    `SELECT id::text, estado FROM satisfacao_entregas WHERE provedor_mensagem_id = $1 FOR UPDATE`, [provedorMensagemId])).rows[0];
  if (!d) return "DESCONHECIDA";
  if (d.estado !== "ACEITA") return "IGNORADO";
  await tx.query(`UPDATE satisfacao_entregas SET estado = $2, motivo = $3, concluida_em = CASE WHEN $2 = 'ENTREGUE' THEN clock_timestamp() ELSE NULL END WHERE id = $1::uuid`,
    [d.id, status, status === "FALHOU" ? `RETORNO: ${detalhe ?? "falha informada pelo provedor"}`.slice(0, 300) : null]);
  await tx.query(`UPDATE marketing_transporte_simulado SET status = $2, atualizado_em = clock_timestamp() WHERE provedor_mensagem_id = $1`, [provedorMensagemId, status]);
  return status;
}
