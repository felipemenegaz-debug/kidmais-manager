# 08 — IA, Agentes, Skills e Harness

## Objetivo
Definir como usar modelos de IA, Codex, skills, agentes, subagentes e loops de validação no desenvolvimento do Kidmais Manager SaaS com equilíbrio entre qualidade, segurança, tempo e consumo.

## Princípio geral
Não usar o modelo mais caro nem o maior esforço para todas as tarefas.

O processo deve escolher deliberadamente:
- modelo;
- esforço de raciocínio;
- número de agentes;
- escopo;
- critérios de parada.

## Matriz oficial de modelos

### GPT-6 Astra
Usar quando a tarefa for especialmente difícil, ambígua ou crítica:
- arquitetura complexa;
- investigação de bugs difíceis;
- segurança;
- revisão pré-produção de alto risco;
- migrations complexas;
- problemas desconhecidos após tentativas normais;
- análise multidisciplinar com muitos arquivos e dependências.

Esforço recomendado:
- Low: primeira tentativa para problemas exigentes quando Astra estiver disponível;
- Medium: arquitetura e debugging complexo;
- High: segurança ou revisão crítica;
- XHigh/Max: somente de forma excepcional e justificada.

### GPT-5.6 Sol
Modelo principal para implementação cotidiana:
- features;
- refatorações;
- APIs;
- testes;
- bugs moderados;
- migrations comuns;
- análise de código;
- PRs.

Esforço recomendado:
- Medium: padrão;
- High: multi-tenant, banco, permissões e refatorações críticas.

### GPT-5.6 Terra
Usar para:
- exploração da base;
- leitura de muitos arquivos;
- documentação;
- revisões auxiliares;
- alterações rotineiras;
- subagentes econômicos.

Esforço:
- Low ou Medium;
- High apenas quando agir como reviewer especializado.

### GPT-5.6 Luna
Usar para:
- tarefas repetitivas;
- extração;
- classificação;
- pequenas edições;
- documentação simples;
- tarefas bem delimitadas de alto volume.

Esforço:
- Low ou Medium.

## Regra obrigatória
Antes de iniciar uma tarefa relevante, registrar na instrução:
- modelo recomendado;
- esforço;
- se haverá subagentes;
- tipo de validação esperado.

## Configuração inicial recomendada
Para a maioria das tarefas:
- Agente principal: GPT-5.6 Sol / Medium.
- Explorer: GPT-5.6 Terra ou Luna / Low-Medium / read-only.
- Reviewer: GPT-5.6 Terra ou Sol / High / read-only.
- Security reviewer: GPT-6 Astra / Medium-High somente quando necessário.

## Agentes e subagentes

### Agente principal
Responsável por:
- entender objetivo;
- coordenar trabalho;
- fazer alterações;
- consolidar resultados;
- não delegar decisões de escopo sem necessidade.

### Explorer
Read-only.
Responsável por:
- localizar arquivos;
- mapear fluxo;
- encontrar chamadas;
- identificar dependências;
- resumir sem modificar código.

### Reviewer
Read-only.
Responsável por:
- correção;
- regressões;
- testes ausentes;
- inconsistências;
- comportamento inesperado.

### Tenant/Security Reviewer
Read-only.
Usado quando houver:
- empresa_id;
- estabelecimento_id;
- autenticação;
- autorização;
- queries multi-tenant;
- dados pessoais;
- contratos;
- pagamentos;
- migrations estruturais.

Responsável por:
- isolamento cross-tenant;
- IDOR;
- vazamento;
- autorização insuficiente;
- integridade;
- rollback e failure modes.

### Migration Reviewer
Usado para mudanças importantes de banco.
Responsável por:
- compatibilidade;
- backfill;
- índices;
- constraints;
- rollback;
- efeito em dados existentes;
- sequência segura de deployment.

## Concorrência
Padrão inicial:
- máximo de 2 subagentes simultâneos além do principal.

Subir para 3 apenas quando as tarefas forem independentes e o ganho de paralelismo for evidente.

Evitar muitos subagentes porque:
- duplicam leitura;
- aumentam consumo;
- podem produzir análises redundantes;
- aumentam custo de coordenação.

## Quando delegar
Delegar quando a tarefa puder ser claramente separada em trabalho read-only ou revisão especializada.

Não delegar:
- pequenas mudanças;
- tarefas lineares;
- alterações simples;
- quando o custo de explicar o contexto for maior que executar diretamente.

