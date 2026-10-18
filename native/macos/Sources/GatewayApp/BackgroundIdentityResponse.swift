import Foundation

struct BackgroundIdentityResponse: Decodable {
    let ok: Bool
    let result: Result?

    struct Result: Decodable {
        let status: String
    }
}
