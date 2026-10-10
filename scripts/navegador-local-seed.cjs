/* eslint-disable @typescript-eslint/no-require-imports */
// Navegador local (docs/NAVEGADOR_LOCAL_20261010.md): popula um PostgreSQL LOCAL e DESCARTÁVEL com contas SINTÉTICAS para
// testes de interface no navegador embutido, contra o servidor Next local (scripts/navegador-local-servidor.cjs).
// Sem argumento (ou --plano): plano offline, nenhuma conexão. Execução SOMENTE com a flag única --seed-navegador-autorizado
// e KIDMAIS_NAVEGADOR_AUTORIZACAO=127.0.0.1:55481/kidmais_navegador_<nome>. O cluster (kidmais_navegador, porta 55481) é
// criado e removido por scripts/cluster-descartavel-postgres.cjs; este script nunca cria, para nem apaga cluster ou banco.
// Recusa antes de abrir socket: host fora de 127.0.0.1/localhost, porta diferente de 55481, banco fora do padrão, nomes de
// banco real/staging/produção, DATABASE_URL apontando para outro alvo, PG* herdadas, prazos comerciais herdados.
// Depois confere identidade (banco, papel, endereço, porta, cluster_name) e exige cluster novo (nenhum outro banco).
// Estados montados pelos serviços de domínio (oferta, confirmação, convites, catálogo, renovação); SQL direto só cria as
// fixtures que os serviços pressupõem (empresa, pessoa, vínculo, linha de teste, isenção), respeitando os gatilhos.
// Senhas sintéticas só no arquivo ignorado pelo Git .local-navegador/credenciais.json (nunca no console). Sem rede.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash, randomBytes, randomUUID} = require('node:crypto');
const {pathToFileURL} = require('node:url');

const raiz = path.resolve(__dirname, '..');
const FLAG = '--seed-navegador-autorizado';
const FLAG_PLANO = '--plano';
const VAR_AUTORIZACAO = 'KIDMAIS_NAVEGADOR_AUTORIZACAO';
const PAPEL = 'kidmais_navegador'; // papel do initdb e cluster_name (lista fechada da ferramenta de ciclo de vida)
const PORTA = 55481;
const BANCO_SUGERIDO = 'kidmais_navegador_20261010';
const PADRAO_BANCO = /^kidmais_navegador_[a-z0-9_]{1,40}$/;
const NOMES_PROIBIDOS = Object.freeze(['kidmais_manager', 'staging', 'production', 'producao']);
const HOSTS_ACEITOS = Object.freeze(['127.0.0.1', 'localhost']);
const PORTA_APP = 3481;
const ORIGEM_APP = `http://localhost:${PORTA_APP}`;
const PASTA_LOCAL = '.local-navegador';
const ARQUIVO_CREDENCIAIS = path.join(raiz, PASTA_LOCAL, 'credenciais.json');
/** 076/077 entraram no inventário aprovado (aplicadas em staging em 10/10/2026); vêm dele com os próprios checks. */
const ULTIMA_INVENTARIO = '20261010_077_regras_pagamento_empresa.sql';
/** Impressão (sha256, CRLF normalizado) de migrations + checks. Mudou → revisar o pacote e aprovar de novo. */
const IMPRESSAO_SCHEMA = '8a9a97477eac3d046dbd891bfd601df6e8f301f469247ef1e5e0f13403e03cfb';
const VARIAVEIS_COMERCIAIS = Object.freeze(['ASSINATURA_TESTE_DIAS', 'ASSINATURA_REGULARIZACAO_DIAS', 'ASSINATURA_SOMENTE_LEITURA_DIAS']);

/** Empresas sintéticas: cada uma cobre um estado da matriz do navegador. */
const EMPRESAS = Object.freeze([
    ['essencial', 'nav-essencial', 'Buffet Sintético Essencial', 'PLANO', 'essencial'],
    ['profissional', 'nav-profissional', 'Buffet Sintético Profissional', 'PLANO', 'profissional'],
    ['premium', 'nav-premium', 'Buffet Sintético Premium', 'PLANO', 'premium'],
    ['teste', 'nav-teste', 'Buffet Sintético em Teste', 'TESTE', null],
    ['isenta', 'nav-isenta', 'Buffet Sintético Isento', 'ISENTA', null],
    ['expirada', 'nav-teste-expirado', 'Buffet Sintético Teste Expirado', 'TESTE_EXPIRADO', null],
].map(([chave, codigo, nome, tipo, plano]) => Object.freeze({chave, codigo, nome:`${nome} (TESTE navegador)`, tipo, plano,
    catalogo:tipo === 'PLANO', renovacao:chave === 'premium'})));
