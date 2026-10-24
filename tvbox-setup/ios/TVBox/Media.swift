import SwiftUI
import UIKit
import ImageIO
import CryptoKit
import AVFoundation

private func md5(_ s: String) -> String {
    Insecure.MD5.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined()
}

private func cacheDir(_ name: String) -> URL {
    let d = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent(name, isDirectory: true)
    try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
    return d
}

/// Poster loading that doesn't feel slow: memory cache → disk cache → network, de-duplicated in flight,
/// decoded off the main thread and downsampled to the size actually drawn.
final class ImagePipeline {
    static let shared = ImagePipeline()
    private let mem = NSCache<NSString, UIImage>()
    private var inflight: [String: Task<UIImage?, Never>] = [:]
    private let lock = NSLock()
    private let dir = cacheDir("img")

    init() { mem.totalCostLimit = 120 * 1024 * 1024 }

    func cached(_ url: String, _ px: CGFloat) -> UIImage? { mem.object(forKey: "\(px)|\(url)" as NSString) }

    func load(_ url: String, _ px: CGFloat) async -> UIImage? {
        let key = "\(px)|\(url)"
        if let m = mem.object(forKey: key as NSString) { return m }
        lock.lock()
        if let t = inflight[key] { lock.unlock(); return await t.value }
        let file = dir.appendingPathComponent(md5(url))
        let t = Task.detached(priority: .userInitiated) { () -> UIImage? in
            var data = try? Data(contentsOf: file)
            if data == nil, let u = API.url(url) {
                data = try? await API.fetch(u, timeout: 20)
                if let data { try? data.write(to: file) }
            }
            guard let data else { return nil }
            return ImagePipeline.downsample(data, px)
        }
        inflight[key] = t
        lock.unlock()
        let img = await t.value
        lock.lock(); inflight[key] = nil; lock.unlock()
        if let img { mem.setObject(img, forKey: key as NSString, cost: Int(img.size.width * img.size.height * img.scale * img.scale * 4)) }
        return img
    }

    func prefetch(_ urls: [String], _ px: CGFloat = 360) {
        for u in urls where !u.isEmpty { Task.detached(priority: .utility) { _ = await self.load(u, px) } }
    }

    static func downsample(_ data: Data, _ px: CGFloat) -> UIImage? {
        guard let src = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
                                     kCGImageSourceShouldCacheImmediately: true,
                                     kCGImageSourceCreateThumbnailWithTransform: true,
                                     kCGImageSourceThumbnailMaxPixelSize: px]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        return UIImage(cgImage: cg)
    }
}

struct Poster: View {
    let url: String
    var px: CGFloat = 360
    @State private var image: UIImage?
    @State private var shimmer = false

    init(url: String, px: CGFloat = 360) {
        self.url = url
        self.px = px
        _image = State(initialValue: ImagePipeline.shared.cached(url, px))
    }

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image).resizable().scaledToFill().transition(.opacity)
            } else {
                Rectangle().fill(Color.card)
                    .overlay(LinearGradient(colors: [.clear, .white.opacity(0.06), .clear], startPoint: .leading, endPoint: .trailing)
                        .offset(x: shimmer ? 200 : -200))
                    .onAppear { withAnimation(.linear(duration: 1.2).repeatForever(autoreverses: false)) { shimmer = true } }
            }
        }
        .task(id: url) {
            guard image == nil, !url.isEmpty else { return }
            let img = await ImagePipeline.shared.load(url, px)
            withAnimation(.easeOut(duration: 0.25)) { image = img }
        }
    }
}

// MARK: - Live covers

/// On-device live covers: play the stream muted and invisibly, grab one frame, cache it for 15 minutes.
@MainActor
final class LiveThumbs {
    static let shared = LiveThumbs()
    private let mem = NSCache<NSString, UIImage>()
    private let dir = cacheDir("live")
    private let ttl: TimeInterval = 15 * 60
    private var running = 0
    private var waiting: [CheckedContinuation<Void, Never>] = []
    private var inflight: [String: Task<UIImage?, Never>] = [:]
    private let ctx = CIContext()

