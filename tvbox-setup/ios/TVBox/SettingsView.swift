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
    @State private var managing = false
    @State private var merging = false
    @State private var selSites = Set<String>()
    @State private var selLives = Set<String>()
    @State private var confirmText: String?
    @State private var confirmAction: (() -> Void)?

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
                    if managing {
                        Button { toggle(&selSites, s.id) } label: { pickRow(selSites.contains(s.id)) { siteLabel(s) } }.buttonStyle(.plain)
                    } else {
                        NavigationLink { SiteEditor(site: $s) } label: { siteLabel(s) }
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
                    if managing {
                        Button { toggle(&selLives, l.id) } label: { pickRow(selLives.contains(l.id)) { liveLabel(l) } }.buttonStyle(.plain)
                    } else {
                        NavigationLink { LiveEditor(src: $l) } label: { liveLabel(l) }
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

            if managing {
                Section {
                    Button(selSites.count + selLives.count == cfg.sites.count + cfg.lives.count ? "取消全选" : "全选") {
                        if selSites.count + selLives.count == cfg.sites.count + cfg.lives.count { selSites = []; selLives = [] }
                        else { selSites = Set(cfg.sites.map(\.id)); selLives = Set(cfg.lives.map(\.id)) }
                    }
                    Button("反选") {
                        selSites = Set(cfg.sites.map(\.id)).subtracting(selSites)
                        selLives = Set(cfg.lives.map(\.id)).subtracting(selLives)
                    }
                    Button("聚合选中的点播源（\(selSites.count)）") { aggregateSites() }
                    Button("合并选中的直播源（\(selLives.count)）") { Task { await mergeLives() } }.disabled(merging)
                    Button("删除选中的 \(selSites.count + selLives.count) 个", role: .destructive) {
                        let n = selSites.count + selLives.count
                        guard n > 0 else { message = "先勾选要删除的源"; return }
                        ask("删除选中的 \(n) 个源？") { cfg.sites.removeAll { selSites.contains($0.id) }; cfg.lives.removeAll { selLives.contains($0.id) }; selSites = []; selLives = [] }
                    }
                    Button("删除不通的（没测过会先测速）", role: .destructive) { Task { await deleteBad() } }.disabled(pinging)
                    Button("重测不通的") { Task { await pingAll(retryFailedOnly: true) } }.disabled(pinging)
                    Button("导出选中到剪贴板") {
                        Task { await export(sites: cfg.sites.filter { selSites.contains($0.id) }, lives: cfg.lives.filter { selLives.contains($0.id) }) }
                    }
                    Button("导出全部到剪贴板") { Task { await export(sites: cfg.sites, lives: cfg.lives) } }
                } header: { Text("批量操作 · 已选 \(selSites.count + selLives.count)") } footer: {
                    Text("聚合：把多个点播源合成一个入口，搜索、浏览、播放线路同时覆盖所有成员，同名影片合并，成员不通自动跳过。合并直播：把多个直播源的频道合成一个列表，同分组归并、相同地址去重。\n导出的是一段 JSON，复制到另一台设备（网页端或 iOS）的「从剪贴板识别」里粘贴即可导入；改过的频道列表会连同内容一起导出。")
                }
                .disabled(locked)
            }

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
        .onDisappear { let n = cfg.dedupe(); if n > 0 { Toast.show("保存时去掉了 \(n) 个重复链接的源") } }
        .toolbar {
            if !locked {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(managing ? "完成" : "批量") { managing.toggle(); if !managing { selSites = []; selLives = [] } }
                }
                ToolbarItem(placement: .navigationBarTrailing) { EditButton() }
            }
        }
        .alert(confirmText ?? "", isPresented: Binding(get: { confirmText != nil }, set: { if !$0 { confirmText = nil } })) {
            Button("删除", role: .destructive) { confirmAction?(); confirmAction = nil }
            Button("取消", role: .cancel) { confirmAction = nil }
        }
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

    private func siteLabel(_ s: Site) -> some View {
        HStack {
            Text(s.name)
            if s.kids == true { Tag(text: "少儿", color: .green) }
            if s.adult == true { Tag(text: "成人", color: .brand) }
            if s.members != nil { Tag(text: "聚合源", color: .teal) }
            Spacer()
            if let m = s.members { Text("\(m.count) 个成员").font(.caption).foregroundStyle(.secondary) }
            else { pingLabel("s:" + s.id) ?? Text(URL(string: s.api)?.host ?? s.api).font(.caption).foregroundStyle(.secondary) }
        }
    }

    private func liveLabel(_ l: LiveSource) -> some View {
        HStack {
            Text(l.name)
            Spacer()
            pingLabel("l:" + l.id) ?? Text(l.text != nil ? "已编辑" : l.url.hasPrefix("http") ? (URL(string: l.url)?.host ?? l.url) : "内置")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private func pickRow<C: View>(_ on: Bool, @ViewBuilder _ content: () -> C) -> some View {
        HStack(spacing: 10) {
            Image(systemName: on ? "checkmark.circle.fill" : "circle").font(.title3).foregroundStyle(on ? Color.brand : Color.secondary)
            content()
        }
        .contentShape(Rectangle())
    }

    private func aggregateSites() {
        let ids = cfg.sites.filter { selSites.contains($0.id) && $0.members == nil }.map(\.key)
        guard ids.count >= 2 else { message = "至少勾选 2 个点播源（聚合源不能再嵌套）"; return }
        var g = Site(key: "group-" + UUID().uuidString.prefix(6), name: "聚合源 \(ids.count)", api: "")
        g.members = ids
        cfg.sites.insert(g, at: 0)
        selSites = [g.id]
        message = "已生成「\(g.name)」，成员保留。点进去可以改名。"
    }

    /// Merge the picked 直播源 into one local list: same group name joins, same stream url is kept once.
    private func mergeLives() async {
        let picked = cfg.lives.filter { selLives.contains($0.id) }
        guard picked.count >= 2 else { message = "至少勾选 2 个直播源"; return }
        merging = true
        defer { merging = false }
        var groups: [(String, [LiveChannel])] = [], seen = Set<String>(), dup = 0, failed: [String] = []
        for l in picked {
            guard let t = await API.liveText(l) else { failed.append(l.name); continue }
            for g in API.parseLive(t, src: l) {
                for c in g.channels {
                    if !seen.insert(c.url).inserted { dup += 1; continue }
                    if let i = groups.firstIndex(where: { $0.0 == g.name }) { groups[i].1.append(c) } else { groups.append((g.name, [c])) }
                }
            }
        }
        guard !seen.isEmpty else { message = "选中的直播源里没解析出频道" + (failed.isEmpty ? "" : "（打不开：\(failed.joined(separator: "、"))）"); return }
        let clean: (String) -> String = { $0.replacingOccurrences(of: "\"", with: " ").replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces) }
        var out = ["#EXTM3U"]
        for (g, chs) in groups { for c in chs {
            out.append("#EXTINF:-1\(c.logo.isEmpty ? "" : " tvg-logo=\"\(clean(c.logo))\"") group-title=\"\(clean(g))\",\(clean(c.name).replacingOccurrences(of: ",", with: " "))")
            out.append(c.url)
        } }
        var merged = LiveSource(name: "合并直播源 \(seen.count)台", url: "merged:" + UUID().uuidString, text: out.joined(separator: "\n") + "\n")
        merged.uid = UUID().uuidString
        let at = cfg.lives.firstIndex { selLives.contains($0.id) } ?? 0
        cfg.lives.insert(merged, at: at)
        cfg.lives.removeAll { selLives.contains($0.id) }
        selLives = [merged.id]
        message = "合并完成：\(groups.count) 个分组、\(seen.count) 个频道，去重 \(dup)" + (failed.isEmpty ? "" : "，打不开：\(failed.joined(separator: "、"))")
    }

    private func toggle(_ set: inout Set<String>, _ id: String) {
        if set.contains(id) { set.remove(id) } else { set.insert(id) }
    }

    private func ask(_ text: String, _ action: @escaping () -> Void) {
        confirmAction = action
        confirmText = text
    }

    private struct PingJob: Sendable {
        let key: String
        let api: String?
        let live: LiveSource?
    }

    /// One source, up to 3 tries with a growing pause, so a network blip doesn't mark a good source as dead.
    private static func pingJob(_ j: PingJob) async -> (String, String) {
        var r = ""
        for k in 0...2 {
            if k > 0 { try? await Task.sleep(nanoseconds: UInt64(600_000_000 * k)) }
            if let api = j.api { r = await API.checkSite(api) } else if let l = j.live { r = await API.checkLive(l) }
            if !r.hasPrefix("✗") { break }
        }
        return (j.key, r)
    }

    /// Ping every 点播 and 直播 source, six at a time, retrying failures; results fill in as they arrive.
    /// Earlier results survive deleting rows (they are keyed by source id).
    private func pingAll(retryFailedOnly: Bool = false) async {
        pinging = true
        defer { pinging = false }
        var jobs: [PingJob] = []
        for s in cfg.sites where s.members == nil && (!retryFailedOnly || ping["s:" + s.id]?.hasPrefix("✗") == true) { jobs.append(PingJob(key: "s:" + s.id, api: s.api, live: nil)) }
        for l in cfg.lives where !retryFailedOnly || ping["l:" + l.id]?.hasPrefix("✗") == true { jobs.append(PingJob(key: "l:" + l.id, api: nil, live: l)) }
        if jobs.isEmpty { return }
        for j in jobs { ping[j.key] = "…" }
        let all = jobs
        await withTaskGroup(of: (String, String).self) { group in
            var next = 0
            while next < min(6, all.count) { let j = all[next]; next += 1; group.addTask { await Self.pingJob(j) } }
            for await (k, v) in group {
                ping[k] = v.hasPrefix("✗") ? "✗ 不通" : v
                if next < all.count { let j = all[next]; next += 1; group.addTask { await Self.pingJob(j) } }
            }
        }
    }

    private func deleteBad() async {
        if !cfg.sites.allSatisfy({ $0.members != nil || ping["s:" + $0.id] != nil }) || !cfg.lives.allSatisfy({ ping["l:" + $0.id] != nil }) {
            ping = ping.filter { !$0.value.hasPrefix("…") }
            await pingAll(retryFailedOnly: false)
        }
        let badSites = Set(cfg.sites.filter { ping["s:" + $0.id]?.hasPrefix("✗") == true }.map(\.id))
        let badLives = Set(cfg.lives.filter { ping["l:" + $0.id]?.hasPrefix("✗") == true }.map(\.id))
        let n = badSites.count + badLives.count
        if n == 0 { message = "没有不通的源"; return }
        ask("删除 \(n) 个不通的源？（已自动重试 2 次）") {
            cfg.sites.removeAll { badSites.contains($0.id) }
            cfg.lives.removeAll { badLives.contains($0.id) }
            selSites.subtract(badSites); selLives.subtract(badLives)
        }
    }

    /// Copy sources as a shareable JSON set; edited / bundled channel lists carry their text so the paste is self-contained.
    private func export(sites: [Site], lives: [LiveSource]) async {
        var ls: [[String: Any]] = []
        for l in lives {
            if l.text != nil || !l.url.hasPrefix("http") {
                guard let t = await API.liveText(l), !t.isEmpty else { continue }
                ls.append(["name": l.name, "text": t])
            } else {
                ls.append(["name": l.name, "url": l.url])
            }
        }
        let ss = sites.map { s -> [String: Any] in
            if let m = s.members { return ["key": s.key, "name": s.name, "members": m] }
            var d: [String: Any] = ["key": s.key, "name": s.name, "api": s.api]
            if s.kids == true { d["kids"] = 1 }
            if s.adult == true { d["adult"] = 1 }
            if let c = s.categories, !c.isEmpty { d["categories"] = c }
            return d
        }
        guard !ss.isEmpty || !ls.isEmpty,
              let data = try? JSONSerialization.data(withJSONObject: ["tvbox": 1, "sites": ss, "lives": ls] as [String: Any], options: [.prettyPrinted, .withoutEscapingSlashes]) else {
            message = "没有可导出的源"
            return
        }
        UIPasteboard.general.string = String(decoding: data, as: UTF8.self)
        UserDefaults.standard.set(UIPasteboard.general.changeCount, forKey: "clip.seen")
        message = "已复制 \(ss.count) 个点播源、\(ls.count) 个直播源。到另一台设备的「从剪贴板识别」里粘贴即可导入。"
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
            if let m = site.members {
                Section("成员（\(m.count)）") {
                    ForEach(m, id: \.self) { k in Text(Config.shared.sites.first { $0.key == k }?.name ?? k + "（已删除）").font(.subheadline) }
                }
            } else {
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
