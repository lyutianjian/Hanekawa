param(
  [ValidateSet(0, 60, 120)][int]$RefreshRate = 0,
  [ValidateSet(1, 1.25)][double]$Scale = 1,
  [ValidateSet('dark', 'light')][string]$Theme = 'dark',
  [string]$Out = '.smoke/motion-windows',
  [int]$Port = 9237,
  [switch]$NativeDpi,
  [switch]$Inspect
)

# Optional Windows wrapper for measuring a real 60/120Hz display mode.
# Only refresh rate changes, after CDS_TEST succeeds; no registry persistence.
# The original display mode is restored in finally, including a failed run.
# Scale normally overrides Chromium. NativeDpi temporarily changes the primary
# display's Windows scale, validates it in Electron and restores it in finally.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MotionDisplay {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct Device {
    public int cb;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string name;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string description;
    public int flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string id;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string key;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct Mode {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string deviceName;
    public ushort specVersion, driverVersion, size, driverExtra;
    public uint fields;
    public int x, y;
    public uint orientation, fixedOutput;
    public short color, duplex, yResolution, ttOption, collate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string formName;
    public ushort logPixels;
    public uint bitsPerPixel, width, height, displayFlags, frequency;
    public uint icmMethod, icmIntent, mediaType, ditherType, reserved1, reserved2, panningWidth, panningHeight;
  }
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern bool EnumDisplayDevices(string device, uint index, ref Device result, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern bool EnumDisplaySettings(string device, int index, ref Mode result);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern int ChangeDisplaySettingsEx(string device, ref Mode mode, IntPtr hwnd, uint flags, IntPtr parameter);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern uint GetDpiForSystem();
  public static Device Primary() {
    for (uint i=0;;i++) {
      var d = new Device { cb = Marshal.SizeOf<Device>() };
      if (!EnumDisplayDevices(null, i, ref d, 0)) throw new Exception("No primary display");
      if ((d.flags & 4) != 0) return d;
    }
  }
  public static Mode Current(string device) {
    var mode = new Mode { size = (ushort)Marshal.SizeOf<Mode>() };
    if (!EnumDisplaySettings(device, -1, ref mode)) throw new Exception("Cannot read current display mode");
    return mode;
  }
}
'@

$motionDisplay = [MotionDisplay]::Primary()
$originalMotionMode = [MotionDisplay]::Current($motionDisplay.name)
$previousMotionDpiContext = [MotionDisplay]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
try { $motionSystemDpi = [MotionDisplay]::GetDpiForSystem() }
finally { [void][MotionDisplay]::SetThreadDpiAwarenessContext($previousMotionDpiContext) }
$motionInfo = [ordered]@{
  display = $motionDisplay.description
  width = $originalMotionMode.width
  height = $originalMotionMode.height
  originalHz = $originalMotionMode.frequency
  systemDpi = $motionSystemDpi
  requestedHz = $RefreshRate
}
if ($NativeDpi) {
  . (Join-Path $PSScriptRoot 'smoke/windowsDpi.ps1')
  $motionSource = [MotionDpi]::Sources() | Where-Object { [MotionDpi]::Name($_) -eq $motionDisplay.name } | Select-Object -First 1
  if ($null -eq $motionSource) { throw 'Primary display has no active DPI source' }
  $originalNativeDpi = [MotionDpi]::Read($motionSource)
  $motionDpiScales = @(100, 125, 150, 175, 200, 225, 250, 300, 350, 400, 450, 500)
  $requestedRelativeDpi = $originalNativeDpi.min + [Array]::IndexOf($motionDpiScales, [int]($Scale * 100))
  if ($requestedRelativeDpi -lt $originalNativeDpi.min -or $requestedRelativeDpi -gt $originalNativeDpi.max) { throw 'Requested native DPI is unavailable' }
  $motionInfo.originalScalePercent = $motionDpiScales[$originalNativeDpi.current - $originalNativeDpi.min]
  $motionInfo.requestedScalePercent = [int]($Scale * 100)
}
if ($Inspect) {
  $motionInfo | ConvertTo-Json
  exit 0
}
$motionChanged = $false
$motionDpiChanged = $false
$motionExit = 1
try {
  if ($RefreshRate -ne 0 -and $RefreshRate -ne $originalMotionMode.frequency) {
    $requestedMotionMode = $originalMotionMode
    $requestedMotionMode.frequency = $RefreshRate
    $requestedMotionMode.fields = 0x00400000
    $testMotionMode = [MotionDisplay]::ChangeDisplaySettingsEx($motionDisplay.name, [ref]$requestedMotionMode, [IntPtr]::Zero, 2, [IntPtr]::Zero)
    if ($testMotionMode -ne 0) { throw "Refresh rate is unavailable (CDS_TEST = $testMotionMode)" }
    $setMotionMode = [MotionDisplay]::ChangeDisplaySettingsEx($motionDisplay.name, [ref]$requestedMotionMode, [IntPtr]::Zero, 0, [IntPtr]::Zero)
    if ($setMotionMode -ne 0) { throw "Could not apply display mode ($setMotionMode)" }
    $motionChanged = $true
  }
  if ($NativeDpi) {
    if ($requestedRelativeDpi -ne $originalNativeDpi.current) {
      [MotionDpi]::Apply($motionSource, $requestedRelativeDpi)
      $motionDpiChanged = $true
    }
    $appliedNativeDpi = [MotionDpi]::Read($motionSource)
    if ($appliedNativeDpi.current -ne $requestedRelativeDpi) { throw 'Native DPI change did not take effect' }
    $motionInfo.measuredScalePercent = $motionDpiScales[$appliedNativeDpi.current - $appliedNativeDpi.min]
  }
  $motionInfo.measuredHz = ([MotionDisplay]::Current($motionDisplay.name)).frequency
  [void](New-Item -ItemType Directory -Path $Out -Force)
  $motionInfo | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Out 'display.json') -Encoding utf8
  $motionInfo | ConvertTo-Json -Compress
  $motionDpiMode = if ($NativeDpi) { 'native' } else { 'chromium' }
  & node (Join-Path $PSScriptRoot 'motion-desktop.mjs') "--scale=$Scale" "--theme=$Theme" "--out=$Out" "--port=$Port" "--dpi=$motionDpiMode"
  $motionExit = $LASTEXITCODE
}
finally {
  try {
    if ($motionDpiChanged) { [MotionDpi]::Apply($motionSource, $originalNativeDpi.current) }
  }
  finally {
    if ($motionChanged) {
      $restoreMotionMode = [MotionDisplay]::ChangeDisplaySettingsEx($motionDisplay.name, [ref]$originalMotionMode, [IntPtr]::Zero, 0, [IntPtr]::Zero)
      if ($restoreMotionMode -ne 0) { throw "Display restore failed ($restoreMotionMode)" }
    }
  }
  $motionInfo.restoredHz = ([MotionDisplay]::Current($motionDisplay.name)).frequency
  if ($NativeDpi) {
    $restoredNativeDpi = [MotionDpi]::Read($motionSource)
    $motionInfo.restoredScalePercent = $motionDpiScales[$restoredNativeDpi.current - $restoredNativeDpi.min]
    if ($restoredNativeDpi.current -ne $originalNativeDpi.current) { throw 'Native DPI restore failed' }
  }
  if (Test-Path -LiteralPath $Out) { $motionInfo | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Out 'display.json') -Encoding utf8 }
  Write-Output ('Display restored: ' + ($motionInfo | ConvertTo-Json -Compress))
}
exit $motionExit
