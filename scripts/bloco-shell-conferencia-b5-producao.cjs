/* eslint-disable @typescript-eslint/no-require-imports */
// B-5 do plano de promoção (26/10/2026): blocos de Shell de PRODUÇÃO que entregam e rodam a conferência SOMENTE LEITURA
// scripts/conferencia-b5-producao.cjs no Web Shell do srv-dak77m2d0e5s73b8rkkg. No E1 e na E2c o artefato publicado ainda é o
// antigo, sem o agregador nem os núcleos de estado. Desenho adaptado do gerador do B-4
// (scripts/bloco-shell-entrega-grupo-a-producao.cjs, rodada 3, sha 2296846f…, ainda em revisão): carregador conferido por
// sha256 (só o corpo conferido imprime CODIGO_SAIDA_BLOCO=0), destino físico sem links, partes ≤ 40 KB, T zerado antes do
// trap, `builtin unset -v C T` na abertura, trap ERR com o motivo. Unificar os dois geradores depois do aceite do B-4 é
// pendência registrada. Diferenças: só leitura — sem APLICAR, sem backup, sem registro em disco persistente.
//   - PARTE-k-DE-N: transporta os 31 arquivos (gzip+base64, sha256 conferido) para
//     /opt/render/project/src/.kidmais-conferencia-b5-producao/.partes/<sha256>. Não conecta ao banco;
//   - CONFERIR-B5-COM-CONTA e CONFERIR-B5-SEM-CONTA (E1): montam a pasta própria e rodam `--conferir-b5` (estados 089–118,
//     combinados, matriz, B-15 reescopado e Fundador SEM provedor, §9.2.7) com o ramo do provedor rotulado no próprio bloco
//     (revisão Astra r1, P2-D): cola-se só o do ramo que o registro SEPARADO da §9.2.2 confirmar (conta Asaas Demerzel existe
//     = COM-CONTA, a referência). Nenhum dos dois consulta o provedor; as ASAAS_* são retiradas do ambiente do node;
//   - CONFERIR-B5-ESTADO (E2c): idem com `--conferir-b5-estado` (identidade, estados, combinados e matriz; 091/094 ausentes);
//   - LIMPEZA: remove só arquivos e partes cujo sha confere; nunca o deploy nem data/.
// Fim esperado: CODIGO_SAIDA_BLOCO=<n> (0 CONFERIDO, 1 recusa antes de conectar, 2 FALHA, 3 PARAR; 4 bloco). Outro código ou
// ausência da linha = parar e ler; prompt `>` depois de colar = Ctrl-C e colar o MESMO bloco.
//   node scripts/bloco-shell-conferencia-b5-producao.cjs <PARTE-k|CONFERIR-B5-COM-CONTA|CONFERIR-B5-SEM-CONTA|CONFERIR-B5-ESTADO|LIMPEZA> <rotulo-da-arvore>
//   node scripts/bloco-shell-conferencia-b5-producao.cjs TODOS <rotulo-da-arvore> <pasta-de-saida>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const {createHash} = require('node:crypto');
const b5 = require('./conferencia-b5-producao.cjs');

const DEPLOY = '/opt/render/project/src';
const NOME_DESTINO = '.kidmais-conferencia-b5-producao';
const DESTINO = DEPLOY + '/' + NOME_DESTINO;
const SERVICO = 'srv-dak77m2d0e5s73b8rkkg';
const LIMITE_PARTE = 40000;
const CARGA_PARTE = 31000;
const SOBRA_POR_ARQUIVO = 320;
const AGREGADOR = 'scripts/conferencia-b5-producao.cjs';
/**
 * Ramo do provedor declarado no E1 (§9.2.7), um bloco rotulado por ramo (revisão Astra r1, P2-D): o gerador não escolhe.
 * Referência: a conta Asaas Demerzel existe (memória 02/11) ⇒ COM-CONTA; o SEM-CONTA existe para o registro separado da
 * §9.2.2 que disser o contrário. Os dois só declaram: nenhum consulta o provedor.
 */
