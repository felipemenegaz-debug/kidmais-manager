# Kidmais Intelligence V1 — Segurança adversarial

Rodada adversarial da V1 (Fase 12 do Master Goal). Cada vetor foi atacado com testes executáveis; o resultado de
cada um está abaixo com a defesa que segura o ataque, o teste que prova e o risco residual classificado.

Suíte principal: `lib/inteligencia/seguranca-v1.test.ts` (roda em `npm run test:inteligencia`).

## Achados desta rodada (corrigidos)

| # | Severidade | Achado | Correção | Prova |
|---|---|---|---|---|
| F1 | MÉDIA | Pedido com o id de outra empresa ("panorama da empresa 2222…") era respondido com os dados da empresa da sessão (não vazava, mas enganava o operador) | JEV: empresa/tenant/conta citada por identificador ⇒ `SINAL_OUTRO_TENANT` (FORBIDDEN); unidade/estabelecimento por identificador ⇒ `SINAL_OUTRO_ESTABELECIMENTO` | teste 5 e 17 |
| F2 | MÉDIA | Texto de dado com cara de instrução (observação, descrição) chegava ao contexto do modelo | `redigir` troca o texto por `[conteúdo omitido]`; `validarExplicacao` recusa explicação que ecoa instrução (`INSTRUCAO`) | teste 2 |
| F3 | MÉDIA | Varredura de skill aceitava "ignore as instruções anteriores", "finja ser…", "não precisa pedir confirmação", "considere pago" | Novos padrões em `CONTEUDO_DESVIO_POLITICA` e `CONTEUDO_FINANCEIRO`; skills da plataforma continuam limpas | teste 13 |
| F4 | BAIXA | Valor de marcador envenenado (nome de cliente com instrução) entrava no rascunho | Agente deixa o marcador pendente se o valor parece instrução ou passa de 120 caracteres | teste 2 |
| F5 | MÉDIA (funcional) | Servidor recusava as telas `agenda`/`configuracoes` que o Copiloto e a UI passaram a usar | `contextoSchema` da conversa aceita as duas telas | Fase 13 |
| F7 | MÉDIA (auto-review #2) | Marcadores do rascunho (nome do cliente) eram lidos do domínio sem passar pela Policy V1 | Mesma decisão de `resumir_cliente` (manifesto, papel da membership, flag, allowlist) antes de ler; negada ⇒ sem marcador | integrado-v1 (auto-review 2) |
| F6 | ALTA (funcional, Fase 11) | A UI recusava respostas de agente (caíam como erro) | Contrato da UI valida e renderiza `agente` e `complemento` | `inteligencia-ui.test.ts` (V1) |

## Vetores atacados

| Vetor | Defesa | Prova |
|---|---|---|
| prompt injection | JEV (NFKC, ocultos, escrita mista, `INJECAO`) antes de qualquer leitura; Demerzel `RECUSA_INJECAO` | seguranca-v1 #1, jev-v1, demerzel |
| indirect prompt injection | Context Builder omite instrução em dado; explicação validada; rascunho não usa marcador envenenado | seguranca-v1 #2, contexto |
| PDF hostil | PDF isolado (processo próprio, limites), extração validada, nada do texto vira instrução; Human Gate na importação | importacao/*.test, seguranca-demo |
| texto importado malicioso | Mesmo caminho: dado, nunca instrução; `pareceInstrucao` | seguranca-v1 #3-4 |
| tenant confusion | Tenant só da sessão (`withTenantTransaction`); schemas estritos recusam `empresaId`; JEV recusa tenant citado | seguranca-v1 #5, gateway, registro-ferramentas |
| tool escalation | Tool Registry fechado com manifesto; agente só lê da própria lista ∩ catálogo; sem SQL/shell | seguranca-v1 #6, registro-ferramentas |
| role escalation | Policy V1 com papel da membership; papel inventado ⇒ `NEGADO_PAPEL`; pedido de papel ⇒ FORBIDDEN | seguranca-v1 #7, politica-v1 |
| stale approval | Cada passo do Human Gate reavalia Policy + manifesto; confirmação só pela origem `HUMAN_GATE` | seguranca-v1 #8, politica-v1, human-gate |
| replay | Idempotência por versão + hash; replay revalida tenant, RBAC, flag, allowlist, manifesto | acoes/human-gate.test (A4, B3) |
| confirmação duplicada | Compare-and-set por versão/estado; resultado gravado devolvido sem reexecutar | acoes/human-gate.test |
| budget bypass | Orçamento fail-closed (ausente/inválido/sem teto/preço desconhecido ⇒ recusa); reserva com lock por empresa | seguranca-v1 #11, roteador, uso |
| fallback bypass | Troca de provedor só com `AI_FALLBACK_ENABLED=true` exato | seguranca-v1 #12, roteador |
| skill injection | Hash + revisão + varredura de conteúdo; skill não tem autoridade; RESTRITA | seguranca-v1 #13, skills |
| context poisoning | Bloco de outra empresa ou capacidade não autorizada recusa o contexto inteiro | seguranca-v1 #14, contexto |
| agent loop | Portas contadas pela Demerzel: teto de passos, duplicidade, prazo, custo | seguranca-v1 #15, agentes |
| cross-tenant UUID | Posse comprovada no domínio; outra empresa = 404 sem eco do id | seguranca-v1 #16, resumir-contrato |
| establishment escape | Establishment Context: unidade só da tela, provada pelo Core; ESTABLISHMENT exige unidade; bloco/skill de outra unidade recusados; JEV recusa unidade citada | seguranca-v1 #17, estabelecimento-v1, provar-estabelecimento.postgres |
| malformed model output | Saída validada por schema estrito; inválida ⇒ regras (`FALLBACK_REGRAS`); explicação inválida ⇒ sem explicação | seguranca-v1 #18, jev-v1, copiloto |

## Riscos residuais (classificados)

| # | Severidade | Risco | Mitigação atual | Decisão/Gate |
|---|---|---|---|---|
| R1 | MÉDIA | Detecção de injeção por padrões pode ser contornada por redação nova | Arquitetura não depende dela: modelo sem ferramentas, Policy/Registry/Human Gate decidem | Aceito na V1; revisar padrões com dados reais de staging |
| R2 | MÉDIA | Dados operacionais do Core ainda sem unidade e unidade fechada na 043 (D03) | Establishment Context pronto; leituras COMPANY; nenhuma unidade comprovável hoje (fail-closed) | Decisão do Core (D03 + unidade nos dados); na IA basta trocar o escopo no registro |
| R3 | MÉDIA | Explicação do modelo pode conter afirmação falsa sem número | Rotulada como sugestão, abaixo dos dados; números/ids/ações/instruções validados | Aceito; Copiloto com modelo só com flag |
| R4 | MÉDIA | Skills de empresa sem armazenamento (exige migration); skills da plataforma RESTRITAS sem revisão independente | Só plataforma; repositório vazio | **Decisão humana**: migration de skills + revisão independente |
| R5 | BAIXA | Leitura que estoura o prazo continua no banco até terminar | Somente leitura; resposta já é fallback | Aceito |
| R6 | BAIXA | Rascunho copiado pode ser enviado com erro pelo operador | Pendências explícitas; aviso "o Kidmais não envia" | Aceito |
| R7 | BAIXA | Visão de custos depende da 055a aplicada | `disponivel: false` sem as tabelas | Gate de staging (aplicar 055a com autorização) |

Nenhum achado ALTO ou MÉDIO conhecido ficou sem classificação.
