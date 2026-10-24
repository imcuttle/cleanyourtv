import Foundation
import AVFoundation
import SwiftUI
import Network

struct DownloadRecord: Identifiable, Codable, Hashable {
    var id: String
    var siteKey: String
    var siteName: String
    var vodId: String
    var name: String
    var pic: String
    var epName: String
    var url: String
    var status: String  // queued / downloading / paused / done / error
    var progress: Double
    var queuedAt: Double? = nil  // queue order (oldest first); 优先 puts it in front
    var path: String?   // relative to the app's home directory (it changes between installs)
    var error: String?
}

struct DownloadStat: Equatable {
    var bytes: Int64 = 0
    var speed: Double = 0   // bytes/s, smoothed
    var eta: Double = 0     // seconds

    static func speedText(_ b: Double) -> String {
        b <= 0 ? "" : b >= 1e6 ? String(format: "%.1f MB/s", b / 1e6) : "\(max(1, Int(b / 1e3))) KB/s"
    }
    static func sizeText(_ b: Int64) -> String {
        b >= 1_000_000_000 ? String(format: "%.2f GB", Double(b) / 1e9) : String(format: "%.1f MB", Double(b) / 1e6)
    }
    static func etaText(_ s: Double) -> String {
        s <= 0 ? "" : s < 60 ? "剩 \(Int(s)) 秒" : s < 3600 ? "剩 \(Int(ceil(s / 60))) 分" : String(format: "剩 %.1f 小时", s / 3600)
    }
}

/// Offline downloads. HLS goes through AVAssetDownloadURLSession (handles AES-128, keeps going in the
/// background); plain mp4 through an ordinary download task.
///
/// Delegate callbacks only note raw progress; a once-a-second tick publishes progress, bytes, speed and ETA
/// together, so the UI updates at a steady rate instead of on every callback.
final class DownloadManager: NSObject, ObservableObject, AVAssetDownloadDelegate, URLSessionDownloadDelegate {
    static let shared = DownloadManager()
    @Published private(set) var records: [DownloadRecord] = []
    @Published private(set) var stats: [String: DownloadStat] = [:]
    private var hls: AVAssetDownloadURLSession!
    private var files: URLSession!
    private var tasks: [String: URLSessionTask] = [:]
    private var packages: [String: URL] = [:]       // HLS: where the .movpkg is being written
    private var rawProgress: [String: Double] = [:]
    private var mp4Bytes: [String: Int64] = [:]
    private var lastSample: [String: (Date, Int64)] = [:]
    private var ticker: Timer?
    private var measuring = false
    private let pathMonitor = NWPathMonitor()
    /// How many episodes download at once: 1 on cellular / Low Data Mode, otherwise half the cores (2–3).
    @Published private(set) var maxJobs = 2

    private override init() {
        super.init()
        if let d = UserDefaults.standard.data(forKey: "downloads"),
           let r = try? JSONDecoder().decode([DownloadRecord].self, from: d) { records = r }
        hls = AVAssetDownloadURLSession(configuration: .background(withIdentifier: "tvbox.hls"),
                                        assetDownloadDelegate: self, delegateQueue: .main)
        files = URLSession(configuration: .default, delegate: self, delegateQueue: .main)
        pathMonitor.pathUpdateHandler = { [weak self] path in
            let n = path.isExpensive || path.isConstrained ? 1 : min(3, max(2, ProcessInfo.processInfo.activeProcessorCount / 2))
            DispatchQueue.main.async {
                guard let self, self.maxJobs != n else { return }
                self.maxJobs = n
                self.pump()
            }
        }
        pathMonitor.start(queue: .global(qos: .utility))
        // Background HLS tasks survive relaunch; a "downloading" record without one goes back in the queue.
        hls.getAllTasks { tasks in
            let alive = Set(tasks.compactMap(\.taskDescription))
            DispatchQueue.main.async {
                for t in tasks { if let id = t.taskDescription { self.tasks[id] = t } }
                for i in self.records.indices where self.records[i].status == "downloading" && !alive.contains(self.records[i].id) {
                    self.records[i].status = "queued"
                }
                self.save()
                self.pump()
            }
        }
    }

    // MARK: queue

    var queue: [DownloadRecord] {
        records.filter { $0.status == "queued" }.sorted { ($0.queuedAt ?? 0) < ($1.queuedAt ?? 0) }
    }
    func queuePosition(_ id: String) -> Int { (queue.firstIndex { $0.id == id } ?? -1) + 1 }

