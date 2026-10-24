import SwiftUI

struct SettingsView: View {
    @Binding var clip: ClipPayload?
    @State private var manualText = ""
    @ObservedObject private var cfg = Config.shared
    @AppStorage("safety.level") private var level = "standard"
    @AppStorage("safety.pin") private var pin = ""
    @AppStorage("douban.tv") private var dbTv = true
    @AppStorage("douban.movie") private var dbMovie = true
    @AppStorage("douban.show") private var dbShow = true
    @AppStorage("douban.anime") private var dbAnime = true
    @State private var unlocked = false
    @State private var askUnlock = false
    @State private var askNewPin = false
    @State private var pinInput = ""
    @State private var importURL = ""
    @State private var replace = false
    @State private var importing = false
    @State private var message: String?
    @State private var ping: [String: String] = [:]
    @State private var pinging = false

    private var locked: Bool { !pin.isEmpty && !unlocked }

    var body: some View {
        Form {
            Section {
                Picker("安全级别", selection: $level) {
                    ForEach(Safety.levels, id: \.0) { Text($0.1).tag($0.0) }
                }
                .pickerStyle(.segmented)
                .disabled(locked)
                if locked {
                    Button("输入家长 PIN 解锁") { pinInput = ""; askUnlock = true }
                } else {
                    Button(pin.isEmpty ? "设置家长 PIN" : "修改 / 清除家长 PIN") { pinInput = ""; askNewPin = true }
                }
            } header: { Text("安全级别") } footer: {
                Text("儿童：只显示标记「少儿」的源，关闭直播和豆瓣热门。标准：隐藏「成人」源和伦理/写真等分类。全部：不过滤。设了 PIN 后，改级别和改源都要先解锁。")
            }

            if level != "kids" {
                Section {
                    Toggle("热门剧集", isOn: $dbTv)
                    Toggle("热门电影", isOn: $dbMovie)
                    Toggle("热门综艺", isOn: $dbShow)
                    Toggle("热门动漫", isOn: $dbAnime)
                } header: { Text("首页豆瓣分类") } footer: {
                    Text("在点播首页显示豆瓣热门榜单。儿童模式下不显示。")
                }
            }

            Section {
                ForEach($cfg.sites) { $s in
                    NavigationLink { SiteEditor(site: $s) } label: {
                        HStack {
                            Text(s.name)
                            if s.kids == true { Tag(text: "少儿", color: .green) }
                            if s.adult == true { Tag(text: "成人", color: .brand) }
                            Spacer()
                            pingLabel("s:" + s.id) ?? Text(URL(string: s.api)?.host ?? s.api).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                .onDelete { cfg.sites.remove(atOffsets: $0) }
                .onMove { cfg.sites.move(fromOffsets: $0, toOffset: $1) }
                Button { cfg.addSite() } label: { Label("添加点播源", systemImage: "plus") }
            } header: {
                HStack {
                    Text("点播源 · \(cfg.sites.count)")
                    Spacer()
                    Button(pinging ? "测速中…" : "一键测速") { Task { await pingAll() } }.disabled(pinging).textCase(nil)
                }
            } footer: {
                Text("苹果CMS 接口（…/api.php/provide/vod）。左滑删除，右上角「编辑」排序。")
            }
            .disabled(locked)

            Section {
                ForEach($cfg.lives) { $l in
                    NavigationLink { LiveEditor(src: $l) } label: {
                        HStack {
                            Text(l.name)
                            Spacer()
                            pingLabel("l:" + l.id) ?? Text(l.text != nil ? "已编辑" : l.url.hasPrefix("http") ? (URL(string: l.url)?.host ?? l.url) : "内置")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                .onDelete { cfg.lives.remove(atOffsets: $0) }
                .onMove { cfg.lives.move(fromOffsets: $0, toOffset: $1) }
                Button {
                    cfg.lives.append(LiveSource(name: "新直播源", url: "https://\(UUID().uuidString.prefix(4)).example/live.m3u"))
                } label: { Label("添加直播源", systemImage: "plus") }
            } header: {
                HStack {
                    Text("直播源 · \(cfg.lives.count)")
                    Spacer()
                    Button(pinging ? "测速中…" : "一键测速") { Task { await pingAll() } }.disabled(pinging).textCase(nil)
                }
            } footer: {
                Text("m3u / m3u8 频道列表、TVBox txt，或单条 .m3u8 播放地址。")
            }
            .disabled(locked)

            Section {
                PasteButton(payloadType: String.self) { strings in
                    let t = strings.joined(separator: "\n")
                    DispatchQueue.main.async {
                        if Recognizer.looksLikeSource(t) { clip = ClipPayload(text: t) } else { message = "剪贴板里没识别到源" }
                    }
                }
                .labelStyle(.titleAndIcon)
                .tint(.brand)
                TextField("或者把文字粘到这里", text: $manualText, axis: .vertical)
                    .lineLimit(3...8).font(.footnote)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                if !manualText.isEmpty {
                    Button("识别") { clip = ClipPayload(text: manualText); manualText = "" }
                }
            } header: { Text("从剪贴板识别") } footer: {
                Text("接口地址、m3u/txt 链接、直播流、TVBox 配置 JSON 或整段频道列表都行。逐个打开链接确认类型，列出新源，已存在的自动去重，确认后添加。回到 App 时剪贴板里有链接也会提示。")
            }
            .disabled(locked)

            Section {
                TextField("https://…/config.json", text: $importURL)
                    .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                Toggle("替换现有源", isOn: $replace)
                Button(importing ? "导入中…" : "导入") { Task { await runImport() } }
                    .disabled(importing || importURL.isEmpty)
            } header: { Text("导入 TVBox 配置") } footer: {
                Text("单仓或多仓（{\"urls\":[…]}）配置地址，只保留能直连的苹果CMS点播源和直播源。")
            }
            .disabled(locked)

            Section {
                Button("恢复默认源", role: .destructive) { cfg.resetDefaults() }
            }
            .disabled(locked)
        }
        .navigationTitle("设置")
        .toolbar { if !locked { EditButton() } }
        .alert("家长 PIN", isPresented: $askUnlock) {
            SecureField("PIN", text: $pinInput).keyboardType(.numberPad)
            Button("解锁") {
                unlocked = pinInput == pin
                if !unlocked { message = "PIN 不对" }
            }
            Button("取消", role: .cancel) {}
        }
        .alert("家长 PIN", isPresented: $askNewPin) {
            SecureField("留空 = 清除 PIN", text: $pinInput).keyboardType(.numberPad)
            Button("保存") { pin = pinInput; unlocked = true; message = pinInput.isEmpty ? "PIN 已清除" : "PIN 已设置" }
            Button("取消", role: .cancel) {}
        }
        .alert(message ?? "", isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil } })) {
            Button("好", role: .cancel) {}
        }
    }

    private func pingLabel(_ key: String) -> Text? {
        guard let v = ping[key] else { return nil }
        let color: Color = v.hasPrefix("✓") ? .green : v.hasPrefix("✗") ? .orange : .secondary
        return Text(v.replacingOccurrences(of: "✓ ", with: "").replacingOccurrences(of: "✗ ", with: ""))
            .font(.caption).foregroundStyle(color)
    }

    /// Ping every 点播 and 直播 source at once; results fill in as they arrive.
    private func pingAll() async {
        pinging = true
        defer { pinging = false }
        ping = [:]
        for s in cfg.sites { ping["s:" + s.id] = "…" }
        for l in cfg.lives { ping["l:" + l.id] = "…" }
        await withTaskGroup(of: (String, String).self) { group in
            for s in cfg.sites { group.addTask { ("s:" + s.id, await API.checkSite(s.api)) } }
            for l in cfg.lives { group.addTask { ("l:" + l.id, await API.checkLive(l)) } }
            for await (k, v) in group { ping[k] = v.hasPrefix("✗") ? "✗ 不通" : v }
        }
    }

    private func runImport() async {
        importing = true
        defer { importing = false }
        do {
            let (s, l) = try await API.importConfig(importURL)
            if s.isEmpty && l.isEmpty { message = "没找到可直连的苹果CMS点播源或直播源"; return }
            cfg.merge(sites: s, lives: l, replace: replace)
            message = "导入 \(s.count) 个点播源、\(l.count) 个直播源"
        } catch {
            message = "导入失败：\(error.localizedDescription)"
        }
    }
}

struct Tag: View {
    let text: String
    let color: Color
    var body: some View {
        Text(text).font(.system(size: 10, weight: .semibold)).foregroundStyle(color)
            .padding(.horizontal, 4).padding(.vertical, 1)
            .overlay(RoundedRectangle(cornerRadius: 3).stroke(color.opacity(0.6)))
    }
}

struct SiteEditor: View {
    @Binding var site: Site
    @State private var status = ""

    var body: some View {
        Form {
            Section("名称") { TextField("名称", text: $site.name) }
            Section("接口地址（苹果CMS）") {
                TextField("https://…/api.php/provide/vod", text: $site.api, axis: .vertical)
                    .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
            }
            Section {
                Toggle("少儿源（儿童模式下显示）", isOn: Binding(get: { site.kids == true }, set: { site.kids = $0 ? true : nil }))
                Toggle("成人源（仅「全部」级别显示）", isOn: Binding(get: { site.adult == true }, set: { site.adult = $0 ? true : nil }))
            }
            if let c = site.categories, !c.isEmpty {
                Section("分类白名单") { Text(c.joined(separator: "、")).font(.footnote) }
            }
            Section {
                Button("测速") { Task { status = "测试中…"; status = await API.checkSite(site.api) } }
                if !status.isEmpty { Text(status).font(.footnote).foregroundStyle(status.hasPrefix("✓") ? .green : .orange) }
            }
        }
        .navigationTitle(site.name)
    }
}

struct LiveEditor: View {
    @Binding var src: LiveSource
    @State private var status = ""

    var body: some View {
        Form {
            Section("名称") { TextField("名称", text: $src.name) }
            Section {
                TextField("https://…/live.m3u", text: $src.url, axis: .vertical)
                    .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
            } header: { Text("地址") } footer: {
                if src.text != nil { Text("已在本机编辑过内容，播放时用编辑后的文本，不再拉取这个地址。") }
            }
            Section {
                NavigationLink { LiveTextEditor(src: $src) } label: {
                    Label(src.text == nil ? "编辑频道列表文本" : "编辑频道列表文本（已修改）", systemImage: "doc.text")
                }
                if src.text != nil {
                    Button("放弃本机修改，恢复用地址", role: .destructive) { src.text = nil }
                }
            }
            Section {
                Button("测速（拉列表 + 抽测 8 个频道）") { Task { status = "测试中…"; status = await API.checkLive(src) } }
                if !status.isEmpty { Text(status).font(.footnote).foregroundStyle(status.hasPrefix("✓") ? .green : .orange) }
            }
        }
        .navigationTitle(src.name)
    }
}

/// Raw m3u / txt editing. Starts from the edited copy, or the current content of the URL / bundled file.
struct LiveTextEditor: View {
    @Binding var src: LiveSource
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var loaded = false

    var body: some View {
        TextEditor(text: $text)
            .font(.system(size: 12, design: .monospaced))
            .textInputAutocapitalization(.never).autocorrectionDisabled()
            .overlay { if !loaded { ProgressView() } }
            .navigationTitle("编辑 \(src.name)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { src.text = text; dismiss() }.disabled(!loaded)
                }
                ToolbarItem(placement: .bottomBar) {
                    Text("\(API.parseLive(text, src: LiveSource(name: src.name, url: "", text: text)).reduce(0) { $0 + $1.channels.count }) 个频道")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .task {
                guard !loaded else { return }
                text = await API.liveText(src) ?? "#EXTM3U\n#EXTINF:-1 group-title=\"我的频道\",频道名\nhttps://example.com/live.m3u8\n"
                loaded = true
            }
    }
}
