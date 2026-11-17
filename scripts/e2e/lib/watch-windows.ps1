# Logs every new process (with its parent) and every new visible top-level window, as JSON
# lines, until killed. The e2e runner uses it to prove Sidekick never opens a console or
# terminal window (a classic bug: a background command started without CREATE_NO_WINDOW).
param([Parameter(Mandatory = $true)][string]$Log)

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class SkWatch {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct PE { public uint dwSize; public uint cntUsage; public uint th32ProcessID; public IntPtr th32DefaultHeapID; public uint th32ModuleID; public uint cntThreads; public uint th32ParentProcessID; public int pcPriClassBase; public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint f, uint p);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr h, ref PE e);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr h, ref PE e);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static Dictionary<uint, string> Procs() {
    var d = new Dictionary<uint, string>();
    IntPtr s = CreateToolhelp32Snapshot(2, 0);
    var e = new PE(); e.dwSize = (uint)Marshal.SizeOf(typeof(PE));
    if (Process32FirstW(s, ref e)) { do { d[e.th32ProcessID] = e.szExeFile + "|" + e.th32ParentProcessID; } while (Process32NextW(s, ref e)); }
    CloseHandle(s);
    return d;
  }
  public static List<string> Windows() {
    var l = new List<string>();
    EnumWindows((h, x) => {
      if (IsWindowVisible(h)) {
        var c = new StringBuilder(256); GetClassNameW(h, c, 256);
        var t = new StringBuilder(256); GetWindowTextW(h, t, 256);
        uint pid; GetWindowThreadProcessId(h, out pid);
        l.Add(h.ToInt64() + "|" + c + "|" + t + "|" + pid);
      }
      return true;
    }, IntPtr.Zero);
    return l;
  }
}
"@

function Emit($obj) { ($obj | ConvertTo-Json -Compress) | Out-File -FilePath $Log -Append -Encoding utf8 }

$seenP = [SkWatch]::Procs()
$seenW = @{}
foreach ($w in [SkWatch]::Windows()) { $seenW[$w] = 1 }
$names = @{}
foreach ($k in $seenP.Keys) { $names[$k] = $seenP[$k].Split('|')[0] }
Emit @{ kind = 'ready'; t = (Get-Date).ToString('o') }

while ($true) {
  $p = [SkWatch]::Procs()
  foreach ($k in $p.Keys) {
    if (-not $seenP.ContainsKey($k) -or $seenP[$k] -ne $p[$k]) {
      $name, $ppid = $p[$k].Split('|')
      $names[$k] = $name
      Emit @{ kind = 'proc'; t = (Get-Date).ToString('o'); pid = [int]$k; ppid = [int]$ppid; name = $name }
    }
  }
  $seenP = $p
  foreach ($w in [SkWatch]::Windows()) {
    if (-not $seenW.ContainsKey($w)) {
      $seenW[$w] = 1
      $parts = $w.Split('|')
      $wpid = [uint32]$parts[3]
      Emit @{ kind = 'window'; t = (Get-Date).ToString('o'); cls = $parts[1]; title = $parts[2]; pid = [int]$wpid; name = $names[$wpid] }
    }
  }
  Start-Sleep -Milliseconds 50
}
