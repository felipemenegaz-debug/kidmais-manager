# Disponibilidade — implementação de engenharia

Data da revisão: 2026-09-07.

## Implementado neste pacote

- migration `database/migrations/20260907_005_disponibilidade_base.sql`;
- `configuracao_agenda` com os turnos 11h–15h e 17h–21h;
- tolerância e passo de início configuráveis;
- `bloqueios_agenda` com bloqueio parcial ou dia inteiro;
- triggers de `atualizado_em` reaproveitando a função criada pela migration 001;
- Repository PostgreSQL de Disponibilidade;
- `AvailabilityService` para geração dinâmica dos horários;
- conflito por intervalo real `[início, fim)`;
- API pública `GET /api/disponibilidade` sem exposição de motivos administrativos;
- rota administrativa separada `GET/POST /api/admin/disponibilidade`;
- painel administrativo grava bloqueios físicos no PostgreSQL;
- calendário do Fechamento consulta a API real e habilita somente ajustes de início efetivamente livres;
- regras comerciais atuais corrigidas para Pocket, Mini, Compacta e Pizza Party;
- testes unitários das regras de horário;
- fluxo público `/disponibilidade` com data → período → horário exato;
- Fechamento público recebe e preserva a seleção de Disponibilidade;
- Fechamento público não repete a etapa de data/horário quando a seleção já foi validada;
- acesso público direto a `/fechamento` sem seleção válida retorna ao fluxo de Disponibilidade;
- revalidação do horário antes de avançar do pacote e novamente no envio do Fechamento;
- `POST /api/fechamentos` revalida o intervalo diretamente no PostgreSQL antes de aceitar a solicitação.

## API pública

Consulta de uma data:

```text
GET /api/disponibilidade?data=2026-09-19
```

Consulta de período (máximo 62 dias):

```text
GET /api/disponibilidade?inicio=2026-09-01&fim=2026-09-30
```

A resposta operacional informa somente status e horários. Motivos internos de bloqueio não são enviados ao cliente.

## Migração

Executar após as migrations 001–004:

```text
20260907_005_disponibilidade_base.sql
```

Depois conferir:

```sql
SELECT codigo, nome, horario_inicio_padrao, horario_fim_padrao,
       tolerancia_inicio_minutos, passo_inicio_minutos
FROM configuracao_agenda
ORDER BY ordem_exibicao;
```

## Testes locais

```bash
npm run test:disponibilidade
```

Nesta revisão, os quatro testes de intervalo passaram.

Também foi executado:

```bash
npx tsc --noEmit
```

sem erros de TypeScript.

O lint direcionado aos novos arquivos de Disponibilidade também passou.

O lint global do projeto ainda aponta pendências anteriores em componentes do CRM/React (principalmente `react-hooks/set-state-in-effect`) e erros de `any` em `app/api/admin/clientes/schemas.ts`.

O `next build` não pôde ser concluído no ambiente de revisão porque o ZIP contém o SWC do Windows, enquanto o ambiente de validação é Linux e não possui acesso à internet para baixar `@next/swc-linux-x64-gnu`. Isso não indica erro do código TypeScript.

## O que ainda depende de módulos futuros

### Festas confirmadas

O Service já está estruturado para disponibilidade por intervalo, porém a ocupação por Festa confirmada deve ser adicionada quando a tabela física `festas` for implementada. Não foi criada uma tabela provisória para simular Festas.

### Elegibilidade comercial persistida

Pocket, Mini, Compacta, Essencial, Completa, Premium e Pizza Party ainda usam a regra comercial existente no código/arquivo de configuração. A tabela `regras_disponibilidade_pacote` deve ser criada somente depois da implementação física de `pacotes`.

### Concorrência final

A proteção definitiva contra duas confirmações simultâneas será implementada junto com Festa/Pagamento, usando revalidação transacional e lock da agenda antes da confirmação.

### Feriados

Não foi criada regra automática para feriados ou vésperas, pois continua pendente de definição comercial oficial.

## Integração atual com Fechamento

No fluxo público, a ordem oficial agora é respeitada:

```text
Disponibilidade: data → período → horário exato
Fechamento: pacote → convidados → demais etapas
```

A etapa de data/horário não é repetida dentro do Fechamento quando o cliente veio de `/disponibilidade`. A seleção aparece em resumo e pode ser alterada por um link que retorna à tela de Disponibilidade.

A disponibilidade é revalidada em três momentos:

1. ao entrar no Fechamento;
2. antes de avançar da escolha do pacote;
3. no backend de `POST /api/fechamentos`, imediatamente antes de aceitar a solicitação.

O fluxo administrativo iniciado internamente ainda mantém compatibilidade com o wizard legado até a engenharia específica do módulo Fechamento ser consolidada.
