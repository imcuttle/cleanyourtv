import SwiftUI
import AVKit

struct PlayRequest: Identifiable {
    let id = UUID()
    let title: String
    let episodes: [Episode]
    var index: Int
    var item: VodItem? = nil   // 点播: progress goes into 观看历史
    var line = 0
    var startAt: Double = 0
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
                AVPlayerView(url: url, title: request.episodes.count > 1 ? "\(request.title) · \(ep.name)" : (request.item == nil ? ep.name : request.title),
                             artwork: request.item?.pic ?? "", startAt: request.startAt, onProgress: { t, dur in
                    guard let it = request.item else { return }
                    Library.shared.record(it, line: request.line, ep: request.index, epName: ep.name, t: t, dur: dur)
                }) {
                    if request.index + 1 < request.episodes.count { request.startAt = 0; request.index += 1 }
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
                    Button("下一集") { request.startAt = 0; request.index += 1 }
                        .font(.subheadline).padding(.horizontal, 12).padding(.vertical, 8)
                        .background(.ultraThinMaterial, in: Capsule())
                }
            }
            .padding(.horizontal).padding(.top, 4)
        }
        .statusBarHidden()
        .onDisappear { Library.shared.commit() }
    }
}

/// Keeps playing when the app leaves the foreground: switching apps starts Picture-in-Picture (the small
/// floating window), locking the screen keeps the sound going with lock-screen / Control Center controls.
struct AVPlayerView: UIViewControllerRepresentable {
    let url: URL
    var title = ""
    var artwork = ""
    var startAt: Double = 0
    var onProgress: ((Double, Double) -> Void)? = nil
    var onEnd: () -> Void = {}

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let vc = AVPlayerViewController()
        let asset = url.isFileURL ? AVURLAsset(url: url)
            : AVURLAsset(url: url, options: ["AVURLAssetHTTPHeaderFieldsKey": ["User-Agent": API.ua]])
        let item = AVPlayerItem(asset: asset)
        item.externalMetadata = Self.metadata(title: title, artwork: artwork)
        let player = AVPlayer(playerItem: item)
        player.audiovisualBackgroundPlaybackPolicy = .continuesIfPossible
        vc.player = player
        vc.allowsPictureInPicturePlayback = true
        vc.canStartPictureInPictureAutomaticallyFromInline = true
        vc.updatesNowPlayingInfoCenter = true
        vc.delegate = context.coordinator
        context.coordinator.attach(vc, player)
        try? AVAudioSession.sharedInstance().setActive(true)
        context.coordinator.observer = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime, object: player.currentItem, queue: .main) { _ in onEnd() }
        if startAt > 5 { player.seek(to: CMTime(seconds: startAt, preferredTimescale: 600)) }
        if let onProgress {
            context.coordinator.player = player
            context.coordinator.timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 5, preferredTimescale: 1), queue: .main) { t in
                let dur = player.currentItem?.duration.seconds ?? 0
                if t.seconds > 1, dur.isFinite, dur > 0 { onProgress(t.seconds, dur) }
            }
        }
        player.play()
        return vc
    }

    func updateUIViewController(_ vc: AVPlayerViewController, context: Context) {}

    static func dismantleUIViewController(_ vc: AVPlayerViewController, coordinator: Coordinator) {
        vc.player?.pause()
        if let o = coordinator.observer { NotificationCenter.default.removeObserver(o) }
        if let t = coordinator.timeObserver { coordinator.player?.removeTimeObserver(t) }
        coordinator.detach()
    }

    static func metadata(title: String, artwork: String) -> [AVMetadataItem] {
        var out: [AVMetadataItem] = []
        let t = AVMutableMetadataItem()
        t.identifier = .commonIdentifierTitle
        t.value = title as NSString
        t.extendedLanguageTag = "und"
        out.append(t)
        if !artwork.isEmpty, let img = ImagePipeline.shared.cached(artwork, 360), let data = img.jpegData(compressionQuality: 0.7) {
            let a = AVMutableMetadataItem()
            a.identifier = .commonIdentifierArtwork
            a.value = data as NSData
            a.dataType = kCMMetadataBaseDataType_JPEG as String
            a.extendedLanguageTag = "und"
            out.append(a)
        }
        return out
    }

    final class Coordinator: NSObject, AVPlayerViewControllerDelegate {
        var observer: NSObjectProtocol?
        var timeObserver: Any?
        var player: AVPlayer?
        private weak var vc: AVPlayerViewController?
        private var pip = false
        private var lifecycle: [NSObjectProtocol] = []

        func attach(_ vc: AVPlayerViewController, _ player: AVPlayer) {
            self.vc = vc
            self.player = player
            let nc = NotificationCenter.default
            // Without PiP (e.g. the screen locked), a player still attached to a visible layer gets paused in
            // the background. Detach it so the audio keeps going; reattach on return.
            lifecycle.append(nc.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
                guard let self, !self.pip else { return }
                self.vc?.player = nil
            })
            lifecycle.append(nc.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
                guard let self, self.vc?.player == nil else { return }
                self.vc?.player = self.player
            })
        }

        func detach() {
            lifecycle.forEach(NotificationCenter.default.removeObserver)
            lifecycle = []
        }

        func playerViewControllerWillStartPictureInPicture(_ c: AVPlayerViewController) { pip = true }
        func playerViewControllerDidStopPictureInPicture(_ c: AVPlayerViewController) { pip = false }
        func playerViewController(_ c: AVPlayerViewController,
                                  restoreUserInterfaceForPictureInPictureStopWithCompletionHandler done: @escaping (Bool) -> Void) {
            done(true)
        }
    }
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
                        Button { groupName = Self.favGroup } label: {
                            Text("\(Self.favGroup) \(favCount)").font(.subheadline.weight(.semibold))
                                .padding(.horizontal, 14).padding(.vertical, 7)
                                .background(groupName == Self.favGroup ? Color.white : Color.card, in: Capsule())
                                .foregroundStyle(groupName == Self.favGroup ? .black : .white)
                        }
                    }
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
                                    .overlay(alignment: .topLeading) {
                                        if lib.isLiveFavorite(ch.url) {
                                            Image(systemName: "star.fill").font(.caption2).foregroundStyle(.yellow).padding(6).shadow(radius: 2)
                                        }
                                    }
                                Text(ch.name).font(.caption.weight(.medium)).lineLimit(1).foregroundStyle(.white)
                            }
                        }
                        .buttonStyle(.plain)
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
