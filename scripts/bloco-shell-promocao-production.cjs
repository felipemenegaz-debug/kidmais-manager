/* eslint-disable @typescript-eslint/no-require-imports */
// Blocos de Shell de PRODUÇÃO da promoção de 12/11/2026 para os passos 112, 114, 116, 117 (adaptadores próprios) e 120, 121,
// 110, 111 e 115 (aplicador genérico), no desenho dos blocos de staging dessas migrations (scripts/bloco-shell-112.cjs e
// vizinhos, que ficam intactos) e do bloco de produção da 100: bind antes da guarda, guarda de RENDER_SERVICE_ID antes de
// ler qualquer arquivo, corpo em subshell, sha256 de cada arquivo IMPLANTADO, CODIGO_SAIDA_BLOCO=<n> no fim (0/1/2/3 do
// aplicador; 4 = recusa do próprio bloco). O bloco NÃO transporta nem grava arquivos: a árvore implantada já traz o
// aplicador, os núcleos e os SQL. A 118 de produção tem o bloco dela (scripts/bloco-shell-118-production.cjs).
//   - APLICAR exige KIDMAIS_REGISTRO_BACKUP definida no shell ANTES de colar, numa linha só: referência e horário do dump
//     conferido e do PITR (export funcional não substitui).
// O bloco gerado é ASCII puro e tem no máximo 32 KB. Este gerador só lê arquivos e escreve o bloco; não conecta.
//   node scripts/bloco-shell-promocao-production.cjs <112|114|116|117|120|121|110|111|115> <CONFERIR|APLICAR> <rotulo-da-arvore>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const generico = require('./migration-generico-production.cjs');

const DESTINO = '/opt/render/project/src';
const LIMITE = 32 * 1024;
const SERVICO = 'srv-dak77m2d0e5s73b8rkkg';
const BACKUP = '^[A-Za-z0-9:._/ -]{6,120}$';
const CONEXAO = 'scripts/conexao-production.cjs';
const NUCLEO_094 = 'scripts/migration-092-094-comum.cjs';
const GENERICO = 'scripts/migration-generico-production.cjs';

/** Passo com adaptador próprio: núcleo da migration (ETAPAS = arquivos com hash revisado) + conexão de produção. */
function proprio(id, {registro, extras = [], conferir, aplicar}) {
  const {ETAPAS} = require(`./migration-${id}-comum.cjs`);
  return Object.freeze({id, aplicador: `scripts/migration-${id}-production.cjs`,
    dependencias: Object.freeze([`scripts/migration-${id}-comum.cjs`, NUCLEO_094, CONEXAO, ...extras]),
    revisados: Object.freeze(ETAPAS.map(([, arquivo, hash]) => [arquivo, hash])), registro,
    comandos: Object.freeze({CONFERIR: `--conferir-${id}`, APLICAR: `--aplicar-${id}-autorizado --backup "$KIDMAIS_REGISTRO_BACKUP"`}),
    titulos: Object.freeze({CONFERIR: conferir, APLICAR: aplicar})});
}
/** Passo do aplicador genérico: os 3 SQL da lista fechada do próprio aplicador. */
function pelGenerico(id, oQueFaz) {
  return Object.freeze({id, aplicador: GENERICO,
    dependencias: Object.freeze([NUCLEO_094, 'scripts/migration-118-comum.cjs', CONEXAO]),
    revisados: Object.freeze(generico.MIGRATIONS[id].arquivos.map(([, arquivo, hash]) => [arquivo, hash])), registro: 'data/promocao-generico-producao',
    comandos: Object.freeze({CONFERIR: `--conferir ${id}`, APLICAR: `--aplicar-autorizado ${id} --backup "$KIDMAIS_REGISTRO_BACKUP"`}),
    titulos: Object.freeze({
      CONFERIR: [`(identidade, sentinelas da ${id} no catalogo e, READ ONLY, o precheck ou o postcheck). Nada e gravado.`],
      APLICAR: [`(uma transacao: precheck, ${oQueFaz}, postcheck e so entao COMMIT).`]})});
}
const PASSOS = Object.freeze({
  '112': proprio('112', {registro: 'data/clientes-pj-112-producao',
    conferir: ['(identidade, os 19 objetos da 112 no catalogo, privilegios de dono de clientes e mesclagens_clientes, precheck ou', 'postcheck, contagens por status e tipo; READ ONLY). Nada e gravado.'],
    aplicar: ['(uma transacao: 6 colunas, 7 CHECKs, indice de CNPJ, 3 funcoes e 2 gatilhos; preservacao e postcheck antes do COMMIT;', 'clientes fica travada por instantes).']}),
  '114': proprio('114', {registro: 'data/agenda-114-producao', extras: ['lib/agenda/trava-configuracao.ts'],
    conferir: ['(identidade, hash do corpo das funcoes, os 6 gatilhos da 019 e, com a 114 presente, a prova funcional KD114; READ ONLY).', 'A 114 nao tem checks externos: a prova e do nucleo. Nada e gravado.'],
    aplicar: ['(uma transacao: funcao kidmais114_exigir_configuracao e os 2 corpos de gatilho; estado, preservacao das 4 tabelas e', 'prova funcional antes do COMMIT).']}),
  '116': proprio('116', {registro: 'data/creditos-franquias-116-producao',
    conferir: ['(identidade, os 5 objetos da 116 no catalogo, dono das notificacoes e REFERENCES, precheck ou postcheck, contagens;', 'READ ONLY). Nada e gravado.'],
    aplicar: ['(uma transacao: objetos das franquias por ciclo; preservacao e postcheck antes do COMMIT).', 'CREDITOS_FRANQUIA_PLANO_ATIVO continua desligada.']}),
  '117': proprio('117', {registro: 'data/whatsapp-multiempresa-117-producao',
    conferir: ['(identidade, os 3 objetos da 117 no catalogo, dono de whatsapp_atendimento_mensagens e REFERENCES em empresas,', 'precheck ou postcheck, contagem de mensagens por ambiente e direcao; READ ONLY). Nada e gravado.',
      'A saida informa a chave WHATSAPP_ATENDIMENTO_MULTIEMPRESA (DESLIGADA / LIGADA / INVALIDA).'],
    aplicar: ['(uma transacao: 2 tabelas de controle e o indice de busca por identificador; preservacao e postcheck antes do COMMIT).',
      'Com WHATSAPP_ATENDIMENTO_MULTIEMPRESA ligada ou invalida o aplicador RECUSA antes do marcador (codigo 1): nao ligar a chave.']}),
  '120': pelGenerico('120', 'tabelas de liquidacoes e reversoes do financeiro com 2 UNIQUE novas'),
  '121': pelGenerico('121', 'tabelas de abertura e conferencias do financeiro, so de acrescimo'),
  '110': pelGenerico('110', 'objetos da pesquisa de satisfacao'),
  '111': pelGenerico('111', 'links de avaliacao e auditoria da pesquisa de satisfacao'),
  '115': pelGenerico('115', 'indice (empresa_id, data_evento) em fechamentos no lugar do indice da 054; bloqueia escritas em fechamentos enquanto cria'),
});
/** Na ordem da cadeia (Object.keys ordenaria as chaves numéricas). */
const IDS = Object.freeze(['114', '112', '116', '117', '120', '121', '110', '111', '115']);
const passo = id => { assert.ok(typeof id === 'string' && Object.hasOwn(PASSOS, id), 'PASSO_DESCONHECIDO'); return PASSOS[id]; };

