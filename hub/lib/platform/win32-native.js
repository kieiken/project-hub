'use strict';
// Windows-only bridge. Code is fixed locally; paths/requests travel as JSON on
// stdin, never through a command interpreter. No downloads, RunAs or token changes.
const cp = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const source = String.raw`
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Security.AccessControl;
using Microsoft.Win32.SafeHandles;
public static class HubWindows {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct Entry {
    public uint size, usage, pid; public UIntPtr heap; public uint module, threads, ppid;
    public int priority; public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string exe;
  }
  [StructLayout(LayoutKind.Sequential)] struct Times { public uint low, high; }
  [StructLayout(LayoutKind.Sequential)] struct Info {
    public uint attributes; public Times created, accessed, written;
    public uint serial, sizeHigh, sizeLow, links, indexHigh, indexLow;
  }
  public class Row { public int pid, ppid; public string sid, since, command; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool Process32FirstW(IntPtr h, ref Entry e);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool Process32NextW(IntPtr h, ref Entry e);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr h, out Times created, out Times exit, out Times kernel, out Times user);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageNameW(IntPtr h, uint flags, StringBuilder name, ref uint size);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr h, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr data, int size, out int needed);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr h, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h, uint milliseconds);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFileW(string p, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool FlushFileBuffers(SafeFileHandle h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h, out Info info);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle h, StringBuilder name, uint size, uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetVolumePathNameW(string p, StringBuilder volume, uint size);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetVolumeNameForVolumeMountPointW(string root, StringBuilder volume, uint size);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetVolumeInformationW(string root, StringBuilder label, uint labelSize, out uint serial, out uint max, out uint flags, StringBuilder fs, uint fsSize);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern uint GetDriveTypeW(string root);
  static Exception Error() { return new Win32Exception(Marshal.GetLastWin32Error()); }
  static void Check(bool ok) { if (!ok) throw Error(); }
  static Row Inspect(IntPtr h, int pid, int parent) {
    Times c,e,k,u; Check(GetProcessTimes(h,out c,out e,out k,out u));
    var image=new StringBuilder(32768); uint size=(uint)image.Capacity;
    Check(QueryFullProcessImageNameW(h,0,image,ref size));
    IntPtr token; Check(OpenProcessToken(h,8,out token));
    string sid;
    try {
      int count; GetTokenInformation(token,1,IntPtr.Zero,0,out count);
      if(count<=0) throw Error();
      IntPtr buffer=Marshal.AllocHGlobal(count);
      try { Check(GetTokenInformation(token,1,buffer,count,out count)); sid=new SecurityIdentifier(Marshal.ReadIntPtr(buffer)).Value; }
      finally { Marshal.FreeHGlobal(buffer); }
    } finally { CloseHandle(token); }
    long ticks=((long)c.high<<32)|c.low;
    return new Row { pid=pid,ppid=parent,sid=sid,since=DateTime.FromFileTimeUtc(ticks).ToString("O"),command=image.ToString() };
  }
  public static Row[] Snapshot() {
    IntPtr snapshot=CreateToolhelp32Snapshot(2,0);
    if(snapshot==new IntPtr(-1)) throw Error();
    var rows=new List<Row>();
    try {
      Entry e=new Entry(); e.size=(uint)Marshal.SizeOf(typeof(Entry));
      Check(Process32FirstW(snapshot,ref e));
      do {
        if(e.pid<=1) continue;
        IntPtr h=OpenProcess(0x1000|0x100000,false,(int)e.pid);
        if(h==IntPtr.Zero) continue; // inaccessible identity is absent, never guessed
        try { if(WaitForSingleObject(h,0)==258) rows.Add(Inspect(h,(int)e.pid,(int)e.ppid)); }
        catch(Win32Exception) { /* inaccessible/exited processes cannot be targets */ }
        finally { CloseHandle(h); }
      } while(Process32NextW(snapshot,ref e));
      int error=Marshal.GetLastWin32Error(); if(error!=18) throw new Win32Exception(error);
    } finally { CloseHandle(snapshot); }
    return rows.ToArray();
  }
  public static bool Stop(int pid, string sid, string since, string image, bool probe, int caller) {
    if(pid<=1||pid==caller||String.IsNullOrEmpty(sid)||String.IsNullOrEmpty(since)||String.IsNullOrEmpty(image)) throw new Exception("identity_missing");
    // Open once; inspect and terminate the SAME kernel process object. No taskkill /T.
    IntPtr h=OpenProcess(0x1000u|0x100000u|(probe?0u:1u),false,pid);
    if(h==IntPtr.Zero) throw Error();
    try {
      var row=Inspect(h,pid,0);
      if(row.sid!=sid||row.since!=since||row.command!=image||sid!=WindowsIdentity.GetCurrent().User.Value) throw new Exception("identity_changed");
      if(WaitForSingleObject(h,0)!=258) throw new Exception("process_exited");
      if(!probe) Check(TerminateProcess(h,1));
      return true;
    } finally { CloseHandle(h); }
  }
  static string Local(string p, bool directory) {
    if(String.IsNullOrEmpty(p)||p.Length<3||!Char.IsLetter(p[0])||p[1]!=':'||p[2]!='\\'||p.IndexOf(':',2)>=0) throw new Exception("local_drive_required");
    string full=Path.GetFullPath(p);
    if(directory&&!Directory.Exists(full)) throw new DirectoryNotFoundException(full);
    if(!directory&&!File.Exists(full)) throw new FileNotFoundException(full);
    // Reject junctions, symbolic links and cloud placeholders, including ancestors.
    for(string current=full;current!=null;current=Path.GetDirectoryName(current))
      if((File.GetAttributes(current)&FileAttributes.ReparsePoint)!=0) throw new Exception("reparse_point_unsupported");
    return full;
  }
  static SafeFileHandle Open(string p, uint access, uint share, uint flags) {
    var h=CreateFileW(p,access,share,IntPtr.Zero,3,flags,IntPtr.Zero);
    if(h.IsInvalid) { var error=Error(); h.Dispose(); throw error; } return h;
  }
  // Documented whole-volume FlushFileBuffers covers namespace changes as well
  // as data. Existing rights only: opening a volume for write commonly fails
  // without an already elevated token. No SetPrivilege / runas / fallback.
  public static string ValidateDirectory(string p, string expected, bool flush) {
    string full=Local(p,true);
    using(var parent=Open(full,0x80,3,0x02000000)) {
      var mount=new StringBuilder(1024); Check(GetVolumePathNameW(full,mount,1024));
      if(GetDriveTypeW(mount.ToString())!=3) throw new Exception("fixed_local_volume_required");
      uint serial,max,flags; var filesystem=new StringBuilder(64);
      Check(GetVolumeInformationW(mount.ToString(),null,0,out serial,out max,out flags,filesystem,64));
      if(filesystem.ToString()!="NTFS") throw new Exception("ntfs_required");
      var volume=new StringBuilder(1024); Check(GetVolumeNameForVolumeMountPointW(mount.ToString(),volume,1024));
      var final=new StringBuilder(32768); uint length=GetFinalPathNameByHandleW(parent,final,(uint)final.Capacity,1);
      if(length==0) throw Error();
      if(length>=final.Capacity||!final.ToString().StartsWith(volume.ToString(),StringComparison.OrdinalIgnoreCase)) throw new Exception("volume_changed");
      Info info; Check(GetFileInformationByHandle(parent,out info));
      if((info.attributes&0x10)==0||(info.attributes&0x400)!=0||info.serial!=serial||(info.indexHigh==0&&info.indexLow==0)) throw new Exception("directory_identity_unavailable");
      string binding=volume.ToString()+"|"+info.serial+"|"+info.indexHigh+":"+info.indexLow;
      if(!String.IsNullOrEmpty(expected)&&binding!=expected) throw new Exception("directory_changed");
      if(flush) using(var disk=Open(volume.ToString().TrimEnd('\\'),0x40000000,3,0)) Check(FlushFileBuffers(disk));
      return binding;
    }
  }
  public static bool PrivateDirectory(string p, bool create) {
    string binding=ValidateDirectory(p,null,false), full=Path.GetFullPath(p);
    var sid=WindowsIdentity.GetCurrent().User;
    var trusted=new HashSet<string>(StringComparer.Ordinal) { sid.Value,"S-1-5-18","S-1-5-32-544","S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464" };
    var replace=FileSystemRights.Delete|FileSystemRights.DeleteSubdirectoriesAndFiles|FileSystemRights.ChangePermissions|FileSystemRights.TakeOwnership;
    for(var parent=Directory.GetParent(full);parent!=null;parent=parent.Parent) {
      var acl=Directory.GetAccessControl(parent.FullName);
      if(!trusted.Contains(acl.GetOwner(typeof(SecurityIdentifier)).Value)) throw new Exception("update_parent_owner");
      foreach(FileSystemAccessRule rule in acl.GetAccessRules(true,true,typeof(SecurityIdentifier)))
        if((rule.PropagationFlags&PropagationFlags.InheritOnly)==0&&rule.AccessControlType==AccessControlType.Allow&&(rule.FileSystemRights&replace)!=0&&!trusted.Contains(rule.IdentityReference.Value)) throw new Exception("update_parent_acl");
    }
    if(create) {
      var acl=new DirectorySecurity(); acl.SetOwner(sid); acl.SetAccessRuleProtection(true,false);
      acl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
      Directory.SetAccessControl(full,acl);
    }
    var actual=Directory.GetAccessControl(full);
    if(!actual.AreAccessRulesProtected||actual.GetOwner(typeof(SecurityIdentifier)).Value!=sid.Value) throw new Exception("update_acl");
    var rules=actual.GetAccessRules(true,true,typeof(SecurityIdentifier));
    if(rules.Count!=1) throw new Exception("update_acl");
    var only=(FileSystemAccessRule)rules[0];
    if(only.IdentityReference.Value!=sid.Value||only.AccessControlType!=AccessControlType.Allow||(only.FileSystemRights&FileSystemRights.FullControl)!=FileSystemRights.FullControl) throw new Exception("update_acl");
    ValidateDirectory(full,binding,false);
    return true;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool MoveFileExW(string from, string to, uint flags);
  public static bool Rename(string from, string to) {
    bool directory=Directory.Exists(from);
    string source=Local(from,directory), destination=Path.GetFullPath(to);
    if(source.Equals(destination,StringComparison.OrdinalIgnoreCase)) throw new Exception("rename_same_path");
    string parent=Path.GetDirectoryName(destination), sourceParent=Path.GetDirectoryName(source);
    string before=ValidateDirectory(parent,null,false), origin=ValidateDirectory(sourceParent,null,false);
    if(before.Split('|')[0]!=origin.Split('|')[0]) throw new Exception("rename_same_volume_required");
    if(File.Exists(destination)) Local(destination,false);
    if(Directory.Exists(destination)) Local(destination,true);
    if(!directory) FlushFile(source);
    // No COPY_ALLOWED: cross-volume copying would lose atomic replacement.
    Check(MoveFileExW(source,destination,0x1|0x8));
    ValidateDirectory(parent,before,false); ValidateDirectory(sourceParent,origin,false);
    return true;
  }
  public static bool FlushFile(string p) {
    string full=Local(p,false);
    // OPEN_EXISTING + GENERIC_WRITE, no truncation and no concurrent rename/write.
    using(var file=Open(full,0x40000000,1,0x00200000)) {
      Info info; Check(GetFileInformationByHandle(file,out info));
      if((info.attributes&(0x10|0x400))!=0) throw new Exception("regular_file_required");
      Check(FlushFileBuffers(file));
    }
    return true;
  }
}
`;

