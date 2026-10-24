import SwiftUI
import AVKit
import MediaPlayer

struct PlayRequest: Identifiable {
    let id = UUID()
    let title: String
    let episodes: [Episode]
    var index: Int
    var item: VodItem? = nil   // 点播: progress goes into 观看历史
    var line = 0
    var startAt: Double = 0
}

struct LiveView: View {
    @ObservedObject private var cfg = Config.shared
    @ObservedObject private var lib = Library.shared
    private static let favGroup = "★ 收藏"
    @AppStorage("safety.level") private var level = "standard"
    @AppStorage("liveSource") private var sourceId = ""
    @State private var groups: [LiveGroup] = []
    @State private var groupName = ""
    @State private var filter = ""
    @State private var playing: PlayRequest?
    @State private var loading = false
    @State private var loadedKey = ""

    private var source: LiveSource? { cfg.lives.first { $0.id == sourceId } ?? cfg.lives.first }
    private var loadKey: String { "\(source?.id ?? "")|\(source?.url ?? "")|\(source?.text?.hashValue ?? 0)" }

    var body: some View {
        Group {
            if level == "kids" {
                ContentUnavailableView("儿童模式下直播已关闭", systemImage: "lock")
            } else if cfg.lives.isEmpty {
                ContentUnavailableView("没有直播源", systemImage: "antenna.radiowaves.left.and.right", description: Text("去「设置」添加"))
            } else {
                content
            }
        }
        .background(Color.black)
        .navigationTitle(source?.name ?? "直播")
        .fullScreenCover(item: $playing) { PlayerScreen(request: $0) }
    }

    private var content: some View {
        VStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    let favCount = lib.liveFavorites.count
                    if favCount > 0 {
                        Button("\(Self.favGroup) \(favCount)") { groupName = Self.favGroup }
                            .buttonStyle(.press(.chip(groupName == Self.favGroup)))
                    }
                    ForEach(groups) { g in
                        Button("\(g.name) \(g.channels.count)") { groupName = g.name }
                            .buttonStyle(.press(.chip(g.name == groupName)))
                    }
                }.padding(.horizontal).padding(.vertical, 8)
            }
            ScrollView {
                if loading { ProgressView().padding(40) }
                if !loading && groups.isEmpty { Text("这个源没解析出频道，去「设置」里测速看看").foregroundStyle(.secondary).padding(40) }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 160), spacing: 10)], spacing: 14) {
                    ForEach(channels) { ch in
                        Button { play(ch) } label: {
                            VStack(alignment: .leading, spacing: 5) {
                                LiveCover(channel: ch)
                                    .overlay(alignment: .topLeading) {
                                        if lib.isLiveFavorite(ch.url) {
                                            Image(systemName: "star.fill").font(.caption2).foregroundStyle(.yellow).padding(6).shadow(radius: 2)
                                        }
                                    }
                                Text(ch.name).font(.caption.weight(.medium)).lineLimit(1).foregroundStyle(.white)
                            }
                        }
                        .buttonStyle(.press)
                        // Long-press = the phone's hover: a muted live preview.
                        .contextMenu {
                            Button { play(ch) } label: { Label("播放", systemImage: "play.fill") }
                            Button { Toast.show(lib.toggleLive(ch) ? "已收藏 \(ch.name)" : "已取消收藏") } label: {
                                lib.isLiveFavorite(ch.url) ? Label("取消收藏", systemImage: "star.slash") : Label("收藏", systemImage: "star")
                            }
                        } preview: {
                            LivePreview(url: ch.url).frame(width: 340, height: 191)
                        }
                    }
                }.padding(.horizontal)
            }
        }
        .searchable(text: $filter, prompt: "搜频道")
        .toolbar {
            Menu {
                ForEach(cfg.lives) { s in
                    Button { sourceId = s.id } label: {
                        if s.id == source?.id { Label(s.name, systemImage: "checkmark") } else { Text(s.name) }
                    }
                }
            } label: { Image(systemName: "antenna.radiowaves.left.and.right") }
        }
        .task(id: loadKey) {
            guard loadedKey != loadKey, let src = source else { return }
            loadedKey = loadKey
            loading = true
            groups = await API.loadLive(src)
            loading = false
            if groupName != Self.favGroup, !groups.contains(where: { $0.name == groupName }) {
                groupName = lib.liveFavorites.isEmpty ? (groups.first?.name ?? "") : Self.favGroup
            }
        }
    }

    private var channels: [LiveChannel] {
        let q = filter.trimmingCharacters(in: .whitespaces)
        if !q.isEmpty { return groups.flatMap(\.channels).filter { $0.name.localizedCaseInsensitiveContains(q) } }
        if groupName == Self.favGroup { return lib.liveFavorites.map(\.channel) }
        return groups.first { $0.name == groupName }?.channels ?? []
    }

    private func play(_ ch: LiveChannel) {
        let list = channels
        playing = PlayRequest(title: ch.name, episodes: list.map { Episode(name: $0.name, url: $0.url) },
                              index: list.firstIndex(of: ch) ?? 0)
    }
}
