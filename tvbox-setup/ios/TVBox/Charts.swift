import SwiftUI
import CryptoKit

// 榜单, modelled on 豆瓣's own pages (same three kinds as the web client):
//   精选榜单  subject_collection (Top250, 一周口碑榜, 实时热门…), ranked by 豆瓣
//   类型排行  movie.douban.com/typerank: one genre, "好于 X% 的同类影片"
//   年度榜    movie.douban.com/explore (选影视): 电影/电视剧/综艺 × 年份 × 类型 × 地区 × 排序
// Pages are cached on disk for 6 hours; opening the tab refetches stale ones, pull-to-refresh forces it,
// and a stale copy is shown when 豆瓣 doesn't answer.

struct ChartItem: Identifiable, Hashable {
    let id: String
    let name: String
    let pic: String
    let rate: String
    let votes: Int
    let rank: Int
    let sub: String
    let year: String
    let desc: String
    let remarks: String
    var douban: DoubanItem { DoubanItem(id: id, name: name, pic: pic, rate: rate, remarks: remarks) }
}

enum Charts {
    struct Collection: Hashable { let id, name, desc: String }
    static let collections = [
        Collection(id: "movie_top250", name: "豆瓣电影 Top250", desc: "看过人数与评分综合排名，每周更新"),
        Collection(id: "movie_weekly_best", name: "一周口碑电影榜", desc: "每周五更新"),
        Collection(id: "movie_real_time_hotest", name: "实时热门电影", desc: "最近的关注度"),
        Collection(id: "tv_chinese_best_weekly", name: "华语口碑剧集榜", desc: "每周三更新"),
        Collection(id: "tv_global_best_weekly", name: "全球口碑剧集榜", desc: "每周三更新"),
        Collection(id: "tv_real_time_hotest", name: "实时热门剧集", desc: "最近的关注度"),
        Collection(id: "show_chinese_best_weekly", name: "国内口碑综艺榜", desc: "每周三更新"),
        Collection(id: "show_global_best_weekly", name: "国外口碑综艺榜", desc: "每周三更新"),
    ]
    private static let allGenres: [(String, String)] = [("11", "剧情"), ("24", "喜剧"), ("5", "动作"), ("13", "爱情"), ("17", "科幻"),
        ("25", "动画"), ("10", "悬疑"), ("19", "惊悚"), ("20", "恐怖"), ("3", "犯罪"), ("16", "奇幻"), ("15", "冒险"), ("22", "战争"),
        ("4", "历史"), ("2", "传记"), ("28", "家庭"), ("8", "儿童"), ("14", "音乐"), ("7", "歌舞"), ("29", "武侠"), ("30", "古装"),
        ("12", "灾难"), ("27", "西部"), ("18", "运动"), ("31", "黑色电影"), ("1", "纪录片"), ("23", "短片"), ("26", "同性"), ("6", "情色")]
    static var genres: [(String, String)] { allGenres.filter { $0.0 != "6" || Safety.level == "all" } }
    static let intervals = [("100:90", "前 10%"), ("90:80", "10–20%"), ("80:70", "20–30%"), ("70:60", "30–40%"), ("60:50", "40–50%")]
    static let kinds = [("movie", "电影"), ("tv", "电视剧"), ("show", "综艺")]
    static let exploreGenres: [String: [String]] = [
        "movie": ["喜剧", "爱情", "动作", "科幻", "动画", "悬疑", "犯罪", "惊悚", "冒险", "奇幻", "恐怖", "战争", "历史", "传记", "音乐", "歌舞", "武侠", "灾难", "西部", "纪录片", "短片"],
        "tv": ["剧情", "喜剧", "爱情", "悬疑", "犯罪", "古装", "武侠", "家庭", "科幻", "奇幻", "动作", "历史", "战争", "惊悚", "恐怖", "动画", "传记"],
        "show": ["真人秀", "脱口秀", "音乐", "歌舞"],
    ]
    static let regions = ["华语", "欧美", "韩国", "日本", "中国大陆", "中国香港", "中国台湾", "美国", "英国", "法国", "德国", "意大利", "西班牙", "印度", "泰国", "俄罗斯"]
    static let sorts = [("S", "高分优先"), ("T", "综合"), ("U", "近期热度"), ("R", "最新上映")]
    static var years: [String] {
        let y = Calendar.current.component(.year, from: Date())
        return (0..<8).map { String(y - $0) } + ["2010年代", "2000年代", "90年代", "80年代", "70年代", "60年代", "更早"]
    }
    /// 高分优先 on 豆瓣 puts concert films with a few hundred votes first; a vote floor makes it a real ranking.
    static let minVotes = ["movie": 5000, "tv": 2000, "show": 500]

