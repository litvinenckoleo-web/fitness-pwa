# make-icons.ps1 — генерирует PNG-иконки приложения (180, 192, 512) без внешних библиотек.
# Запуск из папки проекта:  powershell -ExecutionPolicy Bypass -File .\tools\make-icons.ps1
# Рисует синий квадрат с белой штангой — тот же мотив, что в icons/icon.svg.

param(
    [string]$OutDir = (Join-Path (Split-Path -Parent $PSScriptRoot) 'icons')
)

Add-Type -AssemblyName System.Drawing

if (-not (Test-Path -LiteralPath $OutDir)) {
    New-Item -ItemType Directory -Path $OutDir | Out-Null
}

# Размеры: 180 — apple-touch-icon, 192 и 512 — манифест PWA
$sizes = @(180, 192, 512)

# Координаты мотива заданы в системе 512x512 (как в icon.svg) и масштабируются
$shapes = @(
    @{ X = 136; Y = 246; W = 240; H = 20 },   # гриф
    @{ X = 108; Y = 196; W = 34;  H = 120 },  # блины слева (внутренние)
    @{ X = 76;  Y = 226; W = 26;  H = 60 },   # блины слева (внешние)
    @{ X = 370; Y = 196; W = 34;  H = 120 },  # блины справа (внутренние)
    @{ X = 410; Y = 226; W = 26;  H = 60 }    # блины справа (внешние)
)

foreach ($size in $sizes) {
    $bitmap = New-Object System.Drawing.Bitmap($size, $size)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

    # Фон — диагональный градиент от #3a7bff к #1e4fd6
    $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
    $colorFrom = [System.Drawing.ColorTranslator]::FromHtml('#3a7bff')
    $colorTo = [System.Drawing.ColorTranslator]::FromHtml('#1e4fd6')
    $bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $colorFrom, $colorTo, 45)
    $graphics.FillRectangle($bgBrush, $rect)
    $bgBrush.Dispose()

    # Штанга — белые прямоугольники
    $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $k = $size / 512.0
    foreach ($shape in $shapes) {
        $graphics.FillRectangle(
            $white,
            [float]($shape.X * $k),
            [float]($shape.Y * $k),
            [float]($shape.W * $k),
            [float]($shape.H * $k)
        )
    }
    $white.Dispose()
    $graphics.Dispose()

    $path = Join-Path $OutDir "icon-$size.png"
    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose()

    Write-Output "Готово: $path"
}
