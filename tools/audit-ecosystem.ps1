$ErrorActionPreference = 'Stop'

$now = Get-Date
$stamp = $now.ToString('yyyyMMdd_HHmmss')
$repo = (Resolve-Path .).Path
$outFile = "eco_map_$stamp.md"

function Section([string]$title){ return "`r`n## $title`r`n" }

$lines = @()
$ts = $now.ToString('yyyy-MM-dd HH:mm:ss')
$lines += ('# Ecosystem Audit - {0}' -f $ts)
$lines += ('_Raiz:_ {0}' -f $repo)

# A) Diretórios suspeitos
$maybeOld = @('monitoring','monitoring/prometheus','monitoring/grafana','services/tools/steve','services/tools/ocpp-simulator')
$existing = $maybeOld | Where-Object { Test-Path $_ }
$lines += Section 'Diretórios suspeitos ainda existentes'
if($existing){ $lines += ($existing | ForEach-Object { '- {0}' -f $_ }) } else { $lines += '- (nenhum encontrado) OK' }

# B) Compose
$composeFiles = @('docker-compose.yml','docker-compose.override.yml','docker-compose.observability.yml') | Where-Object { Test-Path $_ }
$lines += Section 'Docker Compose - arquivos detectados'
if($composeFiles){ $lines += ($composeFiles | ForEach-Object { '- {0}' -f $_ }) } else { $lines += '- (nenhum compose encontrado)' }

$lines += Section 'Docker Compose - serviços renderizados'
$svcAll = @()
foreach($f in $composeFiles){
  try{
    $svcs = docker compose -f $f config --services 2>$null
    if($svcs){
      $svcAll += ('**{0}**' -f $f)
      $svcAll += ($svcs | ForEach-Object { '- {0}' -f $_ })
    }
  } catch {
    $svcAll += ('**{0}** - erro no "docker compose config --services"' -f $f)
  }
}
if($svcAll){ $lines += $svcAll } else { $lines += '- (não consegui renderizar config)' }

# C) Workspaces
$lines += Section 'Workspaces inválidos/inexistentes (package.json)'
if(Test-Path '.\package.json'){
  $pkg = Get-Content '.\package.json' -Raw | ConvertFrom-Json -Depth 100
  $globs = @()
  if($pkg.workspaces){
    if($pkg.workspaces.PSObject.Properties.Name -contains 'packages'){ $globs = @($pkg.workspaces.packages) }
    elseif($pkg.workspaces -is [System.Array]){ $globs = @($pkg.workspaces) }
  }
  $missing = @()
  foreach($g in $globs){
    $matches = @(Resolve-Path $g -ErrorAction SilentlyContinue)
    if(-not $matches){ $missing += $g }
  }
  if($missing){ $lines += ($missing | ForEach-Object { '- {0} (não encontrado)' -f $_ }) } else { $lines += '- (OK) nenhum workspace órfão' }
} else { $lines += '- (package.json não encontrado)' }

# D) Grep legados
$lines += Section 'grep - strings de legado/itens para remoção'
$pat = 'STEVE_|MARIADB_|steve\.jar|ocpp-simulator'
$grep = git grep -n -I -E $pat 2>$null
if([string]::IsNullOrWhiteSpace($grep)){ $lines += '- (vazio) OK' } else { $lines += '```text'; $lines += $grep; $lines += '```' }

# E) Workflows antigos
$lines += Section 'GitHub Actions - possíveis workflows antigos'
$oldWF = @('.github/workflows/db-check.yml') | Where-Object { Test-Path $_ }
if($oldWF){ $lines += ($oldWF | ForEach-Object { '- {0} (candidato a remoção, substituído por db-migrations-check.yml)' -f $_ }) } else { $lines += '- (OK) nenhum workflow antigo padrão detectado' }

# F) Provisioning observability
$lines += Section 'Provisioning observability'
$gProv = 'services/grafana/provisioning'
$pDir  = 'services/prometheus'
$lines += (Test-Path $gProv) ? ('- {0} (OK)' -f $gProv) : ('- {0} (faltando?)' -f $gProv)
$lines += (Test-Path $pDir)  ? ('- {0} (OK)' -f $pDir)  : ('- {0} (faltando?)' -f $pDir)

# G) Depcheck
$lines += Section 'Dependências potencialmente não usadas (depcheck)'
try{
  if(Get-Command pnpm -ErrorAction SilentlyContinue){
    $out = pnpm dlx depcheck --json 2>$null
    if($LASTEXITCODE -eq 0 -and $out){
      $json = $out | ConvertFrom-Json
      $unused = @($json.dependencies) + @($json.devDependencies)
      if($unused){ $lines += ($unused | ForEach-Object { '- {0}' -f $_ }) } else { $lines += '- (OK) nenhuma reportada' }
    } else { $lines += '- (não foi possível rodar depcheck - opcional)' }
  } else { $lines += '- (pnpm não encontrado - pule)' }
} catch { $lines += '- (erro ao rodar depcheck - opcional)' }

# H) Arquivos grandes
$lines += Section 'Binários grandes rastreados (>5MB)'
$big = @()
$tracked = git ls-files 2>$null
foreach($f in $tracked){
  if(Test-Path $f){
    $sz = (Get-Item $f).Length
    if($sz -gt 5MB){ $big += ('{0} ({1:N1} MB)' -f $f, ($sz/1MB)) }
  }
}
if($big){ $lines += ($big | ForEach-Object { '- {0}' -f $_ }) } else { $lines += '- (OK) nenhum arquivo grande rastreado' }

# I) Recomendações
$lines += Section 'Recomendações'
if($existing -contains 'monitoring' -or $existing -contains 'monitoring\prometheus'){
  $lines += '- Remover diretório monitoring/ se não for referenciado por nenhum compose.'
}
if($oldWF){
  $lines += '- Remover workflow legado .github/workflows/db-check.yml (substituído).'
}
if($big){ $lines += '- Considerar git rm desses binários ou migrar para Git LFS, se realmente necessários.' }
if([string]::IsNullOrWhiteSpace($grep)){ $lines += '- OK: nenhum traço de STEVE/MARIADB/ocpp-simulator.' }

$lines | Set-Content $outFile -Encoding UTF8
Write-Host ('Relatório gerado: {0}' -f $outFile) -ForegroundColor Green
