import SwiftUI
import AVKit

struct PlayRequest: Identifiable {
    let id = UUID()
    let title: String
    let episodes: [Episode]
    var index: Int
}

/// Full-screen AVPlayerViewController (PiP + AirPlay for free). Auto-advances; plays the downloaded
/// copy when there is one.
struct PlayerScreen: View {
    @Environment(\.dismiss) private var dismiss
    @State var request: PlayRequest

    var body: some View {
        let ep = request.episodes[request.index]
        let local = DownloadManager.shared.localURL(for: ep.url)
        ZStack(alignment: .topLeading) {
            Color.black.ignoresSafeArea()
            if let url = local ?? API.url(ep.url) {
                AVPlayerView(url: url) {
                    if request.index + 1 < request.episodes.count { request.index += 1 }
                }
                .id(request.index)
                .ignoresSafeArea()
            } else {
                Text("地址无效").foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            HStack {
                Button { dismiss() } label: {
                    Image(systemName: "xmark").font(.headline).padding(10).background(.ultraThinMaterial, in: Circle())
                }
                Text(request.episodes.count > 1 ? "\(request.title) · \(ep.name)" : request.title)
                    .font(.subheadline).foregroundStyle(.white).lineLimit(1)
                if local != nil { Tag(text: "本地", color: .green) }
                Spacer()
                if request.index + 1 < request.episodes.count {
                    Button("下一集") { request.index += 1 }
                        .font(.subheadline).padding(.horizontal, 12).padding(.vertical, 8)
                        .background(.ultraThinMaterial, in: Capsule())
                }
            }
            .padding(.horizontal).padding(.top, 4)
        }
        .statusBarHidden()
    }
}

struct AVPlayerView: UIViewControllerRepresentable {
    let url: URL
    var onEnd: () -> Void = {}

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let vc = AVPlayerViewController()
        let asset = url.isFileURL ? AVURLAsset(url: url)
            : AVURLAsset(url: url, options: ["AVURLAssetHTTPHeaderFieldsKey": ["User-Agent": API.ua]])
        let player = AVPlayer(playerItem: AVPlayerItem(asset: asset))
        vc.player = player
        vc.allowsPictureInPicturePlayback = true
        vc.canStartPictureInPictureAutomaticallyFromInline = true
        context.coordinator.observer = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime, object: player.currentItem, queue: .main) { _ in onEnd() }
        player.play()
        return vc
    }

    func updateUIViewController(_ vc: AVPlayerViewController, context: Context) {}

    static func dismantleUIViewController(_ vc: AVPlayerViewController, coordinator: Coordinator) {
        vc.player?.pause()
        if let o = coordinator.observer { NotificationCenter.default.removeObserver(o) }
    }

    final class Coordinator { var observer: NSObjectProtocol? }
}

struct LiveView: View {
    @ObservedObject private var cfg = Config.shared
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
                    ForEach(groups) { g in
                        Button { groupName = g.name } label: {
                            Text("\(g.name) \(g.channels.count)").font(.subheadline.weight(.semibold))
                                .padding(.horizontal, 14).padding(.vertical, 7)
                                .background(g.name == groupName ? Color.white : Color.card, in: Capsule())
                                .foregroundStyle(g.name == groupName ? .black : .white)
                        }
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
                                Text(ch.name).font(.caption.weight(.medium)).lineLimit(1).foregroundStyle(.white)
                            }
                        }
                        .buttonStyle(.plain)
                        // Long-press = the phone's hover: a muted live preview.
                        .contextMenu {
                            Button { play(ch) } label: { Label("播放", systemImage: "play.fill") }
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
            if !groups.contains(where: { $0.name == groupName }) { groupName = groups.first?.name ?? "" }
        }
    }

    private var channels: [LiveChannel] {
        let q = filter.trimmingCharacters(in: .whitespaces)
        if !q.isEmpty { return groups.flatMap(\.channels).filter { $0.name.localizedCaseInsensitiveContains(q) } }
        return groups.first { $0.name == groupName }?.channels ?? []
    }

    private func play(_ ch: LiveChannel) {
        let list = channels
        playing = PlayRequest(title: ch.name, episodes: list.map { Episode(name: $0.name, url: $0.url) },
                              index: list.firstIndex(of: ch) ?? 0)
    }
}
