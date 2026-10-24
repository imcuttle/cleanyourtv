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

    /// 5-minute response cache with in-flight de-duplication: going back to a page, or several rows asking
    /// for the same list, costs nothing. Parsing happens off the main actor.
    actor ResponseCache {
        private var store: [URL: (Date, [String: Any])] = [:]
        private var inflight: [URL: Task<[String: Any], Error>] = [:]
        func value(_ u: URL, timeout: TimeInterval, fresh: Bool) async throws -> [String: Any] {
            if !fresh, let (at, v) = store[u], Date().timeIntervalSince(at) < 300 { return v }
            if let t = inflight[u] { return try await t.value }
            let t = Task.detached(priority: .userInitiated) { () throws -> [String: Any] in
                let data = try await API.fetch(u, timeout: timeout)
                guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw URLError(.cannotParseResponse) }
                return obj
            }
            inflight[u] = t
            defer { inflight[u] = nil }
            let v = try await t.value
            store[u] = (Date(), v)
            if store.count > 400, let oldest = store.min(by: { $0.value.0 < $1.value.0 })?.key { store[oldest] = nil }
            return v
        }
    }
    static let responses = ResponseCache()

    static func get(_ site: Site, _ params: [String: String], timeout: TimeInterval = 15, fresh: Bool = false) async throws -> [String: Any] {
        guard var comps = url(site.api).flatMap({ URLComponents(url: $0, resolvingAgainstBaseURL: false) }) else { throw URLError(.badURL) }
        comps.queryItems = (comps.queryItems ?? []) + params.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        guard let u = comps.url else { throw URLError(.badURL) }
        return try await responses.value(u, timeout: timeout, fresh: fresh)
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
                blurb: String(clean(str(d["vod_content"])).prefix(300)), typeId: str(d["type_id"]))
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
        items(site, try await get(site, ["ac": "detail", "wd": wd], timeout: 8))
    }

    static func splitPeople(_ v: String) -> [String] {
        v.components(separatedBy: CharacterSet(charactersIn: ",，、/|;；"))
            .flatMap { $0.components(separatedBy: "  ") }
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !["暂无", "未知", "内详", "无", "不详", "佚名", "其他", "N/A", "none", "unknown"].contains($0) }
    }

    /// 苹果CMS has no actor filter, but some sites' `wd` also matches credits. Search every site (two pages),
    /// keep titles whose credits really contain the name, one per title + year, newest first.
    static func person(_ name: String, role: String, sites: [Site]) async -> [VodItem] {
        let field = role == "director" ? "vod_director" : "vod_actor"
        let found = await withTaskGroup(of: [(Site, [String: Any])].self) { group in
            for s in sites { for pg in [1, 2] {
                group.addTask {
                    let o = try? await get(s, ["ac": "detail", "wd": name, "pg": String(pg)], timeout: 8)
                    return (o?["list"] as? [[String: Any]] ?? []).map { (s, $0) }
                }
            } }
            var all: [(Site, [String: Any])] = []
            for await r in group { all += r }
            return all
        }
        var seen = Set<String>(), out: [VodItem] = []
        for (s, d) in found {
            guard splitPeople(str(d[field])).contains(name) else { continue }
            let it = item(s, d)
            guard !it.name.contains("解说"), !it.name.contains("预告"), !it.typeName.contains("解说"),
                  it.typeName.isEmpty || Safety.catAllowed(s, it.typeName) else { continue }
            if seen.insert(it.name.replacingOccurrences(of: " ", with: "") + "|" + it.year).inserted { out.append(it) }
        }
        return out.sorted { (Int($0.year) ?? 0) > (Int($1.year) ?? 0) }
    }

    /// Search every given site in parallel. Exact title matches first, then by site order.
    static func searchAll(_ wd: String, sites: [Site]) async -> ([VodItem], [String]) {
        let r = await searchWithCredits(wd, sites: sites)
        return (r.items, r.failed)
    }

    struct PersonHit: Identifiable { let name: String; let role: String; let items: [VodItem]; var id: String { role + name } }

    /// Same requests as searchAll (shared cache), plus works whose 演员 / 导演 credits contain the query —
    /// many sites' `wd` also matches those fields. Grouped per credited person (exact name first, then most works).
    static func searchWithCredits(_ wd: String, sites: [Site]) async -> (items: [VodItem], failed: [String], people: [PersonHit]) {
        await withTaskGroup(of: (Int, [[String: Any]]?).self) { group in
            for (i, s) in sites.enumerated() {
                group.addTask { (i, (try? await get(s, ["ac": "detail", "wd": wd], timeout: 8))?["list"] as? [[String: Any]]) }
            }
            var bucket: [Int: [[String: Any]]] = [:], failed: [String] = []
            for await (i, list) in group { if let list { bucket[i] = list } else { failed.append(sites[i].name) } }
            var items: [VodItem] = []
            var people: [String: (seen: Set<String>, items: [VodItem])] = [:], order: [String] = []
            for i in sites.indices {
                for d in bucket[i] ?? [] {
                    let it = item(sites[i], d)
                    guard it.typeName.isEmpty || Safety.catAllowed(sites[i], it.typeName) else { continue }
                    items.append(it)
                    guard !(it.name + it.typeName).contains("解说"), !(it.name + it.typeName).contains("预告") else { continue }
                    for (field, role) in [("vod_actor", "actor"), ("vod_director", "director")] {
                        for p in Set(splitPeople(str(d[field])).filter { $0.contains(wd) }) {
                            let k = role + "|" + p
                            if people[k] == nil { people[k] = ([], []); order.append(k) }
                            let dedupe = it.name.replacingOccurrences(of: " ", with: "").replacingOccurrences(of: it.year, with: "") + "|" + it.year
                            if people[k]!.seen.insert(dedupe).inserted { people[k]!.items.append(it) }
                        }
                    }
                }
            }
            let hits = order.map { k -> PersonHit in
                let parts = k.split(separator: "|", maxSplits: 1).map(String.init)
                return PersonHit(name: parts[1], role: parts[0], items: people[k]!.items.sorted { (Int($0.year) ?? 0) > (Int($1.year) ?? 0) })
            }.sorted { ($0.name == wd ? 1 : 0, $0.items.count) > ($1.name == wd ? 1 : 0, $1.items.count) }
            return (items.filter { $0.name == wd } + items.filter { $0.name != wd }, failed, Array(hits.prefix(30)))
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
                         director: str(d["vod_director"]), content: clean(str(d["vod_content"])), lines: lines,
                         actors: splitPeople(str(d["vod_actor"])), directors: splitPeople(str(d["vod_director"])),
                         typeId: str(d["type_id"]), typeName: str(d["type_name"]), lang: str(d["vod_lang"]))
    }

    // MARK: - Source checks

    static func checkSite(_ api: String) async -> String {
        let t0 = Date()
        do {
            let obj = try await get(Site(key: "", name: "", api: api), ["ac": "list"], timeout: 10, fresh: true)
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
        guard let obj = parseJSON(String(decoding: try await fetch(u), as: UTF8.self)) as? [String: Any] else {
            throw URLError(.cannotParseResponse)
        }
        return await configFrom(obj, base: u)
    }

    static func parseJSON(_ text: String) -> Any? {
        let t = text.components(separatedBy: .newlines)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }.joined(separator: "\n")
        return try? JSONSerialization.jsonObject(with: Data(t.utf8))
    }

    static func configFrom(_ obj: [String: Any], base: URL?, depth: Int = 0) async -> ([Site], [LiveSource]) {
        var sites = Config.parseSites(obj["sites"])
        var lives = Config.parseLives((obj["lives"] as? [[String: Any]] ?? []).map { l in
            var l = l; l["url"] = unwrapLive(str(l["url"])); return l
        })
        if depth == 0, let urls = obj["urls"] as? [[String: Any]] {
            for sub in urls.prefix(12) {
                guard let u = URL(string: str(sub["url"]), relativeTo: base)?.absoluteURL,
                      let d = try? await fetch(u), let o = parseJSON(String(decoding: d, as: UTF8.self)) as? [String: Any] else { continue }
                let (s2, l2) = await configFrom(o, base: u, depth: 1)
                sites += s2; lives += l2
            }
        }
        return (sites, lives)
    }

    /// Live entries are sometimes wrapped as proxy://do=live&…&ext=<base64 url>.
    static func unwrapLive(_ u: String) -> String {
        guard u.hasPrefix("proxy://"), let r = u.range(of: "ext=") else { return u }
        let b64 = String(u[r.upperBound...].prefix { $0 != "&" }).removingPercentEncoding ?? ""
        guard let d = Data(base64Encoded: b64 + String(repeating: "=", count: (4 - b64.count % 4) % 4)),
              let s = String(data: d, encoding: .utf8), s.hasPrefix("http") else { return u }
        return s
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

    private static func douban(_ url: URL, referer: String = "https://movie.douban.com/") async -> Any? {
        await gate.wait()
        if Task.isCancelled { return nil }
        guard let d = try? await fetch(url, referer: referer, timeout: 10) else { return nil }
        return try? JSONSerialization.jsonObject(with: d)
    }

    /// 豆瓣 subject + rating by exact title (+ year when known). Cached on disk.
    static func cachedRating(name: String, year: String) -> DoubanRating? {
        lock.lock(); defer { lock.unlock() }
        return ratings[name + "|" + year]
    }

    static func doubanRating(name: String, year: String) async -> DoubanRating {
        let key = name + "|" + year
        lock.lock(); let hit = ratings[key]; lock.unlock()
        if let hit, hit.v == 2, let at = hit.at, Date().timeIntervalSince(at) < (hit.rate.isEmpty ? 86400 : 7 * 86400) { return hit }
        // m.douban.com's subject search: id, score, year and poster in one request (the old subject_suggest now answers []).
        var c = URLComponents(string: "https://m.douban.com/rexxar/api/v2/search/subjects")!
        c.queryItems = [URLQueryItem(name: "q", value: name), URLQueryItem(name: "count", value: "8")]
        guard let obj = await douban(c.url!, referer: "https://m.douban.com/movie/") as? [String: Any], !Task.isCancelled else { return hit ?? DoubanRating() }
        let subs = ((obj["subjects"] as? [String: Any])?["items"] as? [[String: Any]] ?? []).compactMap { $0["target"] as? [String: Any] }
        let norm: (String) -> String = { $0.replacingOccurrences(of: "[\\s·:：\\-—!！,，.。]", with: "", options: .regularExpression).lowercased() }
        let exact = subs.filter { str($0["title"]) == name || norm(str($0["title"])) == norm(name) }
        var out = DoubanRating(at: Date(), v: 2)
        if let pick = exact.first(where: { !year.isEmpty && str($0["year"]) == year }) ?? exact.first {
            out.id = str(pick["id"])
            if let v = (pick["rating"] as? [String: Any])?["value"] as? Double, v > 0 { out.rate = String(format: "%.1f", v) }
            if let r = str(pick["cover_url"]).range(of: #"/(p\d+)\."#, options: .regularExpression) {
                let pid = String(str(pick["cover_url"])[r]).dropFirst().dropLast()
                out.pic = "https://img3.doubanio.com/view/photo/s_ratio_poster/public/\(pid).jpg"
            }
        }
        lock.lock()
        ratings[key] = out
        let snapshot = ratings
        lock.unlock()
        saveRatings(snapshot)
        return out
    }

    /// Writing the whole cache after every rating thrashed the main thread; coalesce to one write per 3 s.
    private static var saveTask: Task<Void, Never>?
    private static func saveRatings(_ snapshot: [String: DoubanRating]) {
        lock.lock(); defer { lock.unlock() }
        saveTask?.cancel()
        saveTask = Task.detached(priority: .background) {
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            if Task.isCancelled { return }
            UserDefaults.standard.set(try? JSONEncoder().encode(snapshot), forKey: "douban.cache")
        }
    }

    /// Rate-limited 豆瓣 JSON for other files (榜单).
    static func doubanJSON(_ url: URL) async -> Any? { await douban(url) }

    /// type: "tv" / "movie" (热门), "show" (综艺) or "anime" (日本动画) — the latter two are tags of 豆瓣's tv type.
    static func doubanHot(_ type: String) async -> [DoubanItem] {
        var c = URLComponents(string: "https://movie.douban.com/j/search_subjects")!
        c.queryItems = [.init(name: "type", value: type == "movie" ? "movie" : "tv"), .init(name: "tag", value: ["show": "综艺", "anime": "日本动画"][type] ?? "热门"),
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
