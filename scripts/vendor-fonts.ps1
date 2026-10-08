$ErrorActionPreference = 'Stop'
$fontDirectory = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../vendor/fonts'))
New-Item -ItemType Directory -Path $fontDirectory -Force | Out-Null
$fontDownloads = @(
    @{ Source = 'https://fonts.gstatic.com/s/cinzel/v26/8vIU7ww63mVu7gtR-kwKxNvkNOjw-tbnTYo.ttf'; Name = 'Cinzel-Regular.ttf' },
    @{ Source = 'https://fonts.gstatic.com/s/cinzel/v26/8vIU7ww63mVu7gtR-kwKxNvkNOjw-uTnTYo.ttf'; Name = 'Cinzel-Medium.ttf' },
    @{ Source = 'https://fonts.gstatic.com/s/cinzel/v26/8vIU7ww63mVu7gtR-kwKxNvkNOjw-gjgTYo.ttf'; Name = 'Cinzel-SemiBold.ttf' },
    @{ Source = 'https://fonts.gstatic.com/s/cinzel/v26/8vIU7ww63mVu7gtR-kwKxNvkNOjw-jHgTYo.ttf'; Name = 'Cinzel-Bold.ttf' },
    @{ Source = 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/cinzel/OFL.txt'; Name = 'Cinzel-OFL.txt' },
    @{ Source = 'https://fonts.gstatic.com/s/ebgaramond/v33/SlGDmQSNjdsmc35JDF1K5E55YMjF_7DPuGi-6_RUAw.ttf'; Name = 'EBGaramond-Regular.ttf' },
    @{ Source = 'https://fonts.gstatic.com/s/ebgaramond/v33/SlGDmQSNjdsmc35JDF1K5E55YMjF_7DPuGi-2fRUAw.ttf'; Name = 'EBGaramond-Medium.ttf' },
    @{ Source = 'https://fonts.gstatic.com/s/ebgaramond/v33/SlGDmQSNjdsmc35JDF1K5E55YMjF_7DPuGi-NfNUAw.ttf'; Name = 'EBGaramond-SemiBold.ttf' },
    @{ Source = 'https://fonts.gstatic.com/s/ebgaramond/v33/SlGFmQSNjdsmc35JDF1K5GRwUjcdlttVFm-rI7e8QI96.ttf'; Name = 'EBGaramond-Italic.ttf' },
    @{ Source = 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/ebgaramond/OFL.txt'; Name = 'EBGaramond-OFL.txt' }
)
foreach ($fontDownload in $fontDownloads) {
    $fontTarget = Join-Path $fontDirectory $fontDownload.Name
    Invoke-WebRequest -Uri $fontDownload.Source -OutFile $fontTarget -TimeoutSec 60
    Get-Item -LiteralPath $fontTarget | Select-Object Name, Length
}