const RAMOS_BLOCO = Object.freeze({'CONFERIR-B5-COM-CONTA': 'com-conta', 'CONFERIR-B5-SEM-CONTA': 'sem-conta'});
const EXECUCOES = Object.freeze({
  ...Object.fromEntries(Object.entries(RAMOS_BLOCO).map(([modo, ramo]) => [modo, {args: b5.FLAG_COMPLETO, etapa: 'E1', ramo}])),
  'CONFERIR-B5-ESTADO': {args: b5.FLAG_ESTADO, etapa: 'E2c'},
});
/** As ASAAS_* saem do ambiente do node (defesa em profundidade: o agregador nem as lê, §9.2.4 L1). */
const SEM_ASAAS = 'env -u ASAAS_API_KEY -u ASAAS_WEBHOOK_TOKEN -u ASAAS_AMBIENTE';
/** Contrato TS da 109 (capacidadeRenovacao), conferido por sha256 (n109.CONTRATO) e importado com --experimental-strip-types. */
const CONTRATO_109 = Object.freeze(['lib/assinatura/renovacao-schema.ts', 'lib/assinatura/renovacao-schema-retratos.ts']);
/** Integridade de catálogo da 105 (revisão Astra r2, A): o arquivo revisado do aplicador, conferido pelo sha256 de ETAPAS. */
const INTEGRIDADE_105 = b5.INTEGRIDADE_105[1];
const FIXOS = Object.freeze([...Object.keys(EXECUCOES), 'LIMPEZA']);

/**
 * Agregador, trava de produção do B-1, os núcleos de estado na ordem do B-5 (a 098 não tem núcleo) e os módulos da 107/108
 * que os núcleos da 092–094 e da 100 carregam (o da 100 no require; ad7fbee9) e que o próprio agregador usa nos combinados
 * (B-21: constantes NOVA de migration-108-retrato.cjs). O B-5 só usa SQL_ESTADO/lerEstado e essas constantes, que não leem
 * os arquivos de dados da 108 (retrato e retratos esperados ficam de fora).
 */
const MODULOS_108 = Object.freeze(['scripts/migration-108-evidencias.cjs', 'scripts/migration-108-retrato.cjs', 'scripts/migration-108-inventario.cjs',
  'scripts/migration-107-definicoes.cjs']);
/**
 * Módulos que migration-105-comum.cjs carrega no require desde a rodada staging-r1 (definições e relações da 105). Sem eles o
 * pacote montado não carrega o núcleo da 105 (MODULE_NOT_FOUND na pasta própria).
 */
const MODULOS_105 = Object.freeze(['scripts/migration-105-definicoes.cjs', 'scripts/migration-105-relacoes.cjs']);
function arquivos() {
  const nucleos = [...b5.MIGRACOES, ...b5.AMPLIADAS].map(([, m]) => m.replace('./', 'scripts/'));
  return [...new Set([AGREGADOR, 'scripts/conferencia-b5-105.cjs', 'scripts/conferencia-b5-satisfacao.cjs', 'scripts/migration-092-094-production.cjs', ...nucleos, ...MODULOS_108, ...CONTRATO_109, INTEGRIDADE_105, ...MODULOS_105])];
}
const sha = b => createHash('sha256').update(b).digest('hex');
function ler(raiz, arquivo) {
  const texto = fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(!texto.includes('\r'), 'CR_ISOLADO ' + arquivo);
  return Buffer.from(texto, 'utf8');
}
const seguro = s => { assert.match(s, /^[A-Za-z0-9_./-]+$/, 'CAMINHO_INSEGURO'); assert.ok(!s.split('/').includes('..'), 'CAMINHO_INSEGURO'); return s; };
const b64 = buf => zlib.gzipSync(buf, {level: 9}).toString('base64').match(/.{1,76}/g);
function distribuir(raiz = path.resolve(__dirname, '..')) {
  const lista = arquivos().map(a => { const b = ler(raiz, a); return {arquivo: seguro(a), sha: sha(b), b64: b64(b)}; });
  // Primeiro encaixe, do maior para o menor (determinístico; empate pela ordem da lista): menos partes para colar com 31 arquivos.
  const partes = [];
  const ordem = lista.map((x, i) => ({x, i, tam: x.b64.join('\n').length + SOBRA_POR_ARQUIVO})).sort((a, b) => b.tam - a.tam || a.i - b.i);
  for (const {x, tam} of ordem) {
    assert.ok(tam < CARGA_PARTE, 'ARQUIVO_MAIOR_QUE_A_PARTE ' + x.arquivo);
    let p = partes.find(q => q.carga + tam <= CARGA_PARTE);
    if (!p) partes.push(p = {carga: 0, itens: []});
    p.itens.push(x); p.carga += tam;
  }
  for (const p of partes) p.itens.sort((a, b) => lista.indexOf(a) - lista.indexOf(b));
  lista.forEach(x => { x.parte = partes.findIndex(p => p.itens.includes(x)) + 1; });
  return {lista, partes};
}
const modos = (raiz = path.resolve(__dirname, '..')) => [...distribuir(raiz).partes.map((_, i) => `PARTE-${i + 1}`), ...FIXOS];
const totalPartes = (raiz = path.resolve(__dirname, '..')) => distribuir(raiz).partes.length;

