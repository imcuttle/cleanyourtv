import Foundation

struct Site: Identifiable, Hashable, Codable {
    var key: String
    var name: String
    var api: String
    var kids: Bool? = nil        // shown in 儿童 mode
    var adult: Bool? = nil       // only shown at 安全级别 = 全部
    var categories: [String]? = nil  // TVBox-style whitelist of category names
    var members: [String]? = nil     // 聚合源: keys of the member sites; browsed / searched / played through all of them
    var id: String { key }
}

struct LiveSource: Identifiable, Hashable, Codable {
    var name: String
    var url: String  // m3u / m3u8 / txt URL, a single .m3u8 stream, or the name of a list bundled in the app
    var uid: String? = nil
    var text: String? = nil  // edited in-app: used instead of fetching `url`
    var id: String { uid ?? url }
}

struct VodCategory: Identifiable, Hashable {
    let id: String
    let pid: String
    let name: String
}

struct VodItem: Identifiable, Hashable {
    let site: Site
    let vodId: String
    let name: String
    let pic: String
    let remarks: String
    let typeName: String
    var year: String = ""
    var blurb: String = ""
    var typeId: String = ""
    var id: String { site.key + "/" + vodId }
}

struct Episode: Identifiable, Hashable {
    let id = UUID()
    let name: String
    let url: String
}

struct PlayLine: Identifiable, Hashable {
    let id = UUID()
    let name: String
    let episodes: [Episode]
}

struct VodDetail {
    let year: String
    let area: String
    let actor: String
    let director: String
    let content: String
    let lines: [PlayLine]
    var actors: [String] = []
    var directors: [String] = []
    var typeId = ""
    var typeName = ""
    var lang = ""
}

struct LiveChannel: Identifiable, Hashable {
    let id = UUID()
    let name: String
    let url: String
    let logo: String
}

struct LiveGroup: Identifiable {
    let name: String
    var channels: [LiveChannel]
    var id: String { name }
}

struct DoubanItem: Identifiable, Hashable {
    let id: String
    let name: String
    let pic: String
    let rate: String
    let remarks: String
}

struct DoubanRating: Codable, Hashable {
    var id = ""
    var rate = ""
    var at: Date? = nil   // when fetched; ratings are refreshed after 7 days (1 day when 豆瓣 had no score yet)
    var pic = ""          // 豆瓣's poster for the title (small size url; Poster picks the sharp size)
    var v: Int? = nil     // 2 = looked up through m.douban.com (has pic); older entries are fetched again
}

/// 安全级别: kids = only 少儿 sites + kid categories; standard = no adult sites/categories; all = everything.
enum Safety {
    static let adult = try! NSRegularExpression(pattern: "伦理|理论|三级|福利|写真|里番|两性|擦边|成人|情色|激情|无码|有码|性感|午夜|黄色|av|porn", options: .caseInsensitive)
    static let kidsCats = try! NSRegularExpression(pattern: "动漫|动画|儿童|少儿|卡通|亲子|早教|绘本")
    static let levels = [("kids", "儿童"), ("standard", "标准"), ("all", "全部")]

    static var level: String { UserDefaults.standard.string(forKey: "safety.level") ?? "standard" }

    static func matches(_ re: NSRegularExpression, _ s: String) -> Bool {
        re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }

    static func catAllowed(_ site: Site, _ name: String) -> Bool {
        if let c = site.categories, !c.isEmpty, !c.contains(name) { return false }
        let lv = level
        if lv == "all" { return true }
        if matches(adult, name) { return false }
        if lv == "kids", (site.categories ?? []).isEmpty, !matches(kidsCats, name) { return false }
        return true
    }

    static func visible(_ sites: [Site]) -> [Site] {
        let ok: (Site) -> Bool
        switch level {
        case "kids": ok = { $0.kids == true }
        case "standard": ok = { $0.adult != true }
        default: ok = { _ in true }
        }
        let keys = Set(sites.filter { $0.members == nil && ok($0) }.map(\.key))
        // A 聚合源 shows up when at least one of its members is allowed at this level.
        return sites.filter { $0.members == nil ? keys.contains($0.key) : ($0.members ?? []).contains { keys.contains($0) } }
    }