    /// Start queued downloads until the concurrency limit is reached.
    private func pump() {
        while records.filter({ $0.status == "downloading" }).count < maxJobs, let next = queue.first {
            start(next.id)
        }
        save()
        startTicker()
    }

    func pause(_ id: String) {
        guard let i = records.firstIndex(where: { $0.id == id }), ["queued", "downloading"].contains(records[i].status) else { return }
        tasks[id]?.suspend()
        records[i].status = "paused"
        stats[id] = nil; lastSample[id] = nil
        pump()
    }

    func resume(_ id: String) {
        guard let i = records.firstIndex(where: { $0.id == id }), ["paused", "error"].contains(records[i].status) else { return }
        records[i].status = "queued"
        records[i].queuedAt = Date().timeIntervalSince1970
        pump()
    }

    /// 优先: next in line.
    func prioritize(_ id: String) {
        guard let i = records.firstIndex(where: { $0.id == id }), records[i].status != "done", records[i].status != "downloading" else { return }
        records[i].status = "queued"
        records[i].queuedAt = (queue.first?.queuedAt ?? Date().timeIntervalSince1970) - 1
        pump()
    }

    func pauseAll() { records.filter { ["queued", "downloading"].contains($0.status) }.forEach { pause($0.id) } }
    func resumeAll() {
        records.filter { ["paused", "error"].contains($0.status) }.reversed().forEach { resume($0.id) }
    }

    // MARK: progress / speed

    func stat(_ id: String) -> DownloadStat { stats[id] ?? DownloadStat() }

    /// Downloads belonging to one title.
    func records(for item: VodItem) -> [DownloadRecord] {
        records.filter { $0.siteKey == item.site.key && $0.vodId == item.vodId }
    }

