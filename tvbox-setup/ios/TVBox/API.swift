import Foundation

/// 苹果CMS `api.php/provide/vod` client. Talks to the sites directly — no relay server.
enum API {
    static let ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"

    static func str(_ v: Any?) -> String {
        switch v {
        case let s as String: return s
        case let n as NSNumber: return n.stringValue
        default: return ""
        }
    }

    static func url(_ s: String) -> URL? {
        let t = s.trimmingCharacters(in: .whitespaces)
        return URL(string: t) ?? t.addingPercentEncoding(withAllowedCharacters: .urlFragmentAllowed).flatMap(URL.init(string:))
    }

    static func clean(_ html: String) -> String {
        html.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
            .replacingOccurrences(of: "&nbsp;", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func fetch(_ url: URL, referer: String? = nil, timeout: TimeInterval = 15) async throws -> Data {
        var req = URLRequest(url: url, timeoutInterval: timeout)
        req.setValue(ua, forHTTPHeaderField: "User-Agent")
        if let referer { req.setValue(referer, forHTTPHeaderField: "Referer") }
        let (data, resp) = try await URLSession.shared.data(for: req)
        if let h = resp as? HTTPURLResponse, h.statusCode >= 400 { throw URLError(.badServerResponse) }
        return data
    }

    static func get(_ site: Site, _ params: [String: String]) async throws -> [String: Any] {
        guard var comps = url(site.api).flatMap({ URLComponents(url: $0, resolvingAgainstBaseURL: false) }) else { throw URLError(.badURL) }
        comps.queryItems = (comps.queryItems ?? []) + params.map { URLQueryItem(name: $0.key, value: $0.value) }
        guard let u = comps.url else { throw URLError(.badURL) }
        let data = try await fetch(u)
        guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw URLError(.cannotParseResponse)
        }
        return obj
    }

    /// Leaf categories only (top-level ones return empty lists on these sites), filtered by 安全级别.
    static func categories(_ site: Site) async throws -> [VodCategory] {
        let obj = try await get(site, ["ac": "list"])
        let all = (obj["class"] as? [[String: Any]] ?? []).map {
            VodCategory(id: str($0["type_id"]), pid: str($0["type_pid"]), name: str($0["type_name"]))
        }
        let parents = Set(all.map(\.pid))
        return all.filter { !parents.contains($0.id) && Safety.catAllowed(site, $0.name) }
    }

    static func item(_ site: Site, _ d: [String: Any]) -> VodItem {
        VodItem(site: site, vodId: str(d["vod_id"]), name: str(d["vod_name"]), pic: str(d["vod_pic"]),
                remarks: str(d["vod_remarks"]), typeName: str(d["type_name"]), year: str(d["vod_year"]),
                blurb: clean(str(d["vod_content"])))
    }

    private static func items(_ site: Site, _ obj: [String: Any]) -> [VodItem] {
        (obj["list"] as? [[String: Any]] ?? []).map { item(site, $0) }
            .filter { $0.typeName.isEmpty || Safety.catAllowed(site, $0.typeName) }
    }

    /// Netflix-style home rows: pick well-known leaf categories by name, in this order.
    static let rowWanted = ["国产剧", "韩剧|韩国剧", "欧美剧", "动作片", "喜剧片", "科幻片", "日剧|日本剧",
                            "国产动漫", "日韩动漫", "大陆综艺", "爱情片", "纪录片|记录片"]

    static func homeRows(_ cats: [VodCategory]) -> [VodCategory] {
        rowWanted.compactMap { want in
            let names = want.components(separatedBy: "|")
            return cats.first { names.contains($0.name) }
        }
    }

    static func list(_ site: Site, typeId: String, page: Int) async throws -> ([VodItem], Int) {
        var t = typeId
        // Whitelisted (少儿) sites / kids mode: "latest" comes from the first allowed category.
        if t.isEmpty, !(site.categories ?? []).isEmpty || Safety.level == "kids" {
            t = (try await categories(site)).first?.id ?? ""
        }
        var p = ["ac": "detail", "pg": String(page)]
        if !t.isEmpty { p["t"] = t }
        let obj = try await get(site, p)
        return (items(site, obj), Int(str(obj["pagecount"])) ?? 1)
    }

    static func search(_ site: Site, _ wd: String) async throws -> [VodItem] {
        items(site, try await get(site, ["ac": "detail", "wd": wd]))
    }

    /// Search every given site in parallel. Exact title matches first, then by site order.
    static func searchAll(_ wd: String, sites: [Site]) async -> ([VodItem], [String]) {
        await withTaskGroup(of: (Int, [VodItem]?).self) { group in
            for (i, s) in sites.enumerated() { group.addTask { (i, try? await search(s, wd)) } }
            var bucket: [Int: [VodItem]] = [:], failed: [String] = []
            for await (i, list) in group {
                if let list { bucket[i] = list } else { failed.append(sites[i].name) }
            }
            let all = sites.indices.flatMap { bucket[$0] ?? [] }
            return (all.filter { $0.name == wd } + all.filter { $0.name != wd }, failed)
        }
    }

    static func detail(_ item: VodItem) async throws -> VodDetail {
        let obj = try await get(item.site, ["ac": "detail", "ids": item.vodId])
        guard let d = (obj["list"] as? [[String: Any]])?.first else { throw URLError(.zeroByteResource) }
        let froms = str(d["vod_play_from"]).components(separatedBy: "$$$")
        let urls = str(d["vod_play_url"]).components(separatedBy: "$$$")
        var lines: [PlayLine] = []
        for (i, u) in urls.enumerated() {
            let eps = u.components(separatedBy: "#").compactMap { part -> Episode? in
                let p = part.components(separatedBy: "$")
                let url = (p.count > 1 ? p[1] : p[0]).trimmingCharacters(in: .whitespaces)
                let lower = url.lowercased()
                // Skip "share" web pages — only direct streams play without a 解析 service.
                guard url.hasPrefix("http"), lower.contains(".m3u8") || lower.contains(".mp4") else { return nil }
                return Episode(name: p.count > 1 ? p[0] : "播放", url: url)
            }
            if !eps.isEmpty { lines.append(PlayLine(name: i < froms.count ? froms[i] : "线路\(i + 1)", episodes: eps)) }
        }
        return VodDetail(year: str(d["vod_year"]), area: str(d["vod_area"]), actor: str(d["vod_actor"]),
                         director: str(d["vod_director"]), content: clean(str(d["vod_content"])), lines: lines)
    }

    // MARK: - Source checks

    static func checkSite(_ api: String) async -> String {
        let t0 = Date()
        do {
            let obj = try await get(Site(key: "", name: "", api: api), ["ac": "list"])
            let ms = Int(Date().timeIntervalSince(t0) * 1000)
            return "✓ \(ms)ms · \(str(obj["total"]))部"
        } catch { return "✗ 不通：\(error.localizedDescription)" }
    }

    /// Fetch the list, then probe a sample of channels (first bytes of each stream, 6s each).
    static func checkLive(_ src: LiveSource) async -> String {
        let t0 = Date()
        guard let text = await liveText(src) else { return "✗ 列表打不开" }
        let ms = Int(Date().timeIntervalSince(t0) * 1000)
        let channels = parseLive(text, src: src).flatMap(\.channels)
        if channels.isEmpty { return "✗ \(ms)ms · 没解析出频道" }
        let sample = Array(channels.shuffled().prefix(8))
        let ok = await withTaskGroup(of: Bool.self) { group in
            for ch in sample {
                group.addTask {
                    guard let u = url(ch.url) else { return false }
                    var req = URLRequest(url: u, timeoutInterval: 6)
                    req.setValue(ua, forHTTPHeaderField: "User-Agent")
                    req.setValue("bytes=0-2047", forHTTPHeaderField: "Range")
                    guard let (_, resp) = try? await URLSession.shared.data(for: req) else { return false }
                    return ((resp as? HTTPURLResponse)?.statusCode ?? 500) < 400
                }
            }
            var n = 0
            for await r in group where r { n += 1 }
            return n
        }
        return "\(ok > 0 ? "✓" : "✗") \(ms)ms · \(channels.count)个频道 · 抽测 \(ok)/\(sample.count) 可连"
    }

    // MARK: - Config import

    /// TVBox config URL (single or multi-warehouse `{"urls":[…]}`) → usable sites + lives.
    static func importConfig(_ urlString: String) async throws -> ([Site], [LiveSource]) {
        guard let u = url(urlString) else { throw URLError(.badURL) }
        let (s, l, subs) = try await parseConfig(u)
        var sites = s, lives = l
        for sub in subs.prefix(12) {
            if let (s2, l2, _) = try? await parseConfig(sub) { sites += s2; lives += l2 }
        }
        return (sites, lives)
    }

    private static func parseConfig(_ u: URL) async throws -> ([Site], [LiveSource], [URL]) {
        let data = try await fetch(u)
        let text = String(decoding: data, as: UTF8.self).components(separatedBy: .newlines)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }.joined(separator: "\n")
        guard let obj = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else {
            throw URLError(.cannotParseResponse)
        }
        let subs = (obj["urls"] as? [[String: Any]] ?? []).compactMap { URL(string: str($0["url"]), relativeTo: u)?.absoluteURL }
        return (Config.parseSites(obj["sites"]), Config.parseLives(obj["lives"]), subs)
    }

