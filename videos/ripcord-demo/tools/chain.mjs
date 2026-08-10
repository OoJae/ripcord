import puppeteer from "puppeteer-core";
const TX = "0x6e314ece3f28df705ce60d62bdcb130b46013aa1b919f6b5efb91dd335e9cd05";
const b = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: "new", args: ["--window-size=1600,1100", "--hide-scrollbars"],
});
const p = await b.newPage();
await p.setViewport({ width: 1600, height: 1100, deviceScaleFactor: 1 });
await p.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36");
await p.goto(`https://basescan.org/tx/${TX}`, { waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise((r) => setTimeout(r, 7000));
await p.screenshot({ path: "assets/basescan-tx.png" });
const ok = await p.evaluate((t) => document.body.innerText.includes(t.slice(0, 18)), TX);
console.log("captured · tx visible on page:", ok);
await b.close();
