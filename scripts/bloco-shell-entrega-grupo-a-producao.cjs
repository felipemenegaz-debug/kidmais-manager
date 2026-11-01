/* eslint-disable @typescript-eslint/no-require-imports */
// B-4 do plano de promoção (25/10/2026, decisão D-OP-2 opção a): blocos de Shell de PRODUÇÃO que ENTREGAM, antes do código
// novo, os aplicadores do grupo A ao Web Shell do srv-dak77m2d0e5s73b8rkkg. No E3 o artefato publicado ainda é o antigo,
// sem o aplicador da 092/093 (B-1, escopo 092-093). A 099 (B-2) saiu deste pacote em 31/10/2026: o aplicador dela chegou a
// production pelo próprio deploy (E-1, #288) e ela já foi aplicada (JA_APLICADA_POSTCHECK_PASS); no E3 é pré-condição,
// conferida com o aplicador do artefato publicado, nunca entregue, aplicada nem desfeita por estes blocos. Desenho dos blocos
// de produção de 19/10/2026 (scripts/bloco-shell-migracoes-producao-20261019.cjs, revisados e usados: P2-A colagem
// interativa, P3-1 trap preserva o código, P3-2 bind antes da guarda, P3-3 partes ≤ 40 KB), com duas proteções a mais
// pedidas na revisão do B-4 (26/10/2026):
//   - P2-2 CARREGADOR CONFERIDO: o bloco colado é só um carregador mínimo; todo o programa de controle (o "corpo") vai
//     codificado (gzip+base64) e só roda se o sha256 dele bater com o fixado no carregador. Perder uma linha do corpo que
//     altere o texto decodificado = CORPO_DIVERGENTE (4), nada executado; o que executa é sempre o corpo conferido. CODIGO_SAIDA_BLOCO=0 só pode ser impresso pelo corpo conferido (trap de saída
//     dele); perder uma linha do carregador = sem linha de código (parar e ler), 4, ou o corpo conferido rodando normal
//     (ex.: sem o umask, ou C já com exatamente o corpo). O sha confere os bytes do corpo, não a origem do arquivo nem que o
//     carregador foi colado inteiro. O corpo reconfere a guarda de serviço;
//   - P2-1 DESTINO FÍSICO: o destino é um único nome `.kidmais-…` direto sob o deploy (normalizado no gerador); no Shell,
//     antes de criar, montar ou limpar, a pasta precisa existir no lugar físico esperado (`pwd -P`) e nenhum link (inclusive
//     junção) é aceito na pasta, nas subpastas ou nos arquivos.
// Blocos:
//   - PARTE-k-DE-N: só TRANSPORTA uma fração dos arquivos (gzip+base64, sha256 conferido) para
//     /opt/render/project/src/.kidmais-entrega-grupo-a-producao/.partes/<sha256>; repetir é seguro (JA_PRESENTE só com o
//     sha certo); conteúdo divergente para (4) sem gravar nada daquela parte. Não conecta ao banco;
//   - CONFERIR-092-093 / APLICAR-092-093: exigem TODAS as partes íntegras, montam a pasta
//     própria (presente só vale com o sha certo) e rodam o aplicador DA PASTA PRÓPRIA (o `raiz` dos aplicadores é a pasta
//     deles: lê os SQL transportados, nunca os do deploy) com o node_modules do deploy. APLICAR-* exige, ANTES de tocar em
//     arquivo, o registro do backup do E2 (`backup-<uuid>.json` da ferramenta P1, scripts/backup-lancamento-production.cjs,
//     presente no artefato publicado) conferido: serviço, banco, dump presente com o sha256 do registro, lido por inteiro,
//     criado e com PITR conferido há menos de 24 h (item 4 da revisão);
//   - LIMPEZA: remove só arquivos e partes cujo sha confere (divergente preservado) e as pastas vazias; nunca arquivos do
//     deploy nem o disco persistente (/opt/render/project/src/data, onde ficam os marcadores e o backup — inclusive o da
//     099, data/convites-avulsos-099-producao/migration-099.json).
// A lista de arquivos é EXATAMENTE a que o bloco de produção do B-1 já confere (bloco-shell-092-094.cjs,
// `arquivos('production')`). A 094 (E6), a 091 (E6, revisão do B-4) e a 100 rodam do artefato novo.
// Fim esperado: CODIGO_SAIDA_BLOCO=<n> (0/1/2/3 do aplicador, 4 do bloco). Outro código (127, 130, 143) ou ausência da
// linha = parar e ler; prompt `>` depois de colar = colagem incompleta: Ctrl-C e colar o MESMO bloco.
// O bloco gerado é ASCII puro. Este gerador só lê arquivos e escreve; não conecta nem executa nada.
//   node scripts/bloco-shell-entrega-grupo-a-producao.cjs <PARTE-k|CONFERIR-092-093|APLICAR-092-093|LIMPEZA> <rotulo-da-arvore>
//   node scripts/bloco-shell-entrega-grupo-a-producao.cjs TODOS <rotulo-da-arvore> <pasta-de-saida>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const {createHash} = require('node:crypto');
const b1 = require('./bloco-shell-092-094.cjs');

