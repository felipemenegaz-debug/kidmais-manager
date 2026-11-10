import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Telas e e-mails da equipe de qualquer empresa falam do produto (iA.Fest), nunca da Kidmais. As telas do cliente
 * usam o nome do buffet; a marca da Kidmais só onde o caminho já é da própria Kidmais (`marca.kidmais`, /fechamento).
 */
const ler = (caminho: string) => readFileSync(new URL(`../../${caminho}`, import.meta.url), "utf8");
const semComentarios = (texto: string) => texto.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

const SEM_MARCA = [
  "app/admin/login/page.tsx", "app/acesso/convite/page.tsx", "app/acesso/recuperar/page.tsx", "app/acesso/redefinir/page.tsx", "app/not-found.tsx",
  "app/cadastro/page.tsx", "app/cadastro/confirmar/page.tsx", "app/cadastro/empresa/page.tsx", "app/admin/ajuda/page.tsx", "app/admin/ajuda/[artigo]/page.tsx",
  "components/admin/Assinatura.tsx", "components/admin/AssinaturaAcoes.tsx", "components/admin/AvisoComercial.tsx", "components/admin/importacao/ImportacaoReal.tsx",
  "components/festas/FestaAcessos.tsx", "components/marketing/site/SitePublicoPagina.tsx", "components/clientes/ClienteForm.tsx", "components/clientes/ClienteProfile.tsx",
  "lib/assinatura/avisos-mensagens.ts", "lib/assinatura/arrependimento.ts", "lib/assinatura/devolucao-registro.ts", "lib/cadastro/publico.ts", "lib/suporte/codigo.ts",
];

// lib/acessos/email.ts fica fora por ora (decisão de Felipe, 08/11/2026): o executor da prova de e-mail em produção (V6)
// fixa o hash desse arquivo. A troca para iA.Fest nos e-mails de convite e redefinição entra depois, com a revalidação do V6.
for (const arquivo of SEM_MARCA) {
  test(`sem Kidmais nos textos: ${arquivo}`, () => assert.doesNotMatch(semComentarios(ler(arquivo)), /Kidmais Manager|KidmaisBrand|(?:equipe|pela|com a|da) Kidmais/));
}

test("login mostra o produto", () => assert.match(ler("app/admin/login/page.tsx"), /<h1>iA\.Fest<\/h1>/));

test("aba da equipe usa título e ícone do produto", () => {
  for (const layout of ["app/admin/layout.tsx", "app/clientes/layout.tsx"]) {
    assert.match(ler(layout), /title: 'iA\.Fest'/);
    assert.match(ler(layout), /\/assets\/iafest\/simbolo-painel\.png/);
  }
});

test("wizard: origem interna só diz Kidmais na própria Kidmais; contatos fixos continuam atrás da condição", () => {
  const wizard = ler("components/fechamento/FechamentoWizard.tsx");
  assert.match(wizard, /marca\.kidmais \? "Atendimento Kidmais" : "Atendimento do buffet"/);
  assert.match(wizard, /\{!empresa && <footer className=\{styles\.pageFooter\}>/);
  assert.match(wizard, /\{!empresa && <a href=\{CONTATO_KIDMAIS\.whatsappUrl\}/);
});

test("preço sob consulta: a Kidmais só nas regras da própria Kidmais", () => {
  assert.match(ler("lib/comercial/services/pricing.service.ts"), /empresaEhKidmais\(pacote\.empresaId, customDb\) \? "da Kidmais" : "do buffet"/);
});

test("atendimento novo não vem com o nome da Kidmais", () => {
  assert.match(ler("components/admin/atendimento/ConfiguracaoAtendimento.tsx"), /ativo: false, nome: '', perguntas/);
});

test("consentimento dos Convites: o produto, em nova versão de texto", () => {
  const textos = ler("lib/convites/consentimento-textos.ts");
  assert.match(textos, /VERSAO_TEXTOS_IA = 'convites-ia-20261107\.1'/);
  assert.match(textos, /armazenada no iA\.Fest/);
  assert.doesNotMatch(textos, /armazenada no Kidmais/);
});

test("convite: rodapé e ícone da Kidmais só com a prova da empresa do convite autorizado", () => {
  const tela = ler("components/convites/ConvitePublico.tsx");
  assert.match(tela, /marcaKidmais \? 'Um momento especial, organizado com KidMais\.' : 'Um momento especial\.'/);
  assert.match(tela, /useState\(false\)/);
  const servico = ler("lib/convites/service.ts");
  assert.match(servico, /marcaKidmais: c\.empresa_codigo === 'kidmais'/);
  assert.match(ler("app/convite/[token]/page.tsx"), /\.marcaKidmais\) return base;[^\n]*\n\s*return \{ \.\.\.base, icons: ICONE_NEUTRO \}/);
  const criar = ler("app/convites/criar/page.tsx");
  assert.doesNotMatch(criar, /kidmais/i);
  assert.match(criar, /icone-orcamento\.svg/);
});

test("plano financeiro não atribui as obrigações à Kidmais", () => {
  assert.doesNotMatch(ler("components/admin/CriarPlanoFinanceiro.tsx"), /kidmais/i);
});