// License secrets are additionally DPAPI CurrentUser protected, then kept in
// the current user's local-machine Credential Manager (never a plaintext file).
const licenseSource = String.raw`
public static class HubWindowsLicense {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct Credential {
    public uint flags,type; public string target,comment; public long written;
    public uint size; public IntPtr blob; public uint persist,count;
    public IntPtr attributes; public string alias,user;
  }
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool Read(string target,uint type,uint flags,out IntPtr credential);
  [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool Write(ref Credential credential,uint flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr credential);
  [DllImport("kernel32.dll")] static extern ulong GetTickCount64();
  static readonly UTF8Encoding Utf8=new UTF8Encoding(false,true);
  static string Target(string account) {
    if(account==null||!System.Text.RegularExpressions.Regex.IsMatch(account,@"\Adevice-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\z")) throw new Exception("secret_account_invalid");
    return "ProjectHub.License.v1/"+account;
  }
  static byte[] Hash(string value) { using(var h=System.Security.Cryptography.SHA256.Create()) return h.ComputeHash(Utf8.GetBytes(value)); }
  public static string MachineHint() {
    using(var root=Microsoft.Win32.RegistryKey.OpenBaseKey(Microsoft.Win32.RegistryHive.LocalMachine,Microsoft.Win32.RegistryView.Registry64))
    using(var key=root.OpenSubKey(@"SOFTWARE\Microsoft\Cryptography",false)) {
      string value=key==null?null:key.GetValue("MachineGuid") as string; Guid guid;
      if(!Guid.TryParse(value,out guid)||guid==Guid.Empty) throw new Exception("machine_hint_unavailable");
      return Convert.ToBase64String(Hash("ProjectHub.PersonalTrial.v1\0windows\0"+guid.ToString("D"))).TrimEnd('=').Replace('+','-').Replace('/','_');
    }
  }
  static byte[] Entropy(string account) { return Hash(Target(account)+"\0"+MachineHint()+"\0"+WindowsIdentity.GetCurrent().User.Value); }
  public static string Get(string account) {
    string target=Target(account); IntPtr ptr;
    if(!Read(target,1,0,out ptr)) {
      if(Marshal.GetLastWin32Error()==1168) return null;
      throw new Exception("secret_read_failed");
    }
    try {
      var item=(Credential)Marshal.PtrToStructure(ptr,typeof(Credential));
      if(item.type!=1||item.persist!=2||item.target!=target||item.size==0||item.size>2560) throw new Exception("secret_invalid");
      var blob=new byte[item.size]; Marshal.Copy(item.blob,blob,0,blob.Length);
      var plain=System.Security.Cryptography.ProtectedData.Unprotect(blob,Entropy(account),System.Security.Cryptography.DataProtectionScope.CurrentUser);
      try { return Utf8.GetString(plain); } finally { Array.Clear(plain,0,plain.Length); }
    } finally { CredFree(ptr); }
  }
  public static bool Put(string account,string value) {
    string target=Target(account);
    // Serialize check+create across Hub processes; existing/corrupt keys must
    // never be overwritten. No enterprise roaming and no machine-wide DPAPI.
    string mutexName="Local\\ProjectHub.License."+BitConverter.ToString(Hash(target+WindowsIdentity.GetCurrent().User.Value)).Replace("-","");
    using(var mutex=new System.Threading.Mutex(false,mutexName)) {
      bool held=false;
      try {
        held=mutex.WaitOne(10000); if(!held) throw new Exception("secret_busy");
        if(Get(account)!=null) throw new Exception("secret_exists");
        if(String.IsNullOrEmpty(value)) throw new Exception("secret_empty");
        byte[] plain=Utf8.GetBytes(value),blob;
        try { blob=System.Security.Cryptography.ProtectedData.Protect(plain,Entropy(account),System.Security.Cryptography.DataProtectionScope.CurrentUser); }
        finally { Array.Clear(plain,0,plain.Length); }
        if(blob.Length>2560) throw new Exception("secret_too_large");
        IntPtr data=Marshal.AllocHGlobal(blob.Length);
        try {
          Marshal.Copy(blob,0,data,blob.Length);
          var item=new Credential { type=1,target=target,size=(uint)blob.Length,blob=data,persist=2,user=WindowsIdentity.GetCurrent().User.Value };
          if(!Write(ref item,0)) throw new Exception("secret_write_failed");
        } finally { Marshal.FreeHGlobal(data); }
        if(Get(account)!=value) throw new Exception("secret_readback_failed");
        return true;
      } finally { if(held) mutex.ReleaseMutex(); }
    }
  }
  public static double Elapsed() { return GetTickCount64()/1000.0; }
  public static void Watch(System.Web.Script.Serialization.JavaScriptSerializer json,string id) {
    object gate=new object();
    Microsoft.Win32.PowerModeChangedEventHandler handler=(sender,args)=> {
      if(args.Mode!=Microsoft.Win32.PowerModes.Resume&&args.Mode!=Microsoft.Win32.PowerModes.Suspend) return;
      lock(gate) { Console.WriteLine(json.Serialize(new { ok=true,id=id,value=args.Mode==Microsoft.Win32.PowerModes.Suspend?"suspend":"resume" })); Console.Out.Flush(); }
    };
    Microsoft.Win32.SystemEvents.PowerModeChanged+=handler;
    try {
      Console.WriteLine(json.Serialize(new { ok=true,id=id,value="ready" })); Console.Out.Flush();
      System.Windows.Forms.Application.Run();
    } finally { Microsoft.Win32.SystemEvents.PowerModeChanged-=handler; }
  }
}
`;

