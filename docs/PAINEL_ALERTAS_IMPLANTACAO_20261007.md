# Painel do desenvolvedor — checklist de implantação e alertas acionáveis (07/10/2026)

Entrega pequena, sem migration: usa só tabelas da 063 (`plataforma_empresas_cadastro`, `convites_acesso`) e as
existentes (`empresas`, `memberships`, `usuarios_administrativos`, perfil 026/027). Nenhum dado operacional da empresa
(clientes, contratos, documentos, pagamentos) é lido. Nenhuma permissão é alterada.

## Checklist por empresa (`lib/desenvolvedor/implantacao.ts`)

| Item | Bloqueia "Implantação concluída"? | Fonte |
|---|---|---|
| Responsável com acesso de Gestão (`GESTAO_ATIVA`) | Sim | membership ATIVA + papel Gestão + conta ativa |
| Responsável do cadastro com acesso (`RESPONSAVEL_COM_ACESSO`) — **novo** | Não | e-mail do cadastro administrativo comparado com contas com Gestão ativa e convites válidos desta empresa |
| Gestão sem acesso (`GESTAO_SEM_ACESSO`) — **novo** | Não | Gestão com vínculo desativado (SUSPENSA) ou conta inativa |
| Convites pendentes (`CONVITE_RESPONSAVEL`) | Não | convites vencidos ou nunca enviados |
| Perfil da empresa criado / aplicado | Sim | 026/027 |

Ser responsável no cadastro **não concede acesso**: o acesso só nasce do aceite do convite (membership). O item novo
apenas mostra a divergência.

## Alertas acionáveis no resumo (`lib/desenvolvedor/alertas.ts`)

Calculados a cada carga do resumo, dentro da transação que já conferiu a concessão de desenvolvedor. Cada alerta tem
severidade, empresa, fato observado, data quando existe e link para a seção da ficha onde a ação é feita.

| Alerta | Severidade | Quando |
|---|---|---|
| Envio de e-mail indisponível | Urgente se houver convite não enviado; senão Atenção | `EMAIL_PROVIDER` ausente/desativado ou incompleto |
| Convite não enviado | Urgente | convite PENDENTE, dentro do prazo, com `envios = 0` |
| Convite expirado | Atenção | convite PENDENTE vencido |
| Empresa sem Gestão ativa | Urgente | empresa ATIVA, implantação concluída (ou sem cadastro), ninguém com Gestão ativa |
| Gestão sem acesso | Atenção | Gestão com vínculo desativado ou conta inativa |
| Responsável sem acesso | Atenção | e-mail do cadastro sem Gestão ativa nem convite válido |
| Implantação incompleta | Urgente sem Gestão; senão Atenção | implantação não concluída com item obrigatório pendente (lista o que falta) |
| Implantação pronta para concluir | Próximo passo | todos os obrigatórios atendidos, ainda não marcada |
| Sem cadastro administrativo | Próximo passo | empresa ATIVA sem cadastro no painel |

Limites: até 50 empresas em implantação examinadas item a item e até 60 alertas exibidos (o total aparece). Os e-mails
dos convites não aparecem nos alertas.

## Validação

- Unitários: `lib/desenvolvedor/implantacao.test.ts` (5) e `lib/desenvolvedor/alertas.test.ts` (6).
- PostgreSQL descartável: `lib/desenvolvedor/painel-063.postgres.test.ts` 34/34, com o caso novo de alertas sobre
  SQL real (responsável com Gestão atende; e-mail do cadastro trocado vira alerta sem mudar vínculos; empresa sem cadastro).
- Navegador (Chrome headless, `scripts/painel-implantacao-ui.cjs`): alerta "Implantação incompleta" com link para a
  ficha, que some depois da conclusão; resumo sem rolagem horizontal em 390 px.
- `npm run check:v1:static` aprovado.

## Rollback

Reverter o commit. Sem schema novo nem configuração.
