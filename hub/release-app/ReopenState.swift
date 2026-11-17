import Foundation

// Decisions shared by the real helper and its offline event-sequence tests.
struct ReopenState {
    enum Action { case wait, open, fail }
    var approved = false
    private(set) var opened = false
    mutating func observe(appStopped: Bool, serverStopped: Bool, cancelled: Bool, expired: Bool) -> Action {
        if opened { return .wait }
        if cancelled || expired { return .fail }
        if approved && appStopped && serverStopped { opened = true; return .open }
        return .wait
    }
}
