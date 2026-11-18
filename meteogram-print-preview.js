// A separate, persistent document prevents iOS share/print from capturing the
// dashboard after WebKit fires afterprint (which can precede PDF sharing).
export function meteogramPreviewStyles(doc) {
  const styles = [];
  for (const sheet of Array.from(doc.styleSheets || [])) {
    const path = sheet.href && new URL(sheet.href, doc.baseURI).pathname;
    if (!path || !/\/(aviation-weather-lookup|weather-meteogram)\.css$/.test(path)) continue;
    // Both stylesheets are same-origin. Never silently print an unstyled chart.
    const rules = Array.from(sheet.cssRules || []);
    styles.push(rules.map((rule) => {
      if (rule.conditionText === "print" && rule.cssRules) {
        return Array.from(rule.cssRules).map((child) => child.cssText).join("\n");
      }
      return rule.cssText;
    }).join("\n"));
  }
  if (styles.length !== 2) throw new Error("Print styles are not ready. Reload the board and try again.");
  return styles.join("\n");
}

export function openMeteogramPrintPreview({ doc, view, markup, station = "Airport" }) {
  const css = meteogramPreviewStyles(doc);
  const preview = view.open("", "_blank");
  if (!preview) return false;
  const title = `${String(station).replace(/[^A-Z0-9]/gi, "")} meteogram`;
  preview.document.open();
  preview.document.write(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${css}</style><style>
    @page{size:letter landscape;margin:.28in}
    html,body{margin:0!important;background:white!important;color:#111!important;overflow:auto!important}
    body.aviation-meteogram-printing>#meteogramPreviewTools{display:block!important}
    #meteogramPreviewTools{padding:12px;font:16px Arial,sans-serif;background:#edf4f4}
    #meteogramPreviewTools button{min-height:44px;padding:8px 16px;margin:0 8px 8px 0;font:700 16px Arial,sans-serif}
    #meteogramPreviewTools p{margin:0;line-height:1.4}
    @media screen{.aviation-meteogram-print-page{padding:12px;margin:0 0 20px;border-bottom:1px solid #aaa}.aviation-meteogram-print-chart svg{max-height:none!important}}
    @media print{body.aviation-meteogram-printing>#meteogramPreviewTools{display:none!important}}
  </style></head><body class="aviation-meteogram-printing"><nav id="meteogramPreviewTools"><button id="previewPrint" type="button">Print / Save PDF</button><button id="previewClose" type="button">Close preview</button><p>On iPhone, open the print preview, use Share, then choose Messages or Save to Files. This page contains only the selected meteogram. It stays available after printing or canceling.</p></nav><main id="aviationWeatherLookupOverlay"><div class="aviation-meteogram-print-pages">${markup}</div></main></body></html>`);
  preview.document.close();
  preview.document.getElementById("previewPrint").addEventListener("click", () => preview.print());
  preview.document.getElementById("previewClose").addEventListener("click", () => preview.close());
  preview.focus?.();
  return true;
}
