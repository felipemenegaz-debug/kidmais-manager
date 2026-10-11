# Repetição N14–N16 no navegador local — cotação por empresa (10/10/2026)

**Status: PRONTO PARA APROVAÇÃO, NÃO EXECUTADO.** Nenhum cluster, banco, servidor ou navegador foi iniciado na preparação. Nada em
staging, produção, Render, Asaas, e-mail real ou banco real (`kidmais_manager`). Sem push nem deploy.

- **Código: `412654a3895678a5e333ce29adbfa17d9e95ef91`**. Este pacote está no commit seguinte, que altera só `docs/`; o SHA desse commit é o da aprovação.
  `git diff --name-only 412654a3895678a5e333ce29adbfa17d9e95ef91 HEAD` deve listar só `docs/`. Qualquer outra diferença: parar.
- Base: candidata anterior `936ef67` (navegador N14 FALHA) + correção abaixo. Branch local `claude/kidmais-manager-sales-site-9b9a2d`, não enviada.
- Procedimento, guardas, ambiente do servidor e lista de variáveis: os do [pacote do navegador](NAVEGADOR_LOCAL_20261010.md) (§2–§7), sem mudança.

## 1. O que foi corrigido

| Antes (`936ef67`) | Agora |
|---|---|
| A etapa “Escolha o pacote” em `/b/<código>/fechamento` percorria sempre o catálogo fixo da Kidmais (`PACOTES_FECHAMENTO_V1`): Mini Festa Kidmais, Festa Compacta/Essencial/Completa/Premium, Pizza Party Scienza, com selos, horários e preços da Kidmais, selecionáveis ao lado do pacote da empresa | `pacotesExibidos` (`components/fechamento/pacotes-tela.ts`): no endereço de outra empresa, **só** os pacotes devolvidos por `/api/fechamentos/pacotes` para ela, com nome, preço “a partir de” e descrição dela; sem selo, horário ou texto da Kidmais. Enquanto a lista não chega: “Carregando os pacotes…”; falha: aviso com “Tentar novamente”; lista vazia: “Nenhum pacote disponível…”. Nenhum desses estados recorre ao catálogo da Kidmais |
| O pacote escolhido herdava do catálogo da Kidmais limites, observação, buffet, horário e a regra “sob consulta” | `pacoteDaTela`: outra empresa só escolhe pacote que ela oferece e todos os dados vêm do servidor (sem máximo cadastrado: “Não informado”, e o servidor decide) |
| Etapa de convidados aplicava regras e textos da Kidmais (teto de 150 “A Kidmais atende…”, Festa Compacta só com 40, Pizza Party) | `erroConvidadosEmpresa`: só mínimo/máximo do pacote da empresa, redação neutra. A regra da Kidmais segue igual no endereço dela e no administrativo |
| Outra empresa ficava sem contato nenhum | `contatoPublicoDaEmpresa` (`lib/perfil/contato-publico.ts`) lê WhatsApp, telefone, e-mail, site e Instagram do **cadastro aplicado** da unidade da própria empresa (nunca o rascunho), conferidos por `contatoPublicoDe`; ambíguo, ausente ou com erro → sem contato. Exibidos no rodapé, na tela de conclusão, na validação de identidade pendente e quando não há pacote. Nunca o contato da Kidmais |
| — | Endereço atual da Kidmais (`/fechamento`): mesmo catálogo, selos, horários, preços publicados, contatos e regras — provado por teste que compara com o cálculo anterior |

Seed do navegador: o Profissional ganha perfil com unidade e contato sintético (WhatsApp `(11) 90000-0001`, e-mail
`contato-profissional@example.invalid`, site `https://profissional.example.invalid/`); o Premium continua **sem** contato. A conferência do seed passa a exigir os dois casos. A impressão do
schema não muda (`8a9a97477eac…3cfb`).

## 2. Validação local (código `412654a3895678a5e333ce29adbfa17d9e95ef91`)

