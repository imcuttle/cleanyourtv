import SwiftUI

extension Color {
    static let brand = Color(red: 0.898, green: 0.035, blue: 0.078) // Netflix red
    static let card = Color(white: 0.14)
    static let douban = Color(red: 0.0, green: 0.71, blue: 0.11)
}

struct RateBadge: View {
    let rate: String
    var body: some View {
        Text(rate).font(.system(size: 10, weight: .heavy))
            .padding(.horizontal, 4).padding(.vertical, 1)
            .background(Color.douban).foregroundStyle(.white)
            .clipShape(RoundedRectangle(cornerRadius: 3))
    }
}

struct PosterCell: View {
    let item: VodItem
    var width: CGFloat? = nil
    var showSite = false
    var progress: Double = 0
    @State private var rate: String

    init(item: VodItem, width: CGFloat? = nil, showSite: Bool = false, progress: Double = 0) {
        self.item = item; self.width = width; self.showSite = showSite; self.progress = progress
        _rate = State(initialValue: API.cachedRating(name: item.name, year: item.year)?.rate ?? "")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Color.clear
                .aspectRatio(2 / 3, contentMode: .fit)
                .overlay(Poster(url: item.pic))
                .overlay(alignment: .bottom) {
                    if progress > 0 {
                        GeometryReader { g in
                            Rectangle().fill(Color.brand).frame(width: g.size.width * progress, height: 3)
                                .frame(maxHeight: .infinity, alignment: .bottom)
                        }
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 6))
                .overlay(alignment: .topLeading) {
                    if !item.remarks.isEmpty {
                        Text(item.remarks).font(.system(size: 10, weight: .semibold)).lineLimit(1)
                            .padding(.horizontal, 5).padding(.vertical, 2)
                            .background(Color.brand).foregroundStyle(.white)
                            .clipShape(RoundedRectangle(cornerRadius: 3)).padding(5)
                    }
                }
                .overlay(alignment: .bottomTrailing) { if !rate.isEmpty { RateBadge(rate: rate).padding(5) } }
            Text(item.name).font(.caption).foregroundStyle(.white.opacity(0.85)).lineLimit(1)
            if showSite { Text(item.site.name).font(.caption2).foregroundStyle(.secondary) }
        }
        .frame(width: width)
        .task(id: item.id) {
            guard rate.isEmpty, API.cachedRating(name: item.name, year: item.year) == nil else { return }
            try? await Task.sleep(nanoseconds: 250_000_000)  // skip posters that only fly past while scrolling
            if !Task.isCancelled { rate = await API.doubanRating(name: item.name, year: item.year).rate }
        }
    }
}

struct DoubanCell: View {
    let item: DoubanItem
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Color.clear
                .aspectRatio(2 / 3, contentMode: .fit)
                .overlay(Poster(url: item.pic))
                .clipShape(RoundedRectangle(cornerRadius: 6))
                .overlay(alignment: .bottomTrailing) { if !item.rate.isEmpty { RateBadge(rate: item.rate).padding(5) } }
            Text(item.name).font(.caption).foregroundStyle(.white.opacity(0.85)).lineLimit(1)
        }
        .frame(width: 112)
    }
}

let gridColumns = [GridItem(.adaptive(minimum: 105), spacing: 10)]

// MARK: - Home

struct Row: Identifiable {
    let cat: VodCategory
    var items: [VodItem]
    var id: String { cat.id }
}

struct VodHomeView: View {
    @ObservedObject private var cfg = Config.shared
    @ObservedObject private var lib = Library.shared
    @AppStorage("safety.level") private var level = "standard"
    @AppStorage("siteKey") private var siteKey = ""
    @State private var showPicker = false
    @AppStorage("douban.tv") private var dbTv = true
    @AppStorage("douban.movie") private var dbMovie = true
    @AppStorage("douban.show") private var dbShow = true
    @AppStorage("douban.anime") private var dbAnime = true
    @State private var cats: [VodCategory] = []
    @State private var latest: [VodItem] = []
    @State private var rows: [Row] = []
    @State private var tvHot: [DoubanItem] = []
    @State private var movieHot: [DoubanItem] = []
    @State private var showHot: [DoubanItem] = []
    @State private var animeHot: [DoubanItem] = []
    @State private var error: String?
    @State private var loading = false
    @State private var loadedKey = ""

