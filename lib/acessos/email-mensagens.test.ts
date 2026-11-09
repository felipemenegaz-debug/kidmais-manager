import assert from 'node:assert/strict';
import test from 'node:test';
import { mensagemConvite, mensagemRecuperacao } from './email.ts';

/**
 * Texto dos e-mails de acesso com o nome do produto (iA.Fest). O remetente vem só de EMAIL_REMETENTE; aqui se confere
 * que assunto, texto e HTML não falam mais em "Kidmais", nem em "equipe Kidmais".
 */
const LINK = 'https://exemplo.test/acesso/convite?token=abc';

function semKidmais(m: { assunto: string; texto: string; html: string }) {
    for (const [parte, valor] of Object.entries({ assunto: m.assunto, texto: m.texto, html: m.html })) {
        assert.doesNotMatch(valor, /kidmais/i, `${parte} sem Kidmais`);
    }
}

test('convite: assunto e corpo com iA.Fest, a empresa convidante e o papel', () => {
    const m = mensagemConvite({ para: 'pessoa@exemplo.test', empresa: 'Buffet Alegria', papel: 'Gerente', link: LINK, validadeDias: 7 });
    assert.equal(m.para, 'pessoa@exemplo.test');
    assert.equal(m.assunto, 'Convite para acessar Buffet Alegria no iA.Fest');
    assert.match(m.texto, /^Você foi convidado para acessar Buffet Alegria no iA\.Fest como Gerente\.$/m);
    assert.match(m.html, /no iA\.Fest como Gerente\./);
    assert.match(m.texto, /O convite vale por 7 dias/);
    semKidmais(m);
});

test('redefinição de senha: assunto e corpo com iA.Fest e "equipe iA.Fest"', () => {
    const m = mensagemRecuperacao({ para: 'pessoa@exemplo.test', link: LINK, validadeMinutos: 30 });
    assert.equal(m.assunto, 'Redefinição de senha do iA.Fest');
    assert.match(m.texto, /^Recebemos um pedido para redefinir a senha da sua conta no iA\.Fest\.$/m);
    assert.match(m.texto, /Ninguém da equipe iA\.Fest vê ou escolhe a sua senha\./);
    assert.match(m.html, /Ninguém da equipe iA\.Fest vê ou escolhe a sua senha\./);
    assert.match(m.texto, /O link vale por 30 minutos/);
    semKidmais(m);
});

test('empresa com "Kidmais" no nome continua aparecendo: só o nome do produto mudou', () => {
    const m = mensagemConvite({ para: 'pessoa@exemplo.test', empresa: 'Kidmais Festas', papel: 'Atendente', link: LINK, validadeDias: 7 });
    assert.equal(m.assunto, 'Convite para acessar Kidmais Festas no iA.Fest');
    assert.match(m.texto, /^Você foi convidado para acessar Kidmais Festas no iA\.Fest como Atendente\.$/m);
    assert.match(m.html, /acessar Kidmais Festas no iA\.Fest como Atendente\./);
    for (const valor of [m.assunto, m.texto, m.html]) assert.doesNotMatch(valor, /Kidmais Manager|equipe Kidmais/);
});
