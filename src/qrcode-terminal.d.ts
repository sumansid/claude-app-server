declare module "qrcode-terminal" {
  function generate(text: string, opts: { small: boolean }, callback: (qr: string) => void): void;
  function generate(text: string, callback: (qr: string) => void): void;
  function setErrorLevel(level: "L" | "M" | "Q" | "H"): void;
}
