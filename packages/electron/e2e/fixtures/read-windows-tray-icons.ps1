param([string]$Artwork, [string]$Output)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class TrayIconProbe {
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr LoadImage(IntPtr instance, string path, uint type, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr icon);
}
'@
foreach ($state in @('idle', 'notification')) {
  foreach ($size in @(16,20,24,28,32,40,48,64)) {
    $handle = [TrayIconProbe]::LoadImage([IntPtr]::Zero, (Join-Path $Artwork ($state + '.ico')), 1, $size, $size, 0x10)
    if ($handle -eq [IntPtr]::Zero) { throw "LoadImage failed for $state at $size" }
    $icon = $null
    $bitmap = $null
    try {
      $icon = [System.Drawing.Icon]::FromHandle($handle)
      $bitmap = $icon.ToBitmap()
      if ($bitmap.Width -ne $size -or $bitmap.Height -ne $size) { throw "Wrong native icon dimensions" }
      $bitmap.Save((Join-Path $Output ($state + '-' + $size + '.png')), [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
      if ($bitmap) { $bitmap.Dispose() }
      if ($icon) { $icon.Dispose() }
      [void][TrayIconProbe]::DestroyIcon($handle)
    }
  }
}
