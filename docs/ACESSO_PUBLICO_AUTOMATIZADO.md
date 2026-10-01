# Acesso público automatizado do cliente — preparação (Fase 29)

**Estado:** preparado, não ligado. Regra de domínio e portas em `lib/contratos/acesso-publico/liberacao.ts`
(com testes). Sem rota, sem tabela, sem envio real. É fluxo **transacional**, separado do Kidmais
Intelligence: nenhum LLM participa.

## Hoje

Em Contratos, com a versão em `AGUARDANDO_CLIENTE`, o admin vê o link “Abrir acesso público do cliente”
(`/contrato/<id>`). O cliente prova a identidade por CPF + OTP (fluxo de identidade existente, Gupshup)
e recebe o token de acesso (`criarContratoAcessoToken`). Não existe registro de “acesso liberado” nem envio
automático do link.

## Fluxo alvo

1. Admin clica **Abrir acesso público do cliente** → a liberação é registrada (empresa comprovada, versão,
   ator, horário).
2. O sistema envia um WhatsApp **transacional** com o link `https://<origem>/contrato/<uuid>`.
   A mensagem **não** contém OTP, CPF, token ou valor.
3. O cliente abre o link, informa o CPF, recebe o OTP (fluxo existente), valida e acessa.
4. Falha no WhatsApp **não** revoga a liberação: o admin vê “não enviado” e usa **Reenviar acesso**.

Regras já implementadas em `liberacao.ts`: link só HTTPS e só `/contrato/<uuid>`; parâmetros do template
sanitizados; chave de idempotência por contrato + versão + tentativa (clique duplo/retry não duplica);
reenvio com intervalo mínimo de 60 s e teto de 5 por 24 h; liberação revogada recusa envio.

## O que falta (com gate humano)

| Passo | Gate |
|---|---|
| Migration: tabela `contrato_acessos_publicos` (empresa_id, contrato_id, versao_id, liberado_por/em, revogado_em) e `contrato_acesso_envios` (chave_idempotencia única, tentativa, status, em) com FK composta de empresa | aplicar migration (autorização explícita) |
| Template transacional aprovado no provedor (Gupshup/Meta) com 3 parâmetros: nome, empresa, link | criar/aprovar template no provedor |
| Implementar `EnviadorAcessoWhatsapp` reaproveitando a configuração Gupshup existente | uso de serviço externo pago; envio real |
| Rota `POST /api/admin/contratos/[contratoId]/acesso-publico` (liberar / reenviar), com Tenant Context, papel e auditoria | revisão de código |
| Botões **Abrir acesso público do cliente** e **Reenviar acesso** no painel de Contratos | revisão de UX |

## Auditoria e idempotência

- Auditoria de negócio: `ACESSO_PUBLICO_LIBERADO`, `ACESSO_PUBLICO_ENVIO` (com status), `ACESSO_PUBLICO_REVOGADO`,
  com request id e sem conteúdo da mensagem.
- Idempotência: a chave do envio é única no banco; o retry do mesmo clique devolve o resultado registrado.