    private var sites: [Site] { Safety.visible(cfg.sites) }
    private var site: Site? { sites.first { $0.key == siteKey } ?? sites.first }
    // Reload only when what we show actually changes — not every time the view reappears (back-swipe).
    private var loadKey: String { "\(site?.key ?? "")|\(site?.api ?? "")|\((site?.members ?? []).joined(separator: ","))|\(level)|\(dbTv)\(dbMovie)\(dbShow)\(dbAnime)" }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                if !latest.isEmpty { Hero(items: Array(latest.prefix(6))) } else { Color.clear.frame(height: 100) }
                if let error {
                    Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.orange).padding(.horizontal)
                }
                if loading && latest.isEmpty { ProgressView().frame(maxWidth: .infinity, minHeight: 300) }
                let cont = lib.history.prefix(20).compactMap { e in e.item.map { (e, $0) } }
                if !cont.isEmpty { historyRow(Array(cont)) }
                let favs = level == "kids" ? [] : lib.favorites.prefix(30).compactMap(\.item)
                if !favs.isEmpty { vodRow("我的收藏", Array(favs), nil) }
                if latest.count > 6 {
                    vodRow(level == "kids" ? "少儿精选" : "最新更新", Array(latest.dropFirst(6)), VodCategory(id: "", pid: "", name: level == "kids" ? "少儿精选" : "最新更新"))
                }
                if level != "kids", !(site.map(Safety.adultSite) ?? false) {
                    if dbTv, !tvHot.isEmpty { doubanRow("豆瓣热门剧集", tvHot) }
                    if dbMovie, !movieHot.isEmpty { doubanRow("豆瓣热门电影", movieHot) }
                    if dbShow, !showHot.isEmpty { doubanRow("豆瓣热门综艺", showHot) }
                    if dbAnime, !animeHot.isEmpty { doubanRow("豆瓣热门动漫", animeHot) }
                }
                ForEach(rows) { vodRow($0.cat.name, $0.items, $0.cat) }
                if !cats.isEmpty { allCategories }
            }
            .padding(.bottom, 30)
        }
        .ignoresSafeArea(edges: .top)
        .background(Color.black)
        .appDestinations()
        .toolbarBackground(.hidden, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                HStack(spacing: 8) {
                    Text("TVBOX").font(.system(size: 24, weight: .black)).foregroundStyle(Color.brand)
                    if level == "kids" { Tag(text: "儿童模式", color: .green) }
                }
                .shadow(color: .black.opacity(0.6), radius: 4)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { showPicker = true } label: {
                    HStack(spacing: 4) {
                        Text(site?.name ?? "无源").font(.subheadline.weight(.semibold))
                        Image(systemName: "chevron.down").font(.caption2.weight(.bold))
                    }
                    .foregroundStyle(.white)
                    .shadow(color: .black.opacity(0.6), radius: 4)
                }
                .popover(isPresented: $showPicker, attachmentAnchor: .point(.bottom), arrowEdge: .top) {
                    SitePicker(sites: sites, current: site?.key) { siteKey = $0; showPicker = false }
                        .presentationCompactAdaptation(.popover)
                }
            }
        }
        .refreshable { await load() }
        .task(id: loadKey) { if loadedKey != loadKey { await load() } }
    }

    private func header(_ title: String) -> some View {
        HStack(spacing: 4) {
            Text(title).font(.title3.weight(.bold))
            Image(systemName: "chevron.right").font(.caption.weight(.bold)).foregroundStyle(.secondary)
        }.foregroundStyle(.white)
    }

    private func historyRow(_ list: [(LibEntry, VodItem)]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            NavigationLink { HistoryView() } label: { header("继续观看") }.buttonStyle(.press).padding(.horizontal)
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 8) {
                    ForEach(list, id: \.0.id) { e, item in
                        NavigationLink(value: item) {
                            VStack(alignment: .leading, spacing: 2) {
                                PosterCell(item: item, width: 112, progress: e.progress)
                                Text(e.epName).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                        .buttonStyle(.press)
                        .contextMenu { Button("从观看历史删除", systemImage: "trash", role: .destructive) { Library.shared.deleteHistory(e.id) } }
                    }
                }.padding(.horizontal)
            }
        }
    }

    @ViewBuilder private func vodRow(_ title: String, _ items: [VodItem], _ cat: VodCategory?) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let cat, let site {
                NavigationLink(value: CatRoute(site: site, cat: cat)) { header(title) }.buttonStyle(.press).padding(.horizontal)
            } else if cat == nil {
                NavigationLink { FavoritesView() } label: { header(title) }.buttonStyle(.press).padding(.horizontal)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 8) {
                    ForEach(items) { item in
                        NavigationLink(value: item) { PosterCell(item: item, width: 112) }.buttonStyle(.press)
                    }
                }.padding(.horizontal)
            }
        }
    }

    private func doubanRow(_ title: String, _ items: [DoubanItem]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.title3.weight(.bold)).padding(.horizontal)
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 8) {
                    ForEach(items) { item in
                        NavigationLink(value: item) { DoubanCell(item: item) }.buttonStyle(.press)
                    }
                }.padding(.horizontal)
            }
        }
    }

    private var allCategories: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("全部分类").font(.title3.weight(.bold)).padding(.horizontal)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 84), spacing: 8)], spacing: 8) {
                ForEach(cats) { c in
                    NavigationLink(value: CatRoute(site: site!, cat: c)) {
                        Text(c.name).font(.subheadline).lineLimit(1)
                            .frame(maxWidth: .infinity).padding(.vertical, 9)
                            .background(Color.card).foregroundStyle(.white)
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                    .buttonStyle(.press)
                }
            }.padding(.horizontal)
        }
    }

    private func load() async {
        loadedKey = loadKey
        latest = []; rows = []; cats = []; tvHot = []; movieHot = []; showHot = []; animeHot = []; error = nil
        guard let site else {
            error = level == "kids" ? "儿童模式下没有少儿源，去「设置」添加或标记" : "还没有点播源，去「设置」添加"
            return
        }
        loading = true
        defer { loading = false }
        if level != "kids", !Safety.adultSite(site) {
            let (wantTv, wantMovie, wantShow, wantAnime) = (dbTv, dbMovie, dbShow, dbAnime)
            Task {
                async let tv = wantTv ? API.doubanHot("tv") : []
                async let mv = wantMovie ? API.doubanHot("movie") : []
                async let sh = wantShow ? API.doubanHot("show") : []
                async let an = wantAnime ? API.doubanHot("anime") : []
                (tvHot, movieHot, showHot, animeHot) = await (tv, mv, sh, an)
            }
        }
        do {
            let first = try await API.list(site, typeId: "", page: 1).0
            ImagePipeline.shared.prefetch(first.prefix(6).map(\.pic), 1000)
            ImagePipeline.shared.prefetch(first.map(\.pic))
            latest = first
        } catch {
            self.error = "\(site.name) 打不开：\(error.localizedDescription)。右上角换个源试试"
            return
        }
        cats = (try? await API.categories(site)) ?? []
        let wanted = (level == "kids" || cats.count <= 8) ? Array(cats.prefix(8)) : API.homeRows(cats)
        let loaded = await withTaskGroup(of: (Int, [VodItem]).self) { group in
            for (i, c) in wanted.enumerated() {
                group.addTask { (i, (try? await API.list(site, typeId: c.id, page: 1).0) ?? []) }
            }
            var out: [Int: [VodItem]] = [:]
            for await (i, items) in group { out[i] = items }
            return out
        }
        ImagePipeline.shared.prefetch(loaded.values.flatMap { $0.prefix(8).map(\.pic) })
        rows = wanted.enumerated().compactMap { i, c in
            let items = loaded[i] ?? []
            return items.isEmpty ? nil : Row(cat: c, items: items)
        }
    }
}

