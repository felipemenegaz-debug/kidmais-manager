/* eslint-disable @typescript-eslint/no-require-imports */
// Blocos de Shell da 109 (renovação substituta, B-9) em PRODUÇÃO, no mesmo desenho do bloco de staging
// (scripts/bloco-shell-109.cjs) e do bloco de produção da 100 (P2-A colagem interativa, P3-1 trap/código, P3-2 bind antes
// da guarda). O CÓDIGO é publicado antes, já com o aplicador, os SQL e o contrato de integridade na árvore implantada —
// por isso o bloco NÃO transporta nem grava arquivos: confere o sha256 de cada arquivo implantado e roda o aplicador de
// produção. O operador cola no Web Shell do serviço (bash INTERATIVO):
//   - `bind` desliga o bracketed paste ANTES da guarda e fora do subshell (vale pelo resto da sessão do operador);
//   - guarda RENDER_SERVICE_ID ANTES de qualquer leitura de arquivo (outro serviço: nada do corpo executado);
//   - corpo num SUBSHELL ( … ): set -euo pipefail, umask, cd e exit não alteram nem encerram o shell do operador;
//   - no fim, CODIGO_SAIDA_BLOCO=<n>: 0/1/2/3 do aplicador (CONFERIDO-PASS / recusa antes de conectar / FALHA /
//     RECUSARIA); 4 = recusa do PRÓPRIO bloco, com mensagem nomeada (destino, ferramenta, arquivo, backup). Qualquer
//     outro código (127 linha perdida, 143 sinal) ou ausência da linha = parar e ler;
//   - APLICAR exige KIDMAIS_REGISTRO_BACKUP definida no shell ANTES de colar (referência e horário do ponto PITR de
//     production comprovado, anterior à aplicação), numa linha só.
// B-27 (nota no topo de docs/PLANO_B9_PRODUCAO_PUTS_JANELA_20261029.md): em production a 109 não cria nem retoma cron de
// cobrança ou de renovação; o bloco nunca mexe em cron e avisa isso no cabeçalho.
// O bloco gerado é ASCII puro e tem no máximo 32 KB. Este gerador só lê arquivos e escreve o bloco; não conecta.
//   node scripts/bloco-shell-109-production.cjs <CONFERIR|APLICAR> <rotulo-da-arvore>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {ETAPAS, CONTRATO} = require('./migration-109-comum.cjs');

const DESTINO = '/opt/render/project/src';
const LIMITE = 32 * 1024;
const SERVICO = 'srv-dak77m2d0e5s73b8rkkg';
const APLICADOR = 'scripts/migration-109-production.cjs';
/** Sem scripts/conexao-staging.cjs: o adaptador de produção traz a própria trava de alvo, identidade e disco. */
const DEPENDENCIAS = Object.freeze(['scripts/migration-109-comum.cjs', 'scripts/migration-092-094-comum.cjs']);
const REGISTRO = 'data/renovacao-109-producao';
/** Arquivos com hash revisado no aplicador (SQL e contrato): o gerador recusa árvore divergente. */
const REVISADOS = Object.freeze([...ETAPAS.map(([, arquivo, hash]) => [arquivo, hash]), ...CONTRATO]);
const BACKUP = '^[A-Za-z0-9:._/ -]{6,120}$';
const COMANDOS = Object.freeze({CONFERIR: '--conferir-109', APLICAR: '--aplicar-109-autorizado --backup "$KIDMAIS_REGISTRO_BACKUP"'});
const TITULOS = Object.freeze({
  CONFERIR: ['SOMENTE LEITURA: confere o sha256 do aplicador, dos nucleos, dos 3 SQL e do contrato da 109 IMPLANTADOS e roda',
    '--conferir-109 (identidade, retrato de assinatura_renovacoes pelo contrato do cron, privilegios, sessoes da renovacao,',
    'precheck ou capacidade 109, contagens por estado; READ ONLY). Nada e gravado.',
    'Resultado: PRONTA_PARA_APLICAR / JA_APLICADA_CAPACIDADE_PASS (0); RECUSARIA (3) = parar e ler o motivo',
    '(RETRATO_DIVERGENTE_109 = achado a analisar; nunca vira valor aprovado).'],
  APLICAR: ['ESCRITA (DDL) EM PRODUCAO - somente com a autorizacao especifica da 109 em producao, com NENHUM cron da renovacao',
    'em execucao (suspenso, se existir) e nenhuma renovacao manual ou preflight em andamento.',
    'Antes de colar, no mesmo shell: export KIDMAIS_REGISTRO_BACKUP="<referencia e horario do ponto PITR de production comprovado>".',
    'Roda --aplicar-109-autorizado UMA vez (uma transacao: ALTER de assinatura_renovacoes, indice, 2 funcoes e gatilhos;',
    'postcheck e capacidade 109 antes do COMMIT). Se algo parar, NAO repetir e NAO mexer em cron: copiar a saida e revisar',
    '(o marcador impede a repeticao e diz se o COMMIT foi confirmado, desfeito ou ficou indeterminado; rodar o CONFERIR).'],
});
const AVISO = ['PRODUCAO (B-27, plano B-9): aplicar a 109 NAO cria nem retoma cron de cobranca ou de renovacao e NAO libera o aplicar',
  'da renovacao; a ativacao e entrega separada, com autorizacao propria. O codigo anterior a 109 QUEBRA com ela.'];
