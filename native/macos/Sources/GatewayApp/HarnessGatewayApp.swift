import Darwin
import Foundation
import SwiftUI

@main
struct HarnessGatewayApp: App {
    @NSApplicationDelegateAdaptor(GatewayLifecycleDelegate.self) private var lifecycle
    @StateObject private var model: GatewayModel
    @StateObject private var connections: GatewayConnectionsModel
    @StateObject private var updates: GatewayUpdatesModel
    @StateObject private var navigation = GatewayNavigation()

    init() {
        guard let launch = try? GatewayLaunchConfiguration.read() else {
            FileHandle.standardError.write(Data("Harness Gateway: invalid launch options.\n".utf8))
            exit(64)
        }
        let gateway = GatewayModel(
            command: GatewayCommand(homeDirectory: launch.homeDirectory),
            homeDirectory: launch.homeDirectory,
            defaults: launch.defaults,
            initialConfigPath: launch.configPath
        )
        _model = StateObject(wrappedValue: gateway)
        _connections = StateObject(wrappedValue: GatewayConnectionsModel(
            gateway: gateway,
            bridge: GatewayManagementCommand(homeDirectory: launch.homeDirectory)
        ))
        _updates = StateObject(wrappedValue: GatewayUpdatesModel())
    }

    var body: some Scene {
        Window("Harness Gateway", id: "main") {
            GatewayView(model: model, connections: connections)
                .environmentObject(navigation)
                .environmentObject(updates)
                .frame(minWidth: 800, minHeight: 600)
                .preferredColorScheme(.light)
                .onAppear {
                    lifecycle.connections = connections
                    lifecycle.gateway = model
                    lifecycle.updates = updates
                }
                .onDisappear { Task { await connections.endWizardSession() } }
                .sheet(isPresented: $navigation.showSetup) {
                    SetupWizardView(
                        gateway: model,
                        connections: connections,
                        isPresented: $navigation.showSetup
                    )
                    .frame(minWidth: 760, minHeight: 640)
                    .preferredColorScheme(.light)
                    .interactiveDismissDisabled(true)
                    .onDisappear {
                        Task { await connections.endWizardSession() }
                    }
                }
                .onChange(of: model.configPath) { _, _ in
                    Task { await connections.configurationDidChange() }
                }
                .task {
                    if !model.hasConfig { navigation.showSetup = true }
                    await model.associateBackgroundItem()
                    await connections.refresh()
                    while !Task.isCancelled {
                        if !connections.isBusy { await model.refresh() }
                        do { try await Task.sleep(for: .seconds(30)) }
                        catch { break }
                    }
                }
        }
        .defaultSize(width: 960, height: 680)
        .commands {
            CommandGroup(replacing: .appSettings) {
                Button("Settings…") {
                    navigation.selection = .settings
                }
                .keyboardShortcut(",", modifiers: .command)
            }

            CommandGroup(after: .toolbar) {
                Button("Check for Updates…") {
                    navigation.openUpdates()
                }
                .keyboardShortcut("u", modifiers: [.command, .option])

                Button("Add Connection…") {
                    navigation.showSetup = true
                }
                .keyboardShortcut("n", modifiers: [.command, .shift])
                .disabled(connections.isBusy || model.isBusy || model.clientOnly)

                Button("Refresh") {
                    Task {
                        await model.refresh()
                        await connections.refresh()
                    }
                }
                .keyboardShortcut("r", modifiers: .command)
                .disabled(model.isBusy)
            }
        }
    }
}

@MainActor
final class GatewayNavigation: ObservableObject {
    enum Section: Hashable {
        case overview
        case activity
        case connections
        case settings
    }

    @Published var selection: Section? = .overview
    @Published var showSetup = false
    @Published private(set) var updateCheckID = 0

    func openUpdates() {
        selection = .settings
        updateCheckID &+= 1
    }
}
