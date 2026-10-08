# Revisão do painel do desenvolvedor — 08/10/2026

Revisão feita com staging em `a3c9b2d` (somente leitura, sessão de desenvolvedor de Felipe), leitura de código e testes locais. Nenhuma ação administrativa que grave dados foi executada em staging; nenhuma chamada ao Asaas; nenhuma variável alterada.

Entregas:

- **PR #145** (`codex/painel-revisao-20261008`): cinco problemas comprovados em staging (tela e consulta do painel).
- **PR #146** (`codex/correcoes-comerciais-20261008`): dois defeitos de regra comprovados em código (exceção vencida, listagem do provedor truncada) e testes da cobrança no painel. Escopo independente: nenhum arquivo em comum com a #145.
- **PR #147** (`codex/reconciliacao-auditoria-remocao-20261008`): a exclusão no Asaas feita pela reconciliação fica auditada mesmo quando a operação seguinte falha; resultado desconhecido registrado à parte e nunca repetido automaticamente (autorizada por Felipe em 08/10). Nenhum arquivo em comum com a #145; três com a #146 (`sincronizacao.ts`, `contratacao-e8.postgres.test.ts`, `contratacao.test.ts`), em trechos diferentes (merge automático).

## 1. Rastreabilidade

Fontes: `PROPOSTA_VENDA_ASSINATURA_20261006.md` §3 e §6, `PAINEL_DESENVOLVEDOR.md`, `PAINEL_ALERTAS_IMPLANTACAO_20261007.md`, `PAINEL_COMERCIAL_E5_20261007.md`, `CADASTRO_PUBLICO_E6_20261007.md`, registros de homologação de 07–08/10. Sugestões da proposta marcadas como **P** (próxima etapa) não são tratadas como requisito aprovado.

| Item | Origem | Situação |
|---|---|---|
| Telas do painel: resumo, interessadas, empresas, ficha, atividade, concessões | 063 | Feito; verificado em staging |
| Alertas de implantação | alertas 07/10 | Feito; 10 alertas e destinos verificados em staging |
| Plano, situação, datas, extensão de teste auditada, exceção com prazo, histórico | §3 L, E5 | Feito; ficha do Buffet 1 verificada (prazo, nível) |
| Representação declarada e aprovação/recusa/revogação auditadas; pedidos de acesso | §3 L, E6 | Feito; representação `DECLARADA` e pedido de C `RECUSADA` com motivo verificados |
| Eventos do provedor, sincronização, pendências, liberação manual | §6, E8 | Código feito; execução real pendente dos testes A2–A12 (10/10) |
| Transferência de responsável pelo painel | §3 L | Feito por composição: convite como Gestão → aceite → rebaixar a pessoa anterior (guarda de última Gestão). Trocar a Gestão **não** transfere a representação (decisão de Felipe, 08/10); código conforme. Sem fluxo de nova declaração para empresa existente (§6.1) |
| Atividade sem as origens de cobrança | defeito | **Corrigido na #145** |
| Códigos crus nos rótulos (cadastro público, cobrança, `PENDENTE`) | defeito | **Corrigido na #145** |
| Busca de contratantes por CNPJ formatado | defeito | **Corrigido na #145** |
| Origem "Cadastro direto" em empresa do cadastro público | defeito | **Corrigido na #145** |
| Tabelas quebrando palavras e datas a 390 px | defeito | **Corrigido na #145** |
| Revogar exceção já vencida era aceito | defeito | **Corrigido na #146** |
| Listagem do Asaas truncada em silêncio além do limite de páginas (o risco depende da quantidade de registros, de qualquer situação; lista de cobranças truncada podia esconder pagamento e permitir exclusão indevida de duplicata) | defeito | **Corrigido na #146** |
| Reconciliação: exclusão concluída no Asaas sem auditoria quando a operação seguinte falha; resposta perdida tratada como "indisponível" e exclusão repetida | defeito | **Corrigido na #147** |
| Uso por empresa (custo de IA do 055a, usuários, documentos) | §6 | Fora desta entrega (§6.2) |
| Link para o provedor nos eventos | §6 | Avaliar depois dos eventos reais de A2–A12 (§6.3) |
| Métricas de funil | §3 **P** | Não é requisito de lançamento (no lançamento: consulta SQL de leitura). Fora desta entrega (§6.2) |
| Avisar a Gestão da empresa existente sobre pedido de acesso | E6 | Pendente; depende de e-mail real (desligado). Fora desta entrega (§6.2) |
| Rótulos dos eventos do provedor (`PAYMENT_CONFIRMED` cru) | melhoria | Ainda não visto na tela (nenhum evento até A2). Avaliar depois de A2–A12 (§6.3) |