const DEPLOY = '/opt/render/project/src';
const NOME_DESTINO = '.kidmais-entrega-grupo-a-producao';
const DESTINO = DEPLOY + '/' + NOME_DESTINO;
const SERVICO = 'srv-dak77m2d0e5s73b8rkkg';
const BANCO = 'kidmais_production';
/** Pasta do registro de backup da ferramenta P1 (relativa ao deploy; disco persistente). */
const PASTA_BACKUP = 'data/lancamento-venda-20261011';
const LIMITE_PARTE = 40000;
/** Carga útil (base64) por parte: o resto do limite fica para o carregador e o corpo. */
const CARGA_PARTE = 26000;
/** Linhas fixas por arquivo numa parte (prep, livre, inst, delimitadores). */
const SOBRA_POR_ARQUIVO = 320;
/** Modos que rodam aplicador: comando e registro (disco persistente). */
const EXECUCOES = Object.freeze({
  'CONFERIR-092-093': {aplicador: 'scripts/migration-092-094-production.cjs', args: '--conferir-092-093', registro: 'data/agenda-precos-092-094-producao'},
  'APLICAR-092-093': {aplicador: 'scripts/migration-092-094-production.cjs', args: '--aplicar-092-093-autorizado --backup "$B"', registro: 'data/agenda-precos-092-094-producao'},
});
const FIXOS = Object.freeze([...Object.keys(EXECUCOES), 'LIMPEZA']);
const H = '[0-9a-f]';
/** Nome do registro do backup: exatamente o que a ferramenta P1 grava (backup-<uuid>.json). */
const GLOB_REGISTRO = `backup-${H.repeat(8)}-${H.repeat(4)}-${H.repeat(4)}-${H.repeat(4)}-${H.repeat(12)}.json`;
/**
 * Conferência do registro do backup (node do deploy; só lê). Argumentos: registro, sha256 do dump calculado no Shell,
 * serviço e banco esperados. Sai 4 com os campos divergentes; nada é impresso do conteúdo além das datas.
 */
