// Windows-only WebView2 shell. C# 5 / .NET Framework 4.6.2, no elevation.
using System;
using System.IO;
using System.Text;
using System.Net;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Security.AccessControl;
using System.Web.Script.Serialization;
using System.Collections.Generic;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

public sealed class HubWindow : Form {
  readonly JavaScriptSerializer json = new JavaScriptSerializer();
  readonly Dictionary<string,object> config;
  readonly WebView2 view = new WebView2();
  readonly Label status = new Label();
  readonly System.Windows.Forms.Timer watch = new System.Windows.Forms.Timer();
  Process server;
  string origin, instance;
  bool closing, confirmed, failed, starting=true, quitAccepted, polling;
  // External-workspace guards may spend up to ten seconds checking other servers.
  // Keep a bounded margin without skipping identity or workspace checks.
  const int RequestTimeoutMilliseconds=15000;
  Task pollTask=Task.FromResult(0);
  string quitStage="wait-poll";
  int exitCode=1;
  public int ExitCode { get { return exitCode; } }
  string Value(string key) { return (string)config[key]; }
  string Full(string path) { return Path.GetFullPath(path).TrimEnd('\\'); }
  bool Same(string a, string b) { return String.Equals(Full(a),Full(b),StringComparison.OrdinalIgnoreCase); }
  HubWindow(Dictionary<string,object> settings) {
    config=settings; origin="http://127.0.0.1:"+Convert.ToInt32(config["port"]);
    Icon=System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath);
    Text="Project Hub"; Width=1180; Height=820; MinimumSize=new System.Drawing.Size(720,480);
    status.Text="Project Hub を準備しています…"; status.AutoSize=false; status.Height=48; status.Dock=DockStyle.Top;
    view.Dock=DockStyle.Fill; view.Enabled=false; Controls.Add(view); Controls.Add(status);
    Shown+=async delegate { await Start(); };
    FormClosing+=async delegate(object sender,FormClosingEventArgs e) {
      if(confirmed) return;
      e.Cancel=true; if(starting) { status.Text="起動の準備が終わるまでお待ちください。"; return; } if(closing) return;
      closing=true; view.Enabled=false; watch.Stop();
      var wait=Stopwatch.StartNew(); quitStage="wait-poll";
      try {
        // An already-running status request must finish before the close identity
        // check. Poll observes closing after each await and starts no new request.
        await pollTask;
        QuitDiagnostic("wait-poll",wait,"settled");
        await Quit();
      } catch { Explain("終了を確認できません。窓を残します。"+QuitStageLabel()+"で停止しました。端末の記録を確認してください。"); }
      finally { closing=false; if(!confirmed&&!failed) { view.Enabled=true; watch.Start(); } }
    };
    watch.Interval=1000; watch.Tick+=async delegate {
      if(starting||closing||failed||confirmed||polling) return;
      polling=true;
      try { pollTask=Poll(); await pollTask; }
      finally { polling=false; }
    };
    FormClosed+=delegate { watch.Stop(); view.Dispose(); if(server!=null) server.Dispose(); };
  }
  async Task Poll() {
    try {
      if(server!=null&&server.HasExited) {
        if(server.ExitCode==42) { exitCode=42; confirmed=true; Close(); }
        else { failed=true; view.Enabled=false; Explain("本体が終了しました。保存結果は端末の記録を確認してください。窓は閉じられます。"); }
        return;
      }
      if(!await Identity(false)||closing) return;
      var update=await Request("/api/app-update",null); object phase, restart;
      if(closing) return;
      if(update.status==200&&update.body.TryGetValue("phase",out phase)&&Convert.ToString(phase)=="installed"&&
        update.body.TryGetValue("restartNeeded",out restart)&&restart is bool&&(bool)restart) {
        string allowed=await view.CoreWebView2.ExecuteScriptAsync("typeof appUpdateMayRestart === 'function' && appUpdateMayRestart()");
        if(allowed!="true"||closing) return;
        closing=true; view.Enabled=false;
        try { await Quit("update"); } finally { closing=false; if(!confirmed&&!failed) view.Enabled=true; }
      }
    } catch { /* read-only readiness/status is retried; never replay user writes */ }
  }
  void QuitDiagnostic(string stage, Stopwatch elapsed, string result) {
    // Only fixed stage/result codes and timings: no identity, paths, body or raw exception.
    Console.Error.WriteLine("HUB_WINDOW_QUIT_DIAGNOSTIC stage="+stage+" elapsedMs="+elapsed.ElapsedMilliseconds+" result="+result);
  }
  string QuitStageLabel() {
    if(quitStage=="wait-poll") return "画面の定期確認待ち";
    if(quitStage=="identity") return "起動した本体の一致確認";
    if(quitStage=="quit-request") return "本体への終了要求";
    return "本体と待受の停止確認";
  }
  void Explain(string text) { status.Text=text; status.Visible=true; Console.Error.WriteLine(text); }
  bool Internal(string value) {
    Uri u; return Uri.TryCreate(value,UriKind.Absolute,out u)&&u.Scheme=="http"&&u.Host=="127.0.0.1"&&u.Port==new Uri(origin).Port&&String.IsNullOrEmpty(u.UserInfo);
  }
  void Navigate(string value, bool user) {
    Uri u;
    if(!Uri.TryCreate(value,UriKind.Absolute,out u)) return;
    if(Internal(value)) { view.CoreWebView2.Navigate(value); return; }
    if(user&&(u.Scheme=="https"||u.Scheme=="http")&&String.IsNullOrEmpty(u.UserInfo)) {
      try { Process.Start(new ProcessStartInfo(value) { UseShellExecute=true }); }
      catch(Exception e) { Explain("外部のページを開けません："+e.Message); }
    } else Explain("この移動は専用窓では使えません。");
  }
  static void PrivateDirectory(string path) {
    for(string p=Path.GetFullPath(path);p!=null;p=Path.GetDirectoryName(p))
      if(Directory.Exists(p)&&(File.GetAttributes(p)&FileAttributes.ReparsePoint)!=0) throw new Exception("profile_reparse_point");
    Directory.CreateDirectory(path);
    var sid=WindowsIdentity.GetCurrent().User; var acl=new DirectorySecurity();
    acl.SetOwner(sid); acl.SetAccessRuleProtection(true,false);
    acl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
    Directory.SetAccessControl(path,acl);
    var actual=Directory.GetAccessControl(path);
    if(!actual.AreAccessRulesProtected||actual.GetOwner(typeof(SecurityIdentifier)).Value!=sid.Value) throw new Exception("profile_acl_unconfirmed");
  }
  async Task Start() {
    try { await StartCore(); }
    finally { starting=false; }
  }
  async Task StartCore() {
    bool quitFailedUpdate=false;
    try {
      // Check Runtime before starting a server. Never install or elevate.
      string runtime=CoreWebView2Environment.GetAvailableBrowserVersionString(null);
      if(String.IsNullOrEmpty(runtime)) throw new Exception("WebView2 Runtime が見つかりません。start.cmd のブラウザ版を使ってください。");
      PrivateDirectory(Value("profile"));
      var environment=await CoreWebView2Environment.CreateAsync(null,Value("profile"),null);
      await view.EnsureCoreWebView2Async(environment);
      var core=view.CoreWebView2;
      await core.Profile.ClearBrowsingDataAsync(CoreWebView2BrowsingDataKinds.DiskCache);
      core.Settings.AreDevToolsEnabled=false; core.Settings.AreDefaultContextMenusEnabled=false;
      core.Settings.AreHostObjectsAllowed=false; core.Settings.IsWebMessageEnabled=false;
      core.Settings.IsStatusBarEnabled=false;
      core.NavigationStarting+=delegate(object sender,CoreWebView2NavigationStartingEventArgs e) {
        if(!Internal(e.Uri)) { e.Cancel=true; Navigate(e.Uri,e.IsUserInitiated); }
      };
      core.FrameNavigationStarting+=delegate(object sender,CoreWebView2NavigationStartingEventArgs e) { if(!Internal(e.Uri)) e.Cancel=true; };
      core.NewWindowRequested+=delegate(object sender,CoreWebView2NewWindowRequestedEventArgs e) { e.Handled=true; Navigate(e.Uri,e.IsUserInitiated); };
      core.DownloadStarting+=delegate(object sender,CoreWebView2DownloadStartingEventArgs e) { e.Cancel=true; Explain("専用窓からのダウンロードには対応していません。"); };
      core.PermissionRequested+=async delegate(object sender,CoreWebView2PermissionRequestedEventArgs e) {
        e.State=CoreWebView2PermissionState.Deny;
        e.SavesInProfile=false;
        if(e.PermissionKind!=CoreWebView2PermissionKind.Microphone||!e.IsUserInitiated||!Internal(e.Uri)||!Internal(core.Source)) return;
        var permission=e.GetDeferral();
        try {
          string ticket=await core.ExecuteScriptAsync("window.HubVoice?.permissionTicket() || ''");
          if(String.IsNullOrEmpty(ticket)||ticket=="\"\""||ticket=="null"||!Internal(core.Source)||closing||failed) return;
          if(MessageBox.Show(this,"音声入力のためにマイクを使います。音声はブラウザ提供元などで処理される場合があります。", "音声入力",MessageBoxButtons.OKCancel,MessageBoxIcon.Question)!=DialogResult.OK) return;
          // Recheck after the dialog: navigation or sending may have invalidated the original request.
          string pending=await core.ExecuteScriptAsync("window.HubVoice?.permissionTicket() || ''");
          if(pending==ticket&&Internal(core.Source)&&!closing&&!failed) e.State=CoreWebView2PermissionState.Allow;
        } catch { /* Deny on navigation, unsupported runtime or script failure. */ }
        finally { permission.Complete(); }
      };
      // WebSocket bypasses this event. The backend's win32-window-policy
      // sends an explicit HTTP-only connect-src for this launch/port instead.
      // Do not rely on this resource handler to block WebSocket handshakes.
      core.AddWebResourceRequestedFilter("*",CoreWebView2WebResourceContext.All);
      core.WebResourceRequested+=async delegate(object sender,CoreWebView2WebResourceRequestedEventArgs e) {
        string u=e.Request.Uri;
        if(Internal(u)) {
          var defer=e.GetDeferral();
          try {
            if(!await Identity(false)) e.Response=environment.CreateWebResourceResponse(new MemoryStream(new byte[0]),403,"Unverified Hub","Content-Type: text/plain");
            else if(e.ResourceContext==CoreWebView2WebResourceContext.Document&&(new Uri(u).AbsolutePath=="/"||new Uri(u).AbsolutePath=="/index.html")) e.Request.Headers.SetHeader("X-Hub-Token",OwnerMac("local-api"));
          }
          catch { e.Response=environment.CreateWebResourceResponse(new MemoryStream(new byte[0]),403,"Unverified Hub","Content-Type: text/plain"); }
          finally { defer.Complete(); }
          return;
        }
        if(!Internal(u)&&!u.StartsWith("data:",StringComparison.OrdinalIgnoreCase)&&!(u.StartsWith("blob:",StringComparison.OrdinalIgnoreCase)&&Internal(u.Substring(5))))
          e.Response=environment.CreateWebResourceResponse(new MemoryStream(new byte[0]),403,"Blocked","Content-Type: text/plain");
      };
      core.ProcessFailed+=delegate { failed=true; view.Enabled=false; Explain("画面の表示部品が停止しました。閉じる操作で本体の安全な終了を確認してください。"); };
      // Check port after acquiring the root mutex, never attach to an existing server.
      var probe=new System.Net.Sockets.TcpListener(IPAddress.Loopback,Convert.ToInt32(config["port"]));
      probe.Server.ExclusiveAddressUse=true; try { probe.Start(); } finally { probe.Stop(); }
      var start=new ProcessStartInfo(Value("node"),"\""+Path.Combine(Value("runtime"),"server.js")+"\"");
      start.UseShellExecute=false; start.CreateNoWindow=true; start.WorkingDirectory=Value("runtime");
      start.RedirectStandardOutput=true; start.RedirectStandardError=true;
      start.StandardOutputEncoding=Encoding.UTF8; start.StandardErrorEncoding=Encoding.UTF8;
      start.EnvironmentVariables["HUB_ROOT"]=Value("root"); start.EnvironmentVariables["HUB_PORT"]=Convert.ToString(config["port"]);
      start.EnvironmentVariables["HUB_WINDOW_LAUNCH"]=Value("nonce");
      start.EnvironmentVariables["HUB_UPDATE_BOOTSTRAP"]=Value("bootstrap");
      start.EnvironmentVariables["HUB_UPDATE_CONFIRM"]=Value("updateConfirm");
      server=new Process(); server.StartInfo=start;
      server.OutputDataReceived+=delegate(object sender,DataReceivedEventArgs e) { if(e.Data!=null) Console.WriteLine(e.Data); };
      server.ErrorDataReceived+=delegate(object sender,DataReceivedEventArgs e) { if(e.Data!=null) Console.Error.WriteLine(e.Data); };
      try { if(!server.Start()) throw new Exception("server_start_failed"); }
      catch { server.Dispose(); server=null; throw; }
      server.BeginOutputReadLine(); server.BeginErrorReadLine(); watch.Start();
      var deadline=DateTime.UtcNow.AddSeconds(60);
      while(DateTime.UtcNow<deadline&&!server.HasExited) {
        try { if(await Identity(true)) { var cookie=core.CookieManager.CreateCookie("hub_owner_"+Convert.ToInt32(config["port"]),Guid.NewGuid().ToString("N"),"127.0.0.1","/"); cookie.Expires=DateTime.UtcNow.AddHours(8); cookie.IsHttpOnly=true; cookie.SameSite=CoreWebView2CookieSameSiteKind.Lax; core.CookieManager.AddOrUpdateCookie(cookie); view.Enabled=true; core.Navigate(origin); status.Text=""; status.Visible=false; Console.WriteLine("保存先："+Value("root")); return; } }
        catch(WebException) { } // GET readiness only; no mutation replay.
        catch(IOException) { } // Owner record publication may still be in progress.
        catch(System.Security.SecurityException) { }
        catch(UnauthorizedAccessException) { }
        await Task.Delay(400);
      }
      throw new Exception("準備を確認できません。自動で強制終了しません。端末の記録を確認してください。");
    } catch(WebView2RuntimeNotFoundException) {
      failed=true; view.Enabled=false;
      Explain("起動を止めました：WebView2 Runtime が見つかりません。start.cmd のブラウザ版を使ってください。");
      if(!String.IsNullOrEmpty(Value("updateConfirm"))&&server==null) { confirmed=true; Close(); }
    } catch(Exception e) {
      failed=true; view.Enabled=false; Explain("起動を止めました："+e.Message);
      // Rollback is permitted only after the owned backend has stopped. If its
      // safe quit cannot be confirmed, keep this window and the journal intact.
      quitFailedUpdate=!String.IsNullOrEmpty(Value("updateConfirm"));
    }
    // The in-box C# 5 compiler cannot await inside a catch. Keep startup held
    // until the same safe quit has settled, then let Start release it in finally.
    if(quitFailedUpdate) {
      try { await Quit(); } catch { Explain("新版の終了を確認できません。前の版は保持しています。窓と記録を確認してください。"); }
    }
  }
  sealed class Reply { public int status; public Dictionary<string,object> body; }
  Task<Reply> Request(string route, object body, string diagnosticStage=null) {
    return Task.Run(delegate {
      var elapsed=Stopwatch.StartNew(); string result="failed";
      try {
        var r=(HttpWebRequest)WebRequest.Create(origin+route);
        r.Proxy=null; r.AllowAutoRedirect=false; r.Timeout=RequestTimeoutMilliseconds; r.ReadWriteTimeout=RequestTimeoutMilliseconds; r.KeepAlive=false;
        if(!route.StartsWith("/api/ping?challenge=",StringComparison.Ordinal)) r.Headers["X-Hub-Token"]=OwnerMac("local-api");
        if(body!=null) {
          r.Method="POST"; r.Headers["X-Hub"]="1"; r.ContentType="application/json";
          byte[] bytes=Encoding.UTF8.GetBytes(json.Serialize(body)); r.ContentLength=bytes.Length;
          using(var s=r.GetRequestStream()) s.Write(bytes,0,bytes.Length);
        }
        HttpWebResponse response;
        try { response=(HttpWebResponse)r.GetResponse(); }
        catch(WebException e) { if(e.Response==null) throw; response=(HttpWebResponse)e.Response; }
        using(response) using(var reader=new StreamReader(response.GetResponseStream(),Encoding.UTF8)) {
          string text=reader.ReadToEnd(); if(text.Length>1048576) throw new Exception("response_too_large");
          var reply=new Reply { status=(int)response.StatusCode, body=json.Deserialize<Dictionary<string,object>>(text) };
          result="http_"+reply.status; return reply;
        }
      } catch(WebException e) { result="web_"+e.Status.ToString(); throw; }
      finally { if(diagnosticStage!=null) QuitDiagnostic(diagnosticStage,elapsed,result); }
    });
  }

  string OwnerSecret() {
    string dir=Environment.GetEnvironmentVariable("HUB_AUTH_DIR");
    if(String.IsNullOrEmpty(dir)) dir=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"ProjectHub","run");
    for(string p=dir;p!=null;p=Path.GetDirectoryName(p))
      if(Directory.Exists(p)&&(File.GetAttributes(p)&FileAttributes.ReparsePoint)!=0) throw new Exception("owner_path_reparse");
    string file=Path.Combine(dir,"owner-"+Convert.ToInt32(config["port"])+".json");
    if((File.GetAttributes(file)&FileAttributes.ReparsePoint)!=0) throw new Exception("owner_file_reparse");
    var sid=WindowsIdentity.GetCurrent().User;
    foreach(FileSystemSecurity acl in new FileSystemSecurity[] { Directory.GetAccessControl(dir),File.GetAccessControl(file) }) {
      if(acl.GetOwner(typeof(SecurityIdentifier)).Value!=sid.Value) throw new Exception("owner_acl");
      foreach(FileSystemAccessRule rule in acl.GetAccessRules(true,true,typeof(SecurityIdentifier)))
        if(rule.AccessControlType==AccessControlType.Allow&&rule.IdentityReference.Value!=sid.Value) throw new Exception("owner_acl");
    }
    var record=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(file,Encoding.UTF8));
    string token=(string)record["token"];
    if(token.Length!=64||Convert.ToInt32(record["pid"])!=server.Id) throw new Exception("owner_file_mismatch");
    return token;
  }
  string OwnerMac(string message) {
    string token=OwnerSecret(); byte[] key=new byte[32];
    for(int i=0;i<32;i++) key[i]=Convert.ToByte(token.Substring(i*2,2),16);
    using(var hmac=new HMACSHA256(key)) return BitConverter.ToString(hmac.ComputeHash(Encoding.UTF8.GetBytes(message))).Replace("-","").ToLowerInvariant();
  }
  async Task<bool> Identity(bool state, string diagnosticStage=null) {
    if(server==null||server.HasExited) return false;
    string challenge=Guid.NewGuid().ToString("N");
    var proof=await Request("/api/ping?challenge="+challenge,null,diagnosticStage); object pi,signature;
    if(proof.status!=200||!proof.body.TryGetValue("instance",out pi)||!proof.body.TryGetValue("proof",out signature)||
      OwnerMac(challenge+"\n"+Convert.ToString(pi)+"\n"+Convert.ToInt32(config["port"]))!=Convert.ToString(signature)) return false;
    var r=await Request("/api/ping",null,diagnosticStage); var b=r.body;
    if(r.status!=200||Convert.ToInt32(b["pid"])!=server.Id||!Same((string)b["runtimePath"],Value("runtime"))||
      !Same((string)b["windowRoot"],Value("root"))||(string)b["windowLaunch"]!=Value("nonce")||String.IsNullOrEmpty((string)b["instance"])) return false;
    if(instance==null) instance=(string)b["instance"];
    if(instance!=(string)b["instance"]||server.HasExited) return false;
    return !state||(await Request("/api/state",null)).status==200;
  }
  async Task Quit(string reason="windows-window") {
    if(server==null || (server.HasExited && (!quitAccepted || server.ExitCode!=0))) {
      // The backend is already gone: allow dismissal, but never report success.
      if(server!=null) Explain("本体の正常終了を確認できません。保存成功とは扱わず窓を閉じます。");
      confirmed=true; Close(); return;
    }
    if(!quitAccepted) {
      quitStage="identity";
      if(!await Identity(false,"identity")) throw new Exception("起動した本体の一致を確認できません。");
      quitStage="quit-request";
      var response=await Request("/api/quit",new { reason=reason, instance=instance, windowLaunch=Value("nonce") },"quit-request");
      if(response.status!=200) { object error; Explain(response.body.TryGetValue("error",out error)?Convert.ToString(error):"本体が終了を受け付けませんでした。"); return; }
      quitAccepted=true;
    }
    quitStage="stop-confirmation"; var elapsed=Stopwatch.StartNew();
    var deadline=DateTime.UtcNow.AddSeconds(10);
    try {
      while(DateTime.UtcNow<deadline) {
        if(server.HasExited) {
          if(server.ExitCode!=0) throw new Exception("本体が正常終了していません。端末の記録を確認してください。");
          bool listening=false;
          // A refused loopback connect may take seconds on Windows. Query the
          // kernel listener table instead of treating that delay as a live server.
          foreach(var endpoint in System.Net.NetworkInformation.IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners())
            if(endpoint.Port==Convert.ToInt32(config["port"])) { listening=true; break; }
          if(!listening) {
            if(failed) Explain("本体の停止を確認しました。起動または画面の異常があったため、専用窓は失敗として終了します。");
            else { Console.WriteLine("Project Hub が止まりました。"); exitCode=reason=="update"?42:0; }
            QuitDiagnostic("stop-confirmation",elapsed,"stopped");
            confirmed=true; Close(); return;
          }
        }
        await Task.Delay(200);
      }
      QuitDiagnostic("stop-confirmation",elapsed,"timeout");
      throw new TimeoutException("保存・本体の終了・待受停止をまだ確認できません。");
    } catch(TimeoutException) { throw; }
      catch { QuitDiagnostic("stop-confirmation",elapsed,"failed"); throw; }
  }
  [STAThread]
  public static int Main() {
    try {
      // A GUI process has redirected handles but may have no console. Read/write
      // UTF-8 streams directly; Console.*Encoding requires a console code page.
      Console.SetIn(new StreamReader(Console.OpenStandardInput(),new UTF8Encoding(false,true),false));
      Console.SetOut(new StreamWriter(Console.OpenStandardOutput(),new UTF8Encoding(false)) { AutoFlush=true });
      Console.SetError(new StreamWriter(Console.OpenStandardError(),new UTF8Encoding(false)) { AutoFlush=true });
      if(new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator)) throw new Exception("管理者として起動しないでください。普通の権限で開き直してください。");
      var config=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(Console.In.ReadToEnd());
      string name="Local\\ProjectHub-"+WindowsIdentity.GetCurrent().User.Value+"-"+(string)config["rootHash"];
      int result=1;
      using(var mutex=new Mutex(false,name)) {
        bool held=false;
        try { try { held=mutex.WaitOne(0); } catch(AbandonedMutexException) { held=true; }
          if(!held) throw new Exception("同じ保存先の専用窓は既に起動しています。");
          Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
          using(var form=new HubWindow(config)) { Application.Run(form); result=form.ExitCode; }
        } finally { if(held) mutex.ReleaseMutex(); }
      }
      return result;
    } catch(Exception e) { Console.Error.WriteLine(e.Message); MessageBox.Show(e.Message,"Project Hub",MessageBoxButtons.OK,MessageBoxIcon.Error); return 1; }
  }
}
