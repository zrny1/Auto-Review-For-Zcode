# GUI 窗口探测脚本：按标题匹配 auto-review 相关顶层窗口，输出可见性与坐标
# 作者: hh-zyb  创建日期: 2026年08月29日
$target = 0

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Win32Probe {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int L, T, R, B; }
}
"@

$hits = New-Object System.Collections.ArrayList
$cb = {
  param($h, $l)
  $sb = New-Object System.Text.StringBuilder 256
  [Win32Probe]::GetWindowText($h, $sb, 256) | Out-Null
  $title = $sb.ToString()
  if ($title -match "auto-review") {
    $wpid = 0
    [Win32Probe]::GetWindowThreadProcessId($h, [ref]$wpid) | Out-Null
    $r = New-Object Win32Probe+RECT
    [Win32Probe]::GetWindowRect($h, [ref]$r) | Out-Null
    [void]$script:hits.Add("hwnd=" + $h + " pid=" + $wpid + " visible=" + [Win32Probe]::IsWindowVisible($h) + " rect=" + $r.L + "," + $r.T + " - " + $r.R + "," + $r.B + " title=[" + $title + "]")
  }
  return $true
}
[Win32Probe]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
if ($hits.Count -eq 0) { Write-Output "no-auto-review-window-found" } else { $hits | ForEach-Object { Write-Output $_ } }
Write-Output probe-done