const JS_BACKUP = String.raw`const [j,h,s,b]=process.argv.slice(1);let r;try{r=JSON.parse(require("fs").readFileSync(j,"utf8"))}catch{console.log("BACKUP_REGISTRO_ILEGIVEL");process.exit(4)}`
  + String.raw`const agora=Date.now(),recente=x=>typeof x==="string"&&agora-Date.parse(x)>=0&&agora-Date.parse(x)<864e5;`
  + String.raw`const f=[r.servico!==s&&"servico",r.banco!==b&&"banco",r.arquivo!==require("path").basename(j).replace(/\.json$/,".dump")&&"arquivo",`
  + String.raw`r.sha256!==h&&"sha256",r.arquivoIntegralmenteLido!==true&&"arquivoIntegralmenteLido",!recente(r.criadoEm)&&"criadoEm",!recente(r.pitrConferidoEm)&&"pitrConferidoEm"].filter(Boolean);`
  + String.raw`if(f.length){console.log("BACKUP_REGISTRO_RECUSADO "+f.join(" "));process.exit(4)}console.log("BACKUP_CONFERIDO criadoEm "+r.criadoEm+" pitrConferidoEm "+r.pitrConferidoEm)`;

/** Arquivos (sem repetição, na ordem) que o bloco de produção do B-1 confere. A 099 não entra: já aplicada em production. */
function arquivos() {
  return [...new Set(b1.arquivos('production'))];
}
const sha = b => createHash('sha256').update(b).digest('hex');
/** Conteúdo LF; os SQL têm o hash revisado de cada aplicador (o gerador recusa divergência, como os blocos de origem). */
function ler(raiz, arquivo) {
  const texto = fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(!texto.includes('\r'), 'CR_ISOLADO ' + arquivo);
  return Buffer.from(texto, 'utf8');
}
const seguro = s => { assert.match(s, /^[A-Za-z0-9_./-]+$/, 'CAMINHO_INSEGURO'); assert.ok(!s.split('/').includes('..'), 'CAMINHO_INSEGURO'); return s; };
const b64 = buf => zlib.gzipSync(buf, {level: 9}).toString('base64').match(/.{1,76}/g);
/** Arquivos com conteúdo, sha e carga gzip+base64 (determinística), agrupados em partes pela ordem da lista. */
function distribuir(raiz = path.resolve(__dirname, '..')) {
  // O gerador de origem confere os hashes revisados dos SQL: gerar um bloco dele falha se algum divergir.
  b1.gerar({ambiente: 'production', modo: 'CONFERIR', rotulo: 'abcdef1', raiz});
  const lista = arquivos().map(a => { const b = ler(raiz, a); return {arquivo: seguro(a), sha: sha(b), b64: b64(b)}; });
  const partes = [];
  for (const x of lista) {
    const tam = x.b64.join('\n').length + SOBRA_POR_ARQUIVO;
    assert.ok(tam < CARGA_PARTE, 'ARQUIVO_MAIOR_QUE_A_PARTE ' + x.arquivo);
    if (!partes.length || partes.at(-1).carga + tam > CARGA_PARTE) partes.push({carga: 0, itens: []});
    partes.at(-1).itens.push(x); partes.at(-1).carga += tam;
  }
  lista.forEach(x => { x.parte = partes.findIndex(p => p.itens.includes(x)) + 1; });
  return {lista, partes};
}
const modos = (raiz = path.resolve(__dirname, '..')) => [...distribuir(raiz).partes.map((_, i) => `PARTE-${i + 1}`), ...FIXOS];
const totalPartes = (raiz = path.resolve(__dirname, '..')) => distribuir(raiz).partes.length;

/** Deploy e destino normalizados: destino = um único nome `.kidmais-…` diretamente sob o deploy (nunca o deploy, fora dele ou data/). */
function caminhos(deploy, destino) {
  for (const d of [deploy, destino]) {
    assert.match(d, /^(?:[A-Za-z]:)?\/[A-Za-z0-9_./-]+$/, 'DESTINO_INVALIDO');
    assert.ok(!d.split('/').some(s => s === '..' || s === '.'), 'DESTINO_INVALIDO');
  }
  const p = path.posix.normalize(deploy).replace(/\/+$/, ''), q = path.posix.normalize(destino).replace(/\/+$/, '');
  const nome = path.posix.basename(q);
  assert.ok(path.posix.dirname(q) === p && /^\.kidmais-[a-z0-9-]+$/.test(nome), 'DESTINO_INVALIDO');
  return {deploy: p, destino: q, nome};
}

