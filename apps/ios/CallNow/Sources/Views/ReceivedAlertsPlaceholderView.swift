import SwiftUI

/// Deliberately minimal: just proves a push notification reached the app.
/// Real alert content fetch/display is out of scope for this shell — see
/// docs/ios/step-01-shell-implementation-results.md.
struct ReceivedAlertsPlaceholderView: View {
    let count: Int

    var body: some View {
        VStack(spacing: 4) {
            Text("受信した通知")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Text("\(count)")
                .font(.system(size: 40, weight: .bold, design: .rounded))
        }
        .padding()
        .frame(maxWidth: .infinity)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16))
    }
}