struct Hero: View {
    let items: [VodItem]
    @State private var index = 0
    @State private var rates: [String: String] = [:]
    @State private var pics: [String: String] = [:]   // 豆瓣 poster per item, drawn over the source's own
    private let timer = Timer.publish(every: 6, on: .main, in: .common).autoconnect()

    var body: some View {
        TabView(selection: $index) {
            ForEach(items.indices, id: \.self) { i in slide(items[i]).tag(i) }
        }
        .tabViewStyle(.page(indexDisplayMode: .always))
        .frame(height: 540)
        .onReceive(timer) { _ in withAnimation { index = (index + 1) % max(items.count, 1) } }
        .task(id: items.map(\.id)) {
            for it in items where rates[it.id] == nil {
                let r = await API.doubanRating(name: it.name, year: it.year)
                rates[it.id] = r.rate
                if !r.pic.isEmpty { withAnimation(.easeInOut(duration: 0.4)) { pics[it.id] = r.pic } }
            }
        }
    }

    private func slide(_ item: VodItem) -> some View {
        ZStack(alignment: .bottom) {
            Color.clear.overlay(Poster(url: item.pic, px: 1000))
                .overlay { if let p = pics[item.id] { Poster(url: p, px: 1000, placeholder: false) } }
                .clipped()
            LinearGradient(colors: [.black.opacity(0.55), .clear, .clear, .black.opacity(0.7), .black],
                           startPoint: .top, endPoint: .bottom)
            VStack(spacing: 10) {
                Text(item.name).font(.system(size: 30, weight: .heavy)).multilineTextAlignment(.center)
                    .lineLimit(2).shadow(radius: 6)
                HStack(spacing: 8) {
                    if let r = rates[item.id], !r.isEmpty { RateBadge(rate: "豆瓣 \(r)") }
                    Text([item.typeName, item.remarks].filter { !$0.isEmpty }.joined(separator: "  •  "))
                        .font(.footnote.weight(.medium)).foregroundStyle(.white.opacity(0.8))
                }
                NavigationLink(value: item) {
                    Label("播放", systemImage: "play.fill").padding(.horizontal, 18)
                }
                .buttonStyle(.press(.primary))
            }
            .padding(.horizontal, 24).padding(.bottom, 44)
        }
    }
}

