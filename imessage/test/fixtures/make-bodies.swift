import Foundation
// Messages stores message.attributedBody as an NSArchiver typedstream of an NSMutableAttributedString.
let samples = ["hello from the phone", "emoji 👍🏽 and accents é", String(repeating: "long ", count: 80), "line1\nline2"]
for (i, s) in samples.enumerated() {
  let a = NSMutableAttributedString(string: s, attributes: [NSAttributedString.Key("__kIMMessagePartAttributeName"): NSNumber(value: 0)])
  let d = NSArchiver.archivedData(withRootObject: a)
  try! d.write(to: URL(fileURLWithPath: "body\(i).bin"))
  print(i, d.count)
}
