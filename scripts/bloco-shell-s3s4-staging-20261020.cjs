/* eslint-disable @typescript-eslint/no-require-imports */
// Blocos de Shell de STAGING da janela S3+S4 de 20/10/2026 (docs/HOMOLOGACAO_S3_S4_STAGING_20261020.md), no desenho dos
// blocos revisados de 18–20/10 (scripts/bloco-shell-email-producao-20261020.cjs): o operador (Felipe) cola no Web Shell do
// srv-daif418ae00c73e8k2gg (bash INTERATIVO) blocos gerados de uma árvore conferida, com sha256 e bytes conferidos antes de
// colar. Cada bloco tem no máximo 32 KB, é ASCII e autossuficiente:
//   - confere o sha256 dos arquivos do DEPLOY de que a rodada 3 depende (executor e dependências, registro de 10/10) antes
//     de rodar qualquer node; divergência = código 4 sem rodar nada;
//   - traz scripts/s3s4-staging-20261020.cjs e scripts/s3-cadastro-staging.cjs para a pasta própria (efêmera)
//     /opt/render/project/src/.kidmais-s3s4-staging-20261020/, conferindo o sha256 ANTES de gravar (presente igual =
//     JA_PRESENTE; diferente = código 4 sem gravar nada), e roda o modo do bloco a partir dela;
//   - S4-INICIAR roda a JANELA e só com PRONTO_PARA_S4 inicia o executor da rodada 3 do deploy em segundo plano, numa
//     sessão própria (setsid nohup: nem Ctrl-C nem o fechamento do Shell chegam a ele), com o log no disco persistente sem
//     sobrescrever (noclobber); S4-ENCERRAR roda a recuperação do próprio executor.
// Comum a todos: `bind` desliga o bracketed paste ANTES da guarda e fora do subshell; guarda RENDER_SERVICE_ID antes de
// qualquer leitura/gravação; corpo num SUBSHELL ( … ); no fim CODIGO_SAIDA_BLOCO=<n>: 0/1/2 do script, 4 do bloco.
// Qualquer outro código (127 = linha perdida na colagem, 130 = Ctrl-C, 143 = sinal) ou ausência de CODIGO_SAIDA_BLOCO =
// parar e ler; prompt `>` depois de colar = colagem incompleta: Ctrl-C (nunca colar por cima do `>`) e colar o MESMO bloco.
// Este gerador só lê arquivos e escreve; não conecta nem executa nada.
//   node scripts/bloco-shell-s3s4-staging-20261020.cjs <MODO> <rotulo-da-arvore> <candidata-40-hex>
//   node scripts/bloco-shell-s3s4-staging-20261020.cjs TODOS <rotulo-da-arvore> <candidata-40-hex> <pasta-de-saida-inexistente>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const {createHash} = require('node:crypto');
const janela = require('./s3s4-staging-20261020.cjs');
const executor = require('./homologacao-pagamento-renovacao-staging.cjs');