    struct Page { var items: [ChartItem]; var next: Int; var end: Bool; var updated: Date }

    // MARK: disk cache

    static let ttl: TimeInterval = 6 * 3600
    private static let dir: URL = {
        let d = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("charts")
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }()
    private static func file(_ u: URL) -> URL {
        dir.appendingPathComponent(SHA256.hash(data: Data(u.absoluteString.utf8)).prefix(12).map { String(format: "%02x", $0) }.joined())
    }

    private static func json(_ u: URL, fresh: Bool) async -> (Any, Date)? {
        let f = file(u)
        let at = (try? f.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
        let cached = (try? Data(contentsOf: f)).flatMap { try? JSONSerialization.jsonObject(with: $0) }
        if !fresh, let cached, let at, Date().timeIntervalSince(at) < ttl { return (cached, at) }
        if let d = try? await API.fetch(u, referer: "https://movie.douban.com/", timeout: 12),
           let obj = try? JSONSerialization.jsonObject(with: d) {
            try? d.write(to: f, options: .atomic)
            return (obj, Date())
        }
        if let cached, let at { return (cached, at) }
        return nil
    }

    private static func rate(_ v: Any?) -> String {
        let d = Double(API.str(v)) ?? 0
        return d > 0 ? String(format: "%.1f", d) : ""
    }
    private static func subject(_ x: [String: Any]) -> ChartItem {
        let r = x["rating"] as? [String: Any] ?? [:]
        let sub = API.str(x["card_subtitle"])
        let pic = (x["pic"] as? [String: Any]).map { API.str($0["normal"]) } ?? API.str(x["cover_url"])
        let comment = (x["comment"] as? [String: Any]).map { API.str($0["comment"]) } ?? ""
        let desc = API.str(x["description"]).isEmpty ? comment : API.str(x["description"])
        return ChartItem(id: API.str(x["id"]), name: API.str(x["title"]), pic: pic, rate: rate(r["value"]),
                         votes: Int(API.str(r["count"])) ?? 0, rank: Int(API.str(x["rank"])) ?? 0, sub: sub,
                         year: sub.count >= 4 && Int(sub.prefix(4)) != nil ? String(sub.prefix(4)) : "",
                         desc: String(desc.prefix(120)), remarks: API.str(x["episodes_info"]))
    }
    private static func isTitle(_ x: [String: Any]) -> Bool { ["movie", "tv"].contains(API.str(x["type"])) }

    // MARK: lists

    static func collection(_ id: String, start: Int, fresh: Bool = false) async -> Page? {
        var c = URLComponents(string: "https://m.douban.com/rexxar/api/v2/subject_collection/\(id)/items")!
        c.queryItems = [.init(name: "start", value: String(start)), .init(name: "count", value: "50")]
        guard let (o, at) = await json(c.url!, fresh: fresh), let obj = o as? [String: Any] else { return nil }
        let raw = obj["subject_collection_items"] as? [[String: Any]] ?? []
        let total = Int(API.str(obj["total"])) ?? 0
        return Page(items: raw.filter(isTitle).map(subject), next: start + 50, end: raw.isEmpty || start + 50 >= total, updated: at)
    }

    static func genre(_ type: String, interval: String, start: Int, fresh: Bool = false) async -> Page? {
        var c = URLComponents(string: "https://movie.douban.com/j/chart/top_list")!
        c.queryItems = [.init(name: "type", value: type), .init(name: "interval_id", value: interval), .init(name: "action", value: ""),
                        .init(name: "start", value: String(start)), .init(name: "limit", value: "20")]
        guard let (o, at) = await json(c.url!, fresh: fresh), let list = o as? [[String: Any]] else { return nil }
        let items = list.map { x in
            ChartItem(id: API.str(x["id"]), name: API.str(x["title"]), pic: API.str(x["cover_url"]), rate: rate(x["score"]),
                      votes: Int(API.str(x["vote_count"])) ?? 0, rank: Int(API.str(x["rank"])) ?? 0,
                      sub: [(x["regions"] as? [String] ?? []).joined(separator: " "), (x["types"] as? [String] ?? []).joined(separator: " "),
                            (x["actors"] as? [String] ?? []).prefix(3).joined(separator: " ")].filter { !$0.isEmpty }.joined(separator: " / "),
                      year: String(API.str(x["release_date"]).prefix(4)), desc: "", remarks: "")
        }
        return Page(items: items, next: start + 20, end: list.count < 20, updated: at)
    }

    struct Filter: Hashable {
        var kind = "movie", year = Charts.years[0], genre = "", region = "", sort = "S"
        var title: String {
            let k = Charts.kinds.first { $0.0 == kind }?.1 ?? ""
            let s = ["S": "高分榜", "T": "综合榜", "U": "热度榜", "R": "新片"][sort] ?? ""
            return [year.isEmpty ? "历年" : year, region, genre].filter { !$0.isEmpty }.joined(separator: " · ") + " \(k)\(s)"
        }
    }

    static func explore(_ f: Filter, start: Int, fresh: Bool = false) async -> Page? {
        let form = ["tv": "电视剧", "show": "综艺"][f.kind]
        var sel: [String: String] = [:]
        if let form { sel["形式"] = form }
        if !f.genre.isEmpty { sel["类型"] = f.genre }
        if !f.region.isEmpty { sel["地区"] = f.region }
        let selJSON = String(decoding: (try? JSONSerialization.data(withJSONObject: sel, options: .sortedKeys)) ?? Data("{}".utf8), as: UTF8.self)
        var c = URLComponents(string: "https://m.douban.com/rexxar/api/v2/\(f.kind == "movie" ? "movie" : "tv")/recommend")!
        c.queryItems = [.init(name: "refresh", value: "0"), .init(name: "start", value: String(start)), .init(name: "count", value: "30"),
                        .init(name: "selected_categories", value: selJSON), .init(name: "uncollect", value: "false"),
                        .init(name: "tags", value: [form ?? "", f.genre, f.region, f.year].filter { !$0.isEmpty }.joined(separator: ",")),
                        .init(name: "sort", value: f.sort)]
        guard let (o, at) = await json(c.url!, fresh: fresh), let obj = o as? [String: Any] else { return nil }
        let raw = obj["items"] as? [[String: Any]] ?? []
        let floor = f.sort == "S" ? minVotes[f.kind] ?? 0 : 0
        let items = raw.filter { isTitle($0) && (floor == 0 || (Int(API.str(($0["rating"] as? [String: Any])?["count"])) ?? 0) >= floor) }.map(subject)
        let total = Int(API.str(obj["total"])) ?? 0
        return Page(items: items, next: start + 30, end: raw.isEmpty || start + 30 >= total, updated: at)
    }

    static func ago(_ d: Date) -> String {
        let m = Int(Date().timeIntervalSince(d) / 60)
        return m < 2 ? "刚刚" : m < 60 ? "\(m) 分钟前" : m < 1440 ? "\(m / 60) 小时前" : "\(m / 1440) 天前"
    }
    static func votes(_ v: Int) -> String { v >= 10000 ? String(format: v >= 100000 ? "%.0f万" : "%.1f万", Double(v) / 10000) : "\(v)" }
}

// MARK: - Views

struct ChartCollectionRoute: Hashable { let c: Charts.Collection }

struct ChartsView: View {
    @AppStorage("charts.tab") private var tab = 0
    @State private var token = 0

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Picker("", selection: $tab) {
                    Text("精选榜单").tag(0); Text("类型排行").tag(1); Text("年度榜").tag(2)
                }
                .pickerStyle(.segmented).padding(.horizontal)
                switch tab {
                case 1: GenreChart(token: token)
                case 2: YearChart(token: token)
                default: FeaturedCharts(token: token)
                }
            }
            .padding(.bottom, 30)
        }
        .background(Color.black)
        .navigationTitle("榜单")
        .appDestinations()
        .navigationDestination(for: ChartCollectionRoute.self) { r in
            ScrollView { RankedList(key: r.c.id, token: 0, note: r.c.desc) { await Charts.collection(r.c.id, start: $0, fresh: $1) }.padding(.vertical) }
                .background(Color.black).navigationTitle(r.c.name).navigationBarTitleDisplayMode(.inline)
        }
        .refreshable { token += 1 }
    }
}

