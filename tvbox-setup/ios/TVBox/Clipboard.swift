import SwiftUI
import UIKit

/// Pasted text → 点播 sites / 直播 sources, same rules as the web server's /api/recognize:
/// every link is fetched and classified by what it returns; names come from the text on the same line.
struct Candidate: Identifiable {
    enum Kind { case site, live }
    let id = UUID()
    var kind: Kind
    var name: String
    var url: String            // api for sites, list/stream url for lives ("" for pasted lists)
    var text: String? = nil    // pasted channel list, stored in-app
    var kids = false
    var adult = false
    var categories: [String]? = nil
    var ok: Bool? = nil
    var info = ""
    var exists = false
    var selected = false
}

enum Recognizer {
    private static let vodHint = try! NSRegularExpression(pattern: "provide/vod|/api\\.php|/inc/api|/at/(json|xml)", options: .caseInsensitive)
    private static let liveHint = try! NSRegularExpression(pattern: "\\.(m3u8?|txt)(\\?|$)", options: .caseInsensitive)
    private static let streamish = try! NSRegularExpression(pattern: "\\.(m3u8|flv|ts|mp4|mpd)(\\?|$)|^(rtmp|rtsp):", options: .caseInsensitive)
    private static let linkRE = try! NSRegularExpression(pattern: "(?:https?|rtmp|rtsp)://[^\\s\"'<>，。；、）)】\\]]+", options: .caseInsensitive)

    static func looksLikeSource(_ t: String) -> Bool {
        t.range(of: "(https?|rtmp|rtsp)://|#EXTINF|#genre#|\"sites\"\\s*:", options: .regularExpression) != nil
    }

    private static func has(_ re: NSRegularExpression, _ s: String) -> Bool {
        re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }

    static func normApi(_ s: String) -> String {
        guard var c = URLComponents(string: s.trimmingCharacters(in: .whitespaces)) else { return s }
        c.queryItems = c.queryItems?.filter { !["ac", "pg", "t", "wd", "ids", "h"].contains($0.name) }
        if c.queryItems?.isEmpty == true { c.queryItems = nil }
        c.fragment = nil
        c.host = c.host?.lowercased()
        while c.path.hasSuffix("/") { c.path.removeLast() }
        return c.string ?? s
    }

    static func normURL(_ s: String) -> String {
        guard var c = URLComponents(string: s.trimmingCharacters(in: .whitespaces)) else { return s }
        c.fragment = nil
        c.host = c.host?.lowercased()
        return c.string ?? s
    }

    static func host(_ s: String) -> String {
        (URL(string: s)?.host ?? String(s.prefix(30)))
            .replacingOccurrences(of: "^(www|api|cj|caiji|collect|m3u8)\\.", with: "", options: .regularExpression)
    }

    static func cleanName(_ s: String) -> String {
        String(s.replacingOccurrences(of: "^[\\s\\d.、)）\\-*•#>\\[【(（]+", with: "", options: .regularExpression)
            .replacingOccurrences(of: "[\\s:：,，\\-—|=>【】\\[\\]()（）]+$", with: "", options: .regularExpression)
            .prefix(24))
    }

    private static func channelCount(_ text: String) -> Int {
        API.parseLive(text, src: LiveSource(name: "", url: "", text: text)).reduce(0) { $0 + $1.channels.count }
    }

    enum Kind {
        case vod(total: String), config([String: Any]), list(Int), stream
    }

