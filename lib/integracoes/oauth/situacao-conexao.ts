/**
 * Situação de uma conexão com assistente externo, calculada SÓ a partir do que o iA.Fest registrou (concessão, código,
 * tokens e auditoria sanitizada). Sem relógio de inatividade: ficar sem uso não muda a situação, e nada aqui consulta
 * saúde do servidor nem testa o assistente. "Precisa reconectar" exige evidência de que o assistente não consegue mais
 * se autenticar. Módulo puro, compartilhado entre a rota e a tela.
 */
export type MotivoRevogacao = "USUARIO" | "REUSO" | "SUBSTITUIDA";

/** Última falha de ferramenta DEPOIS da última consulta bem-sucedida (só código fechado, nunca conteúdo). */
export type FalhaRegistrada = { codigo: string; capacidade: string | null; em: string };

export type EvidenciasConexao = {
  motivoRevogacao: MotivoRevogacao | null;
  /** Senha trocada depois da autorização ou usuário inativo: os tokens desta concessão deixam de valer. */
  credencialInvalida: boolean;
  /** O assistente trocou o código da autorização por tokens. */
  codigoUsado: boolean;
  /** Código emitido e ainda dentro do prazo: o assistente ainda pode concluir. */
  codigoPendente: boolean;
  /** Existe token de acesso ou de renovação vigente. */
  tokenVigente: boolean;
  ultimaFalha: FalhaRegistrada | null;
};

export type ConexaoComEvidencias = {
  clientId: string;
  empresaId: string;
  criadaEm: string;
  ultimaFerramentaEm: string | null;
  revogadaEm: string | null;
  evidencias: EvidenciasConexao;
};

export type CodigoSituacao = "NAO_CONFIRMADA" | "AGUARDANDO_AUTORIZACAO" | "AUTORIZADA_SEM_CONSULTA" | "CONSULTA_OK" | "PRECISA_RECONECTAR" | "DESCONECTADA" | "SUBSTITUIDA";

export type Situacao = {
  codigo: CodigoSituacao;
  titulo: string;
  /** Texto com data e horário quando houver. */
  detalhe: string;
  /** Causa comprovada, só quando a evidência existe. */
  causa: string | null;
};

/**
 * `criada_em::text` do PostgreSQL ("2026-11-05 13:55:00.123-03") não é ISO: o Safari devolve data inválida. Normaliza
 * antes de formatar; texto irreconhecível vira travessão, nunca "Invalid Date".
 */
export function formatarDataHora(valor: string | null): string {
  if (!valor) return "—";
  const iso = valor.trim().replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return "—";
  return data.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" });
}

export function situacaoDaConexao(c: ConexaoComEvidencias): Situacao {
  const e = c.evidencias;
  if (c.revogadaEm) {
    if (e.motivoRevogacao === "SUBSTITUIDA") return { codigo: "SUBSTITUIDA", titulo: "Substituída", detalhe: `Trocada por uma autorização mais recente em ${formatarDataHora(c.revogadaEm)}.`, causa: null };
    if (e.motivoRevogacao === "REUSO") {
      return {
        codigo: "PRECISA_RECONECTAR", titulo: "Precisa reconectar", detalhe: `Encerrada em ${formatarDataHora(c.revogadaEm)}.`,
        causa: "O iA.Fest encerrou esta conexão por segurança: uma credencial já substituída foi apresentada de novo.",
      };
    }
    return { codigo: "DESCONECTADA", titulo: "Desconectada", detalhe: `Desconectada em ${formatarDataHora(c.revogadaEm)}.`, causa: null };
  }
  const reconectar = (causa: string): Situacao => ({ codigo: "PRECISA_RECONECTAR", titulo: "Precisa reconectar", detalhe: `Autorizada em ${formatarDataHora(c.criadaEm)}.`, causa });
  if (e.credencialInvalida) return reconectar("A senha ou a situação deste usuário mudou depois da autorização, o que encerra o acesso do assistente.");
  if (!e.codigoUsado) {
    if (!e.codigoPendente) return reconectar("A autorização foi dada no iA.Fest, mas o assistente não concluiu a conexão dentro do prazo.");
    return { codigo: "AUTORIZADA_SEM_CONSULTA", titulo: "Autorizado, aguardando primeira consulta", detalhe: `Autorizada em ${formatarDataHora(c.criadaEm)}. Volte ao assistente para ele concluir a conexão.`, causa: null };
  }
  // Código trocado sem credencial vigente: a troca pode ter falhado (PKCE) ou a renovação automática pode ter terminado.
  if (!e.tokenVigente) return reconectar("Não há credencial vigente nesta conexão: a conexão não foi concluída pelo assistente ou a renovação automática terminou.");
  if (c.ultimaFerramentaEm) return { codigo: "CONSULTA_OK", titulo: "Última consulta bem-sucedida", detalhe: `Última consulta bem-sucedida em ${formatarDataHora(c.ultimaFerramentaEm)}.`, causa: null };
  return { codigo: "AUTORIZADA_SEM_CONSULTA", titulo: "Autorizado, aguardando primeira consulta", detalhe: `Autorizada em ${formatarDataHora(c.criadaEm)}. Nenhuma consulta recebida até agora.`, causa: null };
}

