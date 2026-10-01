import Foundation

enum APIError: Error, LocalizedError, Equatable {
    case invalidURL
    case transport
    case server(status: Int)
    case codedServer(status: Int, code: String)
    case decoding

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "サーバーへの接続先が正しく設定されていません。"
        case .transport:
            return "サーバーに接続できませんでした。"
        case .server(let status):
            return "サーバーがエラーを返しました(status: \(status))。"
        case .codedServer(let status, _):
            return "サーバーがエラーを返しました(status: \(status))。"
        case .decoding:
            return "サーバーの応答を解釈できませんでした。"
        }
    }
}