// Fixed console dispatch retains license actions and guarded compilation.
// General directory checks/rename use the ordinary-rights Windows storage policy.
const program = String.raw`
public static class HubNativeProgram {
  [STAThread]
  public static int Main() {
    Console.InputEncoding=new UTF8Encoding(false); Console.OutputEncoding=new UTF8Encoding(false);
    var json=new System.Web.Script.Serialization.JavaScriptSerializer(); json.MaxJsonLength=8388608;
    string id=null;
    try {
      var r=json.Deserialize<Dictionary<string,object>>(Console.In.ReadToEnd());
      id=(string)r["id"]; if(String.IsNullOrEmpty(id)) throw new Exception("request_id_missing");
      object value;
      switch((string)r["action"]) {
        case "snapshot": value=HubWindows.Snapshot(); break;
        case "stop":
          var row=json.ConvertToType<HubWindows.Row>(r["row"]);
          value=HubWindows.Stop(row.pid,row.sid,row.since,row.command,(bool)r["probe"],Convert.ToInt32(r["caller"])); break;
        case "directory": value=HubWindows.ValidateDirectory((string)r["path"],r.ContainsKey("expected")?(string)r["expected"]:null,false); break;
        case "license-directory": value=HubWindows.ValidateDirectory((string)r["path"],r.ContainsKey("expected")?(string)r["expected"]:null,false); break;
        case "private-directory": value=HubWindows.PrivateDirectory((string)r["path"],(bool)r["create"]); break;
        case "rename": value=HubWindows.Rename((string)r["from"],(string)r["to"]); break;
        case "file": value=HubWindows.FlushFile((string)r["path"]); break;
        case "secret-get": value=HubWindowsLicense.Get((string)r["account"]); break;
        case "secret-put": value=HubWindowsLicense.Put((string)r["account"],(string)r["value"]); break;
        case "machine-hint": value=HubWindowsLicense.MachineHint(); break;
        case "clock": value=HubWindowsLicense.Elapsed(); break;
        case "watch": HubWindowsLicense.Watch(json,id); return 0;
        case "open":
          System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo((string)r["path"]) { UseShellExecute=true }); value=true; break;
        case "reveal":
          System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(Path.Combine(Environment.GetEnvironmentVariable("SystemRoot"),"explorer.exe"),"/select, \""+(string)r["path"]+"\"") { UseShellExecute=true }); value=true; break;
        case "pick":
          using(var d=new System.Windows.Forms.FolderBrowserDialog()) {
            d.Description=(string)r["prompt"]; value=d.ShowDialog()==System.Windows.Forms.DialogResult.OK?d.SelectedPath:"";
          } break;
        default: throw new Exception("unknown_action");
      }
      Console.WriteLine(json.Serialize(new { ok=true,id=id,value=value })); return 0;
    } catch(Exception e) {
      var win32=e as System.ComponentModel.Win32Exception;
      Console.WriteLine(json.Serialize(new { ok=false,id=id,error="NATIVE_OPERATION_FAILED",win32=win32==null?0:win32.NativeErrorCode })); return 1;
    }
  }
}
`;

