/* eslint-disable @typescript-eslint/no-require-imports */
// ORDEM da promoção de staging para production (12/11/2026): só DADOS e funções PURAS. Não conecta em nada, não lê env, não
// roda aplicador nenhum. É roteiro, não autorização: cada passo continua exigindo a autorização própria de Felipe, o backup
// registrado e os pré-requisitos do plano do próprio aplicador (`node <aplicador>` sem argumentos).
//   - a ordem é a do inventário (scripts/production/check-migrations.mjs, approvedFiles), a partir da 089;
//   - a 098 é HISTÓRICA e nunca entra (a 102 e a 108 recusam se ela existir); a 099 e a 105 já estão em production;
//   - o aplicador da 092–094 de produção só tem dois escopos (092-093 e 094): são dois passos, e o 094 exige antes o deploy
//     do código novo (regra do próprio aplicador, scripts/migration-092-094-production.cjs);
//   - 120, 121, 110, 111 e 115 não têm aplicador próprio: passam pelo genérico (scripts/migration-generico-production.cjs);
//   - os adaptadores de 102–103, 104–106, 107–108 e 109 são do OUTRO lote da promoção (PENDENTES_DO_OUTRO_LOTE): este arquivo
//     só aponta o caminho combinado; as flags deles aqui são as do núcleo de cada um.
// Cada passo tem 3 fases, nesta ordem: CONFERIR (só leitura) → APLICAR → CONFERIR_DEPOIS. Qualquer código de saída
// diferente de 0, em qualquer fase, PARA a cadeia (1 recusa antes de conectar, 2 FALHA, 3 RECUSARIA, 4 recusa do bloco de
// Shell; qualquer outro valor ou ausência = parar e ler).
//   node scripts/promocao-production-ordem.cjs            → a ordem, em JSON
//   node scripts/promocao-production-ordem.cjs --roteiro  → docs/PROMOCAO_UNICA_PRODUCTION_20261112.md (texto gerado)
const assert = require('node:assert/strict');

const GENERICO = 'scripts/migration-generico-production.cjs';
/** Únicos aplicadores que podem faltar na árvore deste lote: são entregues pelo outro agente, em outro clone. */
const PENDENTES_DO_OUTRO_LOTE = Object.freeze(['scripts/migration-102-103-production.cjs', 'scripts/migration-104-106-production.cjs',
  'scripts/migration-107-108-production.cjs', 'scripts/migration-109-production.cjs']);
/** Regra de volta: antes de aplicar a 094, o deploy anterior basta; a partir dela, restaurar o backup ou corrigir para a frente. */
const PONTO_SEM_VOLTA_POR_DEPLOY = '094';
const FASES = Object.freeze(['CONFERIR', 'APLICAR', 'CONFERIR_DEPOIS']);

const proprio = (id, escopo, extra = {}) => ({id, situacao: 'APLICAR', migrations: [id], aplicador: `scripts/migration-${id}-production.cjs`,
  conferir: `--conferir-${id}`, aplicar: `--aplicar-${id}-autorizado`, bloco: `node scripts/bloco-shell-${id}.cjs production <CONFERIR|APLICAR> <rotulo>`, escopo, ...extra});
const doMeuLote = (id, escopo) => proprio(id, escopo, {bloco: `node scripts/bloco-shell-promocao-production.cjs ${id} <CONFERIR|APLICAR> <rotulo>`});
const grupo = (id, migrations, escopo, extra = {}) => proprio(id, escopo, {migrations, bloco: 'node scripts/bloco-shell-' + id + '-production.cjs <CONFERIR|APLICAR> <rotulo>', outroLote: true, ...extra});
const generico = (id, escopo) => ({id, situacao: 'APLICAR', migrations: [id], aplicador: 'generico', arquivo: GENERICO, conferir: `--conferir ${id}`, aplicar: `--aplicar-autorizado ${id}`,
  bloco: `node scripts/bloco-shell-promocao-production.cjs ${id} <CONFERIR|APLICAR> <rotulo>`, escopo});
const fora = (id, situacao, escopo) => ({id, situacao, migrations: [id], aplicador: null, escopo});
const congelar = p => Object.freeze({...p, migrations: Object.freeze(p.migrations)});