    private func startTicker() {
        guard ticker == nil, records.contains(where: { $0.status == "downloading" }) else { return }
        ticker = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.tick() }
    }

    private func tick() {
        let active = records.filter { $0.status == "downloading" }
        if active.isEmpty { ticker?.invalidate(); ticker = nil; stats = [:]; return }
        guard !measuring else { return }
        measuring = true
        let pkgs = packages, mp4 = mp4Bytes
        let received = Dictionary(uniqueKeysWithValues: active.map { ($0.id, tasks[$0.id]?.countOfBytesReceived ?? 0) })
        // Package sizes are summed off the main thread (a .movpkg holds hundreds of segment files).
        DispatchQueue.global(qos: .utility).async {
            var bytes: [String: Int64] = [:]
            for r in active {
                bytes[r.id] = max(mp4[r.id] ?? 0, received[r.id] ?? 0, pkgs[r.id].map(Self.directorySize) ?? 0)
            }
            DispatchQueue.main.async { self.apply(bytes); self.measuring = false }
        }
    }

    private func apply(_ bytes: [String: Int64]) {
        let now = Date()
        var next: [String: DownloadStat] = [:]
        for (id, b) in bytes {
            var s = stats[id] ?? DownloadStat()
            if let (t, prev) = lastSample[id], now.timeIntervalSince(t) > 0.3 {
                let inst = max(0, Double(b - prev) / now.timeIntervalSince(t))
                s.speed = s.speed > 0 ? s.speed * 0.6 + inst * 0.4 : inst
            }
            lastSample[id] = (now, b)
            s.bytes = b
            let p = rawProgress[id] ?? 0
            s.eta = p > 0.01 && s.speed > 0 ? Double(b) * (1 - p) / p / s.speed : 0
            next[id] = s
        }
        for i in records.indices where records[i].status == "downloading" {
            if let p = rawProgress[records[i].id], abs(p - records[i].progress) > 0.001 { records[i].progress = p }
        }
        if next != stats { stats = next }
    }

    private static func directorySize(_ url: URL) -> Int64 {
        guard let e = FileManager.default.enumerator(at: url, includingPropertiesForKeys: [.fileSizeKey]) else { return 0 }
        var n: Int64 = 0
        for case let f as URL in e { n += Int64((try? f.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0) }
        return n
    }

    private func save() {
        UserDefaults.standard.set(try? JSONEncoder().encode(records), forKey: "downloads")
    }

    func record(for url: String) -> DownloadRecord? { records.first { $0.url == url } }

    func localURL(for url: String) -> URL? {
        guard let r = record(for: url), r.status == "done", let p = r.path else { return nil }
        let u = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(p)
        return FileManager.default.fileExists(atPath: u.path) ? u : nil
    }

    func add(_ item: VodItem, _ ep: Episode) {
        if let r = record(for: ep.url) {
            if ["error", "paused"].contains(r.status) { resume(r.id) }
            return
        }
        // Strictly increasing, so 全部下载 keeps episode order.
        let at = max(Date().timeIntervalSince1970, (records.compactMap(\.queuedAt).max() ?? 0) + 0.001)
        records.insert(DownloadRecord(id: UUID().uuidString, siteKey: item.site.key, siteName: item.site.name, vodId: item.vodId,
                                      name: item.name, pic: item.pic, epName: ep.name, url: ep.url,
                                      status: "queued", progress: 0, queuedAt: at), at: 0)
        pump()
    }

    func retry(_ id: String) { resume(id) }

    private func start(_ id: String) {
        guard let i = records.firstIndex(where: { $0.id == id }), let url = API.url(records[i].url) else { return }
        records[i].status = "downloading"
        records[i].error = nil
        // Paused earlier: carry on where it stopped.
        if let t = tasks[id], t.state == .suspended {
            t.resume()
            lastSample[id] = nil
            return
        }
        records[i].progress = 0
        let task: URLSessionTask?
        if url.path.lowercased().hasSuffix(".mp4") {
            task = files.downloadTask(with: url)
        } else {
            let asset = AVURLAsset(url: url, options: ["AVURLAssetHTTPHeaderFieldsKey": ["User-Agent": API.ua]])
            task = hls.makeAssetDownloadTask(asset: asset, assetTitle: "\(records[i].name) \(records[i].epName)",
                                             assetArtworkData: nil, options: nil)
        }
        task?.taskDescription = id
        task?.resume()
        if let task { tasks[id] = task }
        rawProgress[id] = 0; mp4Bytes[id] = nil; lastSample[id] = nil
    }

    func delete(_ id: String) {
        guard let i = records.firstIndex(where: { $0.id == id }) else { return }
        let r = records.remove(at: i)
        tasks[id]?.cancel()
        tasks[id] = nil; stats[id] = nil; rawProgress[id] = nil; packages[id] = nil
        for s in [hls as URLSession, files] {
            s?.getAllTasks { $0.filter { $0.taskDescription == id }.forEach { $0.cancel() } }
        }
        pump()
        if let p = r.path { try? FileManager.default.removeItem(at: URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(p)) }
    }

    private func update(_ id: String?, _ change: (inout DownloadRecord) -> Void) {
        guard let id, let i = records.firstIndex(where: { $0.id == id }) else { return }
        let before = records[i]
        change(&records[i])
        if before.status != records[i].status || before.path != records[i].path { save() }
    }

    // MARK: HLS

    func urlSession(_ session: URLSession, assetDownloadTask: AVAssetDownloadTask, willDownloadTo location: URL) {
        if let id = assetDownloadTask.taskDescription { packages[id] = location }
    }

    func urlSession(_ session: URLSession, assetDownloadTask: AVAssetDownloadTask, didFinishDownloadingTo location: URL) {
        update(assetDownloadTask.taskDescription) { $0.path = location.relativePath }
    }

    func urlSession(_ session: URLSession, assetDownloadTask: AVAssetDownloadTask, didLoad timeRange: CMTimeRange,
                    totalTimeRangesLoaded loaded: [NSValue], timeRangeExpectedToLoad expected: CMTimeRange) {
        let done = loaded.map { $0.timeRangeValue.duration.seconds }.reduce(0, +)
        let total = expected.duration.seconds
        if let id = assetDownloadTask.taskDescription { rawProgress[id] = total > 0 ? min(1, done / total) : 0 }
    }

    // MARK: mp4

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let id = downloadTask.taskDescription else { return }
        let rel = "Documents/Downloads/\(id).mp4"
        let dest = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(rel)
        try? FileManager.default.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? FileManager.default.removeItem(at: dest)
        if (try? FileManager.default.moveItem(at: location, to: dest)) != nil { update(id) { $0.path = rel } }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData _: Int64,
                    totalBytesWritten written: Int64, totalBytesExpectedToWrite expected: Int64) {
        guard let id = downloadTask.taskDescription else { return }
        mp4Bytes[id] = written
        rawProgress[id] = expected > 0 ? Double(written) / Double(expected) : 0
    }

    // MARK: both

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        defer {
            if let id = task.taskDescription, tasks[id] === task { tasks[id] = nil }
            pump()
        }
        update(task.taskDescription) { r in
            if let error {
                r.status = "error"
                r.error = (error as NSError).code == NSURLErrorCancelled ? "已取消" : error.localizedDescription
            } else if r.path != nil {
                r.status = "done"
                r.progress = 1
            } else {
                r.status = "error"
                r.error = "没有拿到文件"
            }
        }
    }
}