/** Destino = um único nome `.kidmais-…` diretamente sob o deploy (nunca o deploy, fora dele ou data/). */
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
  const exige = 'Exige as PARTES 1..' + n + ' coladas antes (nesta mesma instancia). Monta a pasta propria (efemera) e roda a conferencia DELA.';
  const titulo = {
    ...Object.fromEntries(Object.entries(RAMOS_BLOCO).map(([modo, ramo]) => [modo, ['SOMENTE LEITURA - E1 (autorizacao A1). ' + exige,
      'Roda --conferir-b5: estados de 089-118 (prefixo antes do E3: base 088 + 099 + 105), combinados 098/108 (B-21),',
      'matriz da 9.2.2 por contagens (REPEATABLE READ READ ONLY), B-15 reescopado e Fundador sem provedor (nada lido do Asaas).',
      `RAMO DO PROVEDOR DECLARADO NESTE BLOCO: ${ramo.toUpperCase()}. Colar so se o registro SEPARADO da 9.2.2 (painel ou declaracao)`,
      `confirmar ${ramo === 'com-conta' ? 'que a conta Asaas Demerzel existe' : 'que NAO ha conta Asaas'}; senao, colar o bloco do outro ramo. Nunca os dois.`,
      'Saida sem ids, documentos, e-mails ou valores. Codigo 2 = FALHA (consulta/leitura), 3 = PARAR com motivos nomeados.']])),
    'CONFERIR-B5-ESTADO': ['SOMENTE LEITURA - E2c (autorizacao A2c). ' + exige,
      'Roda --conferir-b5-estado: identidade, estados 089-118, combinados 098/108 (B-21) e matriz; 091 e 094 tem de estar ausentes.',
      'Nao le documentos, Fundador nem o Asaas.'],
    LIMPEZA: ['Remove da pasta propria so arquivos e partes cujo sha256 confere, e as pastas vazias; nunca arquivos do deploy nem',
      'o disco persistente. Nao conecta ao banco. Opcional: a pasta propria some no proximo deploy.'],
  }[modo] ?? [`TRANSPORTE ${modo}-DE-${n}: grava parte da conferencia B-5 em .partes/ (sha256 conferido). Nao conecta ao banco.`,
    'Repetir e seguro (JA_PRESENTE). Depois de todas as partes: CONFERIR-B5-COM-CONTA ou -SEM-CONTA (E1) ou CONFERIR-B5-ESTADO (E2c).'];
  return ['#!/usr/bin/env bash',
    `# BLOCO-SHELL-CONFERENCIA-B5-PRODUCAO-${nome} - Web Shell do ${SERVICO} (kidmais-manager-production). Colar inteiro, uma vez, e Enter.`,
    ...titulo.map(t => '# ' + t),
    `# Gerado da arvore ${rotulo} por scripts/bloco-shell-conferencia-b5-producao.cjs. Conferir sha256 e bytes antes de colar.`,
    '# Se aparecer o prompt ">" depois de colar (colagem incompleta): Ctrl-C, nunca colar por cima; depois colar o MESMO bloco.',
    '# Fim esperado: CODIGO_SAIDA_BLOCO=<n> (0/1/2/3 conferencia, 4 bloco). Outro codigo (127, 130, 143...) ou sem essa linha = parar e ler.',
    '# Carregador: o programa vai codificado (CORPO) e so roda se o sha256 bater; qualquer linha perdida = nada executado.',
    '# O bind abaixo roda ANTES da guarda e FORA do subshell: desliga o bracketed paste pelo resto desta sessao. A guarda de',
    '# RENDER_SERVICE_ID vem antes de qualquer leitura/gravacao (e o corpo a repete). Corpo em processo proprio: nada vaza.',
    "bind 'set enable-bracketed-paste off' 2>/dev/null",
    `if [ "$RENDER_SERVICE_ID" != "${SERVICO}" ]; then echo "SHELL_ERRADO_NAO_E_PRODUCAO ($RENDER_SERVICE_ID): nada executado"; else`];
}

