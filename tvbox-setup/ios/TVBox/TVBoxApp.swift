import SwiftUI
import AVFoundation

@main
struct TVBoxApp: App {
    init() {
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        _ = DownloadManager.shared  // reattach background HLS downloads
    }

    var body: some Scene {
        WindowGroup { RootView() }
    }
}

struct RootView: View {
    @Environment(\.scenePhase) private var phase
    @ObservedObject private var toast = Toast.shared
    @State private var clip: ClipPayload?
    @State private var clipBanner = false

    var body: some View {
        TabView {
            NavigationStack { VodHomeView() }
                .tabItem { Label("首页", systemImage: "house") }
            NavigationStack { SearchView() }
                .tabItem { Label("搜索", systemImage: "magnifyingglass") }
            NavigationStack { LiveView() }
                .tabItem { Label("直播", systemImage: "tv") }
            NavigationStack { DownloadsView() }
                .tabItem { Label("下载", systemImage: "arrow.down.circle") }
            NavigationStack { SettingsView(clip: $clip) }
                .tabItem { Label("设置", systemImage: "gearshape") }
        }
        .tint(.brand)
        .preferredColorScheme(.dark)
        .overlay(alignment: .bottom) {
            if clipBanner { ClipboardBanner(payload: $clip, visible: $clipBanner) }
        }
        .overlay(alignment: .top) {
            if let t = toast.text {
                Text(t).font(.subheadline.weight(.semibold))
                    .padding(.horizontal, 16).padding(.vertical, 10)
                    .background(.white, in: Capsule()).foregroundStyle(.black)
                    .padding(.top, 8)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .task(id: t) { try? await Task.sleep(nanoseconds: 2_200_000_000); withAnimation { toast.text = nil } }
            }
        }
        .animation(.spring(duration: 0.3), value: clipBanner)
        .animation(.spring(duration: 0.3), value: toast.text)
        .sheet(item: $clip) { ClipboardImportView(text: $0.text) }
        .onChange(of: phase) { _, p in
            if p == .active { ClipboardBanner.check { clipBanner = true } } else { clipBanner = false }
        }
        .onAppear { ClipboardBanner.check { clipBanner = true } }
    }
}
