import Foundation

/**
 The wallet's storage.local, shared by the app's wallet page and the Safari extension (lib/shared-storage.ts): one JSON
 file of key → JSON text in the app group both belong to, each request under a file lock both processes take. The vault
 in it is encrypted with your password, as in the browsers' own storage.
 */
enum Storage {
    static let group = "ACWP4F58HZ.com.borodutch.plainwallet"

    /** get/set/clear use JSON text values. compareAndSet checks vault + mac and writes under this same file lock. */
    static func handle(_ request: Any?) -> [String: Any] {
        do {
            guard let request = request as? [String: Any] else { throw Failure("bad request") }
            return try locked { file in
                var all = try read(file)
                if let transaction = request["compareAndSet"] as? [String: Any] {
                    guard let expected = transaction["expected"] as? [String: Any],
                          Set(expected.keys) == Set(["vault", "mac"]),
                          let changes = transaction["set"] as? [String: String] else { throw Failure("bad transaction") }
                    for (key, value) in expected {
                        guard value is NSNull || value is String else { throw Failure("bad expectation") }
                        let text = value as? String
                        if all[key] != text { return ["committed": false] }
                    }
                    for (key, value) in changes { all[key] = value }
                    try write(all, to: file)
                    return ["committed": true]
                }
                if let changes = request["set"] as? [String: Any] {
                    for (key, value) in changes {
                        if value is NSNull { all[key] = nil } else if let text = value as? String { all[key] = text } else { throw Failure("bad value for \(key)") }
                    }
                    try write(all, to: file)
                    return [:]
                }
                if request["clear"] as? Bool == true {
                    try write([:], to: file)
                    return [:]
                }
                guard let keys = request["get"] as? [String] ?? (request["get"] is NSNull ? Array(all.keys) : nil) else { throw Failure("bad request") }
                return ["values": all.filter { keys.contains($0.key) }]
            }
        } catch {
            return ["error": "Wallet storage: \(error)"]
        }
    }

    struct Failure: Error, CustomStringConvertible {
        let description: String
        init(_ description: String) { self.description = description }
    }

    static func locked<T>(_ body: (URL) throws -> T) throws -> T {
        guard let dir = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { throw Failure("no app group") }
        let fd = open(dir.appendingPathComponent("storage.lock").path, O_CREAT | O_RDWR, 0o600)
        guard fd >= 0, flock(fd, LOCK_EX) == 0 else { throw Failure("can't lock (errno \(errno))") }
        defer { close(fd) } // releases the lock
        return try body(dir.appendingPathComponent("storage.json"))
    }

    // No file yet is an empty wallet; a file that can't be read is an error, never taken for one (a write would wipe it).
    static func read(_ file: URL) throws -> [String: String] {
        guard FileManager.default.fileExists(atPath: file.path) else { return [:] }
        return try JSONDecoder().decode([String: String].self, from: Data(contentsOf: file))
    }

    static func write(_ all: [String: String], to file: URL) throws {
        try JSONEncoder().encode(all).write(to: file, options: .atomic)
    }
}