// MARK: - Category grid

struct CategoryGridView: View {
    let site: Site
    let cat: VodCategory
    @State private var items: [VodItem] = []
    @State private var page = 1
    @State private var pageCount = 1
    @State private var loading = false
    @State private var error: String?

    var body: some View {
        ScrollView {
            if let error { Text(error).foregroundStyle(.orange).padding() }
            LazyVGrid(columns: gridColumns, spacing: 16) {
                ForEach(items) { item in
                    NavigationLink(value: item) { PosterCell(item: item) }.buttonStyle(.press)
                        .onAppear { if item == items.last { Task { await fetch(next: true) } } }
                }
            }.padding(.horizontal)
            if loading { ProgressView().padding() }
        }
        .background(Color.black)
        .navigationTitle(cat.name)
        .task { if items.isEmpty { await fetch(next: false) } }
    }

    private func fetch(next: Bool) async {
        guard !loading, !next || page < pageCount else { return }
        loading = true
        defer { loading = false }
        let pg = next ? page + 1 : 1
        do {
            let (list, pc) = try await API.list(site, typeId: cat.id, page: pg)
            items += list.filter { n in !items.contains { $0.id == n.id } }
            page = pg; pageCount = pc
        } catch { self.error = error.localizedDescription }
    }
}

// MARK: - Detail

