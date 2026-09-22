# Reprodutor de referência B5B-2A. Não sanitiza e recusa qualquer alvo alternativo.
param(
  [ValidateSet('A','B')][string]$Build,
  [ValidateSet('Derive','Verify')][string]$Mode = 'Verify'
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$pgBin = 'C:\Program Files\PostgreSQL\18\bin'
$initdb = Join-Path $pgBin 'initdb.exe'
$pgCtl = Join-Path $pgBin 'pg_ctl.exe'
$postgres = Join-Path $pgBin 'postgres.exe'
$psql = Join-Path $pgBin 'psql.exe'
$hostName = '127.0.0.1'
$port = 55429
$database = 'kidmais_sanitize_v1_post019_b5b'
$owner = 'kidmais_b5b_owner'
$sanitizer = 'kidmais_b5b_sanitizer'
$commit = '0460d0a10ed0ba1afbd2061055762cf3913bda0b'
$leaf = "kidmais-sanitize-reference-post019-b5b-$($Build.ToLowerInvariant())"
$root = Join-Path $env:TEMP $leaf
$data = Join-Path $root 'data'
$archive = Join-Path $root 'migrations.zip'
$source = Join-Path $root 'source'
$evidencePath = Join-Path $env:TEMP "kidmais-b5b2a-evidence-$Build.json"

if ($database -cne 'kidmais_sanitize_v1_post019_b5b') { throw 'TARGET_NAME_MISMATCH' }
if ($hostName -cne '127.0.0.1' -or $port -ne 55429) { throw 'TARGET_COORDINATE_MISMATCH' }
if ($database -in @('kidmais_manager','kidmais_v1_homologacao') -or $port -eq 5432) { throw 'PROTECTED_TARGET' }
foreach ($name in @('DATABASE_URL','PGPASSWORD','PGSERVICE','PGSERVICEFILE','PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGUSER','PGOPTIONS')) {
  Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
}
foreach ($exe in @($initdb,$pgCtl,$postgres,$psql)) { if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'PG18_BINARY_MISSING' } }
if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { throw 'AUTHORIZED_PORT_ALREADY_IN_USE' }
if (Test-Path -LiteralPath $root) { throw 'FRESH_CLUSTER_REQUIRED' }
New-Item -ItemType Directory -Path $root | Out-Null

function Invoke-Native([scriptblock]$Command) {
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "NATIVE_PROCESS_FAILED_$LASTEXITCODE" }
}
function Invoke-Psql([string]$Role,[string]$Sql,[string]$File) {
  $args = @('-X','-w','-v','ON_ERROR_STOP=1','-v','VERBOSITY=sqlstate','-h',$hostName,'-p',[string]$port,'-U',$Role,'-d',$database)
  if ($File) { $args += @('-f',$File) } else { $args += @('-c',$Sql) }
  $result = & $psql @args
  if ($LASTEXITCODE -ne 0) { throw "PSQL_FAILED_$Role" }
  return $result
}
function Invoke-Json([string]$Role,[string]$Sql) {
  $result = & $psql -X -w -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=sqlstate -h $hostName -p $port -U $Role -d $database -c $Sql
  if ($LASTEXITCODE -ne 0 -or $result.Count -ne 1) { throw "PSQL_JSON_FAILED_$Role" }
  return (($result | Select-Object -First 1) | ConvertFrom-Json)
}
function Get-NormalizedSha256([string]$Path) {
  $normalized = [IO.File]::ReadAllText($Path,[Text.UTF8Encoding]::new($false)).Replace("`r`n","`n").Replace("`r","`n")
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes($normalized)
  return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}