export const SITUACAO_SEM_CONEXAO: Situacao = {
  codigo: "AGUARDANDO_AUTORIZACAO", titulo: "Aguardando autorização",
  detalhe: "Este usuário ainda não autorizou este assistente nesta empresa.", causa: null,
};

/** Sem usuário e empresa confirmados, a tela não sabe qual conexão vale para o cartão: não afirma nenhuma situação. */
export const SITUACAO_NAO_CONFIRMADA: Situacao = {
  codigo: "NAO_CONFIRMADA", titulo: "Situação não confirmada",
  detalhe: "Não foi possível confirmar o usuário e a empresa agora. Atualize a situação. Suas conexões e o botão Desconectar continuam abaixo.", causa: null,
};

export type AssistenteId = "chatgpt" | "claude";

/** Identifica o assistente pelo host do client_id (CIMD), nunca pelo nome que ele declara. */
export function assistenteDoCliente(clientId: string): AssistenteId | null {
  try {
    const host = new URL(clientId).hostname.toLowerCase();
    if (host === "chatgpt.com") return "chatgpt";
    if (host === "claude.ai") return "claude";
  } catch {
    // client_id fora do formato de URL não identifica assistente conhecido.
  }
  return null;
}

/**
 * Situação do cartão: só a conexão deste assistente NESTA empresa e deste usuário. Conexão de outra empresa nunca conta
 * como conectada aqui; ela aparece à parte, em `outrasEmpresas`.
 */
export function conexaoDoCartao<T extends ConexaoComEvidencias>(conexoes: readonly T[], assistente: AssistenteId, empresaId: string | null) {
  const doAssistente = conexoes.filter((c) => assistenteDoCliente(c.clientId) === assistente);
  const daEmpresa = doAssistente.filter((c) => c.empresaId === empresaId);
  const ativa = daEmpresa.find((c) => !c.revogadaEm) ?? null;
  const encerrada = daEmpresa.filter((c) => c.revogadaEm && c.evidencias.motivoRevogacao !== "SUBSTITUIDA")
    .sort((a, b) => String(b.revogadaEm).localeCompare(String(a.revogadaEm)))[0] ?? null;
  const conexao = ativa ?? encerrada;
  return {
    conexao,
    ativa,
    situacao: conexao ? situacaoDaConexao(conexao) : SITUACAO_SEM_CONEXAO,
    outrasEmpresas: doAssistente.filter((c) => !c.revogadaEm && c.empresaId !== empresaId),
  };
}

/** Falha registrada traduzida para linguagem simples. O código vem da auditoria: é causa comprovada, não palpite. */
export type FalhaExplicada = { titulo: string; acao: string };

const ROTULO_CAPACIDADE: Readonly<Record<string, string>> = {
  kidmais_consultar_agenda: "resumo da agenda",
  kidmais_consultar_recebiveis_resumo: "resumo dos recebíveis",
  kidmais_buscar_conhecimento: "ajuda e documentação",
  kidmais_obter_trecho: "ajuda e documentação",
};

export function explicarFalha(falha: FalhaRegistrada | null): FalhaExplicada | null {
  if (!falha) return null;
  const alvo = falha.capacidade ? ROTULO_CAPACIDADE[falha.capacidade] ?? "esta consulta" : "esta consulta";
  switch (falha.codigo) {
    case "ESCOPO_INSUFICIENTE":
      return { titulo: `Permissão insuficiente: o assistente tentou consultar ${alvo}, que não foi autorizado nesta conexão.`, acao: "Se quiser liberar, reconecte pelo assistente e marque as permissões que deseja manter e as que deseja adicionar: a nova autorização substitui a anterior." };
    case "ACESSO_NEGADO":
      return { titulo: `Acesso recusado ao consultar ${alvo}: o acesso deste usuário nesta empresa não permite a consulta.`, acao: "Confira o usuário e a empresa. Se o acesso deveria existir, fale com quem administra a empresa." };
    case "ASSINATURA_NECESSARIA":
      return { titulo: "Consulta recusada pela situação da assinatura desta empresa.", acao: "Regularize a assinatura. Não é preciso reconectar." };
    case "CANAL_DESATIVADO":
      return { titulo: "As consultas por assistentes estão pausadas para esta empresa ou neste ambiente.", acao: "Não é preciso reconectar. A conexão volta a responder quando as consultas forem religadas." };
    case "INDISPONIVEL":
      return { titulo: "O iA.Fest não conseguiu responder à última tentativa.", acao: "Tente de novo em alguns minutos. Não é preciso reconectar." };
    case "VOLUME_ACIMA_DO_LIMITE":
      return { titulo: "Há lançamentos demais para resumir por esta conexão.", acao: "Consulte o Financeiro dentro do iA.Fest. Não é preciso reconectar." };
    case "DADOS_INVALIDOS":
      return { titulo: "O assistente enviou uma consulta em formato inválido.", acao: "Reformule a pergunta. Não é preciso reconectar." };
    default:
      return { titulo: "A última tentativa de consulta não foi concluída.", acao: "Tente de novo em alguns minutos. Não é preciso reconectar." };
  }
}