const guardModule = require('./cache-guard');

const cleanup = new Set();
let exitAttached = false;
function track(close) {
  cleanup.add(close);
  if (exitAttached) return;
  exitAttached = true;
  process.once('exit', () => {
    for (const close of cleanup) try { close(); } catch (error) { process.stderr.write('Windows補助の一時ファイルを片付けられません。\n'); }
  });
}
function create(options = {}) {
  const systemRoot = options.systemRoot || process.env.SystemRoot || 'C:\\Windows';
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const run = options.execFileSync || cp.execFileSync, asyncRun = options.execFile || cp.execFile;
  const disk = options.fs || fs, paths = options.paths || path.win32;
  let guard, executable, digest, poisoned, closed = false, closingPromise, resolveClose, rejectClose, cleanupError;
  const watchers = new Set();
  function broken(error) {
    if (!poisoned) {
      const safe = diagnostic(error, 'native-call');
      poisoned = Object.assign(Error('Windows補助の確認を実行できません'), { code: 'windows_bridge_failed', stage: safe.stage, reasonCode: safe.errorCode,
        ...(safe.cacheDiagnostics ? { cacheDiagnostics: safe.cacheDiagnostics } : {}),
        ...(safe.ancestorDepth !== undefined ? { ancestorDepth: safe.ancestorDepth } : {}) });
    }
    return poisoned;
  }
  function close() {
    closed = true;
    if (cleanupError) throw cleanupError;
    if (watchers.size) {
      if (!closingPromise) closingPromise = new Promise((resolve, reject) => { resolveClose = resolve; rejectClose = reject; });
      for (const child of [...watchers]) child.kill();
      return closingPromise;
    }
    try {
      if (guard) { guard.close(); guard = undefined; }
      cleanup.delete(close); resolveClose?.();
    } catch (error) {
      cleanupError = broken(error);
      if (rejectClose) rejectClose(cleanupError); else throw cleanupError;
    }
    return closingPromise;
  }
  function ensure() {
    if (closed) throw Error('Windows補助は終了済みです');
    if (poisoned) throw poisoned;
    let phase = 'native-initialize';
    try {
      if (!options.execFileSync && (process.platform !== 'win32' || process.arch !== 'x64')) throw Error('Windows x64 が必要です');
      if (!executable) {
        const local = Object.hasOwn(options, 'localAppData') ? options.localAppData : process.env.LOCALAPPDATA;
        if (typeof local !== 'string' || !paths.isAbsolute(local) || local.includes('\0') ||
            paths === path.win32 && !/^[a-z]:[\\/]$/i.test(paths.parse(local).root)) throw Error('cache_root_invalid');
        const root = paths.normalize(local);
        guard = (options.guardFactory || guardModule.create)({ source: source + licenseSource + program, root, powershell,
          onDeath(error) { broken(error); for (const child of watchers) child.kill(); } });
        track(close); executable = guard.file;
        digest = crypto.createHash('sha256').update(disk.readFileSync(executable)).digest('hex');
        if (digest !== guard.digest) throw Object.assign(Error('guard digest'), { stage: 'guard-verify', reasonCode: 'GUARD_DIGEST_FAILED' });
      }
      guard.verify();
      if (!disk.lstatSync(executable).isFile() || disk.lstatSync(executable).isSymbolicLink() ||
          crypto.createHash('sha256').update(disk.readFileSync(executable)).digest('hex') !== digest) {
        throw Object.assign(Error('guard digest'), { stage: 'guard-verify', reasonCode: 'GUARD_DIGEST_FAILED' });
      }
      return executable;
    } catch (error) {
      const safe = diagnostic(error, phase);
      throw broken({ stage: safe.stage, reasonCode: safe.errorCode, cacheDiagnostics: safe.cacheDiagnostics, ancestorDepth: safe.ancestorDepth });
    }
  }
  function request(action, data) {
    const id = crypto.randomUUID();
    return { id, opts: { input: JSON.stringify({ ...data, action, id }), encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] } };
  }
  function decode(output, id, failed = false) {
    let result;
    try { result = JSON.parse(String(output).replace(/^\uFEFF/, '').trim()); }
    catch (error) { throw broken(error); }
    if (result?.id !== id || typeof result.ok !== 'boolean' || failed && result.ok) throw broken(Error('Windows補助の応答を確認できません'));
    if (!result.ok) throw Object.assign(Error('Windows native確認失敗'), { code: 'windows_native_failed', stage: 'native-call',
      reasonCode: [2,3,5,6,32,33,50,80,87,112,183,267,1314].includes(result.win32) ? 'WIN32_' + result.win32 : 'NATIVE_OPERATION_FAILED' });
    return result.value;
  }
  function failure(error, id) {
    // A timeout/signal is ambiguous even if stdout contains an apparent success.
    if (error.killed || error.signal || error.code === 'ETIMEDOUT') return broken(error);
    if (error.stdout) try { decode(error.stdout, id, true); } catch (cause) { return cause; }
    return broken(error);
  }
  return {
    call(action, data = {}) {
      const file = ensure(), { id, opts } = request(action, data);
      let output;
      try { output = run(file, [], opts); } catch (error) { throw failure(error, id); }
      ensure();
      return decode(output, id);
    },
    asyncCall(action, data = {}, callback) {
      const file = ensure(), { id, opts } = request(action, data);
      if (action === 'pick') opts.timeout = 0;
      let child, done = false;
      const finish = (error, value) => { if (!done) { done = true; callback(error, value); } };
      try {
        child = asyncRun(file, [], opts, (error, stdout) => {
          if (error) return finish(failure(Object.assign(error, { stdout }), id));
          try { ensure(); finish(null, decode(stdout, id)); } catch (cause) { finish(cause); }
        });
        watchers.add(child);
        child.once('close', () => { watchers.delete(child); if (closed) { try { close(); } catch (e) { finish(e); } } });
        child.stdin.once('error', error => finish(broken(error)));
        child.stdin.end(opts.input);
      } catch (error) { finish(broken(error)); }
      return child;
    },
    watch(onEvent, onError) {
      const file = ensure(), { id, opts } = request('watch', {});
      const child = (options.spawn || cp.spawn)(file, [], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
      watchers.add(child);
      let rest = '', stopping = false, ready = false;
      let confirmReady;
      const handshake = new Promise(resolve => { confirmReady = resolve; });
      const fail = error => { if (!stopping) { stopping = true; confirmReady(false); clearTimeout(deadline); onError?.(error); child.kill(); } };
      const deadline = setTimeout(fail, 30000); deadline.unref?.();
      child.stdout.on('data', data => {
        if (stopping) return;
        rest += data.toString('utf8');
        if (rest.length > 8192) return fail();
        const lines = rest.split('\n'); rest = lines.pop();
        for (const line of lines) try {
          const event = decode(line, id);
          // Suspend only invalidates trust. Do not start a guard RPC while the
          // OS is freezing its children; every ready/resume/use still verifies
          // the live guard and executable before it can enable any operation.
          if (event === 'suspend' && ready) { onEvent(event); continue; }
          ensure();
          if (event === 'ready' && !ready) { ready = true; confirmReady(true); clearTimeout(deadline); }
          else if ((event === 'resume' || event === 'suspend') && ready) onEvent(event);
          else fail();
        } catch (error) { fail(error); }
      });
      child.once('error', fail); child.stdin.once('error', fail);
      child.once('close', () => { watchers.delete(child); fail(); if (closed) close(); });
      child.stdin.end(opts.input);
      const stop = () => { stopping = true; confirmReady(false); clearTimeout(deadline); child.kill(); };
      stop.ready = handshake;
      return stop;
    },
    close,
  };
}
// Only these diagnostic values may cross into an acceptance result. Unknown
// errors (including private exception messages) collapse to a fixed code.
const stages = new Set(['setup','native-initialize','native-compile','native-call','storage-open','storage-commit','storage-read','storage-readback','storage-close',
  'guard-start','guard-ancestors','guard-base','guard-create','guard-dacl','guard-executable','guard-verify','guard-liveness','guard-cleanup',
  'trial','trial-cold-read','sleep-resume','rollback','expiry','purchase','purchase-cold-read','completed']);
