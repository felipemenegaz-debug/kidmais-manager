/* eslint-disable @typescript-eslint/no-require-imports */
// Blocos de Shell da 105 (canal MCP por assinatura: persistência OAuth, staging e produção), no mesmo desenho dos blocos da 102/103,
// da 100 e da 092–094 (P2-A colagem interativa, P3-1 trap/código, P3-2 bind antes da guarda). O CÓDIGO é publicado antes, já com o
// aplicador e os SQL na árvore implantada — por isso o bloco NÃO transporta nem grava arquivos: confere o sha256 de cada
// arquivo implantado e roda o aplicador. O operador cola no Web Shell do serviço (bash INTERATIVO):
//   - `bind` desliga o bracketed paste ANTES da guarda e fora do subshell (vale pelo resto da sessão do operador);
//   - guarda RENDER_SERVICE_ID ANTES de qualquer leitura de arquivo (outro serviço: nada do corpo executado);
//   - corpo num SUBSHELL ( … ): set -euo pipefail, umask, cd e exit não alteram nem encerram o shell do operador;
//   - no fim, CODIGO_SAIDA_BLOCO=<n>: 0/1/2/3 do aplicador (CONFERIDO-PASS / recusa antes de conectar / FALHA /
//     RECUSARIA); 4 = recusa do PRÓPRIO bloco, com mensagem nomeada (destino, ferramenta, arquivo, backup). Qualquer
//     outro código (127 linha perdida, 143 sinal) ou ausência da linha (Ctrl-C pode não imprimir a linha) = parar e ler;
//   - APLICAR exige KIDMAIS_REGISTRO_BACKUP definida no shell ANTES de colar: a referência do ponto de recuperação PITR
//     comprovado (registro de quando e de onde restaurar, anterior à aplicação). Em produção (plano MCP produção, P1), no
//     formato "PITR <AAAA-MM-DDTHH:MMZ> <referencia>": Felipe conferiu no painel do Render que o ponto de restauração
//     cobre o instante da aplicação (o aplicador recusa conferência com mais de 120 min) e o marcador guarda a referência;
//   - produção: 5 SQL (os 4 de staging + definições), núcleo de produção, e o código 5 do aplicador (FALHA com o marcador
//     desatualizado: a saída é o único registro do COMMIT).
// O bloco gerado é ASCII puro e tem no máximo 32 KB. Este gerador só lê arquivos e escreve o bloco; não conecta.
//   node scripts/bloco-shell-105.cjs <staging|production> <CONFERIR|APLICAR> <rotulo-da-arvore>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {ETAPAS} = require('./migration-105-comum.cjs');
const {ETAPAS: ETAPAS_PRODUCAO} = require('./migration-105-production-nucleo.cjs');
/** Os 4 SQL de staging são os mesmos (mesmos hashes) em produção, que acrescenta o de definições. */
const REVISADOS = ETAPAS_PRODUCAO;

