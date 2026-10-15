import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { carregarModulo } from '../../acessos/teste-carregador.ts';
import { cssFalso } from '../../../components/admin/teste-componente.ts';
import { ESTILOS_SITE, conteudoVazio, esquemaConteudoSite, estiloDoConteudo, formaParaImpressao, imagensReferenciadas, type ConteudoPublicado } from './conteudo.ts';
import { ESTILOS, PALETAS, avisosDeCores, contraste, paletaDasCores, temaDoSite } from './tema.ts';

/**
 * UX do site (15/10/2026): estilo/tema por unidade, compatibilidade com conteúdo antigo, foto vinculada a pacote e
 * legibilidade calculada. Comportamento, não marcação.
 */
const IMG = '11111111-1111-4111-8111-111111111111';
const IMG2 = '22222222-2222-4222-8222-222222222222';

/** Rascunho como era gravado ANTES desta evolução (sem `aparencia`, pacotes sem `imagemId`). */
const ANTIGO = {
  identidade: { nome: 'Buffet Alegria', slogan: '', corPrimaria: '#6d4aff', corSecundaria: '#14b8a6', logoImagemId: null },
  apresentacao: { titulo: 'Bem-vindo', texto: 'Texto.' }, galeria: [{ imagemId: IMG, legenda: 'Salão' }],
  estrutura: { capacidade: '', itens: [] }, pacotes: [{ codigo: 'COMPLETA', destaque: '', mostrarPreco: false }],
  localizacao: { mostrar: false, endereco: '', bairro: '', cidade: '', uf: '', cep: '', referencia: '', linkMapa: '' },
  contato: { telefone: '', whatsapp: '', email: '', instagram: '', botaoWhatsapp: true }, formulario: { ativo: true, mostrarDatasLivres: false },
  seo: { titulo: 'Buffet', descricao: 'Desc', indexavel: true },
};

test('compatibilidade: rascunho antigo valida, ganha os padrões e mantém a impressão (sem “alterações não publicadas” falsas)', () => {
  const novo = esquemaConteudoSite.parse(ANTIGO);
  assert.equal(novo.aparencia.estilo, 'INFANTIL_ACOLHEDOR');
  assert.equal(novo.pacotes[0].imagemId, null);
  assert.equal(JSON.stringify(formaParaImpressao(novo)), JSON.stringify(ANTIGO), 'mesma forma (e ordem) do conteúdo antigo → mesma impressão');
  const outroEstilo = esquemaConteudoSite.parse({ ...ANTIGO, aparencia: { estilo: 'CELEBRACOES_ELEGANTE' } });
  assert.notEqual(JSON.stringify(formaParaImpressao(outroEstilo)), JSON.stringify(ANTIGO), 'escolha nova muda a impressão');
  const comFoto = esquemaConteudoSite.parse({ ...ANTIGO, pacotes: [{ codigo: 'COMPLETA', destaque: '', mostrarPreco: false, imagemId: IMG2 }] });
  assert.notEqual(JSON.stringify(formaParaImpressao(comFoto)), JSON.stringify(ANTIGO));
  assert.equal(esquemaConteudoSite.safeParse({ ...ANTIGO, aparencia: { estilo: 'NEON' } }).success, false, 'estilo fora da lista recusado');
  assert.equal(esquemaConteudoSite.safeParse({ ...ANTIGO, aparencia: { estilo: 'INFANTIL_ACOLHEDOR', css: 'x' } }).success, false, 'campo desconhecido recusado');
  assert.equal(esquemaConteudoSite.safeParse({ ...ANTIGO, pacotes: [{ codigo: 'COMPLETA', imagemId: 'nao-uuid' }] }).success, false);
});

test('versão publicada antiga (sem aparencia/imagemId) renderiza no estilo padrão; estilo inválido cai no padrão', () => {
  assert.equal(estiloDoConteudo({}), 'INFANTIL_ACOLHEDOR');
  assert.equal(estiloDoConteudo({ aparencia: { estilo: 'X' } }), 'INFANTIL_ACOLHEDOR');
  assert.equal(estiloDoConteudo({ aparencia: { estilo: 'SOCIAL_CONTEMPORANEO' } }), 'SOCIAL_CONTEMPORANEO');
  assert.deepEqual(imagensReferenciadas({ identidade: { logoImagemId: null }, galeria: [{ imagemId: IMG }], pacotes: [{ codigo: 'X' } as never] }), [IMG]);
  assert.deepEqual(imagensReferenciadas({ identidade: { logoImagemId: null }, galeria: [], pacotes: [{ imagemId: IMG2 }] }), [IMG2], 'foto vinculada ao pacote é referenciada');
});