const ORDEM = Object.freeze([
  proprio('089', 'pedidos de cancelamento e devolução da assinatura, com protocolo'),
  proprio('090', 'campanha Fundador em duas fases'),
  proprio('091', 'documento fiscal CPF/CNPJ do contratante'),
  {id: '092-093', situacao: 'APLICAR', migrations: ['092', '093'], aplicador: 'scripts/migration-092-094-production.cjs', conferir: '--conferir-092-093', aplicar: '--aplicar-092-093-autorizado',
    bloco: 'node scripts/bloco-shell-092-094.cjs production <CONFERIR-092-093|APLICAR-092-093> <rotulo>', escopo: 'preço por quantidades cheias (092) e configuração da agenda por unidade (093); recusa se a 094 já estiver presente'},
  {id: '094', situacao: 'APLICAR', migrations: ['094'], aplicador: 'scripts/migration-092-094-production.cjs', conferir: '--conferir-094', aplicar: '--aplicar-094-autorizado',
    bloco: 'node scripts/bloco-shell-092-094.cjs production <CONFERIR-094|APLICAR-094> <rotulo>', escopo: 'capacidade, limite do dia e intervalo na regra de conflito; exige 092 e 093 completas',
    exigeAntes: 'o código NOVO já implantado em production (regra vigente: sistema em manutenção, código novo no ar primeiro, depois a cadeia inteira na ordem; a 092–093 vêm antes da 094 e a 094 exige o código novo, que o aplicador da 092–094 não reconhece sem ele)'},
  proprio('095', 'créditos de IA: carteiras, lotes, extrato, compra avulsa e devolução'),
  proprio('096', 'comprovante da contratação e arquivo das versões dos documentos legais'),
  proprio('097', 'manifestações do direito de arrependimento'),
  fora('098', 'EXCLUIDA', 'salões combinados HISTÓRICA: nunca entra na cadeia; a 102 e a 108 recusam se ela existir (a 108 é a 098 rebaseada)'),
  fora('099', 'JA_APLICADA', 'convites avulsos: já está em production'),
  proprio('100', 'agenda com um salão: troca o corpo de kidmais094_conflito_ocupacao; exige o corpo exato da 094'),
  grupo('102-103', ['102', '103'], 'apresentação do salão (102) e categoria Serviços nos adicionais (103); a 102 recusa a 098'),
  fora('105', 'JA_APLICADA', 'canal MCP por assinatura: já está em production; fica fora do aplicador da 104–106'),
  grupo('104-106', ['104', '106'], 'versão do hash da revisão operacional (104) e salão de preferência do cliente (106); a 105 não entra'),
  grupo('107-108', ['107', '108'], 'reparo da deriva da agenda (107) e salões combinados rebaseados (108); a 108 recusa a 098', {aposBackup: '--drenagem "<registro-da-drenagem>"'}),
  grupo('109', ['109'], 'renovação substituta do B-9; quebra o código anterior: código compatível antes'),
  doMeuLote('114', 'trava da configuração da agenda nos gatilhos da 019 (KD114); sem checks externos, a prova é do núcleo'),
  doMeuLote('112', 'cliente pessoa jurídica; trava clientes pelo tempo da transação'),
  doMeuLote('116', 'franquias de IA por plano e ciclo; CREDITOS_FRANQUIA_PLANO_ATIVO continua desligada'),
  doMeuLote('117', 'atendimento WhatsApp multiempresa; o núcleo recusa com WHATSAPP_ATENDIMENTO_MULTIEMPRESA ligada'),
  proprio('118', 'cota de leitura de documentos da importação de contratos; backup no formato "PITR <AAAA-MM-DDTHH:MMZ> <referencia>"',
    {bloco: 'node scripts/bloco-shell-118-production.cjs <CONFERIR|APLICAR> <rotulo>'}),
  generico('120', 'financeiro P2: liquidações de entradas e reversões de saídas'),
  generico('121', 'financeiro P2: abertura do financeiro e conferências'),
  generico('110', 'pesquisa de satisfação pós-festa'),
  generico('111', 'pesquisa de satisfação: links de avaliação e auditoria; exige a 110'),
  generico('115', 'índice (empresa_id, data_evento) em fechamentos no lugar do índice da 054'),
].map(congelar));