## 2. PR #145 — revisão

| Aspecto | Conclusão |
|---|---|
| Compatibilidade | Sem migration, variável ou rota nova. `cadastro.origem` é campo novo e opcional na ficha; telas antigas o ignoram. A busca mantém os filtros existentes e só acrescenta a comparação por dígitos (3 ou mais) |
| Isolamento | Atividade continua restrita às origens administrativas (lista do Resumo + `COBRANCA`); nenhuma origem de contratos, pagamentos de festa, financeiro ou IA. A consulta da origem do cadastro só lê `cadastros_empresas` da empresa da ficha, e só se a tabela existir |
| Exposição de dados | Os registros de cobrança passam pela mesma sanitização; os de webhook recusado só têm motivo, provedor e IP (sem corpo nem token). Os motivos aparecem como texto ("sem token de autenticação"), sem valores |
| Permissões | Nenhuma mudança: rotas e páginas continuam com a guarda de concessão; os testes de Gestão sem concessão → 404 continuam passando |
| Testes | Novos testes falham no código de `staging` e passam na #145 (detalhe na descrição da PR) |

## 3. Ações sensíveis — revisão de código

Cobertas: concessões e revogações de desenvolvedor, convites e reenvios, pedidos de acesso, suspensão e reativação, papel e situação de vínculo, recuperação pelo painel, representação, exceções comerciais e extensão de teste, sincronização e liberação de cobrança.

Confirmado em código e testes:

- concessão de desenvolvedor conferida **dentro** da transação, antes de ler ou escrever (teste estático `painel.test.ts` e o novo `cobranca-painel.test.ts`);
- senha confirmada há no máximo 5 min, pelo relógio do banco, em toda operação de efeito (provisionar, suspender/reativar, papel, vínculo, exceções, sincronização, liberação);
- motivo obrigatório (5–500) nas operações comerciais, de representação e de suspensão;
- auditoria na mesma transação da mudança, sanitizada; o resultado do envio de e-mail é auditado à parte, com o resultado real;
- alvo sempre na empresa da rota: exceção de outra empresa → "não encontrada";
- falha do provedor → 502 "Nada foi alterado/liberado"; resultado incerto não cria assinatura nova.

Defeitos comprovados, corrigidos na #146: revogar exceção vencida e listagem truncada (detalhe na descrição da PR).

Avaliado e mantido: escrita depois do envio do e-mail fora do `try` (contador de reenvios, invalidação do pedido de recuperação, auditoria pós-commit). Só falha com o banco indisponível logo após o envio. Engolir a falha subcontaria o limite de reenvios ou perderia auditoria.

## 4. Usabilidade e estados

Verificado em staging e no teste de navegador:

- carregando, vazio e erro na Atividade, Empresas e Interessadas;
- datas invertidas no filtro → aviso;
- paginação com total;
- "Limpar filtros";
- links da Atividade para a ficha;
- alertas com destino;
- datas no fuso do navegador (Brasília para quem está no Brasil);
- 390 px sem rolagem horizontal da página (a tabela rola dentro do contêiner).

Problemas encontrados: os cinco da #145.

## 5. Depois do deploy — checklist

Tudo somente leitura, em staging, com a sessão de desenvolvedor de Felipe, salvo quando indicado. Antes de começar:

- confirmar que o live é o SHA do merge;
- anotar o número de alertas do Resumo, para comparar.