const reasons = new Set([
  'GUARD_START_FAILED','GUARD_ROOT_REFUSED','GUARD_ROOT_LOCK_FAILED','GUARD_COMPONENT_REFUSED','GUARD_ACCESS_DENIED','GUARD_NAME_EXISTS','GUARD_SHARING_VIOLATION','GUARD_NOT_FOUND','GUARD_OPEN_FAILED','GUARD_QUERY_FAILED','GUARD_TYPE_REFUSED','GUARD_REPARSE_REFUSED','GUARD_LINK_COUNT','GUARD_DACL_FAILED','GUARD_DESCRIPTOR_FAILED','GUARD_SECURITY_READ_FAILED','GUARD_SECURITY_SIZE_FAILED','GUARD_DIGEST_FAILED','GUARD_IDENTITY_FAILED','GUARD_PROTOCOL_FAILED','GUARD_CLEANUP_FAILED','GUARD_OPERATION_FAILED','GUARD_EXITED','GUARD_TIMEOUT',
'CACHE_INIT_FAILED','CACHE_PERMISSIONS_UNSAFE','COMPILATION_FAILED','NATIVE_OPERATION_FAILED','NATIVE_BRIDGE_FAILED',
  'STORAGE_PATH_UNSAFE','STORAGE_PATH_CHANGED','STORAGE_LEGACY_PRESENT','STORAGE_UNRECOGNIZED','STORAGE_FORMAT_INVALID','STORAGE_DURABILITY_UNAVAILABLE',
  'STORAGE_DOCUMENT_INVALID','STORAGE_READBACK_FAILED','STORAGE_BUSY','STORAGE_READONLY','STORAGE_IO','STORAGE_CORRUPT','STORAGE_FULL','STORAGE_OPEN_FAILED',
  'STORAGE_FAILED','STORAGE_CLOSE_FAILED','CHECK_FAILED','RESULT_WRITE_FAILED',
  ...[2,3,5,6,32,33,50,80,87,112,183,267,1314].map(n => 'WIN32_' + n)]);
