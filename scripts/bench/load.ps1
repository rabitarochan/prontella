<#
  Ink 風の固定ブロック再描画を一定レートで吐き続ける負荷生成器 (term-bench.mjs の M2/steady 用)。
  1 tick ごとに ESC[<Lines>A でカーソルを block の先頭へ戻し、Lines 行を
  ANSI 色 + スピナー文字 (✻✶✽✢ を巡回) + 行末までのパディングで丸ごと書き直す。
  各行を $Cols にパディング/切り詰めするため、1 tick の出力バイト数はほぼ一定になる。

  呼び出しは短い1行で: & '<このファイルの絶対パス>' -Seconds 20 -Hz 10 -Lines 20 -Cols 100
  (ConPTY へ長い1行コマンドを流し込むと折り返しで壊れるため — pj-isolated-verify 罠26)
#>
param(
  [int]$Seconds = 20,
  [int]$Hz = 10,
  [int]$Lines = 20,
  [int]$Cols = 100,
  # 仕事量を固定するための tick 数 (既定 = Seconds × Hz)。マシンが混んでいて Hz を
  # 出せなくても、この tick 数を出し切ってから終わる (時間ではなく仕事量で揃える)。
  # 上限として Seconds × 4 で打ち切る。
  [int]$Ticks = 0
)

$esc = [char]27
$spinners = @('✻', '✶', '✽', '✢')
$colors = @(31, 32, 33, 34, 35, 36)
$intervalMs = [Math]::Max(1, [int](1000 / $Hz))
if ($Ticks -le 0) { $Ticks = $Seconds * $Hz }
$deadline = (Get-Date).AddSeconds($Seconds * 4)

# 最初の再描画がカーソルを正しい位置まで戻せるよう、先に $Lines 行分の余白を出しておく。
for ($i = 0; $i -lt $Lines; $i++) { Write-Host '' }

$tick = 0
while ($tick -lt $Ticks -and (Get-Date) -lt $deadline) {
  $spinner = $spinners[$tick % $spinners.Length]
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append("$esc[${Lines}A")
  for ($row = 0; $row -lt $Lines; $row++) {
    $color = $colors[$row % $colors.Length]
    $text = "$spinner bench row=$row tick=$tick"
    if ($text.Length -gt $Cols) {
      $text = $text.Substring(0, $Cols)
    } else {
      $text = $text.PadRight($Cols)
    }
    [void]$sb.Append("$esc[${color}m$text$esc[0m`r`n")
  }
  [Console]::Out.Write($sb.ToString())
  $tick++
  Start-Sleep -Milliseconds $intervalMs
}