/** Programa de controle de um modo (vai codificado no bloco). `destino`, `deploy` e `comando` existem para os testes. */
function corpo({modo, raiz = path.resolve(__dirname, '..'), destino = DESTINO, deploy = DEPLOY, comando}) {
  const {lista, partes} = distribuir(raiz);
  const n = partes.length;
  const parte = /^PARTE-(\d+)$/.exec(String(modo));
  assert.ok(FIXOS.includes(modo) || (parte && Number(parte[1]) >= 1 && Number(parte[1]) <= n), 'MODO_DESCONHECIDO');
  const c = caminhos(deploy, destino);
  const execucao = EXECUCOES[modo];
  // T zerado antes do trap (um T herdado nunca é removido); trap ERR diz onde parou.
  const L = ['T=', 'fim() { c=$?; if [ -n "${T:-}" ]; then rm -rf -- "$T" || echo "TEMPORARIO_NAO_REMOVIDO $T"; fi; echo "CODIGO_SAIDA_BLOCO=$c"; }', 'trap fim EXIT',
    'trap \'echo "BLOCO_PAROU_COMANDO_FALHOU (linha $LINENO do programa): nada depois deste ponto foi feito; ler a linha anterior"\' ERR',
    'set -euo pipefail', 'umask 077',
    `[ "\${RENDER_SERVICE_ID:-}" = "${SERVICO}" ] || { echo "SHELL_ERRADO_NAO_E_PRODUCAO: nada executado"; exit 4; }`,
    `cd '${c.deploy}' || { echo "DEPLOY_INACESSIVEL"; exit 4; }`,
    'for f in sha256sum base64 gzip mktemp node find; do command -v "$f" >/dev/null || { echo "FERRAMENTA_AUSENTE $f"; exit 4; }; done'];
  if (execucao) L.push('[ -f node_modules/pg/package.json ] || { echo "DEPENDENCIA_AUSENTE node_modules/pg"; exit 4; }');
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
    const ramo = execucao.ramo ? `KIDMAIS_B5_RAMO_PROVEDOR=${execucao.ramo} ` : '';
    const cmd = comando === undefined ? `${SEM_ASAAS} ${ramo}NODE_PATH='${c.deploy}/node_modules' node --experimental-strip-types ${AGREGADOR} ${execucao.args}` : comando;
    L.push('falta=0', 'tem() { [ -f ".partes/$1" ] && [ "$(h ".partes/$1")" = "$1" ] || { echo "PARTE_AUSENTE_OU_DIVERGENTE $2 (colar a PARTE-$3)"; falta=1; }; }');
    for (const x of lista) L.push(`tem ${x.sha} ${x.arquivo} ${x.parte}`);
    L.push(`[ "$falta" = 0 ] || { echo "MONTAGEM_RECUSADA: colar as partes indicadas (1..${n}) e repetir este bloco"; exit 4; }`,
      'livre() { [ ! -e "$1" ] || [ "$(h "$1")" = "$2" ] || { echo "JA_EXISTE_DIFERENTE $1"; exit 4; }; }',
      'inst() { if [ -e "$1" ]; then [ "$(h "$1")" = "$2" ] || { echo "JA_EXISTE_DIFERENTE $1"; exit 4; }; echo "JA_PRESENTE $1"; else { mkdir -p "$(dirname "$1")" && cp ".partes/$2" "$1"; } || { echo "GRAVACAO_FALHOU $1"; exit 4; }; echo "ESCRITO $1"; fi; }');
    for (const x of lista) L.push(`livre ${x.arquivo} ${x.sha}`);
    for (const x of lista) L.push(`inst ${x.arquivo} ${x.sha}`);
    L.push(`echo "ARQUIVOS_OK ${lista.length}"`);
    if (cmd) L.push('codigo=0', `${cmd} || codigo=$?`, 'exit "$codigo"');
    else L.push('echo "SEM_CONFERENCIA (teste)"');
  }
  return L.join('\n') + '\n';
}