const DEPLOY = janela.DEPLOY;
const DESTINO = DEPLOY + '/.kidmais-s3s4-staging-20261020';
const SERVICO = janela.SERVICO;
const LIMITE = 32768;
const TRANSPORTADOS = Object.freeze(['scripts/s3s4-staging-20261020.cjs', 'scripts/s3-cadastro-staging.cjs']);
/** Pasta da rodada 3 relativa ao deploy (disco persistente) e o log que o S4-INICIAR cria. */
const DIR_R3 = path.posix.relative(DEPLOY, path.posix.dirname(executor.ARQUIVO));
const LOG_R3 = DIR_R3 + '/' + janela.LOG;
const LOG_ENCERRAR = DIR_R3 + '/pagamento-renovacao-encerrar.log';
const S3S4 = 'node scripts/s3s4-staging-20261020.cjs';
const S4 = 'node --experimental-strip-types scripts/homologacao-pagamento-renovacao-staging.cjs';
const C = '--candidata=@C@';
const MODOS = Object.freeze({
    PRE: {args:'--pre', titulo:['SOMENTE LEITURA, antes de W1 (qualquer deploy): commit no ar, chaves da janela, registro de 10/10, estado da',
        'rodada 3 (arquivavel?), disco e Asaas sandbox (so o status HTTP da chave e contagens de webhooks). Nada gravado no disco.']},
    ARQUIVAR: {args:'--arquivar-r3', titulo:['GRAVA NO DISCO: renomeia (sem apagar conteudo, sem sobrescrever) o estado e o log da tentativa que parou no',
        'PRECHECK sem criar nada. Recusa se o estado tiver qualquer sinal de criacao. So depois do PRE = PRE_OK_ARQUIVAR.']},
    JANELA: {args:'--janela ' + C, titulo:['SOMENTE LEITURA, depois de W1: commit = candidata, chaves do S4, Asaas pronto, estado/log ausentes, antes das',
        '20h BRT, banco (READ ONLY): vagas Fundador e fixtures livres. Esperado PRONTO_PARA_S4.']},
    'S4-INICIAR': {args:null, titulo:['INICIA A RODADA 3 DO S4 (grava em staging e no Asaas sandbox; 3 vagas Fundador ficam CONFIRMADAS para sempre).',
        'Roda a JANELA antes e so inicia com PRONTO_PARA_S4. Executor do deploy em segundo plano (setsid nohup); log no disco, sem sobrescrever.',
        'Somente com o "pode ir" de Felipe para o S4. Nao redeployar o staging ate o S4-ACOMPANHAR dar PASS ou INCOMPLETO.']},
    'S4-ACOMPANHAR': {args:'--s4-acompanhar', titulo:['SOMENTE LEITURA: estado da rodada 3 e ultima linha do log. Repetir ate PASS ou INCOMPLETO.']},
    'S4-ENCERRAR': {args:null, titulo:['CONTINGENCIA (so se o S4-ACOMPANHAR der INTERROMPIDA_SEM_CONCLUSAO ou INCOMPLETO com recursos pendentes):',
        'roda a recuperacao do proprio executor (remove assinaturas sandbox e webhook comprovados, desativa fixtures). Idempotente.']},
    'S3-ANTES': {args:'--s3-antes ' + C + ' ' + janela.CNPJ_S3R, titulo:['S3-R OPCIONAL, SOMENTE LEITURA: janela do cadastro (4 chaves), bloqueios globais e CNPJ novo livre.',
        'Esperado PRONTO_PARA_CADASTRO.']},
    'S3-DEPOIS': {args:'--s3-depois ' + C + ' ' + janela.CNPJ_S3R, titulo:['S3-R OPCIONAL, SOMENTE LEITURA: empresa do CNPJ novo ATIVA, teste de 15 dias, uma Gestao, sem cobranca.',
        'Esperado S3_PASS.']},
    'S4N-DEPOIS': {args:'--s4n-depois ' + C + ' ' + janela.CNPJ_TESTE_S3, titulo:['S4-N OPCIONAL, SOMENTE LEITURA: contratacao feita pelo navegador na empresa TESTE S3 (Essencial mensal',
        'Fundador) confirmada pelo webhook. Esperado S4N_PASS.']},
    POS: {args:'--pos ' + C, titulo:['SOMENTE LEITURA, depois de W7: as quatro chaves ausentes, registro de 10/10 restaurado, resumo da rodada 3.',
        'Esperado RESTAURADO.']},
});
const sha = b => createHash('sha256').update(b).digest('hex');
function ler(raiz, arquivo) {
    const texto = fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n');
    assert.ok(!texto.includes('\r'), 'CR_ISOLADO ' + arquivo);
    return Buffer.from(texto, 'utf8');
}
const seguro = s => { assert.match(s, /^[A-Za-z0-9_./-]+$/, 'CAMINHO_INSEGURO'); return s; };
/** Arquivos transportados (conteúdo LF, sha e carga gzip+base64 determinística) e sha dos arquivos do deploy conferidos. */
function carga(raiz = path.resolve(__dirname, '..')) {
    return TRANSPORTADOS.map(a => {
        const b = ler(raiz, a);
        return {arquivo:seguro(a), sha:sha(b), bytes:b.length, b64:zlib.gzipSync(b, {level:9}).toString('base64').match(/.{1,76}/g)};
    });
}
function conferidos(raiz = path.resolve(__dirname, '..')) { return janela.DEPLOY_S4.map(a => ({arquivo:seguro(a), sha:sha(ler(raiz, a))})); }

