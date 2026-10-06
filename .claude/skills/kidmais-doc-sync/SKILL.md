---
name: kidmais-doc-sync
description: Verifica e atualiza a documentação oficial do Kidmais Manager (docs/) ao fim de uma tarefa que mudou regra de negócio, arquitetura, roadmap, operação ou decisão técnica relevante. Use antes de abrir PR e sempre que o usuário tomar uma decisão de produto na conversa.
---

# Doc sync

`docs/` é a fonte oficial (docs/README.md). Regra de mudança (docs/01): registrar no módulo → atualizar o índice se preciso → changelog → ADR quando houver impacto arquitetural.

## Checklist

| Se a tarefa… | Atualize |
|---|---|
| mudou regra de um módulo | `docs/modulos/<MÓDULO>.md` |
| criou módulo ou regra estrutural | `docs/01-REGRAS-DE-NEGOCIO.md` (índice) |
| mudou comportamento visível ao negócio | `docs/06-CHANGELOG-FUNCIONAL.md` (entrada no topo: `## AAAA-MM-DD — Assunto` + "Definido:" em lista) |
| decisão arquitetural (tenant, permissões, Core x Configuração, banco) | novo `docs/arquitetura/ADR/ADR-NNN-TITULO.md` (Status, Data, Contexto, Decisão, Consequências) |
| mudou fase, prazo ou entrega | `docs/03-ROADMAP.md` |
| mudou segurança/auditoria | `docs/04-SEGURANCA-E-AUDITORIA.md` |
| mudou processo de trabalho, skills ou mods | `docs/07-FLUXO-DE-TRABALHO.md` / `docs/08-IA-AGENTES-SKILLS-HARNESS.md` |

## Regras

- Escreva a regra vigente, curta, em português, no estilo dos arquivos existentes (listas, sem prosa longa).
- Não apague nem mova documentos legados da raiz sem revisão específica (docs/README.md).
- Não documente detalhe de implementação que muda à toa; documente regra e decisão.
- Se a regra não foi decidida pelo usuário, não a registre como oficial: pergunte.

## Saída

Liste os arquivos de docs alterados, ou diga "Docs sem alteração necessária" com o motivo.
