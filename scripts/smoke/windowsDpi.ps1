# Windows per-monitor DPI support for the optional native-scale acceptance run.
# The relative DPI query is Windows-specific; fail before editing if unsupported.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MotionDpi {
  [StructLayout(LayoutKind.Sequential)] public struct Luid { public uint low; public int high; }
  [StructLayout(LayoutKind.Sequential)] public struct Source { public Luid adapter; public uint id, mode, flags; }
  [StructLayout(LayoutKind.Sequential)] public struct Rational { public uint numerator, denominator; }
  [StructLayout(LayoutKind.Sequential)] public struct Target {
    public Luid adapter; public uint id, mode, technology, rotation, scaling;
    public Rational refresh; public uint scanline;
    [MarshalAs(UnmanagedType.Bool)] public bool available;
    public uint flags;
  }
  [StructLayout(LayoutKind.Sequential)] public struct Path { public Source source; public Target target; public uint flags; }
  [StructLayout(LayoutKind.Sequential)] public struct Header { public int type; public uint size; public Luid adapter; public uint id; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct SourceName {
    public Header header; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string name;
  }
  [StructLayout(LayoutKind.Sequential)] public struct Dpi { public Header header; public int min, current, max; }
  [StructLayout(LayoutKind.Sequential)] public struct SetDpi { public Header header; public int value; }
  [DllImport("user32.dll")] static extern int GetDisplayConfigBufferSizes(uint flags, out uint paths, out uint modes);
  [DllImport("user32.dll")] static extern int QueryDisplayConfig(uint flags, ref uint paths, IntPtr pathData, ref uint modes, IntPtr modeData, IntPtr topology);
  [DllImport("user32.dll", EntryPoint="DisplayConfigGetDeviceInfo", CharSet=CharSet.Unicode)] static extern int GetName(ref SourceName request);
  [DllImport("user32.dll", EntryPoint="DisplayConfigGetDeviceInfo")] public static extern int GetDpi(ref Dpi request);
  [DllImport("user32.dll", EntryPoint="DisplayConfigSetDeviceInfo")] public static extern int Set(ref SetDpi request);
  public static Source[] Sources() {
    uint paths, modes;
    int code=GetDisplayConfigBufferSizes(2, out paths, out modes);
    if(code!=0) throw new Exception("Display buffer error " + code);
    int stride=Marshal.SizeOf<Path>();
    IntPtr p=Marshal.AllocHGlobal((int)paths*stride), m=Marshal.AllocHGlobal((int)modes*64);
    try {
      code=QueryDisplayConfig(2, ref paths, p, ref modes, m, IntPtr.Zero);
      if(code!=0) throw new Exception("Display query error " + code);
      var result=new Source[paths];
      for(int i=0;i<paths;i++) result[i]=Marshal.PtrToStructure<Path>(IntPtr.Add(p,i*stride)).source;
      return result;
    } finally { Marshal.FreeHGlobal(p); Marshal.FreeHGlobal(m); }
  }
  public static Header H(Source s,int type,uint size) { return new Header {type=type,size=size,adapter=s.adapter,id=s.id}; }
  public static string Name(Source s) {
    var n=new SourceName {header=H(s,1,(uint)Marshal.SizeOf<SourceName>())};
    int code=GetName(ref n);
    if(code!=0) throw new Exception("Source name error " + code);
    return n.name;
  }
  public static Dpi Read(Source s) {
    var d=new Dpi {header=H(s,-3,(uint)Marshal.SizeOf<Dpi>())};
    int code=GetDpi(ref d);
    if(code!=0) throw new Exception("DPI query error " + code);
    return d;
  }
  public static void Apply(Source s,int relative) {
    var d=new SetDpi {header=H(s,-4,(uint)Marshal.SizeOf<SetDpi>()),value=relative};
    int code=Set(ref d);
    if(code!=0) throw new Exception("DPI set error " + code);
  }
}
'@
