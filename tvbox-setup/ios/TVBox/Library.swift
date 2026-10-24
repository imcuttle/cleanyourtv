import SwiftUI

/// Watch history + favorites, stored on the device. Progress is written while playing but only published
/// when the player closes, so the home screen doesn't re-render every few seconds during playback.
struct LibEntry: Codable, Hashable, Identifiable {
    var siteKey: String
    var siteName: String
    var vodId: String
    var name: String
    var pic: String
    var remarks: String
    var year: String
    var typeName: String
    var line = 0
    var ep = 0
    var epName = ""
    var t: Double = 0
    var dur: Double = 0
    var at = Date()
    var id: String { siteKey + "/" + vodId }

    init(_ item: VodItem) {
        siteKey = item.site.key; siteName = item.site.name; vodId = item.vodId; name = item.name
        pic = item.pic; remarks = item.remarks; year = item.year; typeName = item.typeName
    }

    /// Back to a playable item, as long as the source is still configured.
    var item: VodItem? {
        guard let site = Config.shared.sites.first(where: { $0.key == siteKey }) else { return nil }
        return VodItem(site: site, vodId: vodId, name: name, pic: pic, remarks: remarks, typeName: typeName, year: year)
    }

    var progress: Double { dur > 0 ? min(1, t / dur) : 0 }
}

final class Library: ObservableObject {
    static let shared = Library()
    @Published private(set) var history: [LibEntry]
    @Published private(set) var favorites: [LibEntry]
    @Published private(set) var liveFavorites: [LiveFav]
    private var pending: [LibEntry]?

    private init() {
        let d = UserDefaults.standard
        history = (d.data(forKey: "lib.history")).flatMap { try? JSONDecoder().decode([LibEntry].self, from: $0) } ?? []
        favorites = (d.data(forKey: "lib.favs")).flatMap { try? JSONDecoder().decode([LibEntry].self, from: $0) } ?? []
        liveFavorites = (d.data(forKey: "lib.liveFavs")).flatMap { try? JSONDecoder().decode([LiveFav].self, from: $0) } ?? []
    }

    private func save() {
        UserDefaults.standard.set(try? JSONEncoder().encode(pending ?? history), forKey: "lib.history")
        UserDefaults.standard.set(try? JSONEncoder().encode(favorites), forKey: "lib.favs")
    }

    func entry(_ item: VodItem) -> LibEntry? { (pending ?? history).first { $0.id == item.id } }

    /// Called by the player every few seconds — persisted, not published.
    func record(_ item: VodItem, line: Int, ep: Int, epName: String, t: Double, dur: Double) {
        var list = pending ?? history
        var e = list.first { $0.id == item.id } ?? LibEntry(item)
        list.removeAll { $0.id == item.id }
        e.line = line; e.ep = ep; e.epName = epName; e.t = t; e.dur = dur; e.at = Date()
        list.insert(e, at: 0)
        pending = Array(list.prefix(60))
        save()
    }

    /// Player closed: show the new progress.
    func commit() {
        guard let p = pending else { return }
        pending = nil
        history = p
    }

    func deleteHistory(_ id: String) {
        history = (pending ?? history).filter { $0.id != id }
        pending = nil
        save()
    }

    func clearHistory() { pending = nil; history = []; save() }

    func isFavorite(_ item: VodItem) -> Bool { favorites.contains { $0.id == item.id } }

    @discardableResult
    func toggleFavorite(_ item: VodItem) -> Bool {
        if isFavorite(item) { favorites.removeAll { $0.id == item.id }; save(); return false }
        favorites.insert(LibEntry(item), at: 0)
        save()
        return true
    }

    func deleteFavorite(_ id: String) { favorites.removeAll { $0.id == id }; save() }

    fileprivate func setLive(_ l: [LiveFav]) {
        liveFavorites = l
        UserDefaults.standard.set(try? JSONEncoder().encode(l), forKey: "lib.liveFavs")
    }
    func clearFavorites() { favorites = []; save() }
}

// MARK: - Routes shared by every navigation stack

struct CatRoute: Hashable { let site: Site; let cat: VodCategory }
struct PersonRoute: Hashable { let name: String; let role: String }  // role: actor / director

extension View {
    func appDestinations() -> some View {
        self
            .navigationDestination(for: VodItem.self) { VodDetailView(item: $0) }
            .navigationDestination(for: DoubanItem.self) { DoubanResolveView(item: $0) }
            .navigationDestination(for: CatRoute.self) { CategoryGridView(site: $0.site, cat: $0.cat) }
            .navigationDestination(for: PersonRoute.self) { PersonView(route: $0) }
    }
}

// MARK: - 我的: history, favorites, downloads

struct MineView: View {
    @Binding var clip: ClipPayload?
    @ObservedObject private var lib = Library.shared
    @ObservedObject private var dm = DownloadManager.shared
    @AppStorage("safety.level") private var level = "standard"

