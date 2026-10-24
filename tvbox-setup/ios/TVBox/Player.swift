import SwiftUI
import AVKit
import MediaPlayer

// Our own player (no AVPlayerViewController): AVPlayerLayer + SwiftUI controls, keeping what the system
// player gave for free — 画中画, AirPlay, lock-screen / Control Center controls, background audio — and adding
// the gestures people expect: tap = controls, double-tap sides = ∓10 s, hold = 2x, horizontal drag = seek,
// vertical drag left / right = brightness / volume, frame preview while scrubbing, 锁定.

final class PlayerLayerView: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
}

struct LayerHost: UIViewRepresentable {
    let view: PlayerLayerView
    func makeUIView(context: Context) -> PlayerLayerView { view.removeFromSuperview(); return view }
    func updateUIView(_ v: PlayerLayerView, context: Context) {}
}

final class PlayerModel: NSObject, ObservableObject, AVPictureInPictureControllerDelegate {
    let player = AVPlayer()
    let videoView = PlayerLayerView()
    let previewView = PlayerLayerView()
    @Published var time: Double = 0
    @Published var duration: Double = 0      // 0 = live / unknown
    @Published var buffered: Double = 0
    @Published var playing = false
    @Published var buffering = true
    @Published var failed: String?
    @Published var rate: Float = 1
    @Published var pipPossible = false
    @Published var previewReady = false
    var isLive: Bool { duration <= 0 }

    private(set) var url: URL?
    var parked = false
    var onProgress: ((Double, Double) -> Void)?
    var onEnd: (() -> Void)?
    var onNext: (() -> Void)?
    var onPiPStarted: (() -> Void)?

    private var pip: AVPictureInPictureController?
    private var pipStarting = false
    private var timeObs: Any?
    private var kvo: [NSKeyValueObservation] = []
    private var itemKVO: [NSKeyValueObservation] = []
    private var observers: [NSObjectProtocol] = []
    private var endObs: NSObjectProtocol?
    private var remote: [(MPRemoteCommand, Any)] = []
    private var title = "", artwork = ""
    private var lastProgress = Date.distantPast
    private var previewPlayer: AVPlayer?
    private var previewSeeking = false
    private var previewWant: Double?
    private var startAt: Double = 0

