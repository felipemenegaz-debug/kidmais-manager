param(
  [ValidateSet('Fixture','Full','Probe','R1Rollback','R1Commit','R1SqlError','Fault','Negative')][string]$Scenario,
  [ValidateSet('A','B')][string]$Build = 'A',
  [ValidateSet('before-truncate','after-locks','after-truncate','postcheck','sql-error','timeout','concurrency','publication')][string]$FaultCase,
  [ValidateSet('table','column','catalog','external-fk','fingerprint','sequence-drift')][string]$NegativeCase
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$reference = Join-Path $repo 'scripts\sanitize-v1-post-019.reference.ps1'
$fixture = Join-Path $repo 'scripts\sanitize-v1-post-019\fixture.sql'
$leaf = "kidmais-b5b2b-derived-$($Build.ToLowerInvariant())-$($Scenario.ToLowerInvariant()).ps1"
$derived = Join-Path $env:TEMP $leaf

if (-not (Test-Path -LiteralPath $reference -PathType Leaf) -or
    -not (Test-Path -LiteralPath $fixture -PathType Leaf)) { throw 'INTEGRATION_INPUT_MISSING' }
if (Test-Path -LiteralPath $derived) { throw 'FRESH_DERIVED_EXECUTOR_REQUIRED' }

$repoLiteral = $repo.Replace("'", "''")
$injection = @'
  $sequenceMetaSql = @"
SELECT json_agg(json_build_object('name',c.relname,'owner',pg_get_userbyid(c.relowner),
 'owner_table',r.relname,'owner_column',a.attname,'dependency',d.deptype,
 'start',s.seqstart,'increment',s.seqincrement,'minimum',s.seqmin,'maximum',s.seqmax,
 'cache',s.seqcache,'cycle',s.seqcycle) ORDER BY c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
JOIN pg_sequence s ON s.seqrelid=c.oid
LEFT JOIN pg_depend d ON d.classid='pg_class'::regclass AND d.objid=c.oid
 AND d.refclassid='pg_class'::regclass AND d.deptype IN ('a','i')
LEFT JOIN pg_class r ON r.oid=d.refobjid
LEFT JOIN pg_attribute a ON a.attrelid=r.oid AND a.attnum=d.refobjsubid
WHERE n.nspname='public' AND c.relname IN
 ('festa_contagens_convidados_sequencia_seq','festa_eventos_sequencia_seq');
"@
  $sequenceMeta = Invoke-Json postgres $sequenceMetaSql
  if (@($sequenceMeta).Count -ne 2) { throw 'SEQUENCE_INVENTORY_MISMATCH' }
  $sequenceBefore = Invoke-Json postgres "SELECT json_build_object('contagens',(SELECT json_build_object('value',last_value,'called',is_called) FROM public.festa_contagens_convidados_sequencia_seq),'eventos',(SELECT json_build_object('value',last_value,'called',is_called) FROM public.festa_eventos_sequencia_seq));"
  Write-Output ('SEQUENCE_METADATA_SAFE=' + ($sequenceMeta | ConvertTo-Json -Depth 5 -Compress))
  Write-Output ('SEQUENCE_INITIAL_SAFE=' + ($sequenceBefore | ConvertTo-Json -Compress))
  $fixturePath = Join-Path $repo 'scripts\sanitize-v1-post-019\fixture.sql'
  $fixtureError = Join-Path $root 'fixture-error.log'
  $previousNativePreference = $PSNativeCommandUseErrorActionPreference
  $PSNativeCommandUseErrorActionPreference = $false
  try {
    & $psql -X -w -v ON_ERROR_STOP=1 -v VERBOSITY=sqlstate -h $hostName -p $port -U postgres -d $database -f $fixturePath *> $null 2> $fixtureError
    $fixtureExit = $LASTEXITCODE
  } finally { $PSNativeCommandUseErrorActionPreference = $previousNativePreference }
  if ($fixtureExit -ne 0) {
    $fixtureDiagnostic = [IO.File]::ReadAllText($fixtureError)
    $safeState = ([regex]::Match($fixtureDiagnostic,'(?<![A-Z0-9])[0-9][A-Z0-9]{4}(?![A-Z0-9])')).Value
    $safeLine = ([regex]::Match($fixtureDiagnostic,'fixture\.sql:([0-9]+)')).Groups[1].Value
    if (-not $safeState) { $safeState = 'UNKNOWN' }
    if (-not $safeLine) { $safeLine = 'UNKNOWN' }
    throw "FIXTURE_LOAD_FAILED_${safeState}_LINE_$safeLine"
  }
  $sequenceAfterFixture = Invoke-Json postgres "SELECT json_build_object('contagens',(SELECT json_build_object('value',last_value,'called',is_called) FROM public.festa_contagens_convidados_sequencia_seq),'eventos',(SELECT json_build_object('value',last_value,'called',is_called) FROM public.festa_eventos_sequencia_seq));"
  Write-Output ('SEQUENCE_AFTER_FIXTURE_SAFE=' + ($sequenceAfterFixture | ConvertTo-Json -Compress))
  $fixtureStructure = Invoke-Json postgres $structureSql
  $fixtureComponentDrift = @($structure.component_sha256.psobject.Properties.Name | Where-Object {
    [string]$structure.component_sha256.$_ -cne [string]$fixtureStructure.component_sha256.$_
  } | Sort-Object)
  if ($fixtureStructure.sha256 -cne $structure.sha256) {
    throw ('FIXTURE_STRUCTURE_DRIFT_' + ($fixtureComponentDrift -join '_'))
  }
  $fixtureSanitizerStructure = Invoke-Json $sanitizer $structureSql
  $fixtureSanitizerHazards = Invoke-Json $sanitizer $hazardSql
  $fixtureInventory = Invoke-Json $sanitizer $inventorySql
  if (($fixtureInventory | ConvertTo-Json -Depth 100 -Compress) -cne ($inventory | ConvertTo-Json -Depth 100 -Compress) -or
      $fixtureSanitizerStructure.sha256 -cne $structure.sha256 -or [int]$fixtureSanitizerHazards.hazards -ne 0) {
    throw 'FIXTURE_SANITIZER_VIEW_MISMATCH'
  }
  $repeatOutput = & $psql -X -w -A -t -v ON_ERROR_STOP=1 -h $hostName -p $port -U $sanitizer -d $database -c "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY; $structureSql ROLLBACK;"
  if ($LASTEXITCODE -ne 0) { throw 'REPEATABLE_STRUCTURE_QUERY_FAILED' }
  $repeatStructure = ($repeatOutput | Where-Object { $_ -like '{*' } | Select-Object -First 1) | ConvertFrom-Json
  if ($repeatStructure.sha256 -cne $structure.sha256) {
    $repeatDrift = @($structure.component_sha256.psobject.Properties.Name | Where-Object {
      [string]$structure.component_sha256.$_ -cne [string]$repeatStructure.component_sha256.$_
    } | Sort-Object)
    throw ('REPEATABLE_STRUCTURE_DRIFT_' + ($repeatDrift -join '_'))
  }
  $coverage = Invoke-Json postgres @"
SELECT json_build_object(
 'crm',(SELECT count(*) FROM clientes),
 'aniversariantes',(SELECT count(*) FROM aniversariantes),
 'responsaveis',(SELECT count(*) FROM responsaveis_adicionais),
 'usuarios',(SELECT count(*) FROM usuarios_administrativos),
 'sessoes',(SELECT count(*) FROM sessoes_administrativas),
 'otp',(SELECT count(*) FROM validacoes_identidade_cliente),
 'fechamentos',(SELECT count(*) FROM fechamentos),
 'contratos',(SELECT count(*) FROM contratos),
 'versoes',(SELECT count(*) FROM contrato_versoes),
 'edicoes',(SELECT count(*) FROM contrato_edicoes),
 'assinaturas',(SELECT count(*) FROM contrato_assinaturas),
 'documentos',(SELECT count(*) FROM contrato_documentos),
 'documentos_binarios',(SELECT count(*) FROM contrato_documentos WHERE octet_length(conteudo_pdf)>0),
 'festas',(SELECT count(*) FROM festas),
 'buffet_festa',(SELECT count(*) FROM festa_buffet),
 'contagens_festa',(SELECT count(*) FROM festa_contagens_convidados),
 'eventos',(SELECT count(*) FROM festa_eventos)+(SELECT count(*) FROM eventos_historico_cliente)+(SELECT count(*) FROM auditoria),
 'pagamentos',(SELECT count(*) FROM pagamentos),
 'planos',(SELECT count(*) FROM pagamento_planos),
 'parcelas',(SELECT count(*) FROM pagamento_parcelas),
 'recebimentos',(SELECT count(*) FROM pagamento_recebimentos),
 'alocacoes',(SELECT count(*) FROM pagamento_recebimento_alocacoes),
 'gestoes_015',(SELECT count(*) FROM pagamento_gestoes),
 'tratamentos_015',(SELECT count(*) FROM pagamento_tratamentos),
 'eventos_015',(SELECT count(*) FROM pagamento_eventos),
 'ajustes_015',(SELECT count(*) FROM pagamento_ajustes_contratuais),
 'bases_015',(SELECT count(*) FROM pagamento_ajuste_bases),
 'movimentos_015',(SELECT count(*) FROM pagamento_movimentos_contextos),
 'cronogramas_015',(SELECT count(*) FROM pagamento_cronogramas),
 'itens_015',(SELECT count(*) FROM pagamento_cronograma_itens),
 'reservas_015',(SELECT count(*) FROM pagamento_credito_reservas),
 'devolucoes_015',(SELECT count(*) FROM pagamento_devolucoes),
 'alocacoes_devolucao_015',(SELECT count(*) FROM pagamento_devolucao_alocacoes),
 'comprovantes_devolucao_015',(SELECT count(*) FROM pagamento_devolucao_comprovantes),
 'comprovantes',(SELECT count(*) FROM pagamento_comprovantes),
 'whatsapp',(SELECT count(*) FROM whatsapp_conexoes)+(SELECT count(*) FROM whatsapp_onboarding_tentativas));
"@
  if (@($coverage.psobject.Properties | Where-Object { [int]$_.Value -lt 1 }).Count -ne 0) { throw 'FIXTURE_COVERAGE_FAILED' }
  Write-Output ('FIXTURE_SAFE=' + ($coverage | ConvertTo-Json -Compress))
'@

if ($Scenario -eq 'Full') {
  $injection += "`n" + @'
  $countsSql = & node -e "const t=require('./scripts/sanitize-v1-post-019/transaction.cjs'),p=require('./scripts/sanitize-v1-post-019/policy.json');process.stdout.write(t.countsSQL(p))"
  if ($LASTEXITCODE -ne 0) { throw 'COUNTS_QUERY_LOAD_FAILED' }
  $countsBeforeDry = Invoke-Json postgres $countsSql
  $catalogBeforeDry = Invoke-Json postgres $catalogSql
  $structureBeforeDry = Invoke-Json postgres $structureSql
  $argsBase = @('scripts/sanitize-v1-post-019.cjs','--host','127.0.0.1','--port','55429','--database','kidmais_sanitize_v1_post019_b5b','--user','kidmais_b5b_sanitizer')
  $previousNodePreference = $PSNativeCommandUseErrorActionPreference
  $PSNativeCommandUseErrorActionPreference = $false
  try { $dryOutput = @(& node $argsBase '--dry-run' 2>&1); $dryExit = $LASTEXITCODE }
  finally { $PSNativeCommandUseErrorActionPreference = $previousNodePreference }
  if ($dryExit -ne 0) {
    $dryJoined = (($dryOutput | ForEach-Object { $_.ToString() }) -join "`n")
    $drySafe = ([regex]::Matches($dryJoined,'(?m)^[A-Z_]{3,64}$') | Select-Object -Last 1).Value
    if (-not $drySafe) {
      foreach ($candidate in $dryOutput) {
        try { $failureJson = $candidate.ToString() | ConvertFrom-Json -ErrorAction Stop; if ($failureJson.code) { $drySafe = [string]$failureJson.code; break } } catch { }
      }
    }
    if (-not $drySafe) { $drySafe = 'UNKNOWN' }
    throw "DRY_RUN_FAILED_$drySafe"
  }
  $dryText = ($dryOutput -join "`n")
  $dry = $dryText | ConvertFrom-Json
  $sequenceAfterDry = Invoke-Json postgres "SELECT json_build_object('contagens',(SELECT json_build_object('value',last_value,'called',is_called) FROM public.festa_contagens_convidados_sequencia_seq),'eventos',(SELECT json_build_object('value',last_value,'called',is_called) FROM public.festa_eventos_sequencia_seq));"
  $countsAfterDry = Invoke-Json postgres $countsSql
  $catalogAfterDry = Invoke-Json postgres $catalogSql
  $structureAfterDry = Invoke-Json postgres $structureSql
  if ($dry.result -cne 'PLAN' -or -not $dry.rollback_confirmed -or $dry.commit_confirmed -or $dry.plan_digest -notmatch '^[a-f0-9]{64}$' -or
      ($sequenceAfterDry | ConvertTo-Json -Compress) -cne ($sequenceAfterFixture | ConvertTo-Json -Compress) -or
      ($countsAfterDry | ConvertTo-Json -Compress) -cne ($countsBeforeDry | ConvertTo-Json -Compress) -or
      ($catalogAfterDry | ConvertTo-Json -Depth 100 -Compress) -cne ($catalogBeforeDry | ConvertTo-Json -Depth 100 -Compress) -or
      $structureAfterDry.sha256 -cne $structureBeforeDry.sha256) { throw 'DRY_RUN_INVALID' }
  Write-Output ('DRY_RUN_SAFE=' + ([ordered]@{result=$dry.result;plan_digest=$dry.plan_digest;
    rollback_confirmed=$dry.rollback_confirmed;commit_confirmed=$dry.commit_confirmed} | ConvertTo-Json -Compress))
  $PSNativeCommandUseErrorActionPreference = $false
  try { $applyOutput = @(& node $argsBase '--apply' '--authorize-target' '127.0.0.1:55429/kidmais_sanitize_v1_post019_b5b' '--plan-digest' $dry.plan_digest 2>&1); $applyExit = $LASTEXITCODE }
  finally { $PSNativeCommandUseErrorActionPreference = $previousNodePreference }
  if ($applyExit -ne 0) {
    $applySafe = $null
    $applyJoined = (($applyOutput | ForEach-Object { $_.ToString() }) -join "`n")
    $applyStage = ([regex]::Match($applyJoined,'FAIL_STAGE_[A-Z_]+')).Value
    $applySqlState = ([regex]::Match($applyJoined,'FAIL_SQLSTATE_[0-9][A-Z0-9]{4}')).Value
    foreach ($candidate in $applyOutput) {
      try { $failureJson = $candidate.ToString() | ConvertFrom-Json -ErrorAction Stop; if ($failureJson.code) { $applySafe = [string]$failureJson.code; break } } catch { }
    }
    if (-not $applySafe) { $applySafe = 'UNKNOWN' }
    if (-not $applyStage) { $applyStage = 'FAIL_STAGE_UNKNOWN' }
    if (-not $applySqlState) { $applySqlState = 'FAIL_SQLSTATE_UNKNOWN' }
    throw "APPLY_FAILED_${applySafe}_${applyStage}_$applySqlState"
  }
  $applyText = ($applyOutput -join "`n")
  $apply = $applyText | ConvertFrom-Json
  $sequenceAfterApply = Invoke-Json postgres "SELECT json_build_object('contagens',(SELECT json_build_object('value',last_value,'called',is_called) FROM public.festa_contagens_convidados_sequencia_seq),'eventos',(SELECT json_build_object('value',last_value,'called',is_called) FROM public.festa_eventos_sequencia_seq));"
  if ($apply.result -cne 'PASS' -or -not $apply.commit_confirmed -or $apply.rollback_confirmed -or
      $apply.sequences_preserved -ne $true -or $apply.identities_restarted -ne $false -or
      ($sequenceAfterApply | ConvertTo-Json -Compress) -cne ($sequenceAfterFixture | ConvertTo-Json -Compress)) { throw 'APPLY_INVALID' }
  $PSNativeCommandUseErrorActionPreference = $false
  try { $verifyOutput = @(& node $argsBase '--verify' 2>&1); $verifyExit = $LASTEXITCODE }
  finally { $PSNativeCommandUseErrorActionPreference = $previousNodePreference }
  if ($verifyExit -ne 0) { throw 'VERIFY_FAILED' }
  $verifyText = ($verifyOutput -join "`n")
  $verify = $verifyText | ConvertFrom-Json
  $postCatalog = Invoke-Json postgres $catalogSql
  $postStructure = Invoke-Json postgres $structureSql
  if ($verify.result -cne 'PASS' -or -not $verify.rollback_confirmed -or $verify.commit_confirmed -or
      $verify.operational_rows_after -ne 0 -or $verify.sequences_preserved -ne $false -or
      ($postCatalog | ConvertTo-Json -Depth 100 -Compress) -cne ($catalogActual | ConvertTo-Json -Depth 100 -Compress) -or
      $postStructure.sha256 -cne $structure.sha256) { throw 'VERIFY_INVALID' }
  # O JSON emitido pelo apply é provisório até o verify independente; publicar
  # o atestado desta bateria só depois de nova validação do schema versionado.
  $finalAttestation = $apply | ConvertTo-Json -Depth 8 -Compress
  $finalAttestation | & node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{try{require('./scripts/sanitize-v1-post-019/attestation.cjs').validateAttestation(JSON.parse(s))}catch{process.stderr.write('ATTESTATION_INVALID');process.exitCode=1}})"
  if ($LASTEXITCODE -ne 0) { throw 'FINAL_ATTESTATION_INVALID' }
  Write-Output ('ATTESTATION_SAFE=' + $finalAttestation)
  Write-Output ('INTEGRATION_SAFE=' + ([ordered]@{
    dry_run=$dry.result; plan_digest=$dry.plan_digest; apply=$apply.result;
    commit_confirmed=$apply.commit_confirmed; verify=$verify.result;
    operational_rows_after=$verify.operational_rows_after;
    sequences_preserved=$true;identities_restarted=$false;
    structure_sha256=$schema.physical_projection.sha256
  } | ConvertTo-Json -Compress))
'@
}

if ($Scenario -eq 'Fault') {
  if (-not $FaultCase) { throw 'FAULT_CASE_REQUIRED' }
  $injection += "`n" + @'
  $faultCase = '__FAULT_CASE__'
  $countsSql = & node -e "const t=require('./scripts/sanitize-v1-post-019/transaction.cjs'),p=require('./scripts/sanitize-v1-post-019/policy.json');process.stdout.write(t.countsSQL(p))"
  if ($LASTEXITCODE -ne 0) { throw 'COUNTS_QUERY_LOAD_FAILED' }
  $countsBeforeFault = Invoke-Json postgres $countsSql
  $faultOutput = & node 'scripts/sanitize-v1-post-019.faults.cjs' $faultCase
  if ($LASTEXITCODE -ne 0 -or @($faultOutput).Count -ne 1) { throw 'FAULT_PROBE_FAILED' }
  $fault = ($faultOutput | Select-Object -First 1) | ConvertFrom-Json
  $afterFault = Invoke-Json postgres "SELECT json_build_object('contagens',(SELECT json_build_object('value',last_value,'called',is_called) FROM public.festa_contagens_convidados_sequencia_seq),'eventos',(SELECT json_build_object('value',last_value,'called',is_called) FROM public.festa_eventos_sequencia_seq),'rows',(SELECT count(*) FROM public.limites_autenticacao));"
  $countsAfterFault = Invoke-Json postgres $countsSql
  if (($afterFault.contagens | ConvertTo-Json -Compress) -cne ($sequenceAfterFixture.contagens | ConvertTo-Json -Compress) -or
      ($afterFault.eventos | ConvertTo-Json -Compress) -cne ($sequenceAfterFixture.eventos | ConvertTo-Json -Compress)) { throw 'FAULT_SEQUENCE_DRIFT' }
  if ($faultCase -eq 'publication') {
    if ([int]$afterFault.rows -ne 0 -or $fault.publication -cne 'COMMIT_CONFIRMED_ATTESTATION_FAILED') { throw 'FAULT_PUBLICATION_STATE_FAILED' }
  } elseif ([int]$afterFault.rows -ne 1 -or $fault.transaction_outcome -cne 'ROLLED_BACK' -or
      ($countsAfterFault | ConvertTo-Json -Compress) -cne ($countsBeforeFault | ConvertTo-Json -Compress)) { throw 'FAULT_ROLLBACK_STATE_FAILED' }
  $afterStructure = Invoke-Json postgres $structureSql
  if ($afterStructure.sha256 -cne $structure.sha256) { throw 'FAULT_STRUCTURE_DRIFT' }
  Write-Output ('FAULT_SAFE=' + ($fault | ConvertTo-Json -Compress))
'@
  $injection = $injection.Replace('__FAULT_CASE__',$FaultCase)
}

if ($Scenario -eq 'Negative') {
  if (-not $NegativeCase) { throw 'NEGATIVE_CASE_REQUIRED' }
  $injection += "`n" + @'
  $negativeCase = '__NEGATIVE_CASE__'
  $argsBase = @('scripts/sanitize-v1-post-019.cjs','--host','127.0.0.1','--port','55429','--database','kidmais_sanitize_v1_post019_b5b','--user','kidmais_b5b_sanitizer')
  $oldDigest = $null
  if ($negativeCase -eq 'sequence-drift') {
    $oldPlanText = (& node $argsBase '--dry-run') -join "`n"
    if ($LASTEXITCODE -ne 0) { throw 'NEGATIVE_INITIAL_PLAN_FAILED' }
    $oldPlan = $oldPlanText | ConvertFrom-Json
    if ($oldPlan.result -cne 'PLAN') { throw 'NEGATIVE_INITIAL_PLAN_INVALID' }
    $oldDigest = $oldPlan.plan_digest
    Invoke-Psql postgres "SELECT nextval('public.festa_eventos_sequencia_seq');" $null *> $null
  } else {
    switch ($negativeCase) {
      'table' { Invoke-Psql postgres 'CREATE TABLE public.b5b_unexpected(id integer);' $null *> $null }
      'column' { Invoke-Psql postgres 'ALTER TABLE public.clientes ADD COLUMN b5b_unexpected integer;' $null *> $null }
      'catalog' { Invoke-Psql postgres "UPDATE public.pacotes SET nome=nome||' ALTERADO' WHERE codigo='POCKET';" $null *> $null }
      'external-fk' { Invoke-Psql postgres 'ALTER TABLE public.pacotes ADD CONSTRAINT b5b_external_fk FOREIGN KEY(id) REFERENCES public.clientes(id) NOT VALID;' $null *> $null }
      'fingerprint' { Invoke-Psql postgres "COMMENT ON TABLE public.clientes IS 'B5B DRIFT SINTETICO';" $null *> $null }
    }
  }
  $previousNodePreference = $PSNativeCommandUseErrorActionPreference
  $PSNativeCommandUseErrorActionPreference = $false
  try {
    if ($negativeCase -eq 'sequence-drift') {
      $negativeOutput = @(& node $argsBase '--apply' '--authorize-target' '127.0.0.1:55429/kidmais_sanitize_v1_post019_b5b' '--plan-digest' $oldDigest 2>&1)
    } else { $negativeOutput = @(& node $argsBase '--dry-run' 2>&1) }
    $negativeExit = $LASTEXITCODE
  } finally { $PSNativeCommandUseErrorActionPreference = $previousNodePreference }
  if ($negativeExit -eq 0) { throw 'NEGATIVE_ACCEPTED_UNEXPECTEDLY' }
  $attestedFailure = $null
  foreach ($line in $negativeOutput) {
    try { $parsed = $line.ToString() | ConvertFrom-Json -ErrorAction Stop; if ($parsed.result -eq 'FAIL') { $attestedFailure = $parsed; break } } catch { }
  }
  if ($negativeCase -eq 'sequence-drift') {
    if ($attestedFailure.code -cne 'DIGEST_MISMATCH' -or $attestedFailure.transaction_outcome -cne 'ROLLED_BACK') { throw 'NEGATIVE_SEQUENCE_NOT_REFUSED' }
  } elseif (-not $attestedFailure -or $attestedFailure.result -cne 'FAIL' -or $attestedFailure.commit_confirmed) { throw 'NEGATIVE_NOT_REFUSED' }
  Write-Output ('NEGATIVE_SAFE=' + ([ordered]@{case=$negativeCase;result=$attestedFailure.result;
    code=$attestedFailure.code;commit_confirmed=$attestedFailure.commit_confirmed} | ConvertTo-Json -Compress))
'@
  $injection = $injection.Replace('__NEGATIVE_CASE__',$NegativeCase)
}

if ($Scenario -in @('R1Rollback','R1Commit','R1SqlError')) {
  $r1Mode = if ($Scenario -eq 'R1Rollback') { 'rollback' } elseif ($Scenario -eq 'R1SqlError') { 'sql-error' } else { 'commit' }
  $injection = @'
  $r1Mode = '__R1_MODE__'
  $fixturePath = Join-Path $repo 'scripts\sanitize-v1-post-019\fixture-sequences-r1.sql'
  $fixtureOutput = & $psql -X -w -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=sqlstate -h $hostName -p $port -U postgres -d $database -f $fixturePath
  if ($LASTEXITCODE -ne 0) { throw 'R1_FIXTURE_FAILED' }
  $stateSql = "SELECT json_build_object('contagens',(SELECT json_build_object('value',last_value,'called',is_called) FROM public.festa_contagens_convidados_sequencia_seq),'eventos',(SELECT json_build_object('value',last_value,'called',is_called) FROM public.festa_eventos_sequencia_seq),'rows',(SELECT count(*) FROM public.limites_autenticacao));"
  $before = Invoke-Json postgres $stateSql
  if ([int]$before.rows -ne 1 -or $before.contagens.called -ne $true -or $before.eventos.called -ne $true) { throw 'R1_FIXTURE_STATE_FAILED' }
  $probeOutput = & node 'scripts/sanitize-v1-post-019.r1.cjs' $r1Mode
  if ($LASTEXITCODE -ne 0 -or @($probeOutput).Count -ne 1) { throw 'R1_PROBE_FAILED' }
  $probe = ($probeOutput | Select-Object -First 1) | ConvertFrom-Json
  $after = Invoke-Json postgres $stateSql
  if (($before.contagens | ConvertTo-Json -Compress) -cne ($after.contagens | ConvertTo-Json -Compress) -or
      ($before.eventos | ConvertTo-Json -Compress) -cne ($after.eventos | ConvertTo-Json -Compress)) { throw 'R1_SEQUENCE_STATE_CHANGED' }
  if ($r1Mode -ne 'commit' -and ([int]$after.rows -ne 1 -or $probe.transaction_outcome -cne 'ROLLED_BACK' -or $probe.rollback_confirmed -ne $true)) { throw 'R1_ROLLBACK_FAILED' }
  if ($r1Mode -eq 'commit' -and ([int]$after.rows -ne 0 -or $probe.transaction_outcome -cne 'COMMITTED' -or $probe.verify -cne 'PASS')) { throw 'R1_COMMIT_FAILED' }
  $postStructure = Invoke-Json postgres $structureSql
  if ($postStructure.sha256 -cne $structure.sha256) { throw 'R1_STRUCTURE_DRIFT' }
  Write-Output ('R1_SAFE=' + ([ordered]@{mode=$r1Mode;dry_run=$probe.dry_run;apply=$probe.apply;
    transaction_outcome=$probe.transaction_outcome;rollback_confirmed=$probe.rollback_confirmed;
    commit_confirmed=$probe.commit_confirmed;verify=$probe.verify;rows_before=$before.rows;
    rows_after=$after.rows;sequences_preserved=$true;structure_sha256=$postStructure.sha256} | ConvertTo-Json -Compress))
'@
  $injection = $injection.Replace('__R1_MODE__',$r1Mode)
}

$source = [IO.File]::ReadAllText($reference,[Text.UTF8Encoding]::new($false))
$source = [regex]::Replace($source,'(?m)^\$repo = .+$',"`$repo = '$repoLiteral'",1)
$scenarioLeaf = "kidmais-sanitize-reference-post019-b5b-$($Build.ToLowerInvariant())-integration"
$source = [regex]::Replace($source,'(?m)^\$leaf = .+$',"`$leaf = '$scenarioLeaf'",1)
$marker = '  $summary = Invoke-Json postgres '
$index = $source.IndexOf($marker,[StringComparison]::Ordinal)
if ($index -lt 0) { throw 'REFERENCE_INJECTION_POINT_MISSING' }
$source = $source.Insert($index,$injection + "`n")
[IO.File]::WriteAllText($derived,$source,[Text.UTF8Encoding]::new($false))
try {
  $referenceMode = if ($Scenario -eq 'Probe') { 'Derive' } else { 'Verify' }
  & $derived -Build $Build -Mode $referenceMode
  if ($LASTEXITCODE -ne 0) { throw "INTEGRATION_NATIVE_FAILED_$LASTEXITCODE" }
} finally {
  $resolvedTemp = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')
  $resolvedDerived = [IO.Path]::GetFullPath($derived)
  if (-not $resolvedDerived.StartsWith($resolvedTemp + '\',[StringComparison]::OrdinalIgnoreCase) -or
      [IO.Path]::GetFileName($resolvedDerived) -cne $leaf) { throw 'DERIVED_CLEANUP_REFUSED' }
  if (Test-Path -LiteralPath $resolvedDerived) { Remove-Item -LiteralPath $resolvedDerived -Force }
}
