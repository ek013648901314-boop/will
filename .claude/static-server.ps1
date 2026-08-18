# Minimal static file server (no Node/Python required).
# Serves this folder over http://localhost so manifest.json / service worker (PWA features)
# can be tested correctly -- browsers block service worker registration on file:// URLs.
param(
  [int]$Port = 5500
)

$root = Split-Path -Parent $PSScriptRoot
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Output "Serving $root at http://localhost:$Port/"

$mimeMap = @{
  ".html" = "text/html; charset=utf-8"
  ".htm"  = "text/html; charset=utf-8"
  ".js"   = "application/javascript; charset=utf-8"
  ".css"  = "text/css; charset=utf-8"
  ".json" = "application/json; charset=utf-8"
  ".png"  = "image/png"
  ".jpg"  = "image/jpeg"
  ".jpeg" = "image/jpeg"
  ".svg"  = "image/svg+xml"
  ".ico"  = "image/x-icon"
  ".webmanifest" = "application/manifest+json"
}

try {
  while ($listener.IsListening) {
    $context = $listener.GetContext()
    $request = $context.Request
    $response = $context.Response
    try {
      $urlPath = [System.Uri]::UnescapeDataString($request.Url.AbsolutePath)
      if ($urlPath -eq "/") { $urlPath = "/index.html" }
      $filePath = Join-Path $root ($urlPath.TrimStart("/"))
      $fullRoot = (Resolve-Path $root).Path
      $resolved = $null
      if (Test-Path $filePath -PathType Leaf) {
        $resolved = (Resolve-Path $filePath).Path
      }
      if ($resolved -and $resolved.StartsWith($fullRoot)) {
        $ext = [System.IO.Path]::GetExtension($resolved).ToLower()
        $contentType = $mimeMap[$ext]
        if (-not $contentType) { $contentType = "application/octet-stream" }
        $bytes = [System.IO.File]::ReadAllBytes($resolved)
        $response.ContentType = $contentType
        $response.ContentLength64 = $bytes.Length
        $response.StatusCode = 200
        $response.OutputStream.Write($bytes, 0, $bytes.Length)
      } else {
        $response.StatusCode = 404
        $notFoundBytes = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found")
        $response.OutputStream.Write($notFoundBytes, 0, $notFoundBytes.Length)
      }
    } catch {
      try {
        $response.StatusCode = 500
      } catch {}
    } finally {
      $response.OutputStream.Close()
    }
  }
} finally {
  $listener.Stop()
}