| Verificação | Resultado |
|---|---|
| Testes unitários sem banco (conjunto do `check:v1:static`) | 2256/2256 (antes 2247; +9 de `components/fechamento/pacotes-tela.test.ts`) |
| Renderização (`pacotes-tela.test.ts`, `marca-publica.test.ts`, `pacotes-v1.test.ts`, `regras-pagamento.test.ts`) | 26/26 |
| Seed e servidor do navegador | 21/21 |
| Harness de staging (mocks) / verificação de produção | 103/103 / 37/37 |
| Planos offline do seed e da concorrência | `confere: true` (impressão inalterada) |
| TypeScript, worker de PDF, `next build` com fontes pelo mock local (61 páginas) | aprovados |
| ESLint | 0 erros (1 aviso preexistente) |
| `git diff --check` | limpo |

Todos os testes de `scripts/` (274): 267 passam; 7 falham **igualmente no `HEAD` anterior `8586a53`** (conferido num worktree temporário, já removido): `credito-natural.service`, `credito-projetado-ui`, `festa-016-reparo-encoding`, `festa-navegacao-manual`, `festa-navegacao-ui`, `lixeira-interacao`, `ux-contratos-perfil`. Não fazem parte do conjunto das candidatas anteriores nem tocam os arquivos alterados aqui.

Os testes de renderização usam `renderToStaticMarkup` nos componentes reais (`EscolhaPacote`, `ContatoEmpresa`) e procuram qualquer marca do catálogo/contato da Kidmais (“Mini Festa”, “Scienza”, “Mais escolhida”, “R$ 5.100”, “(61) 99340-5359” etc.) no endereço de outra empresa. O teste de fonte da tela falha com a versão anterior (`PACOTES_FECHAMENTO_V1.map`).

## 3. Pasta das credenciais anteriores

O seed grava sempre em `.local-navegador/credenciais.json` e recusa se o arquivo existir (`CREDENCIAIS_EXISTENTES`). Hoje a pasta
`.local-navegador/` guarda as credenciais sintéticas e os e-mails locais da execução de `936ef67`, preservados para revisão. Proposta
(B0, aprovação própria): **renomear** — não apagar — para `.local-navegador-execucao-936ef67/` (continua ignorada por `.local-*/`). Os
clusters anteriores (`.local-concorrencia-pg-5611…`, `.local-concorrencia-pg-a9e1…`, `.local-navegador-pg-5d5b…`,
`.local-navegador-pg-a7eb…`) não são tocados; C6 continua não autorizado.

## 4. Passos (cada um exige aprovação; PowerShell na raiz desta worktree)

0. **Pré-condições (leitura):** `HEAD` = SHA aprovado; `git diff --name-only 412654a3895678a5e333ce29adbfa17d9e95ef91 HEAD` só `docs/`; árvore limpa; nenhum
   `.env*`; nenhuma `DATABASE_URL`/`PG*`/`ASSINATURA_*_DIAS` no ambiente; portas 55481 e 3481 livres; nenhum processo dos clusters
   anteriores ativo. Offline: `node --test scripts/navegador-local-seed.test.cjs scripts/navegador-local-servidor.test.cjs`,
   `node scripts/navegador-local-seed.cjs --plano` (`confere: true`), `node scripts/navegador-local-servidor.cjs --plano` (`OK`),
   `node --experimental-strip-types --test components/fechamento/pacotes-tela.test.ts lib/fechamentos/marca-publica.test.ts`.
1. **B0 — renomear a pasta das credenciais anteriores:** `Rename-Item .local-navegador .local-navegador-execucao-936ef67`.
   Conferir que `.local-navegador` não existe e que a renomeada está ignorada (`git status --short` vazio).
2. **B1 — cluster novo:** `node scripts/cluster-descartavel-postgres.cjs criar --cluster kidmais_navegador --criar-autorizado` (pasta
   nova `.local-navegador-pg-<guid>`), `iniciar --pasta <pasta> --iniciar-autorizado`, `conferir --pasta <pasta>` (bancos `[]`).
3. **B2 — seed:** `$env:KIDMAIS_NAVEGADOR_AUTORIZACAO='127.0.0.1:55481/kidmais_navegador_n14_20261010'; node scripts/navegador-local-seed.cjs --seed-navegador-autorizado`.
   Esperado: `PASS`; conferência anterior + `contatoPublico`: `nav-profissional` com `whatsapp`, `email`, `site`; `nav-premium` `null`.
   Nenhuma senha no console.
