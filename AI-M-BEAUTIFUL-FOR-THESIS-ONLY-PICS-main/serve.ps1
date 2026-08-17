# AI'm Beautiful — local dev/demo server.
#
# The app loads its shade, style, focal-point and foundation data with fetch(),
# which browsers block on file:// — so index.html must be served over http.
# This needs no Python, Node, or any install: it uses .NET's HttpListener.
#
#   Run:   right-click this file -> "Run with PowerShell"
#   Or:    powershell -ExecutionPolicy Bypass -File serve.ps1
#   Then:  open http://localhost:8765
#   Stop:  Ctrl+C, or just close the window
#
# localhost counts as a secure origin, so the camera works normally.

$root   = Split-Path -Parent $MyInvocation.MyCommand.Path
$port   = 8765
$prefix = "http://localhost:$port/"

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)
try {
  $listener.Start()
} catch {
  Write-Host "Could not start on port $port. Is it already in use?" -ForegroundColor Red
  Write-Host $_.Exception.Message
  Read-Host "Press Enter to close"
  exit 1
}

Write-Host ""
Write-Host "  AI'm Beautiful is running" -ForegroundColor Green
Write-Host "  Open:  $prefix" -ForegroundColor Cyan
Write-Host "  Stop:  Ctrl+C"
Write-Host ""

$mime = @{
  '.html'='text/html; charset=utf-8'
  '.js'  ='application/javascript; charset=utf-8'
  '.css' ='text/css; charset=utf-8'
  '.json'='application/json; charset=utf-8'
  '.png' ='image/png'
  '.jpg' ='image/jpeg'
  '.svg' ='image/svg+xml'
  '.bin' ='application/octet-stream'
}

while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
    $rel = [System.Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
    if ([string]::IsNullOrWhiteSpace($rel)) { $rel = 'index.html' }
    $path = Join-Path $root ($rel -replace '/', '\')

    # Keep requests inside the project folder.
    $full = [System.IO.Path]::GetFullPath($path)
    if (-not $full.StartsWith([System.IO.Path]::GetFullPath($root))) {
      $ctx.Response.StatusCode = 403
      $ctx.Response.OutputStream.Close()
      continue
    }

    if (Test-Path $full -PathType Leaf) {
      $ext = [System.IO.Path]::GetExtension($full).ToLower()
      $ct  = $mime[$ext]; if (-not $ct) { $ct = 'application/octet-stream' }
      $bytes = [System.IO.File]::ReadAllBytes($full)
      $ctx.Response.ContentType   = $ct
      $ctx.Response.StatusCode    = 200
      $ctx.Response.ContentLength64 = $bytes.Length
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $ctx.Response.StatusCode = 404
      $b = [System.Text.Encoding]::UTF8.GetBytes('Not found: ' + $rel)
      $ctx.Response.OutputStream.Write($b, 0, $b.Length)
      Write-Host "  404  $rel" -ForegroundColor DarkYellow
    }
    $ctx.Response.OutputStream.Close()
  } catch {
    Write-Host "  error: $($_.Exception.Message)" -ForegroundColor DarkRed
  }
}
