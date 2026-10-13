# Fechamento local da venda — Codex, 11/10/2026

Base: `fa591aa0b61be69998f89e94194038dc2acd6f97`, candidata integrada de Claude. Checkout de trabalho: `.claude/worktrees/kidmais-manager-sales-site-9b9a2d`. O checkout principal e suas pastas anteriores foram preservados.

## PostgreSQL

Cluster novo `.local-descartavel-pg-42c5a4ae5e224d1aa7ed93ab68947828`, PostgreSQL 18, identidade `kidmais_descartavel`, somente `127.0.0.1:55498`. Banco real local e bancos remotos não usados.

14 suítes finais executadas. A primeira rodada passou em 12 e falhou em duas fixtures: conta sintética repetida no caso E2 e comparação de preço numérico com texto decimal. Corrigidos exclusivamente os testes. As duas suítes foram restauradas do zero e repetidas: cadastro 14/14, fixture 5/5. Resultado agregado: **14 suítes aprovadas, 100 testes**. Cobertura inclui gratuidade da Kidmais, assinatura, cobrança, contratação, cadastro, recuperação de convites, catálogo e disponibilidade. Não foi uma única rodada 14/14 após as correções.

Logs privados preservados no cluster: `lancamento-final.log` e `lancamento-correcao.log`. Cluster encerrado em `finally`.

## Concorrência

Cluster novo `.local-concorrencia-pg-8467f6efcf1c463885c39808fd4c0fd8`, identidade `kidmais_concorrencia`, `127.0.0.1:55480`. Grupos a–h e z: **9/9 PASS**. Zero duplicidades; 20 vagas ocupadas no máximo, zero incoerências. Provedor falso, nenhum pagamento. Cluster parado e resultado preservado.

Os executores de concorrência e seed de navegador ainda fixavam o inventário 078. Atualizados para 079, sem enfraquecer as travas: 81 migrations, 207 arquivos, SHA-256 normalizado `5528ce9b70d9599e7bdcc7bfb4fe98dac95acdc2e81ba4e55a2cb520e1662ade`. Testes dos dois executores: 26/26.

## Navegador

Vitrine em `next start`, build de produção, `127.0.0.1:3491`: `/conheca`, `/planos`, `/cadastro`, desktop 1280 e celular 375×812: **6/6 PASS**, sem rolagem horizontal. Preços 197/347/597 e selos Em breve; âncora de recursos indisponíveis ausente. Somente GET, sem banco ou envio. Recursos externos recusados no navegador. Configuração de e-mail era sintética, sem chave válida.

Cadastro em `next dev`, e-mail em arquivo e schema 079 no descartável: **8 grupos PASS**. Conta somente após confirmação; empresa em TESTE e Gestão; CNPJ existente neutro; conta sem empresa pode retomar; resposta perdida não duplica empresa; repetição de e-mail neutra; celular sem rolagem. Assinatura real consultada no banco sintético: três planos, seleção do Profissional anual Fundador por 208200 centavos, checkout interceptado no navegador, pagamento pendente e assinatura preservada. Tela conferida em 1280 e 375 px. Não houve chamada ao Asaas, Resend, CEP ou OTP.

As primeiras tentativas do teste de interface pararam por seletores antigos de botão/ciclo; cada tentativa encerrou servidor/banco. Ajustados os seletores, a rodada completa passou. Pastas de cada tentativa mantidas, sem apagar e-mails anteriores.

**Limites:** cadastro/assinatura foram executados em desenvolvimento porque o provedor de e-mail em arquivo é local; não equivalem a confirmação de e-mail real ou pagamento em staging. Não houve nova simulação visual de escrita bloqueada após expiração; esse comportamento está coberto pelas suítes PostgreSQL. A vitrine mostrou configuração de homologação com campos ainda não definidos, não um rodapé comercial definitivo.

## Validação final da candidata

`npm run check:v1:static`: **2285/2285** unitários, **103/103** harness offline, ESLint sem erros (um aviso já existente), TypeScript e build de produção com 61 páginas aprovados; worker PDF aprovado. Primeira invocação recusada por `ENAMETOOLONG` no Windows; runner ajustado para caminhos relativos à raiz, sem excluir testes, e invocação completa passou. Scripts afetados: 41/41; após tornar P0 autossuficiente, seu teste adicional passou, total 6/6 nessa suíte. Essa última mudança só afeta ferramenta operacional CJS e foi validada por testes/lint, sem repetir build da aplicação.

Diagnóstico P0 preparado para funcionar **antes** de publicar: não importa mais o reconciliador novo, que não existe na versão live. Teste exige SQL idêntico à conferência diária. Comando de cópia temporária, conferência SHA-256 e execução preparado em `diagnostico-production-comando-codex-20261011.txt`, hash `6606c08e58d01c633e6b55d65683156585f069f2d4c5d96ccfee80f2b7d5615a`. Posteriormente executado uma vez sob autorização específica de Felipe: [resultado P0](diagnostico-production-codex-20261011.md).

## Leitura remota — resultado

Workspace confirmado por Felipe: `tea-daidbj95efls73d2bcf0` (My Workspace). Render e `git ls-remote` concordam:

- staging `srv-daif418ae00c73e8k2gg`: branch staging, auto-deploy OFF, LIVE `b95494ff5a36fd88dc794010bbc43d3a80f924d2`;
- produção `srv-dak77m2d0e5s73b8rkkg`: branch production, auto-deploy OFF, LIVE `4af8b38e52c8b8c5724ade980d900face0c73562`.

Essa leitura inicial foi somente de metadados. Posteriormente, push fast-forward `b95494f..d5d930f` para staging; um trabalho paralelo acrescentou `5386a4d`, preservou a candidata e iniciou deploy `dep-db5kk17avr4c73950kq0`. Deploy LIVE; health, `/conheca` e `/planos` 200. Codex não iniciou deploy duplicado. Produção recebeu somente a leitura P0 autorizada; nenhuma variável, migration ou cobrança foi alterada.

## Dados comerciais

Atualização da escolha fiscal: Felipe optou por emitir NFS-e pelo Asaas; a configuração fiscal e a emissão continuam sem verificação. [Documentação oficial](https://docs.asaas.com/docs/notas-fiscais-2). O painel autenticado do Resend mostra `notificacoes.kidmaisfestas.com` Verified. Remetente preparado, não aplicado: `Kidmais Manager <nao-responda@notificacoes.kidmaisfestas.com>`, conforme a exigência de domínio próprio verificado do [Resend](https://resend.com/docs/dashboard/domains/introduction). O contato de suporte e privacidade em Gmail permanece aprovado.

Vendedor informado: Kidmais Festas, CNPJ 20.119.900/0001-60, SCRN 704/705 bloco D loja 12, Asa Norte, Brasília - DF, CEP 70730-640. Felipe aprovou preparar suporte/privacidade em `felipemenegaz@gmail.com`, vitrine em `https://manager.kidmaisfestas.com/conheca`, regularização de 7 dias e somente leitura por 60 dias. Valores preparados em `docs/CONFIGURACAO_VENDA_APROVADA_20261011.json`, não aplicados no Render. Retenção, nota fiscal, aplicação/teste do remetente e documentos legais finais permanecem pendentes.