    static func classify(_ text: String) -> Kind? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { return nil }
        if t.range(of: "#EXT-X-(TARGETDURATION|STREAM-INF|MEDIA-SEQUENCE)", options: .regularExpression) != nil { return .stream }
        if t.contains("#EXTINF") || t.contains("#genre#") { return .list(channelCount(t)) }
        if t.hasPrefix("{"), let o = API.parseJSON(t) as? [String: Any] {
            if o["sites"] != nil || o["urls"] != nil || o["lives"] != nil { return .config(o) }
            if o["class"] is [Any] || o["list"] is [Any] { return .vod(total: API.str(o["total"])) }
        }
        let rows = t.components(separatedBy: .newlines)
            .filter { $0.trimmingCharacters(in: .whitespaces).range(of: "^[^,#\\s][^,]{0,40},\\s*(https?|rtmp|rtsp)://", options: .regularExpression) != nil }
        if rows.count >= 2 { return .list(max(channelCount(t), rows.count)) }
        return nil
    }

    /// First bytes of a link: enough to tell a list / config / API from a video stream (stops at 2 MB).
    static func peek(_ u: URL) async throws -> (text: String, stream: Bool, final: URL) {
        var req = URLRequest(url: u, timeoutInterval: 8)
        req.setValue(API.ua, forHTTPHeaderField: "User-Agent")
        let (bytes, resp) = try await URLSession.shared.bytes(for: req)
        if let h = resp as? HTTPURLResponse, h.statusCode >= 400 { bytes.task.cancel(); throw URLError(.badServerResponse) }
        let mime = resp.mimeType ?? ""
        if mime.hasPrefix("video/") || mime.hasPrefix("audio/") || (mime.contains("octet-stream") && has(streamish, u.absoluteString)) {
            bytes.task.cancel()
            return ("", true, resp.url ?? u)
        }
        if mime.hasPrefix("image/") { bytes.task.cancel(); return ("", false, resp.url ?? u) }
        var data = Data()
        data.reserveCapacity(64 * 1024)
        for try await b in bytes {
            data.append(b)
            if data.count >= 2_000_000 { break }
        }
        bytes.task.cancel()
        return (String(decoding: data, as: UTF8.self), false, resp.url ?? u)
    }

    static func recognize(_ input: String, sites existingSites: [Site], lives existingLives: [LiveSource]) async -> ([Candidate], [String]) {
        let text = String(input.prefix(2_000_000))
        var out: [Candidate] = []
        var unknown: [String] = []

        switch classify(text) {
        case .config(let o):
            let (s, l) = await API.configFrom(o, base: nil)
            out += s.map { Candidate(kind: .site, name: $0.name, url: $0.api, kids: $0.kids == true, adult: $0.adult == true, categories: $0.categories, info: "来自粘贴的配置") }
            out += l.map { Candidate(kind: .live, name: $0.name, url: $0.url, info: "来自粘贴的配置") }
        case .list(let n):
            out.append(Candidate(kind: .live, name: "剪贴板频道 \(n)台", url: "", text: text.trimmingCharacters(in: .whitespacesAndNewlines) + "\n", ok: true, info: "\(n) 个频道"))
        default:
            var seen = Set<String>(), entries: [(url: String, name: String)] = []
            for line in text.components(separatedBy: .newlines) {
                var last = line.startIndex
                for m in linkRE.matches(in: line, range: NSRange(line.startIndex..., in: line)) {
                    guard let r = Range(m.range, in: line) else { continue }
                    let link = String(line[r]).replacingOccurrences(of: "[.,;:!?'\"]+$", with: "", options: .regularExpression)
                    let name = cleanName(String(line[last..<r.lowerBound]))
                    last = r.upperBound
                    if seen.insert(normURL(link)).inserted { entries.append((link, name)) }
                }
            }
            entries = Array(entries.prefix(30))

            enum Result { case cands([Candidate]), single(url: String, name: String, ok: Bool), unknown(String) }
            let results = await withTaskGroup(of: (Int, Result).self) { group in
                for (i, e) in entries.enumerated() {
                    group.addTask {
                        let h = host(e.url)
                        var kind: Kind? = nil, err = "", final = URL(string: e.url)
                        if e.url.lowercased().hasPrefix("http"), let u = API.url(e.url) {
                            do {
                                let p = try await peek(u)
                                final = p.final
                                kind = p.stream ? .stream : classify(p.text)
                            } catch { err = "不通：\(error.localizedDescription)" }
                        } else {
                            kind = .stream
                        }
                        switch kind {
                        case .vod(let total):
                            return (i, .cands([Candidate(kind: .site, name: e.name.isEmpty ? h : e.name, url: normApi(e.url), ok: true, info: "\(total)部")]))
                        case .config(let o):
                            let (s, l) = await API.configFrom(o, base: final)
                            let info = "来自配置 \(e.name.isEmpty ? h : e.name)"
                            return (i, .cands(s.map { Candidate(kind: .site, name: $0.name, url: $0.api, kids: $0.kids == true, adult: $0.adult == true, categories: $0.categories, info: info) }
                                + l.map { Candidate(kind: .live, name: $0.name, url: $0.url, info: info) }))
                        case .list(let n):
                            return (i, .cands([Candidate(kind: .live, name: e.name.isEmpty ? h : e.name, url: e.url, ok: true, info: "\(n) 个频道")]))
                        case .stream:
                            return (i, .single(url: e.url, name: e.name, ok: true))
                        case nil:
                            if has(vodHint, e.url) {
                                return (i, .cands([Candidate(kind: .site, name: e.name.isEmpty ? h : e.name, url: normApi(e.url), ok: false, info: err.isEmpty ? "返回的不是苹果CMS JSON" : err)]))
                            }
                            if has(streamish, e.url), e.url.range(of: "\\.txt|\\.m3u(\\?|$)", options: .regularExpression) == nil {
                                return (i, .single(url: e.url, name: e.name, ok: false))
                            }
                            if has(liveHint, e.url) {
                                return (i, .cands([Candidate(kind: .live, name: e.name.isEmpty ? h : e.name, url: e.url, ok: false, info: err.isEmpty ? "没解析出频道" : err)]))
                            }
                            return (i, .unknown(e.url))
                        }
                    }
                }
                var r: [Int: Result] = [:]
                for await (i, x) in group { r[i] = x }
                return entries.indices.compactMap { r[$0] }
            }
            var singles: [(url: String, name: String, ok: Bool)] = []
            for r in results {
                switch r {
                case .cands(let c): out += c
                case .single(let u, let n, let ok): singles.append((u, n, ok))
                case .unknown(let u): unknown.append(u)
                }
            }
            if !singles.isEmpty {
                let body = singles.map { "#EXTINF:-1 group-title=\"剪贴板\",\($0.name.isEmpty ? host($0.url) : $0.name)\n\($0.url)" }.joined(separator: "\n")
                let alive = singles.filter(\.ok).count
                out.append(Candidate(kind: .live, name: singles.count == 1 ? (singles[0].name.isEmpty ? "剪贴板直播" : singles[0].name) : "剪贴板频道 \(singles.count)台",
                                     url: "", text: "#EXTM3U\n\(body)\n", ok: alive > 0, info: "\(singles.count) 条直播流，\(alive) 条能连上"))
            }
        }

        // De-duplicate inside the paste, then against what is configured.
        let haveApi = Set(existingSites.filter { ($0.categories ?? []).isEmpty }.map { normApi($0.api) })
        let haveURL = Set(existingLives.filter { $0.text == nil }.map { normURL($0.url) })
        let trim: (String?) -> String = { ($0 ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }
        let haveText = Set(existingLives.compactMap(\.text).map { trim($0) })
        var seenKeys = Set<String>()
        out = out.filter { c in
            let key = c.kind == .site ? "s|" + normApi(c.url) + "|" + (c.categories ?? []).joined(separator: ",")
                : c.text != nil ? "t|" + trim(c.text) : "l|" + normURL(c.url)
            return seenKeys.insert(key).inserted
        }.map { c in
            var c = c
            if c.kind == .site {
                c.url = normApi(c.url)
                c.exists = (c.categories ?? []).isEmpty && haveApi.contains(c.url)
            } else {
                c.exists = c.text != nil ? haveText.contains(trim(c.text)) : haveURL.contains(normURL(c.url))
            }
            c.selected = !c.exists && c.ok != false
            return c
        }
        return (out, unknown)
    }
}

