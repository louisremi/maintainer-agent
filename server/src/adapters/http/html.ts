/** Tiny HTML helpers for the admin pages (no template engine, everything escaped). */
export function esc(value: unknown): string {
	return String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export function page(title: string, body: string): string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(title)} · maintainer-agent</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 980px; margin: 2rem auto; padding: 0 1rem; color: #1f2328; }
  h1, h2 { line-height: 1.2 } h2 { margin-top: 2rem; border-bottom: 1px solid #d0d7de; padding-bottom: .3rem }
  table { border-collapse: collapse; width: 100%; margin: .5rem 0 1rem } th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid #eaeef2; vertical-align: top }
  code { background: #f6f8fa; padding: .1rem .3rem; border-radius: 4px } .muted { color: #59636e } .warn { color: #9a6700 } .bad { color: #cf222e } .ok { color: #1a7f37 }
  form.inline { display: inline } button { cursor: pointer } fieldset { border: 1px solid #d0d7de; border-radius: 6px; padding: 1rem }
  label { display: block; margin: .4rem 0 }
</style></head><body>${body}</body></html>`;
}
