# GPT Image para convites — preparação local

Integração preparada em código; não publicada. Nenhuma chave foi copiada do Render.
Confirmada a presença de `OPENAI_API_KEY` no Environment de kidmais-manager-staging,
apenas pelo nome e valor mascarado. Não foi confirmada validade, saldo ou permissão.

## Configuração do servidor

```text
CONVITES_IA_PROVIDER=openai
CONVITES_IA_ENABLED=true
CONVITES_IA_TETO_DIARIO_MICROUSD=3000000
```

O teto acima é exemplo: US$ 3/dia de reservas, até 10 pedidos com a reserva
conservadora existente de US$ 0,30 por pedido. Não representa medição exata do
faturamento nem limite rígido imposto ao fornecedor. Permissões, tenant, cotas,
idempotência e recuperação manual continuam no serviço existente.

Reutiliza `OPENAI_API_KEY` no servidor. Opcionalmente `CONVITES_OPENAI_API_KEY`
permite uma chave própria para imagens. Nunca usar prefixo NEXT_PUBLIC ou enviar
a chave ao navegador. Não copiar secrets de produção para testes locais.

Sem CONVITES_IA_PROVIDER mantém Gemini. Valores desconhecidos desabilitam IA.
Não há troca automática paga de provedor nem retry. Cada geração registra o modelo
real no campo modelo existente; não requer migration.

Modelo fixo: gpt-image-2.5-flare. Uma imagem WebP 768x1024 (3:4), qualidade medium.
Convite completo (V1, 13/10/2026): gpt-image-2.5-sunburst, xhigh, 1024x1536, PNG reencodado
para WebP nas mesmas dimensões; ver [CONVITES_EDITOR_V1_STAGING_20261013.md](CONVITES_EDITOR_V1_STAGING_20261013.md).
Referências autorizadas pela festa são enviadas pelo endpoint images/edits como
multipart; sem referências utiliza images/generations. Origem fixa api.openai.com,
redirecionamentos recusados, timeout 120 segundos. Texto e dados da festa continuam
editáveis pelo KidMais; prompt instrui o fornecedor a não incluir/inventar dados.

## Ativação pendente

O laboratório ComfyUI em 3070 continua separado e não herda as chaves do Render.
Não confundir testar esse laboratório com testar a API OpenAI.
Publicar código e alterar Environment do staging exigem autorização específica;
nenhuma alteração remota foi feita nesta tarefa. Depois da publicação autorizada,
validar acesso ao modelo e uma geração pelo editor com festa sintética.

Fontes oficiais consultadas:
- https://developers.openai.com/api/docs/guides/image-generation
- https://developers.openai.com/api/reference/resources/images/methods/generate