struct ClipPayload: Identifiable {
    let id = UUID()
    let text: String
}

struct ClipboardImportView: View {
    let text: String
    @ObservedObject private var cfg = Config.shared
    @AppStorage("safety.pin") private var pin = ""
    @Environment(\.dismiss) private var dismiss
    @State private var items: [Candidate] = []
    @State private var unknown: [String] = []
    @State private var loading = true
    @State private var askPin = false
    @State private var pinInput = ""
    @State private var message: String?

    private var picked: [Candidate] { items.filter { $0.selected && !$0.exists } }

    var body: some View {
        NavigationStack {
            Group {
                if loading {
                    ProgressView("逐个打开链接确认类型…")
                } else if items.isEmpty {
                    ContentUnavailableView(unknown.isEmpty ? "没识别到点播/直播源" : "\(unknown.count) 个链接都不是点播/直播源",
                                           systemImage: "doc.on.clipboard")
                } else {
                    List {
                        if items.allSatisfy(\.exists) {
                            Text("识别到 \(items.count) 个源，都已存在").foregroundStyle(.secondary)
                        }
                        section("点播源", .site)
                        section("直播源", .live)
                        if !unknown.isEmpty {
                            Section("没认出来的链接") {
                                ForEach(unknown, id: \.self) { Text($0).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                            }
                        }
                    }
                }
            }
            .navigationTitle("识别剪贴板")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(picked.isEmpty ? "添加" : "添加 \(picked.count) 个") {
                        if pin.isEmpty { add() } else { pinInput = ""; askPin = true }
                    }
                    .disabled(picked.isEmpty)
                }
            }
            .alert("家长 PIN", isPresented: $askPin) {
                SecureField("PIN", text: $pinInput).keyboardType(.numberPad)
                Button("添加") { if pinInput == pin { add() } else { message = "PIN 不对" } }
                Button("取消", role: .cancel) {}
            }
            .alert(message ?? "", isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil } })) {
                Button("好", role: .cancel) {}
            }
            .task {
                guard loading else { return }
                (items, unknown) = await Recognizer.recognize(text, sites: cfg.sites, lives: cfg.lives)
                loading = false
            }
        }
    }

    @ViewBuilder private func section(_ title: String, _ kind: Candidate.Kind) -> some View {
        let idx = items.indices.filter { items[$0].kind == kind }
        if !idx.isEmpty {
            Section("\(title) · 新 \(idx.filter { !items[$0].exists }.count) / 共 \(idx.count)") {
                ForEach(idx, id: \.self) { i in row($items[i]) }
            }
        }
    }

    private func row(_ c: Binding<Candidate>) -> some View {
        let v = c.wrappedValue
        return HStack(alignment: .top, spacing: 10) {
            Image(systemName: v.exists ? "checkmark.circle" : v.selected ? "checkmark.circle.fill" : "circle")
                .font(.title3).foregroundStyle(v.exists ? Color.secondary : v.selected ? Color.brand : Color.secondary)
                .onTapGesture { if !v.exists { c.wrappedValue.selected.toggle() } }
            VStack(alignment: .leading, spacing: 3) {
                TextField("名称", text: c.name).font(.subheadline.weight(.semibold)).disabled(v.exists)
                Text(v.text != nil ? "粘贴的频道列表（存在本机）" : v.url).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                Text(v.exists ? "已存在" : v.info.isEmpty ? (v.ok == false ? "不通" : "未验证") : v.info)
                    .font(.caption2)
                    .foregroundStyle(v.exists ? Color.secondary : v.ok == true ? Color.green : v.ok == false ? Color.orange : Color.secondary)
            }
        }
        .opacity(v.exists ? 0.5 : 1)
    }

    private func add() {
        let s = picked.filter { $0.kind == .site }.map { c -> Site in
            var site = Site(key: c.name.isEmpty ? c.url : c.name, name: c.name.isEmpty ? Recognizer.host(c.url) : c.name, api: c.url)
            if c.kids { site.kids = true }
            if c.adult { site.adult = true }
            site.categories = c.categories
            return site
        }
        let l = picked.filter { $0.kind == .live }.map { c in
            c.text != nil ? LiveSource(name: c.name, url: "clipboard:" + UUID().uuidString, text: c.text)
                : LiveSource(name: c.name.isEmpty ? Recognizer.host(c.url) : c.name, url: c.url)
        }
        let before = (cfg.sites.count, cfg.lives.count)
        cfg.merge(sites: s, lives: l, replace: false)
        UserDefaults.standard.set(UIPasteboard.general.changeCount, forKey: "clip.seen")
        message = nil
        dismiss()
        Toast.show("已添加 \(cfg.sites.count - before.0) 个点播源、\(cfg.lives.count - before.1) 个直播源")
    }
}

