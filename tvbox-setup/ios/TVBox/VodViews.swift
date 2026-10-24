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
    @State private var rate = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Color.clear
                .aspectRatio(2 / 3, contentMode: .fit)
                .overlay(Poster(url: item.pic))
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
        .task(id: item.id) { if rate.isEmpty { rate = await API.doubanRating(name: item.name, year: item.year).rate } }
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
    @AppStorage("safety.level") private var level = "standard"
    @AppStorage("siteKey") private var siteKey = ""
    @State private var cats: [VodCategory] = []
    @State private var latest: [VodItem] = []
    @State private var rows: [Row] = []
    @State private var tvHot: [DoubanItem] = []
    @State private var movieHot: [DoubanItem] = []
    @State private var error: String?
    @State private var loading = false
    @State private var loadedKey = ""

    private var sites: [Site] { Safety.visible(cfg.sites) }
    private var site: Site? { sites.first { $0.key == siteKey } ?? sites.first }
    // Reload only when what we show actually changes — not every time the view reappears (back-swipe).
    private var loadKey: String { "\(site?.key ?? "")|\(site?.api ?? "")|\(level)" }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                if !latest.isEmpty { Hero(items: Array(latest.prefix(6))) } else { Color.clear.frame(height: 100) }
                if let error {
                    Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.orange).padding(.horizontal)
                }
                if loading && latest.isEmpty { ProgressView().frame(maxWidth: .infinity, minHeight: 300) }
                if latest.count > 6 {
                    vodRow(level == "kids" ? "少儿精选" : "最新更新", Array(latest.dropFirst(6)), VodCategory(id: "", pid: "", name: level == "kids" ? "少儿精选" : "最新更新"))
                }
                if !tvHot.isEmpty { doubanRow("豆瓣热门剧集", tvHot) }
                if !movieHot.isEmpty { doubanRow("豆瓣热门电影", movieHot) }
                ForEach(rows) { vodRow($0.cat.name, $0.items, $0.cat) }
                if !cats.isEmpty { allCategories }
            }
            .padding(.bottom, 30)
        }
        .ignoresSafeArea(edges: .top)
        .background(Color.black)
        .navigationDestination(for: VodItem.self) { VodDetailView(item: $0) }
        .navigationDestination(for: DoubanItem.self) { DoubanResolveView(item: $0) }
        .navigationDestination(for: VodCategory.self) { c in if let site { CategoryGridView(site: site, cat: c) } }
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
                Menu {
                    ForEach(sites) { s in
                        Button { siteKey = s.key } label: {
                            if s.key == site?.key { Label(s.name, systemImage: "checkmark") } else { Text(s.name) }
                        }
                    }
                } label: {
                    HStack(spacing: 4) {
                        Text(site?.name ?? "无源").font(.subheadline.weight(.semibold))
                        Image(systemName: "chevron.down").font(.caption2.weight(.bold))
                    }
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    .background(.ultraThinMaterial, in: Capsule())
                    .foregroundStyle(.white)
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

    private func vodRow(_ title: String, _ items: [VodItem], _ cat: VodCategory) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            NavigationLink(value: cat) { header(title) }.padding(.horizontal)
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 8) {
                    ForEach(items) { item in
                        NavigationLink(value: item) { PosterCell(item: item, width: 112) }.buttonStyle(.plain)
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
                        NavigationLink(value: item) { DoubanCell(item: item) }.buttonStyle(.plain)
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
                    NavigationLink(value: c) {
                        Text(c.name).font(.subheadline).lineLimit(1)
                            .frame(maxWidth: .infinity).padding(.vertical, 9)
                            .background(Color.card).foregroundStyle(.white)
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                }
            }.padding(.horizontal)
        }
    }

    private func load() async {
        loadedKey = loadKey
        latest = []; rows = []; cats = []; tvHot = []; movieHot = []; error = nil
        guard let site else {
            error = level == "kids" ? "儿童模式下没有少儿源，去「设置」添加或标记" : "还没有点播源，去「设置」添加"
            return
        }
        loading = true
        defer { loading = false }
        if level != "kids" {
            Task {
                async let tv = API.doubanHot("tv")
                async let mv = API.doubanHot("movie")
                (tvHot, movieHot) = await (tv, mv)
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
                rates[it.id] = await API.doubanRating(name: it.name, year: it.year).rate
            }
        }
    }

    private func slide(_ item: VodItem) -> some View {
        ZStack(alignment: .bottom) {
            Color.clear.overlay(Poster(url: item.pic, px: 1000)).clipped()
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
                    Label("播放", systemImage: "play.fill").font(.headline)
                        .padding(.horizontal, 34).padding(.vertical, 10)
                        .background(.white, in: RoundedRectangle(cornerRadius: 5)).foregroundStyle(.black)
                }
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
                    NavigationLink(value: item) { PosterCell(item: item) }.buttonStyle(.plain)
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
                        if !d.actor.isEmpty { credit("主演", d.actor) }
                        if !d.director.isEmpty { credit("导演", d.director) }
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
                .overlay(Poster(url: item.pic, px: 600)).clipShape(RoundedRectangle(cornerRadius: 8))
                .shadow(color: .black.opacity(0.7), radius: 20, y: 10)
                .padding(.bottom, 10)
        }
    }

    private var meta: some View {
        let parts = [detail?.year, detail?.area, item.typeName, item.remarks].compactMap { $0 }.filter { !$0.isEmpty && $0 != "0" }
        return HStack(spacing: 8) {
            if !douban.id.isEmpty, let u = URL(string: "https://movie.douban.com/subject/\(douban.id)/") {
                Link(destination: u) { RateBadge(rate: douban.rate.isEmpty ? "豆瓣 暂无" : "豆瓣 \(douban.rate)") }
            }
            Text(item.site.name).font(.caption.weight(.bold)).padding(.horizontal, 6).padding(.vertical, 2)
                .overlay(RoundedRectangle(cornerRadius: 3).stroke(.white.opacity(0.5)))
            Text(parts.joined(separator: "  •  ")).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
        }
    }

    @ViewBuilder private var actions: some View {
        if let d = detail, lineIdx < d.lines.count, let first = d.lines[lineIdx].episodes.first {
            let eps = d.lines[lineIdx].episodes
            HStack(spacing: 10) {
                Button { play(eps, 0) } label: {
                    Label(eps.count > 1 ? "播放 \(first.name)" : "播放", systemImage: "play.fill")
                        .font(.headline).frame(maxWidth: .infinity).padding(.vertical, 12)
                        .background(.white, in: RoundedRectangle(cornerRadius: 5)).foregroundStyle(.black)
                }
                Button {
                    if eps.count == 1 { dm.add(item, first); note = "已加入下载" } else { dlMode.toggle() }
                } label: {
                    Label(dlMode ? "完成" : (dm.record(for: first.url)?.status == "done" && eps.count == 1 ? "已下载" : "下载"),
                          systemImage: dlMode ? "checkmark" : "arrow.down.to.line")
                        .font(.headline).padding(.vertical, 12).padding(.horizontal, 16)
                        .background(Color.white.opacity(0.18), in: RoundedRectangle(cornerRadius: 5)).foregroundStyle(.white)
                }
            }
        } else if detail != nil {
            Text("这个源没有可直接播放的地址，下面换个源").font(.footnote).foregroundStyle(.secondary)
        } else if error == nil {
            ProgressView().frame(maxWidth: .infinity)
        }
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
                    Text("点选要下载的集").font(.caption).foregroundStyle(.secondary)
                    Button("全部下载") { eps.forEach { dm.add(item, $0) }; note = "已加入下载：\(eps.count) 集" }
                        .font(.caption.weight(.semibold)).buttonStyle(.bordered)
                }
            }.padding(.top, 4)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 72), spacing: 8)], spacing: 8) {
                ForEach(eps.indices, id: \.self) { i in
                    let rec = dm.record(for: eps[i].url)
                    Button {
                        if dlMode { dm.add(item, eps[i]) } else { play(eps, i) }
                    } label: {
                        HStack(spacing: 3) {
                            if let rec {
                                Image(systemName: rec.status == "done" ? "checkmark.circle.fill" : rec.status == "error" ? "exclamationmark.circle" : "arrow.down.circle")
                                    .font(.caption2).foregroundStyle(rec.status == "done" ? .green : .orange)
                            }
                            Text(eps[i].name).font(.caption).lineLimit(1)
                        }
                        .frame(maxWidth: .infinity).padding(.vertical, 10)
                        .background(Color.card).clipShape(RoundedRectangle(cornerRadius: 5))
                        .overlay(RoundedRectangle(cornerRadius: 5)
                            .stroke(dlMode ? Color.white.opacity(0.45) : .clear, style: StrokeStyle(lineWidth: 1, dash: [3])))
                    }.buttonStyle(.plain)
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
                                }.buttonStyle(.plain)
                            }
                        }
                    }
                }
            } else {
                HStack(spacing: 6) { ProgressView(); Text("在所有源里搜索中…").font(.footnote).foregroundStyle(.secondary) }
            }
        }
    }

    private func play(_ eps: [Episode], _ i: Int) {
        playing = PlayRequest(title: item.name, episodes: eps, index: i)
    }

    private func load() async {
        loadedId = item.id
        detail = nil; error = nil; lineIdx = 0; dlMode = false; douban = DoubanRating()
        let current = item
        Task { douban = await API.doubanRating(name: current.name, year: current.year) }
        do { detail = try await API.detail(item) } catch { self.error = "详情加载失败：\(error.localizedDescription)" }
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
                                NavigationLink(value: r) { PosterCell(item: r, showSite: true) }.buttonStyle(.plain)
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
    @State private var results: [VodItem] = []
    @State private var status = ""
    @State private var searching = false

    var body: some View {
        ScrollView {
            if !status.isEmpty {
                Text(status).font(.caption).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal)
            }
            LazyVGrid(columns: gridColumns, spacing: 16) {
                ForEach(results) { item in
                    NavigationLink(value: item) { PosterCell(item: item, showSite: true) }.buttonStyle(.plain)
                }
            }.padding(.horizontal)
            if searching { ProgressView("正在搜索全部 \(Safety.visible(cfg.sites).count) 个源…").padding() }
        }
        .background(Color.black)
        .navigationTitle("搜索")
        .navigationDestination(for: VodItem.self) { VodDetailView(item: $0) }
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "片名，所有源一起搜")
        .onSubmit(of: .search) { Task { await run() } }
    }

    private func run() async {
        let wd = query.trimmingCharacters(in: .whitespaces)
        guard !wd.isEmpty else { return }
        let sites = Safety.visible(cfg.sites)
        results = []; searching = true; status = ""
        let (found, failed) = await API.searchAll(wd, sites: sites)
        results = found
        searching = false
        status = "\(sites.count) 个源，共 \(found.count) 条" + (failed.isEmpty ? "" : "；\(failed.joined(separator: "/")) 未响应")
    }
}