**Critério de parada geral:** qualquer 500 numa página do painel, qualquer acesso ao painel sem concessão, ou live diferente do SHA esperado → parar e seguir o rollback (§7).

| # | Correção | Verificação | Esperado | Parar se |
|---|---|---|---|---|
| 1 | Atividade com cobrança | `/desenvolvedor/atividade`, filtro Ação → "Webhook do provedor recusado" | Os 5 registros de 08/10 (16:53–17:04 em Brasília), com "sem token de autenticação" ou "token de autenticação inválido", IP e nenhum corpo; mais os eventos de A2–A12 | Ausentes; aparece qualquer registro de contratos, festas, financeiro ou IA |
| 2 | Rótulos | Resumo e Atividade, sem filtro | Nenhum código cru ("cadastro cnpj existente", "cobranca webhook recusado", `PENDENTE`) | Qualquer código cru das ações listadas na #145 |
| 3 | Busca por CNPJ | `/desenvolvedor/empresas`, buscar `97.310.458/0001-89` e depois `97310458000189` | As duas buscas mostram ENSAIO KMH Buffet 1 | Zero resultados |
| 4 | Origem | Ficha do Buffet 1 | Origem "Cadastro público (pela própria empresa)". A Kidmais continua com a origem anterior | "Cadastro direto" no Buffet 1 |
| 5 | Celular | Largura de 390 px: Resumo, Atividade, ficha | Cabeçalhos inteiros; data em uma linha; sem rolagem horizontal da página | "Quan/do" ou data partida; página rolando para o lado |
| 6 | Exceção vencida (#146) | Ficha do Buffet 1, bloco comercial | "Revogar" só em exceção vigente. **Não executar** revogação: a regra está coberta por teste | Botão em exceção vencida |
| 7 | Lista incompleta (#146) | Ficha do Buffet 1, cobrança e pendências | Página carrega como antes. Não há como reproduzir no sandbox listas acima do limite (200 assinaturas ou 500 cobranças, de qualquer situação): a regra está coberta por teste. Se uma pendência mostrar `LISTA_INCOMPLETA: …`, é revisão humana no painel do Asaas, não indisponibilidade | Erro ao abrir a ficha |
| 7b | Exclusão na reconciliação (#147) | Ficha do Buffet 1, pendências e Atividade | Nenhuma pendência `REMOCAO_SEM_CONFIRMACAO` sem motivo. **Não provocar** exclusão: a regra está coberta por teste. Se A2–A12 gerar duplicata, cada exclusão aparece como `ASSINATURA_DUPLICADA_REMOVIDA` (resposta do provedor ou releitura) ou como `ASSINATURA_REMOCAO_SEM_CONFIRMACAO` com marcador aberto | Exclusão no Asaas sem registro correspondente na Atividade |
| 8 | Permissões | Sessão de A (Gestão, sem concessão): `/desenvolvedor` e `/api/desenvolvedor/auditoria` | 404 nos dois | Qualquer conteúdo do painel |
| 9 | Regressão | Resumo | Mesmo número de alertas de antes do deploy; a Kidmais continua sem cobrança | Contagem diferente sem explicação |

## 6. Decisões e itens fora desta entrega

### 6.1 Transferência de responsável (decisão de Felipe, 08/10)

Regra: trocar a Gestão não transfere automaticamente uma representação aprovada. O registro anterior é preservado, e qualquer nova representação passa pelo fluxo próprio de declaração e aprovação.

Conferido no código:

- **Quem grava representação:** só o cadastro público cria (`lib/cadastro/publico.ts`, `INSERT` com situação `DECLARADA`), e só a decisão do painel muda a situação (`lib/desenvolvedor/representacao.ts`, com motivo, senha recente e auditoria). Mudar papel, desativar vínculo, convidar ou aceitar convite não toca em `empresa_representacoes`.
- **Banco (067):** a representação não é apagada; empresa, pessoa, qualificação e data da declaração são imutáveis; pode haver só uma em aberto ou aprovada por pessoa e empresa. A representação de quem deixou a Gestão continua como estava, até uma revogação explícita no painel.
- **O que a representação aprovada libera hoje:** nada. A D6 (o que exige representação aprovada) ainda não foi decidida (`MODELO_COMERCIAL_E3_20261006.md`), e nenhum código consulta `APROVADA` para permitir uma ação.

**Pendente, não implementado:** a única forma de declarar representação é o cadastro público, na criação da empresa. A nova Gestão de uma empresa já existente não tem onde declarar. Esse fluxo de declaração depois do cadastro é necessário antes de a D6 passar a exigir representação aprovada.

### 6.2 Fora desta entrega (por decisão de Felipe)

Nenhum destes itens será implementado agora:

- uso por empresa e métricas de funil;
- aviso à Gestão sobre pedido de acesso (depende de e-mail real);
- reforços opcionais de regra:
  - senha recente para convite, reenvio e recuperação pelo painel;
  - evidência obrigatória para aprovar representação;
  - manter o motivo digitado quando a decisão falha;
  - teto acumulado de extensões;
  - auditar falhas de sincronização e liberação;
  - 404 na sincronização de empresa inexistente;
  - impedir no banco que o papel da aplicação escreva em `plataforma_desenvolvedores`.

### 6.3 Eventos do provedor

Rótulos em português e link para o Asaas serão avaliados com os eventos reais de A2–A12. Até lá, a ficha mostra o tipo do provedor como ele chega (ex.: `PAYMENT_CONFIRMED`).

## 7. Merge, deploy, homologação e rollback

**Pré-condições:**

- o teste de bloqueio do Buffet 1 (10/10, a partir de 08:58:32 em Brasília) foi executado e registrado;
- A2–A12 do Asaas sandbox foram concluídos e a reversão foi executada ou decidida;
- Felipe autorizou merge e deploy.

**Sequência:**

1. Se `staging` andou, atualizar as duas branches com `staging` e esperar o CI verde.
2. Mergear a #145, a #146 e a #147 em `staging`, em qualquer ordem. A #145 não tem arquivos em comum com as outras; a #146 e a #147 compartilham `sincronizacao.ts`, `contratacao-e8.postgres.test.ts` e `contratacao.test.ts` em trechos diferentes (merge automático validado). Anotar o SHA de cada merge e conferir a árvore final com a da validação integrada (descrição da #147).
3. Deploy manual do serviço de staging (`srv-daif418ae00c73e8k2gg`) no último merge. Confirmar live = SHA.
4. Executar o checklist do §5 e registrar o resultado.
5. Promover para production pelo padrão já usado (branch `promote/…` que integra `staging` em `production`, como `27f6902`):
   - **Diff esperado:** só a #145, a #146, a #147 e o teste da #143.
   - **Sem** migration nem variável. `production` hoje difere de `staging` apenas pelo teste da #143.
6. **Em production**, manter como estão: cadastro público, e-mail real e cobrança **desligados**, sem nenhuma variável `ASAAS_*`. Conferir o inventário de variáveis antes e depois, sem ler valores.
7. Deploy de production com autorização própria. Fazer só leituras:
   - painel abre para o desenvolvedor;
   - Gestão sem concessão → 404;
   - Atividade sem erro.

**Rollback:** só há código e nenhuma migration, então o rollback é seguro.

- **Staging:** deploy manual de `a3c9b2d`, ou revert dos merges.
- **Production:** deploy do SHA anterior (hoje `27f6902`).

Em nenhum dos dois é preciso mexer no banco ou nas variáveis.

## 8. Limitações

- As correções não foram testadas em staging: dependem do deploy, que não está autorizado agora.
- Nenhuma correção está homologada.
- As correções da #146 (6 e 7) e da #147 (7b) não são reproduzíveis em staging sem gravar dados, excluir no provedor ou criar volume artificial; a evidência é o teste automatizado.
- A compensação imediata na contratação (`resolverFalhaNoVinculo`) ainda trata resposta perdida na exclusão como `COMPENSACAO_FALHOU`, e a reconciliação pode decidir excluir de novo: fora do escopo da #147, para decisão.