/** Contas: Gestão de cada empresa, uma pessoa da Equipe no Essencial e uma Gestão com duas empresas (seleção). */
const CONTAS = Object.freeze([
    ['essencial-gestao', 'REPRESENTANTE_AUTORIZADO', ['essencial']],
    ['essencial-equipe', 'ADMINISTRATIVO', ['essencial']],
    ['profissional-gestao', 'REPRESENTANTE_AUTORIZADO', ['profissional']],
    ['premium-gestao', 'REPRESENTANTE_AUTORIZADO', ['premium']],
    ['teste-gestao', 'REPRESENTANTE_AUTORIZADO', ['teste']],
    ['isenta-gestao', 'REPRESENTANTE_AUTORIZADO', ['isenta']],
    ['expirada-gestao', 'REPRESENTANTE_AUTORIZADO', ['expirada']],
    ['multiempresa-gestao', 'REPRESENTANTE_AUTORIZADO', ['profissional', 'teste']],
].map(([rotulo, papel, empresas]) => Object.freeze({rotulo, papel, empresas:Object.freeze(empresas), email:`nav-${rotulo}@example.invalid`})));
/** Convite pendente que completa 3/3 no Essencial (Gestão + Equipe + convite). */
const EMAIL_CONVITE_ESSENCIAL = 'nav-essencial-convite@example.invalid';
/** Faixa única do pacote das empresas com catálogo: 20–30 convidados, valor fixo. */
const FAIXA = Object.freeze({min:20, max:30, valor:'1500.00'});

const recusa = (codigo, detalhe) => Object.assign(Error(detalhe ? `${codigo} ${detalhe}` : codigo), {codigo});

function modo(argv) {
    if (argv.length === 0 || (argv.length === 1 && argv[0] === FLAG_PLANO)) return 'PLANO';
    if (argv.length === 1 && argv[0] === FLAG) return 'EXECUTAR';
    return null;
}

/** Nome de banco aceito: padrão do cluster e nenhum nome de ambiente real. */
function validarBanco(banco) {
    if (typeof banco !== 'string' || NOMES_PROIBIDOS.some(n => banco.toLowerCase().includes(n))) throw recusa('BANCO_PROIBIDO');
    if (!PADRAO_BANCO.test(banco)) throw recusa('BANCO_FORA_DO_PADRAO');
    return banco;
}

/** Alvo literal; nenhum padrão implícito. Lança antes de qualquer conexão. */
function alvo(env) {
    const texto = env[VAR_AUTORIZACAO];
    if (typeof texto !== 'string' || texto === '') throw recusa('AUTORIZACAO_AUSENTE');
    const m = /^([^:/\s]+):([0-9]{1,5})\/([A-Za-z0-9_]+)$/.exec(texto);
    if (!m) throw recusa('AUTORIZACAO_MALFORMADA');
    const [, host, portaTexto, banco] = m;
    if (!HOSTS_ACEITOS.includes(host.toLowerCase())) throw recusa('HOST_RECUSADO');
    validarBanco(banco);
    if (Number(portaTexto) !== PORTA) throw recusa('PORTA_RECUSADA');
    // localhost pode resolver para ::1; o conector usa sempre 127.0.0.1 e confere o endereço no servidor.
    return Object.freeze({host:'127.0.0.1', porta:PORTA, banco});
}