/// One Top 10 row per 豆瓣 collection.
struct FeaturedCharts: View {
    let token: Int
    @State private var rows: [String: [ChartItem]] = [:]
    @State private var updated: Date?

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            if let updated {
                Text("数据来自豆瓣 · 更新于 \(Charts.ago(updated)) · 点影片在所有源里找").font(.caption).foregroundStyle(.secondary).padding(.horizontal)
            }
            ForEach(Charts.collections, id: \.id) { c in
                if rows[c.id].map({ !$0.isEmpty }) ?? true {
                    VStack(alignment: .leading, spacing: 8) {
                        NavigationLink(value: ChartCollectionRoute(c: c)) {
                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                Text(c.name).font(.title3.weight(.bold))
                                Image(systemName: "chevron.right").font(.caption.weight(.bold)).foregroundStyle(.secondary)
                                Text(c.desc).font(.caption2).foregroundStyle(.secondary)
                            }.foregroundStyle(.white)
                        }.padding(.horizontal)
                        ScrollView(.horizontal, showsIndicators: false) {
                            LazyHStack(spacing: 4) {
                                if let items = rows[c.id] {
                                    ForEach(Array(items.prefix(10).enumerated()), id: \.element.id) { i, it in
                                        NavigationLink(value: it.douban) { Top10Cell(n: it.rank > 0 ? it.rank : i + 1, item: it) }.buttonStyle(.press)
                                    }
                                } else {
                                    ForEach(1...4, id: \.self) { n in Top10Cell(n: n, item: nil) }
                                }
                            }.padding(.horizontal)
                        }
                    }
                }
            }
        }
        .task(id: token) {
            await withTaskGroup(of: (String, Charts.Page?).self) { g in
                for c in Charts.collections { g.addTask { (c.id, await Charts.collection(c.id, start: 0, fresh: token > 0)) } }
                for await (id, p) in g {
                    rows[id] = p?.items ?? []
                    if let at = p?.updated { updated = min(updated ?? at, at) }
                }
            }
        }
    }
}

