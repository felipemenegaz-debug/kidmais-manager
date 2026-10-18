# Fundo do site de venda — staging — 18/10/2026

Felipe autorizou atualizar o site de staging com a versão visual trabalhada na prévia local. Base: `87bedb844643c82f6c78ef4c052b5b6ebd8a31c3`, também LIVE antes desta atualização.

## Escopo

- Fundo contínuo com gradiente WebGL, raios discretos e até seis figuras de festa nas duas primeiras seções de `/conheca`; até três no celular, omitidas quando não há espaço livre.
- Corações transparentes ao clicar, com duração de 5,8 s e limite de três. Links e controles não disparam o efeito.
- Posicionamento evita textos e cartões; painel ilustrativo sem rotação. Conteúdo, preços, links e sinalização comercial permanecem iguais.
- Pausa explícita, preferência por movimento reduzido, suspensão fora da tela/aba e gradiente CSS quando WebGL não está disponível. Sem dependências adicionais.
- `/planos`, módulos administrativos, banco, migrations, variáveis, cron e produção fora da alteração.

## Validação local

- Site: 8/8; geometria: 3/3.
- TypeScript e ESLint nos arquivos alterados: passaram.
- Build de produção: passou, 67 páginas. Primeira tentativa no sandbox ficou sem progresso; interrompida, nova execução fora do sandbox concluiu.
- Revisão independente de código: sem bloqueadores.
- Navegador sobre build de produção local: desktop 1280 px, seis elementos; celular 390 px, dois elementos encontraram espaço. Sem rolagem horizontal ou erros de console.
- Coração observado no clique, pausa e retomada conferidas; abertura e segunda seção inspecionadas. Nenhum formulário enviado.
- Fallback WebGL e preferência de movimento reduzido revisados no código; não simulados no navegador nesta rodada. Desempenho GPU não medido.

## Publicação

Alvo único: web staging `srv-daif418ae00c73e8k2gg`, workspace `tea-daidbj95efls73d2bcf0`. Metadados confirmados: branch staging, auto-deploy OFF; produção usa production, auto-deploy OFF; cron staging também OFF para deploy automático. Sem alteração dessas configurações.

Push fast-forward e um deploy manual do web após validações. Conferir o SHA entregue pelo Render, status LIVE, health e `/conheca`. Se houver falha, investigar antes de repetir. Reversão possível ao deploy anterior `dep-dba8a2tg1s2s73b5nurg`, sem reversão de banco; rollback remoto não executado por este registro.

Resultado remoto será registrado após conclusão; este documento não declara deploy concluído.
