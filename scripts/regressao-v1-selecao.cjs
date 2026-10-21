/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");

const PASTAS = ["app", "components", "lib"];
const OPT_IN = "KIDMAIS_POSTGRES_DESCARTAVEL";
const BANCO = "kidmais_pacotes_v1_descartavel";

function caminhar(diretorio, aceita, encontrados) {
  if (!fs.existsSync(diretorio)) return;
  for (const item of fs.readdirSync(diretorio, { withFileTypes: true })) {
    const caminho = path.join(diretorio, item.name);
    if (item.isDirectory()) caminhar(caminho, aceita, encontrados);
    else if (aceita(item.name)) encontrados.push(caminho);
  }
}

function listar(raiz, aceita) {
  const encontrados = [];
  for (const pasta of PASTAS) caminhar(path.join(raiz, pasta), aceita, encontrados);
  return encontrados.sort();
}

function listarTestesEstaticos(raiz) {
  return listar(
    raiz,
    (nome) => nome.endsWith(".test.ts") && !nome.endsWith(".postgres.test.ts"),
  );
}

function listarTestesPostgres(raiz) {
  return listar(raiz, (nome) => nome.endsWith(".postgres.test.ts"));
}

/**
 * D3 — estado de PostgreSQL declarado por suíte (receita: scripts/regressao-v1-postgres-receita.cjs).
 * Suíte de produto parte do estado canônico ATUAL; suíte de migration declara o estado histórico que testa
 * e aplica/desfaz a própria migration. Antes de CADA suíte o runner recria os bancos de trabalho a partir
 * desses modelos: nenhuma suíte depende de banco deixado por outra. Suíte sem declaração é recusada.
 *   descartavel — estado do banco kidmais_pacotes_v1_descartavel;
 *   rollback    — estado do segundo banco kidmais_pacotes_v1_rollback, quando a suíte usa dois estados;
 *   alvo054     — o banco de trabalho é também o alvo autorizado do harness da 054 (KIDMAIS_054_*).
 */
