# Quinta rodada — preparada; aguarda autorização de Felipe

Objetivo: fechar a comprovação de preservação comercial que ficou inconclusiva na rodada 4. A evidência original permanece INCOMPLETO; não reutilizar seus IDs. O verificador corrigido conserva comparação integral e separa apenas três metadados operacionais, mantendo protegidas todas as condições de acesso/cobrança.

Alvos exclusivos: web staging `srv-daif418ae00c73e8k2gg`, cron staging `crn-db493i142hec73ahmoe0`, banco `kidmais_staging_1z91` no host interno `dpg-daidko3m8hqs73ce4jt0-a:5432` e Asaas sandbox já configurado. Sem migrations, novas credenciais, produção ou banco local real.

1. Revalidar branch/auto-deploy e alvos; publicar a candidata com o verificador corrigido. Habilitar temporariamente somente `ASSINATURA_PLANOS_ATIVOS=true` no web, com deploy manual. Cron temporário `node --experimental-strip-types scripts/assinatura-staging-preflight.cjs --rodada-5`, com deploy.
2. Criar somente empresa sintética `cbfbdb83-09d8-46d9-a1d4-9aeb6dc2b9dd`, usuário `cc401acf-f43c-4f86-b22e-7440ee394acd`, email `assinatura-staging-cc401acf@example.invalid`, documento fictício, vínculo e contratação associados. Recusar IDs/registro já usados. Diretório privado `data/ensaio-assinatura-20261009-5`, umask 077; senha só em memória, log sanitizado.
3. Executar uma vez `node --experimental-strip-types scripts/assinatura-staging-ensaio.cjs --rodada-5-autorizada` por `nohup`, entrada fechada e PID registrado. Não reiniciar/redeployar o web durante o processo. Capturar digests integrais e comerciais das outras empresas antes da fixture; nunca imprimir linhas ou dados pessoais.
4. Checkout Essencial mensal sandbox: R$ 118,20 com Fundador ou R$ 197,00 sem benefício, teto R$ 197,00, sem dinheiro real. Após o preflight agendado encontrar a referência, restaurar o cron normal `node scripts/assinatura-cron.cjs` com deploy; somente depois liberar `cron-conferido`. Simular só o pagamento dessa fixture, conferindo cliente, assinatura, referência e valor.
5. Validar callback externo autenticado, acesso completo, contrato/Fundador únicos, uma vaga Gestão, replay e cron agendado sem duplicação. Cancelar pela aplicação mantendo o período pago. Comparar digests comerciais dos demais cadastros; registrar separadamente se metadados operacionais mudaram.
6. Recuperar mesmo em falha: cancelar somente assinatura própria após comprovar identidade; desativar empresa/usuário e revogar vínculo; preservar webhook existente; remover apenas webhook temporário próprio, se criado. Remover a flag temporária, deployar recuperação e conferir ausência no runtime, cron normal e health. Guardar evidências sanitizadas e não reclassificar a rodada 4.

Este plano não autoriza execução. A [política operacional](OPERACAO_AGENTES.md) exige aprovação explícita para env/deploy/SQL de escrita em staging. A autorização anterior cobria exclusivamente a fixture da quarta rodada. Avisos/renovação remotos, isenção real e publicação comercial continuam sendo operações separadas.

Preparação validada sem banco/provedor: 20/20 testes pertinentes aprovados, TypeScript, ESLint e build Next.js em cópia isolada sem credenciais aprovados. Os testes comprovam IDs/diretório novos, recusa de flags ambíguas/retomada e preflight restrito à referência da quinta rodada, além das garantias da comparação comercial. Execução física deste plano ainda não realizada.

## Autorização recebida e impedimento externo — 09/10/2026

Felipe respondeu “Autorizo” a este plano. A autorização da quinta rodada está vigente; a descrição anterior de espera permanece como histórico da preparação.

A publicação de `0365b77` foi bloqueada pelo Render antes do build, tanto no web (`dep-db4l0u49v7es738dsufg`) quanto no cron (`dep-db4l11s9v7es73a7s1u0`): minutos de pipeline esgotados. Nenhuma fixture, checkout ou pagamento foi iniciado; os IDs desta rodada não foram consumidos. Não repetir deploy enquanto esse impedimento persistir.

Recuperação confirmada: flag temporária removida com Save only e ausente no runtime; candidata ativa continua `850287b`; health PASS. Comando normal do cron restaurado e execução agendada às 20:40:08 UTC em APLICAR, incompleto=false, sem exigir um build novo.

O painel de builds informa gasto mensal de US$ 5 e teto atual US$ 0. Foi preparada, sem salvar, a revisão de teto mensal US$ 10 (até US$ 5 adicionais no mês atual); aprovação financeira separada solicitada. Não trocar plano, retirar limite ou assumir autorização financeira a partir do ensaio sandbox. Evidências: [registro](evidencias/assinatura-rodada5-bloqueio-build-20261009.json) e [revisão não salva](evidencias/assinatura-rodada5-limite-build-20261009.png).