    // MARK: - 豆瓣

    /// Spaces requests to 豆瓣 so a screen full of posters doesn't get us rate-limited.
    actor Gate {
        private var next = Date.distantPast
        func wait() async {
            let now = Date(), at = max(now, next)
            next = at.addingTimeInterval(0.2)
            let d = at.timeIntervalSince(now)
            if d > 0 { try? await Task.sleep(nanoseconds: UInt64(d * 1e9)) }
        }
    }
    private static let gate = Gate()
    private static let lock = NSLock()
    private static var ratings: [String: DoubanRating] = {
        guard let d = UserDefaults.standard.data(forKey: "douban.cache"),
              let r = try? JSONDecoder().decode([String: DoubanRating].self, from: d) else { return [:] }
        return r
    }()

    private static func douban(_ url: URL) async -> Any? {
        await gate.wait()
        guard let d = try? await fetch(url, referer: "https://movie.douban.com/", timeout: 10) else { return nil }
        return try? JSONSerialization.jsonObject(with: d)
    }

    /// 豆瓣 subject + rating by exact title (+ year when known). Cached on disk.
    static func doubanRating(name: String, year: String) async -> DoubanRating {
        let key = name + "|" + year
        lock.lock(); let hit = ratings[key]; lock.unlock()
        if let hit { return hit }
        var c = URLComponents(string: "https://movie.douban.com/j/subject_suggest")!
        c.queryItems = [URLQueryItem(name: "q", value: name)]
        guard let list = await douban(c.url!) as? [[String: Any]] else { return DoubanRating() }
        let norm: (String) -> String = { $0.replacingOccurrences(of: "[\\s·:：\\-—!！,，.。]", with: "", options: .regularExpression).lowercased() }
        let exact = list.filter { str($0["title"]) == name || norm(str($0["title"])) == norm(name) }
        var out = DoubanRating()
        if let pick = exact.first(where: { !year.isEmpty && str($0["year"]) == year }) ?? exact.first {
            out.id = str(pick["id"])
            if let o = await douban(URL(string: "https://movie.douban.com/j/subject_abstract?subject_id=\(out.id)")!) as? [String: Any] {
                out.rate = str((o["subject"] as? [String: Any])?["rate"])
            }
        }
        lock.lock()
        ratings[key] = out
        let snapshot = ratings
        lock.unlock()
        UserDefaults.standard.set(try? JSONEncoder().encode(snapshot), forKey: "douban.cache")
        return out
    }

