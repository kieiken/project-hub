import Cocoa
import Darwin

// Launched from the verified runtime, without a shell, credentials, or privilege
// changes. Its parent authorizes the ordinary quit before any reopen is allowed.
@main struct Reopen {
    static func main() {
        signal(SIGPIPE, SIG_IGN)
        let args = CommandLine.arguments
        guard args.count == 4, let appPID = Int32(args[1]), let serverPID = Int32(args[2]),
              serverPID == getppid(), appPID > 1, serverPID > 1,
              let app = NSRunningApplication(processIdentifier: appPID),
              let bundle = app.bundleURL, bundle.standardizedFileURL.path == URL(fileURLWithPath: args[3]).standardizedFileURL.path else { exit(1) }
        let lock = NSLock()
        var go = false, approved = false, cancelled = false
        DispatchQueue.global().async {
            while let line = readLine() {
                lock.lock()
                if line == "go" { go = true }
                else if line == "approved" { approved = true }
                else { cancelled = true }
                lock.unlock()
            }
            lock.lock(); if !approved { cancelled = true }; lock.unlock()
        }
        print("ready"); fflush(stdout)
        var state = ReopenState(), asked = false
        let deadline = ProcessInfo.processInfo.systemUptime + 25
        while true {
            lock.lock(); let request = go, permission = approved, cancel = cancelled; lock.unlock()
            if request && !asked {
                asked = true
                guard app.terminate() else { print("failed"); fflush(stdout); exit(1) }
            }
            state.approved = permission
            let serverStopped = kill(serverPID, 0) == -1 && errno == ESRCH
            let action = state.observe(appStopped: app.isTerminated, serverStopped: serverStopped, cancelled: cancel, expired: ProcessInfo.processInfo.systemUptime >= deadline)
            if action == .fail { print("failed"); fflush(stdout); if permission && app.isTerminated { manual() }; exit(1) }
            if action == .open {
                // A person may already have reopened the same app. Never start
                // a second instance and never open a different bundle by ID.
                if NSWorkspace.shared.runningApplications.contains(where: { !$0.isTerminated && $0.processIdentifier != appPID && $0.bundleURL?.standardizedFileURL == bundle.standardizedFileURL }) { exit(0) }
                let config = NSWorkspace.OpenConfiguration(); config.createsNewApplicationInstance = false; config.activates = true
                var done = false, success = false
                NSWorkspace.shared.openApplication(at: bundle, configuration: config) { launched, error in
                    success = error == nil && launched?.bundleURL?.standardizedFileURL == bundle.standardizedFileURL; done = true
                }
                let until = ProcessInfo.processInfo.systemUptime + 15
                while !done && ProcessInfo.processInfo.systemUptime < until { RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05)) }
                if !success { manual(); exit(1) }; exit(0)
            }
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05))
        }
    }
    static func manual() {
        NSApplication.shared.setActivationPolicy(.accessory)
        let alert = NSAlert(); alert.messageText = "Project Hubを手動で開いてください"
        alert.informativeText = "自動で開き直せませんでした。これまでと同じProject Hub.appを開いてください。更新の記録は保持しています。"
        alert.runModal()
    }
}