    /// 成人 sources (or a 聚合源 containing one) get no 豆瓣 rows on the home page.
    static func adultSite(_ s: Site) -> Bool {
        if s.adult == true { return true }
        guard let m = s.members else { return false }
        return Config.shared.sites.contains { $0.adult == true && m.contains($0.key) }
    }
}

/// Sources are user-editable and persisted; the bundled config is only the first-run default.
final class Config: ObservableObject {
    static let shared = Config()
    @Published var sites: [Site] { didSet { save() } }

    /// Same link (ignoring ac / pg / t / wd params, fragment, trailing slash) = same source: keep the first and point
    /// 聚合源 members at it. Run when leaving 设置, not on every keystroke. Returns how many were removed.
    @discardableResult func dedupe() -> Int {
        var seen: [String: String] = [:], remap: [String: String] = [:], out: [Site] = []
        for s in sites {
            if s.members != nil || !s.api.hasPrefix("http") { out.append(s); continue }
            let sig = Recognizer.normApi(s.api) + "|" + (s.categories ?? []).joined(separator: ",")
            if let keep = seen[sig] { remap[s.key] = keep; continue }
            seen[sig] = s.key
            out.append(s)
        }
        var seenLive = Set<String>()
        let ls = lives.filter { l in
            l.text != nil || !l.url.hasPrefix("http") || seenLive.insert(Recognizer.normURL(l.url)).inserted
        }
        let removed = (sites.count - out.count) + (lives.count - ls.count)
        guard removed > 0 else { return 0 }
        sites = out.map { s in
            guard var m = s.members else { return s }
            m = m.map { remap[$0] ?? $0 }
            var u = Set<String>(); m = m.filter { u.insert($0).inserted }
            var s = s; s.members = m; return s
        }
        lives = ls
        return removed
    }
    @Published var lives: [LiveSource] {
        didSet {
            if lives.contains(where: { $0.uid == nil }) { lives = Config.withIDs(lives) }
            save()
        }
    }

    static func withIDs(_ l: [LiveSource]) -> [LiveSource] {
        l.map { var x = $0; if x.uid == nil { x.uid = UUID().uuidString }; return x }
    }

    private init() {
        let d = UserDefaults.standard
        if let data = d.data(forKey: "cfg.sites"), let s = try? JSONDecoder().decode([Site].self, from: data) {
            sites = s
        } else {
            sites = Config.bundled().0
        }
        if let data = d.data(forKey: "cfg.lives"), let l = try? JSONDecoder().decode([LiveSource].self, from: data) {
            lives = Config.withIDs(l)
        } else {
            lives = Config.withIDs(Config.bundled().1)
        }
    }

    var visibleSites: [Site] { Safety.visible(sites) }

    private func save() {
        UserDefaults.standard.set(try? JSONEncoder().encode(sites), forKey: "cfg.sites")
        UserDefaults.standard.set(try? JSONEncoder().encode(lives), forKey: "cfg.lives")
    }

    static func bundled() -> ([Site], [LiveSource]) {
        guard let url = Bundle.main.url(forResource: "vod-apps", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return ([], []) }
        let lives = (obj["lives"] as? [[String: Any]] ?? []).map {
            LiveSource(name: API.str($0["name"]), url: API.str($0["url"]))
        }
        return (parseSites(obj["sites"]), lives)
    }

    func resetDefaults() {
        let (s, l) = Config.bundled()
        sites = s
        lives = l
    }

    func addSite() {
        var n = sites.count + 1
        while sites.contains(where: { $0.key == "新源\(n)" }) { n += 1 }
        sites.append(Site(key: "新源\(n)", name: "新源\(n)", api: "https://"))
    }

    private static func flag(_ v: Any?) -> Bool { ["1", "true"].contains(API.str(v)) }

    /// Keep what a phone can use directly: 苹果CMS JSON sites (type 1, http api).
    static func parseSites(_ raw: Any?) -> [Site] {
        var seen = Set<String>(), keys = Set<String>()
        return (raw as? [[String: Any]] ?? []).compactMap { s in
            let api = API.str(s["api"]).trimmingCharacters(in: .whitespaces)
            guard api.hasPrefix("http") else { return nil }
            if s["type"] != nil, API.str(s["type"]) != "1" { return nil }
            let cats = (s["categories"] as? [Any])?.map { API.str($0) }.filter { !$0.isEmpty } ?? []
            guard seen.insert(api + "|" + cats.joined(separator: ",")).inserted else { return nil }
            let name = API.str(s["name"]).trimmingCharacters(in: .whitespaces)
            var key = API.str(s["key"]).isEmpty ? (name.isEmpty ? api : name) : API.str(s["key"])
            while keys.contains(key) { key += "'" }
            keys.insert(key)
            var site = Site(key: key, name: name.isEmpty ? key : name, api: api)
            if flag(s["kids"]) { site.kids = true }
            if flag(s["adult"]) { site.adult = true }
            if !cats.isEmpty { site.categories = cats }
            return site
        }
    }