    static func doubanHot(_ type: String) async -> [DoubanItem] {
        var c = URLComponents(string: "https://movie.douban.com/j/search_subjects")!
        c.queryItems = [.init(name: "type", value: type), .init(name: "tag", value: "热门"),
                        .init(name: "page_limit", value: "30"), .init(name: "page_start", value: "0")]
        guard let obj = await douban(c.url!) as? [String: Any] else { return [] }
        return (obj["subjects"] as? [[String: Any]] ?? []).map {
            DoubanItem(id: str($0["id"]), name: str($0["title"]), pic: str($0["cover"]), rate: str($0["rate"]),
                       remarks: str($0["episodes_info"]))
        }
    }

    // MARK: - Live

    static func liveText(_ src: LiveSource, ignoreEdits: Bool = false) async -> String? {
        if !ignoreEdits, let t = src.text { return t }
        if src.url.hasPrefix("http") {
            guard let u = url(src.url), let d = try? await fetch(u) else { return nil }
            return String(decoding: d, as: UTF8.self)
        }
        let parts = src.url.split(separator: ".", maxSplits: 1).map(String.init)
        guard let u = Bundle.main.url(forResource: parts.first ?? "", withExtension: parts.count > 1 ? parts[1] : nil) else { return nil }
        return try? String(contentsOf: u, encoding: .utf8)
    }