const ESTADO_POSTGRES = {
  // Catálogo do buffet: 063 + 070 + 078 aplicadas pela própria suíte (em transação).
  "lib/comercial/catalogo-ux.postgres.test.ts": { descartavel: "063" },
  // Catálogo do buffet por empresa (078): leitura, escrita, cotação e preservação entre duas empresas; 063 + 070 + 078.
  "lib/comercial/catalogo-buffet-078.postgres.test.ts": { descartavel: "063" },
  // Disponibilidade do pacote por empresa: tela (cotação pública e administração) = servidor; isolamento; legado Kidmais.
  "lib/comercial/disponibilidade-empresa.postgres.test.ts": { descartavel: "063" },
  // F-L: script de fixtures da atualização de staging (scripts/fixture-atualizacao-staging.cjs) no schema de staging (até a 078).
  "lib/comercial/fixture-atualizacao-staging.postgres.test.ts": { descartavel: "078" },
  "lib/comercial/hg4-escopo.postgres.test.ts": { descartavel: "atual" },
  "lib/comercial/pacote-empresa.postgres.test.ts": { descartavel: "atual" },
  "lib/comercial/integridade-fechamento-053.postgres.test.ts": { descartavel: "052" },
  "lib/comercial/pacotes-v1-remediacao.postgres.test.ts": { descartavel: "039", rollback: "atual" },
  "lib/comercial/round4-remediacao.postgres.test.ts": { descartavel: "atual" },
  "lib/comercial/round5-remediacao.postgres.test.ts": { descartavel: "atual" },
  "lib/comercial/supersessao-048.postgres.test.ts": { descartavel: "atual" },
  "lib/contratos/migration-057.postgres.test.ts": { descartavel: "atual" },
  "lib/contratos/integracao-importados/integracao.postgres.test.ts": { descartavel: "atual" },
  "lib/disponibilidade/agenda-062.postgres.test.ts": { descartavel: "atual" },
  "lib/fechamentos/migration-054.postgres.test.ts": { descartavel: "053", alvo054: true },
  "lib/financeiro/baixa.postgres.test.ts": { descartavel: "atual" },
  "lib/financeiro/financeiro.postgres.test.ts": { descartavel: "atual" },
  "lib/pagamentos/pix/pix.postgres.test.ts": { descartavel: "atual" },
  "lib/assinatura/assinatura.postgres.test.ts": { descartavel: "atual" },
  "lib/assinatura/cobranca-068.postgres.test.ts": { descartavel: "atual" },
  // E8: cobrança Asaas (sandbox) com provedor falso; aplica 067 + 068 dentro da suíte.
  "lib/assinatura/cobranca-e8.postgres.test.ts": { descartavel: "atual", tambem: ["075"] },
  "lib/assinatura/contratacao-e8.postgres.test.ts": { descartavel: "atual", tambem: ["075"] },
  "lib/assinatura/transacao-com-prazo.postgres.test.ts": { descartavel: "atual", tambem: ["075"] },
  // Também depois da 061 e da 062: módulo Festa, formalização e agenda nativos (código novo em cada etapa).
  "lib/festas/tenant-festa.postgres.test.ts": { descartavel: "atual", tambem: ["061", "062", "063"] },
  "lib/ia-persistencia/migration-055.postgres.test.ts": { descartavel: "atual" },
  "lib/ia-persistencia/uso-custos.postgres.test.ts": { descartavel: "atual" },
  "lib/ia-persistencia/migration-058.postgres.test.ts": { descartavel: "atual" },
  "lib/inteligencia/inteligencia.postgres.test.ts": { descartavel: "atual" },
  "lib/operacional/migration-059.postgres.test.ts": { descartavel: "atual" },
  "lib/whatsapp/atendimento/migration-060.postgres.test.ts": { descartavel: "atual" },
  // 080 e concorrência do encerrar: cada suíte aplica a 060 (e a 080) sobre o modelo atual, como a da 060.
  "lib/whatsapp/atendimento/migration-080.postgres.test.ts": { descartavel: "atual" },
  "lib/whatsapp/atendimento/encerrar-concorrencia.postgres.test.ts": { descartavel: "atual" },
  // 065 (nome de perfil) e identificação do contato: aplica a 060 e a 065 sobre o modelo atual; independe da 080.
  "lib/whatsapp/atendimento/migration-065.postgres.test.ts": { descartavel: "atual" },
  // 081 (fotos/vídeos e atalhos novos): aplica a 060 e a 080 sobre o modelo atual; independe da 065.
  "lib/whatsapp/atendimento/migration-081.postgres.test.ts": { descartavel: "atual" },
  "lib/whatsapp/atendimento/migration-082.postgres.test.ts": { descartavel: "atual" },
  "lib/whatsapp/atendimento/walle/walle-worker.postgres.test.ts": { descartavel: "atual" },
  "lib/whatsapp/atendimento/walle/agenda-escopo.postgres.test.ts": { descartavel: "063" },
  "lib/pagamentos/estorno-completo.postgres.test.ts": { descartavel: "atual", tambem: ["061", "062"] },
  "lib/pagamentos/gates-c2.postgres.test.ts": { descartavel: "atual" },
  "lib/saas/hg6-kidmais.postgres.test.ts": { descartavel: "045-sem-040" },
  "lib/saas/hg8-catalogo.postgres.test.ts": { descartavel: "atual" },
  "lib/saas/migration-056.postgres.test.ts": { descartavel: "atual" },
  "lib/saas/provar-estabelecimento.postgres.test.ts": { descartavel: "atual" },
  "lib/saas/hg8-empresa.postgres.test.ts": { descartavel: "atual" },
  "lib/saas/hg8-estrutura.postgres.test.ts": { descartavel: "042-sem-040" },
  "lib/saas/hg8-membership.postgres.test.ts": { descartavel: "atual" },
  "lib/saas/hg8-provisionar.postgres.test.ts": { descartavel: "atual" },
  "lib/saas/hg8-tenant.postgres.test.ts": { descartavel: "atual", tambem: ["063"] },
  // Painel do desenvolvedor (063): concessão, interessadas, provisionamento, convites, vínculos, suspensão, senhas.
  "lib/desenvolvedor/painel-063.postgres.test.ts": { descartavel: "063" },
  // #157: rebaixar a última administradora do Perfil com id próprio (≠ empresa SaaS), painel e Configurações > Usuários.
  "lib/desenvolvedor/papel-ultima-administradora.postgres.test.ts": { descartavel: "063" },
  // R2: remover da empresa e desativar o vínculo com Perfis de id próprio (≠ empresa SaaS), duas empresas, ambiguidade.
  "lib/desenvolvedor/remocao-desativacao-perfil.postgres.test.ts": { descartavel: "063" },
  // R2: suspensão e reativação do vínculo (concessões inertes e de volta; remoção de vínculo suspenso revoga).
  "lib/desenvolvedor/suspensao-reativacao-perfil.postgres.test.ts": { descartavel: "063" },
  // Painel comercial (E5): 063 + 067 + 068 aplicadas pela própria suíte.
  "lib/desenvolvedor/comercial.postgres.test.ts": { descartavel: "063" },
  // Cadastro público (E6): 063 + 067 + 068 + 069 aplicadas pela própria suíte.
  "lib/cadastro/cadastro-069.postgres.test.ts": { descartavel: "063" },
  // Adicionais do buffet: 063 + 070 aplicada pela própria suíte.
  "lib/comercial/adicionais-070.postgres.test.ts": { descartavel: "063" },
  // Importação da tabela de preços: 063 + 070 + 071 aplicadas pela própria suíte.
  "lib/comercial/importacao-tabela/importacao-071.postgres.test.ts": { descartavel: "063" },
  // Modelo de contrato da empresa: 063 + 070 + 071 + 072 aplicadas pela própria suíte.
  "lib/contratos/modelo-empresa/modelo-072.postgres.test.ts": { descartavel: "063" },
  // Integração atendimento × painel: empresa ativa × piloto e coexistência 060/063/065/080 (modelo 063, com a 060).
  "lib/whatsapp/atendimento/empresa-ativa.postgres.test.ts": { descartavel: "063" },
  "lib/whatsapp/atendimento/coexistencia-060-065.postgres.test.ts": { descartavel: "063" },
  // Coexistência da 081 com 060/063/065/080: as duas ordens e rollback cruzado (a 080 não sai com a 081 presente).
  "lib/whatsapp/atendimento/coexistencia-081.postgres.test.ts": { descartavel: "063" },
  // Candidata: coexistência e rollback cruzado do atendimento (060/065/080/081/082) com 064/066/067/068/069/070 de staging.
  "lib/whatsapp/atendimento/coexistencia-staging.postgres.test.ts": { descartavel: "063" },
  // Renumeração de 10/10: coexistência do atendimento com a 076 (CPF por empresa) e a 077 (regras de pagamento) do
  // staging, nas duas ordens; os downs do atendimento preservam objetos e dados sintéticos delas.
  "lib/whatsapp/atendimento/coexistencia-cpf-pagamento.postgres.test.ts": { descartavel: "063" },
  // Revisão final da integração r47: ordem dos rollbacks (H1/M1, recusa de dependentes com e sem dados), turno do resumo
  // pelo escopo da empresa/unidade (M2, precisa da 062) e validade da fila + automação global desligada (M3/M4).
  "lib/whatsapp/atendimento/rollback-ordem.postgres.test.ts": { descartavel: "063" },
  "lib/whatsapp/atendimento/walle/resumo-turno.postgres.test.ts": { descartavel: "063" },
  "lib/whatsapp/atendimento/fila-validade.postgres.test.ts": { descartavel: "atual" },
  // Proteções finais: modo regras em todos os caminhos (sem a 082, Wall-e desligado) e entrada recebida com a IA global
  // desligada nunca respondida depois de religar, sem ciclo intermediário (aplica a 060 e depois 080–082).
  "lib/whatsapp/atendimento/protecoes-finais.postgres.test.ts": { descartavel: "atual" },
  // Correção P1 (revisão da candidata final): pausa reconhecida pelas regras vence o limite diário e os caminhos fixos.
  "lib/whatsapp/atendimento/pausa-limite.postgres.test.ts": { descartavel: "atual" },
  // M1: limite diário esgotado ⇒ equipe em silêncio (sem modelo nem texto fixo, sem inventar pausa); origem das marcas.
  "lib/whatsapp/atendimento/limite-silencio.postgres.test.ts": { descartavel: "atual" },
  // 11/10: ordem da premissa do staging (061…079 presentes; 060/065/080–082 depois) × ordem do inventário (modelo "082", no
  // banco de rollback): mesmo schema; rollback nas duas ordens; downs da 078/079 com o atendimento presente.
  "lib/whatsapp/atendimento/ordem-staging-real.postgres.test.ts": { descartavel: "079-sem-atendimento", rollback: "082" },
  // 11/10: o Wall-e no catálogo do buffet por empresa (078 do staging): cada empresa só vê o próprio buffet.
  "lib/whatsapp/atendimento/walle/catalogo-por-empresa.postgres.test.ts": { descartavel: "082" },
  "lib/whatsapp/atendimento/walle/preco-adicional.postgres.test.ts": { descartavel: "082" },
  // 12/10: estado misto (060 aplicada antes de 061…079, 065 ausente) × ordem do inventário; rollback.
  "lib/whatsapp/atendimento/estado-misto.postgres.test.ts": { descartavel: "079-sem-065", rollback: "082" },
  // 12/10 (M2): corrida revogação × envio, determinística (travas do banco como barreiras).
  "lib/whatsapp/atendimento/revogacao-envio.postgres.test.ts": { descartavel: "082" },
  // D2/D3: exclusão (pedido e retenção), PARAR preservado, tarefas pendentes, revogação/troca de link/expiração de arquivos.
  "lib/whatsapp/atendimento/privacidade.postgres.test.ts": { descartavel: "082" },
  // 12/10: correções da revisão independente de 69dc301 (H2, M1, M5, M3, B2, M4, B1).
  "lib/whatsapp/atendimento/revisao-correcoes.postgres.test.ts": { descartavel: "082" },
  // 12/10: correções da revisão independente de 5699dfc (A1 configuração vigente, M1 posse da retenção, M2 callbacks).
  "lib/whatsapp/atendimento/revisao2-correcoes.postgres.test.ts": { descartavel: "082" },
  // 12/10: postcheck da 082 aceita a versão final e recusa variantes antigas/adulteradas (B2 da revisão de aa04387).
  "lib/whatsapp/atendimento/postcheck-082.postgres.test.ts": { descartavel: "082" },
  // 16/10: WhatsApp por empresa (083): conexão, isolamento entre empresas, número único, desconexão, rollback.
  // Também no schema completo (084 de Convites + 085/086 do Marketing), desde a composição de 18/10/2026.
  "lib/whatsapp/conexao-empresa.postgres.test.ts": { descartavel: "083", tambem: ["086"] },
  // 16/10: Meta (Cloud API) como canal do atendimento: webhook assinado → empresa dona do número; status e envio.
  "lib/whatsapp/atendimento/meta-recepcao.postgres.test.ts": { descartavel: "083", tambem: ["086"] },
  // Recuperação manual de convites (079): valida schema e constraints após reconstruir a cadeia completa.
  "lib/convites/recuperacao.postgres.test.ts": { descartavel: "079", tambem: ["079-sem-atendimento"] },
  // Gratuidade da Kidmais com as chaves de produção ligadas, no schema vigente (até a 079).
  "lib/assinatura/kidmais-gratuidade.postgres.test.ts": { descartavel: "079", tambem: ["079-sem-atendimento"] },
  // Script de fixtures do painel em staging (scripts/fixture-painel-staging.cjs) no schema vigente (até a 079).
  "lib/desenvolvedor/fixture-painel-staging.postgres.test.ts": { descartavel: "079", tambem: ["079-sem-atendimento"] },
  // Marketing (goal local 14/10/2026): 085/086 aplicadas pela suíte sobre a 084 (ordem real em staging: 083 do WhatsApp,
  // 084 de Convites, depois 085/086; reaplicação, gatilhos, rollback). Antes: modelo 082 (até 18/10/2026) e 083 (4e80b81).
  "lib/marketing/migration-085-086.postgres.test.ts": { descartavel: "084" },
  // Entrega A no modelo 086: site, formulário, atribuição até contrato, painel, isolamento A×B, domínio simulado.
  "lib/marketing/marketing-a.postgres.test.ts": { descartavel: "086" },
  // Entrega B no modelo 086: planejamento idempotente, supressões, falha recuperável, retorno e concorrência.
  "lib/marketing/automacoes/automacoes-b.postgres.test.ts": { descartavel: "086" },
  // Correções R1–R4 da revisão de bc379ad (15/10/2026): autorização por destino, aptidão da empresa no worker,
  // receita desconhecida e planejamento além de 500 alvos.
  "lib/marketing/correcoes-r1-r4.postgres.test.ts": { descartavel: "086" },
  // Observações O1/O2 da revisão de 64fcd09 (15/10/2026): número que sai do cadastro revoga a autorização; evidência
  // de confirmação congelada.
  "lib/marketing/correcoes-o1-o2.postgres.test.ts": { descartavel: "086" },
  // F1 da revisão de f917f98 (15/10/2026): formulário × saída do número em transações concorrentes (3 conexões).
  "lib/marketing/correcao-f1.postgres.test.ts": { descartavel: "086" },
  // OBS-2 da revisão de f9d8a63 (18/10/2026): o aplicador real de staging 085/086 sobre o schema anterior ao Marketing
  // (083 + 084): conferência, recusas (parcial, trava concorrente, sem CREATE), falha/retomada, idempotência e downs.
  "lib/marketing/aplicador-085-086.postgres.test.ts": { descartavel: "084" },
  // OBS-2: Convites (084) e WhatsApp (083) com o Marketing presente; downs 086 → 085 → 084 e recusas com dados.
  "lib/marketing/composicao-convites-085-086.postgres.test.ts": { descartavel: "086" },
  // 21/10/2026: autorização do responsável para Convites com IA (088), aplicada pela suíte sobre o modelo 086 (a 087 é
  // de outro trabalho local, ainda não integrado): checks, isolamento por empresa, imutabilidade, revogação, rollback.
  "lib/convites/autorizacoes-088.postgres.test.ts": { descartavel: "086" },
};