/** Só os passos que rodam (sem a 098 excluída nem a 099/105 já aplicadas). */
const PASSOS = Object.freeze(ORDEM.filter(p => p.situacao === 'APLICAR'));
const arquivoDe = p => (p.aplicador === 'generico' ? p.arquivo : p.aplicador);
/** Linha de comando de um passo numa fase (o registro do backup entra só no APLICAR). */
function comando(p, fase) {
  assert.ok(FASES.includes(fase), 'FASE_DESCONHECIDA');
  return `node ${arquivoDe(p)} ${fase === 'APLICAR' ? `${p.aplicar} --backup "<registro-do-backup>"${p.aposBackup ? ' ' + p.aposBackup : ''}` : p.conferir}`;
}
/** Regra de volta do passo: 'DEPLOY_ANTERIOR' antes da 094; a partir dela, 'RESTAURAR_BACKUP_OU_CORRIGIR_PARA_A_FRENTE'. */
function volta(id) {
  const i = PASSOS.findIndex(p => p.id === id), corte = PASSOS.findIndex(p => p.id === PONTO_SEM_VOLTA_POR_DEPLOY);
  assert.ok(i >= 0, 'PASSO_DESCONHECIDO');
  return i < corte ? 'DEPLOY_ANTERIOR' : 'RESTAURAR_BACKUP_OU_CORRIGIR_PARA_A_FRENTE';
}
const SIGNIFICADO = Object.freeze({1: 'recusa do aplicador antes de conectar', 2: 'FALHA registrada no marcador (ver a situação do COMMIT)', 3: 'conferência RECUSARIA', 4: 'recusa do bloco de Shell'});
const parar = (motivo, extra = {}) => ({acao: 'PARAR', motivo, ...extra});

/**
 * Função pura: recebe os resultados JÁ obtidos, na ordem em que foram executados — lista de {id, fase, codigo} — e devolve
 * {acao: 'EXECUTAR', id, fase, comando, …} com o próximo, {acao: 'CONCLUIDA'} no fim ou {acao: 'PARAR', motivo, …}.
 * Para em qualquer código diferente do inteiro 0, em resultado fora da sequência (passo ou fase pulados, repetidos ou
 * desconhecidos) e em entrada ilegível. Nunca "pula" um passo: quem decide retomar é Felipe, fora daqui.
 */
function proximoPasso(resultados = []) {
  if (!Array.isArray(resultados)) return parar('RESULTADOS_ILEGIVEIS');
  const sequencia = PASSOS.flatMap(p => FASES.map(fase => ({p, fase})));
  if (resultados.length > sequencia.length) return parar('RESULTADO_ALEM_DA_CADEIA');
  for (let i = 0; i < resultados.length; i++) {
    const r = resultados[i], {p, fase} = sequencia[i];
    if (r === null || typeof r !== 'object') return parar('RESULTADOS_ILEGIVEIS', {posicao: i});
    if (r.id !== p.id || r.fase !== fase) return parar('FORA_DA_ORDEM', {posicao: i, esperado: {id: p.id, fase}, recebido: {id: r.id, fase: r.fase}});
    if (r.codigo !== 0) return parar('CODIGO_DIFERENTE_DE_ZERO', {id: p.id, fase, codigo: r.codigo, significado: SIGNIFICADO[r.codigo] ?? 'código desconhecido ou ausente: parar e ler a saída',
      volta: volta(p.id), reconciliar: fase === 'CONFERIR' ? null : comando(p, 'CONFERIR')});
  }
  if (resultados.length === sequencia.length) return {acao: 'CONCLUIDA', passos: PASSOS.length};
  const {p, fase} = sequencia[resultados.length];
  return {acao: 'EXECUTAR', id: p.id, fase, comando: comando(p, fase), aplicador: p.aplicador, escopo: p.escopo, volta: volta(p.id),
    ...(p.exigeAntes && fase === 'CONFERIR' ? {exigeAntes: p.exigeAntes} : {}), ...(fase === 'APLICAR' ? {exige: 'autorização de Felipe para este passo e backup restaurável registrado'} : {})};
}

