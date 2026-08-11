$ErrorActionPreference = "Continue"
Set-Location d:\workagent
$deps = @('@anthropic-ai/sdk','@iarna/toml','@modelcontextprotocol/sdk','cheerio','echarts','gray-matter','highlight.js','iconv-lite','jsonrepair','jszip','mammoth','mysql2','openai','pdf-parse','pg','react','react-dom','tedious','tree-sitter-wasms','web-tree-sitter','xlsx','yaml','zod','@types/node','@types/react','@types/react-dom','@vitejs/plugin-react','electron','electron-builder','electron-vite','typescript','vite','vitest')
$deleted = 0
foreach ($dep in $deps) {
  if (Test-Path "node_modules\$dep\package.json") { continue }
  $dest = Join-Path (Get-Location) "node_modules\$dep"
  $item = Get-Item $dest -Force -ErrorAction SilentlyContinue
  if ($item) {
    try { [System.IO.Directory]::Delete($item.FullName, $false); $deleted++ } catch { Write-Output "cannot delete: $dep" }
  }
}
Write-Output "deleted=$deleted"
