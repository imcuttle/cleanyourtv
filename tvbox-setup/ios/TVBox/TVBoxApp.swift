import SwiftUI
import AVFoundation

@main
struct TVBoxApp: App {
    init() {
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        _ = DownloadManager.shared  // reattach background HLS downloads
    }

    var body: some Scene {
        WindowGroup {
            TabView {
                NavigationStack { VodHomeView() }
                    .tabItem { Label("首页", systemImage: "house") }
                NavigationStack { SearchView() }
                    .tabItem { Label("搜索", systemImage: "magnifyingglass") }
                NavigationStack { LiveView() }
                    .tabItem { Label("直播", systemImage: "tv") }
                NavigationStack { DownloadsView() }
                    .tabItem { Label("下载", systemImage: "arrow.down.circle") }
                NavigationStack { SettingsView() }
                    .tabItem { Label("设置", systemImage: "gearshape") }
            }
            .tint(.brand)
            .preferredColorScheme(.dark)
        }
    }
}