    func cached(_ url: String) -> UIImage? {
        if let m = mem.object(forKey: url as NSString) { return m }
        let f = dir.appendingPathComponent(md5(url) + ".jpg")
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: f.path),
              let date = attrs[.modificationDate] as? Date, Date().timeIntervalSince(date) < ttl,
              let img = UIImage(contentsOfFile: f.path) else { return nil }
        mem.setObject(img, forKey: url as NSString)
        return img
    }

    func thumb(_ url: String) async -> UIImage? {
        if let c = cached(url) { return c }
        if let t = inflight[url] { return await t.value }
        let t = Task { () -> UIImage? in
            await acquire()
            defer { release() }
            guard !Task.isCancelled, let img = await grab(url) else { return nil }
            mem.setObject(img, forKey: url as NSString)
            try? img.jpegData(compressionQuality: 0.7)?.write(to: dir.appendingPathComponent(md5(url) + ".jpg"))
            return img
        }
        inflight[url] = t
        let img = await t.value
        inflight[url] = nil
        return img
    }

    private func acquire() async {
        if running < 2 { running += 1; return }
        await withCheckedContinuation { waiting.append($0) }
    }

    private func release() {
        if waiting.isEmpty { running -= 1 } else { waiting.removeFirst().resume() }
    }

    private func grab(_ s: String) async -> UIImage? {
        guard let u = API.url(s) else { return nil }
        let item = AVPlayerItem(asset: AVURLAsset(url: u, options: ["AVURLAssetHTTPHeaderFieldsKey": ["User-Agent": API.ua]]))
        let out = AVPlayerItemVideoOutput(pixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        item.add(out)
        item.preferredForwardBufferDuration = 1
        let player = AVPlayer(playerItem: item)
        player.isMuted = true
        player.play()
        defer { player.pause(); player.replaceCurrentItem(with: nil) }
        for _ in 0..<40 {
            try? await Task.sleep(nanoseconds: 300_000_000)
            if item.status == .failed { return nil }
            let t = item.currentTime()
            if t.seconds > 0.2, out.hasNewPixelBuffer(forItemTime: t),
               let pb = out.copyPixelBuffer(forItemTime: t, itemTimeForDisplay: nil) {
                var ci = CIImage(cvPixelBuffer: pb)
                let scale = 480 / max(ci.extent.width, 1)
                ci = ci.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
                guard let cg = ctx.createCGImage(ci, from: ci.extent) else { return nil }
                return UIImage(cgImage: cg)
            }
        }
        return nil
    }
}

struct LiveCover: View {
    let channel: LiveChannel
    @State private var image: UIImage?

    init(channel: LiveChannel) {
        self.channel = channel
        _image = State(initialValue: LiveThumbs.shared.cached(channel.url))
    }

    var body: some View {
        Color.card
            .aspectRatio(16 / 9, contentMode: .fit)
            .overlay {
                if let image {
                    Image(uiImage: image).resizable().scaledToFill().transition(.opacity)
                } else {
                    Poster(url: channel.logo, px: 200).scaledToFit().padding(18).opacity(channel.logo.isEmpty ? 0 : 1)
                        .overlay { if channel.logo.isEmpty { Image(systemName: "tv").font(.title).foregroundStyle(.tertiary) } }
                }
            }
            .overlay(alignment: .bottomLeading) {
                if image != nil, !channel.logo.isEmpty {
                    Poster(url: channel.logo, px: 120).scaledToFit().frame(width: 44, height: 24).padding(6)
                        .shadow(color: .black, radius: 2)
                }
            }
            .overlay(alignment: .topTrailing) {
                Text("LIVE").font(.system(size: 9, weight: .heavy)).padding(.horizontal, 4).padding(.vertical, 1)
                    .background(Color.brand).foregroundStyle(.white).clipShape(RoundedRectangle(cornerRadius: 2)).padding(5)
            }
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .task(id: channel.url) {
                guard image == nil else { return }
                let img = await LiveThumbs.shared.thumb(channel.url)
                withAnimation(.easeOut(duration: 0.3)) { image = img }
            }
    }
}

/// Muted live mini-player for the long-press preview (the phone's version of hover).
struct LivePreview: UIViewRepresentable {
    let url: String

    final class PlayerView: UIView {
        override class var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    }

    func makeUIView(context: Context) -> PlayerView {
        let v = PlayerView()
        v.backgroundColor = .black
        v.playerLayer.videoGravity = .resizeAspectFill
        if let u = API.url(url) {
            let p = AVPlayer(playerItem: AVPlayerItem(asset: AVURLAsset(url: u, options: ["AVURLAssetHTTPHeaderFieldsKey": ["User-Agent": API.ua]])))
            p.isMuted = true
            v.playerLayer.player = p
            p.play()
        }
        return v
    }

    func updateUIView(_ v: PlayerView, context: Context) {}

    static func dismantleUIView(_ v: PlayerView, coordinator: ()) {
        v.playerLayer.player?.pause()
        v.playerLayer.player = nil
    }
}