const sha = b => createHash('sha256').update(b).digest('hex');
/** Conteúdo LF da árvore; os SQL precisam ter exatamente o hash revisado do aplicador. */
function ler(raiz, p, arquivo) {
  const b = Buffer.from(fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n'), 'utf8');
  const revisado = p.revisados.find(([a]) => a === arquivo)?.[1];
  if (revisado) assert.equal(sha(b), revisado, 'ARQUIVO_DIVERGENTE_DO_REVISADO ' + arquivo);
  return b;
}
const seguro = s => { assert.match(s, /^[A-Za-z0-9_./-]+$/, 'CAMINHO_INSEGURO'); return s; };
function arquivos(id) { const p = passo(id); return [p.aplicador, ...p.dependencias, ...p.revisados.map(([arquivo]) => arquivo)]; }

/**
 * `destino` e `comando` existem para os testes locais (destino temporário; comando substituto que só devolve um código).
 * A CLI usa sempre o destino do Render e o comando do aplicador do modo.
 */
// Bracketed paste do operador: o valor de antes (on/off, lido de bind -v; vazio se nao houver readline) e guardado antes do
// bind e restaurado no fim do bloco, aceito ou recusado. Sem bind ou sem shell interativo nada e guardado nem restaurado.
const KM_SALVA = '__kmbp=$(bind -v 2>/dev/null); case "$__kmbp" in *"enable-bracketed-paste on"*) __kmbp=on;; *"enable-bracketed-paste off"*) __kmbp=off;; *) __kmbp=;; esac';
const KM_RESTAURA = '{ [ -z "$__kmbp" ] || bind "set enable-bracketed-paste $__kmbp" 2>/dev/null; unset __kmbp; }';

function gerar({id, modo, rotulo, raiz = path.resolve(__dirname, '..'), destino = DESTINO, comando}) {
  const p = passo(id);
  assert.ok(Object.hasOwn(p.comandos, modo), 'MODO_DESCONHECIDO');
  assert.match(String(rotulo), /^[0-9a-f]{7,40}$/, 'ROTULO_INVALIDO');
  assert.match(destino, /^(?:[A-Za-z]:)?\/[A-Za-z0-9_./-]+$/, 'DESTINO_INVALIDO');
  const cmd = comando === undefined ? `NODE_PATH="$PWD/node_modules" node ${p.aplicador} ${p.comandos[modo]}` : comando;
  const c = ['set -euo pipefail', 'umask 077', `cd '${destino}' || { echo "DESTINO_INACESSIVEL"; exit 4; }`,
    'for f in sha256sum cut node tr grep; do command -v "$f" >/dev/null || { echo "FERRAMENTA_AUSENTE $f"; exit 4; }; done',
    'h() { sha256sum "$1" | cut -d" " -f1; }',
    'arq() { [ -f "$1" ] && [ "$(h "$1")" = "$2" ] || { echo "ARQUIVO_DIVERGENTE_OU_AUSENTE $1"; exit 4; }; }'];
  for (const arquivo of arquivos(id)) c.push(`arq ${seguro(arquivo)} ${sha(ler(raiz, p, arquivo))}`);
  c.push('echo ARQUIVOS_CONFERIDOS');
  if (modo === 'APLICAR') c.push('B="${KIDMAIS_REGISTRO_BACKUP:-}"',
    `printf "%s" "$B" | grep -Eq "${BACKUP}" && [ "$(printf "%s" "$B" | tr -d "\\r\\n")" = "$B" ] || { echo "BACKUP_NAO_INFORMADO defina KIDMAIS_REGISTRO_BACKUP (dump conferido + PITR) numa linha antes de colar"; exit 4; }`);
  c.push('codigo=0', `${cmd} || codigo=$?`, `echo '=== REGISTRO (${p.registro}) ==='`, `ls -1 ${p.registro} 2>/dev/null || echo SEM_REGISTRO`, 'exit "$codigo"');
  const titulo = modo === 'CONFERIR'
    ? [`SOMENTE LEITURA: confere o sha256 do aplicador, dos nucleos e dos SQL da ${id} IMPLANTADOS e roda ${p.comandos.CONFERIR}`, ...p.titulos.CONFERIR,
      'Resultado: PRONTA_PARA_APLICAR / JA_APLICADA_POSTCHECK_PASS (0); RECUSARIA (3) = parar e ler o motivo.']
    : [`ESCRITA (DDL) EM PRODUCAO - somente com a autorizacao especifica de Felipe para a ${id} em producao.`,
      'Antes de colar, no mesmo shell: export KIDMAIS_REGISTRO_BACKUP="<id e horario do dump conferido e do PITR>" (export funcional NAO substitui).',
      `Roda ${p.comandos.APLICAR.split(' --backup')[0]} UMA vez`, ...p.titulos.APLICAR,
      'Se algo parar, NAO repetir nem seguir para o proximo passo da cadeia: copiar a saida e revisar (o marcador impede a',
      'repeticao e diz se o COMMIT foi confirmado, desfeito ou ficou indeterminado; rodar o CONFERIR).'];
  const linhas = ['#!/usr/bin/env bash',
    `# BLOCO-SHELL-${id}-PRODUCTION-${modo} - Web Shell do ${SERVICO} (kidmais-manager-production). Colar inteiro, uma vez, e Enter.`,
    ...titulo.map(t => '# ' + t),
    '# PRODUCAO: somente na ordem da cadeia (scripts/promocao-production-ordem.cjs), com o passo anterior em codigo 0.',
    `# Gerado da arvore ${rotulo} por scripts/bloco-shell-promocao-production.cjs. Conferir sha256 e bytes antes de colar.`,
    '# O bind abaixo roda ANTES da guarda e FORA do subshell, mesmo em outro servico: desliga o bracketed paste do readline',
    '# pelo resto desta sessao. A guarda de RENDER_SERVICE_ID vem antes de qualquer leitura de arquivo. Corpo em subshell:',
    '# opcoes, umask, cwd e variaveis nao vazam. No fim sai CODIGO_SAIDA_BLOCO=<n> (0/1/2/3 aplicador, 4 bloco); outro codigo',
    '# ou ausencia da linha = parar e ler. Prompt `>` depois de colar = colagem incompleta: Ctrl-C e colar o MESMO bloco.',
    KM_SALVA,
    "bind 'set enable-bracketed-paste off' 2>/dev/null",
    `if [ "$RENDER_SERVICE_ID" != "${SERVICO}" ]; then echo "SHELL_ERRADO_NAO_E_PRODUCAO ($RENDER_SERVICE_ID): nada executado"; ${KM_RESTAURA}; else`,
    '(', ...c, ')', 'echo "CODIGO_SAIDA_BLOCO=$?"', KM_RESTAURA, 'fi'];
  const bloco = linhas.join('\n') + '\n';
  assert.match(bloco, /^[\x09\x0a\x20-\x7e]*$/, 'BLOCO_NAO_ASCII');
  assert.ok(Buffer.byteLength(bloco, 'utf8') <= LIMITE, 'BLOCO_GRANDE_DEMAIS');
  return bloco;
}

if (require.main === module) {
  try {
    const [id, modo, rotulo] = process.argv.slice(2);
    const bloco = gerar({id, modo, rotulo});
    process.stdout.write(bloco);
    console.error(`BLOCO-SHELL-${id}-PRODUCTION-${modo} sha256 ${sha(Buffer.from(bloco, 'utf8'))} (${Buffer.byteLength(bloco, 'utf8')} bytes)`);
  } catch (e) { console.error('RECUSADO ' + String(e?.message ?? e).slice(0, 160)); process.exitCode = 1; }
}
module.exports = {DESTINO, LIMITE, SERVICO, PASSOS, IDS, arquivos, gerar};