function estadoDaSuite(raiz, arquivo) {
  const relativo = path.relative(raiz, arquivo).split(path.sep).join("/");
  const estado = ESTADO_POSTGRES[relativo];
  if (!estado) throw new Error(`Suíte PostgreSQL sem estado declarado: ${relativo}. Declare-a em ESTADO_POSTGRES.`);
  return { relativo, ...estado };
}

function arquivosDoCheckEstatico(raiz) {
  return [
    ...listarTestesEstaticos(raiz),
    path.join(raiz, "scripts", "regressao-v1-estatica.test.cjs"),
    // Regressão do Wall-e com os casos dos holdouts já analisados (sem rede nem banco; usa a composition root da IA).
    path.join(raiz, "scripts", "walle-avaliacao", "regressao-holdouts.test.mjs"),
    // Livro único de uso de IA do Wall-e: teto do dia entre processos (arquivo temporário próprio; sem rede nem banco).
    path.join(raiz, "scripts", "walle-avaliacao", "livro-uso-ia.test.mjs"),
  ];
}

function exigirOptInDescartavel(env) {
  const valor = env[OPT_IN];
  if (valor !== BANCO || String(valor).includes("://")) {
    throw new Error(
      `Suíte PostgreSQL descartável recusada: defina ${OPT_IN}=${BANCO}. DATABASE_URL não autoriza esta suíte e não abre conexão.`,
    );
  }
  return BANCO;
}

