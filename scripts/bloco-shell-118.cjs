/* eslint-disable @typescript-eslint/no-require-imports */
// Blocos de Shell da 118 (cota de leitura de documentos da importação, L2) em staging, no mesmo desenho dos blocos da 117, 116, 112,
// 109, 105, 102/103 e 092–094 (P2-A colagem interativa, P3-1 trap/código, P3-2 bind antes da guarda). O CÓDIGO é publicado antes, já com o
// aplicador e os SQL na árvore implantada — por isso o bloco NÃO transporta nem grava arquivos: confere o sha256 de cada
// arquivo implantado e roda o aplicador. O operador cola no Web Shell do serviço (bash INTERATIVO):
//   - `bind` desliga o bracketed paste ANTES da guarda e fora do subshell (vale pelo resto da sessão do operador);
//   - guarda RENDER_SERVICE_ID ANTES de qualquer leitura de arquivo (outro serviço: nada do corpo executado);
//   - corpo num SUBSHELL ( … ): set -euo pipefail, umask, cd e exit não alteram nem encerram o shell do operador;
//   - no fim, CODIGO_SAIDA_BLOCO=<n>: 0/1/2/3 do aplicador (CONFERIDO-PASS / recusa antes de conectar / FALHA /
//     RECUSARIA); 4 = recusa do PRÓPRIO bloco, com mensagem nomeada (destino, ferramenta, arquivo, backup). Qualquer
//     outro código (127 linha perdida, 143 sinal) ou ausência da linha = parar e ler;
//   - APLICAR exige KIDMAIS_REGISTRO_BACKUP definida no shell ANTES de colar (referência e horário do ponto PITR
//     comprovado, anterior à aplicação), numa linha só.
// O bloco gerado é ASCII puro e tem no máximo 32 KB. Este gerador só lê arquivos e escreve o bloco; não conecta.
//   node scripts/bloco-shell-118.cjs <CONFERIR|APLICAR> <rotulo-da-arvore>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {ETAPAS} = require('./migration-118-comum.cjs');

