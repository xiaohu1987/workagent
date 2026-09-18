param(
    [Parameter(Mandatory = $true)]
    [string]$Path
)

# Best-effort diagnostic: report which processes hold a file that packaging needs to
# replace. Always exits 0 so it can be called from a build script without breaking it.
# ASCII only on purpose: Windows PowerShell 5.1 reads BOM-less files as ANSI.

$ErrorActionPreference = 'Stop'

$src = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class PackageLockProbe
{
    [StructLayout(LayoutKind.Sequential)]
    struct RM_UNIQUE_PROCESS
    {
        public int dwProcessId;
        public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct RM_PROCESS_INFO
    {
        public RM_UNIQUE_PROCESS Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
        public int ApplicationType;
        public uint AppStatus;
        public uint TSSessionId;
        [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
    }

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, string strSessionKey);

    [DllImport("rstrtmgr.dll")]
    static extern int RmEndSession(uint pSessionHandle);

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames, uint nApplications, RM_UNIQUE_PROCESS[] rgApplications, uint nServices, string[] rgsServiceNames);

    [DllImport("rstrtmgr.dll")]
    static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo, [In, Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);

    public static List<int> Who(string path)
    {
        var pids = new List<int>();
        uint session;
        string key = Guid.NewGuid().ToString();
        if (RmStartSession(out session, 0, key) != 0) return pids;
        try
        {
            string[] files = new string[] { path };
            if (RmRegisterResources(session, 1, files, 0, null, 0, null) != 0) return pids;

            uint needed = 0, count = 0, reasons = 0;
            int rc = RmGetList(session, out needed, ref count, null, ref reasons);
            if (rc == 234)
            {
                var arr = new RM_PROCESS_INFO[needed];
                count = needed;
                if (RmGetList(session, out needed, ref count, arr, ref reasons) == 0)
                {
                    for (int i = 0; i < count; i++) pids.Add(arr[i].Process.dwProcessId);
                }
            }
        }
        finally { RmEndSession(session); }
        return pids;
    }
}
'@

try {
    if (-not (Test-Path -LiteralPath $Path)) {
        Write-Host "         (nothing to report: $Path does not exist)"
        exit 0
    }

    Add-Type -TypeDefinition $src -Language CSharp
    $pids = [PackageLockProbe]::Who($Path)

    if ($pids.Count -eq 0) {
        Write-Host "         The file is not held by any running process right now (transient lock)."
        exit 0
    }

    Write-Host "         Held open by:"
    foreach ($procId in $pids) {
        $name = '<unknown>'
        $procPath = '<unavailable>'
        try {
            $proc = Get-Process -Id $procId -ErrorAction Stop
            $name = $proc.ProcessName
            try { if ($proc.Path) { $procPath = $proc.Path } } catch { }
        } catch { }
        Write-Host ("           - {0} (PID {1})" -f $name, $procId)
        Write-Host ("               {0}" -f $procPath)
    }
    Write-Host "         Close those processes (or restart them) and run this script again."
} catch {
    Write-Host ("         (lock report unavailable: " + $_.Exception.Message + ")")
}

exit 0