function cabecalho(modo, n, rotulo) {
  const nome = /^PARTE-\d+$/.test(modo) ? `${modo}-DE-${n}` : modo;
  const exige = 'Exige as PARTES 1..' + n + ' coladas antes (nesta mesma instancia). Monta a pasta propria (efemera) e roda o aplicador DELA.';
  const ja099 = 'A 099 ja esta aplicada em production (31/10/2026) e NAO faz parte deste pacote: conferir antes com o aplicador do deploy.';
  const backup = 'ANTES de colar, no mesmo shell: export KIDMAIS_REGISTRO_BACKUP=backup-<uuid>.json (registro do E2 em data/lancamento-venda-20261011:';
  const backup2 = 'dump conferido + PITR ha menos de 24 h; o bloco confere servico, banco, sha256 do dump e datas antes de gravar qualquer arquivo).';
  const titulo = {
    'CONFERIR-092-093': ['SOMENTE LEITURA no banco - E3 (codigo ANTIGO publicado). ' + exige,
      'Roda --conferir-092-093 (B-1): identidade, estado, privilegios e checks SO do escopo 092-093; confirma a 094 AUSENTE.', ja099],
    'APLICAR-092-093': ['ESCRITA (DDL) EM PRODUCAO - E3: somente com a autorizacao especifica do escopo 092-093, codigo ANTIGO publicado.', backup, backup2, exige,
      'Roda --aplicar-092-093-autorizado UMA vez (092 e 093; NUNCA a 094). Se parar, NAO repetir: copiar a saida, CONFERIR-092-093 e seguir o ENC.', ja099],
    LIMPEZA: ['Remove da pasta propria so arquivos e partes cujo sha256 confere, e as pastas vazias; nunca arquivos do deploy nem',
      'registros/marcadores/backup do disco persistente. Nao conecta ao banco. Opcional: a pasta propria some no proximo deploy.'],
  }[modo] ?? [`TRANSPORTE ${modo}-DE-${n}: grava parte dos aplicadores do grupo A em .partes/ (sha256 conferido). Nao conecta ao banco.`,
    'Repetir e seguro (JA_PRESENTE). Depois de todas as partes: CONFERIR-092-093 (ou APLICAR-092-093, com autorizacao).'];
  return ['#!/usr/bin/env bash',
    `# BLOCO-SHELL-ENTREGA-GRUPO-A-PRODUCAO-${nome} - Web Shell do ${SERVICO} (kidmais-manager-production). Colar inteiro, uma vez, e Enter.`,
    ...titulo.map(t => '# ' + t),
    `# Gerado da arvore ${rotulo} por scripts/bloco-shell-entrega-grupo-a-producao.cjs. Conferir sha256 e bytes antes de colar.`,
    '# Se aparecer o prompt ">" depois de colar (colagem incompleta): Ctrl-C, nunca colar por cima; depois colar o MESMO bloco.',
    '# Fim esperado: CODIGO_SAIDA_BLOCO=<n> (0/1/2/3 aplicador, 4 bloco). Outro codigo (127, 130, 143...) ou sem essa linha = parar e ler.',
    '# Carregador: o programa vai codificado (CORPO) e so roda se o sha256 bater; o que executa e sempre o corpo conferido.',
    '# O bind abaixo roda ANTES da guarda e FORA do subshell: desliga o bracketed paste pelo resto desta sessao. A guarda de',
    '# RENDER_SERVICE_ID vem antes de qualquer leitura/gravacao (e o corpo a repete). Corpo em processo proprio: nada vaza.',
    "bind 'set enable-bracketed-paste off' 2>/dev/null",
    `if [ "$RENDER_SERVICE_ID" != "${SERVICO}" ]; then echo "SHELL_ERRADO_NAO_E_PRODUCAO ($RENDER_SERVICE_ID): nada executado"; else`];
}