    var body: some View {
        List {
            NavigationLink { HistoryView() } label: {
                Label { HStack { Text("观看历史"); Spacer(); Text("\(lib.history.count)").foregroundStyle(.secondary) } }
                    icon: { Image(systemName: "clock.arrow.circlepath") }
            }
            if level != "kids" {
                NavigationLink { FavoritesView() } label: {
                    Label { HStack { Text("我的收藏"); Spacer(); Text("\(lib.favorites.count)").foregroundStyle(.secondary) } }
                        icon: { Image(systemName: "heart") }
                }
            }
            if level != "kids" {
                NavigationLink { LiveFavoritesView() } label: {
                    Label { HStack { Text("直播收藏"); Spacer(); Text("\(lib.liveFavorites.count)").foregroundStyle(.secondary) } }
                        icon: { Image(systemName: "star") }
                }
            }
            NavigationLink { DownloadsView() } label: {
                Label { HStack { Text("下载"); Spacer(); Text("\(dm.records.count)").foregroundStyle(.secondary) } }
                    icon: { Image(systemName: "arrow.down.circle") }
            }
            Section {
                NavigationLink { SettingsView(clip: $clip) } label: {
                    Label { HStack { Text("设置"); Spacer(); Text("源 · 安全级别").foregroundStyle(.secondary) } }
                        icon: { Image(systemName: "gearshape") }
                }
            }
        }
        .navigationTitle("我的")
        .appDestinations()
    }
}

struct LibraryRow: View {
    let e: LibEntry
    var showProgress = false
    var body: some View {
        HStack(spacing: 12) {
            Color.clear.frame(width: 52, height: 78).overlay(Poster(url: e.pic, px: 160)).clipShape(RoundedRectangle(cornerRadius: 4))
            VStack(alignment: .leading, spacing: 4) {
                Text(e.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                Text([e.siteName, showProgress ? e.epName : e.typeName].filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                if showProgress, e.dur > 0 {
                    ProgressView(value: e.progress).tint(.brand)
                    Text(e.at, style: .relative).font(.caption2).foregroundStyle(.tertiary) + Text("前").font(.caption2).foregroundStyle(.tertiary)
                }
            }
        }
    }
}

struct HistoryView: View {
    @ObservedObject private var lib = Library.shared
    @State private var confirmClear = false

    var body: some View {
        List {
            if lib.history.isEmpty { Text("还没有观看记录").foregroundStyle(.secondary) }
            ForEach(lib.history) { e in
                if let item = e.item {
                    NavigationLink(value: item) { LibraryRow(e: e, showProgress: true) }
                } else {
                    LibraryRow(e: e, showProgress: true).opacity(0.5)
                }
            }
            .onDelete { idx in idx.map { lib.history[$0].id }.forEach(lib.deleteHistory) }
        }
        .navigationTitle("观看历史")
        .toolbar {
            if !lib.history.isEmpty { Button("清空", role: .destructive) { confirmClear = true } }
        }
        .confirmationDialog("清空全部观看历史？", isPresented: $confirmClear, titleVisibility: .visible) {
            Button("清空", role: .destructive) { lib.clearHistory() }
        }
    }
}

struct FavoritesView: View {
    @ObservedObject private var lib = Library.shared
    @AppStorage("safety.level") private var level = "standard"
    @State private var confirmClear = false

    var body: some View {
        List {
            if level == "kids" {
                Text("儿童模式下收藏不可见").foregroundStyle(.secondary)
            } else {
                if lib.favorites.isEmpty { Text("还没有收藏。打开影片，点 ♡ 收藏。").foregroundStyle(.secondary) }
                ForEach(lib.favorites) { e in
                    if let item = e.item {
                        NavigationLink(value: item) { LibraryRow(e: e) }
                    } else {
                        LibraryRow(e: e).opacity(0.5)
                    }
                }
                .onDelete { idx in idx.map { lib.favorites[$0].id }.forEach(lib.deleteFavorite) }
            }
        }
        .navigationTitle("我的收藏")
        .toolbar {
            if level != "kids", !lib.favorites.isEmpty { Button("清空", role: .destructive) { confirmClear = true } }
        }
        .confirmationDialog("清空全部收藏？", isPresented: $confirmClear, titleVisibility: .visible) {
            Button("清空", role: .destructive) { lib.clearFavorites() }
        }
    }
}

struct LiveFavoritesView: View {
    @ObservedObject private var lib = Library.shared
    @State private var playing: PlayRequest?
    @State private var confirmClear = false

    var body: some View {
        List {
            if lib.liveFavorites.isEmpty { Text("还没有收藏频道。在直播里长按频道 → 收藏。").foregroundStyle(.secondary) }
            ForEach(Array(lib.liveFavorites.enumerated()), id: \.element.id) { i, f in
                Button {
                    playing = PlayRequest(title: f.name, episodes: lib.liveFavorites.map { Episode(name: $0.name, url: $0.url) }, index: i)
                } label: {
                    HStack(spacing: 12) {
                        LiveCover(channel: f.channel).frame(width: 96)
                        Text(f.name).foregroundStyle(.white)
                    }
                }
            }
            .onDelete { idx in idx.map { lib.liveFavorites[$0].url }.forEach(lib.deleteLive) }
        }
        .navigationTitle("直播收藏")
        .toolbar { if !lib.liveFavorites.isEmpty { Button("清空", role: .destructive) { confirmClear = true } } }
        .confirmationDialog("清空全部直播收藏？", isPresented: $confirmClear, titleVisibility: .visible) {
            Button("清空", role: .destructive) { lib.clearLiveFavorites() }
        }
        .fullScreenCover(item: $playing) { PlayerScreen(request: $0) }
    }
}

// MARK: - People

struct PersonView: View {
    let route: PersonRoute
    @ObservedObject private var cfg = Config.shared
    @State private var items: [VodItem]?

    var body: some View {
        ScrollView {
            if let items {
                if items.isEmpty {
                    Text("各源都没搜到。部分源的搜索只按片名匹配，不认演员。")
                        .font(.footnote).foregroundStyle(.secondary).padding()
                } else {
                    Text("\(items.count) 部作品，按年份排序").font(.caption).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal)
                    LazyVGrid(columns: gridColumns, spacing: 16) {
                        ForEach(items) { it in
                            NavigationLink(value: it) { PosterCell(item: it, showSite: true) }.buttonStyle(.press)
                        }
                    }.padding(.horizontal)
                }
            } else {
                ProgressView("在 \(Safety.visible(cfg.sites).count) 个源里找作品…").padding(40)
            }
        }
        .background(Color.black)
        .navigationTitle("\(route.name) · \(route.role == "director" ? "导演" : "演员")")
        .navigationBarTitleDisplayMode(.inline)
        .task { if items == nil { items = await API.person(route.name, role: route.role, sites: Safety.visible(cfg.sites)) } }
    }
}

/// Wrapping row of tappable chips (导演 / 演员 / 分类).
struct ChipFlow: Layout {
    var spacing: CGFloat = 6
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let w = proposal.width ?? 320
        var x: CGFloat = 0, y: CGFloat = 0, row: CGFloat = 0
        for s in subviews {
            let sz = s.sizeThatFits(.unspecified)
            if x + sz.width > w, x > 0 { x = 0; y += row + spacing; row = 0 }
            x += sz.width + spacing; row = max(row, sz.height)
        }
        return CGSize(width: w, height: y + row)
    }
    func placeSubviews(in b: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = b.minX, y = b.minY, row: CGFloat = 0
        for s in subviews {
            let sz = s.sizeThatFits(.unspecified)
            if x + sz.width > b.maxX, x > b.minX { x = b.minX; y += row + spacing; row = 0 }
            s.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(sz))
            x += sz.width + spacing; row = max(row, sz.height)
        }
    }
}