const cacheTargets = new Set(['cache-base', 'cache-directory', 'cache-file']);
const cacheOwners = new Set(['current-user', 'system', 'administrators', 'other', 'unknown']);
const writerCategories = ['everyone', 'authenticated-users', 'users', 'owner-rights', 'logon-session', 'app-capability',
  'other-local-account', 'domain-or-cloud-account', 'service', 'other-well-known', 'unknown'];
const countKeys = ['count', 'inherited', 'direct', 'tokenGroup', 'notTokenGroup', 'tokenGroupUnknown', 'deny', 'noDeny'];
function cacheDiagnostic(value) {
  if (!Array.isArray(value) || value.length > 3) return undefined;
  const targets = new Set(), result = [];
  for (const row of value) {
    if (!row || !cacheTargets.has(row.target) || targets.has(row.target) || !cacheOwners.has(row.owner) || typeof row.rulesRead !== 'boolean') return undefined;
    targets.add(row.target);
    const writers = {};
    for (const category of writerCategories) {
      const counts = row.writers?.[category];
      if (!counts || countKeys.some(key => !Number.isSafeInteger(counts[key]) || counts[key] < 0 || counts[key] > 65535) ||
          counts.count !== counts.inherited + counts.direct || counts.count !== counts.tokenGroup + counts.notTokenGroup + counts.tokenGroupUnknown ||
          counts.count !== counts.deny + counts.noDeny || !row.rulesRead && counts.count !== 0) return undefined;
      writers[category] = Object.fromEntries(countKeys.map(key => [key, counts[key]]));
    }
    result.push({ target: row.target, owner: row.owner, rulesRead: row.rulesRead, writers });
  }
  return result;
}
function diagnostic(error, fallback = 'setup') {
  const stage = stages.has(error?.stage) ? error.stage : stages.has(fallback) ? fallback : 'setup';
  const cache = stage === 'native-initialize' && error?.reasonCode === 'CACHE_PERMISSIONS_UNSAFE' ? cacheDiagnostic(error?.cacheDiagnostics) : undefined;
  return { stage, errorCode: reasons.has(error?.reasonCode) ? error.reasonCode : stage === 'native-compile' ? 'COMPILATION_FAILED'
    : stage.startsWith('guard-') ? 'GUARD_OPERATION_FAILED' : stage === 'native-initialize' ? 'CACHE_INIT_FAILED' : stage === 'native-call' ? 'NATIVE_BRIDGE_FAILED' : 'CHECK_FAILED',
    ...(cache?.length ? { cacheDiagnostics: cache } : {}),
    ...(stage.startsWith('guard-') && Number.isInteger(error?.ancestorDepth) && error.ancestorDepth >= 0 && error.ancestorDepth <= 256 ? { ancestorDepth: error.ancestorDepth } : {}) };
}
module.exports = { create, diagnostic };