function exigirListaPostgres(arquivos) {
  if (!arquivos.length) {
    throw new Error(
      "Suíte PostgreSQL descartável recusada: nenhum teste descartável encontrado.",
    );
  }
  return arquivos;
}

/** Configuração de conexão herdada (DATABASE_URL e qualquer PG*): nunca chega a uma suíte nem ao runner. */
function variavelDeConexaoHerdada(nome) {
  return nome === "DATABASE_URL" || /^PG/i.test(nome);
}

const VARIAVEIS_054 = ["KIDMAIS_054_PG_HOST", "KIDMAIS_054_PG_PORT", "KIDMAIS_054_PG_DATABASE", "KIDMAIS_054_PG_USER", "KIDMAIS_054_AUTORIZACAO"];

/**
 * Ambiente EXPLÍCITO de cada suíte: remove DATABASE_URL e toda variável PG* (PGPORT, PGOPTIONS, PGSERVICEFILE,
 * PGPASSFILE...), remove o alvo da 054 de quem não o declara e repassa a porta autorizada com a autorização literal —
 * a porta não depende de PGPORT nem de padrão implícito. Pura (testada sem processo).
 */
function ambienteDaSuite(base, estado, porta, banco) {
  const env = { ...base, NEXT_TELEMETRY_DISABLED: "1" };
  for (const nome of Object.keys(env)) if (variavelDeConexaoHerdada(nome) || VARIAVEIS_054.includes(nome)) delete env[nome];
  env[OPT_IN] = BANCO;
  env.KIDMAIS_DESCARTAVEL_PORTA = String(porta);
  env.KIDMAIS_DESCARTAVEL_AUTORIZACAO = `127.0.0.1:${porta}/${BANCO}`;
  if (estado.alvo054) {
    Object.assign(env, {
      KIDMAIS_054_PG_HOST: "127.0.0.1",
      KIDMAIS_054_PG_PORT: String(porta),
      KIDMAIS_054_PG_DATABASE: banco,
      KIDMAIS_054_PG_USER: "kidmais_descartavel",
      KIDMAIS_054_AUTORIZACAO: `127.0.0.1:${porta}/${banco}`,
    });
  }
  return env;
}

/** Repetição de suítes pertinentes: KIDMAIS_POSTGRES_SOMENTE="lib/a.postgres.test.ts,lib/b.postgres.test.ts" (caminhos exatos). */
function filtrarSuites(planos, env) {
  const texto = env.KIDMAIS_POSTGRES_SOMENTE;
  if (!texto) return planos;
  const pedidas = texto.split(",").map((s) => s.trim()).filter(Boolean);
  const desconhecidas = pedidas.filter((p) => !Object.hasOwn(ESTADO_POSTGRES, p));
  if (desconhecidas.length) throw new Error(`KIDMAIS_POSTGRES_SOMENTE com suíte desconhecida: ${desconhecidas.join(", ")}`);
  return planos.filter((p) => pedidas.includes(p.estado.relativo));
}

module.exports = {
  variavelDeConexaoHerdada,
  ambienteDaSuite,
  filtrarSuites,
  OPT_IN,
  BANCO,
  PASTAS,
  listarTestesEstaticos,
  listarTestesPostgres,
  arquivosDoCheckEstatico,
  exigirOptInDescartavel,
  exigirListaPostgres,
  ESTADO_POSTGRES,
  estadoDaSuite,
};