struct PeopleRow: View {
    let label: String
    let role: String
    let names: [String]
    var max = 99
    @State private var all = false

    var body: some View {
        if !names.isEmpty {
            HStack(alignment: .top, spacing: 8) {
                Text(label).font(.caption).foregroundStyle(.secondary).frame(width: 30, alignment: .leading).padding(.top, 5)
                ChipFlow {
                    ForEach(Array((all ? names : Array(names.prefix(max))).enumerated()), id: \.offset) { _, n in
                        NavigationLink(value: PersonRoute(name: n, role: role)) { Text(n).font(.caption) }
                            .buttonStyle(.press(.chip(false)))
                    }
                    if !all, names.count > max {
                        Button { all = true } label: {
                            Text("+\(names.count - max)").font(.caption).foregroundStyle(.secondary)
                        }
                        .buttonStyle(.press(.chip(false)))
                    }
                }
            }
        }
    }
}

// MARK: - Live favorites

struct LiveFav: Codable, Hashable, Identifiable {
    var name: String
    var url: String
    var logo: String
    var id: String { url }
    var channel: LiveChannel { LiveChannel(name: name, url: url, logo: logo) }
}

extension Library {
    func isLiveFavorite(_ url: String) -> Bool { liveFavorites.contains { $0.url == url } }

    @discardableResult
    func toggleLive(_ ch: LiveChannel) -> Bool {
        let on = !isLiveFavorite(ch.url)
        setLive(on ? [LiveFav(name: ch.name, url: ch.url, logo: ch.logo)] + liveFavorites : liveFavorites.filter { $0.url != ch.url })
        return on
    }

    func deleteLive(_ url: String) { setLive(liveFavorites.filter { $0.url != url }) }
    func clearLiveFavorites() { setLive([]) }
}