/// App-wide one-line toast.
final class Toast: ObservableObject {
    static let shared = Toast()
    @Published var text: String?
    static func show(_ t: String) { DispatchQueue.main.async { shared.text = t } }
}

/// Shown when the app becomes active and the clipboard has a link. Uses the system PasteButton, so
/// iOS doesn't pop its "allow paste?" prompt; detection itself only checks patterns, never reads content.
struct ClipboardBanner: View {
    @Binding var payload: ClipPayload?
    @Binding var visible: Bool

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "doc.on.clipboard").foregroundStyle(.white)
            VStack(alignment: .leading, spacing: 1) {
                Text("剪贴板里有链接").font(.subheadline.weight(.semibold))
                Text("识别成点播 / 直播源").font(.caption2).foregroundStyle(.secondary)
            }
            Spacer()
            PasteButton(payloadType: String.self) { strings in
                let t = strings.joined(separator: "\n")
                DispatchQueue.main.async {
                    visible = false
                    if Recognizer.looksLikeSource(t) { payload = ClipPayload(text: t) } else { Toast.show("剪贴板里没识别到源") }
                }
            }
            .labelStyle(.titleOnly)
            .buttonBorderShape(.capsule)
            .tint(.brand)
            Button {
                UserDefaults.standard.set(UIPasteboard.general.changeCount, forKey: "clip.seen")
                visible = false
            } label: { Image(systemName: "xmark").font(.caption.weight(.bold)).foregroundStyle(.secondary).padding(6) }
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
        .padding(.horizontal, 12)
        .padding(.bottom, 58)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    static func check(_ show: @escaping () -> Void) {
        let pb = UIPasteboard.general
        guard pb.hasStrings, pb.changeCount != UserDefaults.standard.integer(forKey: "clip.seen") else { return }
        pb.detectPatterns(for: [.probableWebURL]) { result in
            if case .success(let found) = result, found.contains(.probableWebURL) { DispatchQueue.main.async(execute: show) }
        }
    }
}