    static func loadLive(_ src: LiveSource) async -> [LiveGroup] {
        guard let text = await liveText(src) else { return [] }
        return parseLive(text, src: src)
    }

    /// m3u/m3u8 channel lists, TVBox txt, or a single HLS stream (→ one channel).
    static func parseLive(_ text: String, src: LiveSource) -> [LiveGroup] {
        var order: [String] = []
        var map: [String: [LiveChannel]] = [:]
        func add(_ group: String, _ ch: LiveChannel) {
            if map[group] == nil { order.append(group); map[group] = [] }
            map[group]!.append(ch)
        }
        let lines = text.components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespaces) }
        if src.text == nil, src.url.hasPrefix("http"), text.range(of: "#EXT-X-(TARGETDURATION|STREAM-INF|MEDIA-SEQUENCE)", options: .regularExpression) != nil {
            add(src.name, LiveChannel(name: src.name, url: src.url, logo: ""))
        } else if text.contains("#EXTINF") {
            var pending: (String, String, String)?
            for line in lines {
                if line.hasPrefix("#EXTINF") {
                    let name = line.components(separatedBy: ",").last?.trimmingCharacters(in: .whitespaces) ?? ""
                    pending = (name, attr(line, "group-title") ?? "其他", attr(line, "tvg-logo") ?? "")
                } else if !line.isEmpty, !line.hasPrefix("#"), let p = pending {
                    add(p.1.isEmpty ? "其他" : p.1, LiveChannel(name: p.0, url: line, logo: p.2))
                    pending = nil
                }
            }
        } else {
            var group = "其他"
            for line in lines {
                let kv = line.split(separator: ",", maxSplits: 1).map(String.init)
                guard kv.count == 2 else { continue }
                if kv[1].contains("#genre#") { group = kv[0]; continue }
                for u in kv[1].components(separatedBy: "#") where u.hasPrefix("http") {
                    add(group, LiveChannel(name: kv[0], url: u, logo: ""))
                }
            }
        }
        return order.map { LiveGroup(name: $0, channels: map[$0]!) }
    }

    private static func attr(_ line: String, _ key: String) -> String? {
        guard let r = line.range(of: key + "=\"") else { return nil }
        let rest = line[r.upperBound...]
        guard let end = rest.firstIndex(of: "\"") else { return nil }
        return String(rest[..<end])
    }
}