    static func parseLives(_ raw: Any?) -> [LiveSource] {
        (raw as? [[String: Any]] ?? []).compactMap { l in
            let url = API.str(l["url"]).trimmingCharacters(in: .whitespaces)
            guard url.hasPrefix("http") else { return nil }
            let name = API.str(l["name"])
            return LiveSource(name: name.isEmpty ? url : name, url: url)
        }
    }

    func merge(sites newSites: [Site], lives newLives: [LiveSource], replace: Bool) {
        var s = replace ? [] : sites
        for n in newSites where !s.contains(where: { Recognizer.normApi($0.api) == Recognizer.normApi(n.api) && $0.categories == n.categories }) {
            var n = n
            while s.contains(where: { $0.key == n.key }) { n.key += "'" }
            s.append(n)
        }
        var l = replace ? [] : lives
        for n in newLives where !l.contains(where: { n.text == nil ? $0.url == n.url : $0.text?.trimmingCharacters(in: .whitespacesAndNewlines) == n.text?.trimmingCharacters(in: .whitespacesAndNewlines) }) { l.append(n) }
        sites = s
        lives = l
    }
}

/// Reachability of each 点播源. Only rows that are actually on screen in the source picker ask for a ping
/// (6 at a time, one retry); results are cached (see below) so scrolling back / switching is instant.
@MainActor
final class SiteHealth: ObservableObject {
    static let shared = SiteHealth()
    struct Entry: Codable { var ok: Bool; var text: String; var at: Date }
    @Published private(set) var entries: [String: Entry] = [:] { didSet { persist() } }
    @Published private(set) var busy = Set<String>()
    private var saveTask: Task<Void, Never>?

    /// Results are cached on disk and stay valid until 重测; only a failure is looked at again after 10 minutes.
    init() {
        if let d = UserDefaults.standard.data(forKey: "site.health"), let e = try? JSONDecoder().decode([String: Entry].self, from: d) { entries = e }
    }
    private func persist() {
        saveTask?.cancel()
        saveTask = Task { [entries] in
            try? await Task.sleep(nanoseconds: 500_000_000)
            if !Task.isCancelled { UserDefaults.standard.set(try? JSONEncoder().encode(entries), forKey: "site.health") }
        }
    }
    func isBusy(_ s: Site) -> Bool { busy.contains(s.api) }
    private var queue: [String] = []
    private var running = 0

    func label(_ s: Site) -> String? {
        guard let e = entries[s.api] else { return nil }
        return e.ok ? e.text : "不通"
    }
    func isDead(_ s: Site) -> Bool { entries[s.api].map { !$0.ok } ?? false }

    /// Re-test these (the rows currently on screen), ignoring the cache.
    func retest(_ sites: [Site]) { for s in sites { request(s, force: true) } }

    /// Called from a row's onAppear.
    func request(_ s: Site, force: Bool = false) {
        guard !s.api.isEmpty, !busy.contains(s.api) else { return }
        if !force, let e = entries[s.api], e.ok || Date().timeIntervalSince(e.at) < 600 { return }
        busy.insert(s.api)
        queue.append(s.api)
        drain()
    }

    private func drain() {
        while running < 6, !queue.isEmpty {
            let api = queue.removeFirst()
            running += 1
            Task {
                var r = ""
                for k in 0...1 {
                    if k > 0 { try? await Task.sleep(nanoseconds: 600_000_000) }
                    r = await API.checkSite(api)
                    if r.hasPrefix("✓") { break }
                }
                let ok = r.hasPrefix("✓")
                let ms = r.split(separator: " ").dropFirst().first.map(String.init) ?? ""
                entries[api] = Entry(ok: ok, text: ok ? ms : "不通", at: Date())
                busy.remove(api)
                running -= 1
                drain()
            }
        }
    }
}
