---
name: kidmais-relatorio
description: Gera o relatório de entrega padronizado de uma tarefa do Kidmais Manager (objetivo, regras, arquivos, testes, riscos, rollback, pendências). Use ao concluir um bloco de trabalho, quando o usuário pedir "relatório", "resumo da entrega", "handoff" ou ao preparar homologação.
---

# Relatório de entrega

Substitui os `RELATORIO_*.md` / `README_*.md` soltos na raiz. Os antigos ficam onde estão (histórico; não mover sem revisão).

## Onde salvar

`docs/relatorios/AAAA-MM-DD-<assunto-curto>.md` (crie a pasta se não existir). Se o usuário só quiser o resumo na conversa, não crie arquivo.

## Modelo

```markdown
# <Assunto> — AAAA-MM-DD

## Objetivo
Uma ou duas frases: o que foi pedido e por quê.

## Regras aplicadas
- Regra → `docs/modulos/<MÓDULO>.md` (seção). Marque "NOVA" se a regra foi decidida nesta tarefa.

## O que mudou
| Arquivo | Mudança |
|---|---|

## Banco
Migrations, checks e rollback (ou "Sem alteração de banco").

## Testes
| Comando | Resultado |
|---|---|
| `npm run check:v1:static` | PASS |
Inclua o que **não** foi rodado e o motivo.

## Riscos
- Risco → mitigação.

## Rollback
Passos concretos para desfazer (código e banco), e o que se perde.

## Pendências e decisões em aberto
- Item → responsável.
```

## Regras

- Fatos verificáveis: nada de "testado" sem o comando e o resultado.
- Curto: o diff é o registro detalhado; o relatório explica o porquê e o risco.
- Se houve mudança de regra, confirme que `kidmais-doc-sync` foi aplicada.
