// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "HarnessGateway",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "GatewayApp", targets: ["GatewayApp"]),
        .executable(name: "GatewayService", targets: ["GatewayService"]),
        .executable(name: "GatewayUpdateInstaller", targets: ["GatewayUpdateInstaller"]),
    ],
    targets: [
        .executableTarget(name: "GatewayApp"),
        .executableTarget(name: "GatewayService"),
        .executableTarget(name: "GatewayUpdateInstaller"),
        .testTarget(name: "GatewayAppTests", dependencies: ["GatewayApp"]),
    ]
)