struct VodDetailView: View {
    @State var item: VodItem
    @ObservedObject private var dm = DownloadManager.shared
    @ObservedObject private var lib = Library.shared
    @AppStorage("safety.level") private var level = "standard"
    @State private var detail: VodDetail?
    @State private var lineIdx = 0
    @State private var error: String?
    @State private var playing: PlayRequest?
    @State private var matches: [VodItem]?  // same title on every source, searched once
    @State private var douban = DoubanRating()
    @State private var dlMode = false
    @State private var note: String?
    @State private var loadedId = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header
                VStack(alignment: .leading, spacing: 14) {
                    Text(item.name).font(.system(size: 26, weight: .heavy))
                    meta
                    actions
                    if let error { Text(error).foregroundStyle(.orange).font(.footnote) }
                    if let d = detail {
                        let text = d.content.isEmpty ? item.blurb : d.content
                        if !text.isEmpty { Text(text).font(.subheadline).foregroundStyle(.white.opacity(0.8)).lineLimit(5) }
                        PeopleRow(label: "导演", role: "director", names: d.directors)
                        PeopleRow(label: "演员", role: "actor", names: d.actors, max: 12)
                        episodes(d)
                    }
                    sources
                }
                .padding(.horizontal)
            }
            .padding(.bottom, 30)
        }
        .ignoresSafeArea(edges: .top)
        .background(Color.black)
        .toolbarBackground(.hidden, for: .navigationBar)
        .overlay(alignment: .bottom) {
            if let note {
                Text(note).font(.subheadline.weight(.semibold)).padding(.horizontal, 16).padding(.vertical, 10)
                    .background(.white, in: Capsule()).foregroundStyle(.black).padding(.bottom, 20)
                    .task(id: note) { try? await Task.sleep(nanoseconds: 2_000_000_000); self.note = nil }
            }
        }
        .task(id: item.id) { if loadedId != item.id { await load() } }
        .fullScreenCover(item: $playing) { PlayerScreen(request: $0) }
    }

    private var header: some View {
        ZStack(alignment: .bottom) {
            Color.clear.frame(height: 380)
                .overlay(Poster(url: item.pic, px: 200).blur(radius: 30).opacity(0.6)).clipped()
            LinearGradient(colors: [.clear, .black], startPoint: .center, endPoint: .bottom)
            Color.clear.frame(width: 170, height: 255)
                .overlay(Poster(url: item.pic, px: 600))
                .overlay { if !douban.pic.isEmpty { Poster(url: douban.pic, px: 600, placeholder: false) } }
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .shadow(color: .black.opacity(0.7), radius: 20, y: 10)
                .padding(.bottom, 10)
        }
    }

    private var meta: some View {
        let parts = [detail?.year, detail?.area, detail?.lang, item.remarks].compactMap { $0 }.filter { !$0.isEmpty && $0 != "0" }
        return HStack(spacing: 8) {
            if !douban.id.isEmpty, let u = URL(string: "https://movie.douban.com/subject/\(douban.id)/") {
                Link(destination: u) { RateBadge(rate: douban.rate.isEmpty ? "豆瓣 暂无" : "豆瓣 \(douban.rate)") }.buttonStyle(.press)
            }
            Text(item.site.name).font(.caption.weight(.bold)).padding(.horizontal, 6).padding(.vertical, 2)
                .overlay(RoundedRectangle(cornerRadius: 3).stroke(.white.opacity(0.5)))
            if let d = detail, !d.typeId.isEmpty, !d.typeName.isEmpty {
                NavigationLink(value: CatRoute(site: item.site, cat: VodCategory(id: d.typeId, pid: "", name: d.typeName))) {
                    Text("\(d.typeName) ›").font(.caption.weight(.bold)).foregroundStyle(Color(red: 0.56, green: 0.85, blue: 0.88))
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .overlay(RoundedRectangle(cornerRadius: 3).stroke(Color(red: 0.33, green: 0.73, blue: 0.77)))
                }
                .buttonStyle(.press)
            }
            Text(parts.joined(separator: "  •  ")).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
        }
    }

    @ViewBuilder private var actions: some View {
        if let d = detail, lineIdx < d.lines.count, let first = d.lines[lineIdx].episodes.first {
            let eps = d.lines[lineIdx].episodes
            let h = lib.entry(item).flatMap { $0.line == lineIdx && $0.ep < eps.count ? $0 : nil }
            HStack(spacing: 10) {
                Button { play(eps, h?.ep ?? 0, resume: h) } label: {
                    Label(h.map { "继续 \(eps[$0.ep].name)" } ?? (eps.count > 1 ? "播放 \(first.name)" : "播放"), systemImage: "play.fill")
                        .lineLimit(1).frame(maxWidth: .infinity)
                }
                .buttonStyle(.press(.primary))
                let dl = downloadState(eps)
                Button {
                    if eps.count > 1 { dlMode.toggle(); return }
                    let r = dm.record(for: first.url)
                    switch r?.status {
                    case nil: dm.add(item, first); note = "已加入下载"
                    case "done": note = "已下载，播放时自动用本地文件"
                    case "downloading", "queued": dm.pause(r!.id); note = "已暂停"
                    default: dm.resume(r!.id); note = "已继续"
                    }
                } label: {
                    Label(dl.text, systemImage: dl.icon)
                        .font(.headline).monospacedDigit().lineLimit(1)
                        .padding(.vertical, 12).padding(.horizontal, 16)
                        .background {
                            GeometryReader { g in
                                ZStack(alignment: .leading) {
                                    Color.white.opacity(0.18)
                                    Color.green.opacity(0.45).frame(width: g.size.width * dl.progress)
                                }
                            }
                            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                        }
                        .foregroundStyle(.white)
                        .animation(.linear(duration: 0.8), value: dl.progress)
                }
                .buttonStyle(.press)
                if level != "kids" {
                    Button {
                        note = lib.toggleFavorite(item) ? "已收藏" : "已取消收藏"
                    } label: {
                        Image(systemName: lib.isFavorite(item) ? "heart.fill" : "heart")
                            .foregroundStyle(lib.isFavorite(item) ? Color.brand : .white)
                    }
                    .buttonStyle(.press(.secondary))
                }
            }
        } else if detail != nil {
            Text("这个源没有可直接播放的地址，下面换个源").font(.footnote).foregroundStyle(.secondary)
        } else if error == nil {
            ProgressView().frame(maxWidth: .infinity)
        }
    }

    /// What the download button says: its own progress + speed for a film; done/total + speed for a series.
    private func downloadState(_ eps: [Episode]) -> (text: String, icon: String, progress: Double) {
        if dlMode { return ("完成", "checkmark", 0) }
        let mine = dm.records(for: item)
        let active = mine.filter { ["downloading", "queued"].contains($0.status) }
        let speed = DownloadStat.speedText(active.reduce(0) { $0 + dm.stat($1.id).speed })
        if eps.count == 1, let r = dm.record(for: eps[0].url) {
            switch r.status {
            case "done": return ("已下载", "checkmark", 0)
            case "downloading": return ("\(Int(r.progress * 100))%" + (speed.isEmpty ? "" : " · \(speed)"), "pause.fill", max(0.02, r.progress))
            case "queued": return ("排队第 \(dm.queuePosition(r.id)) 位", "hourglass", 0)
            case "paused": return ("继续 \(Int(r.progress * 100))%", "play.fill", r.progress)
            default: return ("重试", "arrow.clockwise", 0)
            }
        }
        let done = mine.filter { $0.status == "done" }.count
        if !active.isEmpty {
            let p = mine.reduce(0.0) { $0 + ($1.status == "done" ? 1 : $1.progress) } / Double(max(1, mine.count))
            return ("\(done)/\(mine.count)" + (speed.isEmpty ? "" : " · \(speed)"), "arrow.down", max(0.02, p))
        }
        return (done > 0 ? "已下 \(done)" : "下载", "arrow.down.to.line", 0)
    }

    private func credit(_ k: String, _ v: String) -> some View {
        (Text(k + "：").foregroundStyle(.secondary) + Text(v)).font(.caption).lineLimit(2)
    }

    @ViewBuilder private func episodes(_ d: VodDetail) -> some View {
        if d.lines.count > 1 {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 16) {
                    ForEach(d.lines.indices, id: \.self) { i in
                        Button(d.lines[i].name) { lineIdx = i }
                            .font(.subheadline.weight(lineIdx == i ? .bold : .regular))
                            .foregroundStyle(lineIdx == i ? .white : .secondary)
                            .padding(.vertical, 4)
                            .overlay(alignment: .top) { if lineIdx == i { Rectangle().fill(Color.brand).frame(height: 3).offset(y: -6) } }
                    }
                }.padding(.top, 6)
            }
        }
        if lineIdx < d.lines.count, d.lines[lineIdx].episodes.count > 1 {
            let eps = d.lines[lineIdx].episodes
            HStack {
                Text("剧集 · \(eps.count)").font(.headline)
                Spacer()
                if dlMode {
                    Text("点选下载，再点暂停/继续").font(.caption).foregroundStyle(.secondary)
                    if dm.records(for: item).contains(where: { ["downloading", "queued"].contains($0.status) }) {
                        Button("全部暂停") { dm.records(for: item).forEach { dm.pause($0.id) } }
                            .buttonStyle(.press(.chip(false)))
                    }
                    Button("全部下载") { eps.forEach { dm.add(item, $0) }; note = "已加入下载：\(eps.count) 集" }
                        .buttonStyle(.press(.chip(true)))
                }
            }.padding(.top, 4)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 72), spacing: 8)], spacing: 8) {
                ForEach(eps.indices, id: \.self) { i in
                    let rec = dm.record(for: eps[i].url)
                    Button {
                        if dlMode {
                            // Tap again to pause / resume that episode.
                            switch rec?.status {
                            case nil: dm.add(item, eps[i])
                            case "downloading", "queued": dm.pause(rec!.id)
                            case "paused", "error": dm.resume(rec!.id)
                            default: break
                            }
                        } else { play(eps, i, resume: lib.entry(item).flatMap { $0.line == lineIdx ? $0 : nil }) }
                    } label: {
                        HStack(spacing: 3) {
                            if let rec {
                                if rec.status == "downloading" {
                                    Text("\(Int(rec.progress * 100))%").font(.system(size: 10, weight: .semibold)).monospacedDigit().foregroundStyle(.green)
                                } else if rec.status == "queued" {
                                    Text("排队").font(.system(size: 10, weight: .semibold)).foregroundStyle(.orange)
                                } else if rec.status == "paused" {
                                    Image(systemName: "pause.fill").font(.system(size: 9)).foregroundStyle(.orange)
                                } else {
                                    Image(systemName: rec.status == "done" ? "checkmark.circle.fill" : "exclamationmark.circle")
                                        .font(.caption2).foregroundStyle(rec.status == "done" ? .green : .orange)
                                }
                            }
                            Text(eps[i].name).font(.caption).lineLimit(1)
                        }
                        .frame(maxWidth: .infinity).padding(.vertical, 10)
                        .background {
                            GeometryReader { g in
                                ZStack(alignment: .leading) {
                                    Color.card
                                    if rec?.status == "downloading" || rec?.status == "paused" {
                                        Color.green.opacity(0.28).frame(width: g.size.width * (rec?.progress ?? 0))
                                    }
                                }
                            }
                        }
                        .clipShape(RoundedRectangle(cornerRadius: 5))
                        .overlay(RoundedRectangle(cornerRadius: 5)
                            .stroke(dlMode ? Color.white.opacity(0.45) : .clear, style: StrokeStyle(lineWidth: 1, dash: [3])))
                    }.buttonStyle(.press)
                }
            }
        }
    }

    @ViewBuilder private var sources: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("其他源").font(.headline).padding(.top, 8)
            if let matches {
                let alternatives = matches.filter { $0.id != item.id }
                if alternatives.isEmpty {
                    Text("其他源没有同名的").font(.footnote).foregroundStyle(.secondary)
                } else {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack {
                            ForEach(alternatives) { alt in
                                Button { item = alt } label: {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(alt.site.name).font(.subheadline.weight(.semibold))
                                        Text(alt.remarks).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                                    }
                                    .padding(.horizontal, 12).padding(.vertical, 8)
                                    .background(Color.card).clipShape(RoundedRectangle(cornerRadius: 6))
                                }.buttonStyle(.press)
                            }
                        }
                    }
                }
            } else {
                HStack(spacing: 6) { ProgressView(); Text("在所有源里搜索中…").font(.footnote).foregroundStyle(.secondary) }
            }
        }
    }

    private func play(_ eps: [Episode], _ i: Int, resume: LibEntry? = nil) {
        let at = resume.map { $0.ep == i && $0.dur - $0.t > 30 ? $0.t : 0 } ?? 0
        playing = PlayRequest(title: item.name, episodes: eps, index: i, item: item, line: lineIdx, startAt: at)
    }

    private func load() async {
        loadedId = item.id
        detail = nil; error = nil; lineIdx = 0; dlMode = false; douban = DoubanRating()
        let current = item
        Task { douban = await API.doubanRating(name: current.name, year: current.year) }
        do {
            let d = try await API.detail(item)
            if let h = lib.entry(item), h.line < d.lines.count { lineIdx = h.line }
            detail = d
        } catch { self.error = "详情加载失败：\(error.localizedDescription)" }
        if matches == nil {
            let (found, _) = await API.searchAll(current.name, sites: Safety.visible(Config.shared.sites))
            matches = found.filter { $0.name == current.name }
        }
    }
}

