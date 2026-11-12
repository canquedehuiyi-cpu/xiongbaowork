import AppKit
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let w = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 420, height: 260), styleMask: [.titled, .closable], backing: .buffered, defer: false)
w.title = "XB Sample Form"
let v = w.contentView!
let a = NSTextField(frame: NSRect(x: 10, y: 210, width: 300, height: 24)); a.setAccessibilityLabel("Single line"); v.addSubview(a)
let b = NSSecureTextField(frame: NSRect(x: 10, y: 180, width: 300, height: 24)); b.stringValue = "secret123"; b.setAccessibilityLabel("Password"); v.addSubview(b)
let sv = NSScrollView(frame: NSRect(x: 10, y: 70, width: 300, height: 100)); let tv = NSTextView(frame: sv.bounds); sv.documentView = tv; tv.setAccessibilityLabel("Multi line"); v.addSubview(sv)
let d = NSButton(title: "Disabled button", target: nil, action: nil); d.frame = NSRect(x: 10, y: 35, width: 200, height: 28); d.isEnabled = false; v.addSubview(d)
let e = NSButton(title: "Send", target: nil, action: nil); e.frame = NSRect(x: 220, y: 35, width: 100, height: 28); v.addSubview(e)
w.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
app.run()