const DESTINO = '/opt/render/project/src';
const LIMITE = 32 * 1024;
const SERVICO = 'srv-daif418ae00c73e8k2gg';
const APLICADOR = 'scripts/migration-118-staging.cjs';
const DEPENDENCIAS = Object.freeze(['scripts/migration-118-comum.cjs', 'scripts/migration-092-094-comum.cjs', 'scripts/conexao-staging.cjs']);
const REGISTRO = 'data/importacao-cotas-118-staging';
/** Arquivos com hash revisado no aplicador da 118 (os 3 SQL): o gerador recusa árvore divergente. */
const REVISADOS = Object.freeze(ETAPAS.map(([, arquivo, hash]) => [arquivo, hash]));
const BACKUP = '^[A-Za-z0-9:._/ -]{6,120}$';
const COMANDOS = Object.freeze({CONFERIR: '--conferir-118', APLICAR: '--aplicar-118-autorizado --backup "$KIDMAIS_REGISTRO_BACKUP"'});
const TITULOS = Object.freeze({
  CONFERIR: ['SOMENTE LEITURA: confere o sha256 do aplicador, dos nucleos e dos 3 SQL da 118 IMPLANTADOS e roda --conferir-118',
    '(identidade, os 7 objetos da 118 no catalogo, REFERENCES em empresas e ia_documentos, precheck ou postcheck,',
    'contagem de documentos e, com a 118, de cotas e leituras por situacao; READ ONLY). Nada e gravado.',
    'Resultado: PRONTA_PARA_APLICAR / JA_APLICADA_POSTCHECK_PASS (0); RECUSARIA (3) = parar e ler o motivo.'],
  APLICAR: ['ESCRITA (DDL) - somente com a autorizacao especifica da 118 neste ambiente.',
    'Antes de colar, no mesmo shell: export KIDMAIS_REGISTRO_BACKUP="<referencia e horario do ponto PITR comprovado>".',
    'Roda --aplicar-118-autorizado UMA vez (uma transacao: 2 tabelas da cota, 2 indices, 3 funcoes e 2 gatilhos;',
    'preservacao e postcheck antes do COMMIT; empresas e ia_documentos travadas por instantes). Se algo parar,',
    'NAO repetir: copiar a saida e revisar (o marcador impede a repeticao e diz se o COMMIT foi confirmado, desfeito ou',
    'ficou indeterminado). Depois do COMMIT a cota passa a valer na importacao; IMPORTACAO_COTA_DISPENSADA fica inerte.'],
});
/** Conteúdo LF da árvore; os SQL precisam ter exatamente o hash revisado do aplicador. */
const sha = b => createHash('sha256').update(b).digest('hex');
function ler(raiz, arquivo) {
  const b = Buffer.from(fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n'), 'utf8');
  const revisado = REVISADOS.find(([a]) => a === arquivo)?.[1];
  if (revisado) assert.equal(sha(b), revisado, 'ARQUIVO_DIVERGENTE_DO_REVISADO ' + arquivo);
  return b;
}
const seguro = s => { assert.match(s, /^[A-Za-z0-9_./-]+$/, 'CAMINHO_INSEGURO'); return s; };
function arquivos() { return [APLICADOR, ...DEPENDENCIAS, ...REVISADOS.map(([arquivo]) => arquivo)]; }

/**
 * `destino` e `comando` existem para os testes locais (destino temporário; comando substituto que só devolve um código).
 * A CLI usa sempre o destino do Render e o comando do aplicador do modo.
 */
function gerar({modo, rotulo, raiz = path.resolve(__dirname, '..'), destino = DESTINO, comando}) {
  assert.ok(Object.hasOwn(COMANDOS, modo), 'MODO_DESCONHECIDO');
  assert.match(String(rotulo), /^[0-9a-f]{7,40}$/, 'ROTULO_INVALIDO');
  assert.match(destino, /^(?:[A-Za-z]:)?\/[A-Za-z0-9_./-]+$/, 'DESTINO_INVALIDO');
  const cmd = comando === undefined ? `NODE_PATH="$PWD/node_modules" node ${APLICADOR} ${COMANDOS[modo]}` : comando;
  const c = ['set -euo pipefail', 'umask 077', `cd '${destino}' || { echo "DESTINO_INACESSIVEL"; exit 4; }`,
    'for f in sha256sum cut node tr; do command -v "$f" >/dev/null || { echo "FERRAMENTA_AUSENTE $f"; exit 4; }; done',
    'h() { sha256sum "$1" | cut -d" " -f1; }',
    'arq() { [ -f "$1" ] && [ "$(h "$1")" = "$2" ] || { echo "ARQUIVO_DIVERGENTE_OU_AUSENTE $1"; exit 4; }; }'];
  for (const arquivo of arquivos()) c.push(`arq ${seguro(arquivo)} ${sha(ler(raiz, arquivo))}`);
  c.push('echo ARQUIVOS_CONFERIDOS');
  if (modo === 'APLICAR') c.push('B="${KIDMAIS_REGISTRO_BACKUP:-}"',
    `printf "%s" "$B" | grep -Eq "${BACKUP}" && [ "$(printf "%s" "$B" | tr -d "\\r\\n")" = "$B" ] || { echo "BACKUP_NAO_INFORMADO defina KIDMAIS_REGISTRO_BACKUP numa linha antes de colar"; exit 4; }`);
  c.push('codigo=0', `${cmd} || codigo=$?`, `echo '=== REGISTRO (${REGISTRO}) ==='`, `ls -1 ${REGISTRO} 2>/dev/null || echo SEM_REGISTRO`, 'exit "$codigo"');
  const linhas = ['#!/usr/bin/env bash',
    `# BLOCO-SHELL-118-STAGING-${modo} - Web Shell do ${SERVICO} (kidmais-manager-staging). Colar inteiro, uma vez, e Enter.`,
    ...TITULOS[modo].map(t => '# ' + t),
    `# Gerado da arvore ${rotulo} por scripts/bloco-shell-118.cjs. Conferir sha256 e bytes antes de colar.`,
    '# O bind abaixo roda ANTES da guarda e FORA do subshell, mesmo em outro servico: desliga o bracketed paste do readline',
    '# pelo resto desta sessao. A guarda de RENDER_SERVICE_ID vem antes de qualquer leitura de arquivo. Corpo em subshell:',
    '# opcoes, umask, cwd e variaveis nao vazam. No fim sai CODIGO_SAIDA_BLOCO=<n> (0/1/2/3 aplicador, 4 bloco); outro codigo',
    '# ou ausencia da linha = parar e ler. Prompt `>` depois de colar = colagem incompleta: Ctrl-C e colar o MESMO bloco.',
    "bind 'set enable-bracketed-paste off' 2>/dev/null",
    `if [ "$RENDER_SERVICE_ID" != "${SERVICO}" ]; then echo "SHELL_ERRADO_NAO_E_STAGING ($RENDER_SERVICE_ID): nada executado"; else`,
    '(', ...c, ')', 'echo "CODIGO_SAIDA_BLOCO=$?"', 'fi'];
  const bloco = linhas.join('\n') + '\n';
  assert.match(bloco, /^[\x09\x0a\x20-\x7e]*$/, 'BLOCO_NAO_ASCII');
  assert.ok(Buffer.byteLength(bloco, 'utf8') <= LIMITE, 'BLOCO_GRANDE_DEMAIS');
  return bloco;
}

if (require.main === module) {
  try {
    const [modo, rotulo] = process.argv.slice(2);
    const bloco = gerar({modo, rotulo});
    process.stdout.write(bloco);
    console.error(`BLOCO-SHELL-118-STAGING-${modo} sha256 ${sha(Buffer.from(bloco, 'utf8'))} (${Buffer.byteLength(bloco, 'utf8')} bytes)`);
  } catch (e) { console.error('RECUSADO ' + String(e?.message ?? e).slice(0, 160)); process.exitCode = 1; }
}
module.exports = {DESTINO, LIMITE, SERVICO, APLICADOR, DEPENDENCIAS, REGISTRO, COMANDOS, arquivos, gerar};