    override init() {
        super.init()
        videoView.backgroundColor = .black
        videoView.playerLayer.player = player
        videoView.playerLayer.videoGravity = .resizeAspect
        previewView.backgroundColor = .black
        previewView.playerLayer.videoGravity = .resizeAspectFill
        player.audiovisualBackgroundPlaybackPolicy = .continuesIfPossible
        if AVPictureInPictureController.isPictureInPictureSupported(), let p = AVPictureInPictureController(playerLayer: videoView.playerLayer) {
            p.delegate = self
            p.canStartPictureInPictureAutomaticallyFromInline = true
            pip = p
            kvo.append(p.observe(\.isPictureInPicturePossible, options: [.initial, .new]) { [weak self] c, _ in
                DispatchQueue.main.async { self?.pipPossible = c.isPictureInPicturePossible }
            })
        }
        timeObs = player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 4), queue: .main) { [weak self] t in self?.tick(t.seconds) }
        kvo.append(player.observe(\.timeControlStatus, options: [.new]) { [weak self] p, _ in
            DispatchQueue.main.async {
                guard let self else { return }
                self.playing = p.timeControlStatus != .paused
                self.buffering = p.timeControlStatus == .waitingToPlayAtSpecifiedRate
                self.nowPlaying()
            }
        })
        let nc = NotificationCenter.default
        // Without 画中画 (screen locked), a player still attached to a visible layer is paused in the background:
        // detach it so the sound keeps going; reattach on return.
        observers.append(nc.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self, !self.pipStarting, !(self.pip?.isPictureInPictureActive ?? false) else { return }
            self.videoView.playerLayer.player = nil
        })
        observers.append(nc.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self, self.videoView.playerLayer.player == nil else { return }
            self.videoView.playerLayer.player = self.player
        })
        setupRemote()
    }

    // MARK: loading

    private static func asset(_ url: URL) -> AVURLAsset {
        url.isFileURL ? AVURLAsset(url: url) : AVURLAsset(url: url, options: ["AVURLAssetHTTPHeaderFieldsKey": ["User-Agent": API.ua]])
    }

    func open(_ url: URL, title: String, artwork: String, startAt: Double) {
        guard url != self.url else { return }
        self.url = url; self.title = title; self.artwork = artwork; self.startAt = startAt
        failed = nil; time = 0; duration = 0; buffered = 0; buffering = true
        let item = AVPlayerItem(asset: Self.asset(url))
        itemKVO = [
            item.observe(\.status, options: [.new]) { [weak self] it, _ in
                DispatchQueue.main.async {
                    guard let self else { return }
                    if it.status == .failed { self.failed = it.error?.localizedDescription ?? "无法播放"; self.buffering = false }
                    if it.status == .readyToPlay { self.updateDuration(it) }
                }
            },
            item.observe(\.duration, options: [.new]) { [weak self] it, _ in DispatchQueue.main.async { self?.updateDuration(it) } },
            item.observe(\.loadedTimeRanges, options: [.new]) { [weak self] it, _ in
                DispatchQueue.main.async {
                    guard let self else { return }
                    let t = self.player.currentTime().seconds
                    self.buffered = it.loadedTimeRanges.map(\.timeRangeValue)
                        .filter { $0.start.seconds <= t + 1 }.map { ($0.start + $0.duration).seconds }.max() ?? 0
                }
            },
        ]
        if let endObs { NotificationCenter.default.removeObserver(endObs) }
        endObs = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in self?.onEnd?() }
        player.replaceCurrentItem(with: item)
        if startAt > 5 { player.seek(to: CMTime(seconds: startAt, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) }
        player.playImmediately(atRate: rate)
        resetPreview()
        nowPlaying()
    }

    func retry() {
        guard let u = url else { return }
        url = nil
        open(u, title: title, artwork: artwork, startAt: time > 5 ? time : startAt)
    }

    private func updateDuration(_ it: AVPlayerItem) {
        let d = it.duration.seconds
        duration = d.isFinite && d > 0 ? d : 0
        nowPlaying()
    }

    private func tick(_ t: Double) {
        guard t.isFinite else { return }
        time = t
        if duration > 0, t > 1, Date().timeIntervalSince(lastProgress) > 5 {
            lastProgress = Date()
            onProgress?(t, duration)
        }
    }

    // MARK: control

    func toggle() { playing ? player.pause() : player.playImmediately(atRate: rate) }
    func play() { player.playImmediately(atRate: rate) }

    func seek(_ s: Double) {
        let s = max(0, duration > 0 ? min(s, duration - 1) : s)
        time = s
        player.seek(to: CMTime(seconds: s, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
            DispatchQueue.main.async { self?.nowPlaying() }
        }
    }
    func skip(_ d: Double) { seek(time + d) }

    func setRate(_ r: Float) {
        rate = r
        player.defaultRate = r
        if playing { player.rate = r }
        nowPlaying()
    }
    /// Hold-to-speed-up: changes the playing rate without touching the chosen one.
    func boost(_ on: Bool) { if playing { player.rate = on ? max(2, rate) : rate } }

    var canPiP: Bool { pip != nil }
    func startPiP() { pip?.startPictureInPicture() }

    // MARK: scrub preview — a second, muted, lowest-bitrate copy of the stream that seeks to the scrub point.

    func preview(at s: Double) {
        guard let url, duration > 0 else { return }
        if previewPlayer == nil {
            let item = AVPlayerItem(asset: Self.asset(url))
            item.preferredPeakBitRate = 300_000
            item.preferredForwardBufferDuration = 1
            let p = AVPlayer(playerItem: item)
            p.isMuted = true
            p.automaticallyWaitsToMinimizeStalling = false
            previewView.playerLayer.player = p
            previewPlayer = p
            previewReady = false
        }
        previewWant = s
        pumpPreview()
    }
    private func pumpPreview() {
        guard !previewSeeking, let p = previewPlayer, let s = previewWant else { return }
        previewWant = nil
        previewSeeking = true
        let tol = CMTime(seconds: 2, preferredTimescale: 600)
        p.seek(to: CMTime(seconds: s, preferredTimescale: 600), toleranceBefore: tol, toleranceAfter: tol) { [weak self] done in
            DispatchQueue.main.async {
                guard let self else { return }
                self.previewSeeking = false
                if done { self.previewReady = true }
                self.pumpPreview()
            }
        }
    }
    private func resetPreview() {
        previewPlayer?.pause()
        previewPlayer = nil
        previewView.playerLayer.player = nil
        previewWant = nil; previewSeeking = false; previewReady = false
    }

    // MARK: lock screen / Control Center

    private func setupRemote() {
        let c = MPRemoteCommandCenter.shared()
        c.skipForwardCommand.preferredIntervals = [15]
        c.skipBackwardCommand.preferredIntervals = [15]
        let add: (MPRemoteCommand, @escaping (MPRemoteCommandEvent) -> MPRemoteCommandHandlerStatus) -> Void = { cmd, h in
            cmd.isEnabled = true
            self.remote.append((cmd, cmd.addTarget(handler: h)))
        }
        add(c.playCommand) { [weak self] _ in self?.play(); return .success }
        add(c.pauseCommand) { [weak self] _ in self?.player.pause(); return .success }
        add(c.togglePlayPauseCommand) { [weak self] _ in self?.toggle(); return .success }
        add(c.skipForwardCommand) { [weak self] _ in self?.skip(15); return .success }
        add(c.skipBackwardCommand) { [weak self] _ in self?.skip(-15); return .success }
        add(c.nextTrackCommand) { [weak self] _ in
            guard let n = self?.onNext else { return .noActionableNowPlayingItem }
            n(); return .success
        }
        add(c.changePlaybackPositionCommand) { [weak self] e in
            guard let e = e as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            self?.seek(e.positionTime); return .success
        }
    }

    private func nowPlaying() {
        var info: [String: Any] = [MPMediaItemPropertyTitle: title,
                                   MPNowPlayingInfoPropertyElapsedPlaybackTime: time,
                                   MPNowPlayingInfoPropertyPlaybackRate: playing ? Double(rate) : 0,
                                   MPNowPlayingInfoPropertyIsLiveStream: isLive]
        if duration > 0 { info[MPMediaItemPropertyPlaybackDuration] = duration }
        let px = Poster.defaultPx, v = ImagePipeline.variants(artwork, px)
        if !artwork.isEmpty, let img = ImagePipeline.shared.cached(v.high, px) ?? v.low.flatMap({ ImagePipeline.shared.cached($0, px) }) {
            info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: img.size) { _ in img }
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    func teardown() {
        player.pause()
        player.replaceCurrentItem(with: nil)
        resetPreview()
        if let timeObs { player.removeTimeObserver(timeObs); self.timeObs = nil }
        kvo.forEach { $0.invalidate() }; kvo = []
        itemKVO.forEach { $0.invalidate() }; itemKVO = []
        observers.forEach(NotificationCenter.default.removeObserver); observers = []
        if let endObs { NotificationCenter.default.removeObserver(endObs); self.endObs = nil }
        remote.forEach { $0.0.removeTarget($0.1) }; remote = []
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        pip?.delegate = nil
        videoView.playerLayer.player = nil
        url = nil
    }

    // MARK: 画中画 — the small window outlives the full-screen player (see PiPKeeper).

    func pictureInPictureControllerWillStartPictureInPicture(_ c: AVPictureInPictureController) { pipStarting = true }
    func pictureInPictureControllerDidStartPictureInPicture(_ c: AVPictureInPictureController) {
        pipStarting = false
        parked = true
        PiPKeeper.shared.model = self
        onPiPStarted?()
    }
    func pictureInPictureController(_ c: AVPictureInPictureController, failedToStartPictureInPictureWithError error: Error) { pipStarting = false }
    func pictureInPictureController(_ c: AVPictureInPictureController,
                                    restoreUserInterfaceForPictureInPictureStopWithCompletionHandler done: @escaping (Bool) -> Void) {
        let k = PiPKeeper.shared
        guard parked, videoView.window == nil, var r = k.request else { return done(true) }
        r.startAt = 0
        k.pendingRestore = done
        k.restore = r
    }
    func pictureInPictureControllerDidStopPictureInPicture(_ c: AVPictureInPictureController) {
        // Closed from the small window (not "back to app"): stop for good.
        guard parked, videoView.window == nil, PiPKeeper.shared.pendingRestore == nil else { return }
        parked = false
        if PiPKeeper.shared.model === self { PiPKeeper.shared.model = nil }
        teardown()
    }
}

/// Holds the player while only the 画中画 window shows it; "back to app" re-presents PlayerScreen (RootView
/// observes `restore`), which picks the same model up again.
final class PiPKeeper: ObservableObject {
    static let shared = PiPKeeper()
    @Published var restore: PlayRequest?
    var request: PlayRequest?
    var model: PlayerModel?
    var pendingRestore: ((Bool) -> Void)?

    /// For a restoring screen: the parked model. For any other new player: stop whatever is still in 画中画.
    func claim() -> PlayerModel? {
        guard let m = model else { return nil }
        model = nil
        if restore != nil { m.parked = false; return m }
        m.parked = false
        pendingRestore = nil
        m.teardown()
        return nil
    }
}

// MARK: - System bits: volume, brightness, orientation, AirPlay

enum SystemControls {
    /// MPVolumeView's slider is the only public way to set the system volume; living in the view tree also
    /// keeps the system volume HUD from popping up.
    static let volumeView = MPVolumeView(frame: CGRect(x: -2000, y: -2000, width: 1, height: 1))
    static var volume: Double { Double(AVAudioSession.sharedInstance().outputVolume) }
    static func setVolume(_ v: Double) { volumeView.subviews.compactMap { $0 as? UISlider }.first?.setValue(Float(v), animated: false) }

    static var scene: UIWindowScene? { UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first }
    static var brightness: Double {
        get { Double(scene?.screen.brightness ?? 0.5) }
        set { scene?.screen.brightness = CGFloat(newValue) }
    }
    static func orient(landscape: Bool) {
        guard let s = scene else { return }
        s.requestGeometryUpdate(.iOS(interfaceOrientations: landscape ? .landscapeRight : .portrait)) { _ in }
        s.keyWindow?.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
    }
}

struct HiddenVolumeView: UIViewRepresentable {
    func makeUIView(context: Context) -> UIView {
        let v = UIView(frame: .zero)
        SystemControls.volumeView.removeFromSuperview()
        v.addSubview(SystemControls.volumeView)
        return v
    }
    func updateUIView(_ v: UIView, context: Context) {}
}

struct AirPlayButton: UIViewRepresentable {
    func makeUIView(context: Context) -> AVRoutePickerView {
        let v = AVRoutePickerView()
        v.tintColor = .white
        v.activeTintColor = UIColor(Color.brand)
        v.prioritizesVideoDevices = true
        return v
    }
    func updateUIView(_ v: AVRoutePickerView, context: Context) {}
}

/// UIKit recognisers under the controls: they cooperate (tap waits for double-tap, hold vs drag) far better
/// than stacked SwiftUI gestures.
struct GestureSurface: UIViewRepresentable {
    enum Pan { case began(Axis, CGFloat), changed(CGFloat, CGFloat), ended }
    var enabled: Bool
    var onTap: () -> Void
    var onDoubleTap: (CGFloat) -> Void
    var onPan: (Pan) -> Void
    var onHold: (Bool) -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> UIView {
        let v = UIView()
        v.backgroundColor = .clear
        let c = context.coordinator
        c.surface = self
        let dbl = UITapGestureRecognizer(target: c, action: #selector(Coordinator.double(_:)))
        dbl.numberOfTapsRequired = 2
        let tap = UITapGestureRecognizer(target: c, action: #selector(Coordinator.tap))
        tap.require(toFail: dbl)
        let pan = UIPanGestureRecognizer(target: c, action: #selector(Coordinator.pan(_:)))
        let hold = UILongPressGestureRecognizer(target: c, action: #selector(Coordinator.hold(_:)))
        hold.minimumPressDuration = 0.45
        for g in [dbl, tap, pan, hold] as [UIGestureRecognizer] { g.delegate = c; v.addGestureRecognizer(g) }
        return v
    }
    func updateUIView(_ v: UIView, context: Context) { context.coordinator.surface = self }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var surface: GestureSurface!
        @objc func tap() { surface.onTap() }
        @objc func double(_ g: UITapGestureRecognizer) {
            guard let v = g.view else { return }
            surface.onDoubleTap(g.location(in: v).x / max(v.bounds.width, 1))
        }
        @objc func pan(_ g: UIPanGestureRecognizer) {
            guard let v = g.view else { return }
            switch g.state {
            case .began:
                let vel = g.velocity(in: v)
                surface.onPan(.began(abs(vel.x) > abs(vel.y) ? .horizontal : .vertical, g.location(in: v).x / max(v.bounds.width, 1)))
            case .changed:
                let t = g.translation(in: v)
                surface.onPan(.changed(t.x / max(v.bounds.width, 1), t.y / max(v.bounds.height, 1)))
            default: surface.onPan(.ended)
            }
        }
        @objc func hold(_ g: UILongPressGestureRecognizer) {
            if g.state == .began { surface.onHold(true) }
            else if [.ended, .cancelled, .failed].contains(g.state) { surface.onHold(false) }
        }
        func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
            if let t = g as? UITapGestureRecognizer, t.numberOfTapsRequired == 1 { return true }  // shows the lock while locked
            return surface.enabled
        }
    }
}

// MARK: - Screen

struct PlayerScreen: View {
    @Environment(\.dismiss) private var dismiss
    @State private var request: PlayRequest
    @StateObject private var m: PlayerModel
    @State private var chrome = true
    @State private var chromeTick = 0
    @State private var locked = false
    @State private var hud: HUD?
    @State private var hudTick = 0
    @State private var scrub: Double?          // 0…1 while dragging the timeline
    @State private var showList = false
    @State private var pan: PanKind?
    @State private var panStart: Double = 0
    @State private var seekTarget: Double = 0
    @State private var originalBrightness: Double?

    enum PanKind { case seek, brightness, volume }
    enum HUD: Equatable { case brightness(Double), volume(Double), seek(Double, Double), text(String, String) }

    init(request: PlayRequest) {
        _request = State(initialValue: request)
        _m = StateObject(wrappedValue: PiPKeeper.shared.claim() ?? PlayerModel())
    }

    private var ep: Episode { request.episodes[request.index] }
    private var isLiveList: Bool { request.item == nil && m.isLive }
    private var hasNext: Bool { request.index + 1 < request.episodes.count }
    private var hasPrev: Bool { request.index > 0 }

    var body: some View {
        GeometryReader { geo in
            let landscape = geo.size.width > geo.size.height
            ZStack {
                Color.black.ignoresSafeArea()
                LayerHost(view: m.videoView).ignoresSafeArea()
                GestureSurface(enabled: !locked, onTap: { showChrome(!chrome) }, onDoubleTap: doubleTap, onPan: onPan, onHold: hold)
                    .ignoresSafeArea()
                if m.buffering && m.failed == nil {
                    ProgressView().controlSize(.large).tint(.white).allowsHitTesting(false)
                }
                if let err = m.failed { failure(err) }
                if chrome && !locked { controls(landscape: landscape) }
                if chrome {
                    Button { withAnimation(.easeOut(duration: 0.2)) { locked.toggle() }; showChrome(true) } label: {
                        Image(systemName: locked ? "lock.fill" : "lock.open")
                    }
                    .buttonStyle(.press(.icon))
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                    .padding(.leading, landscape ? 8 : 14)
                    .transition(.opacity)
                }
                if let hud { hudView(hud).allowsHitTesting(false).transition(.opacity.combined(with: .scale(scale: 0.9))) }
                if showList { episodePanel(landscape: landscape) }
                HiddenVolumeView().frame(width: 1, height: 1).opacity(0.01).allowsHitTesting(false)
            }
        }
        .preferredColorScheme(.dark)
        .statusBarHidden()
        .persistentSystemOverlays(chrome && !locked ? .automatic : .hidden)
        .animation(.easeOut(duration: 0.2), value: chrome)
        .animation(.easeOut(duration: 0.15), value: hud)
        .task(id: request.index) { start() }
        .task(id: chromeTick) {
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            if !Task.isCancelled, m.playing, scrub == nil, !showList { chrome = false }
        }
        .task(id: hudTick) {
            try? await Task.sleep(nanoseconds: 700_000_000)
            if !Task.isCancelled, pan == nil { hud = nil }
        }
        .onAppear {
            m.onPiPStarted = { dismiss() }
            if let done = PiPKeeper.shared.pendingRestore {
                PiPKeeper.shared.pendingRestore = nil
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { done(true) }
            }
        }
        .onDisappear {
            if let b = originalBrightness { SystemControls.brightness = b }
            Library.shared.commit()
            if !m.parked { m.teardown(); SystemControls.orient(landscape: false) }
        }
    }

    // MARK: pieces

    private func controls(landscape: Bool) -> some View {
        ZStack {
            VStack(spacing: 0) {
                LinearGradient(colors: [.black.opacity(0.75), .clear], startPoint: .top, endPoint: .bottom).frame(height: 130)
                Spacer()
                LinearGradient(colors: [.clear, .black.opacity(0.8)], startPoint: .top, endPoint: .bottom).frame(height: 170)
            }
            .ignoresSafeArea().allowsHitTesting(false)
            VStack(spacing: 0) {
                topBar
                Spacer()
                centerButtons
                Spacer()
                bottomBar(landscape: landscape)
            }
            .padding(.horizontal, landscape ? 20 : 14).padding(.vertical, 8)
        }
        .transition(.opacity)
    }

    private var topBar: some View {
        HStack(spacing: 12) {
            Button { dismiss() } label: { Image(systemName: "chevron.down") }.buttonStyle(.press(.icon))
            VStack(alignment: .leading, spacing: 2) {
                Text(request.item == nil ? ep.name : request.title).font(.headline).lineLimit(1)
                if request.item != nil, request.episodes.count > 1 {
                    Text(ep.name).font(.caption).foregroundStyle(.white.opacity(0.7)).lineLimit(1)
                }
            }
            .foregroundStyle(.white)
            if DownloadManager.shared.localURL(for: ep.url) != nil { Tag(text: "本地", color: .green) }
            Spacer(minLength: 8)
            AirPlayButton().frame(width: 40, height: 40)
            if m.canPiP {
                Button { m.startPiP() } label: { Image(systemName: "pip.enter") }
                    .buttonStyle(.press(.icon)).disabled(!m.pipPossible).opacity(m.pipPossible ? 1 : 0.4)
            }
        }
    }

    private var centerButtons: some View {
        HStack(spacing: 44) {
            if !m.isLive {
                Button { m.skip(-10); showChrome(true) } label: { Image(systemName: "gobackward.10").font(.system(size: 30, weight: .medium)) }
                    .buttonStyle(.press)
            } else if hasPrev {
                Button { go(-1) } label: { Image(systemName: "backward.end.fill").font(.system(size: 28)) }.buttonStyle(.press)
            }
            Button { m.toggle(); showChrome(true) } label: {
                Image(systemName: m.playing ? "pause.fill" : "play.fill").font(.system(size: 34))
                    .frame(width: 76, height: 76).background(Color.black.opacity(0.35), in: Circle())
            }
            .buttonStyle(.press)
            if !m.isLive {
                Button { m.skip(10); showChrome(true) } label: { Image(systemName: "goforward.10").font(.system(size: 30, weight: .medium)) }
                    .buttonStyle(.press)
            } else if hasNext {
                Button { go(1) } label: { Image(systemName: "forward.end.fill").font(.system(size: 28)) }.buttonStyle(.press)
            }
        }
        .foregroundStyle(.white)
        .opacity(m.buffering ? 0 : 1)
    }

    private func bottomBar(landscape: Bool) -> some View {
        VStack(spacing: 6) {
            if !m.isLive { scrubber }
            HStack(spacing: 10) {
                if m.isLive {
                    Text("● 直播").font(.caption.weight(.heavy)).foregroundStyle(Color.brand)
                } else {
                    Text("\(fmt(scrub.map { $0 * m.duration } ?? m.time)) / \(fmt(m.duration))")
                        .font(.caption.weight(.semibold)).monospacedDigit().foregroundStyle(.white.opacity(0.9))
                }
                Spacer()
                if !m.isLive {
                    Menu {
                        ForEach([0.75, 1, 1.25, 1.5, 2] as [Float], id: \.self) { r in
                            Button { m.setRate(r) } label: {
                                if r == m.rate { Label(rateText(r), systemImage: "checkmark") } else { Text(rateText(r)) }
                            }
                        }
                    } label: {
                        Text(m.rate == 1 ? "倍速" : rateText(m.rate))
                    }
                    .menuStyle(.button).buttonStyle(.press(.chip(false)))
                }
                if request.episodes.count > 1 {
                    Button(isLiveList ? "频道" : "选集") { withAnimation(.spring(duration: 0.3)) { showList = true } }
                        .buttonStyle(.press(.chip(false)))
                }
                if hasNext && !m.isLive {
                    Button { go(1) } label: { Image(systemName: "forward.end.fill") }.buttonStyle(.press(.chip(false)))
                }
                Button { SystemControls.orient(landscape: !landscape); showChrome(true) } label: {
                    Image(systemName: landscape ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right")
                }
                .buttonStyle(.press(.chip(false)))
            }
        }
    }

    private var scrubber: some View {
        GeometryReader { g in
            let w = g.size.width
            let p = scrub ?? (m.duration > 0 ? m.time / m.duration : 0)
            let b = m.duration > 0 ? min(1, m.buffered / m.duration) : 0
            ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.22))
                Capsule().fill(Color.white.opacity(0.4)).frame(width: w * b)
                Capsule().fill(Color.brand).frame(width: w * p)
            }
            .frame(height: scrub == nil ? 4 : 8)
            .overlay(alignment: .leading) {
                Circle().fill(Color.brand).frame(width: scrub == nil ? 14 : 22, height: scrub == nil ? 14 : 22)
                    .shadow(color: .black.opacity(0.4), radius: 3)
                    .offset(x: w * p - (scrub == nil ? 7 : 11))
            }
            .frame(maxHeight: .infinity)
            .overlay(alignment: .topLeading) {
                if let s = scrub {
                    VStack(spacing: 4) {
                        LayerHost(view: m.previewView)
                            .frame(width: 176, height: 99)
                            .overlay { if !m.previewReady { ProgressView().tint(.white) } }
                            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(.white, lineWidth: 2))
                        Text(fmt(s * m.duration)).font(.subheadline.weight(.bold)).monospacedDigit().shadow(radius: 3)
                    }
                    .offset(x: min(max(0, w * s - 88), w - 176), y: -138)
                    .allowsHitTesting(false)
                }
            }
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0)
                .onChanged { v in
                    let f = min(1, max(0, v.location.x / w))
                    if scrub == nil { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
                    scrub = f
                    m.preview(at: f * m.duration)
                    showChrome(true)
                }
                .onEnded { v in
                    m.seek(min(1, max(0, v.location.x / w)) * m.duration)
                    scrub = nil
                    showChrome(true)
                })
            .animation(.easeOut(duration: 0.12), value: scrub == nil)
        }
        .frame(height: 28)
    }

    private func failure(_ err: String) -> some View {
        VStack(spacing: 14) {
            Image(systemName: "exclamationmark.triangle").font(.largeTitle).foregroundStyle(.orange)
            Text("播放失败").font(.headline)
            Text(err).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center).lineLimit(3)
            HStack(spacing: 10) {
                Button("重试") { m.retry() }.buttonStyle(.press(.primary))
                if hasNext { Button("下一集") { go(1) }.buttonStyle(.press(.secondary)) }
                Button("关闭") { dismiss() }.buttonStyle(.press(.secondary))
            }
        }
        .padding(30).frame(maxWidth: 360)
    }

    private func hudView(_ h: HUD) -> some View {
        Group {
            switch h {
            case .brightness(let v), .volume(let v):
                let icon: String = {
                    if case .brightness = h { return v < 0.4 ? "sun.min.fill" : "sun.max.fill" }
                    return v == 0 ? "speaker.slash.fill" : v < 0.5 ? "speaker.wave.1.fill" : "speaker.wave.3.fill"
                }()
                HStack(spacing: 12) {
                    Image(systemName: icon).font(.headline).frame(width: 24)
                    ZStack(alignment: .leading) {
                        Capsule().fill(Color.white.opacity(0.25))
                        Capsule().fill(Color.white).frame(width: 130 * v)
                    }
                    .frame(width: 130, height: 5)
                }
            case .seek(let t, let d):
                VStack(spacing: 4) {
                    Text("\(fmt(t)) / \(fmt(m.duration))").font(.title3.weight(.bold)).monospacedDigit()
                    Text("\(d >= 0 ? "+" : "−")\(fmt(abs(d)))").font(.subheadline).monospacedDigit().foregroundStyle(.white.opacity(0.75))
                }
            case .text(let icon, let t):
                Label(t, systemImage: icon).font(.headline)
            }
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 20).padding(.vertical, 14)
        .background(Color.black.opacity(0.6), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func episodePanel(landscape: Bool) -> some View {
        ZStack(alignment: landscape ? .trailing : .bottom) {
            Color.black.opacity(0.35).ignoresSafeArea()
                .onTapGesture { withAnimation(.spring(duration: 0.3)) { showList = false } }
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text(isLiveList ? "频道" : "选集").font(.headline)
                    Text("\(request.index + 1) / \(request.episodes.count)").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button { withAnimation(.spring(duration: 0.3)) { showList = false } } label: { Image(systemName: "xmark") }
                        .buttonStyle(.press(.icon))
                }
                ScrollViewReader { proxy in
                    ScrollView {
                        if isLiveList {
                            LazyVStack(spacing: 2) {
                                ForEach(request.episodes.indices, id: \.self) { i in
                                    Button { pick(i) } label: {
                                        HStack(spacing: 12) {
                                            Text("\(i + 1)").font(.caption).monospacedDigit().foregroundStyle(.secondary).frame(width: 28, alignment: .trailing)
                                            Text(request.episodes[i].name).lineLimit(1)
                                            Spacer()
                                        }
                                        .padding(.vertical, 10).padding(.horizontal, 8)
                                        .background(i == request.index ? Color.brand : .clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                                    }
                                    .buttonStyle(.press).id(i)
                                }
                            }
                        } else {
                            LazyVGrid(columns: [GridItem(.adaptive(minimum: 64), spacing: 8)], spacing: 8) {
                                ForEach(request.episodes.indices, id: \.self) { i in
                                    Button { pick(i) } label: {
                                        Text(request.episodes[i].name).font(.subheadline).lineLimit(1)
                                            .frame(maxWidth: .infinity).padding(.vertical, 11)
                                            .background(i == request.index ? Color.brand : Color.white.opacity(0.1),
                                                        in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                                    }
                                    .buttonStyle(.press).id(i)
                                }
                            }
                        }
                    }
                    .onAppear { proxy.scrollTo(request.index, anchor: .center) }
                }
            }
            .foregroundStyle(.white)
            .padding(16)
            .frame(width: landscape ? 340 : nil)
            .frame(maxHeight: landscape ? .infinity : 420)
            .background(Color(white: 0.09).opacity(0.97), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .padding(landscape ? 10 : 0)
            .transition(.move(edge: landscape ? .trailing : .bottom))
        }
    }

    // MARK: actions

    private func start() {
        PiPKeeper.shared.request = request
        let item = request.item, line = request.line, idx = request.index, ep = self.ep
        m.onProgress = { t, dur in if let item { Library.shared.record(item, line: line, ep: idx, epName: ep.name, t: t, dur: dur) } }
        m.onEnd = { if hasNext { go(1) } }
        m.onNext = hasNext ? { go(1) } : nil
        let title = request.episodes.count > 1 && item != nil ? "\(request.title) · \(ep.name)" : (item == nil ? ep.name : request.title)
        if let u = DownloadManager.shared.localURL(for: ep.url) ?? API.url(ep.url) {
            m.open(u, title: title, artwork: item?.pic ?? "", startAt: request.startAt)
        } else {
            m.failed = "地址无效"
        }
        showChrome(true)
    }

    private func go(_ d: Int) {
        let i = request.index + d
        guard request.episodes.indices.contains(i) else { return }
        request.startAt = 0
        request.index = i
    }
    private func pick(_ i: Int) {
        withAnimation(.spring(duration: 0.3)) { showList = false }
        if i != request.index { request.startAt = 0; request.index = i }
    }

    private func showChrome(_ on: Bool) {
        chrome = on
        if on { chromeTick += 1 }
    }
    private func flash(_ h: HUD) { hud = h; hudTick += 1 }

    private func doubleTap(_ x: CGFloat) {
        if m.isLive || (x > 0.35 && x < 0.65) {
            m.toggle()
            flash(.text(m.playing ? "pause.fill" : "play.fill", m.playing ? "暂停" : "播放"))
        } else {
            m.skip(x < 0.5 ? -10 : 10)
            flash(.text(x < 0.5 ? "gobackward.10" : "goforward.10", x < 0.5 ? "后退 10 秒" : "快进 10 秒"))
        }
    }

    private func hold(_ on: Bool) {
        guard !m.isLive, !locked else { return }
        m.boost(on)
        if on {
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            hud = .text("forward.fill", "\(rateText(max(2, m.rate))) 快进中")
        } else { hud = nil }
    }

    private func onPan(_ e: GestureSurface.Pan) {
        switch e {
        case .began(let axis, let x):
            if axis == .horizontal {
                guard !m.isLive else { pan = nil; return }
                pan = .seek; panStart = m.time; seekTarget = m.time
            } else if x < 0.5 {
                pan = .brightness; panStart = SystemControls.brightness
                if originalBrightness == nil { originalBrightness = panStart }
            } else {
                pan = .volume; panStart = SystemControls.volume
            }
        case .changed(let dx, let dy):
            switch pan {
            case .seek:
                seekTarget = min(max(0, panStart + Double(dx) * min(m.duration, 300)), max(0, m.duration - 1))
                hud = .seek(seekTarget, seekTarget - panStart)
            case .brightness:
                let v = min(1, max(0, panStart - Double(dy) * 1.4))
                SystemControls.brightness = v
                hud = .brightness(v)
            case .volume:
                let v = min(1, max(0, panStart - Double(dy) * 1.4))
                SystemControls.setVolume(v)
                hud = .volume(v)
            case nil: break
            }
        case .ended:
            if pan == .seek { m.seek(seekTarget) }
            pan = nil
            hudTick += 1
        }
    }

    private func rateText(_ r: Float) -> String { r == Float(Int(r)) ? "\(Int(r))x" : "\(r)x" }
    private func fmt(_ s: Double) -> String {
        guard s.isFinite else { return "0:00" }
        let s = Int(max(0, s)), h = s / 3600, mm = s / 60 % 60, ss = s % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, mm, ss) : String(format: "%d:%02d", mm, ss)
    }
}