const DESTINO = '/opt/render/project/src';
const LIMITE = 32 * 1024;
const AMBIENTES = Object.freeze({
  staging: Object.freeze({servico: 'srv-daif418ae00c73e8k2gg', nome: 'kidmais-manager-staging', aplicador: 'scripts/migration-105-staging.cjs',
    dependencias: Object.freeze(['scripts/migration-105-comum.cjs', 'scripts/migration-092-094-comum.cjs', 'scripts/conexao-staging.cjs']), registro: 'data/mcp-105-staging', rotulo: 'STAGING',
    sqls: ETAPAS, codigos: '0/1/2/3 aplicador, 4 bloco', backup: '^[A-Za-z0-9:._/ -]{6,120}$', faltaBackup: 'defina KIDMAIS_REGISTRO_BACKUP antes de colar', ferramentas: 'sha256sum cut node', linhaUnica: false}),
  production: Object.freeze({servico: 'srv-dak77m2d0e5s73b8rkkg', nome: 'kidmais-manager-production', aplicador: 'scripts/migration-105-production.cjs',
    dependencias: Object.freeze(['scripts/migration-105-production-nucleo.cjs', 'scripts/migration-105-definicoes.cjs', 'scripts/migration-105-comum.cjs',
      'scripts/migration-092-094-comum.cjs']), registro: 'data/mcp-105-producao', rotulo: 'PRODUCTION',
    sqls: ETAPAS_PRODUCAO, codigos: '0/1/2/3/5 aplicador, 4 bloco', backup: '^PITR [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}Z [A-Za-z0-9:._/ -]{3,80}$',
    faltaBackup: 'defina KIDMAIS_REGISTRO_BACKUP no formato PITR AAAA-MM-DDTHH:MMZ referencia (conferido no painel) antes de colar',
    // Revisão do Astra (rodada 1, P3): o grep aceita UMA linha válida dentro de um valor multilinha; em produção o valor
    // inteiro precisa ser uma linha só (sem CR/LF), senão o bloco recusa com 4 antes do aplicador.
    ferramentas: 'sha256sum cut node tr', linhaUnica: true}),
});
const COMANDOS = Object.freeze({CONFERIR: '--conferir-105', APLICAR: '--aplicar-105-autorizado --backup "$KIDMAIS_REGISTRO_BACKUP"'});
const TITULOS_STAGING = Object.freeze({
  CONFERIR: ['SOMENTE LEITURA: confere o sha256 do aplicador, dos nucleos e dos 4 SQL da 105 IMPLANTADOS e roda --conferir-105',
    '(identidade, estado da 105, dependencias, privilegios, precheck ou integridade, READ ONLY). Nada e gravado.'],
  APLICAR: ['ESCRITA (DDL) - somente com a autorizacao especifica da 105 neste ambiente. Antes de colar, no mesmo',
    'shell: export KIDMAIS_REGISTRO_BACKUP="<referencia e horario do ponto PITR comprovado>". Roda --aplicar-105-autorizado',
    'UMA vez (uma transacao: 6 tabelas mcp_*, indices, funcao e gatilho; postcheck e integridade antes do COMMIT).',
    'NAO liga o canal (MCP_ENABLED continua desligado). Se algo parar, NAO repetir: copiar a saida e revisar (o marcador',
    'impede a repeticao e diz se o COMMIT foi confirmado, desfeito ou ficou indeterminado; rodar o CONFERIR).'],
});
const TITULOS_PRODUCAO = Object.freeze({
  CONFERIR: ['SOMENTE LEITURA: confere o sha256 do aplicador, dos nucleos e dos 5 SQL da 105 IMPLANTADOS e roda --conferir-105',
    '(identidade e papel, estado, dependencias, privilegios, precheck ou integridade + DEFINICOES, READ ONLY). Nada e gravado.',
    'Resultado: PRONTA_PARA_APLICAR / JA_APLICADA_INTEGRIDADE_PASS (0); DIVERGENTE / PARCIAL / FALHA_DE_CONFERENCIA (3) = parar.'],
  APLICAR: ['ESCRITA (DDL) EM PRODUCAO - somente com a autorizacao especifica da 105 em producao, na janela do MCP. Antes de',
    'colar, Felipe confere no painel do Render que o PITR cobre este instante e, no mesmo shell:',
    'export KIDMAIS_REGISTRO_BACKUP="PITR <AAAA-MM-DDTHH:MMZ> <referencia>" (horario UTC da conferencia; vale 120 min).',
    'Roda --aplicar-105-autorizado UMA vez (UMA transacao: precheck, 6 tabelas mcp_*, indices, funcao e gatilho, postcheck,',
    'integridade e definicoes antes do COMMIT). NAO liga o canal. Se algo parar, NAO repetir: copiar a saida e revisar.',
    'Codigo 5 = COMMIT com marcador desatualizado: a SAIDA e o unico registro do COMMIT; copiar antes de tudo; rodar o CONFERIR.'],
});
const TITULOS = Object.freeze({staging: TITULOS_STAGING, production: TITULOS_PRODUCAO});
const sha = b => createHash('sha256').update(b).digest('hex');
/** Conteúdo LF da árvore; os SQL precisam ter exatamente o hash revisado do aplicador. */
function ler(raiz, arquivo) {
  const b = Buffer.from(fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n'), 'utf8');
  const revisado = REVISADOS.find(([, a]) => a === arquivo)?.[2];
  if (revisado) assert.equal(sha(b), revisado, 'ARQUIVO_DIVERGENTE_DO_REVISADO ' + arquivo);
  return b;
}
const seguro = s => { assert.match(s, /^[A-Za-z0-9_./-]+$/, 'CAMINHO_INSEGURO'); return s; };
function arquivos(ambiente) { const a = AMBIENTES[ambiente]; return [a.aplicador, ...a.dependencias, ...a.sqls.map(([, arquivo]) => arquivo)]; }

/**
 * `destino` e `comando` existem para os testes locais (destino temporário; comando substituto que só devolve um código).
 * A CLI usa sempre o destino do Render e o comando do aplicador do modo.
 */
function gerar({ambiente, modo, rotulo, raiz = path.resolve(__dirname, '..'), destino = DESTINO, comando}) {
  assert.ok(Object.hasOwn(AMBIENTES, ambiente), 'AMBIENTE_DESCONHECIDO');
  assert.ok(Object.hasOwn(COMANDOS, modo), 'MODO_DESCONHECIDO');
  assert.match(String(rotulo), /^[0-9a-f]{7,40}$/, 'ROTULO_INVALIDO');
  assert.match(destino, /^(?:[A-Za-z]:)?\/[A-Za-z0-9_./-]+$/, 'DESTINO_INVALIDO');
  const a = AMBIENTES[ambiente];
  assert.match(a.faltaBackup, /^[A-Za-z0-9 :._()-]+$/, 'MENSAGEM_INSEGURA');
  const cmd = comando === undefined ? `NODE_PATH="$PWD/node_modules" node ${a.aplicador} ${COMANDOS[modo]}` : comando;
  const c = ['set -euo pipefail', 'umask 077', `cd '${destino}' || { echo "DESTINO_INACESSIVEL"; exit 4; }`,
    `for f in ${a.ferramentas}; do command -v "$f" >/dev/null || { echo "FERRAMENTA_AUSENTE $f"; exit 4; }; done`,
    'h() { sha256sum "$1" | cut -d" " -f1; }',
    'arq() { [ -f "$1" ] && [ "$(h "$1")" = "$2" ] || { echo "ARQUIVO_DIVERGENTE_OU_AUSENTE $1"; exit 4; }; }'];
  for (const arquivo of arquivos(ambiente)) c.push(`arq ${seguro(arquivo)} ${sha(ler(raiz, arquivo))}`);
  c.push('echo ARQUIVOS_CONFERIDOS');
  if (modo === 'APLICAR') c.push('B="${KIDMAIS_REGISTRO_BACKUP:-}"',
    `printf "%s" "$B" | grep -Eq "${a.backup}"${a.linhaUnica ? ' && [ "$(printf "%s" "$B" | tr -d "\\r\\n")" = "$B" ]' : ''} || { echo "BACKUP_NAO_INFORMADO ${a.faltaBackup}"; exit 4; }`);
  c.push('codigo=0', `${cmd} || codigo=$?`, `echo '=== REGISTRO (${a.registro}) ==='`, `ls -1 ${a.registro} 2>/dev/null || echo SEM_REGISTRO`, 'exit "$codigo"');
  const linhas = ['#!/usr/bin/env bash',
    `# BLOCO-SHELL-105-${a.rotulo}-${modo} - Web Shell do ${a.servico} (${a.nome}). Colar inteiro, uma vez, e Enter.`,
    ...TITULOS[ambiente][modo].map(t => '# ' + t),
    `# Gerado da arvore ${rotulo} por scripts/bloco-shell-105.cjs. Conferir sha256 e bytes antes de colar.`,
    '# O bind abaixo roda ANTES da guarda e FORA do subshell, mesmo em outro servico: desliga o bracketed paste do readline',
    '# pelo resto desta sessao. A guarda de RENDER_SERVICE_ID vem antes de qualquer leitura de arquivo. Corpo em subshell:',
    `# opcoes, umask, cwd e variaveis nao vazam. No fim sai CODIGO_SAIDA_BLOCO=<n> (${a.codigos}); outro codigo`,
    '# ou ausencia da linha = parar e ler. Prompt `>` depois de colar = colagem incompleta: Ctrl-C e colar o MESMO bloco.',
    "bind 'set enable-bracketed-paste off' 2>/dev/null",
    `if [ "$RENDER_SERVICE_ID" != "${a.servico}" ]; then echo "SHELL_ERRADO_NAO_E_${a.rotulo} ($RENDER_SERVICE_ID): nada executado"; else`,
    '(', ...c, ')', 'echo "CODIGO_SAIDA_BLOCO=$?"', 'fi'];
  const bloco = linhas.join('\n') + '\n';
  assert.match(bloco, /^[\x09\x0a\x20-\x7e]*$/, 'BLOCO_NAO_ASCII');
  assert.ok(Buffer.byteLength(bloco, 'utf8') <= LIMITE, 'BLOCO_GRANDE_DEMAIS');
  return bloco;
}

if (require.main === module) {
  try {
    const [ambiente, modo, rotulo] = process.argv.slice(2);
    const bloco = gerar({ambiente, modo, rotulo});
    process.stdout.write(bloco);
    console.error(`BLOCO-SHELL-105-${AMBIENTES[ambiente].rotulo}-${modo} sha256 ${sha(Buffer.from(bloco, 'utf8'))} (${Buffer.byteLength(bloco, 'utf8')} bytes)`);
  } catch (e) { console.error('RECUSADO ' + String(e?.message ?? e).slice(0, 160)); process.exitCode = 1; }
}
module.exports = {DESTINO, LIMITE, AMBIENTES, COMANDOS, arquivos, gerar};