struct DownloadsView: View {
    @ObservedObject private var dm = DownloadManager.shared
    @State private var playing: PlayRequest?

    var body: some View {
        List {
            if dm.records.isEmpty {
                Text("还没有下载。打开影片，点「下载」再选集。").foregroundStyle(.secondary)
            } else {
                let speed = dm.records.reduce(0.0) { $0 + dm.stat($1.id).speed }
                HStack {
                    Text("同时下载 \(dm.maxJobs) 集，其余排队").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Text(DownloadStat.speedText(speed)).font(.caption.weight(.semibold)).foregroundStyle(.green).monospacedDigit()
                }
            }
            ForEach(dm.records) { r in
                HStack(spacing: 12) {
                    Color.clear.frame(width: 48, height: 72).overlay(Poster(url: r.pic))
                        .clipShape(RoundedRectangle(cornerRadius: 4))
                    VStack(alignment: .leading, spacing: 4) {
                        Text(r.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                        Text("\(r.epName) · \(r.siteName)").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        if r.status == "downloading" { ProgressView(value: r.progress).tint(.green) }
                        HStack(spacing: 6) {
                            Text(label(r)).foregroundStyle(r.status == "error" ? .orange : .secondary)
                            if r.status == "downloading" {
                                let st = dm.stat(r.id)
                                if st.bytes > 0 { Text(DownloadStat.sizeText(st.bytes)).foregroundStyle(.secondary) }
                                Text(DownloadStat.speedText(st.speed)).foregroundStyle(.green).fontWeight(.semibold)
                                Text(DownloadStat.etaText(st.eta)).foregroundStyle(.secondary)
                            }
                        }
                        .font(.caption2).monospacedDigit()
                    }
                    Spacer()
                    switch r.status {
                    case "done":
                        Button {
                            playing = PlayRequest(title: r.name, episodes: [Episode(name: r.epName, url: r.url)], index: 0)
                        } label: { Image(systemName: "play.circle.fill").font(.system(size: 34)) }
                            .buttonStyle(.plain)
                    case "downloading", "queued":
                        Button { dm.pause(r.id) } label: { Image(systemName: "pause.circle").font(.system(size: 30)) }
                            .buttonStyle(.plain).foregroundStyle(.secondary)
                    default:
                        Button { dm.resume(r.id) } label: {
                            Image(systemName: r.status == "error" ? "arrow.clockwise.circle" : "play.circle").font(.system(size: 30))
                        }
                        .buttonStyle(.plain).foregroundStyle(r.status == "error" ? .orange : .green)
                    }
                }
                .swipeActions(edge: .leading) {
                    if r.status != "done", r.status != "downloading" {
                        Button { dm.prioritize(r.id) } label: { Label("优先", systemImage: "arrow.up.to.line") }.tint(.blue)
                    }
                }
            }
            .onDelete { idx in idx.map { dm.records[$0].id }.forEach(dm.delete) }
        }
        .navigationTitle("下载")
        .toolbar {
            if dm.records.contains(where: { ["downloading", "queued"].contains($0.status) }) {
                Button("全部暂停") { dm.pauseAll() }
            } else if dm.records.contains(where: { ["paused", "error"].contains($0.status) }) {
                Button("全部开始") { dm.resumeAll() }
            }
        }
        .fullScreenCover(item: $playing) { PlayerScreen(request: $0) }
    }

    private func label(_ r: DownloadRecord) -> String {
        switch r.status {
        case "done": return "已下载 · 可离线播放"
        case "downloading": return "下载中 \(Int(r.progress * 100))%"
        case "queued": return "排队第 \(dm.queuePosition(r.id)) 位 · 右滑可优先"
        case "paused": return "已暂停 \(Int(r.progress * 100))%"
        default: return "失败：\(r.error ?? "")"
        }
    }
}
