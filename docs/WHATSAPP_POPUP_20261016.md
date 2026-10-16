# Janela de autorização Meta — 16/10/2026

## Diagnóstico

Felipe informou que a janela da Meta não abriu. A UI de staging mostrou autorização não concluída e nenhuma conexão ativa. O callback local emite essa mensagem quando não recebe `authResponse.code`; isso não identifica sozinho a causa.

Leitura do painel Meta: OAuth cliente/Web e login SDK habilitados; origem de staging e URIs de redirecionamento presentes. Nenhuma configuração remota alterada. Console da aba sem erros/avisos disponíveis na captura.

O componente chamava `FB.login` após reautenticação, requisição de início e carregamento assíncrono do SDK. A [documentação oficial Meta](https://developers.facebook.com/documentation/javascript/reference/FB.login) orienta abrir o login em resposta a clique para evitar bloqueio de pop-up. Perda de ativação do clique é hipótese compatível com o código e o relato; não foi instrumentada no navegador real.

## Correção local

Branch `codex/whatsapp-popup-20261016`, base `6557272` de origin/staging. Worktree isolado `kidmais-manager-whatsapp-popup-20261016`.

- Primeiro botão `Preparar conexão`: preserva reautenticação e criação da tentativa, carrega o SDK e limpa a senha do estado.
- Segundo botão `Continuar na Meta`: chama `FB.login` sincronamente no novo clique, sem aguardar rede. Tentativa expirada/inválida exige nova preparação.
- Cancelamento sem código e exceção do SDK limpam o listener; mensagem orienta verificar bloqueio se a janela não abrir.
- Mantidos contrato do backend, validação de origem/IDs/state e fluxo de conclusão. Nenhuma mudança de escopos, segredo, infraestrutura ou banco.

## Validação local

- Testes de handlers reais transpiliados, com hooks/SDK/transportes sintéticos: **5/5 PASS**. Cobrem fronteira síncrona do clique, senha recusada, expiração, callback sem código e exceção do SDK.
- Testes existentes `onboarding.test.ts` e `configuracao.test.ts`: **5/5 PASS**.
- ESLint do componente e teste: PASS.
- `npm run build`: PASS, inclui TypeScript e geração de páginas.
- Primeira rodada em Node **24.20.0**. Repetida em **22.23.2** (versão de `engines`/`.node-version`): os mesmos testes 5/5 + 5/5, ESLint e `next build` com TypeScript **PASS**.
- Instalação offline com `--ignore-scripts`, sem arquivos de ambiente reais; nenhuma credencial carregada nem banco acessado.

Os testes não comprovam abertura do pop-up em Chrome/Edge/Codex nem autorização real da Meta. Revisão independente somente leitura por outro agente: APROVADO tecnicamente, sem achados acionáveis, com repetição do teste sintético 5/5 PASS. Validação visual/funcional do fluxo real continua pendente. Não repetidas tentativas com número nem gravado vídeo nesta rodada.

### Limites dos testes sintéticos (revisão 16/10)

- `useState`/`useRef` são simulados; não há React DOM, renderização real nem ordem de efeitos do React.
- A "fronteira do clique" é uma flag do teste: comprova que `FB.login` roda dentro do `onClick`, sem `await` antes. Não comprova a ativação transitória do navegador nem que o SDK abre a janela de forma síncrona.
- O SDK, a reautenticação e as rotas são substituídos; contrato real da Meta, `postMessage` da janela e conclusão no backend não são exercitados.
- O teste `.mjs` não está em script npm nem no CI (`ci.yml`); roda apenas manualmente com `node --test`.
- Risco residual, não bloqueante: um duplo clique muito rápido em `Continuar na Meta`, antes da nova renderização, poderia chamar `FB.login` duas vezes.

## Publicação proposta: PR aberto; merge e deploy aguardam autorização

Revisar a candidata, publicar por PR para staging e, com autorização explícita, fazer deploy manual somente de `kidmais-manager-staging` (`srv-daif418ae00c73e8k2gg`, workspace `tea-daidbj95efls73d2bcf0`). Revalidar branch/auto-deploy antes do push/merge e o commit exato antes do deploy. Sem migrations, mudança de env ou produção. Após deploy: health e conferência visual dos dois botões; usuário faz reautenticação/autorização do número secundário. Recuperação proposta: deploy do commit anterior, também sujeito a autorização. Não declarar o problema resolvido em staging antes dessa validação.