4. **B3 — servidor:** mesma variável; `node scripts/navegador-local-servidor.cjs --iniciar-autorizado` (aba própria). Fontes pelo mock
   local, Asaas `DESLIGADO(CHAVE_FORA_DO_SANDBOX)`, sem ViaCEP (campo de CEP não usado).
5. **B4 — navegador:** painel em `http://localhost:3481`, **sem sessão** (N14–N16 são públicos; nenhuma credencial digitada).
   Desktop e celular (375×812). Conferir que todos os recursos carregam só de `localhost:3481`. Não enviar pedido.
6. **B5 — encerrar:** parar o servidor; `node scripts/cluster-descartavel-postgres.cjs parar --pasta <pasta>`; portas livres. Preservar
   pasta nova, renomeada e anteriores (sem C6).

## 5. Checklist (desktop e celular)

| # | Página | Esperado |
|---|---|---|
| N14a | `/b/nav-profissional/fechamento` | Título “Orçamento da festa”, ícone `/icone-orcamento.svg`, nome “Buffet Sintético Profissional (TESTE navegador)”, sem logo/nome Kidmais. Etapa de pacote com **um único cartão**: “Pocket sintético”, “A partir de R$ 1.500,00”, “Descrição não cadastrada.”, sem selo nem horário. **Nenhum** de: Mini Festa, Festa Compacta/Essencial/Completa/Premium, Pizza Party, Scienza, “Mais escolhida”, R$ 5.100, “Kidmais” |
| N14b | idem, escolher o Pocket | Detalhes: Mínimo 20 pagantes, Limite 30 convidados, Duração “Duração não cadastrada.”; sem observação ou “sob consulta”; “Continuar” leva ao calendário com horários |
| N14c | idem, etapa de convidados | 31 → “Pocket sintético atende até 30 convidados neste pacote.”; 19 → mínimo de 20; nenhum texto “Kidmais”/150 |
| N14d | idem, rodapé | Contato da empresa: WhatsApp “(11) 90000-0001” (`https://wa.me/5511900000001`), e-mail, site `profissional.example.invalid`. **Sem** “(61) 99340-5359”, `kidmaisfestas` ou Instagram da Kidmais em qualquer etapa visitada |
| N14e | `/b/nav-profissional/disponibilidade` | Como em `936ef67` (nome, ícone, horários), sem Kidmais |
| N15 | `/b/nav-premium/fechamento` e `/disponibilidade` | Igual a N14a–c/e com o nome do Premium; **sem rodapé de contato** (Premium sem contato cadastrado) e sem contato da Kidmais |
| N16 | `/b/nav-essencial/fechamento`, `/b/nav-essencial/disponibilidade`, `/b/nav-inexistente/fechamento` | As três respostas idênticas: 404, mesmo texto e título |

Critério de parada: qualquer pacote, preço, selo, horário, texto ou contato da Kidmais em `/b/<código>`; recurso fora de
`localhost:3481`; seed ≠ `PASS`; qualquer diferença de SHA. Parar, encerrar processos e reportar sem corrigir durante a execução.

## 6. Efeitos e recuperação

- Efeitos: só a pasta nova do cluster, a renomeação de `.local-navegador/` e a nova `.local-navegador/` (credenciais e e-mails
  sintéticos), todas ignoradas pelo Git. Nenhum efeito fora da máquina.
- Recuperação: parar servidor/cluster; desfazer B0 renomeando de volta (depois de mover a nova pasta para outro nome); remover a pasta
  nova do cluster só com autorização de limpeza (C6).
- Código: `git revert` dos commits da correção (nada foi enviado).

## 7. Riscos conhecidos

- Etapas depois do calendário (buffet, personalização, valor, dados, resumo) não fazem parte de N14–N16; já usavam as APIs da empresa,
  mas a varredura de textos neste pacote cobre o pacote, os convidados e os contatos. Teste de fonte continua barrando “Kidmais” sem a
  guarda da marca em toda a tela.
- O endereço legado `/fechamento` fica “não configurado” no servidor local (sem `AGENDA_PUBLICA_*`); o fluxo da Kidmais é provado por
  testes de renderização e comparação com o cálculo anterior, não no navegador.
- Contato público exibe o que a empresa aplicou no próprio perfil; sem perfil, a empresa fica sem contato (comportamento desejado).