struct Top10Cell: View {
    let n: Int
    let item: ChartItem?
    var body: some View {
        HStack(alignment: .bottom, spacing: -18) {
            Text("\(n)").font(.system(size: 92, weight: .black)).tracking(-6)
                .foregroundStyle(Color(white: 0.06))
                .shadow(color: Color(white: 0.45), radius: 0, x: 1.2, y: 0).shadow(color: Color(white: 0.45), radius: 0, x: -1.2, y: 0)
                .shadow(color: Color(white: 0.45), radius: 0, x: 0, y: 1.2).shadow(color: Color(white: 0.45), radius: 0, x: 0, y: -1.2)
                .offset(y: -14)
            VStack(alignment: .leading, spacing: 4) {
                Color.clear.frame(width: 104, height: 156)
                    .overlay { if let item { Poster(url: item.pic) } else { Rectangle().fill(Color.card) } }
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                    .overlay(alignment: .bottomTrailing) { if let r = item?.rate, !r.isEmpty { RateBadge(rate: r).padding(4) } }
                    .shadow(color: .black.opacity(0.8), radius: 6, x: -4)
                Text(item?.name ?? " ").font(.caption).foregroundStyle(.white.opacity(0.85)).lineLimit(1).frame(width: 104, alignment: .leading)
            }
        }
    }
}