/** PG* herdadas recusadas; DATABASE_URL só é tolerada se apontar exatamente para o mesmo alvo (e nem é usada). */
function semConexaoHerdada(env, a) {
    const pg = Object.keys(env).filter(n => /^PG/i.test(n));
    if (pg.length) throw recusa('CONEXAO_HERDADA', pg.join(','));
    if (env.DATABASE_URL === undefined) return;
    let u;
    try { u = new URL(env.DATABASE_URL); } catch { throw recusa('DATABASE_URL_DIVERGENTE'); }
    const mesmo = ['postgres:', 'postgresql:'].includes(u.protocol) && HOSTS_ACEITOS.includes(u.hostname.toLowerCase())
        && Number(u.port) === a.porta && decodeURIComponent(u.pathname.replace(/^\//, '')) === a.banco;
    if (!mesmo) throw recusa('DATABASE_URL_DIVERGENTE');
}

/** Prazos comerciais herdados mudariam o estado esperado (ex.: teste expirado virar somente leitura). */
function semPrazoComercialHerdado(env) {
    const herdadas = VARIAVEIS_COMERCIAIS.filter(n => env[n] !== undefined);
    if (herdadas.length) throw recusa('PRAZO_COMERCIAL_HERDADO', herdadas.join(','));
}

const SQL_IDENTIDADE = `SELECT current_database() AS db, current_user AS papel, host(inet_server_addr()) AS endereco,
    inet_server_port() AS porta, current_setting('cluster_name') AS cluster,
    ARRAY(SELECT datname::text FROM pg_database WHERE datname NOT IN ('postgres','template0','template1') ORDER BY 1) AS bancos`;
/** Servidor certo e cluster novo: só o banco desta execução pode existir. */
function conferirIdentidade(linha, a, database, bancosEsperados) {
    const r = linha ?? {};
    const obtido = {db:r.db, papel:r.papel, endereco:r.endereco, porta:Number(r.porta), cluster:r.cluster, bancos:r.bancos};
    const esperado = {db:database, papel:PAPEL, endereco:'127.0.0.1', porta:a.porta, cluster:PAPEL, bancos:bancosEsperados};
    try { assert.deepEqual(obtido, esperado); } catch { throw recusa('IDENTIDADE_DIVERGENTE'); }
    return true;
}

/** A pasta local só recebe credenciais se o Git já a ignora (regra .local-* na raiz) e nenhuma regra a reinclui. */
function conferirGitignore(texto) {
    const linhas = String(texto ?? '').replace(/^﻿/, '').split(/\r?\n/).map(l => l.trim());
    const regra = linhas.find(l => ['.local-*/', '.local-*', '/.local-*/', '/.local-*'].includes(l)) ?? null;
    const reinclusao = linhas.some(l => l.startsWith('!') && l.includes('.local-'));
    return {ignorada:Boolean(regra) && !reinclusao, regra};
}

/** Remove e-mails, tokens, UUIDs e hashes; limita o tamanho. Saída e falhas só passam por aqui. */
function sanitizar(texto) {
    return String(texto ?? '')
        .replace(/[^\s@'"]+@[^\s@'"]+/g, '<email>')
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
        .replace(/\b[0-9a-f]{64}\b/gi, '<hash>')
        .replace(/Nav-[A-Za-z0-9_-]{20,}/g, '<senha>')
        .replace(/\b(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{20,}\b/g, '<token>')
        .slice(0, 160);
}

/** Senha sintética por conta (24 caracteres base64url); só existe em memória e no arquivo ignorado. */
const gerarSenha = () => 'Nav-' + randomBytes(18).toString('base64url');

/** Conteúdo do arquivo de credenciais (puro). Nunca é impresso. */
function montarCredenciais(a, senhas, agora = new Date()) {
    const empresa = chave => EMPRESAS.find(e => e.chave === chave);
    return {
        aviso:'Contas SINTÉTICAS do banco local descartável. Não reutilizar em nenhum outro ambiente. Apagar ao remover o cluster.',
        origem:ORIGEM_APP, banco:`${a.host}:${a.porta}/${a.banco}`, geradoEm:agora.toISOString(),
        contas:CONTAS.map(c => ({rotulo:c.rotulo, email:c.email, senha:senhas.get(c.rotulo), papel:c.papel === 'REPRESENTANTE_AUTORIZADO' ? 'Gestão' : 'Equipe',
            empresas:c.empresas.map(k => ({codigo:empresa(k).codigo, nome:empresa(k).nome}))})),
        enderecosPublicos:EMPRESAS.filter(e => e.catalogo).map(e => ({codigo:e.codigo, fechamento:`${ORIGEM_APP}/b/${e.codigo}/fechamento`,
            disponibilidade:`${ORIGEM_APP}/b/${e.codigo}/disponibilidade`, esperado:e.plano === 'essencial' ? 404 : 200})),
    };
}

/** Grava sem sobrescrever (flag wx) e com 0600; no Windows o modo só controla somente-leitura e valem as ACLs da pasta. */
function escreverCredenciais(arquivo, dados, fsImpl = fs) {
    fsImpl.mkdirSync(path.dirname(arquivo), {recursive:true, mode:0o700});
    fsImpl.writeFileSync(arquivo, JSON.stringify(dados, null, 2) + '\n', {flag:'wx', mode:0o600});
}

const lerNormalizado = relativo => fs.readFileSync(path.join(raiz, relativo), 'utf8').replace(/\r\n/g, '\n');
const sha = texto => createHash('sha256').update(texto).digest('hex');

/** Mesma receita de scripts/assinatura-schema-completo.cjs: inventário aprovado (até a 077) + checks. */
async function plano() {
    const {approvedFiles, requiredChecks} = await import(pathToFileURL(path.join(raiz, 'scripts/production/check-migrations.mjs')).href);
    if (approvedFiles.at(-1) !== ULTIMA_INVENTARIO) throw recusa('INVENTARIO_MUDOU');
    const etapas = approvedFiles.map(arquivo => {
        const checks = (arquivo === '20261009_074a_planos_comerciais.sql' ? ['20261009_074a_precheck.sql', '20261009_074a_postcheck.sql'] : requiredChecks(arquivo))
            .map(p => `database/checks/${p}`);
        if (arquivo.split('_')[1] === '011') checks.push('database/checks/20260908_011_pagamentos_postcheck.sql');
        return {migration:`database/migrations/${arquivo}`, antes:checks.filter(p => p.includes('precheck')), depois:checks.filter(p => !p.includes('precheck'))};
    });
    const fontes = [...new Set(etapas.flatMap(e => [...e.antes, e.migration, ...e.depois]))];
    const impressao = sha(fontes.map(f => `${f}\0${sha(lerNormalizado(f))}\n`).join(''));
    return {etapas, migrations:etapas.length, arquivos:fontes.length, ultima:ULTIMA_INVENTARIO, impressao};
}

async function conectar(a, database, bancosEsperados) {
    const {Client} = require('pg');
    const c = new Client({host:a.host, port:a.porta, user:PAPEL, database, ssl:false, connectionTimeoutMillis:5000,
        password:async () => { throw recusa('SERVIDOR_PEDIU_SENHA'); }, application_name:'kidmais-navegador-seed'});
    await c.connect();
    try {
        conferirIdentidade((await c.query(SQL_IDENTIDADE)).rows[0], a, database, bancosEsperados);
        await c.query("SET statement_timeout='60s'"); await c.query("SET lock_timeout='10s'");
        return c;
    } catch (e) { await c.end().catch(() => {}); throw e; }
}

function hashFalso() {
    const b64 = n => randomBytes(n).toString('base64').replace(/=+$/, '');
    return `scrypt$v=1$N=131072$r=8$p=1$${b64(16)}==$${b64(64)}==`;
}

async function construirSchema(a, p) {
    const admin = await conectar(a, 'postgres', []);
    try { await admin.query(`CREATE DATABASE ${a.banco} TEMPLATE template0 ENCODING 'UTF8'`); } finally { await admin.end(); }
    const c = await conectar(a, a.banco, [a.banco]);
    try {
        for (const etapa of p.etapas) {
            if (etapa.migration.includes('_046_')) {
                // Pré-condição histórica da 046 (igual à receita canônica): identidade sintética, sem login nem e-mail.
                const email = lerNormalizado(etapa.migration).match(/email_alvo text := '([^']+)'/)?.[1];
                assert.ok(email, 'FIXTURE_046_REVISAR');
                await c.query(`INSERT INTO usuarios_administrativos(email,nome,cargo,senha_hash,papel,ativo)
                    VALUES(lower(btrim($1)),'Representante Fixture Sintética','Fixture de teste',$2,'REPRESENTANTE_AUTORIZADO',true)`, [email, hashFalso()]);
            }
            for (const arquivo of [...etapa.antes, etapa.migration, ...etapa.depois]) await c.query(lerNormalizado(arquivo));
        }
    } finally { await c.end(); }
}

/** Documento sintético no formato aceito (14 posições), começando por 7 para não colidir com CNPJ real conhecido. */
function documentoSintetico(usados) {
    let d;
    do d = '7' + String(randomBytes(6).readUIntBE(0, 6)).padStart(13, '0').slice(-13); while (usados.has(d));
    usados.add(d);
    return d;
}

async function popular(c, senhas) {
    const ex = {query:async (sql, params) => { const r = await c.query(sql, params); return {rows:r.rows, rowCount:r.rowCount}; }};
    let emTransacao = false;
    const withTransaction = async trabalho => {
        assert.equal(emTransacao, false, 'TRANSACAO_ANINHADA');
        emTransacao = true;
        await c.query('BEGIN');
        try { const r = await trabalho(ex); await c.query('COMMIT'); return r; }
        catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
        finally { emTransacao = false; }
    };
    const {carregarModulo} = await import(pathToFileURL(path.join(raiz, 'lib/acessos/teste-carregador.ts')).href);
    const cache = new Map();
    const carregar = f => carregarModulo(path.join(raiz, f), {'db/postgres':{db:() => ex, withTransaction}}, cache);
    const s = {senha:carregar('lib/autenticacao/senha.ts'), ofertas:carregar('lib/assinatura/ofertas.ts'), planos:carregar('lib/assinatura/planos-comerciais.ts'),
        convites:carregar('lib/acessos/convites.ts'), limites:carregar('lib/assinatura/limites-usuarios.ts'), precos:carregar('lib/comercial/pacote-precos.ts'),
        pacotes:carregar('lib/comercial/pacotes-admin.ts'), renovacaoRepo:carregar('lib/assinatura/renovacao-repositorio.ts'),
        renovacao:carregar('lib/assinatura/renovacao-fundador.ts'), estado:carregar('lib/assinatura/estado.ts'), recursos:carregar('lib/assinatura/recursos-plano.ts'),
        cotacao:carregar('lib/comercial/cotacao-publica.ts')};
    const q = async (sql, params) => (await ex.query(sql, params)).rows;
    const documentos = new Set();
    const ids = Object.fromEntries(EMPRESAS.map(e => [e.chave, {empresa:randomUUID(), documento:documentoSintetico(documentos)}]));
    const usuarios = Object.fromEntries(CONTAS.map(conta => [conta.rotulo, randomUUID()]));
    const gestaoDe = chave => usuarios[CONTAS.find(conta => conta.empresas[0] === chave && conta.papel === 'REPRESENTANTE_AUTORIZADO').rotulo];

    // ---- Fixtures (mesmas transições que o banco aceita para empresas novas).
    const hashes = new Map();
    for (const conta of CONTAS) hashes.set(conta.rotulo, await s.senha.criarHashSenha(senhas.get(conta.rotulo)));
    await withTransaction(async tx => {
        for (const e of EMPRESAS) {
            const id = ids[e.chave];
            await tx.query("INSERT INTO empresas(id,codigo,nome,status) VALUES($1,$2,$3,'PROVISIONAMENTO')", [id.empresa, e.codigo, e.nome]);
            await tx.query("UPDATE empresas SET status='ATIVA' WHERE id=$1", [id.empresa]);
        }
        for (const conta of CONTAS) {
            await tx.query(`INSERT INTO usuarios_administrativos(id,nome,email,cargo,senha_hash,papel,ativo)
                VALUES($1,$2,$3,'Fixture navegador',$4,$5,true)`, [usuarios[conta.rotulo], `Pessoa sintética ${conta.rotulo}`, conta.email, hashes.get(conta.rotulo), conta.papel]);
            await tx.query("UPDATE usuarios_administrativos SET senha_alterada_em=clock_timestamp()-interval '1 hour' WHERE id=$1", [usuarios[conta.rotulo]]);
            for (const chave of conta.empresas) {
                await tx.query("INSERT INTO memberships(empresa_id,usuario_id,papel,status,vigente_desde) VALUES($1,$2,$3,'PENDENTE',clock_timestamp())",
                    [ids[chave].empresa, usuarios[conta.rotulo], conta.papel]);
                await tx.query("UPDATE memberships SET status='ATIVA' WHERE empresa_id=$1 AND usuario_id=$2", [ids[chave].empresa, usuarios[conta.rotulo]]);
            }
        }
        for (const e of EMPRESAS) {
            const id = ids[e.chave];
            if (e.tipo === 'PLANO' || e.tipo === 'TESTE')
                await tx.query(`INSERT INTO empresa_assinaturas(empresa_id,situacao,teste_inicio,teste_fim,documento_teste)
                    VALUES($1,'TESTE',clock_timestamp(),clock_timestamp()+interval '15 days',$2)`, [id.empresa, id.documento]);
            if (e.tipo === 'TESTE_EXPIRADO') // 75 dias após o fim: além dos 60 de somente leitura → BLOQUEADO
                await tx.query(`INSERT INTO empresa_assinaturas(empresa_id,situacao,teste_inicio,teste_fim,documento_teste)
                    VALUES($1,'TESTE',clock_timestamp()-interval '90 days',clock_timestamp()-interval '75 days',$2)`, [id.empresa, id.documento]);
            if (e.tipo === 'ISENTA')
                await tx.query("INSERT INTO assinatura_isencoes(empresa_id,documento_verificado,motivo,concedida_por) VALUES($1,$2,'Isenção sintética navegador local',$3)",
                    [id.empresa, id.documento, gestaoDe(e.chave)]);
        }
    });

    // ---- Contratos confirmados pelos serviços (oferta → pagamento conferido → ativação), provedor falso, sem rede.
    const hoje = (await q("SELECT to_char(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD') AS dia"))[0].dia;
    for (const e of EMPRESAS.filter(x => x.tipo === 'PLANO')) {
        const empresaId = ids[e.chave].empresa, gestao = gestaoDe(e.chave);
        const oferta = await withTransaction(async tx => {
            const ocupadas = (await tx.query("SELECT count(*)::int AS n FROM assinatura_fundadores WHERE estado<>'LIBERADA'")).rows[0].n;
            const fundador = ocupadas < s.planos.condicoesComerciais.fundador.vagas;
            return s.ofertas.prepararOferta(tx, empresaId, gestao, {plano:e.plano, ciclo:'MENSAL',
                valorEsperadoCentavos:s.planos.valorComercial(e.plano, 'mensal', fundador), versao:s.planos.condicoesComerciais.versao});
        });
        const sub = {id:`sub_nav_${e.chave}`, customer:`cus_nav_${e.chave}`, externalReference:empresaId, cycle:'MONTHLY', status:'ACTIVE', deleted:false, valorCentavos:oferta.valor_final_centavos};
        const pago = {id:`pay_nav_${e.chave}`, status:'RECEIVED', dueDate:hoje, paymentDate:hoje, invoiceUrl:null, deleted:false,
            valorCentavos:oferta.valor_final_centavos, assinaturaId:sub.id, clienteId:sub.customer, billingType:'PIX'};
        await withTransaction(async tx => {
            await tx.query('SELECT id FROM empresas WHERE id=$1 FOR UPDATE', [empresaId]);
            await tx.query('SELECT empresa_id FROM empresa_assinaturas WHERE empresa_id=$1 FOR UPDATE', [empresaId]);
            const x = await s.ofertas.confirmarOfertaPaga(tx, empresaId, sub, [pago], sub.customer);
            assert.ok(x, 'CONTRATO_NAO_CONFIRMADO');
            await tx.query(`UPDATE empresa_assinaturas SET situacao='ATIVA',ciclo='MENSAL',plano=$2,contratacao_atual_id=$3,provedor='ASAAS',
                provedor_cliente_id=$4,provedor_assinatura_id=$5,periodo_atual_fim=clock_timestamp()+interval '1 month' WHERE empresa_id=$1`,
                [empresaId, x.plano, x.id, sub.customer, sub.id]);
        });
    }

    // ---- Essencial em 3/3: Gestão + Equipe ativas + um convite pendente (serviço de convites, sem envio de e-mail).
    await withTransaction(tx => s.convites.criarConviteNaTransacao(tx, {gerarToken:() => randomBytes(32).toString('base64url')},
        {empresaId:ids.essencial.empresa, email:EMAIL_CONVITE_ESSENCIAL, nomeSugerido:null, papel:'ADMINISTRATIVO', criadoPor:gestaoDe('essencial')}));

    // ---- Catálogo mínimo pelos serviços de domínio (mesmo padrão da homologação de planos/cotação).
    const horarios = (await q('SELECT id::text AS id FROM configuracao_agenda WHERE ativo ORDER BY id')).map(x => x.id);
    assert.ok(horarios.length > 0, 'AGENDA_SEM_HORARIOS');
    for (const e of EMPRESAS.filter(x => x.catalogo)) {
        const empresaId = ids[e.chave].empresa;
        const ctx = () => ({empresaId, usuarioId:gestaoDe(e.chave), requestId:randomUUID(), motivo:'PACOTE_EDITADO'});
        const pacote = (await q(`INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente, convidados_minimos, convidados_maximos)
            VALUES ($1, 'POCKET', 'Pocket sintético', 1, true, true, $2, $3) RETURNING id`, [empresaId, FAIXA.min, FAIXA.max]))[0].id;
        await withTransaction(tx => s.precos.gravarFaixasPacote(tx, empresaId, pacote, [{convidadosMin:FAIXA.min, convidadosMax:FAIXA.max, valor:FAIXA.valor}],
            {minimo:FAIXA.min, maximo:FAIXA.max}, ctx()));
        await withTransaction(tx => s.pacotes.definirDisponibilidadePacoteAdmin(tx, pacote,
            {disponibilidade:[1, 2, 3, 4, 5, 6, 7].flatMap(dia => horarios.map(horarioId => ({dia, horarioId})))}, ctx()));
    }

    // ---- Renovação Fundador pendente (Premium), montada como processarRenovacao monta: repositório e mensagem do domínio.
    for (const e of EMPRESAS.filter(x => x.renovacao)) {
        const empresaId = ids[e.chave].empresa;
        const repo = s.renovacaoRepo.repositorioRenovacao(withTransaction);
        const contexto = await repo.ler(empresaId);
        assert.ok(contexto && !contexto.registro && contexto.destinatarioValido, 'RENOVACAO_SEM_CONTEXTO');
        const id = randomUUID(), data = s.renovacao.primeiraRenovacaoRegular(hoje, contexto.beneficioFim, contexto.ciclo);
        await repo.criar({id, empresaId, contratacaoId:contexto.contratacaoId, destinatarioId:contexto.destinatarioId, primeiroVencimento:hoje,
            primeiraDataRegular:data, mensagem:s.renovacao.mensagemRenovacao(contexto, id, data, ORIGEM_APP), estado:'PENDENTE',
            avisoTentadoEm:null, avisoEnviadoEm:null, precoAplicadoEm:null, ultimoErro:null});
    }

    // ---- Conferência pelos mesmos serviços que o servidor usa (o navegador repete a matriz pela interface).
    const conferencia = {};
    const essencialVagas = await withTransaction(tx => s.limites.consultarVagas(tx, ids.essencial.empresa));
    assert.deepEqual([essencialVagas?.limite, essencialVagas?.ocupadas, essencialVagas?.disponiveis], [3, 3, 0], 'ESSENCIAL_3_DE_3');
    conferencia.essencialVagas = '3/3';
    conferencia.financeiroCompleto = {};
    for (const e of EMPRESAS) {
        const incluido = await withTransaction(tx => s.recursos.recursoIncluido(tx, ids[e.chave].empresa, 'FINANCEIRO_COMPLETO'));
        assert.equal(incluido, e.chave !== 'essencial', 'FINANCEIRO_' + e.chave);
        conferencia.financeiroCompleto[e.chave] = incluido;
    }
    conferencia.acesso = {};
    for (const e of EMPRESAS) {
        const {acesso} = await withTransaction(tx => s.estado.lerEstadoComercial(tx, ids[e.chave].empresa));
        assert.equal(acesso.nivel, e.tipo === 'TESTE_EXPIRADO' ? 'BLOQUEADO' : 'COMPLETO', 'ACESSO_' + e.chave);
        conferencia.acesso[e.chave] = acesso.nivel;
    }
    const envCotacao = {COTACAO_PUBLICA_POR_EMPRESA:'true'};
    conferencia.cotacao = {};
    for (const e of EMPRESAS.filter(x => x.catalogo)) {
        let status = 200;
        try { await s.cotacao.escopoCotacaoPublica(() => ex, e.codigo, {}, envCotacao); } catch (erro) { status = erro?.httpStatus ?? 'ERRO'; }
        assert.equal(status, e.plano === 'essencial' ? 404 : 200, 'COTACAO_' + e.chave);
        conferencia.cotacao[e.codigo] = status;
    }
    const ofertas = await withTransaction(tx => s.ofertas.consultarOfertas(tx, ids.teste.empresa, {ASSINATURA_PLANOS_ATIVOS:'true', ASAAS_AMBIENTE:'sandbox'}));
    assert.ok(ofertas?.habilitado && ofertas.fundador && !ofertas.aguardandoVaga, 'OFERTA_FUNDADOR_TESTE');
    conferencia.ofertaTeste = {habilitado:true, fundador:true, essencialMensalCentavos:ofertas.planos.find(x => x.id === 'essencial')?.mensal};
    const renovacao = await withTransaction(tx => s.renovacaoRepo.consultarRenovacao(tx, ids.premium.empresa));
    assert.equal(renovacao?.estado, 'PENDENTE', 'RENOVACAO_PREMIUM');
    conferencia.renovacaoPremium = {estado:renovacao.estado, dataRegular:renovacao.dataRegular, valorRegularCentavos:renovacao.valorRegular};
    const campanha = (await q("SELECT count(*) FILTER (WHERE estado='CONFIRMADA')::int AS confirmadas FROM assinatura_fundadores"))[0];
    conferencia.fundadorConfirmadas = campanha.confirmadas;
    return conferencia;
}

async function executar(env) {
    const a = alvo(env);
    semConexaoHerdada(env, a);
    semPrazoComercialHerdado(env);
    if (path.resolve(process.cwd()).toLowerCase() !== raiz.toLowerCase()) throw recusa('EXECUTAR_NA_RAIZ_DO_REPOSITORIO');
    let gitignore = '';
    try { gitignore = fs.readFileSync(path.join(raiz, '.gitignore'), 'utf8'); } catch { /* ausente: recusa abaixo */ }
    if (!conferirGitignore(gitignore).ignorada) throw recusa('PASTA_LOCAL_NAO_IGNORADA');
    if (fs.existsSync(ARQUIVO_CREDENCIAIS)) throw recusa('CREDENCIAIS_EXISTENTES', 'apague o arquivo da rodada anterior');
    const p = await plano();
    if (p.impressao !== IMPRESSAO_SCHEMA) throw recusa('SCHEMA_DIVERGENTE_DO_PACOTE');
    global.fetch = async () => { throw Error('REDE_PROIBIDA'); };
    process.env.EMAIL_PROVIDER = 'desativado'; // só neste processo; nada aqui envia e-mail
    const senhas = new Map(CONTAS.map(conta => [conta.rotulo, gerarSenha()]));
    const resumo = {resultado:'INCOMPLETO', alvo:{host:a.host, porta:a.porta, banco:a.banco}, schema:{migrations:p.migrations, arquivos:p.arquivos, ultima:p.ultima, impressao:p.impressao},
        empresas:EMPRESAS.map(e => `${e.codigo}:${e.tipo}${e.plano ? ':' + e.plano : ''}`), contas:CONTAS.length, credenciais:path.relative(raiz, ARQUIVO_CREDENCIAIS), falha:null};
    let etapa = 'schema', c = null;
    try {
        await construirSchema(a, p);
        etapa = 'fixtures';
        c = await conectar(a, a.banco, [a.banco]);
        resumo.conferencia = await popular(c, senhas);
        etapa = 'credenciais';
        escreverCredenciais(ARQUIVO_CREDENCIAIS, montarCredenciais(a, senhas));
        resumo.resultado = 'PASS';
    } catch (e) {
        resumo.falha = {etapa, codigo:sanitizar(e?.code ?? e?.codigo ?? e?.name), mensagem:sanitizar(e?.message)};
    } finally {
        if (c) await c.end().catch(() => {});
        senhas.clear();
    }
    resumo.observacao = resumo.resultado === 'PASS'
        ? 'Senhas só no arquivo de credenciais (ignorado pelo Git). Banco preservado até a remoção do cluster.'
        : 'Falhou: banco parcial. Pare e remova o cluster pela ferramenta de ciclo de vida e recomece; nenhuma credencial válida foi gravada.';
    console.log(JSON.stringify(resumo, null, 2));
    if (resumo.resultado !== 'PASS') process.exitCode = 2;
}

async function principal(argv, env) {
    const m = modo(argv);
    if (m === null) { console.error('USO: sem argumento/--plano (offline) ou ' + FLAG + ' com ' + VAR_AUTORIZACAO + ' (exige aprovação)'); process.exitCode = 1; return; }
    if (m === 'PLANO') {
        const p = await plano();
        console.log(JSON.stringify({modo:'PLANO_OFFLINE', conexao:false, alvoEsperado:`127.0.0.1:${PORTA}/${BANCO_SUGERIDO}`, papel:PAPEL,
            migrations:p.migrations, arquivos:p.arquivos, ultima:p.ultima, impressao:p.impressao, impressaoAprovada:IMPRESSAO_SCHEMA,
            confere:p.impressao === IMPRESSAO_SCHEMA, empresas:EMPRESAS.map(e => ({codigo:e.codigo, tipo:e.tipo, plano:e.plano, catalogo:e.catalogo, renovacao:e.renovacao})),
            contas:CONTAS.map(c => ({rotulo:c.rotulo, papel:c.papel, empresas:c.empresas})), credenciais:path.relative(raiz, ARQUIVO_CREDENCIAIS)}, null, 2));
        return;
    }
    await executar(env);
}

if (require.main === module)
    principal(process.argv.slice(2), process.env).catch(e => {
        console.error('SEED_NAVEGADOR_RECUSADO ' + sanitizar(e?.message ?? e?.codigo)); process.exitCode = 1;
    });
module.exports = {FLAG, FLAG_PLANO, VAR_AUTORIZACAO, PAPEL, PORTA, PORTA_APP, ORIGEM_APP, PASTA_LOCAL, BANCO_SUGERIDO, NOMES_PROIBIDOS, IMPRESSAO_SCHEMA,
    EMPRESAS, CONTAS, EMAIL_CONVITE_ESSENCIAL, ARQUIVO_CREDENCIAIS, modo, validarBanco, alvo, semConexaoHerdada, semPrazoComercialHerdado,
    conferirIdentidade, conferirGitignore, sanitizar, gerarSenha, documentoSintetico, montarCredenciais, escreverCredenciais, plano, SQL_IDENTIDADE};
