/* eslint-disable @typescript-eslint/no-require-imports */
// Não carrega .env.local nem usa DATABASE_URL como fallback.
const { Client } = require('pg');
const { randomUUID } = require('node:crypto');
const readline = require('node:readline/promises');
function segredo(prompt) {
    if (!process.stdin.isTTY)
        throw Error('Use um terminal local interativo.');
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    return new Promise((resolve, reject) => {
        let value = '';
        const cleanup = () => { process.stdin.off('data', receive); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); };
        const receive = chunk => {
            for (const char of chunk.toString('utf8')) {
                if (char === '\u0003') {
                    cleanup();
                    reject(Error('Operação cancelada.'));
                    return;
                }
                if (char === '\r' || char === '\n') {
                    cleanup();
                    resolve(value);
                    return;
                }
                if (char === '\u007f' || char === '\b')
                    value = [...value].slice(0, -1).join('');
                else if (char >= ' ')
                    value += char;
            }
        };
        process.stdin.on('data', receive);
    });
}
async function provisionar(client, input) {
    const { criarHashSenha } = await import('../lib/autenticacao/senha.ts');
    const hash = input.senha ? await criarHashSenha(input.senha) : null;
    await client.query('BEGIN');
    try {
        await client.query('LOCK TABLE usuarios_administrativos IN EXCLUSIVE MODE');
        const count = (await client.query('SELECT count(*)::int AS n FROM usuarios_administrativos')).rows[0].n;
        if (input.acao === 'bootstrap' && count !== 0)
            throw Error('Bootstrap recusado: já existe usuário administrativo.');
        if (!['ADMINISTRATIVO', 'REPRESENTANTE_AUTORIZADO'].includes(input.papel))
            throw Error('Papel inválido.');
        const email = input.email.trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
            throw Error('Email inválido.');
        let user;
        if (['bootstrap', 'criar'].includes(input.acao)) {
            if (!hash || !input.nome?.trim())
                throw Error('Nome e senha obrigatórios.');
            user = (await client.query('INSERT INTO usuarios_administrativos(email,nome,cargo,senha_hash,papel) VALUES($1,$2,$3,$4,$5) RETURNING id,email,nome,papel,ativo', [email, input.nome.trim(), input.cargo?.trim() || null, hash, input.acao === 'bootstrap' ? 'REPRESENTANTE_AUTORIZADO' : input.papel])).rows[0];
        }
        else {
            const old = (await client.query('SELECT id FROM usuarios_administrativos WHERE email=$1 FOR UPDATE', [email])).rows[0];
            if (!old)
                throw Error('Usuário não encontrado.');
            user = (await client.query(`UPDATE usuarios_administrativos SET papel=$2,ativo=$3,
    senha_hash=COALESCE($4,senha_hash),senha_alterada_em=CASE WHEN $4::text IS NOT NULL THEN clock_timestamp() ELSE senha_alterada_em END
    WHERE id=$1 RETURNING id,email,nome,papel,ativo`, [old.id, input.papel, input.ativo, hash])).rows[0];
            await client.query('UPDATE sessoes_administrativas SET revogado_em=clock_timestamp() WHERE usuario_id=$1 AND revogado_em IS NULL', [old.id]);
        }
        await client.query(`INSERT INTO auditoria(ator_tipo,acao,entidade_tipo,entidade_id,dados_depois,origem,request_id)
   VALUES('SISTEMA',$1,'USUARIO_ADMINISTRATIVO',$2,$3,'CLI_PROVISIONAMENTO',$4)`, ['ADMIN_' + input.acao.toUpperCase(), user.id, user, randomUUID()]);
        await client.query('COMMIT');
        return user;
    }
    catch (e) {
        await client.query('ROLLBACK');
        throw e;
    }
}
async function main() {
    const action = process.argv[2];
    if (!['bootstrap', 'criar', 'atualizar'].includes(action))
        throw Error('Uso: node scripts/admin-provision.cjs bootstrap|criar|atualizar');
    const connection = process.env.KIDMAIS_PROVISION_DATABASE_URL || await segredo('Conexão PostgreSQL de provisionamento (oculta): ');
    const c = new Client({ connectionString: connection });
    await c.connect();
    try {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const email = await rl.question('Email: '), nome = action === 'atualizar' ? '' : await rl.question('Nome: '), cargo = action === 'atualizar' ? '' : await rl.question('Cargo (opcional): ');
        const papel = action === 'bootstrap' ? 'REPRESENTANTE_AUTORIZADO' : await rl.question('Papel (ADMINISTRATIVO ou REPRESENTANTE_AUTORIZADO): ');
        const ativo = action === 'atualizar' ? (await rl.question('Manter ativo? (sim/não): ')).toLowerCase() === 'sim' : true;
        const changePassword = action !== 'atualizar' || (await rl.question('Redefinir senha? (sim/não): ')).toLowerCase() === 'sim';
        rl.close();
        let senha = null;
        if (changePassword) {
            senha = await segredo('Senha (oculta): ');
            if (senha !== await segredo('Confirme a senha (oculta): '))
                throw Error('Senhas não conferem.');
        }
        const confirm = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await confirm.question(`Confirmar ${action} de ${email}, papel ${papel}? Digite CONFIRMAR: `);
        confirm.close();
        if (answer !== 'CONFIRMAR')
            throw Error('Operação cancelada.');
        const user = await provisionar(c, { acao: action, email, nome, cargo, papel, ativo, senha });
        console.log(JSON.stringify({ id: user.id, email: user.email, papel: user.papel, ativo: user.ativo }));
    }
    finally {
        await c.end();
    }
}
module.exports = { provisionar };
if (require.main === module)
    main().catch(() => { console.error('Provisionamento não concluído. Confira conexão, permissões, dados e existência prévia de usuário. Nenhuma credencial foi registrada.'); process.exitCode = 1; });