/**
 * Programa de controle (texto bash) de um modo — vai codificado dentro do bloco e só roda conferido. `destino`, `deploy` e
 * `comando` existem para os testes locais (pastas temporárias; comando substituto que só devolve um código).
 */
function corpo({modo, raiz = path.resolve(__dirname, '..'), destino = DESTINO, deploy = DEPLOY, comando}) {
  const {lista, partes} = distribuir(raiz);
  const n = partes.length;
  const parte = /^PARTE-(\d+)$/.exec(String(modo));
  assert.ok(FIXOS.includes(modo) || (parte && Number(parte[1]) >= 1 && Number(parte[1]) <= n), 'MODO_DESCONHECIDO');
  const c = caminhos(deploy, destino);
  const execucao = EXECUCOES[modo];
  // Saída: o código (inclusive 4 do bloco e sinais) sai SEMPRE daqui; remove o temporário da parte sem mudar o código.
  // P2-N1: T zerado ANTES do trap — um T herdado do ambiente (exportado no Shell) nunca é removido; só o mktemp da parte o define.
  // P3-N2: comando que falha sob set -e antes do fim (ex.: find/mkdir) diz onde parou em vez de sair 1 mudo.
  const L = ['T=', 'fim() { c=$?; if [ -n "${T:-}" ]; then rm -rf -- "$T" || echo "TEMPORARIO_NAO_REMOVIDO $T"; fi; echo "CODIGO_SAIDA_BLOCO=$c"; }', 'trap fim EXIT',
    'trap \'echo "BLOCO_PAROU_COMANDO_FALHOU (linha $LINENO do programa): nada depois deste ponto foi feito; ler a linha anterior"\' ERR',
    'set -euo pipefail', 'umask 077',
    `[ "\${RENDER_SERVICE_ID:-}" = "${SERVICO}" ] || { echo "SHELL_ERRADO_NAO_E_PRODUCAO: nada executado"; exit 4; }`];
  if (modo.startsWith('APLICAR-')) {
    // Antes de qualquer arquivo: o registro do backup do E2 conferido (item 4 da revisão). Ao aplicador vai o caminho relativo.
    L.push(`case "\${KIDMAIS_REGISTRO_BACKUP:-}" in ${GLOB_REGISTRO}) ;; *) echo "BACKUP_NAO_INFORMADO export KIDMAIS_REGISTRO_BACKUP=backup-<uuid>.json (registro do E2: dump conferido + PITR) antes de colar"; exit 4 ;; esac`,
      `R='${c.deploy}/${PASTA_BACKUP}'; J="$R/$KIDMAIS_REGISTRO_BACKUP"; D="\${J%.json}.dump"`,
      'for x in "$R" "$J" "$D"; do [ ! -L "$x" ] || { echo "BACKUP_LINK_RECUSADO"; exit 4; }; done',
      '[ -d "$R" ] && [ -f "$J" ] && [ -s "$D" ] || { echo "BACKUP_NAO_ENCONTRADO $KIDMAIS_REGISTRO_BACKUP"; exit 4; }',
      'command -v node >/dev/null && command -v sha256sum >/dev/null || { echo "FERRAMENTA_AUSENTE node/sha256sum"; exit 4; }',
      'HD="$(sha256sum "$D" | cut -d" " -f1)"',
      `node -e '${JS_BACKUP}' "$J" "$HD" '${SERVICO}' '${BANCO}' || exit 4`,
      `B='${PASTA_BACKUP}/'"$KIDMAIS_REGISTRO_BACKUP"`);
  }
  L.push(`cd '${c.deploy}' || { echo "DEPLOY_INACESSIVEL"; exit 4; }`,
    'for f in sha256sum base64 gzip mktemp node find; do command -v "$f" >/dev/null || { echo "FERRAMENTA_AUSENTE $f"; exit 4; }; done');
  if (execucao) L.push('[ -f node_modules/pg/package.json ] || { echo "DEPENDENCIA_AUSENTE node_modules/pg"; exit 4; }');
  // Lugar físico (P2-1): sem link no destino; existente só como pasta; depois de entrar, `pwd -P` = deploy físico/nome.
  L.push('P="$(pwd -P)"', `[ ! -L '${c.nome}' ] || { echo "LINK_RECUSADO ${c.nome}"; exit 4; }`);
  if (modo === 'LIMPEZA') L.push(`[ -e '${c.nome}' ] || { echo "NADA_A_LIMPAR"; exit 0; }`);
  L.push(`[ ! -e '${c.nome}' ] || [ -d '${c.nome}' ] || { echo "DESTINO_NAO_E_PASTA ${c.nome}"; exit 4; }`,
    `mkdir -p '${c.nome}' && cd '${c.nome}' || { echo "DESTINO_INACESSIVEL"; exit 4; }`,
    `[ "$(pwd -P)" = "$P/${c.nome}" ] || { echo "DESTINO_FORA_DO_LUGAR $(pwd -P)"; exit 4; }`,
    'k="$(find . -type l -print 2>/dev/null | head -n 1)"; [ -z "$k" ] || { echo "LINK_RECUSADO $k"; exit 4; }',
    'mkdir -p .partes', 'h() { sha256sum "$1" | cut -d" " -f1; }');
  if (parte) {
    const k = Number(parte[1]), itens = partes[k - 1].itens;
    L.push('T="$(mktemp -d)" || { echo "TEMPORARIO_FALHOU"; exit 4; }',
      'prep() { { base64 -d | gzip -dc > "$T/$1"; } 2>/dev/null || { echo "CONTEUDO_DIVERGENTE $2"; exit 4; }; [ "$(h "$T/$1")" = "$1" ] || { echo "CONTEUDO_DIVERGENTE $2"; exit 4; }; }',
      'livre() { [ ! -e ".partes/$1" ] || [ "$(h ".partes/$1")" = "$1" ] || { echo "PARTE_EXISTE_DIFERENTE $1"; exit 4; }; }',
      'inst() { if [ -e ".partes/$1" ]; then [ "$(h ".partes/$1")" = "$1" ] || { echo "PARTE_EXISTE_DIFERENTE $1"; exit 4; }; echo "JA_PRESENTE $2"; else cp "$T/$1" ".partes/$1" || { echo "GRAVACAO_FALHOU $2"; exit 4; }; echo "TRANSPORTADO $2"; fi; }');
    for (const x of itens) L.push(`prep ${x.sha} ${x.arquivo} <<'B64'`, ...x.b64, 'B64');
    // Fase 2 só depois de TODOS os itens da parte conferidos.
    for (const x of itens) L.push(`livre ${x.sha}`);
    for (const x of itens) L.push(`inst ${x.sha} ${x.arquivo}`);
    L.push(`echo "PARTE_${k}_DE_${n}_OK ${itens.length} arquivos"`);
  } else if (modo === 'LIMPEZA') {
    L.push('limpar() { if [ ! -e "$1" ]; then echo "AUSENTE $1"; elif [ "$(h "$1")" = "$2" ]; then rm -f -- "$1" || { echo "REMOCAO_FALHOU $1"; exit 4; }; echo "REMOVIDO $1"; else echo "DIVERGENTE_PRESERVADO $1"; fi; }');
    for (const x of lista) L.push(`limpar ${x.arquivo} ${x.sha}`);
    for (const x of lista) L.push(`limpar .partes/${x.sha} ${x.sha}`);
    L.push('find . -mindepth 1 -depth -type d -empty -delete 2>/dev/null || true', 'cd "$P"',
      `rmdir '${c.nome}' 2>/dev/null && echo "PASTA_REMOVIDA" || echo "PASTA_MANTIDA (arquivos divergentes preservados)"`, 'echo LIMPEZA_FIM');
  } else {
    const cmd = comando === undefined ? `NODE_PATH='${c.deploy}/node_modules' node ${execucao.aplicador} ${execucao.args}` : comando;
    // Montagem só com TODAS as partes presentes e íntegras; senão diz qual parte colar e não grava nada.
    L.push('falta=0', 'tem() { [ -f ".partes/$1" ] && [ "$(h ".partes/$1")" = "$1" ] || { echo "PARTE_AUSENTE_OU_DIVERGENTE $2 (colar a PARTE-$3)"; falta=1; }; }');
    for (const x of lista) L.push(`tem ${x.sha} ${x.arquivo} ${x.parte}`);
    L.push(`[ "$falta" = 0 ] || { echo "MONTAGEM_RECUSADA: colar as partes indicadas (1..${n}) e repetir este bloco"; exit 4; }`,
      'livre() { [ ! -e "$1" ] || [ "$(h "$1")" = "$2" ] || { echo "JA_EXISTE_DIFERENTE $1"; exit 4; }; }',
      'inst() { if [ -e "$1" ]; then [ "$(h "$1")" = "$2" ] || { echo "JA_EXISTE_DIFERENTE $1"; exit 4; }; echo "JA_PRESENTE $1"; else { mkdir -p "$(dirname "$1")" && cp ".partes/$2" "$1"; } || { echo "GRAVACAO_FALHOU $1"; exit 4; }; echo "ESCRITO $1"; fi; }');
    for (const x of lista) L.push(`livre ${x.arquivo} ${x.sha}`);
    for (const x of lista) L.push(`inst ${x.arquivo} ${x.sha}`);
    L.push(`echo "ARQUIVOS_OK ${lista.length}"`);
    if (cmd) L.push('codigo=0', `${cmd} || codigo=$?`, `echo '=== REGISTRO (${execucao.registro}) ==='`,
      `ls -1 '${c.deploy}/${execucao.registro}' 2>/dev/null || echo "SEM_REGISTRO ${execucao.registro}"`, 'exit "$codigo"');
    else L.push('echo "SEM_APLICADOR (teste)"');
  }
  return L.join('\n') + '\n';
}