## Skills iniciais

### kidmais-business-rules
Consulta documentação oficial antes de alterar regras funcionais.

### kidmais-tenant-safety
Verifica isolamento por empresa e estabelecimento.

### kidmais-safe-migration
Padroniza análise, migration, backfill, rollback, clone/homologação e postcheck.

### kidmais-test-gate
Define testes mínimos antes de considerar trabalho concluído.

### kidmais-pr-review
Revisa correctness, segurança, regressão e cobertura antes do PR.

### kidmais-doc-sync
Verifica se regras, ADRs, roadmap ou changelog precisam ser atualizados.

## Princípio das Skills
Manter poucas skills, com escopo claro.
Não criar skill para tarefas que o modelo executa bem apenas com documentação e AGENTS.md.

## AGENTS.md
O AGENTS.md deve conter somente regras permanentes e de alta prioridade, por exemplo:
- ler docs quando a tarefa afetar regra de negócio;
- não tocar produção sem autorização;
- tenant isolation obrigatório;
- migration remota de produção nunca automática;
- revisar diff e testes antes de concluir;
- reportar riscos e rollback.

Evitar transformar AGENTS.md em manual gigante.

## Harness
Não criar harness próprio nesta fase.

Usar:
- harness nativo do Codex;
- AGENTS.md;
- skills;
- agentes personalizados;
- scripts de validação;
- Git + PR;
- CI/CD.

Reavaliar harness próprio somente se houver necessidade clara de automação específica não atendida pelo Codex.

## Kidmais Development Loop

1. CONTEXTO
   - ler documentação relevante;
   - localizar código;
   - identificar riscos.

2. PLANO
   - definir menor mudança coerente;
   - indicar arquivos;
   - escolher modelo/esforço.

3. IMPLEMENTAÇÃO
   - alterar somente o necessário.

4. TESTE LOCAL
   - testes específicos primeiro.

5. SELF-REVIEW
   - revisar diff.

6. REVIEW ESPECIALIZADO
   - tenant/security/migration quando aplicável.

7. CORREÇÃO
   - corrigir achados concretos.

8. REGRESSÃO
   - ampliar validação conforme risco.

9. DOC SYNC
   - atualizar documentação se houve mudança de regra/arquitetura.

10. PR
   - resumo;
   - testes;
   - riscos;
   - rollback.

## Critério de parada
Evitar loops cegos.

Se duas tentativas independentes falharem pela mesma razão:
- interromper implementação;
- reavaliar hipótese;
- pedir exploração adicional;
- trocar para modelo mais capaz quando justificado.

Escalonamento sugerido:
1. Sol / Medium.
2. Sol / High.
3. Astra / Low-Medium.
4. Astra / High apenas para casos críticos.
5. Astra XHigh/Max excepcionalmente.

## Estratégia de tokens
Reduzir consumo por estrutura, não apenas reduzindo raciocínio:
- documentação persistente;
- prompts curtos;
- não repetir contexto já disponível;
- explorers read-only;
- arquivos e módulos bem delimitados;
- testes específicos primeiro;
- não iniciar vários agentes para tarefa simples;
- usar Astra apenas quando gerar ganho real.

## Plano de implantação dos agentes

### Estágio A — Fundação SaaS
Ativos:
- principal;
- explorer;
- reviewer;
- tenant/security reviewer.

### Estágio B — Primeiras migrations
Adicionar:
- migration reviewer.

### Estágio C — Productização
Adicionar agentes somente se surgir necessidade recorrente comprovada, por exemplo:
- docs researcher;
- UI reviewer;
- test specialist.

### Estágio D — Escala
Avaliar automações em CI para:
- PR review;
- segurança;
- tenant isolation;
- documentação;
- regressão.

## Regra de evolução
Um novo agente ou skill só deve ser criado quando:
1. a tarefa ocorrer repetidamente;
2. houver comportamento suficientemente específico;
3. o ganho superar custo de contexto/manutenção.

## Primeira tarefa SaaS
Fase 1A — diagnóstico da arquitetura e plano multi-tenant.

Configuração recomendada:
- principal: GPT-6 Astra / Low ou GPT-5.6 Sol / High;
- explorer: GPT-5.6 Terra / Medium;
- tenant reviewer: GPT-6 Astra / Medium;
- sem alterações de código;
- resultado: mapa de entidades, tabelas, APIs, autenticação, riscos, migrations propostas, rollback e testes.