const sha = b => createHash('sha256').update(b).digest('hex');
/** Conteúdo LF da árvore; os SQL e o contrato precisam ter exatamente o hash revisado do aplicador. */
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
  const cmd = comando === undefined ? `NODE_PATH="$PWD/node_modules" node --experimental-strip-types ${APLICADOR} ${COMANDOS[modo]}` : comando;
  const c = ['set -euo pipefail', 'umask 077', `cd '${destino}' || { echo "DESTINO_INACESSIVEL"; exit 4; }`,
    'for f in sha256sum cut node grep tr; do command -v "$f" >/dev/null || { echo "FERRAMENTA_AUSENTE $f"; exit 4; }; done',
    'h() { sha256sum "$1" | cut -d" " -f1; }',
    'arq() { [ -f "$1" ] && [ "$(h "$1")" = "$2" ] || { echo "ARQUIVO_DIVERGENTE_OU_AUSENTE $1"; exit 4; }; }'];
  for (const arquivo of arquivos()) c.push(`arq ${seguro(arquivo)} ${sha(ler(raiz, arquivo))}`);
  c.push('echo ARQUIVOS_CONFERIDOS');
  if (modo === 'APLICAR') c.push('B="${KIDMAIS_REGISTRO_BACKUP:-}"',
    `printf "%s" "$B" | grep -Eq "${BACKUP}" && [ "$(printf "%s" "$B" | tr -d "\\r\\n")" = "$B" ] || { echo "BACKUP_NAO_INFORMADO defina KIDMAIS_REGISTRO_BACKUP (ponto PITR de production) numa linha antes de colar"; exit 4; }`);
  c.push('codigo=0', `${cmd} || codigo=$?`, `echo '=== REGISTRO (${REGISTRO}) ==='`, `ls -1 ${REGISTRO} 2>/dev/null || echo SEM_REGISTRO`, 'exit "$codigo"');
  const linhas = ['#!/usr/bin/env bash',
    `# BLOCO-SHELL-109-PRODUCTION-${modo} - Web Shell do ${SERVICO} (kidmais-manager-production). Colar inteiro, uma vez, e Enter.`,
    ...TITULOS[modo].map(t => '# ' + t), ...AVISO.map(t => '# ' + t),
    `# Gerado da arvore ${rotulo} por scripts/bloco-shell-109-production.cjs. Conferir sha256 e bytes antes de colar.`,
    '# O bind abaixo roda ANTES da guarda e FORA do subshell, mesmo em outro servico: desliga o bracketed paste do readline',
    '# pelo resto desta sessao. A guarda de RENDER_SERVICE_ID vem antes de qualquer leitura de arquivo. Corpo em subshell:',
    '# opcoes, umask, cwd e variaveis nao vazam. No fim sai CODIGO_SAIDA_BLOCO=<n> (0/1/2/3 aplicador, 4 bloco); outro codigo',
    '# ou ausencia da linha = parar e ler. Prompt `>` depois de colar = colagem incompleta: Ctrl-C e colar o MESMO bloco.',
    "bind 'set enable-bracketed-paste off' 2>/dev/null",
    `if [ "$RENDER_SERVICE_ID" != "${SERVICO}" ]; then echo "SHELL_ERRADO_NAO_E_PRODUCTION ($RENDER_SERVICE_ID): nada executado"; else`,
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
    console.error(`BLOCO-SHELL-109-PRODUCTION-${modo} sha256 ${sha(Buffer.from(bloco, 'utf8'))} (${Buffer.byteLength(bloco, 'utf8')} bytes)`);
  } catch (e) { console.error('RECUSADO ' + String(e?.message ?? e).slice(0, 160)); process.exitCode = 1; }
}
module.exports = {DESTINO, LIMITE, SERVICO, APLICADOR, DEPENDENCIAS, REGISTRO, COMANDOS, arquivos, gerar};