function cabecalho(modo, rotulo, candidata) {
    return ['#!/usr/bin/env bash',
        `# BLOCO-SHELL-S3S4-STAGING-20261020-${modo} - Web Shell do ${SERVICO} (kidmais-manager-staging). Colar inteiro, uma vez, e Enter.`,
        ...MODOS[modo].titulo.map(t => '# ' + t),
        `# Candidata (commit que o deploy de W1 deve por no ar): ${candidata}`,
        `# Gerado da arvore ${rotulo} por scripts/bloco-shell-s3s4-staging-20261020.cjs. Conferir sha256 e bytes antes de colar.`,
        '# Se aparecer o prompt ">" depois de colar (colagem incompleta): Ctrl-C, nunca colar por cima; depois colar o MESMO bloco.',
        '# Fim esperado: CODIGO_SAIDA_BLOCO=<n> (0 ok, 2 divergente, 1 recusado, 4 bloco). Outro codigo (127, 130, 143...) ou sem essa linha = parar e ler.',
        '# O bind abaixo roda ANTES da guarda e FORA do subshell: desliga o bracketed paste pelo resto desta sessao. A guarda de',
        '# RENDER_SERVICE_ID vem antes de qualquer leitura/gravacao. Corpo em subshell: opcoes, trap, umask e cwd nao vazam.',
        "bind 'set enable-bracketed-paste off' 2>/dev/null",
        `if [ "$RENDER_SERVICE_ID" != "${SERVICO}" ]; then echo "SHELL_ERRADO_NAO_E_STAGING ($RENDER_SERVICE_ID): nada executado"; else`];
}

/**
 * `destino`, `deploy`, `s3s4`, `s4`, `lancador` e `espera` existem para os testes locais (pastas temporárias; comandos
 * substitutos; o Git Bash não tem setsid; espera curta). A CLI usa sempre as pastas do staging, os comandos reais,
 * `setsid nohup` e 15 s de espera depois de iniciar o S4.
 */
function gerar({modo, rotulo, candidata, raiz = path.resolve(__dirname, '..'), destino = DESTINO, deploy = DEPLOY, s3s4 = S3S4, s4 = S4, lancador = 'setsid nohup', espera = 15}) {
    assert.ok(Object.hasOwn(MODOS, modo), 'MODO_DESCONHECIDO');
    assert.match(String(rotulo), /^[0-9a-f]{7,40}$/, 'ROTULO_INVALIDO');
    assert.match(String(candidata), /^[0-9a-f]{40}$/, 'CANDIDATA_INVALIDA');
    for (const d of [destino, deploy]) assert.match(d, /^(?:[A-Za-z]:)?\/[A-Za-z0-9_./-]+$/, 'DESTINO_INVALIDO');
    assert.ok(Number.isInteger(espera) && espera >= 0 && espera <= 60, 'ESPERA_INVALIDA');
    assert.match(lancador, /^[a-z]+( [a-z]+)*$/, 'LANCADOR_INVALIDO');
    const lista = carga(raiz), deployConferido = conferidos(raiz);
    const cmd = args => `${s3s4} ${args.replace('@C@', candidata)}`;
    const c = ['set -euo pipefail', 'umask 077',
        `cd '${deploy}' || { echo "DEPLOY_INACESSIVEL"; exit 4; }`,
        'for f in sha256sum base64 gzip mktemp node; do command -v "$f" >/dev/null || { echo "FERRAMENTA_AUSENTE $f"; exit 4; }; done',
        'h() { sha256sum "$1" | cut -d" " -f1; }',
        // Arquivos do deploy: o executor da rodada 3 e o registro de 10/10 são lidos por este script; nada roda se divergirem.
        'conf() { { [ -f "$1" ] && [ "$(h "$1")" = "$2" ]; } || { echo "DEPLOY_DIVERGENTE $1"; exit 4; }; }',
        ...deployConferido.map(x => `conf ${x.arquivo} ${x.sha}`),
        `echo "DEPLOY_CONFERIDO ${deployConferido.length}"`,
        `mkdir -p '${destino}' && cd '${destino}' || { echo "DESTINO_INACESSIVEL"; exit 4; }`,
        'T="$(mktemp -d)" || { echo "TEMPORARIO_FALHOU"; exit 4; }', "trap 'rm -rf -- \"$T\" || echo \"TEMPORARIO_NAO_REMOVIDO $T\"' EXIT",
        // Fase 1: decodificar e conferir no temporário; fase 2: nenhum presente diferente; fase 3: gravar.
        'prep() { { base64 -d | gzip -dc > "$T/$1"; } 2>/dev/null || { echo "CONTEUDO_DIVERGENTE $2"; exit 4; }; [ "$(h "$T/$1")" = "$1" ] || { echo "CONTEUDO_DIVERGENTE $2"; exit 4; }; }',
        'livre() { [ ! -e "$1" ] || [ "$(h "$1")" = "$2" ] || { echo "JA_EXISTE_DIFERENTE $1"; exit 4; }; }',
        'inst() { if [ -e "$1" ]; then echo "JA_PRESENTE $1"; else { mkdir -p "$(dirname "$1")" && cp "$T/$2" "$1"; } || { echo "GRAVACAO_FALHOU $1"; exit 4; }; echo "ESCRITO $1"; fi; }'];
    for (const x of lista) c.push(`prep ${x.sha} ${x.arquivo} <<'B64'`, ...x.b64, 'B64');
    for (const x of lista) c.push(`livre ${x.arquivo} ${x.sha}`);
    for (const x of lista) c.push(`inst ${x.arquivo} ${x.sha}`);
    c.push(`echo "ARQUIVOS_OK ${lista.length}"`, 'codigo=0');
    if (modo === 'S4-INICIAR') {
        c.push(`${cmd('--janela ' + C)} || codigo=$?`,
            'if [ "$codigo" != 0 ]; then echo "S4_NAO_INICIADO (a JANELA recusou com codigo $codigo; nada foi iniciado)"; exit "$codigo"; fi',
            `cd '${deploy}'`, `[ ! -e '${LOG_R3}' ] || { echo "LOG_R3_PRESENTE (arquivar antes; nada foi iniciado)"; exit 4; }`,
            `for f in ${lancador}; do command -v "$f" >/dev/null || { echo "FERRAMENTA_AUSENTE $f (nada foi iniciado)"; exit 4; }; done`, 'set -o noclobber',
            `${lancador} ${s4} ${executor.FLAG} > '${LOG_R3}' 2>&1 < /dev/null &`,
            'echo "S4_INICIADO PID=$! (anotar). Sessao propria: fechar o Shell nao interrompe. Nao redeployar o staging ate o S4-ACOMPANHAR dar PASS ou INCOMPLETO."',
            `sleep ${espera}`, `cd '${destino}'`, `${cmd('--s4-acompanhar')} || true`, 'exit 0');
    } else if (modo === 'S4-ENCERRAR') {
        c.push(`cd '${deploy}'`, `${s4} ${executor.FLAG_ENCERRAR} 2>&1 | tee -a '${LOG_ENCERRAR}' || codigo=$?`,
            `cd '${destino}'`, `${cmd('--s4-acompanhar')} || true`, 'exit "$codigo"');
    } else {
        c.push(`${cmd(MODOS[modo].args)} || codigo=$?`, 'exit "$codigo"');
    }
    const bloco = [...cabecalho(modo, rotulo, candidata), '(', ...c, ')', 'echo "CODIGO_SAIDA_BLOCO=$?"', 'fi'].join('\n') + '\n';
    assert.match(bloco, /^[\x09\x0a\x20-\x7e]*$/, 'BLOCO_NAO_ASCII');
    assert.ok(Buffer.byteLength(bloco) <= LIMITE, 'BLOCO_MAIOR_QUE_32KB ' + modo + ' ' + Buffer.byteLength(bloco));
    return bloco;
}
const nomeArquivo = modo => `BLOCO-SHELL-S3S4-STAGING-20261020-${modo}.sh`;

