/* eslint-disable @typescript-eslint/no-require-imports */
// Conferência da conexão real dos executores de staging (aplicador 076/077 e homologação de planos/cotação).
// A trava de alvo (assinatura-staging-ensaio.cjs) fixa serviço, ambiente, host interno, porta e banco; aqui se confere
// o que o servidor responde. O TLS esperado é o da configuração da própria aplicação (lib/db/postgres.ts):
// DATABASE_SSL=true exige TLS com certificado verificado; DATABASE_SSL=false só vale na rede privada do Render
// (host interno sem domínio, endereço do servidor em faixa privada). Nada aqui relaxa a trava global.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/** Disco persistente do web staging (metadados do serviço: dsk-daif418ae00c73e8k340). */
const DISCO = '/opt/render/project/src/data';
const BANCO = 'kidmais_staging_1z91';
const SQL_IDENTIDADE = `SELECT current_database() AS db,
    (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls,
    coalesce(inet_server_addr() << ANY('{10.0.0.0/8,172.16.0.0/12,192.168.0.0/16}'::inet[]), false) AS servidor_privado`;

/** TLS que a configuração atual exige; recusa o que a trava não prevê (certificado sem verificação, valor ausente). */
function tlsEsperado(env) {
    assert.ok(['true', 'false'].includes(env.DATABASE_SSL), 'SSL_CONFIGURACAO_RECUSADA');
    if (env.DATABASE_SSL === 'false') return false;
    assert.notEqual(env.DATABASE_SSL_REJECT_UNAUTHORIZED, 'false', 'CERTIFICADO_SEM_VERIFICACAO_RECUSADO');
    return true;
}

/** Linha de SQL_IDENTIDADE contra a configuração: banco exato, TLS conforme DATABASE_SSL, sem TLS só em endereço privado. */
function conferirIdentidade(id, env, sufixo = '') {
    const tls = tlsEsperado(env);
    assert.equal(id?.db, BANCO, 'BANCO' + sufixo);
    assert.equal(id.tls, tls, 'TLS' + sufixo);
    if (!tls) assert.equal(id.servidor_privado, true, 'REDE_PRIVADA' + sufixo);
    return {banco:id.db, tls:id.tls, redePrivada:id.servidor_privado === true};
}

/**
 * Estado e evidências só no disco montado: sem ele, o diretório seria criado no sistema de arquivos efêmero, a
 * tentativa anterior ficaria invisível e um replay passaria. Ponto de montagem = dispositivo diferente do pai.
 */
function exigirDisco(disco = DISCO, stat = fs.statSync) {
    let d, pai;
    try { d = stat(disco); pai = stat(path.dirname(disco)); } catch { d = null; }
    assert.ok(d && d.isDirectory() && d.dev !== pai.dev, 'DISCO_PERSISTENTE_AUSENTE');
}

module.exports = {BANCO, DISCO, SQL_IDENTIDADE, tlsEsperado, conferirIdentidade, exigirDisco};
