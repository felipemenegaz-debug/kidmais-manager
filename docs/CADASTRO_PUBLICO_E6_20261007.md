# E6/E7 — Cadastro público, verificação de e-mail, identificação da empresa e início guiado (07/10/2026)

Empilhada sobre o painel comercial (E5). Migration nova: **069** (NÃO APLICADA). Depende de 063, 067 e 068.

## Fluxo

1. **Planos** (`/planos`, pública): um plano por empresa, duração do teste vinda de `ASSINATURA_TESTE_DIAS` (padrão 15) e
   preços de `ASSINATURA_PRECO_{MENSAL,ANUAL}_CENTAVOS` — sem preço configurado mostra **"Preço a definir"**.
2. **Pessoa** (`/cadastro` → `POST /api/cadastro`): nome, e-mail, senha e aceite da versão vigente dos **termos** e do
   **aviso de privacidade**. A resposta é sempre a mesma e sai antes do processamento (`after`): nem conteúdo nem tempo
   revelam se o e-mail tem conta. **Nenhuma conta nasce aqui.**
   - E-mail sem conta: pedido pendente (`cadastros_publicos`) com token de 32 bytes só em hash, link no fragmento
     `#t=`, validade de 24 h, um pendente por e-mail (o novo substitui o anterior).
   - E-mail com conta: recebe aviso para entrar (sem link de confirmação).
   - Limites: 10 pedidos/h por IP e 3/h por e-mail (antes de qualquer scrypt). Falha de envio invalida o pedido e fica
     auditada sem o e-mail.
3. **Confirmação** (`/cadastro/confirmar#t=…` → `POST /api/cadastro/confirmar`): uso único; cria a identidade com papel
   global **neutro**, registra os dois aceites (versão + SHA-256 do texto exibido), apaga o hash da senha do pedido e
   abre a sessão. Se uma conta com o e-mail surgiu nesse meio-tempo, recusa e pede para entrar.
4. **Empresa** (`/cadastro/empresa` → `POST /api/cadastro/empresa`, sessão autenticada; serve também para quem já tem
   conta e quer outro CNPJ — link "Cadastrar empresa" no Admin):
   - **Identificação da empresa**: CNPJ (dígitos verificadores, sem raiz repetida), razão social, nome fantasia, telefone.
   - **Pessoa responsável pelo uso**: quem cadastra, com Gestão **só nesta empresa**.
   - **Representação**: a pessoa declara ser sócia/administradora, procuradora ou responsável indicada. Fica
     `DECLARADA` até decisão da plataforma; não muda acesso.
   - **Sócios**: lista opcional de nomes e qualificação, `DECLARADO` (sem documento pessoal).
   - Numa transação: empresa ATIVA, cadastro administrativo (implantação em configuração), vínculo de Gestão,
     capacidades de Festa da Gestão, **teste grátis do CNPJ** (068), representação, sócios, aceites `NOVA_EMPRESA` e a
     chave de idempotência. Mesma chave = mesma empresa (clique duplo, conexão caída).
   - **CNPJ já cadastrado** (cadastro administrativo, teste já usado ou perfil legado como o da Kidmais): 409 com mensagem
     neutra, **nenhum dado da empresa existente**, nenhum vínculo; registra pedido de acesso (`solicitacoes_acesso_empresa`).
   - Concorrência no mesmo CNPJ: trava por CNPJ + índices únicos → uma empresa só; o outro recebe a resposta neutra.
   - Exige senha confirmada há ≤ 5 min (pede a senha na própria tela) e limita 5 empresas/dia por pessoa.
5. **Início guiado** (`/admin/inicio`): perfil, pacotes, chave Pix, equipe e primeiro cliente, cada item a partir de uma
   contagem real do banco; o que não está instalado aparece como "não disponível".

**Validar os dígitos do CNPJ não comprova a existência da empresa nem a autoridade de quem cadastra.** Nenhuma consulta
a base governamental foi integrada: exigiria verificar documentação, condições de acesso e custo (não feito).

## Painel do desenvolvedor

Ficha da empresa → **Representação e sócios**: representações (aprovar, recusar, revogar — senha recente, motivo,
evidência descrita, auditoria `REPRESENTACAO_*`), sócios declarados e pedidos de acesso (marcar como atendido depois de
convidar pelo fluxo de convites, ou recusar). Nada disso concede acesso. Atividade do painel inclui a origem
`CADASTRO_PUBLICO`.

## Pré-requisitos para ligar (`situacaoCadastro`)

`CADASTRO_PUBLICO_ATIVO=true` **e** e-mail configurado (`EMAIL_PROVIDER=resend` com remetente verificado — D1) **e**
`USUARIOS_CRIACAO_DIRETA=desativada` (E1). Faltando qualquer um, o cadastro responde 503 e a página explica.
`/api/cadastro*` é sempre permitido pelo paywall (cadastrar outra empresa não depende da situação da atual).

## Termos e privacidade

`lib/cadastro/documentos-legais.ts`, páginas `/termos` e `/privacidade`. Versão `2026-10-07-minuta`, **marcadas como
minuta** com lacunas `[A DEFINIR]` (preços, cancelamento, retenção, canal de atendimento, suboperadores, encarregado).
Não são textos legais definitivos: dependem de revisão jurídica (D11) e de nova versão antes da publicação — trocar
qualquer texto muda o hash e exige nova versão.

## Migration 069

| Arquivo | Papel |
|---|---|
| `database/migrations/20261007_069_cadastro_publico.sql` | `cadastros_publicos`, `aceites_documentos_legais` (só inserção), `cadastros_empresas` (idempotência), `empresa_socios` (só inserção), `solicitacoes_acesso_empresa` |
| `database/checks/20261007_069_precheck.sql` / `_postcheck.sql` | Somente leitura |
| `database/rollback/20261007_069_cadastro_publico_down.sql` | Recusa com qualquer dado de cadastro |

Ordem: 067 → 068 → 069, cada uma com precheck, aplicação e postcheck.

## Validação (simulações locais)

- Unitários `lib/cadastro/cadastro.test.ts` 5/5 (hash/versão dos documentos, condições para abrir, validação do pedido,
  token só no fragmento, rotas).
- PostgreSQL 18 descartável `lib/cadastro/cadastro-069.postgres.test.ts` 10/10: migration/rollback; pedido sem conta;
  conta existente sem link; limite por e-mail e por IP; falha de envio; confirmação de uso único, vencida e em corrida;
  empresa completa e idempotente; CNPJ existente (outra pessoa e perfil legado) neutro com pedido de acesso; CNPJ
  inválido; **concorrência real em duas conexões**; mesma pessoa com dois CNPJs (Gestão em uma, Equipe na outra);
  reautenticação; cadastro fechado; limite diário; decisão de representação auditada sem mudar acesso.
- Navegador (Chrome headless, e-mail em arquivo local, `scripts/cadastro-publico-ui.cjs`) 5/5: planos; cadastro
  completo até o início guiado; CNPJ existente sem dados de terceiros; e-mail já cadastrado; celular sem rolagem.
- `npm run check:v1:static`.

## Pendente / decisões

- D1: provedor e domínio remetente (Resend) — sem isso o cadastro não liga.
- D4 (teste por CNPJ completo ou raiz), D11 (textos legais), preços.
- Proteção anti-robô (CAPTCHA): não incluída; limites por IP/e-mail no lugar. Avaliar se houver abuso.
- Notificar a Gestão da empresa existente sobre pedido de acesso: hoje o pedido aparece no painel do desenvolvedor.