/// Wrapping-free chip row: one horizontally scrolling line per filter.
struct ChipRow: View {
    let label: String
    let options: [(String, String)]  // (value, title)
    @Binding var value: String
    var body: some View {
        HStack(spacing: 8) {
            Text(label).font(.caption).foregroundStyle(.secondary).frame(width: 30, alignment: .leading)
            ScrollViewReader { proxy in
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 4) {
                        ForEach(options, id: \.0) { v, t in
                            Button(t) { value = v }.buttonStyle(.press(.chip(v == value))).id(v)
                        }
                    }
                }
                .onAppear { proxy.scrollTo(value, anchor: .center) }
            }
        }
    }
}

struct GenreChart: View {
    let token: Int
    @AppStorage("charts.genre") private var genre = "11"
    @AppStorage("charts.interval") private var interval = "100:90"

    var body: some View {
        let name = Charts.genres.first { $0.0 == genre }?.1 ?? "剧情"
        let pian = name.hasSuffix("片") || name.hasSuffix("电影") ? name : name + "片"
        VStack(alignment: .leading, spacing: 10) {
            VStack(spacing: 6) {
                ChipRow(label: "类型", options: Charts.genres, value: $genre)
                ChipRow(label: "排名", options: Charts.intervals, value: $interval)
            }
            .padding(10).background(Color.card.opacity(0.6), in: RoundedRectangle(cornerRadius: 10)).padding(.horizontal)
            Text("\(pian)排行榜").font(.title3.weight(.bold)).padding(.horizontal)
            RankedList(key: genre + "|" + interval, token: token,
                       note: "豆瓣评分排在所有\(pian)的\((Charts.intervals.first { $0.0 == interval }?.1 ?? "").replacingOccurrences(of: "前 ", with: "前"))") {
                await Charts.genre(genre, interval: interval, start: $0, fresh: $1)
            }
        }
    }
}

struct YearChart: View {
    let token: Int
    @State private var f = Charts.Filter()

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(spacing: 6) {
                ChipRow(label: "类别", options: Charts.kinds, value: Binding(get: { f.kind }, set: { f.kind = $0; f.genre = "" }))
                ChipRow(label: "年份", options: [("", "全部")] + Charts.years.map { ($0, $0) }, value: $f.year)
                ChipRow(label: "类型", options: [("", "全部")] + (Charts.exploreGenres[f.kind] ?? []).map { ($0, $0) }, value: $f.genre)
                ChipRow(label: "地区", options: [("", "全部")] + Charts.regions.map { ($0, $0) }, value: $f.region)
                ChipRow(label: "排序", options: Charts.sorts, value: $f.sort)
            }
            .padding(10).background(Color.card.opacity(0.6), in: RoundedRectangle(cornerRadius: 10)).padding(.horizontal)
            Text(f.title).font(.title3.weight(.bold)).padding(.horizontal)
            RankedList(key: "\(f.kind)|\(f.year)|\(f.genre)|\(f.region)|\(f.sort)", token: token,
                       note: f.sort == "S" ? "只算评价人数 ≥ \(Charts.votes(Charts.minVotes[f.kind] ?? 0)) 的，免得冷门片冲到榜首" : nil) {
                await Charts.explore(f, start: $0, fresh: $1)
            }
        }
    }
}