/**
 * Abertura do carregador (P3-N1/P2-R3-1/P2-R4-1/P3-R5-2): subshell sem C/T do shell do operador. `\command builtin`
 * resolve o unset sem alias (a barra) e sem uma função `builtin`; se a remoção falhar (C ou T somente leitura), recusa
 * com 4. Limite: uma FUNÇÃO `command` do operador anula a abertura (o unset não roda e não há recusa explícita) — residual
 * declarado. É uma camada a mais: a proteção do arquivo do operador não depende dela (ver LINHA_TEMPORARIO).
 */
const ABERTURA_CARREGADOR = '( \\command builtin unset -v C T || { echo "VARIAVEIS_DO_CARREGADOR_NAO_LIMPAS (C/T somente leitura neste shell): abrir uma sessao nova do Shell; nada executado"; echo "CODIGO_SAIDA_BLOCO=4"; exit 4; }';

/**
 * Temporário + trap + escrita do corpo, encadeados numa única linha: ou tudo (C novo, trap dele, corpo escrito nele) ou nada.
 * Falha de base64/gzip não interrompe (o sha confere depois); falha do mktemp ou do trap = 4 sem escrever.
 */
const LINHA_TEMPORARIO = 'C="$(mktemp)" && trap \'rm -f -- "$C"\' EXIT && { { base64 -d | gzip -dc > "$C"; } 2>/dev/null; true; } <<\'CORPO\' || { echo "TEMPORARIO_FALHOU"; echo "CODIGO_SAIDA_BLOCO=4"; exit 4; }';