test('legibilidade: texto dos botões e cor de destaque atingem 4,5:1 em todas as paletas e estilos; cor clara é corrigida e avisada', () => {
  for (const estilo of ESTILOS_SITE) {
    for (const p of PALETAS) {
      const v = temaDoSite({ aparencia: { estilo }, identidade: { corPrimaria: p.primaria, corSecundaria: p.secundaria } }).variaveis;
      assert.ok(contraste(v['--sobre-primaria'], p.primaria) >= 4.5, `${p.id}/${estilo}: texto do botão`);
      assert.ok(contraste(v['--primaria-texto'], ESTILOS[estilo].neutros.fundo) >= 4.5, `${p.id}/${estilo}: destaque como texto`);
      assert.ok(contraste(v['--foco'], ESTILOS[estilo].neutros.fundo) >= 3, `${p.id}/${estilo}: foco visível`);
      assert.deepEqual(avisosDeCores(p.primaria, p.secundaria, estilo), [], `${p.id}/${estilo}: paleta pronta sem avisos`);
    }
    assert.ok(contraste(ESTILOS[estilo].neutros.texto, ESTILOS[estilo].neutros.fundo) >= 7, `${estilo}: texto principal`);
    assert.ok(contraste(ESTILOS[estilo].neutros.textoSuave, ESTILOS[estilo].neutros.fundo) >= 4.5, `${estilo}: texto suave`);
  }
  const amarelo = temaDoSite({ identidade: { corPrimaria: '#ffe066', corSecundaria: '#14b8a6' } }).variaveis;
  assert.equal(amarelo['--sobre-primaria'], '#14121a', 'botão amarelo recebe texto escuro');
  assert.ok(contraste(amarelo['--primaria-texto'], ESTILOS.INFANTIL_ACOLHEDOR.neutros.fundo) >= 4.5, 'amarelo como texto é escurecido');
  assert.match(avisosDeCores('#ffe066', '#14b8a6', 'INFANTIL_ACOLHEDOR').join(' '), /clara demais/);
  assert.match(avisosDeCores('#7a7a7a', '#14b8a6', 'SOCIAL_CONTEMPORANEO').join(' '), /botões fica difícil/);
  assert.match(avisosDeCores('#6d4aff', '#6d4aff', 'SOCIAL_CONTEMPORANEO').join(' '), /quase iguais/);
  assert.equal(paletaDasCores('#6D4AFF', '#14B8A6')?.id, 'VIOLETA_TURQUESA');
  assert.equal(paletaDasCores('#6d4aff', '#000000'), null, 'personalizada');
});

test('renderizador: estilo da unidade e cores chegam à página; foto de pacote só quando vinculada; sem foto = abertura com cores', () => {
  const Pagina = (carregarModulo('components/marketing/site/SitePublicoPagina.tsx', { 'site-publico.module.css': cssFalso }) as unknown as { default: (p: unknown) => unknown }).default;
  const base = esquemaConteudoSite.parse({ ...conteudoVazio('Buffet Alegria'), aparencia: { estilo: 'CELEBRACOES_ELEGANTE' },
    identidade: { ...conteudoVazio('Buffet Alegria').identidade, corPrimaria: '#7b1e3a' }, apresentacao: { titulo: 'Bem-vindo', texto: 'Texto' }, formulario: { ativo: true } });
  const publicado = (extra: Partial<ConteudoPublicado>): ConteudoPublicado => ({ ...base, pacotes: [], versao: 1, publicadoEm: '', rascunhoHash: '', ...extra });
  const render = (c: ConteudoPublicado) => renderToStaticMarkup(createElement(Pagina as never, { conteudo: c, urlImagem: (id: string) => `/img/${id}`, base: '', acaoFormulario: '#', captura: {}, datasLivres: null }));
  const pacote = { codigo: 'COMPLETA', nome: 'Completa', descricao: null, destaque: '', convidadosMinimos: 50, convidadosMaximos: 100, duracaoMinutos: 240, precoAPartirCentavos: null };
  const semFoto = render(publicado({ pacotes: [pacote] }));
  assert.match(semFoto, /data-estilo="CELEBRACOES_ELEGANTE"/);
  assert.match(semFoto, /--cor-primaria:#7b1e3a/);
  assert.match(semFoto, /data-capa="nao"/, 'sem foto: abertura composta com as cores');
  assert.doesNotMatch(semFoto, /\/img\//, 'nenhuma foto inventada para pacote ou abertura');
  const comFoto = render(publicado({ galeria: [{ imagemId: IMG, legenda: 'Salão' }], pacotes: [{ ...pacote, imagemId: IMG2 }] }));
  assert.match(comFoto, /data-capa="sim"/);
  assert.match(comFoto, new RegExp(`/img/${IMG2}`), 'foto vinculada ao pacote aparece');
  const antigo = render({ ...publicado({ pacotes: [pacote] }), aparencia: undefined } as unknown as ConteudoPublicado);
  assert.match(antigo, /data-estilo="INFANTIL_ACOLHEDOR"/, 'versão publicada antiga usa o padrão');
});
