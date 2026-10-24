import SwiftUI

/// One button look for the whole app: the style draws the single shape (no label backgrounds stacked on
/// top of system button chrome), and every button shrinks / dims while pressed.
struct PressStyle: ButtonStyle {
    enum Kind { case plain, primary, secondary, chip(Bool), icon }
    var kind: Kind = .plain

    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed
        shaped(configuration.label)
            .contentShape(Rectangle())
            .scaleEffect(pressed ? 0.94 : 1)
            .opacity(pressed ? 0.7 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.65), value: pressed)
    }

    @ViewBuilder private func shaped(_ label: Configuration.Label) -> some View {
        let rr = RoundedRectangle(cornerRadius: 8, style: .continuous)
        switch kind {
        case .plain:
            label
        case .primary:
            label.font(.headline).foregroundStyle(.black)
                .padding(.vertical, 12).padding(.horizontal, 16)
                .background(Color.white, in: rr)
        case .secondary:
            label.font(.headline).foregroundStyle(.white)
                .padding(.vertical, 12).padding(.horizontal, 16)
                .background(Color.white.opacity(0.16), in: rr)
        case .chip(let on):
            label.font(.subheadline.weight(on ? .bold : .regular)).lineLimit(1)
                .padding(.horizontal, 12).padding(.vertical, 6)
                .background(on ? Color.white : Color.white.opacity(0.1), in: Capsule())
                .foregroundStyle(on ? .black : .white.opacity(0.85))
        case .icon:
            label.font(.headline.weight(.semibold)).foregroundStyle(.white)
                .frame(width: 40, height: 40)
                .background(Color.black.opacity(0.45), in: Circle())
        }
    }
}

extension ButtonStyle where Self == PressStyle {
    static var press: PressStyle { PressStyle() }
    static func press(_ kind: PressStyle.Kind) -> PressStyle { PressStyle(kind: kind) }
}
