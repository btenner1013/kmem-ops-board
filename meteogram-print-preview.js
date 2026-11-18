import { createMeteogramPdf } from "./meteogram-pdf-export.js";

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

export function openMeteogramPrintPreview({ doc, view, markup, station = "Airport", createPdf = createMeteogramPdf }) {
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
  </style></head><body class="aviation-meteogram-printing"><nav id="meteogramPreviewTools"><button id="previewCreatePdf" type="button">Create PDF for sharing</button><button id="previewSharePdf" type="button" hidden>Share PDF</button><button id="previewDownloadPdf" type="button" disabled>Download PDF</button><button id="previewPrint" type="button">Print / Save PDF</button><button id="previewClose" type="button">Close preview</button><p>Create a PDF above for a fixed landscape file, then Share PDF or Download PDF. No print dialog is needed for these buttons.</p><p id="previewPdfStatus" role="status" aria-live="polite"></p><p>For paper printing: on iPhone in DuckDuckGo, use the browser menu’s Print command if this button does not open printing. In the print sheet, open the page preview and use Share to send the PDF in Messages or Save to Files. Choose Landscape when available. This page contains only the selected meteogram. It stays available after printing or canceling.</p><p id="previewPrintStatus" role="status" aria-live="polite"></p></nav><main id="aviationWeatherLookupOverlay"><div class="aviation-meteogram-print-pages">${markup}</div></main></body></html>`);
  preview.document.close();
  const pdfStatus = preview.document.getElementById("previewPdfStatus");
  const createButton = preview.document.getElementById("previewCreatePdf");
  const shareButton = preview.document.getElementById("previewSharePdf");
  const downloadButton = preview.document.getElementById("previewDownloadPdf");
  let pdfFile = null, downloadUrl = null, preparing = false, disposed = false;
  createButton.addEventListener("click", async () => {
    if (disposed || preview.closed || preparing || pdfFile) return;
    preparing = true;
    createButton.disabled = true;
    pdfStatus.textContent = "Creating landscape PDF…";
    try {
      const blob = await createPdf(preview.document);
      if (disposed || preview.closed) return;
      pdfFile = new preview.File([blob], `${title.replace(/ /g, "-")}.pdf`, { type: "application/pdf" });
      downloadUrl = preview.URL.createObjectURL(blob);
      downloadButton.disabled = false;
      let canShare = false;
      try {
        canShare = typeof preview.navigator.share === "function"
          && typeof preview.navigator.canShare === "function"
          && preview.navigator.canShare({ files: [pdfFile] });
      } catch { /* Download is still supported when file sharing is unavailable. */ }
      shareButton.hidden = !canShare;
      createButton.textContent = "PDF ready";
      pdfStatus.textContent = canShare
        ? "PDF ready. Tap Share PDF and choose Messages, or download a copy."
        : "PDF ready. Download it, then attach the saved PDF to your message.";
    } catch (error) {
      if (disposed || preview.closed) return;
      pdfFile = null;
      createButton.disabled = false;
      pdfStatus.textContent = "Could not create the PDF. Try again, or use your browser’s Print command. " + (error?.message || "");
    } finally {
      preparing = false;
    }
  });
  shareButton.addEventListener("click", async () => {
    if (!pdfFile || shareButton.disabled) return;
    shareButton.disabled = true;
    try {
      // Call directly in this fresh click: iOS requires transient user activation.
      await preview.navigator.share({ files: [pdfFile], title });
      pdfStatus.textContent = "Share sheet closed. The PDF remains ready to share or download.";
    } catch (error) {
      pdfStatus.textContent = error?.name === "AbortError"
        ? "Sharing canceled. The PDF is still ready."
        : "Sharing is unavailable here. Download the PDF and attach it to your message.";
    } finally {
      shareButton.disabled = false;
    }
  });
  downloadButton.addEventListener("click", () => {
    if (!downloadUrl) return;
    const link = preview.document.createElement("a");
    link.href = downloadUrl;
    link.download = pdfFile.name;
    link.textContent = "Download meteogram PDF";
    preview.document.body.append(link);
    link.click();
    link.remove();
    pdfStatus.textContent = "PDF download requested. If your browser opens it instead, use its Share or Save to Files command.";
  });
  preview.document.getElementById("previewPrint").addEventListener("click", () => {
    // Some iOS browser WebViews silently ignore window.print(). Do not treat
    // returning from it as success; keep a usable native-menu fallback visible.
    preview.document.getElementById("previewPrintStatus").textContent =
      "If no print sheet opens, use your browser’s menu → Print. This chart-only page is ready to print or share from there.";
    try { preview.print(); } catch { /* The native browser-menu route remains available. */ }
  });
  preview.document.getElementById("previewClose").addEventListener("click", () => {
    disposed = true;
    if (downloadUrl) preview.URL.revokeObjectURL(downloadUrl);
    downloadUrl = null;
    pdfFile = null;
    preview.close();
  });
  preview.focus?.();
  return true;
}
