import Foundation

struct Site: Identifiable, Hashable, Codable {
    var key: String
    var name: String
    var api: String
    var kids: Bool? = nil        // shown in 儿童 mode
    var adult: Bool? = nil       // only shown at 安全级别 = 全部
    var categories: [String]? = nil  // TVBox-style whitelist of category names
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
        switch level {
        case "kids": return sites.filter { $0.kids == true }
        case "standard": return sites.filter { $0.adult != true }
        default: return sites
        }
    }
}

/// Sources are user-editable and persisted; the bundled config is only the first-run default.
final class Config: ObservableObject {
    static let shared = Config()
    @Published var sites: [Site] { didSet { save() } }
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
