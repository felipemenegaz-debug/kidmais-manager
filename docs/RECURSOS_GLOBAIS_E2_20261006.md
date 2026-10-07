# E2 — Recursos da instalação fora do alcance das empresas

Segunda entrega do plano de venda por assinatura ([PROPOSTA_VENDA_ASSINATURA_20261006.md](PROPOSTA_VENDA_ASSINATURA_20261006.md), §8).
Objetivo: antes do cadastro público, nenhuma empresa nova pode alterar ou ler recursos que valem para a instalação inteira.

## Levantamento (staging 8c71673)

| Recurso | Antes | Depois |
|---|---|---|
| Regras comerciais e descontos por data (`data/disponibilidade.json`, alimenta a agenda pública) | Qualquer vínculo de qualquer empresa lia e gravava pela agenda administrativa | **Corrigido**: só a empresa dona da agenda pública vê e altera; as demais recebem listas vazias e 403 `AGENDA_CONFIG_DA_INSTALACAO` |
| PDF da tabela de pacotes (`documentos_publicos`) | Publicação já exige autoridade de plataforma (identidade global) | Sem mudança |
| WhatsApp/Meta (`whatsapp_conexoes`, credencial única) | Consulta e onboarding já exigem autoridade de plataforma + reautenticação | Sem mudança |
| Catálogo, pacotes e adicionais públicos (`/api/fechamentos/*`) | Já respondem 403 `CATALOGO_PUBLICO_INDETERMINADO` | Sem mudança |
| Agenda pública (`/api/disponibilidade`) | Atende só `AGENDA_PUBLICA_EMPRESA_ID` | Sem mudança |
| Autoridade de plataforma | Vem só do papel da identidade global; fluxos de empresa criam identidade neutra | Sem mudança (E1 e Pix também não a concedem) |
| **Bloqueios de agenda antigos sem empresa** (anteriores à 062) | Valem para todas as empresas até a plataforma atribuí-los (regra da 062) | **Pendência operacional** — ver abaixo |

## Dona da configuração legada

`lib/disponibilidade/config-legada.ts`, nesta ordem: `AGENDA_PUBLICA_EMPRESA_ID` (se for uma empresa existente);
a empresa de código `kidmais`; a única empresa não desativada da instalação. Com várias empresas e nenhuma dessas
regras, ninguém altera. Para a Kidmais nada muda: ela continua editando como antes.

## Pendência antes do cadastro público (obrigatória)

Os bloqueios sem empresa (`bloqueios_agenda.empresa_id IS NULL`, ativos) bloqueiam a agenda de **todas** as empresas e
aparecem para elas como "GLOBAL", com o motivo. Antes de abrir o cadastro, a plataforma precisa atribuir ou liberar
todos eles (painel da agenda, `resolverEDesativarBloqueioLegado` / `liberarBloqueioLegadoPelaEmpresa`). É uma operação
de dados autorizada à parte; o cadastro público (E6) deve recusar ser ligado enquanto houver algum.

## Validação

- `lib/disponibilidade/config-legada.test.ts`: ordem da dona, recusa 403 para outra empresa, checagem antes de abrir o
  arquivo e tela sem os controles.
- `npm run check:v1:static`: testes, lint, TypeScript e build aprovados (06/10/2026).
- Sem migration. Rollback: reverter o código.