/** Texto de docs/PROMOCAO_UNICA_PRODUCTION_20261112.md, gerado só destes dados (o teste confere o arquivo contra isto). */
function roteiro() {
  const L = ['# Promoção única staging → production (roteiro de 12/11/2026)', '',
    '> Gerado por `node scripts/promocao-production-ordem.cjs --roteiro`. Não editar à mão: mudar os dados em `scripts/promocao-production-ordem.cjs` e gerar de novo (o teste confere).', '',
    '**Isto é um roteiro, não uma autorização.** Nada aqui foi executado em production nem em staging. Cada passo continua exigindo, na hora: a autorização específica de Felipe, o backup restaurável registrado (dump conferido + PITR; export funcional não substitui) e os pré-requisitos do plano do próprio aplicador (`node <aplicador>`, sem argumentos, imprime o plano sem conectar).', '',
    '## Regras da cadeia', '',
    '- Onde: Web Shell do web de production (`srv-dak77m2d0e5s73b8rkkg`), com a árvore implantada trazendo os aplicadores, os núcleos e os SQL. Os blocos de Shell conferem o sha256 de cada arquivo implantado antes de rodar.',
    '- Cada passo tem três fases, nesta ordem: **CONFERIR** (só leitura) → **APLICAR** (uma vez; marcador exclusivo no disco persistente) → **CONFERIR** de novo.',
    '- **Qualquer código de saída diferente de 0 para a cadeia.** Não repetir o passo, não seguir para o próximo: copiar a saída e o marcador e decidir com Felipe. `proximoPasso()` deste script devolve PARAR nesses casos.',
    '- A 098 é histórica e **nunca** entra (a 102 e a 108 recusam se ela existir). A 099 e a 105 já estão em production.',
    '- O aplicador da 092–094 de production tem dois escopos: 092-093 e 094. O 094 exige antes o deploy do código novo.',
    `- Os adaptadores de ${PENDENTES_DO_OUTRO_LOTE.map(a => '`' + a + '`').join(', ')} são do outro lote desta promoção: os comandos deles abaixo usam as flags do núcleo e precisam ser conferidos contra o adaptador entregue.`, '',
    '## Colagem interrompida de um bloco de Shell', '',
    'Os blocos de Shell de production desligam a colagem com colchetes (bracketed paste) do readline na primeira linha, guardam o valor anterior na variável `__kmbp` e o restauram na última. Se o bloco for colado pela metade (prompt `>`) e cancelado com Ctrl-C, essa última linha não roda: a colagem com colchetes fica desligada e `__kmbp` fica na sessão. O aplicador não rodou. Antes de colar de novo o MESMO bloco, inteiro, restaurar e limpar com:', '',
    '```bash', '[ -z "$__kmbp" ] || bind "set enable-bracketed-paste $__kmbp" 2>/dev/null; unset __kmbp', '```', '',
    'É o mesmo comando do fim dos blocos. Com `__kmbp` vazia (cancelado antes da primeira linha, ou bloco que não guarda o valor) ele não muda nada; para religar à mão: `bind \'set enable-bracketed-paste on\'`. Na dúvida, fechar o Shell e abrir outro tem o mesmo efeito. Se a colagem chegou a imprimir alguma saída do aplicador, tratar como passo executado: ler a saída e rodar o CONFERIR do passo antes de qualquer decisão.', '',
    '## O que cada resultado significa', '',
    '| Código | Significado | O que fazer |', '|---|---|---|',
    '| 0 | PLANO, PRONTA_PARA_APLICAR, APLICADA_POSTCHECK_PASS ou JA_APLICADA (conferência PASS) | seguir para a próxima fase |',
    '| 1 | recusa do aplicador ANTES de conectar (alvo, disco, backup, argumentos, marcador de tentativa anterior, chave ligada na 117) | parar; nada foi enviado ao banco |',
    '| 2 | FALHA registrada no marcador | parar; ler `commit`/`commits` na saída e rodar o CONFERIR do passo antes de qualquer decisão |',
    '| 3 | conferência RECUSARIA | parar; ler o motivo; nada foi escrito |',
    '| 4 | recusa do bloco de Shell (arquivo divergente, backup não informado, destino) | parar; o aplicador não rodou |',
    '| outro ou sem a linha `CODIGO_SAIDA_BLOCO` | linha perdida, sinal ou colagem incompleta | parar e ler |', '',
    'Situação do COMMIT numa FALHA: `NAO_COMMITADA` (o COMMIT nunca foi enviado: nada aplicado), `CONFIRMADO` (aplicado; a falha veio depois), `DESFEITA_PELO_SERVIDOR` (o servidor recusou o COMMIT: nada aplicado) e `INDETERMINADO` (sem resposta do COMMIT: só o CONFERIR diz se aplicou). Em todos os casos o marcador impede a repetição; retomar exige decisão de Felipe e o marcador anterior renomeado, nunca apagado.', '',
    '## Regra de volta', '',
    `- **Antes da ${PONTO_SEM_VOLTA_POR_DEPLOY}** (passos ${PASSOS.filter(p => volta(p.id) === 'DEPLOY_ANTERIOR').map(p => p.id).join(', ')}): voltar ao deploy anterior basta.`,
    `- **Da ${PONTO_SEM_VOLTA_POR_DEPLOY} em diante**: restaurar o backup registrado ou corrigir para a frente. O down de cada migration (\`database/rollback/\`) nunca é executado pelos aplicadores e só vale com autorização própria e nas condições do próprio arquivo.`, '',
    '## Fora da cadeia', '', '| Migration | Situação | Motivo |', '|---|---|---|',
    ...ORDEM.filter(p => p.situacao !== 'APLICAR').map(p => `| ${p.id} | ${p.situacao} | ${p.escopo} |`), '',
    '## Ordem e comandos', ''];
  PASSOS.forEach((p, i) => {
    L.push(`### ${i + 1}. ${p.id} — ${p.escopo}`, '');
    if (p.exigeAntes) L.push(`**Antes deste passo:** ${p.exigeAntes}.`, '');
    L.push(`- Aplicador: \`${arquivoDe(p)}\`${p.aplicador === 'generico' ? ' (genérico, lista fechada)' : ''}${p.outroLote ? ' — **do outro lote; conferir as flags contra o adaptador entregue**' : ''}`,
      `- CONFERIR: \`${comando(p, 'CONFERIR')}\``, `- APLICAR: \`${comando(p, 'APLICAR')}\``, `- CONFERIR de novo: \`${comando(p, 'CONFERIR_DEPOIS')}\``,
      `- Bloco de Shell: ${p.bloco ? '`' + p.bloco + '`' : 'gerador de production a cargo do outro lote'}`,
      `- Volta: ${volta(p.id) === 'DEPLOY_ANTERIOR' ? 'deploy anterior basta' : 'restaurar o backup ou corrigir para a frente'}`, '');
  });
  L.push('## Pendências conhecidas deste roteiro', '',
    '- Nenhum passo foi ensaiado em PostgreSQL real por este lote: os adaptadores novos e o genérico têm só testes com cliente simulado.',
    '- Regra vigente de deploy: sistema em manutenção, código novo implantado primeiro e depois a cadeia inteira de migrations na ordem deste roteiro; a 092–093 vêm antes da 094 e a 094 exige o código novo já no ar (o que vale nesta ordem). Como e quando a árvore com os aplicadores chega ao web de production é decisão do plano de promoção, não deste roteiro.', '');
  return L.join('\n');
}

if (require.main === module) {
  if (process.argv[2] === '--roteiro') process.stdout.write(roteiro());
  else console.log(JSON.stringify({ordem: ORDEM, pontoSemVoltaPorDeploy: PONTO_SEM_VOLTA_POR_DEPLOY, pendentesDoOutroLote: PENDENTES_DO_OUTRO_LOTE}, null, 2));
}
module.exports = {ORDEM, PASSOS, FASES, GENERICO, PENDENTES_DO_OUTRO_LOTE, PONTO_SEM_VOLTA_POR_DEPLOY, SIGNIFICADO, comando, volta, proximoPasso, roteiro};
