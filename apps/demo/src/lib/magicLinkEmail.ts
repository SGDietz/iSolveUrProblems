/**
 * Magic-link email for iSolveUrProblems — adapted from aiASAP's G-locked design
 * (warm dark-brown radial surround, GOLD text, gold button), rebranded to iSolve/6.
 *
 * Same render-safe rules as the locked aiASAP version: text is SOLID gold, NOT
 * -webkit-background-clip:text (that goes invisible on Android Gmail). The button
 * keeps its real gradient (an element background, which email clients render).
 *
 * NOTE: no avatar image yet — aiASAP's <img> pointed at aiASAP's own Supabase
 * storage. When an iSolve-hosted 6 image exists, drop it into .sixwrap below.
 */
export function buildMagicLinkEmailHtml(magicLink: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="dark light">
<meta name="supported-color-schemes" content="dark light">
<title>iSolveUrProblems — Your sign-in link</title>
<style>
  body { margin:0; padding:0; background:#0e0803; -webkit-font-smoothing:antialiased; }
  .wrap { width:100%; background: radial-gradient(circle at 50% -8%, #34200f 0%, #1a0f06 50%, #0e0803 100%); background-color:#160c04; padding: 40px 16px; }
  .card { max-width: 540px; margin:0 auto; background:#1d1209; background-color:#1d1209; border:1px solid #4a2f14; border-radius:24px; overflow:hidden; box-shadow:0 24px 70px rgba(0,0,0,.6); }
  .inner { padding: 40px 40px 30px; text-align:center; font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif; }
  .wordmark { font-family:'Arial Black','Archivo Black',Impact,sans-serif; font-weight:900; font-size:32px; letter-spacing:.3px; color:#f4d086; margin:0 0 4px; }
  .tag { font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif; font-size:13px; font-weight:800; letter-spacing:5px; text-transform:uppercase; color:#d9a85e; margin:0 0 24px; }
  h1 { font-size:25px; color:#f1c87e; margin:18px 0 12px; font-weight:800; }
  p { font-size:16px; line-height:1.6; margin:0 0 20px; color:#e2bd84; }
  .btn { display:inline-block; margin:8px 0 4px; padding:16px 46px; border-radius:14px; background:linear-gradient(180deg,#ffda6c 0%,#f3bc53 39%,#c6873a 72%,#915a27 100%); background-color:#f0b84e; color:#3a2108 !important; font-weight:800; font-size:18px; text-decoration:none; box-shadow:0 10px 26px rgba(215,160,90,.4); }
  .divider { height:1px; width:70%; margin:30px auto 0; background:#4a2f14; }
  .fine { font-size:13px; line-height:1.55; margin-top:22px; color:#a98a63; }
  .foot { text-align:center; padding:22px 20px 4px; font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif; font-size:12px; line-height:1.7; color:#b39a50; }
  .foot a { text-decoration:none; color:#cda966; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="inner">
        <div class="wordmark">iSolveUrProblems</div>
        <div class="tag">Your Quicker Fixer Upper</div>
        <h1>6 Here &mdash; Your Quicker Fixer Upper &#128079;</h1>
        <p>Tap the magic link below to finish setting up your account &mdash; then next time, I'll know it's you &#129309;</p>
        <a href="${magicLink}" class="btn">Finish setting up &rarr;</a>
        <div class="divider"></div>
        <p class="fine">Didn't ask to set up an account? No worries &mdash; just ignore this email.</p>
      </div>
    </div>
    <div class="foot">
      Sent by 6 at <a href="https://iSolveUrProblems.ai">iSolveUrProblems.ai</a> &#128155;<br>
      &copy; 2026 iSolveUrProblems &middot; DietzX LLC
    </div>
  </div>
</body>
</html>`;
}