/// 豆瓣热门 → find the same title across all sources.
struct DoubanResolveView: View {
    let item: DoubanItem
    @State private var hit: VodItem?
    @State private var results: [VodItem]?

    var body: some View {
        Group {
            if let hit {
                VodDetailView(item: hit)
            } else if let results {
                if results.isEmpty {
                    ContentUnavailableView("所有源都没有「\(item.name)」", systemImage: "film")
                } else {
                    ScrollView {
                        LazyVGrid(columns: gridColumns, spacing: 16) {
                            ForEach(results) { r in
                                NavigationLink(value: r) { PosterCell(item: r, showSite: true) }.buttonStyle(.press)
                            }
                        }.padding()
                    }
                    .navigationTitle(item.name)
                }
            } else {
                ProgressView("在所有源里找「\(item.name)」…")
            }
        }
        .background(Color.black)
        .task {
            guard hit == nil, results == nil else { return }
            let (r, _) = await API.searchAll(item.name, sites: Safety.visible(Config.shared.sites))
            if let exact = r.first(where: { $0.name == item.name }) { hit = exact } else { results = r }
        }
    }
}

// MARK: - Search (all sources)

struct SearchView: View {
    @ObservedObject private var cfg = Config.shared
    @AppStorage("safety.level") private var level = "standard"
    @State private var query = ""
    @State private var searched = ""
    @State private var results: [VodItem] = []
    @State private var people: [API.PersonHit] = []
    @State private var tab = 0
    @State private var status = ""
    @State private var searching = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if !searched.isEmpty && !searching {
                    Picker("", selection: $tab) {
                        Text("影片 \(results.count)").tag(0)
                        Text("演员 / 导演 \(people.count)").tag(1)
                    }
                    .pickerStyle(.segmented).padding(.horizontal)
                }
                if !status.isEmpty { Text(status).font(.caption).foregroundStyle(.secondary).padding(.horizontal) }
                if tab == 0 {
                    // Every title that matched — by name, or because the site's search also matched its credits.
                    LazyVGrid(columns: gridColumns, spacing: 16) {
                        ForEach(results) { item in
                            NavigationLink(value: item) { PosterCell(item: item, showSite: true) }.buttonStyle(.press)
                        }
                    }.padding(.horizontal)
                    if !searching, !searched.isEmpty, results.isEmpty {
                        Text("没有影片匹配，换个关键词").foregroundStyle(.secondary).frame(maxWidth: .infinity).padding(30)
                    }
                } else {
                    ChipFlow(spacing: 10) {
                        ForEach(people) { p in
                            NavigationLink(value: PersonRoute(name: p.name, role: p.role)) {
                                HStack(alignment: .firstTextBaseline, spacing: 6) {
                                    Text(p.name).font(.subheadline.weight(.semibold))
                                    Text("\(p.role == "director" ? "导演" : "演员") · \(p.items.count) 部").font(.caption2).opacity(0.6)
                                }
                            }
                            .buttonStyle(.press(.chip(false)))
                        }
                    }
                    .padding(.horizontal)
                    if people.isEmpty {
                        Text("没有演员或导演的名字包含「\(searched)」").foregroundStyle(.secondary).frame(maxWidth: .infinity).padding(30)
                    }
                }
                if searching { ProgressView("正在搜索全部 \(Safety.visible(cfg.sites).count) 个源…").frame(maxWidth: .infinity).padding() }
            }
        }
        .background(Color.black)
        .navigationTitle("搜索")
        .appDestinations()
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "片名 / 演员 / 导演")
        .onSubmit(of: .search) { Task { await run() } }
    }

    private func run() async {
        let wd = query.trimmingCharacters(in: .whitespaces)
        guard !wd.isEmpty else { return }
        let sites = Safety.visible(cfg.sites)
        results = []; people = []; searching = true; status = ""; searched = wd; tab = 0
        let r = await API.searchWithCredits(wd, sites: sites)
        let rank: (VodItem) -> Int = { $0.name == wd ? 0 : $0.name.contains(wd) ? 1 : 2 }
        results = r.items.enumerated().sorted { (rank($0.element), $0.offset) < (rank($1.element), $1.offset) }.map(\.element)
        people = r.people
        searching = false
        status = r.failed.isEmpty ? "" : "\(r.failed.joined(separator: "/")) 未响应"
    }
}

