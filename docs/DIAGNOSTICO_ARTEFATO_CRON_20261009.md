# Diagnóstico do artefato do cron — inspeção preparada

Alvo único: workspace `tea-daidbj95efls73d2bcf0`, cron `crn-db493i142hec73ahmoe0` de staging. O comando normal e auto-deploy OFF permanecem preservados. Última execução normal consultada: 10/10/2026 02:00:43 UTC, bem-sucedida. Nenhum deploy ou alteração operacional realizado nesta investigação.

## Evidência disponível

- Build anterior registra checkout de `27e072237442e2f249e1e93d85a74e62b6eb7695` e Node 22.23.2, sucesso às 00:50:05 e deploy LIVE às 00:50:06 UTC.
- Execução registra início às 00:50:09 e erro MODULE_NOT_FOUND às 00:50:25, conforme [relatório anterior](evidencias/aviso-email-staging-resultado-20261009.json). Não há evidência suficiente para atribuir a causa à revisão antiga ou ao cache.
- git ls-tree confirma o arquivo no commit. Não há .renderignore ou .gitattributes nesse commit; .gitignore não exclui o script. package.json não tem etapa postinstall que o remova.
- O painel Runs identifica a última candidata publicada como `27e0722`; os links de execuções levam aos logs e não fornecem comprovação dos arquivos do container que falhou.

## Operação proposta para aprovação

Abrir **uma sessão Shell temporária** do cron pelo Dashboard, no plano atual, por até cinco minutos. A [documentação oficial Render](https://render.com/docs/ssh#cron-job-connections) informa que o Shell do cron cria uma instância temporária com o último build/configuração, sem executar automaticamente o comando do cron; ao fechar a sessão, o Render remove a instância. A conexão temporária pode ter cobrança por duração, conforme o plano existente. Não criar um serviço, mudar plano, enviar e-mail, executar cron, conectar SQL, ler env/secrets ou disparar deploy.

Executar somente o comando de leitura abaixo. Ele verifica o serviço e ambiente, mostra apenas a revisão pública (se válida), Node/cwd e presença/digest de três arquivos de código. Digests git são calculados diretamente dos bytes do artefato, sem imprimir o conteúdo. As referências esperadas vêm do commit publicado.

```sh
node -e 'const fs=require("node:fs"),crypto=require("node:crypto");if(process.env.RENDER_SERVICE_ID!=="crn-db493i142hec73ahmoe0"||process.env.KIDMAIS_DEPLOY_ENV!=="staging")throw Error("ALVO_RECUSADO");const base="/opt/render/project/src/",refs={"scripts/assinatura-aviso-email-staging.cjs":"efdde0e6a5abbe1cc473612d8164d9788c2fb875","scripts/assinatura-cron.cjs":"e2a8df05c2c95dde1d3ab17cf51f8f8f2021ef79","lib/assinatura/renovacao-fundador.ts":"c36c304dc3c67a458a3b54bc6f9cc861ed747c38"};const arquivos=Object.entries(refs).map(([arquivo,esperado])=>{try{const b=fs.readFileSync(base+arquivo),blob=crypto.createHash("sha1").update("blob "+b.length+"\0").update(b).digest("hex");return{arquivo,presente:true,blob,igualCandidata:blob===esperado};}catch{return{arquivo,presente:false};}});const c=process.env.RENDER_GIT_COMMIT;console.log(JSON.stringify({servico:"crn-db493i142hec73ahmoe0",ambiente:"staging",node:process.version,cwd:process.cwd(),revisaoInformada:/^[a-f0-9]{40}$/.test(c||"")?c:"NAO_DISPONIVEL",arquivos,bancoConsultado:false,provedoresChamados:false}));'
```

Guardar somente a saída sanitizada e captura do diagnóstico; sair com `exit`, fechar a sessão e verificar seu encerramento. Não executar comandos sugeridos pelo terminal, imprimir todas as variáveis, abrir .env ou realizar chamadas de rede por conveniência. Se a sessão não ficar disponível dentro do limite, encerrá-la e registrar a limitação.

Esta inspeção comprova o artefato **atual**, não recupera a instância histórica das 00:50. Se o script estiver presente e igual à candidata, registrar isso sem afirmar causa retroativa. Se faltar/divergir, usar os digests para preparar correção. Em qualquer resultado, não repetir o envio ou deploy nesta autorização; preparar uma operação própria, com verificação do artefato antes da janela de envio.

## Limite de autorização

A aprovação anterior para dois deploys/envio foi consumida e recuperada. A política [OPERACAO_AGENTES.md](OPERACAO_AGENTES.md) exige aprovação explícita para “restart ou infraestrutura de staging”. A abertura do Shell de cron provisiona uma instância temporária; por esse efeito operacional e possível cobrança, solicitar aprovação para esta sessão delimitada. A skill render-debug orienta diagnóstico por evidências, mas não concede autorização para provisionamento, SQL ou novo deploy.

## Inspeção autorizada e concluída

Felipe respondeu “Pode.” à sessão delimitada. Identidade e comando normal foram revalidados. A sessão foi aberta após a conferência das 02:04:32 UTC e fechada antes das 02:05:51 UTC (09/10, 23:04–23:05 em São Paulo), dentro de cinco minutos. Foi executado somente o comando de leitura proposto e `exit`; depois a página foi fechada e a listagem confirmou nenhuma aba restante. O terminal após exit apresentou novamente um prompt; por isso a captura anterior ao fechamento não comprova desconexão por si só. A página foi efetivamente fechada para encerrar a conexão; não foi consultado status de desprovisionamento pela API.

Resultado: Node v22.23.2, cwd `/opt/render/project/src`, revisão informada `27e072237442e2f249e1e93d85a74e62b6eb7695`. Os três arquivos estão presentes e seus blobs git correspondem exatamente à candidata:

| Arquivo | Blob | Confere |
| --- | --- | --- |
| scripts/assinatura-aviso-email-staging.cjs | efdde0e6a5abbe1cc473612d8164d9788c2fb875 | Sim |
| scripts/assinatura-cron.cjs | e2a8df05c2c95dde1d3ab17cf51f8f8f2021ef79 | Sim |
| lib/assinatura/renovacao-fundador.ts | c36c304dc3c67a458a3b54bc6f9cc861ed747c38 | Sim |

Nenhum provedor chamado, e-mail enviado ou conexão SQL criada. Não houve deploy, alteração de env/comando/schedule/plano ou acesso a produção. O cron normal teve nova execução bem-sucedida às 02:05:13 UTC, confirmada por metadados, preservando staging/auto-deploy OFF.

O bloqueio de arquivo ausente **não se reproduz no artefato atual**. A causa da falha histórica permanece não confirmada; não alterar o código nem limpar cache sem evidência adicional. Uma nova tentativa poderá conferir os hashes imediatamente antes do envio no mesmo Shell temporário, evitando trocar o comando do cron durante a publicação. Isso requer nova autorização para sessão/envio; não foi realizado nesta inspeção.

- [Comprovação dos arquivos no Shell](evidencias/diagnostico-artefato-cron-resultado-20261009.png).
- [Relatório sanitizado](evidencias/diagnostico-artefato-cron-resultado-20261009.json).
- [Terminal após exit, antes de fechar a página](evidencias/diagnostico-artefato-cron-shell-encerrado-20261009.png).

Validação documental: revisão de saída/capturas/links e git diff --check. Nenhuma mudança de código; alterações preexistentes preservadas.
