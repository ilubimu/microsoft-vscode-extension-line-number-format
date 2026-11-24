param(
    [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

if (-not $OutputPath) {
    $extensionRoot = Split-Path -Parent $PSScriptRoot
    $OutputPath = Join-Path $extensionRoot "images\icon.png"
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath) | Out-Null

$size = 128
$bitmap = [System.Drawing.Bitmap]::new($size, $size)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$graphics.Clear([System.Drawing.Color]::Transparent)

# Rounded dark tile.
$x = 6.0; $y = 6.0; $w = 116.0; $h = 116.0; $r = 24.0
$path = [System.Drawing.Drawing2D.GraphicsPath]::new()
$path.AddArc($x, $y, $r * 2, $r * 2, 180, 90)
$path.AddArc($x + $w - $r * 2, $y, $r * 2, $r * 2, 270, 90)
$path.AddArc($x + $w - $r * 2, $y + $h - $r * 2, $r * 2, $r * 2, 0, 90)
$path.AddArc($x, $y + $h - $r * 2, $r * 2, $r * 2, 90, 90)
$path.CloseFigure()

$background = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 30, 36, 48))
$border = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(255, 60, 76, 100), 2.0)
$graphics.FillPath($background, $path)
$graphics.DrawPath($border, $path)

# Three line-number rows: decimal on the left, hexadecimal on the right.
$font = [System.Drawing.Font]::new(
    "Consolas",
    17,
    [System.Drawing.FontStyle]::Bold,
    [System.Drawing.GraphicsUnit]::Pixel
)
$decimalBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 154, 164, 178))
$hexBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 92, 200, 232))
$barPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(255, 92, 200, 232), 2.0)

$far = [System.Drawing.StringFormat]::new()
$far.Alignment = [System.Drawing.StringAlignment]::Far
$near = [System.Drawing.StringFormat]::new()
$near.Alignment = [System.Drawing.StringAlignment]::Near

$rows = @(
    @("1", "0x01"),
    @("2", "0x0A"),
    @("3", "0x1F")
)

$rowY = 26.0
foreach ($row in $rows) {
    $decimalRect = [System.Drawing.RectangleF]::new(14.0, $rowY, 30.0, 24.0)
    $hexRect = [System.Drawing.RectangleF]::new(54.0, $rowY, 64.0, 24.0)
    $graphics.DrawString($row[0], $font, $decimalBrush, $decimalRect, $far)
    $graphics.DrawString($row[1], $font, $hexBrush, $hexRect, $near)
    $rowY += 30.0
}

# Vertical separator, echoing the label column separator.
$graphics.DrawLine($barPen, 48.0, 24.0, 48.0, 104.0)

$bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)

$graphics.Dispose()
$background.Dispose()
$border.Dispose()
$font.Dispose()
$decimalBrush.Dispose()
$hexBrush.Dispose()
$barPen.Dispose()
$far.Dispose()
$near.Dispose()
$path.Dispose()
$bitmap.Dispose()

Write-Host "Wrote $OutputPath"