/** Abertura do carregador: subshell sem C/T do shell do operador; C/T somente leitura = recusa antes de tudo. */
const ABERTURA_CARREGADOR = '( builtin unset -v C T || { echo "VARIAVEIS_DO_CARREGADOR_NAO_LIMPAS (C/T somente leitura neste shell): abrir uma sessao nova do Shell; nada executado"; echo "CODIGO_SAIDA_BLOCO=4"; exit 4; }';

/** Bloco colado: guarda + carregador que decodifica o corpo, confere o sha256 e só então o executa num bash próprio. */
function gerar({modo, rotulo, raiz, destino, deploy, comando, alterarCorpo = x => x}) {
  const n = totalPartes(raiz);
  assert.match(String(rotulo), /^[0-9a-f]{7,40}$/, 'ROTULO_INVALIDO');
  const texto = Buffer.from(alterarCorpo(corpo({modo, raiz, destino, deploy, comando})), 'utf8');
  const shaCorpo = sha(texto);
  const carregador = [ABERTURA_CARREGADOR, 'umask 077',
    'C="$(mktemp)" || { echo "TEMPORARIO_FALHOU"; echo "CODIGO_SAIDA_BLOCO=4"; exit 4; }', 'trap \'rm -f -- "$C"\' EXIT',
    '{ base64 -d | gzip -dc > "$C"; } 2>/dev/null <<\'CORPO\'', ...b64(texto), 'CORPO',
    `if [ "$(sha256sum "$C" 2>/dev/null | cut -d" " -f1)" = "${shaCorpo}" ]; then env -u BASH_ENV -u ENV bash "$C"; else echo "CORPO_DIVERGENTE: bloco incompleto ou alterado, nada executado"; echo "CODIGO_SAIDA_BLOCO=4"; exit 4; fi`,
    ')'];
  const bloco = [...cabecalho(modo, n, rotulo), ...carregador, 'fi'].join('\n') + '\n';
  assert.match(bloco, /^[\x09\x0a\x20-\x7e]*$/, 'BLOCO_NAO_ASCII');
  assert.ok(Buffer.byteLength(bloco) <= LIMITE_PARTE, 'BLOCO_MAIOR_QUE_40KB ' + modo);
  return bloco;
}
const nomeArquivo = (modo, n) => `BLOCO-SHELL-CONFERENCIA-B5-PRODUCAO-${/^PARTE-\d+$/.test(modo) ? `${modo}-DE-${n}` : modo}.sh`;

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
module.exports = {DEPLOY, DESTINO, NOME_DESTINO, ABERTURA_CARREGADOR, SERVICO, AGREGADOR, EXECUCOES, RAMOS_BLOCO, SEM_ASAAS, CONTRATO_109, FIXOS, LIMITE_PARTE, arquivos, totalPartes, distribuir, modos, caminhos, corpo, gerar, nomeArquivo};
