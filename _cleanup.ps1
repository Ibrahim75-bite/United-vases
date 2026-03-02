$lines = Get-Content "e:\El-Muttahida\elmuttahida_backend\server.js"
# Keep lines 1-743 (0..742), 914-1208 (913..1207), 1294-1428 (1293..1427), and skip the rest
$keep = @()
$keep += $lines[0..742]
$keep += $lines[913..1207]
$keep += $lines[1293..1427]
$keep | Set-Content "e:\El-Muttahida\elmuttahida_backend\server.js" -Encoding UTF8
Write-Host "Done. Removed duplicate product routes. New total: $($keep.Length)"