function Remove-ExactCluster {
  if (Test-Path -LiteralPath $data) {
    $stop = Start-Process -FilePath $pgCtl -ArgumentList @('-D',"`"$data`"",'-m','fast','-w','stop') -WindowStyle Hidden -PassThru
    $stop.WaitForExit()
  }
  $resolvedTemp = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')
  $resolvedRoot = [IO.Path]::GetFullPath($root).TrimEnd('\')
  if (-not $resolvedRoot.StartsWith($resolvedTemp + '\',[StringComparison]::OrdinalIgnoreCase) -or
      [IO.Path]::GetFileName($resolvedRoot) -cne $leaf) { throw 'CLEANUP_TARGET_REFUSED' }
  if (Test-Path -LiteralPath $resolvedRoot) { Remove-Item -LiteralPath $resolvedRoot -Recurse -Force }
}

$started = $false
$locationPushed = $false
try {
  Push-Location -LiteralPath $repo
  $locationPushed = $true
  git -C $repo archive --format=zip -o $archive $commit database/migrations
  if ($LASTEXITCODE -ne 0) { throw 'GIT_ARCHIVE_FAILED' }
  New-Item -ItemType Directory -Path $source | Out-Null
  Expand-Archive -LiteralPath $archive -DestinationPath $source
  $schema = Get-Content -LiteralPath (Join-Path $repo 'scripts\sanitize-v1-post-019\expected-schema.json') -Raw | ConvertFrom-Json
  if ($schema.source_commit -cne $commit -or $schema.sources.Count -ne 20) { throw 'SOURCE_MANIFEST_MISMATCH' }
  $recipePath = Join-Path $repo 'scripts\sanitize-v1-post-019\reference-bootstrap.json'
  $executorPath = Join-Path $repo 'scripts\sanitize-v1-post-019.reference.ps1'
  $recipe = Get-Content -LiteralPath $recipePath -Raw | ConvertFrom-Json
  $recipeHash = Get-NormalizedSha256 $recipePath
  $executorHash = Get-NormalizedSha256 $executorPath
  if ($recipe.target.host -cne $hostName -or [int]$recipe.target.port -ne $port -or $recipe.target.database -cne $database -or
      [int]$recipe.postgresql.exact_version_num -ne 180006 -or $recipe.reference_executor_sha256 -cne $executorHash) { throw 'REFERENCE_RECIPE_MISMATCH' }
  if ($Mode -eq 'Verify' -and ($schema.physical_projection.reference_recipe_sha256 -cne $recipeHash -or
      $schema.physical_projection.reference_executor_sha256 -cne $executorHash)) { throw 'REFERENCE_SEAL_MISMATCH' }
  $migrationEvidence = @()
  foreach ($entry in $schema.sources) {
    $path = Join-Path $source ($entry.path -replace '/','\')
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "MIGRATION_MISSING_$($entry.path)" }
    $normalized = [IO.File]::ReadAllText($path,[Text.UTF8Encoding]::new($false)).Replace("`r`n","`n").Replace("`r","`n")
    [IO.File]::WriteAllText($path,$normalized,[Text.UTF8Encoding]::new($false))
    $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
    if ($actualHash -cne $entry.sha256) { throw "MIGRATION_HASH_MISMATCH_$($entry.path)" }
    $migrationEvidence += [ordered]@{ path=$entry.path; sha256=$actualHash; result='PENDING' }
  }
  if (($migrationEvidence | Where-Object path -Like '*_019_*').sha256 -cne '121265ed0e5c89882abf27a7178f206d26f0e1dea15a773bc413fdaf68ed4d90') { throw 'MIGRATION_019_HASH_MISMATCH' }

  & $initdb -D $data -U postgres --auth-local=trust --auth-host=reject --encoding=UTF8 --locale=C --data-checksums --no-instructions *> (Join-Path $root 'initdb.log')
  if ($LASTEXITCODE -ne 0) { throw 'INITDB_FAILED' }
  $hbaPath = Join-Path $data 'pg_hba.conf'
  $hbaOriginal = [IO.File]::ReadAllText($hbaPath)
  $hbaPrefix = "host $database postgres 127.0.0.1/32 trust`nhost $database $owner 127.0.0.1/32 trust`nhost $database $sanitizer 127.0.0.1/32 trust`nhost all all 127.0.0.1/32 reject`nhost all all ::1/128 reject`n"
  [IO.File]::WriteAllText($hbaPath,$hbaPrefix+$hbaOriginal,[Text.UTF8Encoding]::new($false))
  $bootstrapPath = Join-Path $root 'bootstrap.sql'
  $bootstrap = @"
CREATE ROLE $owner LOGIN NOSUPERUSER NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE $sanitizer LOGIN NOSUPERUSER NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 1;
CREATE DATABASE $database OWNER $owner ENCODING 'UTF8' TEMPLATE template0;
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;
REVOKE CONNECT ON DATABASE template0 FROM PUBLIC;
REVOKE CONNECT ON DATABASE $database FROM PUBLIC;
REVOKE TEMPORARY ON DATABASE $database FROM PUBLIC;
GRANT CONNECT ON DATABASE $database TO $sanitizer;
ALTER ROLE $sanitizer IN DATABASE $database SET default_transaction_read_only = on;
"@
  [IO.File]::WriteAllText($bootstrapPath,$bootstrap,[Text.UTF8Encoding]::new($false))
  Get-Content -LiteralPath $bootstrapPath -Raw | & $postgres --single -D $data template1 *> (Join-Path $root 'bootstrap.log')
  if ($LASTEXITCODE -ne 0) { throw 'OFFLINE_BOOTSTRAP_FAILED' }

  [IO.File]::AppendAllText((Join-Path $data 'postgresql.conf'),"`nlisten_addresses = '$hostName'`nport = $port`nmax_connections = 10`n",[Text.UTF8Encoding]::new($false))
  $serverLog = Join-Path $root 'server.log'
  $pgctlOut = Join-Path $root 'pgctl-start-out.log'
  $pgctlError = Join-Path $root 'pgctl-start-error.log'
  $start = Start-Process -FilePath $pgCtl -ArgumentList @('-D',"`"$data`"",'-l',"`"$serverLog`"",'-w','start') -WindowStyle Hidden -RedirectStandardOutput $pgctlOut -RedirectStandardError $pgctlError -PassThru
  $start.WaitForExit()
  if ($start.ExitCode -ne 0) {
    $startupText = ((@($pgctlOut,$pgctlError,$serverLog) | Where-Object { Test-Path -LiteralPath $_ } |
      ForEach-Object { [IO.File]::ReadAllText($_) }) -join "`n").ToLowerInvariant()
    $failureClass = if ($startupText -match 'could not create restricted token') { 'WINDOWS_RESTRICTED_TOKEN' }
      elseif ($startupText -match 'address already in use|could not bind|only one usage') { 'PORT_CONFLICT' }
      elseif ($startupText -match 'permission denied|access is denied') { 'PERMISSION_DENIED' }
      elseif ($startupText -match 'could not open|no such file|does not exist') { 'MISSING_FILE' }
      elseif ($startupText -match 'database system is starting up|timed out') { 'START_TIMEOUT' }
      elseif ($startupText -match 'invalid|syntax error') { 'INVALID_CONFIG' }
      else { 'UNCLASSIFIED' }
    $listening = [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
    $safeExcerpt = ($startupText -replace '[a-z]:\\[^\r\n]*','<path>' -replace '[^a-z0-9_ <>.:-]',' ')
    if ($safeExcerpt.Length -gt 240) { $safeExcerpt = $safeExcerpt.Substring(0,240) }
    Write-Output ('STARTUP_SAFE=' + ([ordered]@{class=$failureClass;pgctl_exit=$start.ExitCode;
      port_listening=$listening;pgdata_exists=(Test-Path -LiteralPath $data);server_log_exists=(Test-Path -LiteralPath $serverLog);
      excerpt=$safeExcerpt} | ConvertTo-Json -Compress))
    throw 'PG_START_FAILED'
  }
  $started = $true

  $gate = Invoke-Json $owner "SELECT json_build_object('database',current_database(),'host',host(inet_server_addr()),'port',inet_server_port(),'version',version(),'version_num',current_setting('server_version_num')::int,'user',current_user,'search_path',current_setting('search_path'),'system_identifier',(SELECT system_identifier::text FROM pg_control_system()));"
  Write-Output ('GATE0_SAFE=' + ($gate | ConvertTo-Json -Compress))
  if ($gate.database -cne $database -or $gate.host -cne $hostName -or [int]$gate.port -ne $port -or [int]$gate.version_num -ne 180006 -or $gate.user -cne $owner -or $gate.search_path -cne '"$user", public') { throw 'GATE0_FAILED' }

  for ($i=0; $i -lt $migrationEvidence.Count; $i++) {
    $path = Join-Path $source ($migrationEvidence[$i].path -replace '/','\')
    Invoke-Psql $owner $null $path *> $null
    $migrationEvidence[$i].result = 'PASS'
  }

  $policy = Get-Content -LiteralPath (Join-Path $repo 'scripts\sanitize-v1-post-019\policy.json') -Raw | ConvertFrom-Json
  $allTables = @($policy.tables.psobject.Properties.Name | Sort-Object)
  $emptyTables = @($policy.tables.psobject.Properties | Where-Object Value -eq 'EMPTY' | ForEach-Object Name | Sort-Object)
  if ($allTables.Count -ne 63 -or $emptyTables.Count -ne 54) { throw 'POLICY_CARDINALITY_MISMATCH' }
  $quote = { param($x) 'public."' + $x + '"' }
  $allSql = ($allTables | ForEach-Object { & $quote $_ }) -join ','
  $emptySql = ($emptyTables | ForEach-Object { & $quote $_ }) -join ','
  $privilegeSql = @"
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO $sanitizer;
GRANT SELECT ON TABLE $allSql TO $sanitizer;
GRANT TRUNCATE ON TABLE $emptySql TO $sanitizer;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO $sanitizer;
ALTER DEFAULT PRIVILEGES FOR ROLE $owner IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE $owner IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE $owner IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER ROLE $owner NOLOGIN;
"@
  Invoke-Psql postgres $privilegeSql $null *> $null

  $sanitizerGate = Invoke-Json $sanitizer "SELECT json_build_object('database',current_database(),'host',host(inet_server_addr()),'port',inet_server_port(),'user',current_user,'default_read_only',current_setting('default_transaction_read_only'),'read_only',current_setting('transaction_read_only'));"
  if ($sanitizerGate.database -cne $database -or $sanitizerGate.host -cne $hostName -or [int]$sanitizerGate.port -ne $port -or $sanitizerGate.user -cne $sanitizer -or $sanitizerGate.default_read_only -cne 'on' -or $sanitizerGate.read_only -cne 'on') { throw 'SANITIZER_PREFLIGHT_FAILED' }

  $roles = Invoke-Json postgres @"
SELECT json_build_object(
 'owner_login',(SELECT rolcanlogin FROM pg_roles WHERE rolname='$owner'),
 'sanitizer',(SELECT json_build_object('login',rolcanlogin,'superuser',rolsuper,'inherit',rolinherit,'createdb',rolcreatedb,'createrole',rolcreaterole,'replication',rolreplication,'bypassrls',rolbypassrls,'connection_limit',rolconnlimit) FROM pg_roles WHERE rolname='$sanitizer'),
 'memberships',(SELECT count(*) FROM pg_auth_members WHERE pg_get_userbyid(roleid) IN ('$owner','$sanitizer') OR pg_get_userbyid(member) IN ('$owner','$sanitizer')),
 'connect_target',has_database_privilege('$sanitizer','$database','CONNECT'),
 'connect_postgres',has_database_privilege('$sanitizer','postgres','CONNECT'),
 'connect_template0',has_database_privilege('$sanitizer','template0','CONNECT'),
 'connect_template1',has_database_privilege('$sanitizer','template1','CONNECT'),
 'database_temp',has_database_privilege('$sanitizer','$database','TEMPORARY'),
 'schema_usage',has_schema_privilege('$sanitizer','public','USAGE'),
 'schema_create',has_schema_privilege('$sanitizer','public','CREATE'),
 'table_select',(SELECT count(*) FROM pg_tables WHERE schemaname='public' AND has_table_privilege('$sanitizer',quote_ident(schemaname)||'.'||quote_ident(tablename),'SELECT')),
 'table_truncate',(SELECT count(*) FROM pg_tables WHERE schemaname='public' AND has_table_privilege('$sanitizer',quote_ident(schemaname)||'.'||quote_ident(tablename),'TRUNCATE')),
 'table_insert_update_delete',(SELECT count(*) FROM pg_tables WHERE schemaname='public' AND (has_table_privilege('$sanitizer',quote_ident(schemaname)||'.'||quote_ident(tablename),'INSERT') OR has_table_privilege('$sanitizer',quote_ident(schemaname)||'.'||quote_ident(tablename),'UPDATE') OR has_table_privilege('$sanitizer',quote_ident(schemaname)||'.'||quote_ident(tablename),'DELETE'))),
 'sequence_select',(SELECT count(*) FROM pg_sequences WHERE schemaname='public' AND has_sequence_privilege('$sanitizer',quote_ident(schemaname)||'.'||quote_ident(sequencename),'SELECT')),
 'sequence_select_names',(SELECT json_agg(sequencename ORDER BY sequencename) FROM pg_sequences WHERE schemaname='public' AND has_sequence_privilege('$sanitizer',quote_ident(schemaname)||'.'||quote_ident(sequencename),'SELECT')),
 'sequence_usage',(SELECT count(*) FROM pg_sequences WHERE schemaname='public' AND has_sequence_privilege('$sanitizer',quote_ident(schemaname)||'.'||quote_ident(sequencename),'USAGE')),
 'sequence_update',(SELECT count(*) FROM pg_sequences WHERE schemaname='public' AND has_sequence_privilege('$sanitizer',quote_ident(schemaname)||'.'||quote_ident(sequencename),'UPDATE')),
 'function_execute',(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND has_function_privilege('$sanitizer',p.oid,'EXECUTE')));
"@
  $expectedSequences = @('festa_contagens_convidados_sequencia_seq','festa_eventos_sequencia_seq')
  if ($roles.owner_login -ne $false -or $roles.sanitizer.login -ne $true -or $roles.sanitizer.superuser -ne $false -or $roles.sanitizer.inherit -ne $false -or $roles.sanitizer.createdb -ne $false -or $roles.sanitizer.createrole -ne $false -or $roles.sanitizer.replication -ne $false -or $roles.sanitizer.bypassrls -ne $false -or [int]$roles.sanitizer.connection_limit -ne 1 -or [int]$roles.memberships -ne 0 -or $roles.connect_target -ne $true -or $roles.connect_postgres -ne $false -or $roles.connect_template0 -ne $false -or $roles.connect_template1 -ne $false -or $roles.database_temp -ne $false -or $roles.schema_usage -ne $true -or $roles.schema_create -ne $false -or [int]$roles.table_select -ne 63 -or [int]$roles.table_truncate -ne 54 -or [int]$roles.table_insert_update_delete -ne 0 -or [int]$roles.sequence_select -ne 2 -or (Compare-Object @($roles.sequence_select_names) $expectedSequences) -or [int]$roles.sequence_usage -ne 0 -or [int]$roles.sequence_update -ne 0 -or [int]$roles.function_execute -ne 0) { throw 'SANITIZER_ROLE_MISMATCH' }

  $locksSql = & node -e "const t=require('./scripts/sanitize-v1-post-019/transaction.cjs'),p=require('./scripts/sanitize-v1-post-019/policy.json');process.stdout.write(t.locksSQL(p))"
  if ($LASTEXITCODE -ne 0) { throw 'LOCK_QUERY_LOAD_FAILED' }
  Invoke-Psql $sanitizer "BEGIN READ WRITE; $locksSql ROLLBACK;" $null *> $null

  $inventorySql = & node -e "process.stdout.write(require('./scripts/sanitize-v1-post-019/transaction.cjs').INVENTORY)"
  if ($LASTEXITCODE -ne 0) { throw 'INVENTORY_QUERY_LOAD_FAILED' }
  $structureSql = & node -e "process.stdout.write(require('./scripts/sanitize-v1-post-019/transaction.cjs').STRUCTURE)"
  if ($LASTEXITCODE -ne 0) { throw 'STRUCTURE_QUERY_LOAD_FAILED' }
  $hazardSql = & node -e "const t=require('./scripts/sanitize-v1-post-019/transaction.cjs'),p=require('./scripts/sanitize-v1-post-019/policy.json');process.stdout.write(t.hazardSQL(p))"
  if ($LASTEXITCODE -ne 0) { throw 'HAZARD_QUERY_LOAD_FAILED' }
  $catalogSql = & node -e "const t=require('./scripts/sanitize-v1-post-019/transaction.cjs'),c=require('./scripts/sanitize-v1-post-019/canonical-catalog.json');process.stdout.write(t.catalogSQL(c))"
  if ($LASTEXITCODE -ne 0) { throw 'CATALOG_QUERY_LOAD_FAILED' }
  $inventory = Invoke-Json $sanitizer $inventorySql
  $structure = Invoke-Json $sanitizer $structureSql
  $hazards = Invoke-Json $sanitizer $hazardSql
  $catalogActual = Invoke-Json $sanitizer $catalogSql
  $catalogTemp = Join-Path $root 'catalog-actual.json'
  [IO.File]::WriteAllText($catalogTemp,($catalogActual | ConvertTo-Json -Depth 100 -Compress),[Text.UTF8Encoding]::new($false))
  $catalogHash = & node -e "const fs=require('fs'),g=require('./scripts/sanitize-v1-post-019/guards.cjs'),c=require('./scripts/sanitize-v1-post-019/checks.cjs'),e=require('./scripts/sanitize-v1-post-019/canonical-catalog.json');const a=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));c.assertCatalog(a,e);process.stdout.write(g.hash(g.stable(a)))" $catalogTemp
  if ($LASTEXITCODE -ne 0) { throw 'CATALOG_CONTENT_MISMATCH' }
  $inventoryTemp = Join-Path $root 'inventory-actual.json'
  [IO.File]::WriteAllText($inventoryTemp,($inventory | ConvertTo-Json -Depth 100 -Compress),[Text.UTF8Encoding]::new($false))
  & node -e "const fs=require('fs'),c=require('./scripts/sanitize-v1-post-019/checks.cjs'),s=require('./scripts/sanitize-v1-post-019/expected-schema.json'),p=require('./scripts/sanitize-v1-post-019/policy.json');c.assertInventory(JSON.parse(fs.readFileSync(process.argv[1],'utf8')),s,p)" $inventoryTemp
  if ($LASTEXITCODE -ne 0) { throw 'INVENTORY_MISMATCH' }
  if ([int]$hazards.hazards -ne 0) { throw 'HAZARDS_PRESENT' }
  if ($Mode -eq 'Verify') {
    $projection = $schema.physical_projection
    if (-not $projection -or $schema.execution_gate -cne 'REVIEWED_DISPOSABLE_PROJECTION' -or
        $structure.sha256 -cne $projection.sha256 -or $structure.canonicalization -cne $projection.canonicalization -or
        [string]$catalogHash -cne $projection.catalog_sha256) { throw 'SEALED_PROJECTION_MISMATCH' }
    $expectedComponents = @($projection.component_sha256.psobject.Properties.Name | Sort-Object)
    $actualComponents = @($structure.component_sha256.psobject.Properties.Name | Sort-Object)
    if (Compare-Object $expectedComponents $actualComponents) { throw 'SEALED_COMPONENT_SET_MISMATCH' }
    foreach ($name in $expectedComponents) {
      if ([string]$structure.component_sha256.$name -cne [string]$projection.component_sha256.$name) { throw "SEALED_COMPONENT_MISMATCH_$name" }
    }
  }

  $summary = Invoke-Json postgres "SELECT json_build_object('tables',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'),'columns',(SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped),'constraints',(SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public'),'indexes',(SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'),'triggers',(SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'),'internal_triggers',(SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND t.tgisinternal),'functions',(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'),'sequences',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S'),'extensions',(SELECT count(*) FROM pg_extension));"
  $catalogCounts = [ordered]@{}
  foreach ($property in $catalogActual.psobject.Properties | Sort-Object Name) { $catalogCounts[$property.Name] = @($property.Value).Count }
  $evidence = [ordered]@{
    build=$Build; mode=$Mode; gate0=$gate; target=[ordered]@{host=$hostName;port=$port;database=$database};
    source_commit=$commit; migrations=$migrationEvidence; summary=$summary; catalog_counts=$catalogCounts;
    catalog_sha256=[string]$catalogHash; hazards=[int]$hazards.hazards; roles=$roles;
    structure=$structure; sanitizer_preflight=$sanitizerGate; lock_validation='PASS_ROLLBACK'
  }
  [IO.File]::WriteAllText($evidencePath,($evidence | ConvertTo-Json -Depth 100),[Text.UTF8Encoding]::new($false))
  Write-Output ($evidence | ConvertTo-Json -Depth 8 -Compress)
} finally {
  if ($started) { & $pgCtl -D $data -m fast -w stop *> $null }
  Remove-ExactCluster
  if ($locationPushed) { Pop-Location }
}