/**
 * Bloco colado: guarda + carregador mínimo que decodifica o corpo, confere o sha256 e só então o executa num bash próprio
 * (sem BASH_ENV/ENV). `alterarCorpo` existe só para os testes das defesas internas (o sha passa a ser o do corpo alterado).
 */
function gerar({modo, rotulo, raiz, destino, deploy, comando, alterarCorpo = x => x}) {
  const n = totalPartes(raiz);
  assert.match(String(rotulo), /^[0-9a-f]{7,40}$/, 'ROTULO_INVALIDO');
  const texto = Buffer.from(alterarCorpo(corpo({modo, raiz, destino, deploy, comando})), 'utf8');
  const shaCorpo = sha(texto);
  // P3-N1/P2-R3-1/P2-R4-1: o subshell começa sem C/T do shell do operador; e o temporário, o trap e a escrita do corpo
  // estão numa linha só (LINHA_TEMPORARIO): perder essa linha não arma trap nem escreve em lugar nenhum — um C herdado só é
  // LIDO pela conferência do sha: conteúdo diferente do corpo = 4; exatamente o corpo conferido = esse corpo executa.
  const carregador = [ABERTURA_CARREGADOR, 'umask 077', LINHA_TEMPORARIO, ...b64(texto), 'CORPO',
    `if [ "$(sha256sum "$C" 2>/dev/null | cut -d" " -f1)" = "${shaCorpo}" ]; then env -u BASH_ENV -u ENV bash "$C"; else echo "CORPO_DIVERGENTE: bloco incompleto ou alterado, nada executado"; echo "CODIGO_SAIDA_BLOCO=4"; exit 4; fi`,
    ')'];
  const bloco = [...cabecalho(modo, n, rotulo), ...carregador, 'fi'].join('\n') + '\n';
  assert.match(bloco, /^[\x09\x0a\x20-\x7e]*$/, 'BLOCO_NAO_ASCII');
  assert.ok(Buffer.byteLength(bloco) <= LIMITE_PARTE, 'BLOCO_MAIOR_QUE_40KB ' + modo);
  return bloco;
}
const nomeArquivo = (modo, n) => `BLOCO-SHELL-ENTREGA-GRUPO-A-PRODUCAO-${/^PARTE-\d+$/.test(modo) ? `${modo}-DE-${n}` : modo}.sh`;

