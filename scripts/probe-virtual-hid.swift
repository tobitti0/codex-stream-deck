import CoreHID
import Foundation

// Diagnostic only. This is a vendor-defined device with an unrelated identity,
// never a keyboard, mouse, or Micro. No input report is sent or action performed.
@main
struct VirtualHidProbe {
    static func main() async {
        let descriptor = Data([
            0x06, 0x23, 0xff, // Vendor-defined usage page 0xff23
            0x09, 0x01, 0xa1, 0x01,
            0x15, 0x00, 0x26, 0xff, 0x00,
            0x75, 0x08, 0x95, 0x01,
            0x09, 0x01, 0x81, 0x02, 0xc0
        ])
        let properties = HIDVirtualDevice.Properties(
            descriptor: descriptor, vendorID: 0xfffe,
            productID: 1, product: "Codex Deck HID capability probe"
        )
        let device = HIDVirtualDevice(properties: properties)
        let report: [String: Any] = [
            "virtualHidCreated": device != nil,
            "inputReportsSent": 0,
            "microIdentityUsed": false
        ]
        if let data = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]),
           let text = String(data: data, encoding: .utf8) {
            print(text)
        }
    }
}