/// Source picker: each row pings itself when it scrolls into view, so only what you can see is tested.
struct SitePicker: View {
    let sites: [Site]
    let current: String?
    let pick: (String) -> Void
    @ObservedObject private var health = SiteHealth.shared
    @State private var onScreen = Set<String>()

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("点播源 · \(sites.count)").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("重测") { health.retest(sites.filter { onScreen.contains($0.key) }) }.font(.caption.weight(.semibold))
            }
            .padding(.horizontal, 14).padding(.vertical, 8)
            Divider()
            list
        }
        .frame(minWidth: 260, idealWidth: 300, maxHeight: 420)
    }

    private var list: some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                ForEach(sites) { s in
                    Button { pick(s.key) } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "checkmark").font(.caption.weight(.bold)).opacity(s.key == current ? 1 : 0).frame(width: 14)
                            Text(s.name).font(.subheadline).lineLimit(1)
                            if s.kids == true { Tag(text: "少儿", color: .green) }
                            Spacer(minLength: 12)
                            if let m = s.members {
                                Text("聚合 \(m.count)").font(.caption).foregroundStyle(Color.secondary)
                            } else if !s.api.isEmpty {
                                Text(health.isBusy(s) ? "测速中…" : health.label(s) ?? "…").font(.caption.monospacedDigit())
                                    .foregroundStyle(health.isDead(s) ? Color.orange : health.label(s) == nil ? Color.secondary : Color.green)
                            }
                        }
                        .opacity(health.isDead(s) ? 0.5 : 1)
                        .padding(.horizontal, 14).padding(.vertical, 11)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .onAppear { onScreen.insert(s.key); health.request(s) }
                    .onDisappear { onScreen.remove(s.key) }
                    Divider()
                }
            }
        }
    }
}