if (require.main === module) {
    try {
        const [modo, rotulo, candidata, saida] = process.argv.slice(2);
        if (modo === 'TODOS') {
            assert.ok(saida && !fs.existsSync(saida), 'PASTA_DE_SAIDA_INVALIDA_OU_EXISTENTE');
            fs.mkdirSync(saida, {recursive:true});
            for (const m of Object.keys(MODOS)) {
                const bloco = gerar({modo:m, rotulo, candidata});
                fs.writeFileSync(path.join(saida, nomeArquivo(m)), bloco, {flag:'wx'});
                console.log(`${sha(Buffer.from(bloco, 'utf8'))}  ${Buffer.byteLength(bloco, 'utf8')}  ${nomeArquivo(m)}`);
            }
        } else {
            const bloco = gerar({modo, rotulo, candidata});
            process.stdout.write(bloco);
            console.error(`${nomeArquivo(modo)} sha256 ${sha(Buffer.from(bloco, 'utf8'))} (${Buffer.byteLength(bloco, 'utf8')} bytes)`);
        }
    } catch (e) { console.error('RECUSADO ' + String(e?.message ?? e).split(/\r?\n/)[0].slice(0, 160)); process.exitCode = 1; }
}
module.exports = {DEPLOY, DESTINO, SERVICO, TRANSPORTADOS, MODOS, LIMITE, DIR_R3, LOG_R3, LOG_ENCERRAR, carga, conferidos, gerar, nomeArquivo};
