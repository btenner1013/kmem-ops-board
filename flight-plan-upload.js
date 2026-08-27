export const ONE_PDF_ERROR = "Please select one PDF DD1801 at a time.";
export const PDF_ONLY_ERROR = "Please select an electronic PDF DD1801. Other file types are not supported.";

export function isPdfFile(file) {
  if (!file) return false;

  const type = String(file.type || "").trim().toLowerCase();
  const hasPdfExtension = /\.pdf$/i.test(String(file.name || "").trim());

  if (type === "application/pdf") return true;
  return hasPdfExtension && (type === "" || type === "application/octet-stream");
}

export function validatePdfFileSelection(files) {
  const selectedFiles = Array.from(files || []);

  if (selectedFiles.length === 0) {
    return { file: null, error: "" };
  }

  if (selectedFiles.length !== 1) {
    return { file: null, error: ONE_PDF_ERROR };
  }

  const [file] = selectedFiles;
  if (!isPdfFile(file)) {
    return { file: null, error: PDF_ONLY_ERROR };
  }

  return { file, error: "" };
}