if (require.main === module) {
  try {
    const [modo, rotulo, saida] = process.argv.slice(2);
    if (modo === 'TODOS') {
      assert.ok(saida && !fs.existsSync(saida), 'PASTA_DE_SAIDA_INVALIDA_OU_EXISTENTE');
      fs.mkdirSync(saida, {recursive: true});
      const lista = modos(), n = totalPartes();
      for (const m of lista) {
        const bloco = gerar({modo: m, rotulo});
        fs.writeFileSync(path.join(saida, nomeArquivo(m, n)), bloco, {flag: 'wx'});
        console.log(`${sha(Buffer.from(bloco, 'utf8'))}  ${Buffer.byteLength(bloco, 'utf8')}  ${nomeArquivo(m, n)}`);
      }
    } else {
      const bloco = gerar({modo, rotulo});
      process.stdout.write(bloco);
      console.error(`${nomeArquivo(modo, totalPartes())} sha256 ${sha(Buffer.from(bloco, 'utf8'))} (${Buffer.byteLength(bloco, 'utf8')} bytes)`);
    }
  } catch (e) { console.error('RECUSADO ' + String(e?.message ?? e).slice(0, 160)); process.exitCode = 1; }
}
module.exports = {DEPLOY, DESTINO, NOME_DESTINO, ABERTURA_CARREGADOR, LINHA_TEMPORARIO, SERVICO, BANCO, PASTA_BACKUP, EXECUCOES, FIXOS, LIMITE_PARTE, JS_BACKUP, arquivos, totalPartes, distribuir, modos, caminhos, corpo, gerar, nomeArquivo};