/// Ranked list with infinite scroll. Numbers come from 豆瓣 when it ranks (collections, typerank), else by order.
struct RankedList: View {
    let key: String
    let token: Int
    var note: String?
    let load: (Int, Bool) async -> Charts.Page?
    @State private var items: [ChartItem] = []
    @State private var next = 0
    @State private var end = false
    @State private var loading = false
    @State private var failed = false
    @State private var updated: Date?
    @State private var loadedToken = 0

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 0) {
            if note != nil || updated != nil {
                Text([note, updated.map { "更新于 \(Charts.ago($0))" }].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary).padding(.horizontal).padding(.bottom, 6)
            }
            ForEach(Array(items.enumerated()), id: \.element.id) { i, it in
                NavigationLink(value: it.douban) { RankRow(n: it.rank > 0 ? it.rank : i + 1, item: it) }.buttonStyle(.press)
                    .onAppear { if i >= items.count - 4 { Task { await more(fresh: false) } } }
                Divider().overlay(Color.white.opacity(0.06)).padding(.leading, 56)
            }
            Group {
                if loading { ProgressView().frame(maxWidth: .infinity).padding() }
                else if failed { Text("豆瓣没响应，下拉重试").foregroundStyle(.orange).padding() }
                else if end && items.isEmpty { Text("没有符合条件的影片，放宽一下筛选").foregroundStyle(.secondary).padding() }
                else if end { Text("— 到底了 —").font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity).padding() }
            }.font(.footnote)
        }
        .task(id: "\(key)#\(token)") {
            let fresh = token != loadedToken
            loadedToken = token
            items = []; next = 0; end = false; failed = false; updated = nil
            await more(fresh: fresh)
        }
    }

    private func more(fresh: Bool) async {
        guard !loading, !end else { return }
        loading = true
        defer { loading = false }
        let k = key
        // Filtered pages (vote floor) can come back empty while more remain; keep going a few pages.
        for _ in 0..<5 {
            guard let p = await load(next, fresh), k == key else { failed = items.isEmpty; end = true; return }
            let seen = Set(items.map(\.id))
            items += p.items.filter { !seen.contains($0.id) }
            next = p.next; end = p.end
            updated = min(updated ?? p.updated, p.updated)
            if !p.items.isEmpty || end { return }
        }
    }
}

struct RankRow: View {
    let n: Int
    let item: ChartItem
    var body: some View {
        HStack(spacing: 12) {
            Text("\(n)").font(.system(size: n < 100 ? 20 : 15, weight: .heavy)).monospacedDigit()
                .foregroundStyle(n <= 3 ? Color.brand : Color(white: 0.45)).frame(width: 34)
            Color.clear.frame(width: 64, height: 96).overlay(Poster(url: item.pic, px: 200)).clipShape(RoundedRectangle(cornerRadius: 4))
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(item.name).font(.headline).lineLimit(1)
                    if !item.year.isEmpty { Text(item.year).font(.caption).foregroundStyle(.secondary) }
                }
                HStack(spacing: 6) {
                    if let r = Double(item.rate) {
                        Stars(value: r)
                        Text(item.rate).font(.subheadline.weight(.bold)).foregroundStyle(Color(red: 1, green: 0.71, blue: 0))
                    } else { Text("暂无评分").font(.caption).foregroundStyle(.secondary) }
                    if item.votes > 0 { Text("\(Charts.votes(item.votes))人评价").font(.caption).foregroundStyle(.secondary) }
                }
                if !item.sub.isEmpty { Text(item.sub).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                if !item.desc.isEmpty { Text("“\(item.desc)”").font(.caption).italic().foregroundStyle(.white.opacity(0.7)).lineLimit(1) }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal).padding(.vertical, 8)
        .contentShape(Rectangle())
        .contextMenu {
            if let u = URL(string: "https://movie.douban.com/subject/\(item.id)/") { Link(destination: u) { Label("在豆瓣打开", systemImage: "safari") } }
        }
    }
}

struct Stars: View {
    let value: Double  // 0–10
    var body: some View {
        let row = HStack(spacing: 1) { ForEach(0..<5, id: \.self) { _ in Image(systemName: "star.fill") } }.font(.system(size: 10))
        row.foregroundStyle(Color(white: 0.3))
            .overlay(alignment: .leading) {
                GeometryReader { g in
                    row.foregroundStyle(Color(red: 1, green: 0.71, blue: 0)).frame(width: g.size.width, alignment: .leading)
                        .mask(alignment: .leading) { Rectangle().frame(width: g.size.width * min(1, value / 10)) }
                }
            }
            .fixedSize()
    }
}
